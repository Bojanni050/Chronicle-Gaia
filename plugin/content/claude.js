/**
 * claude.ai provider-script. Haalt het huidige gesprek op via de interne
 * API (primaire bron: GET /api/organizations/{org}/chat_conversations/{uuid}),
 * met een DOM-fallback voor het geval de API-vorm wijzigt. Normaliseert naar
 * de ParsedConversation-vorm en levert af via de service worker.
 *
 * Idempotent: Chrome kan het script opnieuw injecteren (extensie-herladen,
 * SPA-navigatie). De tweede run stopt in de guard; top-level const-declaraties
 * kunnen dan ook niet meer botsen.
 */
(() => {

  const { makeButton, exportToChronicle, buildConversation } = window.__chronicleUI;

  function conversationUuidFromUrl() {
    const match = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
    return match ? match[1] : null;
  }

  function lastConversationUuidFromDom() {
    // Alleen op een echte /chat/<uuid>-pagina: op /cowork-pagina's staat geen
    // uuid in de URL en de sidebar-links zijn *andere* gesprekken — die als
    // bron nemen exporteert stiekem de verkeerde chat. Daar is null de
    // eerlijke waarde; de DOM-fallback levert dan de zichtbare inhoud.
    if (!/\/chat\//.test(location.pathname)) return null;
    const link = document.querySelector('a[href*="/chat/"]');
    if (!link) return null;
    const match = (link.getAttribute('href') || '').match(/\/chat\/([0-9a-f-]{36})/i);
    return match ? match[1] : null;
  }

  /**
   * De org-id staat niet in elke installatie onder dezelfde localStorage-
   * sleutel. Resolutie in volgorde: bekende sleutels → elke sleutel met een
   * uuid die op "org" lijkt → de /api/organizations-lijst (waar de webclient
   * zelf ook uit leest).
   */
  async function resolveOrgId() {
    const knownKeys = ['lastActiveOrg', 'lastActiveOrgId', 'activeOrg'];
    for (const key of knownKeys) {
      const value = localStorage.getItem(key);
      if (value && /^[0-9a-f-]{36}$/i.test(value.trim())) return value.trim();
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/org/i.test(key)) continue;
      const value = localStorage.getItem(key);
      const match = (value || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (match) return match[0];
    }
    try {
      const res = await fetch('/api/organizations', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const org = body?.org?.uuid || body?.[0]?.uuid || body?.uuid;
      if (org) return org;
    } catch {
      // geen van de routes werkte: de DOM-fallback neemt het over
    }
    return null;
  }

  async function fetchConversation(uuid) {
    const org = await resolveOrgId();
    if (!org) throw new Error('no org');
    const res = await fetch(`/api/organizations/${org}/chat_conversations/${uuid}?tree=True&rendering=tree`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`claude API ${res.status}`);
    return res.json();
  }

  function turnsFromApi(conv) {
    const turns = [];
    for (const msg of conv.chat_messages || []) {
      let text = '';
      if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n\n');
      } else if (typeof msg.text === 'string') {
        text = msg.text;
      }
      text = (text || '').trim();
      if (!text) continue;
      turns.push({ role: msg.sender === 'assistant' ? 'assistant' : 'user', text });
    }
    return turns;
  }

  /**
   * Cowork-sessies markeren elk bericht semantisch: een h2.sr-only met
   * "You said:" of "Claude responded:", binnen een class*="message-row"-
   * container. Dat is exacter dan elke testid-heuristiek — de rol staat er
   * letterlijk in.
   */
  /**
   * Plakte iemand een attachment-naam of hash in de chat (bv.
   * 'ACFrOgA7...pdf'), dan staat zo'n reeks van 40+ tekens als een onleesbare
   * blob in het archief. Die tokens worden hier leesbaar ingekort; de rest
   * van de tekst blijft onaangetast. Geldt alleen voor de DOM-scrape — de
   * API-route levert de echte turns en blijft verbatim.
   */
  const OPAQUE_TOKEN = /[A-Za-z0-9_-]{40,}/g;

  function shortenOpaqueTokens(text) {
    return text.replace(OPAQUE_TOKEN, (m) => m.slice(0, 12) + '…[' + m.length + ' tekens]');
  }

  function turnsFromCoworkMarkers() {
    const headers = [...document.querySelectorAll('h2.sr-only')].filter((h) =>
      /^(you said|claude responded)/i.test((h.textContent || '').trim())
    );
    if (!headers.length) return [];
    const A11Y_NOISE = [
      /^you said/i,
      /^claude responded/i,
      /^computer actions available/i,
      /^use the up and down arrow keys/i,
      /^press tab/i,
      /^allow pasting/i,
      /^warning: don/i,
    ];
    return headers
      .map((h) => {
        const isUser = /^you said/i.test((h.textContent || '').trim());
        const container =
          h.closest('[class*="message-row"]') || h.parentElement || h;
        const text = shortenOpaqueTokens(
          (container.innerText || '')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !A11Y_NOISE.some((re) => re.test(line)))
            .join('\n')
        ).trim();
        return { role: isUser ? 'user' : 'assistant', text };
      })
      .filter((t, i, arr) => t.text && arr.findIndex((x) => x.text === t.text) === i);
  }

  function turnsFromDom() {
    const turns = [];
    // Vier lagen, breedst laatst: chat-pagina-testids → streamer/font-
    //    klassen → data-testid*="message" → de generieke StreamBlock-markup
    //    die claude.ai in cowork-sessies voor alle berichten gebruikt.
    let blocks = document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"]');
    if (!blocks.length) {
      blocks = document.querySelectorAll('[data-test-streamer="true"], .font-claude-message, .font-user-message');
    }
    if (!blocks.length) {
      blocks = document.querySelectorAll('[data-testid*="message"], [data-test-id*="message"]');
    }
    if (!blocks.length) {
      blocks = document.querySelectorAll('[data-stream="input"], [data-stream="output"], .stream-block, [class*="stream-block"]');
    }
    for (const block of blocks) {
      const testid = block.getAttribute('data-testid') || block.getAttribute('data-test-id') || '';
      const streamer = block.getAttribute('data-test-streamer');
      const stream = block.getAttribute('data-stream');
      const isUser =
        testid === 'user-message' ||
        streamer === 'false' ||
        stream === 'input' ||
        /user|human/i.test(testid);
      const text = (block.innerText || '').trim();
      if (!text) continue;
      turns.push({ role: isUser ? 'user' : 'assistant', text });
    }
    console.info('[Chronicle] DOM-fallback:', turns.length, 'berichten gevonden');
    return turns;
  }

  function transcriptFromTurns(turns) {
    return turns
      .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}`)
      .join('\n\n');
  }

  async function collectConversation() {
    const uuid = conversationUuidFromUrl() || lastConversationUuidFromDom();
    let turns = null;
    let name = null;
    let occurredAt = null;
    if (uuid) {
      try {
        const conv = await fetchConversation(uuid);
        turns = turnsFromApi(conv);
        name = typeof conv.name === 'string' && conv.name.trim() ? conv.name.trim() : null;
        occurredAt = conv.updated_at || conv.created_at || null;
      } catch {
        turns = null; // val door naar de DOM-fallback
      }
    }
    if (!turns || !turns.length) {
      turns = turnsFromCoworkMarkers();
      console.info('[Chronicle] cowork-markers:', turns.length, 'berichten');
    }
    if (!turns || !turns.length) {
      turns = turnsFromDom();
    }
    if (!turns.length) {
      return { error: 'geen berichten gevonden op deze pagina' };
    }
    return buildConversation({
      content: transcriptFromTurns(turns),
      turns,
      title: name,
      url: uuid ? `https://claude.ai/chat/${uuid}` : location.href,
      sourceProvider: 'claude',
      occurredAt: occurredAt ? Date.parse(occurredAt) || occurredAt : undefined,
    });
  }

  const floatingButton = makeButton(() => {
    // Directe feedback, vóór async werk: als de klik iets doet, zie je het meteen.
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

  // De toolbar-knop van de extensie triggert dezelfde export.
  window.__chronicleUI.bindToolbarClick(() => {
    window.__chronicleUI.setButtonState(floatingButton, 'busy');
    runExport(floatingButton).catch((err) => {
      floatingButton.textContent = '✗ ' + String(err && err.message ? err.message : err).slice(0, 60);
      setTimeout(() => window.__chronicleUI.setButtonState(floatingButton, 'idle'), 6000);
    });
  });
})();
