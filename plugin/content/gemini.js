/**
 * gemini.google.com provider-script.
 *
 * Gemini heeft géén bruikbare JSON-API voor de webclient: alles loopt via het
 * ondoorzichtige batchexecute/StreamGenerate-protocol en een directe
 * /app/{id}-load rendert alleen de app-shell, niet de berichten. Daarom leest
 * dit script de DOM. De selectors zijn de bewezen set uit
 * davidmalko87/gemini-chat-exporter (mid-2026) — Google verandert de Angular-
 * internals met enige regelmaat, dus breekt dit, dan staan de juiste strings
 * in CONFIG.
 *
 * Idempotent: Chrome mag het script opnieuw injecteren (extensie-herladen,
 * SPA-navigatie). De tweede run stopt in de guard van de UI-helper.
 */
(() => {

  const { makeButton, exportToChronicle, buildConversation, transcriptFromTurns, innerTextWithCodeFences } = window.__chronicleUI;

  // Selectors in volgorde van voorkeur; de eerste die tekst oplevert wint.
  const SELECTORS = {
    turnContainer: '.conversation-container',
    userQuery: ['user-query .query-text', 'user-query', '.query-text'],
    modelResponse: ['model-response .markdown', '.model-response-text', 'model-response', 'message-content'],
    sidebarLink: 'a[href^="/app/"]',
    sidebarScroller: 'infinite-scroller',
    chatsSection: '[data-test-id="chats-expandable-section"]',
    sectionToggle: '[data-test-id="expandable-section-toggle"]',
  };

  // Gemini emit no-break spaces (U+00A0, U+202F); normaliseer naar gewone
  // spaties. Uit char-codes opgebouwd zodat dit bestand ASCII blijft.
  const NBSP_RE = new RegExp('[' + String.fromCharCode(0xa0, 0x202f) + ']', 'g');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function conversationIdFromUrl() {
    const match = location.pathname.match(/\/app\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  function idFromHref(href) {
    const match = (href || '').match(/\/app\/([^/?#]+)/);
    return match ? match[1] : null;
  }

  /** Eerste selector die niet-lege tekst oplevert, mét codefences. */
  function firstMatchText(root, selectors) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el && el.innerText && el.innerText.trim()) {
        return innerTextWithCodeFences(el);
      }
    }
    return '';
  }

  /** Strip Gemini's a11y-labels ("You said"/"Gemini said") en normaliseer spaties. */
  function cleanText(text) {
    if (!text) return '';
    return text
      .replace(NBSP_RE, ' ')
      .replace(/\r\n?/g, '\n')
      .replace(/^\s*(you said|gemini said)\b[:\s]*/i, '')
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').replace(/\s+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function turnsFromDom() {
    const turns = [];
    for (const container of document.querySelectorAll(SELECTORS.turnContainer)) {
      const userText = cleanText(firstMatchText(container, SELECTORS.userQuery));
      if (userText) turns.push({ role: 'user', text: userText });
      const modelText = cleanText(firstMatchText(container, SELECTORS.modelResponse));
      if (modelText) turns.push({ role: 'assistant', text: modelText });
    }
    return turns;
  }

  function firstUserPrompt(turns) {
    const turn = turns.find((t) => t.role === 'user' && t.text.trim());
    return turn ? turn.text.trim() : '';
  }

  /** De gesprekstitel staat in de zijbalk bij de bijbehorende anchor. */
  function titleFromSidebar(id) {
    if (id) {
      const anchor = document.querySelector(`a[href="/app/${id}"]`);
      if (anchor) {
        const title = (anchor.getAttribute('aria-label') || anchor.innerText || '').trim();
        if (title) return title;
      }
    }
    const fromDoc = (document.title || '').replace(/\s*[-–]\s*Gemini.*$/i, '').trim();
    return fromDoc || null;
  }

  function collectConversation() {
    const id = conversationIdFromUrl();
    const turns = turnsFromDom();
    if (!turns.length) {
      return { error: 'geen berichten gevonden op deze pagina' };
    }
    return buildConversation({
      content: transcriptFromTurns(turns),
      turns,
      title: titleFromSidebar(id),
      url: id ? `https://gemini.google.com/app/${id}` : location.href,
      sourceProvider: 'gemini',
    });
  }

  // ── Bulk ─────────────────────────────────────────────────────────────────
  // Gemini heeft geen lijst-API voor de webclient: de gesprekkenlijst is de
  // (gevirtualiseerde, lazy-paginierende) zijbalk, en berichten laden alléén
  // door op een anchor te klikken — niet via directe navigatie. Vandaar het
  // klikken + stabiliteitswacht uit gemini-chat-exporter.

  async function harvestConversations() {
    const merged = new Map();
    const absorb = () => {
      for (const anchor of document.querySelectorAll(SELECTORS.sidebarLink)) {
        const id = idFromHref(anchor.getAttribute('href'));
        if (!id || merged.has(id)) continue;
        const title = (anchor.getAttribute('aria-label') || anchor.innerText || '').trim();
        merged.set(id, { id, title: title || `(zonder titel ${id})` });
      }
    };
    absorb();

    // "Recent"-sectie uitklappen als die dichtgeklapt is.
    const section = document.querySelector(SELECTORS.chatsSection);
    if (section && !/\bexpanded\b/.test(section.className)) {
      const toggle = Array.from(document.querySelectorAll(SELECTORS.sectionToggle))
        .find((b) => /recent|recentste/i.test(b.getAttribute('aria-label') || ''));
      if (toggle) {
        toggle.click();
        await sleep(1000);
      }
    }

    // Virtualisatie + lazy paginering: herhaald naar beneden en accumuleren
    // tot er vijf rondes geen nieuwe gesprekken meer bijkomen.
    const scroller = document.querySelector(SELECTORS.sidebarScroller);
    if (scroller) {
      let stable = 0;
      let lastSize = -1;
      for (let i = 0; i < 400 && stable < 5; i++) {
        scroller.scrollTop = scroller.scrollHeight;
        await sleep(600);
        absorb();
        if (merged.size === lastSize) stable += 1;
        else {
          stable = 0;
          lastSize = merged.size;
        }
      }
      scroller.scrollTop = 0;
      await sleep(400);
      absorb();
    }
    return Array.from(merged.values());
  }

  async function scrollToFindAnchor(id) {
    const sel = `a[href="/app/${id}"]`;
    let anchor = document.querySelector(sel);
    if (anchor) return anchor;
    const scroller = document.querySelector(SELECTORS.sidebarScroller);
    if (!scroller) return null;
    scroller.scrollTop = 0;
    await sleep(200);
    for (let i = 0; i < 300; i++) {
      anchor = document.querySelector(sel);
      if (anchor) return anchor;
      const prev = scroller.scrollTop;
      scroller.scrollTop = Math.min(scroller.scrollTop + scroller.clientHeight * 0.8, scroller.scrollHeight);
      await sleep(200);
      if (scroller.scrollTop === prev) break;
    }
    return document.querySelector(sel);
  }

  async function navigateTo(conv) {
    const anchor = await scrollToFindAnchor(conv.id);
    if (!anchor) return false;
    anchor.click();
    await sleep(400);
    return true;
  }

  /** Wacht tot de doelconversatie gerenderd én stabiel is; anders null. */
  async function waitForRender(targetId, prevFirstPrompt) {
    const deadline = Date.now() + 20000;
    let lastSig = '';
    let stableHits = 0;
    while (Date.now() < deadline) {
      await sleep(600);
      if (conversationIdFromUrl() !== targetId) continue;
      const turns = turnsFromDom();
      if (!turns.length) continue;
      const prompt = firstUserPrompt(turns);
      // De eerste prompt moet bestaan én verschillen van het vorige gesprek:
      // dat is de guard tegen het "stale body"-probleem (de SPA toont nog even
      // het vorige gesprek).
      if (!prompt) continue;
      if (prevFirstPrompt && prompt === prevFirstPrompt) continue;
      const sig = turns.length + ':' + turns.reduce((n, t) => n + t.text.length, 0);
      if (sig === lastSig) {
        stableHits += 1;
        if (stableHits >= 1) return turns;
      } else {
        stableHits = 0;
        lastSig = sig;
      }
    }
    if (conversationIdFromUrl() === targetId) {
      const turns = turnsFromDom();
      if (turns.length) return turns;
    }
    return null;
  }

  async function collectBulkConversations(onProgress) {
    const list = await harvestConversations();
    if (!list.length) {
      throw new Error('geen gesprekken in de zijbalk — open de linkerzijbalk');
    }
    const out = [];
    let prevFirstPrompt = '';
    for (let i = 0; i < list.length; i++) {
      const conv = list[i];
      onProgress && onProgress(i + 1, list.length, conv.title);
      const navigated = await navigateTo(conv);
      const turns = navigated ? await waitForRender(conv.id, prevFirstPrompt) : null;
      if (!turns || !turns.length) continue;
      prevFirstPrompt = firstUserPrompt(turns) || prevFirstPrompt;
      out.push(buildConversation({
        content: transcriptFromTurns(turns),
        turns,
        title: conv.title,
        url: `https://gemini.google.com/app/${conv.id}`,
        sourceProvider: 'gemini',
      }));
      await sleep(200);
    }
    return out;
  }

  const bulkButton = window.__chronicleUI.makeBulkButton(async () => {
    const ui = window.__chronicleUI;
    try {
      bulkButton.textContent = '⇊ lijst ophalen…';
      const conversations = await collectBulkConversations((i, total, name) => {
        bulkButton.textContent = `⇊ ophalen ${i}/${total}${name ? ' • ' + name.slice(0, 30) : ''}`;
      });
      if (!conversations.length) {
        bulkButton.textContent = '✗ geen gesprekken gevonden';
        setTimeout(() => (bulkButton.textContent = '⇊ Alles naar Chronicle'), 4000);
        return;
      }
      await ui.exportManyToChronicle(bulkButton, conversations);
    } catch (err) {
      bulkButton.textContent = '✗ ' + String(err && err.message ? err.message : err).slice(0, 60);
      setTimeout(() => (bulkButton.textContent = '⇊ Alles naar Chronicle'), 6000);
    }
  });

  const floatingButton = makeButton(() => {
    window.__chronicleUI.setButtonState(floatingButton, 'busy');
    runExport(floatingButton).catch((err) => {
      floatingButton.textContent = '✗ ' + String(err && err.message ? err.message : err).slice(0, 60);
      setTimeout(() => window.__chronicleUI.setButtonState(floatingButton, 'idle'), 6000);
    });
  });

  async function runExport(button) {
    const conv = collectConversation();
    if (conv.error) {
      button.textContent = '✗ ' + conv.error;
      setTimeout(() => window.__chronicleUI.setButtonState(button, 'idle'), 4000);
      return;
    }
    await exportToChronicle(button, conv);
  }

  // ── Automatische capture ─────────────────────────────────────────────────
  // Gemini's netwerkroute is ondoorzichtig en verandert; daarom is de DOM de
  // bron van waarheid. Een MutationObserver + settle-debounce levert het
  // gesprek zodra een antwoord klaar is met streamen. Bij het openen van een
  // bestaand gesprek exporteren we níet: pas groei t.o.v. de baseline (na
  // render-stilte) telt. Herlevering blijft veilig (listener dedupt op
  // url/contentHash), dus een te vroege levering is hooguit een update.
  let armed = false;
  let baseline = '';
  let settleTimer = null;

  function signature() {
    const turns = turnsFromDom();
    return turns.length + ':' + turns.reduce((n, t) => n + t.text.length, 0);
  }

  function scheduleCapture() {
    if (!armed) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const sig = signature();
      if (!sig || sig === baseline) return;
      baseline = sig;
      const conv = collectConversation();
      if (conv.error) {
        console.info('[Chronicle] auto-capture: niets op te halen (', conv.error, ')');
        return;
      }
      console.info('[Chronicle] auto-capture: levering —', (conv.turns || []).length, 'berichten');
      exportToChronicle(floatingButton, conv);
    }, 1800);
  }

  /** Neem de huidige stand als baseline nadat de pagina gerenderd is. */
  function armAfterSettle() {
    armed = false;
    baseline = '';
    setTimeout(() => {
      baseline = signature();
      armed = true;
    }, 4000);
  }

  new MutationObserver(scheduleCapture).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Bij een SPA-navigatie naar een ander gesprek eerst laten renderen, dan pas
  // als baseline nemen — anders exporteer je het net geopende oude gesprek.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    armAfterSettle();
  }, 1000);
  armAfterSettle();

  // Diagnose: laat eenmalig zien of de DOM-selectors nog werken. Breekt een
  // Google-update de markup, dan zie je hier 0 containers i.p.v. een stille
  // breuk (de juiste strings staan bovenin SELECTORS).
  setTimeout(() => {
    const containers = document.querySelectorAll(SELECTORS.turnContainer).length;
    const turns = turnsFromDom().length;
    console.info('[Chronicle] gemini DOM-diagnose:', containers, 'containers,', turns, 'berichten');
  }, 5000);

  // Het interceptorsignaal blijft als bonus-trigger: het vuurt directer dan de
  // observer (al is de observer de betrouwbare basis).
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'chronicle-intercept' || data.type !== 'conversation-updated') return;
    if (data.provider !== 'gemini') return;
    scheduleCapture();
  });

  window.__chronicleUI.bindToolbarClick(() => {
    window.__chronicleUI.setButtonState(floatingButton, 'busy');
    runExport(floatingButton).catch((err) => {
      floatingButton.textContent = '✗ ' + String(err && err.message ? err.message : err).slice(0, 60);
      setTimeout(() => window.__chronicleUI.setButtonState(floatingButton, 'idle'), 6000);
    });
  });

  console.info('[Chronicle] gemini provider actief');
})();
