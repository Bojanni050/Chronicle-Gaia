# Walkthrough (vervolg)

`walkthrough.md` is bij 1021 regels afgesloten; dit bestand gaat chronologisch verder.

## 2026-10-23 (Blobmatch: ook zonder sediment-pointer)

- Findings: 0.5.7 in de pagina gaf nog steeds `geen passende blob` voor zes van de twaalf bijlagen, en de volgorde-fallback vuurde niet. De namen van die zes (`Grunge Lookbook in Drieluik`, `Industriële triptiek…`, `Gespiegelde straatmode…`) komen uit `metadata.image_gen_title` en zijn dus gegenereerd, maar hun `asset_pointer` is kennelijk `file-service://` in plaats van `sediment://`. Mijn `generated`-vlag hing alleen aan het pointer-schema, dus deze foto's kwamen nooit in de derde trap. Dat was een aanname die één gesprek lang klopte en daarna niet meer.
- Conclusions: `generated` afleiden uit twee onafhankelijke signalen — de pointer (`sediment://`) én de aanwezigheid van `image_gen_title`. Daarnaast een vierde trap: staan er evenveel onopgeloste verwijzingen als vrije blobs in de pagina, dan is volgorde het enige resterende signaal en is de juiste bytes met een kleine kans op verwisseling beter dan een lege bijlage. De logregel noemt nu per verwijzing ook de pixelmaat en het pointersoort, zodat een volgende meting zonder extra code duidelijk maakt welke trap waarom faalde.
- Actions: `plugin/content/chatgpt.js` (`generated` ook bij `image_gen_title`, `pointerKind`, trap 4 `volgorde-alle`, uitgebreidere diagnostiek), `plugin/manifest.json` 0.5.8, nieuw `walkthrough2.md`. validated: `node --check` ✓, `npx vitest run` 118 groen ✓. Vereist: extensie herladen én Chronicle herstarten (de listener met `hasNewPlacement` draait pas na een herstart).
