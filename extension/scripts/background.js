import {
  API_BASE_URL,
  API_REQUEST_TIMEOUT_MS,
  HEALTH_REQUEST_TIMEOUT_MS,
  MAX_API_TEXT_CHARACTERS,
  MAX_INPUT_TOKENS,
  MAX_TOKEN_COUNT_BATCH_ITEMS,
  MAX_TRANSLATION_BATCH_ITEMS
} from "../config/api-config.js";

const SUPPORTED_ACTIONS = new Set(["TRANSLATE_PAGE", "RESTORE_PAGE"]);
const activeTabActions = new Set();

class BackendUnavailableError extends Error {}

class BackendTimeoutError extends BackendUnavailableError {}

class BackendResponseError extends Error {
  constructor(status, detail) {
    super(typeof detail === "string" ? detail : "The backend returned an error.");
    this.status = status;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OPERATION_PROGRESS") {
    return false;
  }

  if (!SUPPORTED_ACTIONS.has(message?.type)) {
    sendResponse({
      ok: false,
      status: "error",
      statusMessage: "Unsupported extension action."
    });
    return false;
  }

  handlePageTextAction(message)
    .then(sendResponse)
    .catch((error) => {
      console.error("Page translation action failed.", error);
      sendResponse({
        ok: false,
        status: "error",
        statusMessage: "The page action failed. Original text was not discarded."
      });
    });
  return true;
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  return tab;
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["scripts/content.js"]
  });
}

async function requestApi(path, body) {
  const controller = new AbortController();
  const timeoutMs = path === "/health"
    ? HEALTH_REQUEST_TIMEOUT_MS
    : API_REQUEST_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new BackendTimeoutError(
        `${path} timed out after ${timeoutMs / 1000} seconds.`
      );
    }
    throw new BackendUnavailableError(
      error instanceof Error ? error.message : "The backend could not be reached."
    );
  } finally {
    clearTimeout(timeoutId);
  }

  let responseBody;
  try {
    responseBody = await response.json();
  } catch (error) {
    throw new BackendResponseError(
      502,
      `The backend returned invalid JSON for ${path}.`
    );
  }

  if (!response.ok) {
    throw new BackendResponseError(response.status, responseBody.detail);
  }
  return responseBody;
}

function notifyProgress(requestId, statusMessage) {
  if (!requestId) {
    return;
  }

  chrome.runtime.sendMessage({
    type: "OPERATION_PROGRESS",
    requestId,
    statusMessage
  }).catch(() => {});
}

function splitAtBoundary(text) {
  const characters = Array.from(text);
  if (characters.length < 2) {
    return null;
  }

  const middle = Math.floor(characters.length / 2);
  let boundary = null;
  let bestDistance = Infinity;

  for (let index = 1; index < characters.length - 1;) {
    if (!/\s/u.test(characters[index])) {
      index++;
      continue;
    }

    const start = index;
    while (index < characters.length && /\s/u.test(characters[index])) {
      index++;
    }
    if (index >= characters.length) {
      break;
    }

    const distance = Math.abs((start + index) / 2 - middle);
    if (distance < bestDistance) {
      bestDistance = distance;
      boundary = { start, end: index };
    }
  }

  if (boundary) {
    return {
      left: characters.slice(0, boundary.start).join(""),
      separator: characters.slice(boundary.start, boundary.end).join(""),
      right: characters.slice(boundary.end).join("")
    };
  }

  return {
    left: characters.slice(0, middle).join(""),
    separator: "",
    right: characters.slice(middle).join("")
  };
}

function splitToCharacterLimit(text, maxCharacters, separatorBefore = "") {
  if (Array.from(text).length <= maxCharacters) {
    return [{ text, separatorBefore }];
  }

  const split = splitAtBoundary(text);
  if (!split) {
    return [{ text, separatorBefore }];
  }
  return [
    ...splitToCharacterLimit(split.left, maxCharacters, separatorBefore),
    ...splitToCharacterLimit(split.right, maxCharacters, split.separator)
  ];
}

function comparePaths(left, right) {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index++) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return left.length - right.length;
}

