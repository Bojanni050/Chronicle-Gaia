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

  /**
   * De ChatGPT-API gate't /backend-api op een Bearer-token uit /api/auth/session;
   * cookies alleen geven 401. Zonder token vallen we terug op cookie-auth.
   */
  async function authHeaders() {
    try {
      const res = await fetch('/api/auth/session', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!res.ok) return {};
      const session = await res.json();
      const token = session && session.accessToken;
      if (!token) return {};
      return {
        Authorization: `Bearer ${token}`,
        'X-Authorization': `Bearer ${token}`,
      };
    } catch {
      return {};
    }
  }

  /** De detailrespons kan direct de mapping zijn of onder `conversation` zitten. */
  function mappingRoot(body) {
    if (!body || typeof body !== 'object') return null;
    if (body.mapping) return body;
    if (body.conversation && body.conversation.mapping) return body.conversation;
    return null;
  }

  async function fetchConversation(id) {
    // De detail-route is in de loop der tijd verschoven (enkelvoud → meervoud);
    // probeer de bekende vormen na elkaar en neem de eerste met een mapping-tree.
    const paths = [
      `/backend-api/conversation/${id}`,
      `/backend-api/conversations/${id}`,
    ];
    const auth = await authHeaders();
    let lastError = null;
    for (const path of paths) {
      try {
        const res = await fetch(path, {
          headers: { Accept: 'application/json', ...auth },
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!res.ok) {
          lastError = new Error(`chatgpt API ${res.status} (${path})`);
          continue;
        }
        const root = mappingRoot(await res.json());
        if (root) return root;
        lastError = new Error(`chatgpt API onverwachte vorm (${path})`);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('chatgpt API onbereikbaar');
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
      const text = parts.filter((p) => typeof p === 'string' && p.trim()).join('\n').trim();
      if (text) return text;
    }
    // Alleen tekstinhoud. `code` is de tool-call van de image generator: de ruwe
    // JSON-argumenten ("size", "prompt") horen niet als assistenttekst in het
    // transcript, en `execution_output` is gereedschapsuitvoer.
    const type = msg?.content?.content_type;
    if (!type || type === 'text' || type === 'multimodal_text') {
      if (typeof msg?.content?.text === 'string') return msg.content.text.trim();
    }
    return '';
  }

  /**
   * Bestands-id uit een CDN-url. ChatGPT serveert afbeeldingen als
   * `/backend-api/estuary/content?id=file_…` of als
   * `https://files.oaiusercontent.com/file-…`; beide bevatten het id. Nodig om
   * een gegenereerde foto aan de API-verwijzing te koppelen.
   */
  function fileIdFromUrl(url) {
    if (typeof url !== 'string') return null;
    const fromQuery = url.match(/[?&]id=(file[-_][A-Za-z0-9]+)/);
    if (fromQuery) return fromQuery[1];
    const fromPath = url.match(/(file[-_][A-Za-z0-9]{8,})/);
    return fromPath ? fromPath[1] : null;
  }

  /**
   * De afbeeldingen die de pagina toont, met CDN-url en id. Gegenereerde foto's
   * (DALL·E/GPT-image) staan in de API als `sediment://`-pointer zonder
   * download-url; de `<img>` in het bericht is dan de enige route naar de bytes.
   * `blob:` is pagina-gebonden en niet door de service worker op te halen; die
   * wordt hier wél gemeld (`blob: true`) en later in de pagina zelf uitgelezen.
   *
   * Gezocht wordt in twee rondes: binnen een berichtcontainer (waar geüploade
   * afbeeldingen staan) én in `main` voor `blob:`-afbeeldingen. Die tweede ronde
   * is nodig omdat een gegenereerde foto in het `tool`-bericht hangt en dat blok
   * geen `data-message-author-role` heeft — met alleen de eerste ronde bleef de
   * verwijzing zonder url achter (gemeten: gap "geen download-url").
   */
  function domImageRefs() {
    const out = [];
    const seen = new Set();
    const collect = (img) => {
      const src = img.currentSrc || img.src;
      if (!src || seen.has(src)) return;
      const blob = /^blob:/i.test(src);
      if (!blob && !/^https?:/i.test(src)) return;
      if (/avatar|profile|emoji|icon|logo/i.test(src)) return;
      if (img.naturalWidth && img.naturalWidth < 64) return;
      seen.add(src);
      const alt = String(img.getAttribute('alt') || '').trim();
      out.push({
        src,
        blob,
        fileId: blob ? null : fileIdFromUrl(src),
        filename: alt && alt.length < 60 ? alt : null,
      });
    };
    for (const img of document.querySelectorAll('[data-message-author-role] img[src]')) collect(img);
    for (const img of document.querySelectorAll('main img[src]')) {
      if (!/^blob:/i.test(img.currentSrc || img.src)) continue;
      collect(img);
    }
    return out;
  }

  /** Leest een `blob:`-afbeelding als base64 (alleen hier mogelijk, niet in de SW). */
  async function blobBytes(src) {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`blob ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // String.fromCharCode(...bytes) op 2,4 MB blaast de stack op: per blok.
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

  /**
   * Vult de bytes aan voor verwijzingen zonder download-url (de `sediment://`
   * pointers van gegenereerde foto's). De pagina toont die foto als blob; de
   * koppeling gaat op bytegrootte (`size_bytes` uit de API = werkelijke
   * blobgrootte, gemeten: 2405280), niet op `alt` — die is generiek
   * ("Gegenereerde afbeelding 1").
   */
  async function inlineBlobImages(attachments) {
    const pending = attachments.filter((ref) => ref && !ref.url && !ref.dataBase64);
    const blobs = domImageRefs().filter((image) => image.blob);
    if (!pending.length) return attachments;
    if (!blobs.length) {
      console.info('[Chronicle] geen blob-afbeelding in de pagina voor', pending.length, 'verwijzing(en)');
      return attachments;
    }
    const used = new Set();
    for (const ref of pending) {
      let match = null;
      for (const image of blobs) {
        if (used.has(image.src)) continue;
        if (!image.bytes) {
          try {
            image.bytes = await blobBytes(image.src);
          } catch (err) {
            image.bytes = null;
            console.info('[Chronicle] blob onleesbaar:', String(err && err.message ? err.message : err));
          }
        }
        if (!image.bytes) continue;
        if (typeof ref.size === 'number' && image.bytes.size === ref.size) {
          match = image;
          break;
        }
      }
      if (!match) continue;
      used.add(match.src);
      ref.dataBase64 = match.bytes.base64;
      ref.mimeType = ref.mimeType || match.bytes.mimeType;
      ref.size = match.bytes.size;
    }
    // Diagnose: welke verwijzing bleef zonder bytes achter, en waarom.
    const unmatched = pending.filter((ref) => !ref.dataBase64);
    if (unmatched.length) {
      console.info(
        '[Chronicle] geen passende blob voor',
        unmatched.map((ref) => `${ref.filename || ref.providerFileId} (${ref.size ?? '?'} bytes)`).join(', '),
        '— paginablobs:',
        blobs.map((image) => (image.bytes ? image.bytes.size : '?')).join(', ')
      );
    }
    return attachments;
  }

  /**
   * Koppelt de API-verwijzingen aan wat de pagina toont: een verwijzing zonder
   * url krijgt de CDN-url van de afbeelding met hetzelfde id, en een afbeelding
   * die geen enkele verwijzing heeft (gegenereerd, niet in `metadata`) wordt
   * toegevoegd. Zonder dit kwam een gegenereerde foto nooit mee: de pointer is
   * `sediment://` en het download-endpoint kent die opslag niet.
   */
  function withDomImages(attachments, images) {
    if (!images.length) return attachments;
    const byId = new Map();
    for (const image of images) if (image.fileId) byId.set(image.fileId, image);

    const out = attachments.map((ref) => {
      if (ref.url || !ref.providerFileId) return ref;
      const match = byId.get(ref.providerFileId);
      if (!match) return ref;
      const next = { ...ref, url: match.src };
      if (!next.filename && match.filename) next.filename = match.filename;
      return next;
    });

    const claimed = new Set(out.map((ref) => ref.providerFileId).filter(Boolean));
    const usedUrls = new Set(out.map((ref) => ref.url).filter(Boolean));
    for (const image of images) {
      if (!image.fileId || claimed.has(image.fileId) || usedUrls.has(image.src)) continue;
      claimed.add(image.fileId);
      usedUrls.add(image.src);
      out.push(window.__chronicleUI.attachmentRef({
        providerFileId: image.fileId,
        url: image.src,
        download: 'chatgpt',
        filename: image.filename,
        mimeType: 'image/png',
      }));
    }
    return out;
  }

  /**
   * Bijlagen uit de API-response. Twee bronnen: `metadata.attachments` (de
   * geüploade bestanden, met naam/type/grootte) en pointers in de content-parts
   * (`file-service://` voor wat in een bericht is gezet, `sediment://` voor
   * gegenereerde afbeeldingen). De bytes komen later via
   * `/backend-api/files/{id}/download` of de CDN-url; hier reist alleen de
   * verwijzing mee.
   */
  function attachmentsFromApi(messages) {
    const out = [];
    const seen = new Set();
    const add = (ref) => {
      const key = ref.providerFileId ? 'id:' + ref.providerFileId : ref.url;
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(ref);
    };
    for (const msg of messages) {
      for (const att of (msg && msg.metadata && msg.metadata.attachments) || []) {
        if (!att) continue;
        const fileId = att.id || att.file_id;
        if (!fileId) continue;
        add(window.__chronicleUI.attachmentRef({
          providerFileId: fileId,
          download: 'chatgpt',
          filename: att.name || att.file_name || null,
          mimeType: att.mime_type || null,
          size: typeof att.size === 'number' ? att.size : null,
        }));
      }
      const parts = (msg && msg.content && msg.content.parts) || [];
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        const pointer = part.asset_pointer || part.asset_pointer_url;
        if (typeof pointer !== 'string') continue;
        // file-service:// = geüpload of in het bericht gezet; sediment:// =
        // gegenereerd (DALL·E/GPT-image). Beide verwijzen naar een file-id; de
        // sediment-variant heeft geen download-endpoint, daar vult de DOM de url.
        const match = pointer.match(/^(?:file-service|sediment):\/\/(.+)$/);
        if (!match) continue;
        const generated = String(match[1]).startsWith('file_');
        // De titel die ChatGPT zelf aan de generatie gaf ("Winterkat") is een
        // betere bestandsnaam dan een id.
        const genTitle = (msg.metadata && msg.metadata.image_gen_title) || null;
        add(window.__chronicleUI.attachmentRef({
          providerFileId: match[1],
          download: 'chatgpt',
          filename: genTitle
            ? String(genTitle).trim()
            : generated
              ? `chatgpt-afbeelding-${match[1].slice(-8)}`
              : null,
          mimeType: part.mime_type || null,
          size: typeof part.size_bytes === 'number' ? part.size_bytes : null,
        }));
      }
    }
    return out;
  }

  function turnsFromApi(root) {
    const turns = [];
    const branch = activeBranchMessages(root);
    for (const msg of branch) {
      const role = msg?.author?.role;
      if (!role || role === 'system' || role === 'tool') continue;
      const text = messageText(msg);
      if (!text) continue;
      turns.push({ role: role === 'user' ? 'user' : 'assistant', text });
    }
    return { turns, attachments: attachmentsFromApi(branch) };
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

  /**
   * DOM-vangnet voor afbeeldingen als de API-read faalt: http(s)-URLs gaan als
   * verwijzing mee, `blob:`-afbeeldingen worden hier meteen uitgelezen (de
   * service worker kan er niet bij).
   */
  async function attachmentsFromDom() {
    const out = [];
    for (const image of domImageRefs()) {
      if (!image.blob) {
        out.push(window.__chronicleUI.attachmentRef({
          url: image.src,
          providerFileId: image.fileId,
          download: image.fileId ? 'chatgpt' : 'direct',
          filename: image.filename,
        }));
        continue;
      }
      try {
        const bytes = await blobBytes(image.src);
        out.push(window.__chronicleUI.attachmentRef({
          filename: image.filename || 'chatgpt-afbeelding',
          mimeType: bytes.mimeType,
          size: bytes.size,
          dataBase64: bytes.base64,
        }));
      } catch (err) {
        console.info('[Chronicle] blob onleesbaar:', String(err && err.message ? err.message : err));
      }
    }
    return out;
  }

  async function collectConversation() {
    const id = conversationIdFromUrl();
    let turns = null;
    let attachments = [];
    let title = null;
    let occurredAt = null;
    if (id) {
      try {
        const root = await fetchConversation(id);
        const parsed = turnsFromApi(root);
        turns = parsed.turns;
        // De pagina toont de gegenereerde foto's; de API geeft daar alleen een
        // sediment-pointer voor. Koppel ze hier, ook als de API-read slaagde.
        attachments = withDomImages(parsed.attachments, domImageRefs());
        attachments = await inlineBlobImages(attachments);
        title = typeof root.title === 'string' && root.title.trim() ? root.title.trim() : null;
        occurredAt = root.update_time || root.create_time || null;
      } catch (err) {
        console.info('[Chronicle] chatgpt API-read mislukt:', String(err && err.message ? err.message : err), '— DOM-fallback');
        turns = null; // val door naar de DOM-fallback
      }
    }
    if (!turns || !turns.length) {
      turns = turnsFromDom();
      attachments = await attachmentsFromDom();
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
      attachments,
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
          const parsed = turnsFromApi(root);
          const turns = parsed.turns;
          if (!turns.length) return null;
          return buildConversation({
            content: transcriptFromTurns(turns),
            turns,
            title: typeof conv.title === 'string' && conv.title.trim() ? conv.title.trim() : undefined,
            url: `https://chatgpt.com/c/${conv.id}`,
            sourceProvider: 'chatgpt',
            occurredAt: conv.update_time || conv.create_time || null,
            attachments: parsed.attachments,
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
