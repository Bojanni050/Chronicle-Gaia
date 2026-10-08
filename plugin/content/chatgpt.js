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

  const { makeButton, exportToChronicle, buildConversation, transcriptFromTurns, innerTextWithCodeFences, toEpochMs } = window.__chronicleUI;

  function conversationIdFromUrl() {
    const match = location.pathname.match(/\/c\/([0-9a-f-]{16,})/i);
    return match ? match[1] : null;
  }

  async function fetchConversation(id) {
    const res = await fetch(`/backend-api/conversation/${id}`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`chatgpt API ${res.status}`);
    return res.json();
  }

  /**
   * Reconstrueert de actieve tak via current_node: van die node terug naar
   * de root via parent. Zonder deze stap bevatten exports alle takken
   * (bewerkingen/regeneraties) plat in het transcript. Zonder current_node
   * valt de functie terug op de hele boom in DFS-volgorde.
   */
  function activeBranchMessages(root) {
    const mapping = root.mapping || {};
    const byId = new Map(Object.values(mapping).map((n) => [n.id, n]));
    const currentId = root.current_node;
    if (!currentId || !byId.has(currentId)) {
      const nodes = Object.values(mapping);
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
    const branch = [];
    let current = byId.get(currentId);
    while (current) {
      if (current.message) branch.unshift(current.message);
      current = current.parent && byId.has(current.parent) ? byId.get(current.parent) : null;
    }
    return branch;
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
    for (const msg of activeBranchMessages(root)) {
      const role = msg?.author?.role;
      if (!role || role === 'system' || role === 'tool') continue;
      const text = messageText(msg);
      if (!text) continue;
      turns.push({ role: role === 'user' ? 'user' : 'assistant', text });
    }
    return turns;
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
      cache: 'no-store',
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
  window.addEventListener('message', (event) => {
    // Geen event.source-check: in de isolated world is event.source het
    // MAIN-world window — een ander object dan de content-script-window,
    // dus die vergelijking wijst altijd af. De origin- en source-veld-
    // controles samen zijn voldoende streng.
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'chronicle-intercept' || data.type !== 'conversation-updated') return;
    if (data.provider !== 'chatgpt') return;
    console.info('[Chronicle] auto-capture signaal', JSON.stringify(data));
    // Zelfde herhalende levering als de Claude-provider: het signaal valt bij
    // de headers, het antwoord streamt nog. Dedup aan de listener-kant maakt
    // tussenliggende leveringen onschadelijk; de laatste heeft alles.
    const ATTEMPTS = [2000, 4000, 6000];
    ATTEMPTS.forEach((delay, i) => {
      setTimeout(async () => {
        const conv = await collectConversation();
        if (conv.error) {
          if (i === ATTEMPTS.length - 1) console.info('[Chronicle] auto-capture: niets op te halen (', conv.error, ')');
          return;
        }
        console.info('[Chronicle] auto-capture: levering', i + 1, 'van', ATTEMPTS.length, '—', (conv.turns || []).length, 'berichten');
        await exportToChronicle(floatingButton, conv);
      }, delay);
    });
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
