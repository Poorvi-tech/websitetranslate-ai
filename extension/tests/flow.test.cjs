const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionRoot = path.resolve(__dirname, "..");
const contentSource = fs.readFileSync(
  path.join(extensionRoot, "scripts/content.js"),
  "utf8"
);
const popupSource = fs.readFileSync(
  path.join(extensionRoot, "popup/popup.js"),
  "utf8"
);
const backgroundSource = fs.readFileSync(
  path.join(extensionRoot, "scripts/background.js"),
  "utf8"
).replace(
  /^import \{[\s\S]*?\} from "\.\.\/config\/api-config\.js";/,
  'const API_BASE_URL = "http://127.0.0.1:8000";\n' +
    "const API_REQUEST_TIMEOUT_MS = 120000;\n" +
    "const HEALTH_REQUEST_TIMEOUT_MS = 10000;\n" +
    "const MAX_API_TEXT_CHARACTERS = 2000;\n" +
    "const MAX_INPUT_TOKENS = 256;\n" +
    "const MAX_TOKEN_COUNT_BATCH_ITEMS = 64;\n" +
    "const MAX_TRANSLATION_BATCH_ITEMS = 8;"
);
const hostSetTimeout = setTimeout;
const hostClearTimeout = clearTimeout;

function createElement(tagName, options = {}) {
  return {
    tagName,
    hidden: options.hidden || false,
    isContentEditable: options.contentEditable || false,
    parentElement: options.parentElement || null,
    getAttribute(name) {
      return name === "aria-hidden" && options.ariaHidden ? "true" : null;
    },
    closest() {
      return null;
    }
  };
}

function createContentContext(inputSegments) {
  const body = createElement("BODY");
  const textNodes = inputSegments.map(({ text, ...options }) => ({
    nodeValue: text,
    parentElement: createElement(options.tagName || "P", {
      ...options,
      parentElement: body
    }),
    isConnected: true
  }));
  let contentListener;
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          contentListener = listener;
        }
      }
    }
  };
  const document = {
    body,
    createTreeWalker() {
      let index = 0;
      return {
        nextNode() {
          return textNodes[index++] || null;
        }
      };
    }
  };
  const context = vm.createContext({
    chrome,
    document,
    NodeFilter: { SHOW_TEXT: 4 },
    window: {
      getComputedStyle(element) {
        return {
          display: element.hidden ? "none" : "block",
          visibility: "visible"
        };
      }
    }
  });
  vm.runInContext(contentSource, context);

  function send(message) {
    let response;
    contentListener(message, {}, (value) => {
      response = value;
    });
    return response;
  }

  return { send, textNodes };
}

