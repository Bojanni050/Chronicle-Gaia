# Verbeterplan — capture-robuustheid en archief

Vergelijkingsstudie tegen vergelijkbare open-sourceprojecten (januari 2026):
[chatsearch](https://github.com/AaronBergman/chatsearch),
[interlatch](https://github.com/Chatixia-AI/interlatch),
[ChatVault](https://github.com/martenzi/ChatVault),
[ThreadShelf](https://github.com/ChrystianSchutz/ThreadShelf),
[mychatarchive](https://github.com/1ch1n/mychatarchive) en
[resonant-archive](https://github.com/nekyialabs/resonant-archive).
Conclusie vooraf: Chronicle's capture-aanpak (fetch-interceptie + knoppen +
dedup) behoort tot de meest geavanceerde; de leerpunten liggen in robuustheid
van de interceptie en in schaalbaarheid/autonomie van het archief.

## Spoor 1 — Capture-robuustheid

Huidige situatie: `plugin/content/intercept.js` seint op hardgecodeerde
endpoints per provider (`…/completion`, `/backend-api/conversation` — de
laatste is al één keer verplaatst naar `/f/conversation`). Faalt de match,
dan valt alles terug op de handmatige knoppen.

### 1.1 Periodiek vangnet-sync (interlatch-model)

Elke ~5 minuten per open tab, plus enkele seconden nadat een chat wordt
verlaten: haal de bewezen lijst-API op (Claude:
`GET /api/organizations/{org}/chat_conversations` — bestaat al in de
bulk-knop) en vergelijk `updatedAt` met de laatst gearchiveerde versie.
Vangt: endpoint-wijzigingen, chats gegroeid in een ander tab/apparaat, en
streams die de fetch-wrap missen. De listener dedupt al op contentHash,
dus een overbodige levering kost niets (`duplicate`).

### 1.2 Generieke fetch-observatie (chatsearch)

Observeer alle fetch-antwoorden op het tabdomein en classificeer achteraf
op response-shape (velden als `mapping` / `content[]`), i.p.v. een
hardgecodeerde URL-lijst. Een route-wijziging zoals OpenAI's
`/f/conversation` overleeft capture dan gewoon.

### 1.3 E2E-tests tegen gemockte providers

Playwright met gemockte claude.ai/chatgpt.com/gemini-pagina's in CI. Nu
bestaat alleen `plugin/content/normalize.test.ts` op unit-niveau; een
gemockte pagina-test met een "nieuw antwoord arriveert"-scenario had de
`/f/conversation`-breuk in CI laten zien in plaats van in productie.
Zie ook chatsearch (`npm run e2e` tegen mock claude.ai / chatgpt.com) en
ChatSweep (`npm run e2e` tegen gemockte sites).

### 1.4 Gezondheidsstatus in de UI

Ziet de interceptor in een actieve tab X dagen geen signalen meer
(vermoedelijke endpoint-wijziging), toon dat op de plugin-badge of het
MCP-statuspaneel. Een stille breuk merk je nu pas als data mist.

## Spoor 2 — Archief

Huidige situatie:

- `SELECT * FROM chats` laadt het hele archief in het renderer-geheugen
  (`electron-main.js`, `load-chats`).
- Zoeken is client-side `content.toLowerCase().includes(query)` per chat
  per keystroke, in een `useMemo` die ook telkens hersorteert
  (`App.tsx`, `filteredChats`).
- Semantisch zoeken rekent cosine-similarity in JS over élke chat
  (`components/AdvancedSearch.tsx`), met embeddings per API-call naar
  Gemini.
- Eén embedding per volledige chat (`chats.embedding`).

### 2.1 Full-text index in Postgres

Voeg een `tsvector`-kolom + GIN-index toe over titel+samenvatting+content
en vervang de client-side substring door `websearch_to_tsquery`.
Typfout-tolerantie via `pg_trgm` + `similarity()`. ChatVault scheidt dit
eerlijk: keyword (`find`, FTS5) naast semantisch (`search`).

### 2.2 Chunk-level embeddings

Eén vector per volledige gesprek verliest detailniveaus. Sla per chat een
tabel `chunks (chatId, seq, text, embedding)` bij; zoeken levert dan het
fragment plus de chat. Grootste kwaliteitswinning voor semantisch zoeken
(ThreadShelf en resonant-archive doen dit ook).

### 2.3 `SELECT *` aanpakken

- Minimaal: selecteer alleen de kolommen die de lijstweergave nodig heeft
  (id, titel, samenvatting, tags, bron, datums) en laad `content` +
  `embedding` lazy per geselecteerde chat.
- Structureler: paginering/lazy-loading met een `count`-query voorboven
  en filters in SQL met `LIMIT/OFFSET` (pakt 2.1 mee).

### 2.4 Semantische zoekscore in SQL

`pgvector` (extension + `vector`-kolom + IVFFlat/HNSW-index) laat
`ORDER BY embedding <=> $1` het werk doen i.p.v. N cosine-berekeningen in
de renderer. De huidige JS-route blijft als graceful fallback, zodat
"pgvector niet vereist" (README) blijft gelden.

### 2.5 Lokale embedding-fallback

mychatarchive en resonant-archive draaien embeddings volledig lokaal
(sentence-transformers / ONNX, nomic-embed-text-v1.5, Apache-2.0). Chronicle
is nu volledig afhankelijk van een Gemini-key en netwerk voor
samenvatting, tags én embeddings. `@xenova/transformers` is een drop-in
voor Electron en maakt het archief autonoom.

### 2.6 Sorteer buiten de memo

`createdAt DESC` heeft al een DB-index; sorteer één keer bij het laden,
niet per keystroke in de filter-memo.

### 2.7 Schaalttest

E2E-test die 5–10k chats seedt en de zoek- en lijstflows meet
(chatsearch heeft een 10k-chat benchmark). Maakt de groeigrenzen van
2.1–2.3 meetbaar.

## Prioritering

1. 2.2 chunk-embeddings + 2.1 FTS-index — grootste functionele winst
2. 2.3 `SELECT *` — belangrijkste performance-fix
3. 1.1 vangnet-sync + 1.2 generieke fetch-observatie — robuustheid
4. 2.4 pgvector + 2.5 lokale embeddings — autonomie en schaal
5. 1.3 e2e-tests + 1.4 gezondheidsstatus + 2.7 schaalttest
