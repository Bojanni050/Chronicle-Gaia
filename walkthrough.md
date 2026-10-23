# Walkthrough — Chronicle-Gaia

## 2026-10-05 (Capture-verbinding Chronicle → Foundation, fase 0-1)

- Findings:
  - De handoff ging ervan uit dat de brug naar Foundation nog volledig moest
    worden gebouwd. Bij het doornemen bleek Foundation (`server/routes/ingest.js`,
    `server/ingestPolicy.js`) de gateway al te hebben, én een eigen bulk-importeur
    (`tools/chatgpt_bulk_import/`, `chatgptImportManager.js`, `routes/chatgptImport.js`)
    die ChatGPT/Gemini via Playwright en Claude via export-zip rechtstreeks naar
    `POST /api/ingest/chat` post. Git toont `6c9fad5` (2026-09-23): die import is
    mee-geëxtraheerd uit het gecombineerde Foundation-Chronicle-prototype en is dus
    erfgoed van vóór de splitsing — capture-logica aan de ontvangende kant, in strijd
    met `Gaia-Documentation/capture-chronicle.md`.
  - Besluit (gebruiker): de Foundation-erfenis mag weg; Chronicle wordt de enige
    capture-path en levert álle chats. Opruimen pas ná bewezen vervanging.
  - Technische constraints: Foundation's CORS/CSRF-guard staat alleen
    localhost/127.0.0.1/chrome-extension toe → een `file://`-renderer krijgt 403.
    De POST moet dus vanuit het Electron main-proces (Bearer-token blijft buiten de
    renderer). `provider_conversation_id` wordt server-side uit `sourceProvider` +
    `url` afgeleid → zonder `url` geen dedup.
  - Chronicle slaat nu geen `url`/`turns`/`occurredAt` op; de renderer-parser kent
    ook de ChatGPT `mapping`-boom niet. De gepullde `electron-main.js` blijkt die
    boom wél al te parsen (`jsonToTranscript`).
  - `main` stond 2 commits achter; gepulld. `.ernv.local` was een typo voor
    `.env.local` (die al in `.gitignore` stond).
- Conclusions:
  - De eigenlijke opdracht (transport) is onafhankelijk van het opruimen en van de
    per-bron-mapping; daarom in fasen. Fase 1 = de verbinding zelf, strict en getest.
  - De payload-builder is bewust streng: hij emit exact de velden die het
    `chat`-entry-point toestaat en laat de afgeleide laag (tags/summary/embedding)
    er per constructie buiten. Zo kan er niets afgeleid naar Gaia lekken.
  - Verrijking (`geminiService`, `process.env.API_KEY`) is vermoedelijk stuk in de
    renderer en hoort — net als het Foundation-token — niet in de renderer thuis;
    apart op te lossen, blokkeert capture niet.
- Actions:
  - `git pull --ff-only` (bc2a9bc → 3dea129).
  - `.ernv.local` → `.env.local`; typo-regel uit `.gitignore` verwijderd.
  - Nieuw `utils/foundationCapture.ts`: pure payload-builder + rol/provider-mapping
    (`buildChatIngestPayload`, `toFoundationRole`, `toSourceProvider`).
  - Nieuw `utils/foundationCapture.test.ts`: 11 tests (contract-compliance, verboden
    velden, rol-mapping, timestamp-validatie, lege content).
  - `electron-main.js`: Foundation-config-resolver (URL + token uit
    `Foundation/server/data/token.txt`, env-overrides) en IPC-handler
    `foundation-capture-chat` (Node `fetch`, nooit throw).
  - `electron-preload.js`: `captureChatToFoundation(payload)`.
  - `App.tsx`: type-declaratie van `captureChatToFoundation`.
  - Validatie: `npx vitest run` → 21 tests groen; `vite build` → ok;
    `node --check` op main/preload → ok.
  - Live tegen de server (Foundation op `contabo`, Tailscale `100.65.0.15:4577`):
    config in gitignored `foundation.local.json`. Twee keer dezelfde chat met
    dezelfde `url` → eerste `201` + `insertedNew:true`, tweede `200` +
    `insertedNew:false`, zelfde `id` en `providerConversationId` (dedup bewezen).
    Contract-weigering: `status` → 422, onbekend veld → 422, zonder token → 401.
    Test-observatie-id: `1c18f0de-c17d-475e-9c25-21dac2c334a4` (nog op te ruimen
    of te laten staan).

## 2026-10-05 (Capture-verbinding, fase 2 — import splitsen)

- Findings:
  - De verrijking (`analyzeContent`/`generateEmbedding`) zat ín `UploadModal` en
    gooide bij falen de hele import om (`success:false`) — dat botst met de regel
    "de archief-write mag nooit falen".
- Conclusions:
  - Verrijking is nu best-effort; het archief wordt altijd eerst gezet en capture
    is een losse, retrybare stap. De ruwe capture-velden (`capture`) en de
    leverstatus (`foundation`) worden op de entry bewaard, zodat een mislukte
    zending later opnieuw kan zonder de chat opnieuw te importeren.
  - Alleen chats worden gecaptured; een geïmporteerde afbeelding is een visueel
    asset, geen chat.
- Actions:
  - `types.ts`: `CaptureData`, `CaptureTurn`, `FoundationCaptureState`;
    `ChatEntry.capture`/`.foundation`.
  - `utils/foundationCapture.ts`: `turnsFromTranscript()` (hergebruikt
    `parseChatMessages`).
  - `electron-main.js` + `scripts/migrate.js`: kolommen `capture JSONB` en
    `foundation JSONB` (+ `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` voor
    bestaande DB's), save/load-mapping.
  - `UploadModal.tsx`: non-fataal verrijken (`enrichContent`/`safeEmbedding`),
    turns afgeleid uit het transcript, capture doorgegeven aan `onUpload`.
  - `App.tsx`: `captureToFoundation`, `setFoundationState`, `handleRetryCapture`;
    archief-eerst, capture daarna (fire-and-forget).
  - `ChatViewer.tsx`: status-pil (Captured to Gaia / Sending… / Not sent) + Retry.
  - Validatie: 24 tests groen, `vite build` ok, `node --check` ok. App-niveau
    end-to-end nog niet gedraaid (vereist lokale Postgres + GUI).

## 2026-10-05 (Capture-verbinding, fase 3 — ruwe vorm per bron)

- Findings:
  - Chronicle had twee parsers: `utils/chatUtils.convertJsonToTranscript` in de
    renderer (kent `messages`/`history`/`conversation`, geen echte url) en een
    oudere `jsonToTranscript` in `electron-main.js` (kende wél de ChatGPT
    `mapping`-boom). Beide gaven alleen platte tekst terug: geen `turns`, geen
    `url`, geen `occurredAt` — dus geen dedup per bron.
  - `Chronicle Docs/ChatGPT-importer-review-...md` (juli) beschrijft precies de
    juiste aanpak: rendert op gestructureerde `turns`, provider-idempotency op
    `(sourceProvider, providerConversationId)`.
- Conclusions:
  - Eén gedeelde, pure parser-module als bron van waarheid; de main-process-versie
    wordt eruit afgeleid (via esbuild) in plaats van gedupliceerd. Dedup werkt
    nu waar de bron een stabiele id heeft (Claude-export: `uuid` → url); ChatGPT
    blijft bewust url-loos tot de scraper-run (fase 5-vervolg).
  - Export-parsers splitsen een bestand in één of meerdere gesprekken (een
    Claude-export bevat álle gesprekken).
- Actions:
  - Nieuw `utils/sourceParsers.ts` (+ `.test.ts`, 15 tests): `parseClaudeConversation`,
    `parseClaudeExport`, `parseChatGPTConversation` (mapping, cycle-guard,
    systeem-berichten overgeslagen), generieke dispatcher `parseConversationJson`.
  - Nieuw `scripts/build-source-parsers.js` (esbuild → `utils/sourceParsers.cjs`,
    gitignored) + npm-script `build:parsers` in `postinstall`.
  - `UploadModal.tsx`: JSON-import gebruikt de parsers; per gesprek een result;
    `url`/`occurredAt`/`sourceProvider` gaan mee in `capture`.
  - `electron-main.js`: `import-chats` hergebruikt de gedeelde parsers, oude
    `jsonToTranscript` verwijderd; import-entries krijgen `capture`.
  - Live tegen de server bewezen: Claude-export → `url https://claude.ai/chat/…`
    → eerste POST `201`/`insertedNew:true`, tweede `200`/`insertedNew:false`,
    zelfde `providerConversationId claude:…`. Test-observatie daarna opgeruimd
    (episode + gateway-rij, trigger terug op `O`).
  - Validatie: 39 tests groen, `vite build` ok, `node --check` ok.

## 2026-10-05 (Capture-verbinding, fase 4 — bronbestand als blob, eigenaar Foundation)

- Findings:
  - Besluit (gebruiker): Foundation is **eigenaar** van het originele
    exportbestand; Chronicle houdt een identieke byte-for-byte kopie. Het hele
    bestand gaat als één blob naar Foundation; daarnaast elk gesprek rauw als
    chat. De blob is het "ultieme bewijs", waardoor elke ontledingskeuze aan de
    capture-kant herleidbaar en herhaalbaar is.
- Conclusions:
  - Chronicle's kopie is content-addressed op **dezelfde** sha256 als Foundation,
    zodat de hashes direct vergelijkbaar zijn en een mismatch zichtbaar is
    (`identical`-vlag). Mirror eerst, dan pas verzenden.
  - Het bronbestand is een apart ding, niet een veld van de chat: aparte
    `sourceFile`-state op de entry, met eigen status en retry.
- Actions:
  - `electron-main.js`: lokale blob-mirror (`putLocalBlob`, sha256) + IPC
    `foundation-capture-source-file` (mirror → POST `/api/source-files`, geeft
    beide hashes terug); `sourceFile`-kolom in save/load + init/migratie.
  - `electron-preload.js`: `captureSourceFileToFoundation` + `getPathForFile`
    (webUtils) zodat de renderer het echte bestandspad kan doorgeven.
  - `types.ts`: `SourceFileState` + `ChatEntry.sourceFile`.
  - `UploadModal.tsx`: `SourceFileRef` per bestand (ook voor afbeeldingen, die
    context kunnen dragen), doorgegeven aan `onUpload`.
  - `App.tsx`: `captureSourceFile`/`setSourceFileState`/`handleRetrySourceFile`;
    volgorde archief → bronbestand → chat.
  - `ChatViewer.tsx`: status-pil "Original mirrored"/"Sending original…"/"Original
    not sent" + Retry file.
  - Validatie: 39 tests groen, `vite build` ok, `node --check` ok. Live blob-
    upload tegen de VPS bewezen (sha256 identiek, idempotent).

## 2026-10-05 (Foto's als attachments aan de chat gekoppeld)

- Findings:
  - Besluit (gebruiker): alleen foto's die in **dezelfde bron** zitten worden aan
    de chat gekoppeld — geen verzonnen paren.
  - Bevinding op de server: `POST /api/attachments` gaf 400 op binaire bodies —
    de globale `express.json` probeerde ze als JSON te parsen (dezelfde bug als
    eerder bij `/api/source-files`). De attachment-route was dus stuk sinds die
    parser er is.
- Conclusions:
  - De payload-kant (`buildChatIngestPayload`) draagt nu `attachments`
    (metadata, id verplicht); Foundation's `chat`-contract staat het al toe.
  - Extractie is per bron en verzon niets: ChatGPT's `mapping` levert inline
    data-URLs (bytes) én pointers (url); Claude's export noemt binaire
    attachments alleen bij naam en bevat geen bytes — die worden niet geüpload.
  - Volgorde: bronbestand → foto's uploaden → chat met attachment-referenties.
- Actions:
  - Foundation: `express.json` skipt nu ook `/api/attachments` (naast
    `/api/source-files`); attachment-upload live bewezen (201, bestand op schijf,
    referentie op de observatie).
  - Chronicle: `utils/foundationCapture.ts` (+ `attachments` in payload/tests);
    `utils/sourceParsers.ts` (`ParsedImage`, ChatGPT image-extractie uit parts,
    Claude naam-only); `electron-main.js` (`foundation-upload-attachment`, pad
    óf dataUrl); `electron-preload.js`; `types.ts` (`CaptureData.attachments`);
    `UploadModal.tsx` (`AttachmentRef`, per gesprek); `App.tsx`
    (`captureToFoundation` uploadt refs vóór de chat).
  - Live bewezen: attachment `bc1f17b8…` geüpload, chat `78213c77…` met die
    referentie → `attachments` op de observatie, bytes op schijf. Daarna
    opgeruimd (trigger terug op `O`).
  - Validatie: 43 tests groen, `vite build` ok, `node --check` ok.

## 2026-10-05 (Gemini-verrijking gerepareerd — key naar het main-proces)

- Findings:
  - `services/geminiService.ts` las `process.env.API_KEY` in de **renderer**;
    Vite definieert dat niet, dus de verrijking was stuk. Een `define` als "fix"
    zou de key in de client-bundle bakken — een lek.
  - Live tegen de Gemini-API bleek de key **geldig**, maar de modellen bestaan
    niet meer: `gemini-3-flash-preview` staat niet in de model-lijst, en
    `text-embedding-004` is vervangen door `gemini-embedding-001` (response is
    `embeddings[0].values`, niet `embedding.values`).
- Conclusions:
  - De key hoort in het main-proces, precies zoals de Foundation-token. De
    Gemini-calls zijn naar IPC verplaatst; de renderer raakt de key nooit aan.
  - Modellen naar bestaande alternatieven: `gemini-flash-latest` (stabiele
    alias) en `gemini-embedding-001`.
- Actions:
  - `electron-main.js`: `resolveGeminiKey()` + `.env.local`-loader; IPC-handlers
    `analyze-content`, `generate-embedding`, `fetch-models` (met de juiste
    modellen en response-vorm).
  - `electron-preload.js`: de drie handlers exposed.
  - `services/geminiService.ts`: herschreven naar IPC (`window.electronAPI`),
    geen `process.env.API_KEY` meer; browser-fallback faalt eerlijk.
  - Defaults gelijkgetrokken: `App.tsx`, `SettingsModal.tsx`, `geminiService`,
    `fetch-models`-fallback.
  - Live bewezen: `analyze-content` → geldige JSON (summary/tags/title),
    `generate-embedding` → 3072 dims. Build-bundle kromp 768 kB → 490 kB (de
    `@google/genai`-SDK zit niet meer in de renderer).
  - Validatie: 43 tests groen, `vite build` ok, `node --check` ok.

## 2026-10-05 (Importformaten: Markdown-export + derde-partij JSON, en stille faal)

- Findings:
  - Bo importeerde een chat via een derde-partij export-extensie, in twee
    vormen: een **Markdown-export** (`> From: <url>`, `# you asked` /
    `# chatgpt response`, `message time:`) en een **JSON-export** (array van
    berichten met `contents: [{type,content}]` + `chatGroupId`).
  - Beide faalden: de Markdown ging als **één turn zonder url** naar Foundation,
    de JSON gaf "Invalid chat structure" (`parseConversationJson` → null).
  - Erger: bij enkel mislukte resultaten sloot "Commit to Archive" de modal
    **zonder iets te importeren en zonder melding** — een stille faal.
- Conclusions:
  - Beide exportvormen zijn nu ondersteund; crucially leveren ze **dezelfde**
    `provider_conversation_id` (uit de conversation-id), dus dedup werkt over
    Markdown én JSON heen.
  - De stille faal is gedicht: `handleFinalize` sluit nooit meer stil en toont
    welke bestanden faalden en waarom.
- Actions:
  - `utils/sourceParsers.ts`: `parseMarkdownTranscript` + `looksLikeMarkdownExport`
    (url via `> From:`, turns via headings, `occurredAt` via `message time:`);
    `genericTurns` begrijpt nu `contents[]`-blokken; `urlFromExport` leidt de url
    af uit `chatGroupId`/`conversation_id`.
  - `components/UploadModal.tsx`: Markdown-tak naast de JSON-tak; `commitError`
    + zichtbare melding; `handleFinalize` weigert stil te sluiten.
  - Live bewezen tegen Bo's echte bestanden (`Gaia-geheugenarchitectuur.md` én
    `.json`): beide → url `https://chatgpt.com/c/6ac2ea61-…`, provider chatgpt,
    2 echte turns.
  - Validatie: 50 tests groen, `vite build` ok. Na parserwijziging
    `npm run build:parsers` gedraaid (CJS bijgewerkt).

