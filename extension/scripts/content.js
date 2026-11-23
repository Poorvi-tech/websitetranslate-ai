if (!globalThis.__websiteTranslateAIContentLoaded) {
  globalThis.__websiteTranslateAIContentLoaded = true;

  (() => {
    const preservedTextNodes = new Map();
    const textNodeRecords = new WeakMap();
    let nextSegmentId = 1;

    const UNSUITABLE_ELEMENTS = new Set([
      "SCRIPT",
      "STYLE",
      "NOSCRIPT",
      "TEMPLATE",
      "INPUT",
      "TEXTAREA",
      "SELECT",
      "OPTION",
      "BUTTON",
      "CODE",
      "PRE",
      "IFRAME",
      "OBJECT",
      "CANVAS",
      "SVG",
      "MATH",
      "VIDEO",
      "AUDIO"
    ]);

    function isSuitableTextNode(textNode) {
      if (!textNode.nodeValue || !textNode.nodeValue.trim()) {
        return false;
      }

      const parentElement = textNode.parentElement;
      if (
        !parentElement ||
        UNSUITABLE_ELEMENTS.has(parentElement.tagName) ||
        parentElement.isContentEditable
      ) {
        return false;
      }

      const unsuitableSelector = "script,style,noscript,template,input,textarea," +
        "select,option,button,code,pre,iframe,object,canvas,svg,math,video,audio," +
        "[data-website-translate-ui]";
      if (parentElement.closest(unsuitableSelector)) {
        return false;
      }

      for (let element = parentElement; element; element = element.parentElement) {
        if (element.hidden || element.getAttribute("aria-hidden") === "true") {
          return false;
        }

        const styles = window.getComputedStyle(element);
        if (
          styles.display === "none" ||
          styles.visibility === "hidden" ||
          styles.visibility === "collapse"
        ) {
          return false;
        }
      }

      return true;
    }

    function preserveTextNode(textNode) {
      const existingRecord = textNodeRecords.get(textNode);
      if (existingRecord) {
        if (
          existingRecord.changedByExtension &&
          textNode.nodeValue !== existingRecord.lastTranslatedText
        ) {
          existingRecord.originalText = textNode.nodeValue;
          existingRecord.changedByExtension = false;
          existingRecord.lastTranslatedText = null;
        } else if (!existingRecord.changedByExtension) {
          existingRecord.originalText = textNode.nodeValue;
        }

        return existingRecord;
      }

      const record = {
        id: nextSegmentId++,
        node: textNode,
        originalText: textNode.nodeValue,
        changedByExtension: false,
        lastTranslatedText: null
      };

      preservedTextNodes.set(record.id, record);
      textNodeRecords.set(textNode, record);
      return record;
    }

    function extractReadableText() {
      const segments = [];
      if (!document.body) {
        return segments;
      }

      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT
      );

      let textNode = walker.nextNode();
      while (textNode) {
        if (isSuitableTextNode(textNode) && textNode.isConnected) {
          const record = preserveTextNode(textNode);
          segments.push({
            id: record.id,
            text: record.changedByExtension
              ? record.originalText
              : textNode.nodeValue
          });
        }

        textNode = walker.nextNode();
      }

      return segments;
    }

    function restoreOriginalText() {
      let restoredCount = 0;
      let skippedCount = 0;

      for (const record of preservedTextNodes.values()) {
        if (record.changedByExtension) {
          if (
            record.node.isConnected &&
            record.node.nodeValue === record.lastTranslatedText
          ) {
            record.node.nodeValue = record.originalText;
            restoredCount++;
          } else if (
            record.node.isConnected &&
            record.node.nodeValue !== record.originalText
          ) {
            skippedCount++;
          }

          record.changedByExtension = false;
          record.lastTranslatedText = null;
        }
      }

      return { restoredCount, skippedCount };
    }

    function applyTranslations(translations) {
      let appliedCount = 0;
      let skippedCount = 0;

      for (const translation of translations) {
        const record = preservedTextNodes.get(translation.id);
        if (
          !record ||
          !record.node.isConnected ||
          typeof translation.translatedText !== "string"
        ) {
          skippedCount++;
          continue;
        }

        const currentText = record.node.nodeValue;
        if (
          currentText !== record.originalText &&
          (!record.changedByExtension ||
            currentText !== record.lastTranslatedText)
        ) {
          skippedCount++;
          continue;
        }

        record.node.nodeValue = translation.translatedText;
        record.changedByExtension =
          translation.translatedText !== record.originalText;
        record.lastTranslatedText = record.changedByExtension
          ? translation.translatedText
          : null;
        appliedCount++;
      }

      return { appliedCount, skippedCount };
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === "EXTRACT_TEXT") {
        const segments = extractReadableText();
        sendResponse({
          ok: true,
          segments
        });
        return false;
      }

      if (message?.type === "APPLY_TRANSLATIONS") {
        const result = applyTranslations(
          Array.isArray(message.translations) ? message.translations : []
        );
        sendResponse({
          ok: true,
          ...result
        });
        return false;
      }

      if (message?.type === "RESTORE_ORIGINAL") {
        const result = restoreOriginalText();
        sendResponse({
          ok: true,
          ...result
        });
        return false;
      }

      return false;
    });
  })();
}