function createFlowHarness({
  segments,
  maxInputTokens = 256,
  failTranslations = new Set(),
  timeoutAtPath = null,
  holdHealth = false,
  backendUnavailable = false,
  failBatchStatus = null,
  invalidBatchJson = false
}) {
  const content = createContentContext(segments);
  let backgroundListener;
  let releaseHealth;
  const healthGate = holdHealth
    ? new Promise((resolve) => {
      releaseHealth = resolve;
    })
    : null;
  const apiRequests = [];
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener) {
          backgroundListener = listener;
        }
      },
      sendMessage() {
        return Promise.resolve();
      }
    },
    tabs: {
      async query() {
        return [{ id: 1 }];
      },
      async sendMessage(tabId, message) {
        return content.send(message);
      }
    },
    scripting: {
      async executeScript() {
        return [];
      }
    }
  };

  async function fetchApi(url, options = {}) {
    if (url.endsWith("/health")) {
      if (healthGate) {
        await healthGate;
      }
      if (backendUnavailable) {
        return new Response(JSON.stringify({ detail: "Backend unavailable" }), {
          status: 503
        });
      }
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }

    const body = JSON.parse(options.body);
    apiRequests.push({ url, body });
    if (timeoutAtPath && url.endsWith(timeoutAtPath)) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true }
        );
      });
    }

    if (url.endsWith("/token-count")) {
      return new Response(JSON.stringify({
        token_counts: body.texts.map((text) => Array.from(text).length),
        max_input_tokens: maxInputTokens,
        max_text_characters: 2000,
        max_token_count_batch_items: 64
      }), { status: 200 });
    }

    if (url.endsWith("/translate-batch")) {
      if (failBatchStatus) {
        return new Response(JSON.stringify({ detail: "Model service unavailable" }), {
          status: failBatchStatus
        });
      }
      if (invalidBatchJson) {
        return new Response("not JSON", { status: 200 });
      }
      return new Response(JSON.stringify({
        translated_texts: body.texts.map((text) => {
          if (failTranslations.has(text)) {
            return "";
          }
          return text === "Hello, how are you?"
            ? "नमस्ते, आप कैसे हैं?"
            : text.toUpperCase();
        })
      }), { status: 200 });
    }

    return new Response(JSON.stringify({ detail: "Not found" }), { status: 404 });
  }

  const backgroundContext = vm.createContext({
    chrome,
    console: { error() {}, warn() {} },
    fetch: fetchApi,
    AbortController,
    setTimeout(callback, delay) {
      if (timeoutAtPath && delay === 120000) {
        queueMicrotask(callback);
        return 0;
      }
      return hostSetTimeout(callback, delay);
    },
    clearTimeout(timer) {
      if (timer !== 0) {
        hostClearTimeout(timer);
      }
    }
  });
  vm.runInContext(backgroundSource, backgroundContext);

  function sendAction(type) {
    return new Promise((resolve) => {
      backgroundListener(
        {
          type,
          requestId: "test-request",
          sourceLanguage: "en",
          targetLanguage: "hi"
        },
        {},
        resolve
      );
    });
  }

  return {
    apiRequests,
    content,
    releaseHealth,
    sendAction
  };
}

test("translates, reuses original text on repeat, and restores exactly", async () => {
  const harness = createFlowHarness({
    segments: [
      { text: " Hello, how are you? \n" },
      { text: "Do not translate", tagName: "SCRIPT" },
      { text: "User input", contentEditable: true },
      { text: "Hidden text", hidden: true }
    ]
  });

  const first = await harness.sendAction("TRANSLATE_PAGE");
  assert.equal(first.status, "success");
  assert.equal(harness.content.textNodes[0].nodeValue, " नमस्ते, आप कैसे हैं? \n");
  assert.deepEqual(
    Array.from(
      harness.content.send({ type: "EXTRACT_TEXT" }).segments,
      (segment) => segment.text
    ),
    [" Hello, how are you? \n"]
  );

  const second = await harness.sendAction("TRANSLATE_PAGE");
  assert.equal(second.status, "success");
  assert.equal(harness.content.textNodes[0].nodeValue, " नमस्ते, आप कैसे हैं? \n");

  const restored = await harness.sendAction("RESTORE_PAGE");
  assert.equal(restored.status, "success");
  assert.equal(harness.content.textNodes[0].nodeValue, " Hello, how are you? \n");
  assert.deepEqual(
    harness.content.textNodes.slice(1).map((node) => node.nodeValue),
    ["Do not translate", "User input", "Hidden text"]
  );
});

test("keeps invalid batch items unchanged and restores successful segments", async () => {
  const harness = createFlowHarness({
    segments: [{ text: "Hello" }, { text: "Fail" }],
    failTranslations: new Set(["Fail"])
  });

  const result = await harness.sendAction("TRANSLATE_PAGE");
  assert.equal(result.status, "backend_unavailable");
  assert.match(result.statusMessage, /left unchanged/);
  assert.equal(harness.content.textNodes[0].nodeValue, "HELLO");
  assert.equal(harness.content.textNodes[1].nodeValue, "Fail");

  await harness.sendAction("RESTORE_PAGE");
  assert.deepEqual(
    harness.content.textNodes.map((node) => node.nodeValue),
    ["Hello", "Fail"]
  );
});