function groupJobs(jobs, maxItems, maxCharacters) {
  const groups = [];
  let group = [];
  let characterCount = 0;

  for (const job of jobs) {
    const length = Array.from(job.text).length;
    if (length > maxCharacters) {
      throw new Error("A text segment exceeded the configured API character limit.");
    }
    if (
      group.length &&
      (group.length >= maxItems || characterCount + length > maxCharacters)
    ) {
      groups.push(group);
      group = [];
      characterCount = 0;
    }
    group.push(job);
    characterCount += length;
  }

  if (group.length) {
    groups.push(group);
  }
  return groups;
}

async function prepareTranslationChunks(segments, requestId) {
  const initialJobs = [];
  const failedSegmentIds = new Set();

  segments.forEach((segment) => {
    const text = typeof segment.text === "string" ? segment.text : "";
    const leadingWhitespace = text.match(/^\s*/u)?.[0] || "";
    const trailingWhitespace = text.match(/\s*$/u)?.[0] || "";
    const contentEnd = text.length - trailingWhitespace.length;
    const content = text.slice(leadingWhitespace.length, contentEnd);

    if (!content) {
      failedSegmentIds.add(segment.id);
      return;
    }

    const chunks = splitToCharacterLimit(content, MAX_API_TEXT_CHARACTERS);
    chunks.forEach((chunk, partIndex) => {
      initialJobs.push({
        segmentId: segment.id,
        leadingWhitespace,
        trailingWhitespace,
        text: chunk.text,
        separatorBefore: chunk.separatorBefore,
        path: [partIndex]
      });
    });
  });

  let pending = initialJobs;
  const readyJobs = [];

  while (pending.length) {
    const groups = groupJobs(
      pending,
      MAX_TOKEN_COUNT_BATCH_ITEMS,
      MAX_API_TEXT_CHARACTERS
    );
    const nextPending = [];

    for (const [groupIndex, group] of groups.entries()) {
      notifyProgress(
        requestId,
        `Checking token limits: batch ${groupIndex + 1} of ${groups.length}...`
      );
      const countResponse = await requestApi("/token-count", {
        texts: group.map((job) => job.text)
      });
      if (
        !Array.isArray(countResponse.token_counts) ||
        countResponse.token_counts.length !== group.length ||
        countResponse.max_input_tokens !== MAX_INPUT_TOKENS ||
        !Number.isInteger(countResponse.max_text_characters) ||
        !Number.isInteger(countResponse.max_token_count_batch_items) ||
        countResponse.max_text_characters !== MAX_API_TEXT_CHARACTERS ||
        countResponse.max_token_count_batch_items !== MAX_TOKEN_COUNT_BATCH_ITEMS
      ) {
        throw new BackendResponseError(502, "Backend returned invalid token limits.");
      }

      group.forEach((job, index) => {
        const tokenCount = countResponse.token_counts[index];
        if (!Number.isInteger(tokenCount) || tokenCount < 1) {
          throw new BackendResponseError(502, "Backend returned an invalid token count.");
        }
        if (tokenCount <= countResponse.max_input_tokens) {
          readyJobs.push(job);
        } else {
          const split = splitAtBoundary(job.text);
          if (!split) {
            failedSegmentIds.add(job.segmentId);
            return;
          }

          nextPending.push({
            ...job,
            text: split.left,
            path: [...job.path, 0]
          });
          nextPending.push({
            ...job,
            text: split.right,
            separatorBefore: split.separator,
            path: [...job.path, 1]
          });
        }
      });
    }

    pending = nextPending;
  }

  return { readyJobs, failedSegmentIds };
}

