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
- **`src/core/popup.ts`** — `handleClipObsidian()` roept nu `saveToChronicle(...)` i.p.v.
  `saveToObsidian(...)`. Vault/pad/behavior (Obsidian-vaultconcepten) blijven in de UI staan
  maar worden niet meer gebruikt voor de aflevering zelf — alleen voor `incrementStat`
  (de ingebouwde gebruiksstatistieken, verder ongemoeid).
- **`src/types/types.ts`, `src/utils/storage-utils.ts`, `src/utils/cli-stubs.ts`** —
  twee nieuwe settings: `chronicleUrl` (default `http://127.0.0.1:4580`) en `chronicleToken`
  (leeg; moet overeenkomen met Chronicle's `CHRONICLE_INGEST_TOKEN` / `foundation.local.json`).
- **`src/settings.html`, `src/managers/general-settings.ts`** — een "Chronicle"-sectie met
  twee tekstvelden (URL + token) boven de Vaults-sectie, met dezelfde auto-save als de rest
  van het formulier.
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

Laad `clipper/dist/` als "Uitgepakte extensie" via `chrome://extensions`. Stel daarna in de
extensie-instellingen de Chronicle-URL (standaard `http://127.0.0.1:4580`) en het ingest-token
in — zonder token wordt elke clip geweigerd met "Geen Chronicle-token ingesteld".

## Bekende afwijking buiten deze fork

`npx vitest run` faalt op 9 testbestanden met `Cannot find package 'webextension-polyfill'`,
terwijl het package wél in `node_modules` staat en de echte `webpack`-build het probleemloos
oplost. Dit is een Vite/Vitest-resolutiequirk van de upstream-testinfrastructuur, niet iets
dat door deze fork is veroorzaakt — de 139 individuele tests die wél draaiden, slaagden
allemaal.