test("token preflight splits chunks before any oversized translation request", async () => {
  const harness = createFlowHarness({
    segments: [{ text: "a".repeat(600) }]
  });

  const result = await harness.sendAction("TRANSLATE_PAGE");
  assert.equal(result.status, "success");
  assert.equal(harness.content.textNodes[0].nodeValue, "A".repeat(600));

  const translateRequests = harness.apiRequests
    .filter((request) => request.url.endsWith("/translate-batch"));
  assert.equal(translateRequests.length, 1);
  assert.ok(translateRequests[0].body.texts.length > 1);
  assert.ok(
    translateRequests.every((request) =>
      request.body.texts.every((text) => Array.from(text).length <= 256)
    )
  );
});

test("does not restore text subsequently modified by the page", async () => {
  const harness = createFlowHarness({ segments: [{ text: "Hello" }] });
  await harness.sendAction("TRANSLATE_PAGE");
  harness.content.textNodes[0].nodeValue = "Page updated this text";

  const result = await harness.sendAction("RESTORE_PAGE");
  assert.match(result.statusMessage, /page-modified segments were left untouched/);
  assert.equal(harness.content.textNodes[0].nodeValue, "Page updated this text");
});

test("batches thousands of short segments within API item limits", async () => {
  const segments = Array.from({ length: 520 }, (_, index) => ({
    text: `segment ${index}`
  }));
  const harness = createFlowHarness({ segments });

  const result = await harness.sendAction("TRANSLATE_PAGE");
  assert.equal(result.status, "success");
  assert.equal(harness.content.textNodes.length, 520);

  const tokenCountRequests = harness.apiRequests.filter((request) =>
    request.url.endsWith("/token-count")
  );
  const translationRequests = harness.apiRequests.filter((request) =>
    request.url.endsWith("/translate-batch")
  );
  assert.ok(tokenCountRequests.length < 20);
  assert.equal(translationRequests.length, 65);
  for (const request of tokenCountRequests) {
    assert.ok(request.body.texts.length <= 64);
    assert.ok(request.body.texts.reduce((sum, text) => sum + Array.from(text).length, 0) <= 2000);
  }
  for (const request of translationRequests) {
    assert.ok(request.body.texts.length <= 8);
    assert.ok(request.body.texts.reduce((sum, text) => sum + Array.from(text).length, 0) <= 2000);
  }
});

test("does not apply empty translations returned by the backend", async () => {
  const harness = createFlowHarness({
    segments: [{ text: "Translate me" }],
    failTranslations: new Set(["Translate me"])
  });

  const result = await harness.sendAction("TRANSLATE_PAGE");
  assert.equal(result.status, "backend_unavailable");
  assert.match(result.statusMessage, /empty translation/);
  assert.equal(harness.content.textNodes[0].nodeValue, "Translate me");
});

test("reports an API timeout and leaves webpage text unchanged", async () => {
  const harness = createFlowHarness({
    segments: [{ text: "Hello" }],
    timeoutAtPath: "/token-count"
  });

  const result = await harness.sendAction("TRANSLATE_PAGE");
  assert.equal(result.status, "backend_unavailable");
  assert.match(result.statusMessage, /timed out/);
  assert.equal(harness.content.textNodes[0].nodeValue, "Hello");
});

test("reports an unavailable backend before extracting page content", async () => {
  const harness = createFlowHarness({
    segments: [{ text: "Hello" }],
    backendUnavailable: true
  });

  const result = await harness.sendAction("TRANSLATE_PAGE");
  assert.equal(result.status, "backend_unavailable");
  assert.match(result.statusMessage, /Backend unavailable/);
  assert.equal(harness.apiRequests.length, 0);
  assert.equal(harness.content.textNodes[0].nodeValue, "Hello");
});

test("reports a model error and keeps the failed batch unchanged", async () => {
  const harness = createFlowHarness({
    segments: [{ text: "Hello" }, { text: "How are you?" }],
    failBatchStatus: 503
  });

  const result = await harness.sendAction("TRANSLATE_PAGE");
  assert.equal(result.status, "backend_unavailable");
  assert.match(result.statusMessage, /Model service unavailable/);
  assert.deepEqual(
    harness.content.textNodes.map((node) => node.nodeValue),
    ["Hello", "How are you?"]
  );
});

