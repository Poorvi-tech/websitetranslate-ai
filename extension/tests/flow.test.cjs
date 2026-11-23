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
    "const MAX_API_TEXT_CHARACTERS = 2000;\n" +
    "const MAX_TOKEN_COUNT_BATCH_ITEMS = 8;"
);

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
  failTranslations = new Set()
}) {
  const content = createContentContext(segments);
  let backgroundListener;
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
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }

    const body = JSON.parse(options.body);
    apiRequests.push({ url, body });
    if (url.endsWith("/token-count")) {
      return new Response(JSON.stringify({
        token_counts: body.texts.map((text) => Array.from(text).length),
        max_input_tokens: maxInputTokens,
        max_text_characters: 2000,
        max_token_count_batch_items: 8
      }), { status: 200 });
    }

    if (failTranslations.has(body.text)) {
      return new Response(JSON.stringify({ detail: "model unavailable" }), {
        status: 503
      });
    }

    const translatedText = body.text === "Hello, how are you?"
      ? "नमस्ते, आप कैसे हैं?"
      : body.text.toUpperCase();
    return new Response(JSON.stringify({ translated_text: translatedText }), {
      status: 200
    });
  }

  const backgroundContext = vm.createContext({
    chrome,
    console: { error() {} },
    fetch: fetchApi
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

  return { apiRequests, content, sendAction };
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

test("keeps failed segments unchanged and restores successful segments", async () => {
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
    segments: [{ text: "abcdefghijklmnop" }],
    maxInputTokens: 6
  });

  const result = await harness.sendAction("TRANSLATE_PAGE");
  assert.equal(result.status, "success");
  assert.equal(harness.content.textNodes[0].nodeValue, "ABCDEFGHIJKLMNOP");

  const translateRequests = harness.apiRequests
    .filter((request) => request.url.endsWith("/translate"));
  assert.ok(translateRequests.length > 1);
  assert.ok(
    translateRequests.every((request) => Array.from(request.body.text).length <= 6)
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
