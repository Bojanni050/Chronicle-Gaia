/**
 * chat.mistral.ai (Le Chat) provider-script.
 *
 * Le Chat praat via tRPC (`/api/trpc/<router>.<procedure>`) en verzendt een
 * antwoord via `POST /api/chat` (+ `/api/chat/resume` bij een hervatte stream).
 * Lezen gaat via twee tRPC-queries:
 *   - `chat.byId`    met { id }     → gesprek (o.a. de titel)
 *   - `message.all`  met { chatId } → { items: [...] } met de berichten
 * Elk bericht heeft `role` (user/assistant/system/tool) en `contentChunks`
 * (soms een `content`-string). Dit script haalt het huidige gesprek op via die
 * route, met een DOM-fallback erachter.
 *
 * Alleen het huidige gesprek + auto-capture (geen bulk, per afspraak).
 * Idempotent: Chrome mag het script opnieuw injecteren; de UI-helper vervangt
 * de knop dan i.p.v. te verdubbelen.
 */
(() => {

  const { makeButton, exportToChronicle, buildConversation, transcriptFromTurns, innerTextWithCodeFences, toEpochMs } = window.__chronicleUI;

  function conversationIdFromUrl() {
    const match = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
    return match ? match[1] : null;
  }

  /**
   * tRPC batching-GET. Antwoord is een batch-array:
   *   [{ result: { data: { json: X } } }]  of  [{ error: {...} }]
   */
  async function trpcQuery(procedure, json) {
    const input = encodeURIComponent(JSON.stringify({ '0': { json } }));
    const res = await fetch(`/api/trpc/${procedure}?batch=1&input=${input}`, {
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        'x-trpc-source': 'nextjs-react',
      },
      credentials: 'include',
      cache: 'no-store',
    });
    const body = await res.json().catch(() => null);
    const entry = Array.isArray(body) ? body[0] : body;
    if (!res.ok || (entry && entry.error)) {
      const message = entry?.error?.json?.message || entry?.error?.message || `HTTP ${res.status}`;
      throw new Error(`mistral ${procedure}: ${String(message).slice(0, 80)}`);
    }
    const data = entry?.result?.data;
    return data && typeof data === 'object' && 'json' in data ? data.json : data;
  }

  /** Verzamelt de bericht-items uit de verschillende mogelijke vormen. */
  function messageItems(data) {
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data.items)) return data.items;
    if (Array.isArray(data.pages)) return data.pages.flatMap((p) => (p && p.items) || []);
    if (Array.isArray(data)) return data;
    return [];
  }

  /** Tekst uit contentChunks: alleen `text`-chunks; tools/afbeeldingen slaan we over. */
  function chunkText(chunks) {
    if (!Array.isArray(chunks)) return '';
    const parts = [];
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type !== 'text') continue;
      const text = chunk.content ?? chunk.text ?? '';
      if (typeof text === 'string' && text.trim()) parts.push(text);
    }
    return parts.join('\n').trim();
  }

  function messageText(item) {
    const fromChunks = chunkText(item?.contentChunks);
    if (fromChunks) return fromChunks;
    return typeof item?.content === 'string' ? item.content.trim() : '';
  }

  /**
   * Bestands- en afbeeldingschunks. De tRPC-vorm verschilt per versie, dus dit
   * is bewust defensief: alleen objecten met een http(s)-download-URL tellen.
   * Onbekende vormen leveren geen bijlage op (en dus ook geen verzonnen gap).
   */
  function attachmentsFromItems(items) {
    const out = [];
    const seen = new Set();
    const push = (file) => {
      if (!file || typeof file !== 'object') return;
      const url = file.downloadUrl || file.download_url || file.url || file.fileUrl || file.src;
      if (typeof url !== 'string' || !/^https?:/i.test(url)) return;
      if (seen.has(url)) return;
      seen.add(url);
      out.push(window.__chronicleUI.attachmentRef({
        url,
        download: 'direct',
        filename: file.fileName || file.filename || file.name || null,
        mimeType: file.mimeType || file.mime_type || null,
        size: typeof file.size === 'number' ? file.size : null,
      }));
    };
    for (const item of items) {
      for (const chunk of item?.contentChunks || []) {
        if (!chunk || typeof chunk !== 'object' || chunk.type === 'text') continue;
        push(chunk.file);
        push(chunk.image);
        push(chunk.document);
        if (chunk.content && typeof chunk.content === 'object') push(chunk.content);
      }
    }
    return out;
  }

  function turnsFromApi(items) {
    const turns = [];
    for (const item of items) {
      const role = item?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      // Een nog streamend antwoord slaan we over; de laatste levering heeft alles.
      if (role === 'assistant' && item?.status === 'generating') continue;
      const text = messageText(item);
      if (!text) continue;
      turns.push({ role, text });
    }
    return turns;
  }

  /**
   * DOM-fallback (best-effort). Le Chat rendert berichten in de chatlijst; we
   * herkennen de rol aan data-attributen en lezen de bodytekst. De API-route is
   * primair — dit is alleen vangnet.
   */
  function turnsFromDom() {
    const turns = [];
    const nodes = document.querySelectorAll('[data-message-role], [data-message-author-role]');
    for (const node of nodes) {
      const role = (node.getAttribute('data-message-role') || node.getAttribute('data-message-author-role') || '').toLowerCase();
      const mapped = /user|human/.test(role) ? 'user' : /assistant|bot|model/.test(role) ? 'assistant' : null;
      if (!mapped) continue;
      const text = innerTextWithCodeFences(node).trim();
      if (!text) continue;
      turns.push({ role: mapped, text });
    }
    return turns;
  }

  function titleFrom(docTitle) {
    const fromDoc = (document.title || '').replace(/\s*[-–|]\s*(Vibe|Le Chat|Mistral).*$/i, '').trim();
    return docTitle || fromDoc || null;
  }

  async function collectConversation() {
    const id = conversationIdFromUrl();
    let turns = null;
    let attachments = [];
    let title = null;
    let occurredAt = null;
    if (id) {
      try {
        const items = messageItems(await trpcQuery('message.all', { chatId: id }));
        turns = turnsFromApi(items);
        attachments = attachmentsFromItems(items);
        const last = items[items.length - 1];
        occurredAt = last && last.createdAt ? last.createdAt : null;
      } catch (err) {
        console.info('[Chronicle] mistral API-read mislukt:', String(err && err.message ? err.message : err), '— DOM-fallback');
        turns = null;
      }
      if (!title) {
        try {
          const chat = await trpcQuery('chat.byId', { id });
          title = (chat && (chat.title || (chat.chat && chat.chat.title))) || null;
        } catch {
          // titel is optioneel; de DOM-documenttitel is de terugval
        }
      }
    }
    if (!turns || !turns.length) {
      turns = turnsFromDom();
      attachments = [];
    }
    if (!turns.length) {
      return { error: 'geen berichten gevonden op deze pagina' };
    }
    return buildConversation({
      content: transcriptFromTurns(turns),
      turns,
      title: titleFrom(title),
      url: id ? `https://chat.mistral.ai/chat/${id}` : location.href,
      sourceProvider: 'mistral',
      occurredAt: toEpochMs(occurredAt),
      attachments,
    });
  }

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

  // ── Automatische capture ────────────────────────────────────────────────
  // Het interceptorscript seint na een POST /api/chat (of /api/chat/resume).
  // Daarna wordt (herhaald, want het antwoord streamt nog) het gesprek via de
  // API opgehaald en geleverd. Herlevering is veilig: de listener dedupt op
  // url/contentHash, dus de laatste levering wint.
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'chronicle-intercept' || data.type !== 'conversation-updated') return;
    if (data.provider !== 'mistral') return;
    console.info('[Chronicle] auto-capture signaal', JSON.stringify(data));
    const ATTEMPTS = [2500, 5000, 8000];
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

  console.info('[Chronicle] mistral provider actief');
})();