test("reports malformed API JSON and does not change page text", async () => {
  const harness = createFlowHarness({
    segments: [{ text: "Hello" }],
    invalidBatchJson: true
  });

  const result = await harness.sendAction("TRANSLATE_PAGE");
  assert.equal(result.status, "backend_unavailable");
  assert.match(result.statusMessage, /invalid JSON/);
  assert.equal(harness.content.textNodes[0].nodeValue, "Hello");
});

test("handles pages with no translatable text without API translation requests", async () => {
  const harness = createFlowHarness({
    segments: [{ text: "" }, { text: " \t\n " }]
  });

  const result = await harness.sendAction("TRANSLATE_PAGE");
  assert.equal(result.status, "success");
  assert.match(result.statusMessage, /No translatable text/);
  assert.equal(harness.apiRequests.length, 0);
});

test("splits large text without truncating content or exceeding batch limits", async () => {
  const originalText = "Hello world. ".repeat(400);
  const harness = createFlowHarness({
    segments: [{ text: originalText }]
  });

  const result = await harness.sendAction("TRANSLATE_PAGE");
  assert.equal(result.status, "success");
  assert.equal(harness.content.textNodes[0].nodeValue, originalText.toUpperCase());

  for (const request of harness.apiRequests) {
    if (request.url.endsWith("/token-count")) {
      assert.ok(request.body.texts.reduce((sum, text) => sum + text.length, 0) <= 2000);
    }
    if (request.url.endsWith("/translate-batch")) {
      assert.ok(request.body.texts.length <= 8);
      assert.ok(request.body.texts.reduce((sum, text) => sum + text.length, 0) <= 2000);
    }
  }
});

test("a rejected overlapping action does not release the active tab lock", async () => {
  const harness = createFlowHarness({
    segments: [{ text: "Hello" }],
    holdHealth: true
  });

  const activeRequest = harness.sendAction("TRANSLATE_PAGE");
  await new Promise((resolve) => setImmediate(resolve));

  const rejectedAction = await harness.sendAction("RESTORE_PAGE");
  const secondRejectedAction = await harness.sendAction("RESTORE_PAGE");
  assert.match(rejectedAction.statusMessage, /already running/);
  assert.match(secondRejectedAction.statusMessage, /already running/);

  harness.releaseHealth();
  assert.equal((await activeRequest).status, "success");
});

test("popup disables duplicate actions and displays progress and completion", () => {
  const elements = new Map();
  for (const id of [
    "translate-button",
    "restore-button",
    "status-message",
    "source-language",
    "target-language"
  ]) {
    elements.set(id, {
      disabled: false,
      dataset: {},
      value: id === "source-language" ? "en" : "hi",
      addEventListener(event, callback) {
        this[event] = callback;
      }
    });
  }
  const listeners = [];
  let sentMessage;
  let sendResponse;
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        }
      },
      sendMessage(message, callback) {
        sentMessage = message;
        sendResponse = callback;
      }
    }
  };
  vm.runInNewContext(popupSource, {
    chrome,
    crypto: { randomUUID: () => "popup-test-request" },
    document: { getElementById: (id) => elements.get(id) }
  });

  const translateButton = elements.get("translate-button");
  const restoreButton = elements.get("restore-button");
  translateButton.click();
  assert.equal(translateButton.disabled, true);
  assert.equal(restoreButton.disabled, true);
  assert.equal(sentMessage.type, "TRANSLATE_PAGE");
  assert.equal(sentMessage.sourceLanguage, "en");
  assert.equal(sentMessage.targetLanguage, "hi");
  assert.equal(
    elements.get("status-message").textContent,
    "Connecting to translation backend..."
  );

  listeners[0]({
    type: "OPERATION_PROGRESS",
    requestId: "popup-test-request",
    statusMessage: "Translating batch 1 of 1..."
  });
  assert.equal(
    elements.get("status-message").textContent,
    "Translating batch 1 of 1..."
  );

  sendResponse({
    ok: true,
    status: "success",
    statusMessage: "Translation completed."
  });
  assert.equal(translateButton.disabled, false);
  assert.equal(restoreButton.disabled, false);
  assert.equal(elements.get("status-message").textContent, "Translation completed.");
});