async function translateChunks(jobs, requestId) {
  const translatedBySegment = new Map();
  const failedSegmentIds = new Set();
  const groups = groupJobs(
    jobs,
    MAX_TRANSLATION_BATCH_ITEMS,
    MAX_API_TEXT_CHARACTERS
  );
  let completed = 0;
  let backendUnavailable = false;
  const failureMessages = new Set();

  for (const [groupIndex, group] of groups.entries()) {
    notifyProgress(
      requestId,
      `Translating batch ${groupIndex + 1} of ${groups.length}...`
    );
    let outcomes;
    try {
      const response = await requestApi("/translate-batch", {
        texts: group.map((job) => job.text),
        source_language: "en",
        target_language: "hi"
      });
      if (
        !Array.isArray(response.translated_texts) ||
        response.translated_texts.length !== group.length
      ) {
        throw new BackendResponseError(
          502,
          "The backend returned an invalid translation batch."
        );
      }

      outcomes = group.map((job, index) => {
        const translatedText = response.translated_texts[index];
        if (typeof translatedText !== "string" || !translatedText.trim()) {
          return {
            job,
            error: new BackendResponseError(
              502,
              `The backend returned an empty translation for batch item ${index + 1}.`
            )
          };
        }
        return { job, translatedText };
      });
    } catch (error) {
      console.warn("Translation batch request failed.", {
        status: error instanceof BackendResponseError ? error.status : undefined,
        message: error instanceof Error ? error.message : "Unknown request error."
      });
      outcomes = group.map((job) => ({ job, error }));
    }

    for (const outcome of outcomes) {
      completed++;
      if (outcome.error) {
        failedSegmentIds.add(outcome.job.segmentId);
        failureMessages.add(
          outcome.error instanceof Error
            ? outcome.error.message
            : "The translation batch failed."
        );
        if (
          outcome.error instanceof BackendUnavailableError ||
          (outcome.error instanceof BackendResponseError &&
            outcome.error.status >= 500)
        ) {
          backendUnavailable = true;
        }
        continue;
      }

      const translations = translatedBySegment.get(outcome.job.segmentId) || [];
      translations.push({
        ...outcome.job,
        translatedText: outcome.translatedText
      });
      translatedBySegment.set(outcome.job.segmentId, translations);
    }

    if (backendUnavailable) {
      for (const job of jobs.slice(completed)) {
        failedSegmentIds.add(job.segmentId);
      }
      break;
    }
  }

  return {
    translatedBySegment,
    failedSegmentIds,
    backendUnavailable,
    failureMessages: [...failureMessages]
  };
}

function assembleTranslations(segments, translatedBySegment, failedSegmentIds) {
  const translations = [];

  for (const segment of segments) {
    if (failedSegmentIds.has(segment.id)) {
      continue;
    }

    const chunks = translatedBySegment.get(segment.id);
    if (!chunks?.length) {
      failedSegmentIds.add(segment.id);
      continue;
    }
    chunks.sort((left, right) => comparePaths(left.path, right.path));

    const translatedCore = chunks
      .map((chunk, index) =>
        `${index === 0 ? "" : chunk.separatorBefore}${chunk.translatedText}`
      )
      .join("");
    const leadingWhitespace = chunks[0].leadingWhitespace;
    const trailingWhitespace = chunks[0].trailingWhitespace;

    translations.push({
      id: segment.id,
      translatedText: `${leadingWhitespace}${translatedCore}${trailingWhitespace}`
    });
  }

  return translations;
}

