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

  const { makeButton, exportToChronicle, buildConversation, transcriptFromTurns, innerTextWithCodeFences, toEpochMs, applyBulkFilter } = window.__chronicleUI;

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
      cache: 'no-store',
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

  async function fetchConversation(uuid, orgArg) {
    const org = orgArg || (await resolveOrgId());
    if (!org) throw new Error('no org');
    const res = await fetch(`/api/organizations/${org}/chat_conversations/${uuid}?tree=True&rendering_mode=messages&render_all_tools=true`, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`claude API ${res.status}`);
    return res.json();
  }

  /**
   * Reconstrueert de actieve tak: van current_leaf_message_uuid terug naar de
   * root via parent_message_uuid. Zonder deze stap bevatten exports óók de
   * alternatieve takken (bewerkingen/regeneraties) plat in het transcript.
   * Zonder leaf-info (oudere API-vormen) valt de functie terug op de volledige
   * lijst in oorspronkelijke volgorde.
   */
  function activeMessages(conv) {
    const messages = conv.chat_messages || [];
    const leaf = conv.current_leaf_message_uuid;
    if (!leaf) return messages;
    const byUuid = new Map(messages.map((m) => [m.uuid, m]));
    if (!byUuid.has(leaf)) return messages;
    const branch = [];
    let current = leaf;
    while (current && byUuid.has(current)) {
      const msg = byUuid.get(current);
      branch.unshift(msg);
      current = msg.parent_message_uuid;
    }
    return branch.length ? branch : messages;
  }

  /**
   * Bijlagen per bericht. `msg.files` is de moderne vorm (file_uuid + naam +
   * type); `msg.attachments[].extracted_content` is de tekst die Claude zelf
   * uit het bestand haalde. De service worker probeert eerst de originele bytes
   * via file_uuid; lukt dat niet, dan wordt de tekstextractie als .txt bewaard
   * — met een naam die dat zegt.
   */
  function attachmentsFromMessages(messages, org) {
    const out = [];
    const byName = new Map();
    for (const msg of messages) {
      const extracted = new Map();
      for (const att of msg.attachments || []) {
        if (att && att.file_name && typeof att.extracted_content === 'string' && att.extracted_content.trim()) {
          extracted.set(att.file_name, att.extracted_content);
        }
      }

      for (const f of msg.files || []) {
        if (!f || !f.file_name) continue;
        const known = byName.get(f.file_name);
        if (known) {
          if (!known.text && extracted.get(f.file_name)) known.text = extracted.get(f.file_name);
          continue;
        }
        const ref = window.__chronicleUI.attachmentRef({
          providerFileId: f.file_uuid || f.file_id || null,
          download: 'claude',
          org,
          filename: f.file_name,
          mimeType: f.file_type || window.__chronicleUI.mimeFromFilename(f.file_name),
          size: typeof f.file_size === 'number' ? f.file_size : null,
          text: extracted.get(f.file_name) || null,
        });
        byName.set(f.file_name, ref);
        out.push(ref);
      }

      // Oudere vorm zonder files[]: alleen de tekstextractie is beschikbaar.
      for (const [name, text] of extracted) {
        if (byName.has(name)) continue;
        const ref = window.__chronicleUI.attachmentRef({
          filename: name,
          mimeType: window.__chronicleUI.mimeFromFilename(name),
          text,
        });
        byName.set(name, ref);
        out.push(ref);
      }
    }
    return out;
  }

  function turnsFromApi(conv, org) {
    const turns = [];
    const messages = activeMessages(conv);
    for (const msg of messages) {
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
        extras.push(`[Attached: ${f && f.file_name ? f.file_name : 'file'}]`);
      }
      text = [text || '', ...extras].filter(Boolean).join('\n\n').trim();
      if (!text) continue;
      turns.push({ role: msg.sender === 'assistant' ? 'assistant' : 'user', text });
    }
    return { turns, attachments: attachmentsFromMessages(messages, org) };
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

  async function collectConversation(signalUuid) {
    // Voorkeur: de uuid uit het intercept-signaal (het gesprek dat zojuist
    // een antwoord kreeg), daarna de URL, dan de DOM. Navigeer je binnen
    // de debounce-tijd weg, dan levert het signaal nog steeds het juiste
    // gesprek i.p.v. dat van de nieuwe pagina.
    const uuid = signalUuid || conversationUuidFromUrl() || lastConversationUuidFromDom();
    let turns = null;
    let attachments = [];
    let name = null;
    let occurredAt = null;
    if (uuid) {
      try {
        const org = await resolveOrgId();
        const conv = await fetchConversation(uuid, org);
        const parsed = turnsFromApi(conv, org);
        turns = parsed.turns;
        attachments = parsed.attachments;
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
      occurredAt: toEpochMs(occurredAt),
      attachments,
    });
  }

  /**
   * Wandelt één pagina API-respons om naar {uuid, name}. Claude's webclient
   * heeft de lijstvorm in de loop der tijd veranderd (losse array,
   * `chat_conversations`, `data`, `conversations`, met cursor óf offset), dus
   * we accepteren alle vormen en normaliseren meteen naar wat de bulk nodig
   * heeft.
   */
  function pageToList(body) {
    const raw = Array.isArray(body)
      ? body
      : (body && (body.chat_conversations || body.data || body.conversations)) || [];
    const list = [];
    for (const conv of raw) {
      const uuid = conv && (conv.uuid || conv.id);
      if (!uuid) continue;
      const name = (conv.name || conv.title || '').trim();
      list.push({ uuid, name });
    }
    return list;
  }

  async function fetchConversationPage(url) {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  /** Wandelt cursor- of offset-paginering af tot de lijst leeg blijft. */
  async function collectFromEndpoint(base) {
    const sep = base.includes('?') ? '&' : '?';
    const out = [];
    const seen = new Set();
    let cursor = null;
    let offset = 0;
    for (let page = 0; page < 60; page++) {
      const url = cursor
        ? `${base}${sep}cursor=${encodeURIComponent(cursor)}`
        : offset
          ? `${base}${sep}offset=${offset}`
          : base;
      const body = await fetchConversationPage(url);
      const list = pageToList(body);
      let added = 0;
      for (const conv of list) {
        if (seen.has(conv.uuid)) continue;
        seen.add(conv.uuid);
        out.push(conv);
        added += 1;
      }
      if (!list.length || !added) break;
      const nextCursor = !Array.isArray(body) && typeof body.cursor === 'string' ? body.cursor : null;
      if (nextCursor) {
        cursor = nextCursor;
        continue;
      }
      if (list.length < 100) break;
      offset += list.length;
    }
    return out;
  }

  /**
   * Laatste redmiddel: de gesprekken die in de zijbalk staan. De lijst is dan
   * alleen wat er gepagineerd geladen is (niet alles), maar "een paar" is
   * beter dan "geen" — en de melding zegt het eerlijk.
   */
  function conversationsFromSidebar() {
    const out = [];
    const seen = new Set();
    for (const link of document.querySelectorAll('a[href*="/chat/"]')) {
      const match = (link.getAttribute('href') || '').match(/\/chat\/([0-9a-f-]{36})/i);
      if (!match || seen.has(match[1])) continue;
      seen.add(match[1]);
      const name = (link.getAttribute('aria-label') || link.innerText || '').trim().split('\n')[0];
      out.push({ uuid: match[1], name });
    }
    return out;
  }

  async function collectAllConversations() {
    const org = await resolveOrgId();
    if (!org) {
      console.info('[Chronicle] claude bulk: geen org-id gevonden (localStorage én /api/organizations)');
      return { list: [], source: null, reason: 'geen org-id gevonden (localStorage + /api/organizations)' };
    }
    // De webclient gebruikt niet in elke versie hetzelfde pad.
    const endpoints = [
      `/api/organizations/${org}/chat_conversations_v2?limit=100`,
      `/api/organizations/${org}/chat_conversations?limit=100`,
    ];
    for (const base of endpoints) {
      try {
        const list = await collectFromEndpoint(base);
        console.info('[Chronicle] claude bulk: lijst via', base.split('?')[0], '—', list.length, 'gesprekken');
        if (list.length) return { list, source: 'api' };
      } catch (err) {
        console.info('[Chronicle] claude bulk:', base.split('?')[0], 'mislukt:', String(err && err.message ? err.message : err));
      }
    }
    const fromDom = conversationsFromSidebar();
    console.info('[Chronicle] claude bulk: DOM-zijbalk gaf', fromDom.length, 'gesprekken');
    return { list: fromDom, source: fromDom.length ? 'sidebar' : null, reason: fromDom.length ? null : 'lijst-API faalde en de zijbalk gaf geen links' };
  }

  async function collectBulkConversations(filter, onProgress, onCollected) {
    const { list: all, source, reason } = await collectAllConversations();
    // Welke filters zin hebben hangt van de bron af: de DOM-zijbalk heeft geen
    // datums of archiefvlag, de API hopelijk wel.
    const list = applyBulkFilter(all, filter, {
      hasDates: source === 'api',
      hasArchive: source === 'api',
    });
    if (list.length !== all.length) {
      console.info('[Chronicle] claude bulk: filter', all.length, '→', list.length, 'gesprekken');
    }
    const org = await resolveOrgId();
    const out = [];
    let i = 0;
    let failed = 0;
    // In batches van 3 met 200ms pauze — het patroon van
    // agoramachina/claude-exporter: klein genoeg om de API niet te
    // overbelasten (429's), snel genoeg om niet eeuwig te duren.
    const BATCH = 3;
    let nextLog = 25;
    for (let b = 0; b < list.length; b += BATCH) {
      const batch = list.slice(b, b + BATCH);
      const results = await Promise.all(batch.map(async (conv) => {
        try {
          const full = await fetchConversation(conv.uuid, org);
          const parsed = turnsFromApi(full, org);
          const turns = parsed.turns;
          if (!turns.length) return null;
          return buildConversation({
            content: transcriptFromTurns(turns),
            turns,
            title: typeof conv.name === 'string' && conv.name.trim() ? conv.name.trim() : undefined,
            url: `https://claude.ai/chat/${conv.uuid}`,
            sourceProvider: 'claude',
            occurredAt: toEpochMs(conv.updated_at || conv.created_at),
            attachments: parsed.attachments,
          });
        } catch (err) {
          // Eén onbereikbaar gesprek mag de bulk niet breken, maar stil
          // verdwijnen is erger: de eerste paar fouten gaan naar de console,
          // anders zie je alleen "geen gesprekken gevonden" zonder oorzaak.
          failed += 1;
          if (failed <= 3) {
            console.info(
              '[Chronicle] claude bulk: gesprek mislukt',
              conv.uuid,
              String(err && err.message ? err.message : err)
            );
          }
          return null;
        }
      }));
      for (const conv of results) {
        i++;
        if (conv) {
          out.push(conv);
          // Meteen doorleveren: bij honderden gesprekken duurt ophalen minuten
          // en tot het eind gebeurde er in Chronicle niets zichtbaars.
          if (onCollected) await onCollected(conv);
        }
        onProgress && onProgress(i, list.length, conv ? (conv.title || '') : '—');
      }
      if (i >= nextLog) {
        console.info('[Chronicle] claude bulk: opgehaald', i, '/', list.length);
        nextLog = i + 25;
      }
      if (b + BATCH < list.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return { conversations: out, failed, total: list.length, source, reason: reason || null };
  }

  // Net als bij Gemini in 0.6.5: lever tijdens het ophalen. Claude heeft geen
  // DOM-navigatie nodig (de API geeft alles), maar bij honderden gesprekken
  // duurt het ophalen minuten en werd er tot het einde niets geleverd — de knop
  // liep wel door, Chronicle bleef leeg.
  const BULK_BATCH = 5;

  let bulkBusy = false;

  async function runBulk(filter) {
    if (bulkBusy) return;
    bulkBusy = true;
    const ui = window.__chronicleUI;
    const batch = [];
    const totals = { total: 0, created: 0, updated: 0, duplicates: 0, failed: 0, queued: 0, gaps: 0 };

    const addTotals = (report) => {
      for (const key of Object.keys(totals)) totals[key] += Number(report[key]) || 0;
    };

    const flush = async () => {
      if (!batch.length) return;
      const chunk = batch.splice(0, batch.length);
      const report = await ui.deliverMany(chunk, (sum, _size, shipped) => {
        bulkButton.textContent = `⇊ leveren ${shipped}/${chunk.length} • nieuw ${sum.created} • bijgewerkt ${sum.updated} • bekend ${sum.duplicates}`;
      });
      addTotals(report);
      console.info('[Chronicle] claude bulk: geleverd', chunk.length, 'gesprekken', totals);
    };

    try {
      bulkButton.textContent = '⇊ lijst ophalen…';
      const { conversations, failed, total, source, reason } = await collectBulkConversations(
        filter,
        (i, count, name) => {
          bulkButton.textContent = `⇊ ophalen ${i}/${count}${name && name !== '—' ? ' • ' + name.slice(0, 30) : ''}`;
        },
        async (conv) => {
          batch.push(conv);
          if (batch.length >= BULK_BATCH) await flush();
        }
      );
      if (!conversations.length) {
        // Onderscheid maken tussen "lijst onvindbaar" en "lijst gevonden maar
        // niets leesbaar": dat scheelt de volgende keer zoeken in het donker.
        if (!total) {
          bulkButton.textContent = '✗ geen gesprekken gevonden — zie console';
          bulkButton.title = reason || 'Open de linkerzijbalk en probeer opnieuw.';
        } else {
          bulkButton.textContent = `✗ ${total} gevonden, 0 leesbaar — zie console`;
          bulkButton.title = 'De lijst werkte, maar elk gesprek ophalen mislukte (API-fout of gewijzigde route).';
        }
        setTimeout(() => {
          bulkButton.textContent = '⇊ Alles naar Chronicle';
          bulkButton.title = '';
        }, 8000);
        return;
      }
      await flush();
      console.info('[Chronicle] claude bulk:', conversations.length, 'van', total, 'gesprekken via', source);
      bulkButton.textContent = `⇊ klaar • nieuw ${totals.created} • bijgewerkt ${totals.updated} • bekend ${totals.duplicates}`;
      if (totals.failed) bulkButton.textContent += ` • ${totals.failed} mislukt`;
      if (totals.gaps) bulkButton.textContent += ` • ${totals.gaps} bestand(en) niet`;
      if (failed) bulkButton.textContent += ` • ${failed} overgeslagen`;
      bulkButton.title = failed
        ? `${failed} gesprek(ken) konden niet worden opgehaald — zie console`
        : '';
      setTimeout(() => {
        bulkButton.textContent = '⇊ Alles naar Chronicle';
        bulkButton.title = '';
      }, 10000);
    } catch (err) {
      // Wat al geleverd is, blijft geleverd: alleen de rest is misgegaan.
      bulkButton.textContent = '✗ ' + String(err && err.message ? err.message : err).slice(0, 60);
      bulkButton.title = `al geleverd: nieuw ${totals.created} • bijgewerkt ${totals.updated} • bekend ${totals.duplicates}`;
      setTimeout(() => {
        bulkButton.textContent = '⇊ Alles naar Chronicle';
        bulkButton.title = '';
      }, 8000);
    } finally {
      bulkBusy = false;
    }
  }


  // Filterformulier (gedeeld met ChatGPT/Gemini, staat in normalize.js).
  const filterPanel = window.__chronicleUI.makeBulkFilterPanel({ onStart: runBulk });

  const bulkButton = window.__chronicleUI.makeBulkButton(() => filterPanel.toggle());

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
  // Het MAIN-world interceptorscript seint 'conversation-updated' als een
  // antwoordstream is afgerond. Het gesprek is op dat moment gegroeid; hier
  // wordt het (debounced) opgehaald via de bewuste API-route en afgeleverd.
  // Herlevering is veilig: de listener dedupt, dus een signaal te veel is
  // hooguit een duplicate, nooit een dubbele rij.
  window.addEventListener('message', (event) => {
    // Geen event.source-check: in de isolated world is event.source het
    // MAIN-world window — een ander object dan de content-script-window,
    // dus die vergelijking wijst altijd af. De origin- en source-veld-
    // controles samen zijn voldoende streng.
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== 'chronicle-intercept' || data.type !== 'conversation-updated') return;
    if (data.provider !== 'claude') return;
    // Debounce: een antwoord arriveert in veel kleine afgeronde reads; pas
    // als de signalen 1,5s stil zijn, is het gesprek stabiel genoeg.
    console.info('[Chronicle] auto-capture signaal', JSON.stringify(data));
    // Het signaal valt bij de response-headers: het antwoord streamt op dat
    // moment nog. Herhaalde levering met oplopende tussenpozen lost dat op —
    // de listener dedupt, dus tussentijdse (half-gegroeide) versies zijn
    // hooguit een update die de volgende levering weer overtreft; de laatste
    // poging heeft gegarandeerd het complete antwoord.
    const ATTEMPTS = [2000, 4000, 6000]; // na 2s, 6s, 12s
    ATTEMPTS.forEach((delay, i) => {
      setTimeout(async () => {
        const conv = await collectConversation(data.uuid);
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
