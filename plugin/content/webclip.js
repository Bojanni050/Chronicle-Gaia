/**
 * Chronicle web clip — injected on demand (via chrome.scripting, activeTab)
 * when the toolbar button is clicked on a page that is not one of the AI
 * chat providers. Turns the page's main content into Markdown with the
 * vendored Turndown (plugin/vendor/turndown.js, loaded just before this
 * file) and hands it to the service worker as a plain web clip.
 *
 * No host_permissions are needed: activeTab grants this one-shot injection
 * for the tab the user just clicked on, nothing more.
 */
(function () {
  // Noise die geen tekstuele waarde heeft en de Markdown alleen maar vervuilt.
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG']);

  /**
   * Kloont een node inclusief de inhoud van elke *open* shadow root die eronder
   * hangt, plat in de gewone DOM-boom. Sites zoals Reddit (shreddit-post,
   * shreddit-comment-tree) renderen hun eigenlijke tekst in web components met
   * shadow DOM — `element.innerHTML` ziet die inhoud niet, waardoor een export
   * eerder leeg leek dan dat hij was. Closed shadow roots zijn ook voor de
   * pagina zelf niet leesbaar; die blijven onvermijdelijk buiten beeld.
   */
  function deepCloneWithShadow(node) {
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE) {
      return node.cloneNode(true);
    }
    if (node.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(node.tagName)) {
      return document.createDocumentFragment();
    }
    const clone = node.cloneNode(false);
    if (node.shadowRoot) {
      for (const child of Array.from(node.shadowRoot.childNodes)) {
        clone.appendChild(deepCloneWithShadow(child));
      }
    }
    for (const child of Array.from(node.childNodes)) {
      clone.appendChild(deepCloneWithShadow(child));
    }
    return clone;
  }

  // `<article>`/`<main>` is op veel sites geen betrouwbaar signaal meer: op
  // Reddit matcht het eerste `<article>` in documentvolgorde bijvoorbeeld een
  // comment- of composer-wrapper, niet de post — met als gevolg een (bijna)
  // lege export terwijl de rest van de pagina wél inhoud had. De hele
  // (gevlakte) body is minder precies maar nooit per ongeluk leeg.
  function mainContentElement() {
    return deepCloneWithShadow(document.body);
  }

  function toMarkdown(root) {
    // eslint-disable-next-line no-undef
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    return turndown.turndown(root.innerHTML);
  }

  try {
    const root = mainContentElement();
    let markdown = toMarkdown(root).trim();
    if (!markdown) {
      // Laatste redmiddel: *closed* shadow roots zijn met geen enkele DOM-truc
      // uit te lezen, maar `innerText` volgt de gerenderde (samengestelde)
      // boom zoals de browser 'm toont — dat ziet open shadow-inhoud ook
      // zonder dat wij hem zelf hoeven te vlakken. Platte tekst, geen opmaak.
      markdown = (document.body.innerText || '').trim();
    }
    if (!markdown) {
      chrome.runtime.sendMessage({ type: 'chronicle-webclip-result', ok: false, error: 'geen tekstinhoud gevonden op deze pagina' });
      return;
    }
    chrome.runtime.sendMessage({
      type: 'chronicle-webclip-result',
      ok: true,
      title: document.title || location.href,
      url: location.href,
      markdown,
    });
  } catch (err) {
    chrome.runtime.sendMessage({ type: 'chronicle-webclip-result', ok: false, error: String((err && err.message) || err) });
  }
})();
