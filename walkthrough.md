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
