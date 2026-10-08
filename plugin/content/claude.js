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
    const res = await fetch(`/api/organizations/${org}/chat_conversations/${uuid}?tree=True&rendering_mode=messages&render_all_tools=true`, {
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
        // Text-blokken zijn de kern; thinking-blokken komen er als gemarkeerde
        // sectie bij (patroon van agoramachina/claude-exporter) — Foundation
        // krijgt ze, afwijzen/filteren is niet aan de afzender.
        const parts = [];
        for (const block of msg.content) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
          } else if (block && block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
            parts.push('### Thinking\n\n````\n' + block.thinking.trim() + '\n````\n');
          }
        }
        text = parts.join('\n\n');
      } else if (typeof msg.text === 'string') {
        text = msg.text;
      }
      // Attachments: naam + geëxtraheerde inhoud erbij, zelfde vorm als
      // Chronicle's sourceParsers ([Attached: ...]), zodat plugin- en
      // bestandsimport hetzelfde archiefbeeld opleveren.
      const extras = [];
      for (const att of msg.attachments || []) {
        if (att && att.extracted_content) {
          extras.push(`[Attached: ${att.file_name || 'attachment'}]\n${att.extracted_content}`);
        }
      }
      for (const f of msg.files || []) {
        extras.push(`[Attached: ${f && f.file_name ? f.file_name : 'file'} — content not included in this export]`);
      }
      text = [text || '', ...extras].filter(Boolean).join('\n\n').trim();
      if (!text) continue;
      turns.push({ role: msg.sender === 'assistant' ? 'assistant' : 'user', text });
    }
    return turns;
  }

  /**
   * Zet een DOM-node om naar tekst waarbij codeblokken als echte markdown-
   * fences gemarkeerd worden (```), zodat de archive-viewer (react-markdown)
   * ze als codeblok rendert i.p.v. platgeslagen tekst. Inline-code blijft
   * inline; alleen echte blokken (pre/code) krijgen fences.
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
          innerTextWithCodeFences(container)
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
      const text = innerTextWithCodeFences(block).trim();
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

  async function collectAllConversations() {
    const org = await resolveOrgId();
    if (!org) return [];
    const conversations = [];
    let cursor = null;
    // De gesprekkenlijst is gepagineerd; wandel alle pagina's af.
    do {
      const url = `/api/organizations/${org}/chat_conversations?limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok) throw new Error(`claude conversations API ${res.status}`);
      const body = await res.json();
      for (const conv of body.chat_conversations || []) conversations.push(conv);
      cursor = body.cursor || null;
    } while (cursor);
    return conversations;
  }

  async function collectBulkConversations(onProgress) {
    const list = await collectAllConversations();
    const out = [];
    let i = 0;
    // In batches van 3 met 200ms pauze — het patroon van
    // agoramachina/claude-exporter: klein genoeg om de API niet te
    // overbelasten (429's), snel genoeg om niet eeuwig te duren.
    const BATCH = 3;
    for (let b = 0; b < list.length; b += BATCH) {
      const batch = list.slice(b, b + BATCH);
      const results = await Promise.all(batch.map(async (conv) => {
        try {
          const full = await fetchConversation(conv.uuid);
          const turns = turnsFromApi(full);
          if (!turns.length) return null;
          return buildConversation({
            content: transcriptFromTurns(turns),
            turns,
            title: typeof conv.name === 'string' && conv.name.trim() ? conv.name.trim() : undefined,
            url: `https://claude.ai/chat/${conv.uuid}`,
            sourceProvider: 'claude',
            occurredAt: conv.updated_at || conv.created_at || null,
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

  // De toolbar-knop van de extensie triggert dezelfde export.
  window.__chronicleUI.bindToolbarClick(() => {
    window.__chronicleUI.setButtonState(floatingButton, 'busy');
    runExport(floatingButton).catch((err) => {
      floatingButton.textContent = '✗ ' + String(err && err.message ? err.message : err).slice(0, 60);
      setTimeout(() => window.__chronicleUI.setButtonState(floatingButton, 'idle'), 6000);
    });
  });
})();
