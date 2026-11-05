# Chronicle-fork van obsidian-clipper

Dit is een `--depth 1`-clone van [obsidianmd/obsidian-clipper](https://github.com/obsidianmd/obsidian-clipper)
(MIT-licentie), met alleen de save-stap omgebouwd naar Chronicle in plaats van Obsidian.
De content-extractie (Defuddle, inclusief `flatten-shadow-dom.js`), de popup-UI, templates,
highlighter en reader-mode zijn onaangeroerd — dat was precies het punt: hun extractie is
rijper dan wat `plugin/content/webclip.js` zelf doet.

## Wat is gewijzigd

- **`src/utils/chronicle-note-creator.ts`** (nieuw) — `saveToChronicle(fileContent, noteName, url)`
  POST't naar Chronicle's lokale ingest-listener (`{chronicleUrl}/ingest/chat`), met dezelfde
  payload-vorm (`content`, `title`, `url`, `sourceProvider: 'web'`, `occurredAt`) als
  `plugin/service-worker.js` al gebruikt. Analoog aan `saveToObsidian()` in
  `src/utils/obsidian-note-creator.ts`, die ongewijzigd is gebleven.
- **`src/utils/chronicle-connection.ts`** (nieuw) — haalt URL én ingest-token op bij de app
  via `GET /ingest/config` (nieuw endpoint in `services/ingest-listener.js`). Het token wordt
  bewust **niet** bewaard: `general_settings` staat in `storage.sync`, en een ingest-token is
  per machine. De verbinding leeft in het geheugen van de extensie; na een 401 (app herstart
  met een nieuw token) wordt de cache gewist en volgt één retry.
- **`src/core/popup.ts`** — `handleClipObsidian()` roept nu `saveToChronicle(...)` i.p.v.
  `saveToObsidian(...)`. Vault/pad/behavior (Obsidian-vaultconcepten) blijven in de UI staan
  maar worden niet meer gebruikt voor de aflevering zelf — alleen voor `incrementStat`
  (de ingebouwde gebruiksstatistieken, verder ongemoeid). CLI-fouten komen nu in een
  inline regel (`#clip-status`) i.p.v. de popup te vervangen door "failed to save file",
  zodat een niet-draaiende app of een 4xx leesbaar is en de knop bruikbaar blijft.
- **`src/types/types.ts`, `src/utils/storage-utils.ts`, `src/utils/cli-stubs.ts`** —
  één nieuwe setting: `chronicleUrl` (default `http://127.0.0.1:4580`). Geen
  `chronicleToken` meer in de settings.
- **`src/settings.html`, `src/managers/general-settings.ts`** — een "Chronicle"-sectie met
  een URL-veld, een statusregel en een knop **Test verbinding**. De status wordt bij het
  openen van de instellingen automatisch gepeild.
- **`src/manifest.chrome.json`** — naam/omschrijving/versie aangepast zodat de extensie
  herkenbaar is naast de bestaande "Chronicle Chat Exporter" (`plugin/`); permissies
  ongewijzigd.

## Niet gewijzigd (bewust)

- Alle content-extractie, templates, highlighter, reader-mode, i18n-strings ("Add to Obsidian"
  in de UI staat dus nog letterlijk zo) — puur cosmetisch, functioneel onveranderd.
- `host_permissions: ["<all_urls>", ...]` — deze extensie draait (anders dan `plugin/`'s
  activeTab-aanpak) een altijd-geladen content script op elke pagina (voor highlighter/reader
  mode). Dat is een bewust bredere permissie-voetafdruk dan de minimale aanpak in
  `plugin/content/webclip.js` — een expliciete trade-off voor de rijkere extractie.

## Build

```
cd clipper
npm install
npm run build:chrome   # -> clipper/dist/ en clipper/builds/*.zip
```

Laad `clipper/dist/` als "Uitgepakte extensie" via `chrome://extensions`. Verdere configuratie
is niet nodig: de extensie vraagt de listener-URL en het ingest-token zelf op bij de draaiende
Chronicle-app (`GET /ingest/config`). Draait de app niet, dan zegt de popup dat bij de knop.
De Chronicle-sectie in de extensie-instellingen toont de verbindingsstatus en heeft een knop
**Test verbinding**; alleen de URL is handmatig aan te passen (voor een afwijkende poort).

`GET /ingest/config` is bewust smal: alleen loopback-Host (`127.0.0.1`, `localhost`, `::1`),
alleen een browser-extensie-Origin, en nooit een CORS-header. Een webpagina kan het antwoord
dus niet lezen; een ander lokaal proces kan dat wel — net als het `foundation.local.json` op
deze machine. Zonder dat endpoint zou de gebruiker het token alsnog met de hand moeten plakken.

De manifestversie is `1.7.1.2` (Chrome accepteert alleen 1–4 puntgescheiden integers; de
eerdere `1.7.1-chronicle.1` zou bij het laden geweigerd zijn).

## Bekende afwijking buiten deze fork

`npx vitest run` faalt op 9 testbestanden met `Cannot find package 'webextension-polyfill'`,
terwijl het package wél in `node_modules` staat en de echte `webpack`-build het probleemloos
oplost. Dit is een Vite/Vitest-resolutiequirk van de upstream-testinfrastructuur, niet iets
dat door deze fork is veroorzaakt — de 139 individuele tests die wél draaiden, slaagden
allemaal.