## 2026-10-05 (Archiveren in plaats van verwijderen)

- Findings:
  - De prullenbak-knop heette "Destroy Memory" / "Confirm Deletion", maar er was
    **geen DELETE** in de app: `save-database` upsert alleen, dus de rij bleef in
    Postgres staan en kwam na herstart terug. De knop loog in twee richtingen.
  - Besluit (Bo, zie `capture-chronicle.md`): uit het archief halen mag; het blijft
    in Chronicle én in Foundation. Foundation wordt niet aangeraakt.
- Conclusions:
  - Echt **archiveren**: een `archived`-vlag, standaard verborgen, terug te halen.
    Geen enkele chat wordt meer uit de database verwijderd.
  - Eerlijke UX: archief-icoon + "Move to Archive", bevestiging zegt expliciet dat
    de chat bewaard blijft in Chronicle en Gaia.
- Actions:
  - `types.ts`: `ChatEntry.archived`, `AppState.showArchived`.
  - `electron-main.js`: kolom `archived BOOLEAN` (+ ALTER voor bestaande DB's),
    save/load-mapping.
  - `App.tsx`: `handleArchive`/`handleRestore` (vervangen `handleDelete`);
    `showArchived`-filter in `filteredChats`.
  - `components/Sidebar.tsx`: "Show archived"-toggle in de quick filters.
  - `components/ChatViewer.tsx`: archief-icoon/`Restore`, nieuwe bevestigingstekst;
    inline `TrashIcon` weg.
  - `components/Icons.tsx`: `ArchiveIcon` toegevoegd.
  - Validatie: 50 tests groen, `vite build` ok, `node --check` ok.

## 2026-10-05 (Dedup bij import: url eerst, content-hash als fallback)

- Findings:
  - Chronicle had geen inhoudelijke dedup: elke import kreeg een random id, dus
    dezelfde chat twee keer importeren gaf twee rijen — terwijl Foundation de
    tweede als upsert ziet. Dat liep uit elkaar (drift).
  - Foundation's `contentHash` (server/contentHash.js) is een simpele 32-bit
    hash (`ch_...`), geen sha256 — bewust "good enough" voor tekst-dedup.
- Conclusions (Bo): sleutel = url waar die er is, anders content-hash; bij een
  treffer: identieke inhoud → niet importeren, andere inhoud → incrementeel
  updaten (geen tweede rij). Bijwerken → opnieuw capturen naar Foundation.
  Bewuste beperking: zonder url zijn twee verschillende chats met identieke
  tekst niet te onderscheiden (gedocumenteerd in de code).
- Actions:
  - Nieuw `utils/chatDedup.ts` (+ 12 tests): `foundationContentHash` (zelfde
    algoritme als Foundation, portable), `normalizeUrl` (zelfde normalisatie als
    `providerConversationId.js`), `dedupKeys`, `findChatDuplicate`.
  - `App.tsx` `handleUpload`: vóór toevoegen zoeken op url/hash; identiek →
    overslaan; anders → bestaande entry bijwerken + opnieuw capturen. Korte
    melding (`importNotice`) toont "already in your archive" / "Updated existing
    chat".
  - `types.ts`: `ChatEntry.contentHash`; `electron-main.js`: kolom `"contentHash"`
    (+ ALTER), save/load-mapping; kolomnaam-quoting op de VPS bewezen.
  - Validatie: 62 tests groen, `vite build` ok, `node --check` ok.

## 2026-10-08 (Claude-export: manifest + categorie-zips)

- Findings:
  - Bo's Claude-export is niet langer één `conversations.json`. De download is
    nu een `manifest.json` (`data_files[]`) die 6 categorie-zips noemt:
    `light_metadata`, `projects`, `memories`, `design_chats`, `frames`,
    `conversations` — elk achter een eenmalige, 24u-geldige link.
  - De native bulk-import brak daarop: de file-dialog accepteerde alleen
    `json/md/txt`, en `import-chats` las elk bestand met `fs.readFileSync(...,'utf-8')`
    → binaire zip faalt. Er was ook nergens zip-extractie in de repo.
  - Belangrijker: het *gespreksschema binnenin is ongewijzigd* (zelfde array met
    `uuid`/`name`/`chat_messages[{sender,content}]`). De aanname "de parser moet
    herschreven" klopt dus niet; alleen de verpakking veranderde. `summary` is
    nieuw en werd tot nu toe weggegooid.
  - Losse bug: `SettingsModal.handleNativeImport` riep `onNativeImport?.()`, maar
    `App.tsx` gaf die prop nooit door. De knop parseerde dus wel, maar zette
    nooit iets in het archief (loze "Successfully imported N chats"-alert). Ook
    las hij dedup-ids uit `localStorage.chronicle_chats_v1`, dat in native modus
    niet meer geschreven wordt (de DB is de bron) → altijd lege set.
- Conclusions:
  - De rewrite zit in de container/import-laag, niet in de parser: zip +
    manifest lezen, gesprekscategorieën eruit halen, de rest (memories, frames,
    login-data) laten vallen door de strikte `parseClaudeExport`.
  - Ontbrekende zips worden gerapporteerd in plaats van stil genegeerd, zodat een
    halve download zichtbaar is.
  - `fflate` als zip-dep: ~8 kB, pure JS, CJS in het main-proces.
- Actions:
  - Nieuw `utils/claudeExportZip.cjs` (Electron-vrij, testbaar):
    `readJsonEntries`, `isClaudeExportManifest`, `conversationsFromZip`,
    `conversationsFromManifest` (rapporteert `missing`).
  - Nieuw `utils/claudeExportZip.test.ts` (6 tests): zip-uitlezen, manifest-herkenning,
    gesprekken uit één zip, categorieën negeren, ontbrekende zips melden.
  - `utils/sourceParsers.ts`: `ParsedConversation.summary` + `parseClaudeConversation`
    neemt `conv.summary` mee; `sourceParsers.test.ts` +1 test.
  - `electron-main.js` `import-chats`: `.zip`-filter + All Files; zip- of
    manifest-pad via de nieuwe module; `summary`/`missing` doorgegeven.
  - `App.tsx`: `handleNativeImport` (loopt elke chat door `handleUpload`, dus
    dezelfde dedup + Foundation-capture) en `onNativeImport={handleNativeImport}`
    op `SettingsModal`; `importChats`-type krijgt `missing`.
  - `components/SettingsModal.tsx`: dedup-ids nu uit `loadDatabase()`; alert toont
    niet-gedownloade zips.
  - `package.json`: `fflate` dependency.
  - Validatie: 92 tests groen, `vite build` ok, `node --check` op
    `electron-main.js` + `claudeExportZip.cjs` ok.

## 2026-10-08 (Importdatum = echte gespreksdatum i.p.v. vandaag)

- Findings:
  - Bo: "Alle chats krijgen de datum van vandaag." Dat was een **bewuste eerdere
    keuze** (comment in `captureIngest.ts`): de archiefregel kreeg de ingest-tijd
    als `createdAt`, zodat een geïmporteerde chat bovenaan stond i.p.v. op zijn
    oorspronkelijke datum. De UI (ChatCard, ChatViewer, sortering, zoekfilters,
    analytics) leest overal `chat.createdAt`, dus daar kwam "vandaag" vandaan.
  - Het echte gespreksmoment zat wél al in `capture.occurredAt` (naar Foundation),
    maar niet op de entry.
- Conclusions:
  - Besluit (Bo): omdraaien — de echte gespreksdatum is de archiefsdatum. Eén
    regel voor álle importpaden: gebruik `capture.occurredAt` als die er is, val
    anders terug op de ingest-tijd (bron zonder tijd, bijv. losse notitie).
  - Bewust gevolg: geïmporteerde chats staan nu chronologisch op hun eigen datum,
    niet meer automatisch bovenaan.
- Actions:
  - `App.tsx` `handleUpload` (dekt zowel UploadModal als de native bulk-import):
    `createdAt`/`updatedAt` van een nieuwe chat = `Date.parse(capture.occurredAt)`
    met `now` als fallback.
  - `utils/captureIngest.ts` (plugin-ingest): `archiveMs = occurredMs ?? now`;
    `item.createdAt`/`updatedAt` = `archiveMs`; oude comment vervangen.
  - `utils/captureIngest.test.ts`: +1 test (archiefdatum = occurredAt) en +1
    (fallback naar ingest-tijd zonder tijd).
  - Validatie: 93 tests groen, `vite build` ok, `node --check` ok.

## 2026-10-08 (Bestaande imports bijwerken naar hun echte datum)

- Findings:
  - Bo importeerde opnieuw en alles stond nog op 8 oktober. Twee oorzaken: (1) de
    nieuwe regel geldt alleen voor nieuwe entries, en (2) de id-dedup slaat een
    re-import van hetzelfde bestand over, dus bestaande rijen werden nooit
    bijgewerkt. Bovendien draait de fix pas na `vite build` + herstart.
  - De echte datum zat wél al in `capture.occurredAt` van elke opgeslagen rij.
- Conclusions:
  - Niet alleen nieuwe imports fixen, maar de archiefsdatum bij het **laden**
    afleiden uit `capture.occurredAt`. Zo corrigeren bestaande rijen zichzelf
    zonder re-import; idempotent. Rijen zonder capture-moment (losse notitie)
    houden hun opgeslagen datum.
- Actions:
  - `utils/captureIngest.ts`: nieuw `archiveTimestamps(capture, fallback)` als
    één regel voor "archiefdatum = gespreksmoment"; `normalizeIngestChat`
    gebruikt het.
  - `electron-main.js` `load-database`: `createdAt`/`updatedAt` uit
    `capture.occurredAt` wanneer aanwezig, anders de opgeslagen waarden.
  - `utils/captureIngest.test.ts`: +2 tests voor `archiveTimestamps` (met/zonder
    moment).
  - Validatie: 95 tests groen, `vite build` ok, `node --check` ok.

## 2026-10-08 (Echte wipe + in-app importmelding)

- Findings:
  - Bo kreeg na import op een "lege" database "Already in your archive". `SELECT
    count(*) FROM chats` gaf **545** rijen: de database was niet leeg.
  - Oorzaak: "Wipe All Data" deed alleen `setState({ chats: [] })` — er was geen
    DELETE. De knop belooft "This action is permanent", maar de rijen kwamen bij
    de volgende start gewoon terug (net als `archived`, maar hier is wissen wél
    de bedoeling). De dedup op de import was dus correct.
  - De importmelding was een browser-`alert()` in `SettingsModal`, buiten de
    app-stijl (Bo's tweede punt). Daarnaast toonde de App-toast tijdens een bulk
    alleen de laatste per-chat-uitslag.
- Conclusions:
  - Wipe moet écht uit Postgres verwijderen (Chronicle's eigen kopie; Gaia
    onaangeroerd — consistent met `capture-chronicle.md`).
  - Importresultaat in de app-stijl tonen, en de bulk als één samenvatting i.p.v.
    een reeks per-chat-toasts. De renderer bepaalt wat nieuw is (url/hash-dedup),
    dus de telling komt uit `handleUpload`, niet uit het aantal dat het
    main-proces zag.
- Actions:
  - `electron-main.js`: nieuw `clear-database` (`DELETE FROM chats` + `links`);
    `electron-preload.js` + `App.tsx`-type: `clearDatabase`.
  - `App.tsx`: `handleClearAll` async en roept `clearDatabase()` aan vóór het
    leegmaken van de state. `handleUpload` geeft nu `'added' | 'updated' |
    'duplicate'` terug en heeft een `silent`-vlag; `handleNativeImport` telt de
    uitkomsten en geeft een samenvatting terug, zonder losse toasts.
  - `components/SettingsModal.tsx`: `alert()` vervangen door een gestylede
    melding (sagegroen/amber/terracotta) onder Data Management; prop geeft de
    samenvatting door.
  - Validatie: 95 tests groen, `vite build` ok, `node --check` op main + preload ok.
  - Vervolg (zelfde dag, Bo): die melding stond ín de scrollbare tab-inhoud,
    dus je moest scrollen om het succes te zien. Melding verplaatst naar een balk
    tússen de scroll-inhoud en de footer (altijd zichtbaar), met ✓/!/×-icoon.

## 2026-10-08 (Resizable eerste kolom)

- Findings: De eerste kolom (Sidebar, archieflijst) stond vast op `w-[280px]` en
  kon niet breder, waardoor lange titels/tags afgekapt werden.
- Conclusions: Vaste breedte vervangen door state + sleepgreep aan de
  rechterrand. Standaard twee keer zo breed (560px), ondergrens 240px, harde
  bovengrens 50% van het venster. Waarde bewust lokaal in `Sidebar` gehouden
  (geen App-state) omdat dit puur een layout-detail is; `max-w-[50vw]` is een
  tweede vangnet naast de clamp in de drag-handler. `transition-all` vervangen
  door `transition-colors`, anders loopt de breedte tijdens het slepen achter.
- Actions:
  - `components/Sidebar.tsx`: `width`-state (default 560), `clampWidth`,
    `startResize` + window `mousemove`/`mouseup`-listeners, clamp bij
    venster-resize; sleepgreep (`cursor-col-resize`, hover-highlight) in `aside`.
  - Validatie: `vite build` ok.

## 2026-10-08 (Plugin: ChatGPT auto-capture — endpoint verplaatst)

- Findings: Claude werkte, ChatGPT niet. Console: interceptor actief + helper
  geïnjecteerd, maar géén `[Chronicle] intercept: chatgpt`. Live geprobeerd tegen
  chatgpt.com (unauth-mweb, Playwright): `POST /backend-api/conversation` → 422
  (bestaat) én `POST /backend-api/f/conversation` → 422 (bestaat óók). De
  interceptor matchte alleen `/backend-api/conversation`, dus de huidige
  streaming-route `f/conversation` viel er buiten → geen sein → geen
  auto-capture. `GET /backend-api/conversation/{id}` gaf in dezelfde sessie 404
  (Bo's consoleregel), terwijl `GET /backend-api/conversations` 200 gaf — de
  detail-route is dus ook niet meer betrouwbaar.
- Conclusions:
  - Send-route verbreden naar `/backend-api/(f/)?conversation`. Over-signaleren
    is veilig (listener dedupt op url/contentHash, provider levert herhaald).
  - Onbekende conversation-POST's één keer per URL loggen: dan is een volgende
    endpoint-wijziging direct zichtbaar in de console in plaats van stil.
  - Read-pad houdt de bewezen `/conversation/{id}` maar probeert nu ook
    `/conversations/{id}` (bestaat, 401 zonder auth) en accepteert alleen een
    antwoord met `mapping`; anders DOM-fallback (nu met logregel).
- Actions:
  - `plugin/content/intercept.js`: `CHATGPT_CONVERSATION` =
    `/backend-api/(?:f/)?conversation(?:[/?]|$)/i`; diagnose-log voor niet-
    gematchte `/backend-api/...conversation`-POST's; headercomment bijgewerkt.
  - `plugin/content/chatgpt.js`: `fetchConversation` probeert twee routes en
    eist een `mapping`-tree; API-fout wordt gelogd vóór DOM-fallback.
  - `plugin/content/normalize.js`: bulk-samenvatting las `report: {}` (NaN);
    gebruikt nu het laatste chunk-rapport.
  - `plugin/manifest.json` → 0.1.2; `plugin/README.md` bijgewerkt.
  - Validatie: `node --check` op alle plugin-JS + manifest-JSON ok.
  - Open: Bo moet de extensie herladen en een bericht sturen; de nieuwe
    diagnose-regel bevestigt de definitieve route.

## 2026-10-08 (Plugin: ChatGPT-send seint nu, read-route + auth)

- Findings: Na de interceptor-fix verscheen `[Chronicle] intercept: chatgpt` +
  `auto-capture signaal`, maar het uitlezen faalde: `GET
  /backend-api/conversation/{id}` → 404 en `GET /backend-api/conversations/{id}`
  → 401; de DOM-fallback vond 0 berichten. De 401 op de meervoud-route is de
  aanwijzing: de ChatGPT-API gate't `/backend-api` op een Bearer-token, niet op
  cookies alleen.
- Conclusions:
  - Auth-header toevoegen zoals de bewezen exporter (pionxzh): token uit
    `/api/auth/session` → `Authorization` + `X-Authorization`. Cookies blijven
    als fallback als de sessie niet leesbaar is.
  - Detailrespons kan direct de mapping zijn of onder `conversation` zitten;
    `mappingRoot` accepteert beide en weigert de rest (dan DOM-fallback).
  - Diagnose verbreed: élke conversation-request (elke methode, bazaar/ads
    uitgezonderd) één keer loggen, zodat ook een read-routewijziging zichtbaar is.
- Actions:
  - `plugin/content/chatgpt.js`: `authHeaders()` + `mappingRoot()`; probeert
    `/conversation/{id}` dan `/conversations/{id}` met auth.
  - `plugin/content/intercept.js`: send-sein alleen op POST, daarnaast
    once-per-URL diagnose voor GET én POST conversation-requests.
  - `plugin/manifest.json` → 0.1.3; `plugin/README.md` bijgewerkt.
  - Validatie: `node --check` ok. Open: herladen + testen; bij falen geeft
    `chatgpt request gezien:` de route die de pagina zelf wél gebruikt.

## 2026-10-08 (Plugin: ChatGPT werkt — bevestigd)

- Findings: Bo herlaadde de extensie; de diagnose-regel gaf de definitieve
  route: `GET /backend-api/conversations/{id}?num_turns=10&include_has_versions=true`.
  Onze aanroep (meervoud, zónder query) gaf de volledige mapping terug en de
  capture landde: `auto-capture: levering 1 van 3 — 7 berichten` →
  `{"ok":true,"status":201,"action":"create"}` + twee `duplicate`-leveringen.
  Claude én ChatGPT werken nu.
- Conclusions:
  - De pagina zelf leest met `num_turns=10` (alleen recente turns); wij laten de
    query bewust weg zodat de volledige conversation-mapping wordt opgehaald —
    dat is precies wat een archief-export wil.
  - Diagnose-regel terug naar `console.debug`: bruikbaar bij problemen (Verbose),
    maar geen ruis in de normale console.
- Actions:
  - `plugin/content/intercept.js`: `chatgpt request gezien` → `console.debug`.
  - Validatie: `node --check` ok.

## 2026-10-08 (Plugin: Gemini als derde provider)

- Findings: Gemini toevoegen aan de plugin. Gemini heeft geen bruikbare
  JSON-API: de webclient praat via het ondoorzichtige
  `batchexecute`/`StreamGenerate`-protocol, en een directe `/app/{id}`-load
  rendert alleen de app-shell (berichten laden alléén door op een zijbalk-
  anchor te klikken). De DOM-selectors zijn dus de enige realistische route.
- Conclusions:
  - DOM-extractie met de bewezen selectors uit `davidmalko87/gemini-chat-
    exporter` (mid-2026): `.conversation-container`, `user-query .query-text`,
    `model-response .markdown`. Eerste-selector-die-tekst-heeft, plus
    NBSP-normalisatie en het strippen van "You said"/"Gemini said".
  - Auto-capture seint op de StreamGenerate-POST (fetch óf XHR) en scrapet
    daarna herhaald (3/6/9s) de DOM — het antwoord streamt immers nog;
    listener-dedup maakt herlevering veilig.
  - Bulk kan niet via een lijst-API: de (gevirtualiseerde) zijbalk wordt
    uitgelezen en elk gesprek wordt aangeklikt, met de stabiliteitswacht +
    "eerste prompt verschilt"-guard tegen het stale-body-probleem dat de
    userscript documenteert.
  - `occurredAt` blijft leeg — Gemini toont geen tijdstip in de DOM.
- Actions:
  - nieuw `plugin/content/gemini.js` (knop, bulk, auto-capture, DOM-scrape).
  - `plugin/content/intercept.js`: `GEMINI_STREAM`-regex + `signal('gemini')`
    in de fetch- én XHR-tak; diagnose verbreed (`request gezien`, debug).
  - `plugin/manifest.json` → 0.2.0: gemini-host-permissie, intercept-match en
    een derde provider-entry.
  - `plugin/README.md` bijgewerkt.
  - Validatie: `node --check` op alle plugin-JS + manifest-JSON ok; `vite build` ok.
  - Open: Bo moet de extensie herladen en op gemini.google.com testen; de
    selectors kunnen na een Google-update breken.

## 2026-10-08 (Plugin: Gemini auto-capture via DOM-observer)

- Findings: Gemini-provider laadde wel (interceptor + helper + provider actief)
  maar er kwam géén `[Chronicle] intercept: gemini` — de StreamGenerate-route
  vuurde niet (of er was geen bericht verzonden, of Google gebruikt een andere
  batchexecute-route; onze `request gezien`-diagnose staat op debug en was dus
  verborgen in de console).
- Conclusions:
  - Voor een DOM-only provider is de netwerkroute een zwak fundament. De DOM
    wordt nu de bron van waarheid: een `MutationObserver` met settle-debounce
    (1,8s) levert het gesprek zodra een antwoord klaar is met streamen.
  - Geen export bij het openen van een bestaand gesprek: pas groei t.o.v. de
    baseline na render-stilte telt. Baseline reset bij SPA-navigatie naar een
    ander /app/{id}. Herlevering blijft veilig (listener-dedup).
  - Het interceptorsignaal blijft als bonus-trigger, maar is niet meer de basis.
- Actions:
  - `plugin/content/gemini.js`: `MutationObserver` + `signature()`/
    `scheduleCapture()`/`armAfterSettle()`; URL-reset; eenmalige DOM-diagnose
    (`gemini DOM-diagnose: N containers, M berichten`).
  - `plugin/manifest.json` → 0.2.1; `plugin/README.md` bijgewerkt.
  - Validatie: `node --check` ok.
  - Open: herladen; de DOM-diagnose-regel vertelt of de selectors nog kloppen.

## 2026-10-08 (Plugin: Gemini werkt — bevestigd)

- Findings: Na herladen vuurde de keten zoals bedoeld: `[Chronicle] intercept:
  gemini` → `auto-capture: levering — 8 berichten` →
  `{"ok":true,"action":"create"}` en daarna `action:"update"`. De
  DOM-selectors kloppen (8 turns). De `gemini DOM-diagnose: 0 containers` hoorde
  bij de lege `/app`-pagina vóór er een gesprek was — correct gedrag.
- Conclusions:
  - De MutationObserver is de juiste basis voor Gemini; de netwerkroute
    (StreamGenerate) is onbetrouwbaar. Selectors uit gemini-chat-exporter
    werken.
  - De console ruis (`m=LQaXg?wli=BardChatUi…`) is Gemini's eigen wasm-logging,
    niet van de plugin.
- Actions: geen codewijziging; walkthrough bijgewerkt.
  - Plugin-status: Claude, ChatGPT én Gemini werken.

## 2026-10-08 (Jaartal op de chatkaart)

- Findings: De datum op de chatkaart toonde alleen "24 dec", zonder jaartal.
- Conclusions: `year: 'numeric'` toegevoegd — nu "24 dec 2025". Geldt voor de
  kaart; er is geen tweede plek met deze maand/dag-only formattering.
- Actions: `components/ChatCard.tsx` (dateStr-options); `vite build` ok.

## 2026-10-09 (Plugin: Mistral als vierde provider — huidig + auto)

- Findings: Plugin moet ook chat.mistral.ai (Le Chat) kunnen. Live uitgezocht:
  Le Chat is een Next.js-app die via **tRPC** praat (`/api/trpc/<router>.<proc>`)
  en antwoorden streamt via `POST /api/chat` (+ `/api/chat/resume`). Lezen:
  `chat.byId` met `{id}` (uuid) voor de titel en `message.all` met `{chatId}`
  voor `{items:[berichten]}`. Berichten hebben `role` (user/assistant/system/
  tool) en `contentChunks` (soms een `content`-string). Anoniem verzenden
  redirect naar login, dus de echte send is niet live te observeren — de
  endpoints komen uit de clientbundel en zijn met een probe bevestigd
  (`chat.byId`/`message.all` bestaan, eisen een uuid; `chat.delete` is een POST).
- Conclusions:
  - Zelfde route-aanpak als ChatGPT: API eerst, DOM-fallback erachter. Send-sein
    op `POST /api/chat` (fetch). Geen bulk (per afspraak alleen huidig + auto).
  - De plugin alleen was niet genoeg: Mistral ontbrak in `SourceType` en in de
    twee provider-maps, waardoor een import als "Other" zou landen en de
    Foundation-dedup-provider fout zou zijn.
- Actions:
  - `plugin/content/mistral.js` (nieuw): tRPC-read (`chat.byId`, `message.all`),
    defensieve chunk→tekst, DOM-fallback, knop + toolbar + auto-capture.
  - `plugin/content/intercept.js`: `MISTRAL_CHAT` (`/api/chat`, `/api/chat/resume`)
    → `signal('mistral')`; diagnose verbreed naar `/api/chat`.
  - `plugin/manifest.json` → 0.3.0: host-permissie, intercept-match en
    provider-entry voor `chat.mistral.ai`.
  - `types.ts` `SourceType.MISTRAL`; `utils/captureIngest.ts` + `utils/foundationCapture.ts`
    provider-maps; `utils/sourceParsers.ts` union.
  - `components/Icons.tsx` `MistralIcon`; `components/ChatCard.tsx`-branch;
    `components/MindMap.tsx`-kleur.
  - `plugin/README.md` bijgewerkt.
  - Validatie: `npm run build:parsers` (captureIngest.cjs), 95 tests groen,
    `vite build` ok, `node --check` op plugin + main.
  - Open: extensie herladen; op chat.mistral.ai een bericht sturen en kijken naar
    `[Chronicle] intercept: mistral` → `auto-capture: levering …`. Bij falen
    geeft `request gezien: POST …/api/chat` de route; de API-read logt zijn
    status/fout.

## 2026-10-09 (Minimize to tray-optie)

- Findings: Er was geen manier om Chronicle naar het systeemvak te verbergen;
  minimaliseren ging altijd naar de taakbalk. De main-process had ook geen
  tray-icoon en geen enkel kanaal om een renderer-voorkeur naar de main te
  sturen.
- Conclusions:
  - De optie hoort in `Settings` (net als thema) en wordt via localStorage
    bewaard; de main-process beslist op basis daarvan of minimaliseren het
    venster verbergt. Een klein IPC-kanaal (`set-minimize-to-tray`) houdt de
    twee kanten in sync zonder de token/secret-aanpak te raken.
  - Tray wordt pas aangemaakt als de optie aan staat en weer opgeruimd bij
    uitzetten, zodat er nooit een pictogram verschijnt zonder dat erom gevraagd
    is. Klikken op het pictogram (of "Open Chronicle" in het menu) haalt het
    venster terug; het menu heeft ook Quit.
  - Het icoon is gegenereerd met een dependency-vrij script (PNG via zlib) in
    het app-palet (#8A9482), 32×32 met 4× supersampling voor gladde randen.
- Actions:
  - `scripts/make-tray-icon.js` (nieuw) + `assets/tray-icon.png` (gegenereerd);
    `assets/**/*` zat al in de electron-builder `files`-lijst.
  - `electron-main.js`: `Tray`/`Menu`/`nativeImage`-import, `createTray`/
    `destroyTray`/`setMinimizeToTray`/`showMainWindow`, `minimize`-handler in
    `createWindow`, IPC `set-minimize-to-tray`.
  - `electron-preload.js`: `setMinimizeToTray`-bridge.
  - `types.ts`: `Settings.minimizeToTray`; `App.tsx`: default `false`, type-
    declaratie en het doorgeven in de settings-persist-effect.
  - `components/SettingsModal.tsx`: toggle in de General-tab (sectie "Window").
  - Validatie: `node --check` op main/preload/script, `vite build` ok,
    95 tests groen. `npm run build` (electron-builder) faalt op deze machine op
    de bekende winCodeSign-symlink-privilege, ongewijzigd t.o.v. ervoor.
  - Open: optie live testen in een gepackte/dev-app — minimaliseren zou het
    venster moeten verbergen en het tray-klik het moeten terugbrengen.

## 2026-10-12 (Installable NSIS-exe bouwen)

- Findings: `npm run build` bleef steken op `Sub items Errors: 2 … Cannot create
  symbolic link … winCodeSign\<hash>\darwin\10.12\lib\libcrypto.dylib` en daarna
  `Archives with Errors: 1`. Dat blokkeerde de NSIS-installer; alleen
  `release/win-unpacked/` werd geproduceerd. 7-Zip (via `app-builder`) pakt
  `winCodeSign-2.6.0.7z` uit en moet daarin de twee darwin-symlinks aanmaken;
  zonder `SeCreateSymbolicLinkPrivilege` (taakbalk: geen Developer Mode, geen
  admin-shell) mislukt dat en geeft 7za exit 2, wat electron-builder als
  mislukte extractie ziet. Alle overige bestanden in de archiefmap zijn wél
  uitgepakt; de twee dylibs zijn 0-byte resten.
- Conclusions:
  - De archiefmap van winCodeSign is inhoudelijk compleet genoeg: de twee
    darwin-symlinks zijn voor een Windows-build irrelevant (`rcedit-x64.exe` en
    `windows-6/signtool.exe` zijn er wel). Daarom is de bestaande extractie
    gekopieerd naar de mapnaam die electron-builder verwacht
    (`Cache/winCodeSign/winCodeSign-2.6.0`), waarna de download/extractie werd
    overgeslagen en de build doorliep.
  - Dit is een workaround, geen structurele fix: de echte oplossing blijft
    Developer Mode aanzetten (of een admin-shell), want dan slaagt de
    symlink-extractie en is de handmatige cache-seed niet nodig.
- Actions:
  - Geen codewijziging. Cache geseed: `%LOCALAPPDATA%\electron-builder\Cache\
    winCodeSign\winCodeSign-2.6.0` (kopie van een geslaagde extractie).
  - Resultaat: `release/Chronicle Setup 1.0.0.exe` (81 MB, NSIS one-click,
    perMachine=false) + `.blockmap`.
  - Aandachtspunten voor de volgende build:
    - `npm run build` draait géén `vite build`; eerst renderer bouwen, anders
      wordt een verouderde `dist/` verpakt (`release/win-unpacked` was van
      vóór de laatste rendererwijzigingen).
    - Geen app-icoon: `default Electron icon is used` en `author is missed in
      the package.json`. Voor een nette installer `build.win.icon`
      (`assets/icon.ico`) en `author` toevoegen.
    - `.env.local` stond niet in `build.files`; inmiddels toegevoegd, zodat de
      geïnstalleerde app de `API_KEY` bij zich heeft (`loadEnvLocal` leest
      `.env.local` via `app.getAppPath()`, en die asar-lezing werkt met
      Electron's fs-patch). Gevolg: de sleutel zit in de installer en is er met
      `asar extract` uit te halen — alleen deelbare builds zonder eigen key
      weggeven. Het Foundation-tokenbestand wordt nog steeds niet meegepakt
      (die zoekpaden wijzen naar `<app>/../Foundation/...`), dus Foundation-
      levering blijft afhankelijk van `FOUNDATION_TOKEN`/`FOUNDATION_URL` in de
      omgeving of `foundation.local.json`.
  - Validatie: `npx electron-builder --win nsis` → exit 0; installer aanwezig
    in `release/`.

## 2026-10-12 (App-icoon en author)

- Findings: In `assets/` stonden `icon.ico` en `build.win.ico`, maar beide zijn
  byte-identieke **PNG's** van 1024×1024 met een `.ico`-extensie. Met
  `build.win.icon: assets/icon.ico` faalde de build op
  `rcedit-x64.exe … Reserved header is not 0 or image type is not icon`: de
  `icon`-taak van app-builder converteert alleen als de extensie nog niet de
  doelvorm heeft, dus een PNG onder de naam `.ico` wordt ongewijzigd aan rcedit
  doorgegeven en die weigert het.
- Conclusions:
  - Het bronbestand hoeft geen ICO te zijn: `icon.png` (≥256×256) laat
    app-builder zelf een `.ico` genereren in `release/.icon-ico/`. Eén
    bronbestand in de repo, geen tweede binair icoon erbij en geen nieuwe
    dependency — in lijn met `scripts/make-tray-icon.js`.
  - `author: Studio Bo` in `package.json` vult meteen `CompanyName`/copyright
    in de exe-metadata (rcedit), dus dat was functioneel en niet alleen
    cosmetisch.
- Actions:
  - `assets/icon.ico` → `assets/icon.png` (inhoud onveranderd);
    `package.json`: `author` + `build.win.icon: assets/icon.png`.
  - Validatie: build naar een tijdelijke output-dir → géén
    `default Electron icon is used`-waarschuwing meer; icoon uit `Chronicle.exe`
    én uit de installer getrokken met `[System.Drawing.Icon]::ExtractAssociatedIcon`
    en visueel gecontroleerd (donker embleem, transparante hoek).
  - Open: `assets/build.win.ico` is een duplicaat van `assets/icon.png` (nog
    untracked) en wordt wél meegepakt in `app.asar`; weggooien scheelt ~1,2 MB.
    De gegenereerde ico heeft één entry (256×256); 16/32 px worden door Windows
    geschaald — een multi-res ico zou de taakbalk scherper maken.
  - `release/` is nog niet ververst: OpenChamber (pid 28712) houdt een handle op
    de oude `release/win-unpacked/resources/app.asar`, waardoor electron-builder
    stopt met `remove … Het proces heeft geen toegang tot het bestand`. Venster
    sluiten of herstarten en daarna `npx vite build && npm run build`.

## 2026-10-12 (Main-process-modules ontbraken in de installer)

- Findings: de geïnstalleerde app (`%LOCALAPPDATA%\Programs\chronicle-ai-archive`)
  crasht direct met een dialoog: `Uncaught Exception: Error: Cannot find module
  './services/ingest-listener'`. Oorzaak: `build.files` bevatte alleen
  `index.html`, `dist/**`, `electron-main.js`, `electron-preload.js`,
  `.env.local` en `assets/**`, terwijl `electron-main.js` bij het opstarten
  `./services/ingest-listener` en `./utils/*.cjs` requiret. De oude asar had dan
  ook nul entries onder `services/` en geen enkel project-`.cjs` — de eerdere
  verificatie keek alleen of `.env.local` meeging en miste dit.
- Conclusions:
  - De renderer is één Vite-bundle, maar de main process laadt zijn eigen
    modules lazy met `require`, dus alles wat daar aangeroepen wordt hoort
    expliciet in `files`.
  - `utils/*.cjs` (en niet `utils/**/*`): alleen de door esbuild gegenereerde
    CommonJS-bestanden zijn runtime nodig, de TypeScript-bron hoeft niet mee.
    `services/geminiService.ts` blijft dus buiten de build — die is renderer-zijde
    en zit al in de bundle.
  - Zo'n fout is alleen in een gepackte app te zien, niet in dev: daar wijzen de
    paden naar de repo.
- Actions:
  - `package.json` → `build.files`: `services/ingest-listener.js` en
    `utils/*.cjs` toegevoegd.
  - Validatie: asar bevat nu `\services\ingest-listener.js`,
    `\utils\captureIngest.cjs`, `\utils\claudeExportZip.cjs`,
    `\utils\sourceParsers.cjs`; de build uit een tijdelijke output-dir gestart en
    die kwam schoon op (`[Chronicle] PostgreSQL Schema verified.` +
    `Ingest listener on http://127.0.0.1:4580`), daarna afgesloten.
  - Open: de bestaande installatie moet opnieuw geïnstalleerd worden; en voor
    een Foundation-URL/token in de gepackte app kun je `foundation.local.json`
    in `%APPDATA%\chronicle-ai-archive\` zetten (staat in de zoeklijst van
    `loadFoundationConfigFile`).

## 2026-10-12 (userData naar Local op Windows)

- Findings: Electron zet `userData` standaard in `%APPDATA%` (Roaming). Daar
  stond bij Chronicle vrijwel alleen wegwerp-Chromium-cache: 6,3 MB `Cache`,
  1,6 MB `GPUCache` en 1,1 MB Dawn-caches tegen 16 KB `Local Storage` en 80 KB
  `source-blobs`. De Electron-docs waarschuwen juist dat `userData` in sommige
  omgevingen naar cloudopslag wordt geback-upt en dat er geen grote bestanden in
  horen; Roaming is ook het profiel dat in een domeinomgeving meeroamt. Niets
  van wat Chronicle daar bewaart (caches, blob-mirror, localStorage-kopie van
  het archief) is profielgebonden.
- Conclusions:
  - Op Windows hoort `userData` in `%LOCALAPPDATA%`, gezet met `app.setPath`
    vóór de ready-fase: alle latere `app.getPath('userData')`-aanroepen
    (`foundation.local.json`, `source-blobs`) resolven daarna automatisch daar.
  - De mapnaam wordt uit de bestaande `userData` gehaald (`path.basename`) in
    plaats van uit `app.getName()`, zodat een latere `productName`-wijziging de
    map niet stil verplaatst.
  - Verhuizing is één `rename` (zelfde volume, dus verplaatsen en niet kopiëren)
    met `cpSync` als terugval; in die terugval blijft de oude map staan, zodat er
    nooit data verdwijnt als het verplaatsen halverwege faalt.
  - Daarna `mkdirSync`, want `app.setPath` weigert een pad dat nog niet bestaat
    (het maakt de map zelf niet aan) — bij een verse installatie is de
    Local-map er immers nog niet.
  - macOS en Linux blijven onaangeroerd: daar is het standaardpad al lokaal.
- Actions:
  - `electron-main.js`: `useLocalUserData()` direct na de `require`s en vóór
    alles wat `userData` leest.
  - Validatie: `node --check` ok; gepackte build gestart → stdout
    `[Chronicle] userData moved to C:\Users\bojan\AppData\Local\chronicle-ai-archive`,
    daarna `PostgreSQL Schema verified` en de ingest listener op 4580. Na
    afloop: Local-map met 70 bestanden (8 blobs, gelijk aan ervoor) en
    `%APPDATA%\chronicle-ai-archive` verdwenen.
  - Open: `foundation.local.json` hoort nu in
    `%LOCALAPPDATA%\chronicle-ai-archive\` (die regel hierboven is daarmee
    achterhaald); `CHRONICLE_BLOBS_DIR` blijft als override werken.

## 2026-10-16 (Browserplugin: meldingen verplaatsbaar + inklapbaar)

- Findings: de hele plugin-UI bestond uit twee los gepositioneerde knoppen,
  allebei hardcoded rechtsonder (`normalize.js`: export op `bottom:20px;
  right:20px`, bulk op `bottom:56px; right:20px`). Wie daar last van had kon
  niets verplaatsen, en er was geen manier om de knoppen weg te leggen. Bo vroeg
  (a) een optie voor de plek waar de plugin-meldingen staan en (b) een optie om
  ze in te klappen.
- Conclusions:
  - Eén container `#chronicle-ui` (fixed, `flex-direction: column`) met de
    knoppen erin, in plaats van twee onafhankelijk gepositioneerde knoppen: nu
    is er precies één plek die de hoek kent, en "ingeklapt" is niets meer dan
    de kinderen verbergen — de toggle blijft dan als handvat staan.
  - De knoppen zelf krijgen geen `position/offset` meer; dat verhuist naar de
    container. De inline look (kleuren, font, schaduw, `zIndex: 9999`) is
    gelijkgetrokken in één `BUTTON_STYLE`, zodat de twee knoppen niet meer
    uiteen kunnen lopen.
  - Voorkeuren naast `baseUrl`/`token` in `chrome.storage.local`
    (`uiCorner`, `uiCollapsed`) en na het injecteren live toegepast via
    `chrome.storage.onChanged`: de optiepagina hoeft geen gesprekstab te
    herladen — dat was de belangrijkste eis, want herladen betekent een nieuw
    gesprek en dus verlies van de auto-capture-baseline.
  - Standaardhoek rechtsonder + uitgeklapt is bewust exact het oude gedrag; een
    onbekende/ontbrekende `uiCorner` valt op dezelfde waarde terug.
  - De toggle staat op de hoek zelf (`insertBefore(button, toggle)`, toggle als
    laatste kind) zodat een ingeklapte plugin precies staat waar de knoppen
    stonden. Hij schrijft dezelfde `uiCollapsed`-sleutel weg, dus de keuze
    overleeft een herstart.
  - Geen nieuwe permissie nodig: `storage` zat al in het manifest.
- Actions:
  - `plugin/content/normalize.js`: `UI_CORNERS`/`DEFAULT_CORNER`, `uiState`,
    `ensurePanel()` (container + toggle), `layoutPanel()` (hoek + inklappen),
    `setCollapsed()`, `applyStoredPreferences()`, `loadUiPreferences()`
    (storage-get + onChanged-listener); `makeButton`/`makeBulkButton` appendden
    nu in de container; `setCollapsed` staat op `window.__chronicleUI`.
  - `plugin/options/options.html` + `options.js`: keuzelijst "Waar staan de
    meldingen van de plugin?" (4 hoeken) en checkbox "Meldingen standaard
    ingeklapt tonen"; beide laden/opslaan met de bestaande Opslaan-knop.
  - `plugin/manifest.json`: versie 0.3.0 → 0.4.0.
  - `plugin/README.md`: stap 5 gecorrigeerd + nieuwe sectie "Meldingen en
    positie"; `options/`-regel in "Bouwvorm" bijgewerkt.
  - Validatie: `node --check` op `normalize.js`/`options.js` ok, manifest-JSON
    parseert. Daarna een tijdelijke harness (`plugin/__ui-harness.local.html`,
    daarna verwijderd) die `chrome.storage` stubt, `normalize.js` laadt en de
    knoppen aanmaakt; via een statisch Node-servertje op 127.0.0.1 en Playwright
    op 1280x800 gemeten: default rechtsonder (panel `right: 1260`,
    `bottom: 780` = viewport − 20), `top-left` → `left/top: 20`,
    onzin-waarde valt terug op rechtsonder, inklappen via het handvat verbergt
    beide knoppen (`display: none`) en schrijft `{uiCollapsed:true}`
    respectievelijk `{uiCollapsed:false}` bij uitklappen, en een
    storage-wijziging naar `bottom-left` + ingeklapt herpositioneert de
    container live naar `left: 20, bottom: 780`. Geen console-fouten
    (alleen een favicon-404 van de harness-server).
  - Open: niet getest in een echte provider-tab met de extensie geladen; de
    provider-scripts zijn ongemoeid, dus die controle is een `chrome://extensions`
    → herladen → één gesprek openen.
## 2026-10-16 (build-and-start.cmd + start.cmd)

- Findings: Chronicle-Gaia is een Electron/Vite-app (geen Tauri); `npm start` doet al `vite build && electron .`, terwijl `npm run build` een volledige electron-builder-installer maakt (te zwaar voor even herstarten).
- Conclusions: `build-and-start.cmd` gebruikt `npm start`; `start.cmd` start alleen Electron op de bestaande `dist`, met melding als die ontbreekt.
- Actions: `build-and-start.cmd` en `start.cmd` (nieuw); validated: niet uitgevoerd.

## 2026-10-18 (start.cmd herzien + start-fast.cmd)

- Findings: `npm start` (= `vite build && electron .`) houdt het consolevenster open zolang Electron draait, doordat Electron een kindproces van cmd blijft. Opnieuw bouwen terwijl er niets veranderd is kost onnodig tijd; de bestaande `start.cmd` (commit f8d3e3e) startte al zonder rebuild.
- Conclusions: `start.cmd` bouwt zichtbaar (`vite build`) en start Electron daarna losgekoppeld (`start "" "node_modules\electron\dist\electron.exe" .`) zodat het consolevenster direct sluit; `start-fast.cmd` slaat de rebuild over en is de snelle variant, met een melding als `dist\index.html` ontbreekt. `build-and-start.cmd` blijft ongewijzigd op `npm start`.
- Actions: `start.cmd` herschreven, `start-fast.cmd` (nieuw); validated: `vite build` gedraaid (✓ built in 1.28s), het Electron-deel niet runtime getest.

## 2026-10-18 (settings naar config.json)

- Findings: settings (thema, AI-provider, model, minimizeToTray, profiel) stonden alleen in de localStorage van het Chromium-profiel — niet leesbaar, niet te back-uppen, en een blob van een oudere build miste velden die later zijn toegevoegd (zoals `minimizeToTray`), waardoor een instelling niet leek te blijven hangen.
- Conclusions: in native modus is `config.json` in de userData-map (`%LOCALAPPDATA%\chronicle-ai-archive\config.json`) de bron van waarheid, gelezen en geschreven door de main-process via IPC. Wat nog in localStorage staat wordt eenmalig overgezet naar het bestand en daarna verwijderd, zodat de twee nooit uit elkaar kunnen lopen. Ingelezen waarden worden over `DEFAULT_SETTINGS` gemerged, zodat een bestand van een oudere build automatisch de nieuwe velden krijgt. In de browser (`npm run dev`) blijft localStorage in gebruik.
- Actions: `electron-main.js` (`SETTINGS_FILE`, `readSettingsFile`/`writeSettingsFile` met tmp-bestand + rename, IPC `load-settings`/`save-settings`), `electron-preload.js` (`loadSettings`/`saveSettings`), `App.tsx` (types, init met migratie, sync-effect schrijft naar het bestand); validated: `node --check` op beide JS-bestanden, `vite build` ✓, `vitest run` 95 tests groen; migratie runtime bevestigd (de oude localStorage-blob met `minimizeToTray: true` stond na de eerste start in `config.json`).

## 2026-10-18 (settings: opstart-race overschreef config.json)

- Findings: bij de tweede start kwam `minimizeToTray` terug als `false`. Diagnose met tijdelijke `[Chronicle][diag]`-logs in de IPC-handlers liet de volgorde zien: `save-settings tray=false` (defaults) → `load-settings` (leest het zojuist overschreven bestand) → `save-settings`. De mount-effect schreef dus de defaults weg vóórdat de renderer het bestaande bestand gelezen had, waardoor er nooit iets onthouden werd. In de browser viel dit niet op: daar leest de init-effect localStorage synchroon (geen await) vóór de save-effect. De eerste run leek te werken doordat de migratietak het bestand daarna nog een keer met de oude waarden vulde.
- Conclusions: opslaan mag pas gebeuren als de instellingen van deze sessie geladen zijn — `settingsLoadedRef` (useRef) blokkeert de save-effect tot `initApp` klaar is. Het bestand wordt daarna expliciet één keer geschreven, zodat het ook op een vers profiel meteen bestaat (de save-effect zou daar niet afgaan omdat de settings-referentie niet wijzigt).
- Actions: `App.tsx` (`settingsLoadedRef`, guard in de settings-effect, `useRef`-import, expliciete `saveSettings` in `initApp` na het laden); validated: met een handmatig gevuld `config.json` (`userName: "LoadTest"`, `minimizeToTray: true`) een volledige start/stop gedaan — de log toont `load-settings` mét die waarden vóór elke `save-settings`, en het bestand stond na afloop nog steeds op `LoadTest`/`true`. Daarna diag-logs verwijderd, opnieuw `vite build` ✓ en 95 tests groen, en `config.json` teruggezet op de echte waarden.
- Open: de app heeft geen `app.requestSingleInstanceLock()`, dus twee instanties kunnen naast elkaar draaien en elkaars `config.json` overschrijven (laatste wint). Niet aangepast — dat is een gedragsbeslissing, geen bugfix.

## 2026-10-18 (één instantie per machine)

- Findings: er was geen single-instance lock. Een tweede start gaf dus een tweede venster dat hetzelfde `config.json` overschrijft, dezelfde PostgreSQL-database gebruikt en de ingest-poort niet kan binden (bij het testen luisterde de eerste instantie al op `http://127.0.0.1:4580`).
- Conclusions: `app.requestSingleInstanceLock()` direct na `useLocalUserData()` en vóór alle andere setup; een tweede start krijgt de lock niet en doet meteen `app.quit()`. De draaiende kopie krijgt het `second-instance`-event en haalt het venster naar voren via de bestaande `showMainWindow()` — die herstelt ook een geminimaliseerd of naar het systeemvak verborgen venster. Daar is een `[Chronicle]`-logregel bijgezet, zodat een overdracht in de log terug te vinden is.
- Actions: `electron-main.js` (lock, `second-instance`-handler, logregel); validated: instantie A gestart (4 processen: main + helpers), daarna een tweede start met `node_modules\.bin\electron.cmd .` — die ging na 436 ms uit met exit 0 en het aantal processen bleef 4, en A's log bevatte `[Chronicle] Second launch handed over to the running window.` (precies 1×). Het naar voren halen van het venster zelf is niet visueel gecontroleerd; dat is dezelfde `showMainWindow()` die de tray al gebruikt.

## 2026-10-18 (kruisje kan naar het systeemvak)

- Findings: de tray-optie dekte alleen minimaliseren — op het kruisje sloot Chronicle altijd af. Twee dingen kwamen er tijdens het testen bij: (a) de `settingsLoadedRef`-guard uit de vorige entry blokkeerde de mount-effect, en omdat de tray-keuzes in diezelfde effect werden doorgegeven, bereikten ze de main-process nooit op een vers profiel (daar blijft de settings-referentie gelijk, dus de effect ging niet nog eens af); (b) een `config.json` met een UTF-8 BOM (wat PowerShell en Windows-editors ervoor schrijven) werd door `JSON.parse` geweigerd, waarna de renderer zijn defaults over het bestand heen schreef — de instellingen verdwenen dan stil.
- Conclusions: nieuwe instelling `closeToTray` die alléén meetelt zolang `minimizeToTray` aan staat (zonder pictogram is een verborgen venster niet terug te halen), en die in de UI alleen verschijnt als het systeemvak aan staat. De main-process onderscheidt een echt afsluiten via `app.isQuitting` — gezet door `before-quit` en het tray-menu — zodat Quit, `app.quit()` en het afsluiten van de machine altijd doorwerken; alleen het kruisje verbergt. Het doorgeven van bestand én tray-keuzes zit nu in één helper (`pushSettingsToMain`), gebruikt door `initApp` én de effect, zodat die twee niet uit elkaar kunnen lopen. `set-minimize-to-tray` is vervangen door één `set-tray-options` met beide keuzes. `readSettingsFile` negeert een BOM en bewaart een onleesbaar bestand als `config.json.invalid`.
- Actions: `types.ts` (`closeToTray`), `App.tsx` (`DEFAULT_SETTINGS`, `pushSettingsToMain`, effect teruggebracht tot één regel), `electron-preload.js` (`setTrayOptions`), `electron-main.js` (`closeToTray`, `setTrayOptions`, `close`-handler, `before-quit`, BOM/invalid-afhandeling), `components/SettingsModal.tsx` (tweede toggle onder "Minimize to tray"); validated: `node --check` op beide JS-bestanden, `vite build` ✓, 95 tests groen, en twee end-to-end runs waarin `PostMessage(WM_CLOSE)` op het venster precies het kruisje nabootst — met `closeToTray` aan bleven 4 processen draaien met 0 zichtbare vensters (dus verborgen, niet afgesloten), met `closeToTray` uit gingen alle processen weg (dus echt afgesloten); `config.json` hield in beide runs de waarden die erin stonden.

## 2026-10-18 (Evernote-achtige vormgeving)

- Findings: de UI voelde zwaar en rommelig: een brede topbalk met vijf knoppen, een 560px brede lijst vol dikke omrande kaarten met hoofdletter-microlabels, een enorme titel (`text-6xl`) in de viewer, en een Tailwind-lettergrootteschaal (`xs` 0.95rem, `sm` 1.2rem) die alles opblies.
- Conclusions: layout naar het Evernote-voorbeeld — links een navigatiebalk (merk, Note-knop, Insights / Knowledge Base / Power Search / Neural Map, Settings onderaan), in het midden een vlakke notitielijst op de achtergrond, rechts de editor als afgeronde witte kaart. Alle bestaande kleuren (warm-beige, paper, sandstone, sage-green, terracotta, #394239) zijn behouden; alleen verhoudingen, randen en typografie zijn aangepast. Geen logica of dependency gewijzigd.
- Actions: `App.tsx` (topbalk vervangen door `<nav>`, views in afgeronde panelen, `PencilIcon` import), `components/Sidebar.tsx` (breedte 380, transparante kolom, pill-zoekveld, ronde tag-chips, "N notes found"), `components/ChatCard.tsx` (vlakke rijen met scheidingslijn, titel/samenvatting/bron+tags/datum), `components/ChatViewer.tsx` (titel `text-3xl/4xl`, lichtere kop), `index.html` (kleinere lettergrootteschaal, beige achtergrond, scrollbar); validated: `vite build` ✓, 95 tests groen. Niet visueel in Electron bekeken.

## 2026-10-18 (geselecteerde tags in de viewer)

- Findings: de tags bovenaan een chat zijn klikbaar (ze openen het gerelateerde-tags-paneel), maar de actieve selectie was niet zichtbaar.
- Conclusions: geselecteerde tags krijgen terracotta met witte tekst, zoals de tags in de lijst al deden; hover geeft een terracotta rand. `activeRelatedTags` werd al aan de viewer doorgegeven.
- Actions: `components/ChatViewer.tsx` (tag-knop klasse); validated: 95 tests groen.

## 2026-10-18 (abstract leesbaar in dark mode)

- Findings: in dark mode stond de abstract-tekst (`text-stone-400`) op een lichtgrijze achtergrond (`bg-slate-50/50` zonder dark-variant) — onleesbaar. De tag-knoppen hadden ook geen dark-kleuren.
- Conclusions: de kaart krijgt een donkere achtergrond en rand in dark mode, de tekst wordt lichter (`stone-200`); tags krijgen een lichtere sage/amber tint.
- Actions: `components/ChatViewer.tsx` (abstract-kaart, samenvattingstekst, tag-knoppen); validated: 95 tests groen. Niet visueel gecontroleerd.

## 2026-10-18 (hover-iconen zichtbaar in dark mode)

- Findings: de Edit/Archive-knoppen (en andere icoonknoppen) kregen bij hover `text-earth-dark` — bijna zwart op de donkere achtergrond, dus het icoon verdween.
- Conclusions: overal waar `hover:text-earth-dark` zonder dark-variant stond, is `dark:hover:text-white` toegevoegd.
- Actions: `App.tsx` en `components/*.tsx` (11 plekken, o.a. ChatViewer-knoppen, Sidebar-typeschakelaar, modals); validated: 95 tests groen. Niet visueel gecontroleerd.

## 2026-10-18 (kleinere knoppen, minder ronding)

- Findings: knoppen waren groot (`px-8 py-5`, `py-3/py-4`, zware schaduwen) en de afrondingen extreem (`rounded-[2.5rem]`, `rounded-2xl/3xl`).
- Conclusions: de radius-schaal is centraal verlaagd in de Tailwind-config (xl 0.375rem, 2xl 0.5rem, 3xl 0.625rem; `full` blijft voor pills/cirkels), arbitrary waarden zijn `rounded-xl` geworden, en knoppen zijn compacter met lichtere schaduwen.
- Actions: `index.html` (borderRadius), `App.tsx` en `components/*.tsx` (knop-padding, schaduw, arbitrary radii, dashboard-knoppen); validated: `vite build` ✓, 95 tests groen. Niet visueel gecontroleerd.

## 2026-10-18 (blauwe tinten vervangen door natuurlijke tinten)

- Findings: de blauwachtige dark-mode (dashboard, kaarten, knoppen) kwam van de Tailwind `slate`-klassen (koud blauwgrijs), plus enkele `blue-*`-accenten.
- Conclusions: in plaats van tientallen klassen te herschrijven is de `slate`-schaal in de Tailwind-config vervangen door de warme `stone`-waarden, en `blue` door een sage-groene schaal; zo blijft alle bestaande markup werken en past de kleur bij de rest van het palet. De bronkleuren in de Neural Map (Gemini blauw e.d.) zijn bewust gelaten als herkenning, alleen de twee grijsblauwe zijn warm gemaakt.
- Actions: `index.html` (colors.slate, colors.blue), `components/MindMap.tsx` (2 hex-waarden); validated: geen testwijzigingen nodig. Niet visueel gecontroleerd.

## 2026-10-18 (Quit in het menu)

- Findings: met close-to-tray aan verbergt het kruisje alleen het venster; afsluiten kon alleen via het tray-menu.
- Conclusions: Quit-item onder Settings in de linker navigatie, via nieuw IPC-kanaal `quit-app` dat `app.isQuitting` zet vóór `app.quit()` — zelfde mechanisme als het tray-menu, dus de close-handler houdt de afsluiting niet tegen. Alleen zichtbaar in Electron.
- Actions: `electron-main.js` (`quit-app`), `electron-preload.js` (`quitApp`), `App.tsx` (type + knop); validated: `node --check`, `vite build` ✓. Niet end-to-end gestart.

## 2026-10-18 (Neural Map efficiënter)

- Findings: met 586 chats was de kaart zwaar. (1) Links werden over alle paren gebouwd (O(n²)); omdat bijna elke chat de tag `imported` heeft (534×) ontstonden ~140k links, die elk frame werden getekend én als veer werden berekend. (2) Afstoting vergeleek elk paar per frame (O(n²)). (3) De simulatie en tekenlus draaiden voor altijd, ook als alles stil lag, en de lus werd bij elke hover/zoom/pan opnieuw aangemaakt. (4) Per node een schaduw (`shadowBlur`) en een gradient per frame. (5) De startspiraal groeide lineair (radius 15·i), dus nodes begonnen tot ~9000px uit elkaar. (6) De kaart was `fixed inset-0` en overdekte daardoor de nieuwe navigatie.
- Conclusions: links via een omgekeerde tag-index; tags die op >15% van de chats zitten (min. 10) tellen niet mee omdat ze niets zeggen, en per node blijven de 6 sterkste links over. Afstoting via een ruimtelijk raster (alleen naburige cellen, cutoff 300px waar de kracht al verwaarloosbaar is). Simulatie slaapt zodra de gemiddelde snelheid² < 0.02 en wordt wakker bij slepen; getekend wordt alleen bij beweging of een wijziging van zoom/pan/hover/selectie (view-state via refs, geen herstart van de lus). Gewone nodes worden per kleur in één pad getekend zonder schaduw/gradient; de gedetailleerde weergave blijft voor geselecteerd, hover en ingezoomd (k>1). Culling van nodes/links buiten beeld. Hover zet state alleen bij een echte wijziging. Gouden-hoek-spiraal met radius 30·√i. De kaart is nu `absolute` binnen het paneel zodat de navigatie zichtbaar blijft.
- Actions: `components/MindMap.tsx` herschreven (zelfde UI en gedrag, kleine opruiming van radius/schaduwen); validated: `vite build` ✓, 95 tests groen. De framesnelheid en lay-out zijn niet gemeten of visueel bekeken in Electron.

## 2026-10-18 (Neural Map: direct schakelen met laadindicator)

- Findings: na een klik op Neural Map duurde het even voordat er iets zichtbaar werd. Twee oorzaken: de kaart werd via `AnalyticsDashboard` gerenderd, dat eerst alle dashboardstatistieken berekende (regex-split over de inhoud van elke chat) voordat het naar de MindMap doorschakelde; en de graaf werd synchroon opgebouwd tijdens de eerste render.
- Conclusions: `App.tsx` rendert de MindMap nu rechtstreeks (zelfde gedrag: een chat openen vanuit de kaart zet `returnToMindMap`), zodat het dashboard niet meer meedraait. De MindMap toont meteen een overlay met spinner ("Neural map opbouwen…") en bouwt de graaf 30 ms later op, na de eerste paint.
- Actions: `App.tsx` (import + mindmap-branch), `components/MindMap.tsx` (`ready`-state, uitgestelde opbouw, overlay); validated: `vite build` ✓, 95 tests groen. Niet gemeten of visueel bekeken.

## 2026-10-18 (Neural Map op sigma.js / WebGL)

- Findings: de canvas-versie met eigen physics werd bij duizenden chats een bottleneck; er komen er duizenden bij. Bovendien is een eigen tekenlaag minder fraai en minder uitbreidbaar.
- Conclusions: overstap op sigma.js (WebGL) met graphology als graafstructuur en ForceAtlas2 in een Web Worker voor de indeling, zodat de UI bediend kan blijven tijdens het indelen. Bewust sigma 3 gekozen (stabiele, goed gedocumenteerde API) en niet de net verschenen v4, die een nieuw styles/primitives-systeem heeft. Nieuwe dependencies (met jouw akkoord): `sigma@3`, `graphology`, `graphology-layout-forceatlas2`. De tag-linklogica is verhuisd naar een pure, geteste functie (`utils/neuralGraph.ts`): omgekeerde tag-index, tags op >15% van de chats worden genegeerd, kleine tags krijgen alle paren, grote tags (>40) een beperkt aantal verbindingen met vaste offsets (voorkomt members² paren en een kettingvorm), en per chat blijven de 6 sterkste verbindingen over. De layout stopt vanzelf na 4–20 s (schaalt met aantal nodes) en kan met de knop "Opnieuw indelen" herstart worden. Hover/selectie benadrukt een node en zijn buren (rest gedimd, labels alleen daarvan); labels van de rest verschijnen pas bij inzoomen. Nodes zijn sleepbaar (gepind voor de layout tijdens het slepen). De "Open Chat"-kaart staat nu vast linksonder in plaats van aan de node. De laadindicator uit de vorige stap blijft.
- Actions: `package.json`/`package-lock.json` (3 dependencies), `components/MindMap.tsx` (herschreven op sigma), `utils/neuralGraph.ts` + `utils/neuralGraph.test.ts` (4 tests); validated: `vite build` ✓, 99 tests groen, en een echte run in de browser met 3000 gegenereerde chats: spinner binnen 10 ms zichtbaar, 3000 nodes + 12.600 verbindingen gerenderd, ForceAtlas2-worker verplaatst de nodes, 60 fps, geen consolefouten, en klik/hover/klik-op-achtergrond (via sigma-events) toont en sluit de popup. Niet getest: slepen en zoomen met echte muis (het testvenster liet geen betrouwbare coördinaten toe), en niet in Electron zelf.

## 2026-10-18 (Gemini: gebruikersbeurt stond dubbel in het archief)

- Findings: bij Gemini-gesprekken stond elke gebruikersbeurt dubbel ("Ja" werd "Ja Ja", "Hoe dan" werd "Hoe dan Hoe dan"). Bo's live DOM (console-digest, want de plugin-DOM is alleen met zijn eigen login te zien) laat de oorzaak zien: `.query-text` bevat naast de zichtbare `p.query-text-line`'s een `<h5 class="cdk-visually-hidden screen-reader-user-query-label">You said <hele prompt></h5>` — het schermlezer-label herhaalt de prompt, en `textContent` van de bubbel wordt dus "You said Ja  Ja". Daar kwam een tweede fout bovenop: `innerTextWithCodeFences` las `clone.innerText` van een *losse* knoop, en een knoop die niet gerenderd wordt valt volgens de spec terug op `textContent`. In Chromium nagemeten: `clone.innerText === clone.textContent` (dus geen newlines tussen blokken — een prompt van dertien regels werd één regel, en Bo's tellingen lieten 13 `.query-text-line`s in één bubbel zien), `visibility: hidden` maakt innerText zelfs helemaal leeg, en offscreen `position: fixed; left: -99999px` geeft wél de echte innerText.
- Conclusions: a11y-only knopen (`.cdk-visually-hidden`, `.screen-reader-user-query-label`, `.sr-only`, `.visually-hidden`) gaan uit de kloon vóór het lezen, en de kloon hangt tijdens het lezen even renderbaar maar buiten beeld in de pagina (bewust géén `visibility: hidden`). `pre` → markdown-fences blijft ongewijzigd; beide leesacties vallen terug op `textContent` als `innerText` geen string is, zodat de helper ook in jsdom (vitest) werkt — jsdom kent `innerText` niet, dus zonder die terugval zou de helper in tests niets opleveren. `cleanText` in `gemini.js` blijft staan als vangnet, maar is na deze fix een no-op voor de label-strip.
- Actions: `plugin/content/normalize.js` (`A11Y_ONLY`, renderhost, innerText/textContent-terugval in `innerTextWithCodeFences`), nieuw `plugin/content/normalize.test.ts` (label eruit, codefences intact, geen host in de pagina), `plugin/README.md` bijgewerkt. validated: `node --check` ✓, `npx vitest run` 102 tests groen ✓, en in echte Chromium (Playwright) met Bo's `outerHTML`-fragment: "Hoe dan" komt er één keer uit, multiline-prompts houden hun newlines en een codeblok blijft heel. Nog van Bo nodig: extensie herladen en een Gemini-gesprek opnieuw exporteren — bestaande rijen in het archief bevatten de verdubbeling nog, en een nieuwe levering is door de dedup een update.

## 2026-10-23 (Plugin: afbeeldingen én bestanden mee, Foundation krijgt ze ook)

- Findings: de plugin stuurde alleen tekst. Bestanden en afbeeldingen uit een gesprek kwamen niet mee, en Foundation's `chat`-contract accepteert ze wél (`attachments: attachmentArray`). De blokkade zat aan de Chronicle-kant: de plugin-whitelist (`plugin/service-worker.js`, `utils/captureIngest.ts`) weigerde `attachments`, `buildChatIngestPayload` kreeg ze nooit, en de listener schreef `assets: []`. Base64-inline was geen optie: de chat-body is op 5 MB begrensd en Postgres hoort geen bytes te dragen.
- Conclusions: bytes en verwijzingen gescheiden. De content scripts leveren per bestand een *referentie* (providerFileId/url/naam/type/grootte), de service worker haalt de bytes op (die heeft de host-permissies en de sessie-cookies; een content script is CORS-gebonden) en POST ze naar een nieuwe `POST /ingest/attachment`. De listener spiegelt de bytes content-addressed in `userData/source-blobs/<sha256>` (dezelfde store als de bronbestanden, dus dedup is gratis) en uploadt dezelfde bytes naar Foundation; de chat gaat pas daarna, met alleen `{id, filename, mimeType, size, url}`. Foundation's 25 MB-limiet is één-op-één overgenomen: een groter bestand wordt niet lokaal bewaard als Foundation het niet kan hebben — dat is precies de drift die `source-blobs` wil voorkomen. Wat niet op te halen is, wordt een `attachmentGaps`-record op de chat (archief-only, nooit naar Foundation): een gesprek mag niet doen alsof het een bestand heeft dat er niet is. Herlevering van een gegroeid gesprek uploadt niet opnieuw: de blob-meta bewaart het Foundation-id, en de SW cachet referentie→attachment. `handleIngestChat` telt nieuwe attachment-ids als een echte wijziging, anders zou een bestaand gesprek dat later bijlagen krijgt voorgoed als duplicate gelden.
- Conclusions per provider: ChatGPT is de bewezen route (`metadata.attachments` + `file-service://`-pointers, bytes via `/backend-api/files/{id}/download` met bearer). Claude probeert de originele bytes op `/api/organizations/{org}/files/{uuid}/{contents,download,preview}`; lukt dat niet, dan wordt `extracted_content` bewaard als `<naam>-tekstextractie.txt` — de naam zegt zelf dat het een uittreksel is, en de extractie wordt bewust niet gecachet zodat een volgende levering het origineel opnieuw probeert. Gemini en Mistral zijn best-effort: Gemini via DOM-afbeeldingen en `googleusercontent`-links, Mistral via onbekende tRPC-chunks (alleen objecten met een http(s)-download-URL). Lokale weergave loopt via een nieuw `chronicle-asset://blob/<sha256>`-protocol in plaats van base64 in de rij; afbeeldingen komen in `assets` (bestaande galerij), de rest in een bijlagenlijst in `ChatViewer` met de gaps er zichtbaar onder. Geen cap per chat (afspraak), dus de bulk-knop kan veel schijf gebruiken — de blob-store dedupliceert identieke bytes, wat het grootste deel daarvan opvangt.
- Actions: `utils/captureIngest.ts` (+tests), `services/ingest-listener.js` (attachment-endpoint, blob-meta, dedup op nieuwe bijlagen), `electron-main.js` (asset-protocol, `mirrorBlob` doorgegeven), `plugin/service-worker.js` (resolutie/upload/cache), `plugin/content/normalize.js` (helpers, buildConversation), `chatgpt.js`, `claude.js`, `gemini.js`, `mistral.js`, `plugin/manifest.json` (0.5.0 + CDN-hostpermissies), `types.ts`, `components/ChatViewer.tsx`; validated: `npm run build:parsers` ✓, `node --check` op alle gewijzigde scripts ✓, `npx vite build` ✓, `npx vitest run` 114 tests groen ✓. Niet gevalideerd (vereist een echte sessie): de Claude-downloadroute, Gemini-bestandschips, de Mistral-chunkvorm, en de end-to-end levering in Electron/Chromium.

## 2026-10-23 (Bijlage zonder Foundation: lokaal bewaren in plaats van verliezen)

- Findings: bij de eerste test bleek de listener de bytes al gespiegeld te hebben vóór de upload naar Foundation, maar bij een mislukte upload gaf `/ingest/attachment` een 502 terug. De service worker maakte daar een gap van: het bestand stond dus wél op schijf, maar zonder verwijzing in de chat — functioneel een gemiste bijlage, en de spiegel werd wees. Bij Bo liep Foundation niet (alleen Chronicle's ingest-poort 4580 stond open), dus dit zou meteen de eerste ervaring zijn.
- Conclusions: de volgorde lokaal-eerst is goed, de foutafhandeling was het probleem. Een mislukte upload levert nu een **lokaal-only** bijlage op met id `local:<sha256>`, status 201, en `foundationPending` in de blob-meta; de download werkt via `chronicle-asset://` en in de viewer staat "alleen lokaal". Dat id mag Foundation nooit zien (het zou een 404-link op `/api/attachments/local:…` opleveren), dus `normalizeAttachments` in `utils/foundationCapture.ts` filtert de prefix eruit — dezelfde regel als bij gaps: geen verzonnen bijlagen naar Foundation. Aanvullen gebeurt bij de eerstvolgende levering van dezelfde bytes: de SW cachet een lokaal-only attachment bewust niet (net als een tekstextractie), de listener ziet dat de meta geen `foundation.id` heeft en uploadt alsnog; het nieuwe id verschilt van het oude, en omdat nieuwe attachment-ids als wijziging tellen werkt de rij zichzelf bij. De 25 MB-grens blijft onverkort weigeren (413, geen spiegel): daar is de byteshoeveelheid het probleem, niet de bereikbaarheid.
- Actions: `services/ingest-listener.js` (`LOCAL_ATTACHMENT_PREFIX`, `patchBlobMeta`, lokaal-only antwoord bij uploadfout), `plugin/service-worker.js` (niet cachen bij `foundationPending`/`local:`), `utils/foundationCapture.ts` (prefix eruit + nieuwe test), `components/ChatViewer.tsx` ("alleen lokaal"). validated: `node --check` ✓, `npx vitest run` 115 tests groen ✓, `npx vite build` ✓, en een smoke-test van `handleIngestAttachment` met een nagebootste blob-store: Foundation onbereikbaar → 201 met `local:`-id en `foundationPending` in meta; Foundation daarna up met dezelfde bytes → 201 met echt id en pending gewist; derde levering → 200 `reused` zonder tweede upload.

## 2026-10-23 (Gegenereerde ChatGPT-foto's: sediment-pointers)

- Findings: zelf meegestuurde bijlagen kwamen mee, maar een gegenereerde foto niet — zonder foutmelding. De API levert die als `image_asset_pointer` met `sediment://file_…`, en `attachmentsFromApi` herkende alleen `file-service://`; sediment werd expliciet overgeslagen ("heeft een andere route"). De DOM-fallback draaide alleen als de API-read mislukte, dus er kwam helemaal geen verwijzing: geen bijlage én geen gap. `/backend-api/files/{id}/download` is de route voor geüploade bestanden en kent de sediment-opslag niet.
- Conclusions: voor een gegenereerde foto is de `<img>` in het bericht de enige weg naar de bytes. Daarom tellen sediment-pointers nu als verwijzing én koppelt de content script elke verwijzing aan de CDN-url van de afbeelding met hetzelfde file-id (`/backend-api/estuary/content?id=file_…` of `files.oaiusercontent.com/file-…`); een afbeelding zonder API-pointer wordt toegevoegd. De SW probeert bij een `file_`-id het download-endpoint niet eerst (dat geeft toch 404) maar pakt de CDN-url met credentials. Naam wordt `chatgpt-afbeelding-<id>`, en `uploadAttachment` plakt de extensie eraan als de naam er geen heeft — anders stond er "attachment" zonder type in de lijst. Twee referenties kunnen op dezelfde bytes uitkomen (API-pointer én DOM-url); de blob dedupliceert dat al, maar de chat zou het bestand dubbel tonen, dus `resolveAttachments` dedupliceert op het resulterende id.
- Actions: `plugin/content/chatgpt.js` (`fileIdFromUrl`, `domImageRefs`, `withDomImages`, sediment in `attachmentsFromApi`, `attachmentsFromDom` hergebruikt dezelfde selectie), `plugin/service-worker.js` (`fetchChatGptFile` met sediment-tak en CDN-fallback, extensie in `uploadAttachment`, dedupe in `resolveAttachments`), `plugin/manifest.json` 0.5.1. validated: `node --check` ✓, `npx vitest run` 115 groen ✓. Niet gevalideerd: een echte ChatGPT-sessie (moet van Bo komen). Bulk-export heeft geen DOM van de andere gesprekken, dus daar blijft een gegenereerde foto een gap.

## 2026-10-23 (Winterkat: tool-call-JSON en de dedup die een gap opat)

- Findings: van het gesprek "Afbeelding winterkat" stond in het archief als assistenttekst de ruwe DALL-E-tool-call (`{"size":"1024x1024","n":1,"prompt":"Create a…`), met `attachments: []` en `gaps: []`. Meting in de pagina gaf de echte vorm: de foto zit in een **`tool`-bericht** met `content_type: multimodal_text` en `asset_pointer: sediment://file_…` (2,4 MB), en alle `<img>` in `main` zijn **`blob:`-URL's** — mijn DOM-vangnet filterde die weg omdat de service worker ze niet kan ophalen, wat waar is, maar het content script kan het wél. Daarnaast: `messageText` viel terug op `content.text` voor `code`-inhoud, en de dedup vergeleek alleen contenthash en attachment-ids, niet de gaps — een tweede export waarin de download alsnog mislukte werd dus stil als duplicate weggegooid.
- Conclusions: de JSON hoort niet in een transcript, dus `messageText` doet `content.text` alleen nog bij `text`/`multimodal_text` (en zonder content_type). Gegenereerde afbeeldingen krijgen de titel die ChatGPT zelf meegaf (`metadata.image_gen_title`) als bestandsnaam en `size_bytes` als grootte — beter dan een id. De dedup vergelijkt nu ook de gap-lijst: een mislukte download is een uitkomst die je wilt kunnen herzien, en zonder die vergelijking zou dezelfde fout voorgoed verborgen blijven.
- Actions: `plugin/content/chatgpt.js` (`messageText`, `attachmentsFromApi`), `services/ingest-listener.js` (dedup met `existingGaps`/`hasNewGaps`). validated: `node --check` ✓, `npx vitest run` 115 groen ✓. Nog open: de bytesroute voor `sediment://` (estuary zonder signature of `/backend-api/files/{id}/download`) — wordt in de pagina gemeten voordat er iets gebouwd wordt.

## 2026-10-23 (Gegenereerde foto's: blob in de pagina uitlezen)

- Findings: de serverroute is definitief dood. Meting in de pagina op `GET /backend-api/estuary/content?id=file_…&p=fs&ts=<epoch>`: **403** (json, 45 bytes) — er is dus wél een signature nodig; de eerdere 422 was alleen de parameter-validatie die vóór de auth-check afgaat. `p=blob` en `p=file_store` geven 422 (ongeldige waarde), dus `fs` is de enige optie en zonder `sig` kom je niet verder. Wél goud: de `blob:`-afbeelding in de pagina is **2405280 bytes**, exact gelijk aan `size_bytes` van de sediment-pointer. De `alt`-tekst is generiek ("Gegenereerde afbeelding 1"), dus koppelen op naam kan niet; koppelen op bytegrootte kan wél.
- Conclusions: de bytes moeten uit de pagina komen, want alleen daar leeft de blob (`fetch(blobUrl)` in het content script; de service worker kan dat niet). Het content script leest de blob, zet hem als base64 in de ref (`dataBase64`), de SW decodeert en POST naar `/ingest/attachment` — de rest van de pijp (blob-store, Foundation, `assets`) blijft ongewijzigd. Koppeling ref→blob gebeurt **strikt op `size_bytes`**: een verwijzing zonder grootte krijgt géén blob, want de eerste vrije pakken zou het verkeerde bestand opleveren. Base64 mag nooit in de retry-queue of in de chatpayload belanden (storage-quotum en de 5 MB-grens): `enqueue` stript het, en het foutpad van `deliver` post het niet. Bij een retry wordt die bijlage dan een gap — eerlijk, en de tekst blijft behouden.
- Actions: `plugin/content/normalize.js` (`attachmentRef` accepteert `dataBase64`), `plugin/content/chatgpt.js` (blob-vlag in `domImageRefs`, `blobBytes` met blokgewijze base64-conversie, `inlineBlobImages`, `attachmentsFromDom` async en leest blobs direct uit), `plugin/service-worker.js` (inline decode in `fetchAttachment`, `withoutInlineBytes` in `enqueue` en in het foutpad van `deliver`), `plugin/manifest.json` 0.5.2. validated: `node --check` ✓, `npx vitest run` 115 groen ✓, `npx vite build` ✓. Niet gevalideerd: of het content script de blob onder de pagina-CSP mag fetchen (console mocht het; zo niet, dan is canvas→dataURL de fallback). Bulk blijft gaps: daar is geen DOM.
