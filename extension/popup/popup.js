const translateButton = document.getElementById("translate-button");
const restoreButton = document.getElementById("restore-button");
const statusMessage = document.getElementById("status-message");
const sourceLanguage = document.getElementById("source-language");
const targetLanguage = document.getElementById("target-language");

let activeRequestId = null;

function setStatus(message, state = "ready") {
  statusMessage.textContent = message;
  statusMessage.dataset.state = state;
}

function setBusy(isBusy) {
  translateButton.disabled = isBusy;
  restoreButton.disabled = isBusy;
}

function sendExtensionMessage(message, initialStatus) {
  const requestId = crypto.randomUUID();
  activeRequestId = requestId;
  setBusy(true);
  setStatus(initialStatus, "busy");

  chrome.runtime.sendMessage({ ...message, requestId }, (response) => {
    if (activeRequestId !== requestId) {
      return;
    }

    activeRequestId = null;
    setBusy(false);

    if (chrome.runtime.lastError) {
      setStatus(
        `Translation failed: ${chrome.runtime.lastError.message}`,
        "error"
      );
      return;
    }

    setStatus(
      response?.statusMessage || "The extension did not return a status.",
      response?.status || "error"
    );
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (
    message?.type === "OPERATION_PROGRESS" &&
    message.requestId === activeRequestId
  ) {
    setStatus(message.statusMessage, "busy");
  }
});

function handleTranslateRequest() {
  sendExtensionMessage({
    type: "TRANSLATE_PAGE",
    sourceLanguage: sourceLanguage.value,
    targetLanguage: targetLanguage.value
  }, "Connecting to translation backend...");
}

function handleRestoreRequest() {
  sendExtensionMessage(
    { type: "RESTORE_PAGE" },
    "Restoring original text..."
  );
}

translateButton.addEventListener("click", handleTranslateRequest);
restoreButton.addEventListener("click", handleRestoreRequest);
