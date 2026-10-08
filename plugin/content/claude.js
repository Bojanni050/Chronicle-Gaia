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
  if (window.__chronicleClaudeInjected) return;
  window.__chronicleClaudeInjected = true;

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

  async function fetchConversation(uuid) {
    const org = localStorage.getItem('lastActiveOrg');
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
    const blocks = document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"]');
    for (const block of blocks) {
      const text = (block.innerText || '').trim();
      if (!text) continue;
      turns.push({
        role: block.getAttribute('data-testid') === 'user-message' ? 'user' : 'assistant',
        text,
      });
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

  const floatingButton = makeButton(async (event) => {
    await runExport(event.currentTarget);
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
  window.__chronicleUI.bindToolbarClick(() => runExport(floatingButton));
})();
