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
