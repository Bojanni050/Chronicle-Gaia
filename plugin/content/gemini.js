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
      // Gemeten (2026-10-29): de user-prompt staat dubbel in de DOM (a11y-
      // label + zichtbare tekst leveren allebei dezelfde regel). Een exact
      // herhaalde kop vouwen we samen: "X\n\nX" → "X".
      .replace(/^([^\n]{1,4000})\n\n\1$/, '$1')
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

  /**
   * Bijlagen uit de DOM. Gemini heeft geen leesbare API voor bijlagen, dus
   * dit is de enige route.
   *
   * Gemeten in de echte DOM (console-meting 2026-10-29): geüploade afbeeldingen
   * renderen als `lh3.googleusercontent.com/gg/…`-thumbnail (512 breed, alt
   * "Uploaded image preview"), gegenereerde afbeeldingen als `blob:`-URL's
   * (1024 breed) met een beschrijvende alt. Decoderende puinfilters nodig: de
   * account-avatar onder `lh3…/a/…` (64px, lege alt) en de Google-sparkle-svg
   * (150px) passeren de oude ≥64px-toets en de alt/src-woordenlijst nog.
   *
   * De chat is GÉVIRTUALISEERD (console-meting 2026-10-29): container 0–8
   * bestaan altijd als placeholder, maar hun tekst is pas in de DOM zodra ze
   * door de viewport zijn gegaan — en wordt er daarna weer uit gewist.
   * Dus kan er niet één keer gelezen worden: `collectRendered()` scrollt de
   * tijdlijn van boven naar beneden in stappen en bewaart per container de
   * best-geziene tekst én bijlagen, zodat de later weer gewiste beurten
   * overleven in de state.
   *
   * Positie: een upload hangt in de user-query, een gegenereerde afbeelding in
   * het antwoord — `afterTurn` verwijst naar de echte turns-index (opgebouwd
   * o.b.v. welke containers zelf wél tekst hadden), niet naar
   * container-index × 2: bij lege containers breekt die teller. Zonder
   * `afterTurn` belandt alles bovenaan de chat (zelfde val als bij ChatGPT).
   *
   * `blob:` kan alleen het content script lezen, niet de service worker, dus
   * de bytes gaan als base64 in de verwijzing (zelfde route als chatgpt.js) —
   * hier is geen matching nodig: de blob is zelf de bijlage. Aan dezelfde
   * afbeelding in meerdere beurten (zelfde url) hangt één referentie: dedup
   * op de eerst-geziene beurt.
   */
  async function blobBytes(src) {
    // Blokgewijze base64; één String.fromCharCode.apply op een paar MB blaast
    // de stack op — zelfde les als bij chatgpt.js.
    const response = await fetch(src);
    if (!response.ok) throw new Error(`blob ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return {
      base64: btoa(binary),
      mimeType: response.headers.get('content-type') || 'image/png',
      size: bytes.length,
    };
  }

  /** De alt is bij geüploade afbeeldingen de generieke placeholder, geen naam. */
  function nameFromAlt(alt) {
    if (!alt) return null;
    if (/^(uploaded image preview|thumbnail|preview)$/i.test(alt)) return null;
    const clean = alt.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim();
    if (clean.length < 8) return null;
    return clean.slice(0, 60);
  }

  function isDecor(src) {
    // Account-avatars en Google-decoratie: geen chatbijlage.
    return (
      /googleusercontent\.com\/a\//i.test(src) ||
      /sparkle|lamda/i.test(src) ||
      /\.svg($|\?)/i.test(src)
    );
  }

  /** Dichtstbijzijnde scrollbare ancestor van de beurt-containers. */
  function findChatScroller() {
    const container = document.querySelector(SELECTORS.turnContainer);
    let el = container && container.parentElement;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 10) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  /** Zit dit element in de prompt-kant van de beurt, of in het antwoord? */
  function sideOf(element) {
    return element.closest('user-query') || element.closest('.user-query') ? 'user' : 'model';
  }

  /**
   * Alle beurten en bijlagen verzamelen over een Gévirtualiseerde tijdlijn.
   *
   * Werkwijze (bewezen via console-meting): de containers blijven als
   * placeholder in de DOM staan, maar hun tekst en afbeeldingen verschijnen
   * pas wanneer de viewport eraan komt en worden daarna weer gewist. Maar één
   * keer "alles lezen" is dus fout. Deze functie scrollt van boven naar
   * beneden en houdt per container de bestgeziene tekst + bijlagen vast —
   * na het scrollen is de verzamelde state compleet, wat de DOM daarna ook
   * weer dreigt te wissen.
   */
  async function collectRendered() {
    // Per container-element een record: buiten de viewport gewiste tekst ×
    // virtualisatie verliezen we niet, want we blijven de bestgeziene waarden
    // vasthouden. Bijlagen dedupliceren we per verwijzing (blob-url/CDN-url).
    const state = new Map(); // container → { user, model, atts: Map(key → rec) }
    const ensure = (container) => {
      let s = state.get(container);
      if (!s) {
        s = { user: '', model: '', atts: new Map() };
        state.set(container, s);
      }
      return s;
    };

    const collectCandidates = (container, s) => {
      for (const img of container.querySelectorAll('img[src]')) {
        const src = img.currentSrc || img.src;
        if (!src) continue;
        const isBlob = /^blob:/i.test(src);
        if (!isBlob && !/^https?:/i.test(src)) continue;
        if (isDecor(src)) continue;
        const alt = (img.alt || '').trim();
        if (/avatar|profile|emoji|icon|logo/i.test(src + ' ' + alt)) continue;
        // naturalWidth staat pas na het laden; lazy-afbeeldingen mogen dus met
        // 0 door de toets heen (de decor-geval heeft wél al grootte).
        if ((img.naturalWidth || 0) > 0 && img.naturalWidth < 64) continue;
        const key = (isBlob ? 'blob:' : 'img:') + src;
        const rec = s.atts.get(key);
        if (rec) {
          // Lazy-set alt: alsnog proberen de bestandsnaam te verbeteren.
          if (!rec.alt && alt) rec.alt = alt;
          continue;
        }
        s.atts.set(key, { kind: isBlob ? 'blob' : 'img', src, alt, side: sideOf(img), bytes: null, failed: false });
      }
      for (const anchor of container.querySelectorAll('a[href]')) {
        const href = anchor.href;
        if (!href || !/^https?:/i.test(href)) continue;
        if (!/googleusercontent|contribution\.usercontent|drive\.google/i.test(href)) continue;
        const label = (anchor.getAttribute('download') || anchor.getAttribute('aria-label') || anchor.innerText || '').trim();
        const key = 'a:' + href;
        const rec = s.atts.get(key);
        if (rec) {
          if (!rec.label && label) rec.label = label;
          continue;
        }
        s.atts.set(key, { kind: 'anchor', src: href, label, side: sideOf(anchor), bytes: null, failed: false });
      }
    };

    const scan = () => {
      for (const container of document.querySelectorAll(SELECTORS.turnContainer)) {
        const s = ensure(container);
        const userText = cleanText(firstMatchText(container, SELECTORS.userQuery));
        if (userText && userText.length > s.user.length) s.user = userText;
        const modelText = cleanText(firstMatchText(container, SELECTORS.modelResponse));
        if (modelText && modelText.length > s.model.length) s.model = modelText;
        collectCandidates(container, s);
      }
    };

    // Blob-bytes ophalen zodra we ze zien — een blob-url sterft bij het
    // uit-fokusen van zijn container, dus nóoit later opnieuw proberen.
    const drainBlobs = async () => {
      for (const s of state.values()) {
        for (const rec of s.atts.values()) {
          if (rec.kind !== 'blob' || rec.bytes || rec.failed) continue;
          try {
            rec.bytes = await blobBytes(rec.src);
          } catch (err) {
            rec.failed = true;
            console.info(
              '[Chronicle] gemini blob onleesbaar:',
              rec.src.slice(0, 48),
              String((err && err.message) || err)
            );
          }
        }
      }
    };

    // Pas op: het scrollen zelf triggert MutationObserver en auto-capture;
    // revealing-uitgeschakeld via de flag hieronder.
    revealing = true;
    try {
      scan();
      await drainBlobs();
      const scroller = findChatScroller();
      if (scroller) {
        scroller.scrollTop = 0;
        await sleep(300);
        scan();
        await drainBlobs();
        let stable = 0;
        let prevFilled = -1;
        for (let i = 0; i < 300; i++) {
          const prev = scroller.scrollTop;
          scroller.scrollTop = Math.min(
            prev + Math.max(Math.round(scroller.clientHeight * 0.7), 200),
            scroller.scrollHeight
          );
          await sleep(350);
          scan();
          await drainBlobs();
          const filled = Array.from(state.values())
            .reduce((n, s) => n + (s.user ? 1 : 0) + (s.model ? 1 : 0), 0);
          const atBottom =
            scroller.scrollTop <= prev + 2 ||
            scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
          if (filled === prevFilled) stable += 1;
          else {
            stable = 0;
            prevFilled = filled;
          }
          if (atBottom && stable >= 3) break;
        }
      }
      scan();
      await drainBlobs();
    } finally {
      revealing = false;
      if (armed) {
        // Ravenbaseline op de nieuwe stand: zoveel leverde de export op —
        // auto-capture opnieuw vergelijken i.p.v. meteen "nieuw" te melden.
        baseline = signature();
      }
    }

    // Samenstelling: eerst beurten (met echte index), daarna bijlagen gekleefd
    // aan hun eigen beurt — mapping op de turns-array, niet op container-index.
    const ordered = Array.from(document.querySelectorAll(SELECTORS.turnContainer));
    const turns = [];
    const turnIndex = new Map(); // container → { user, model, before }
    for (const container of ordered) {
      const s = state.get(container);
      const userText = s && s.user;
      const modelText = s && s.model;
      const before = turns.length;
      const idxUser = userText ? turns.length : null;
      if (userText) turns.push({ role: 'user', text: userText });
      const idxModel = modelText ? turns.length : null;
      if (modelText) turns.push({ role: 'assistant', text: modelText });
      turnIndex.set(container, { user: idxUser, model: idxModel, before });
    }

    const afterTurnFor = (container, side) => {
      const idx = turnIndex.get(container);
      if (!idx) return null;
      const own = side === 'user' ? idx.user : idx.model;
      if (own !== null && own !== undefined) return own;
      if (side === 'model' && idx.user !== null && idx.user !== undefined) {
        // Antwoord zonder tekst (alleen de afbeelding): de beurt bestaat
        // niet op de turns-array, maar de foto hoort wél bij dát antwoord —
        // dus aan de eigen prompt-beurt plakken i.p.v. bovenaan verdwijnen.
        return idx.user;
      }
      // De beurt bestaat niet (prompt zonder tekst): plak aan de laatste
      // beurt hiervoor; op de allereerste container betekent dat bovenaan.
      return idx.before > 0 ? idx.before - 1 : null;
    };

    const seen = new Set();
    const attachments = [];
    // Middiagnose: per container de beurtindex, zodat een plaatsingsvraag uit
    // één logregel te beantwoorden is (bijv. "waarom hangt de foto op ?").
    console.info(
      '[Chronicle] gemini map:',
      ordered
        .map((c, i) => {
          const idx = turnIndex.get(c);
          return `c${i} u=${idx.user ?? '-'} m=${idx.model ?? '-'}`;
        })
        .join(' | ')
    );
    for (const container of ordered) {
      const s = state.get(container);
      if (!s) continue;
      for (const rec of s.atts.values()) {
        const key = rec.kind === 'blob' ? 'blob:' + rec.src : rec.src;
        if (seen.has(key)) continue;
        seen.add(key);
        if (rec.kind === 'blob') {
          const ref = window.__chronicleUI.attachmentRef({
            download: 'blob',
            afterTurn: afterTurnFor(container, rec.side),
            filename: nameFromAlt(rec.alt) || 'gegenereerde afbeelding',
          });
          if (rec.bytes) {
            ref.dataBase64 = rec.bytes.base64;
            ref.mimeType = rec.bytes.mimeType;
            ref.size = rec.bytes.size;
          }
          attachments.push(ref);
          continue;
        }
        attachments.push(window.__chronicleUI.attachmentRef({
          url: rec.src,
          download: 'direct',
          afterTurn: afterTurnFor(container, rec.side),
          filename: rec.kind === 'anchor'
            ? (rec.label && rec.label.length > 2 ? rec.label : null)
            : nameFromAlt(rec.alt),
        }));
      }
    }

    const carried = attachments.filter((a) => a.dataBase64 || a.url).length;
    console.info(
      '[Chronicle] bijlagen (gemini):',
      attachments.length,
      'verzameld,',
      carried,
      'met bron |',
      turns.length,
      'beurten =',
      attachments
        .filter((a) => a.dataBase64 || a.url)
        .map((a) => `${a.filename || '?'} → na beurt ${a.afterTurn ?? '?'}`)
        .join(' | ')
    );
    return { turns, attachments };
  }

  async function collectConversation() {
    const id = conversationIdFromUrl();
    const { turns, attachments } = await collectRendered();
    if (!turns.length) {
      return { error: 'geen berichten gevonden op deze pagina' };
    }
    return buildConversation({
      content: transcriptFromTurns(turns, attachments),
      turns,
      title: titleFromSidebar(id),
      url: id ? `https://gemini.google.com/app/${id}` : location.href,
      sourceProvider: 'gemini',
      attachments,
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

  /**
   * Wacht tot de doelconversatie zichtbaar is en de zichtbare beurt-staart
   * stabiel is. De eigennaamse beurten moeten dáárna via collectRendered()
   * uit de virtualistie-scroll komen; hier gaat het alleen om de
   * stale-body-guard (het SPA-vraagstuk: de URL is al het nieuwe gesprek, de
   * DOM toont nog even het oude).
   */
  async function waitForConversation(targetId) {
    const deadline = Date.now() + 20000;
    let lastSig = '';
    let stableHits = 0;
    while (Date.now() < deadline) {
      await sleep(600);
      if (conversationIdFromUrl() !== targetId) continue;
      const turns = turnsFromDom();
      if (!turns.length) continue;
      const sig =
        turns.length + ':' + turns.reduce((n, t) => n + t.text.length, 0);
      if (sig === lastSig) {
        stableHits += 1;
        if (stableHits >= 1) return true;
      } else {
        stableHits = 0;
        lastSig = sig;
      }
    }
    return conversationIdFromUrl() === targetId && turnsFromDom().length > 0;
  }

  async function collectBulkConversations(onProgress) {
    const list = await harvestConversations();
    if (!list.length) {
      throw new Error('geen gesprekken in de zijbalk — open de linkerzijbalk');
    }
    const out = [];
    // Stale-body-guard: het SPA-vraagstuk is dat de DOM nog even het vorige
    // gesprek toont nadat de URL al wisselde. Een volledig gelijk
    // beurten-signatuur (aantal + tekensamenstelling) betekent vrijwel altijd
    // dat het oude gesprek nog op het scherm stond — dan skippen en wachten.
    let prevSig = '';
    for (let i = 0; i < list.length; i++) {
      const conv = list[i];
      onProgress && onProgress(i + 1, list.length, conv.title);
      const navigated = await navigateTo(conv);
      if (!navigated || !(await waitForConversation(conv.id))) continue;
      const { turns, attachments } = await collectRendered();
      if (!turns.length) continue;
      const sig = turns.length + ':' + turns.reduce((n, t) => n + t.text.length, 0);
      if (prevSig && sig === prevSig) {
        console.info('[Chronicle] gemini bulk: overslaan (stale body):', conv.title);
        continue;
      }
      prevSig = sig;
      console.info(
        '[Chronicle] gemini bulk:',
        (conv.title || '(zonder titel)').slice(0, 40),
        '→',
        turns.length,
        'beurten,',
        attachments.length,
        'bijlagen'
      );
      out.push(buildConversation({
        content: transcriptFromTurns(turns, attachments),
        turns,
        title: conv.title,
        url: `https://gemini.google.com/app/${conv.id}`,
        sourceProvider: 'gemini',
        attachments,
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
    const conv = await collectConversation();
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
  // Tijdens collectRendered() scrollen we door de tijdlijn; elke stap triggert
  // de observer en dus scheduleCapture op zichzelf. Terwijl de collectie draait
  // negeren we captures — de baseline wordt na afloop op de nieuwe stand gezet.
  let revealing = false;

  // Bewust zonder reveal-scroll: dit is de snelle wijzigingsdetector voor de
  // observer. Groei van een lopend antwoord gebeurt aan de onderkant (zichtbaar
  // en gerenderd), dus de zichtbare staart is voldoende als baseline.
  function signature() {
    const turns = turnsFromDom();
    return turns.length + ':' + turns.reduce((n, t) => n + t.text.length, 0);
  }

  function scheduleCapture() {
    if (!armed || revealing) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      const sig = signature();
      if (!sig || sig === baseline) return;
      baseline = sig;
      // Asynchroon sinds de blob-bijlagen: bytes lezen kan de waarde pas later
      // opleveren; alles in de promise om ordering te behouden.
      collectConversation().then((conv) => {
        if (conv.error) {
          console.info('[Chronicle] auto-capture: niets op te halen (', conv.error, ')');
          return;
        }
        console.info('[Chronicle] auto-capture: levering —', (conv.turns || []).length, 'berichten');
        exportToChronicle(floatingButton, conv);
      });
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
