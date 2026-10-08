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

  function turnsFromDom() {
    const turns = [];
    // Primaire selectors (chat-pagina), plus de brede per-bericht-role-
    //    attributen die claude.ai ook in cowork-sessies gebruikt.
    let blocks = document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"]');
    if (!blocks.length) {
      blocks = document.querySelectorAll('[data-test-streamer="true"], .font-claude-message, .font-user-message');
    }
    for (const block of blocks) {
      const testid = block.getAttribute('data-testid');
      const streamer = block.getAttribute('data-test-streamer');
      const isUser = testid === 'user-message' || streamer === 'false';
      const text = (block.innerText || '').trim();
      if (!text) continue;
      turns.push({ role: isUser ? 'user' : 'assistant', text });
    }
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