async function translatePage(tabId, message) {
  if (message.sourceLanguage !== "en" || message.targetLanguage !== "hi") {
    return {
      ok: false,
      status: "error",
      statusMessage: "Only English-to-Hindi translation is supported."
    };
  }

  notifyProgress(message.requestId, "Connecting to translation backend...");
  let health;
  try {
    health = await requestApi("/health");
  } catch (error) {
    const reason = error instanceof BackendTimeoutError
      ? "The backend health check timed out."
      : error instanceof BackendResponseError
        ? error.message
        : `Backend unavailable at ${API_BASE_URL}.`;
    return {
      ok: false,
      status: "backend_unavailable",
      statusMessage: `${reason} Start the local backend and try again.`
    };
  }
  if (health.status !== "ok") {
    return {
      ok: false,
      status: "backend_unavailable",
      statusMessage: "Backend unavailable. The health check did not succeed."
    };
  }

  notifyProgress(message.requestId, "Extracting webpage text...");
  await injectContentScript(tabId);
  const extracted = await chrome.tabs.sendMessage(tabId, { type: "EXTRACT_TEXT" });
  if (!extracted?.ok || !Array.isArray(extracted.segments)) {
    return {
      ok: false,
      status: "error",
      statusMessage: "The webpage did not return translatable text."
    };
  }
  if (!extracted.segments.length) {
    return {
      ok: true,
      status: "success",
      statusMessage: "No translatable text was found on this webpage."
    };
  }

  notifyProgress(
    message.requestId,
    `Found ${extracted.segments.length} text segments. Preparing bounded batches...`
  );
  try {
    const { readyJobs, failedSegmentIds } = await prepareTranslationChunks(
      extracted.segments,
      message.requestId
    );
    const translatableJobs = readyJobs.filter(
      (job) => !failedSegmentIds.has(job.segmentId)
    );
    const translated = await translateChunks(translatableJobs, message.requestId);
    for (const id of translated.failedSegmentIds) {
      failedSegmentIds.add(id);
    }

    const results = assembleTranslations(
      extracted.segments,
      translated.translatedBySegment,
      failedSegmentIds
    );
    let appliedCount = 0;
    let skippedCount = 0;
    if (results.length) {
      notifyProgress(message.requestId, "Applying translations to the webpage...");
      const applied = await chrome.tabs.sendMessage(tabId, {
        type: "APPLY_TRANSLATIONS",
        translations: results
      });
      if (
        !applied?.ok ||
        !Number.isInteger(applied.appliedCount) ||
        applied.appliedCount < 0 ||
        !Number.isInteger(applied.skippedCount) ||
        applied.skippedCount < 0
      ) {
        throw new Error("The webpage returned an invalid translation result.");
      }
      appliedCount = applied.appliedCount;
      skippedCount = applied.skippedCount;
    }

    const failedCount = failedSegmentIds.size + skippedCount;
    if (failedCount) {
      const reason = translated.failureMessages[0];
      const detail = reason ? ` First error: ${reason}` : "";
      const statusMessage = translated.backendUnavailable
        ? `Backend unavailable or timed out during translation. ${appliedCount} segments translated; ${failedCount} left unchanged.${detail}`
        : `Translation partially completed. ${appliedCount} segments translated; ${failedCount} left unchanged.${detail}`;
      return {
        ok: false,
        status: translated.backendUnavailable ? "backend_unavailable" : "partial",
        statusMessage
      };
    }

    return {
      ok: true,
      status: "success",
      statusMessage: `Translation completed. ${appliedCount} text segments translated.`
    };
  } catch (error) {
    if (
      error instanceof BackendUnavailableError ||
      (error instanceof BackendResponseError && error.status >= 500)
    ) {
      return {
        ok: false,
        status: "backend_unavailable",
        statusMessage: `Backend request failed: ${error.message} Translated text was not discarded.`
      };
    }
    throw error;
  }
}

async function restorePage(tabId) {
  await injectContentScript(tabId);
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "RESTORE_ORIGINAL"
  });
  if (!response?.ok) {
    return {
      ok: false,
      status: "error",
      statusMessage: "The webpage did not accept the restore request."
    };
  }
  return {
    ok: true,
    status: "success",
    statusMessage: response.skippedCount
      ? `${response.restoredCount} segments restored; ${response.skippedCount} page-modified segments were left untouched.`
      : `${response.restoredCount} original text segments restored.`
  };
}

async function handlePageTextAction(message) {
  let tab;
  let ownsActionLock = false;
  try {
    tab = await getActiveTab();
    if (typeof tab?.id !== "number" || tab.id < 0) {
      return {
        ok: false,
        status: "error",
        statusMessage: "No active webpage is available."
      };
    }

    if (activeTabActions.has(tab.id)) {
      return {
        ok: false,
        status: "error",
        statusMessage: "An action is already running on this webpage."
      };
    }
    activeTabActions.add(tab.id);
    ownsActionLock = true;

    if (message.type === "TRANSLATE_PAGE") {
      return await translatePage(tab.id, message);
    }
    return await restorePage(tab.id);
  } catch (error) {
    console.error("Page text action failed.", error);
    return {
      ok: false,
      status: "error",
      statusMessage: `Translation failed: ${error instanceof Error ? error.message : "Unexpected webpage error."}`
    };
  } finally {
    if (ownsActionLock) {
      activeTabActions.delete(tab.id);
    }
  }
}
