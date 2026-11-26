// SPDX-License-Identifier: Apache-2.0
/*
 * Attaching the tab you are looking at to a question.
 *
 * Two rules decide the shape of this file:
 *
 *  - nothing is read until the person asks for it. There is no background capture, no content
 *    script that runs on every page and no listener that samples a tab: `attachPage` is called
 *    from a click, and nowhere else.
 *  - what is captured is bounded and refuse-able. A browser's own pages cannot be scripted, and
 *    the selection is cut to a length a prompt can hold.
 *
 * The server re-checks everything here (apps/api/src/lib/page-context.ts): this file decides what
 * to *offer*, not what is allowed.
 */
(function (root) {
  "use strict";

  /** The same limits the server applies, so the client cannot send a page the server would cut. */
  var LIMITS = { title: 300, url: 2000, selection: 4000 };

  /** Schemes a browser will not let an extension script, or that are not pages at all. */
  var REFUSED = /^(chrome|chrome-extension|edge|about|devtools|view-source|file|javascript|data):/i;

  /**
   * The function injected into the page. It is deliberately tiny and reads only what is already
   * on screen; it is named so it can be lifted out and called in a test.
   */
  function captureFunc() {
    var selection = "";
    try {
      selection = String(window.getSelection() || "");
    } catch (err) {
      // A cross-origin frame refuses; an empty selection is the honest answer.
      selection = "";
    }
    return {
      title: String(document.title || ""),
      url: String(location.href || ""),
      selection: selection,
    };
  }

  /** Cut a string to a limit on a word boundary, and say that it was cut. */
  function clip(text, limit) {
    var value = String(text == null ? "" : text);
    if (value.length <= limit) return value;
    var cut = value.slice(0, limit);
    var space = cut.lastIndexOf(" ");
    return (space > limit * 0.6 ? cut.slice(0, space) : cut) + " … [truncated]";
  }

  /** The address a page must have to be attached, or null. */
  function acceptableUrl(raw) {
    var value = String(raw == null ? "" : raw).trim();
    if (!value || REFUSED.test(value)) return null;
    if (!/^https?:\/\//i.test(value)) return null;
    return value.slice(0, LIMITS.url);
  }

  /** True when the extension may read this URL at all, so the button can explain itself. */
  function canAttach(url) {
    return acceptableUrl(url) !== null;
  }

  /** Normalise what a page reported into what will be sent, or null when it is not a page. */
  function pageFrom(raw) {
    if (!raw || typeof raw !== "object") return null;
    var url = acceptableUrl(raw.url);
    var title = clip(String(raw.title || "").trim(), LIMITS.title);
    var selection = clip(String(raw.selection || "").trim(), LIMITS.selection);
    if (!url) return null;
    return { title: title, url: url, selection: selection };
  }

  /** What the chip says: the page, and how much of it is attached. */
  function attachmentLabel(page) {
    if (!page) return "";
    var host = "";
    try {
      host = new URL(page.url).host;
    } catch (err) {
      host = page.url;
    }
    var name = page.title || host;
    if (!page.selection) return name;
    var words = page.selection.split(/\s+/).filter(Boolean).length;
    return name + " — " + words + (words === 1 ? " word selected" : " words selected");
  }

  /**
   * Ask the browser for the tab's page, and return it normalised.
   *
   * `chrome` is a parameter rather than a global so a test can pass a stub and assert that
   * nothing is read unless this is called.
   */
  async function attachPage(chrome, tabId) {
    if (!chrome || !chrome.scripting || typeof tabId !== "number") return null;
    var results = await chrome.scripting.executeScript({ target: { tabId: tabId }, func: captureFunc });
    var hit = Array.isArray(results) ? results[0] : null;
    return pageFrom(hit && hit.result);
  }

  root.NexusContext = {
    LIMITS: LIMITS,
    acceptableUrl: acceptableUrl,
    attachPage: attachPage,
    attachmentLabel: attachmentLabel,
    canAttach: canAttach,
    captureFunc: captureFunc,
    clip: clip,
    pageFrom: pageFrom,
  };
})(typeof window !== "undefined" ? window : globalThis);
