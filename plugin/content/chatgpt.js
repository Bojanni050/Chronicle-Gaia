/**
 * chatgpt.com provider-script. Haalt het huidige gesprek op via de interne
 * API (GET /backend-api/conversation/{id} met de sessie-cookie), met een
 * DOM-fallback. Normaliseert naar de ParsedConversation-vorm (mapping-tree
 * → geordende turns, zelfde regels als utils/sourceParsers.ts) en levert af
 * via de service worker.
 *
 * Idempotent: Chrome kan het script opnieuw injecteren (extensie-herladen,
 * SPA-navigatie). De tweede run stopt in de guard.
 */
(() => {

  const { makeButton, exportToChronicle, buildConversation } = window.__chronicleUI;

  function conversationIdFromUrl() {
    const match = location.pathname.match(/\/c\/([0-9a-f-]{16,})/i);
    return match ? match[1] : null;
  }

  async function fetchConversation(id) {
    const res = await fetch(`/backend-api/conversation/${id}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`chatgpt API ${res.status}`);
    return res.json();
  }

  function mappingToOrderedMessages(mapping) {
    const nodes = Object.values(mapping || {});
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const roots = nodes.filter((n) => !n.parent || !byId.has(n.parent));
    const ordered = [];
    const seen = new Set();
    const walk = (node) => {
      if (!node || seen.has(node.id)) return;
      seen.add(node.id);
      if (node.message) ordered.push(node.message);
      (node.children || []).forEach((childId) => walk(byId.get(childId)));
    };
    roots.forEach(walk);
    return ordered;
  }

  function messageText(msg) {
    const parts = msg?.content?.parts;
    if (Array.isArray(parts)) {
      return parts.filter((p) => typeof p === 'string' && p.trim()).join('\n').trim();
    }
    if (typeof msg?.content?.text === 'string') return msg.content.text.trim();
    return '';
  }

  function turnsFromApi(root) {
    const turns = [];
    for (const msg of mappingToOrderedMessages(root.mapping)) {
      const role = msg?.author?.role;
      if (!role || role === 'system' || role === 'tool') continue;
      const text = messageText(msg);
      if (!text) continue;
      turns.push({ role: role === 'user' ? 'user' : 'assistant', text });
    }
    return turns;
  }

  /**
   * Zet een DOM-node om naar tekst waarbij codeblokken als echte markdown-
   * fences gemarkeerd worden (```), zodat de archive-viewer ze als codeblok
   * rendert i.p.v. platgeslagen tekst.
   */
  function innerTextWithCodeFences(node) {
    const clone = node.cloneNode(true);
    const pres = [...clone.querySelectorAll('pre')];
    for (const pre of pres) {
      const code = pre.querySelector('code');
      const text = (code || pre).innerText || '';
      const langMatch = (code?.className || '').match(/language-([\w-]+)/);
      const lang = langMatch ? langMatch[1] : '';
      const fenced = '\n```' + lang + '\n' + text.replace(/\n+$/, '') + '\n```\n';
      pre.replaceWith(document.createTextNode(fenced));
    }
    return clone.innerText || '';
  }

  function turnsFromDom() {
    const turns = [];
    const blocks = document.querySelectorAll('[data-message-author-role]');
    for (const block of blocks) {
      const role = block.getAttribute('data-message-author-role');
      if (role !== 'user' && role !== 'assistant') continue;
      const text = innerTextWithCodeFences(block).trim();
      if (!text) continue;
      turns.push({ role, text });
    }
    return turns;
  }

  function transcriptFromTurns(turns) {
    return turns
      .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}`)
      .join('\n\n');
  }

  async function collectConversation() {
    const id = conversationIdFromUrl();
    let turns = null;
    let title = null;
    let occurredAt = null;
    if (id) {
      try {
        const root = await fetchConversation(id);
        turns = turnsFromApi(root);
        title = typeof root.title === 'string' && root.title.trim() ? root.title.trim() : null;
        occurredAt = root.update_time || root.create_time || null;
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
      title,
      url: id ? `https://chatgpt.com/c/${id}` : location.href,
      sourceProvider: 'chatgpt',
      occurredAt,
    });
  }

  async function collectAllConversations() {
    const conversations = [];
    let offset = 0;
    // De lijst is gepagineerd; wandel alle pagina's af (limit 100 per keer).
    while (true) {
      const res = await fetch(`/backend-api/conversations?offset=${offset}&limit=100&order=updated`, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`chatgpt conversations API ${res.status}`);
      const body = await res.json();
      const items = body.items || [];
      conversations.push(...items);
      if (items.length < 100) break;
      offset += 100;
    }
    return conversations;
  }

  async function collectBulkConversations(onProgress) {
    const list = await collectAllConversations();
    const out = [];
    let i = 0;
    // In batches van 3 met 200ms pauze — zelfde beschermingspatroon als de
    // Claude-provider (overgenomen van agoramachina/claude-exporter).
    const BATCH = 3;
    for (let b = 0; b < list.length; b += BATCH) {
      const batch = list.slice(b, b + BATCH);
      const results = await Promise.all(batch.map(async (conv) => {
        try {
          const root = await fetchConversation(conv.id);
          const turns = turnsFromApi(root);
          if (!turns.length) return null;
          return buildConversation({
            content: transcriptFromTurns(turns),
            turns,
            title: typeof conv.title === 'string' && conv.title.trim() ? conv.title.trim() : undefined,
            url: `https://chatgpt.com/c/${conv.id}`,
            sourceProvider: 'chatgpt',
            occurredAt: conv.update_time || conv.create_time || null,
          });
        } catch {
          return null; // één onbereikbaar gesprek mag de bulk niet breken
        }
      }));
      for (const conv of results) {
        i++;
        if (conv) out.push(conv);
        onProgress && onProgress(i, list.length, conv ? (conv.title || '') : '—');
      }
      if (b + BATCH < list.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
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

  // ── Automatische capture (fase 3) ────────────────────────────────────────
  // Zelfde patroon als de Claude-provider: het interceptorscript seint, hier
  // wordt (debounced) het huidige gesprek via de bewezen route opgehaald en
  // afgeleverd. Herlevering is veilig (listener-dedup).
  let autoCaptureTimer = null;
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'chronicle-intercept' || data.type !== 'conversation-updated') return;
    if (data.provider !== 'chatgpt') return;
    clearTimeout(autoCaptureTimer);
    autoCaptureTimer = setTimeout(async () => {
      const conv = await collectConversation();
      if (conv.error) return;
      await exportToChronicle(floatingButton, conv);
    }, 1500);
  });

  // De toolbar-knop van de extensie triggert dezelfde export.
  window.__chronicleUI.bindToolbarClick(() => {
    window.__chronicleUI.setButtonState(floatingButton, 'busy');
    runExport(floatingButton).catch((err) => {
      floatingButton.textContent = '✗ ' + String(err && err.message ? err.message : err).slice(0, 60);
      setTimeout(() => window.__chronicleUI.setButtonState(floatingButton, 'idle'), 6000);
    });
  });
})();
