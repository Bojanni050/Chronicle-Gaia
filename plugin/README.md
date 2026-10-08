# Chronicle Chat Exporter (browserplugin)

Chrome-extensie (MV3) die het huidige gesprek op **claude.ai** en **chatgpt.com**
met één klik aflevert bij Chronicle — niet rechtstreeks bij Foundation. Chronicle
is de deur: de listener schrijft de archiefkopie in de eigen `chats`-tabel en
forwardt dezelfde raw velden automatisch naar Foundation's Ingestie Gateway
(`POST /api/ingest/chat`, `source: "chronicle-capture"`).

```
plugin (content script)  →  service worker (token + retry-queue)
        →  Chronicle ingest listener (127.0.0.1:4580, POST /ingest/chat)
              →  archiefkopie (Postgres)  +  forward naar Foundation
```

## Installeren (lokaal, "Load unpacked")

1. Start Chronicle (de listener start automatisch met de app, op
   `http://127.0.0.1:4580`, uitsluitend loopback).
2. Bepaal het ingest-token — de listener resolvet in deze volgorde:
   - `CHRONICLE_INGEST_TOKEN` (env)
   - `ingestToken` in `foundation.local.json`
   - de gedeelde Foundation-token (fallback)
3. Chrome → `chrome://extensions` → *Developer mode* → *Load unpacked* →
   kies de map `plugin/` uit deze repo.
4. Open de opties van de extensie: zet de listener-URL
   (standaard `http://127.0.0.1:4580`) en het token.
5. Ga naar een gesprek op claude.ai of chatgpt.com en klik rechtsonder
   op **→ Chronicle**.

## Automatische capture (fase 3)

Naast de knoppen draait er nu een automatische capture: het script
`content/intercept.js` draait in de MAIN world (vanaf document_start) en
wikkelt `window.fetch` in. Het antwoordt géén inhoud — het seint alleen
*"dit gesprek is net bijgewerkt"*:

- claude.ai: na een volledig uitgelezen `POST …/chat_conversations/{uuid}/completion`
- chatgpt.com: na een `POST /backend-api/conversation`

Het provider-script (isolated world) hoort het signaal via
`window.postMessage`, wacht 1,5s (debounce — een antwoord arriveert in
vele kleine reads), haalt het gesprek dan op via de normale bewezen
API-route en levert het af zoals de knop dat doet. Herlevering is veilig:
de listener dedupt op URL/contentHash, dus een signaal te veel is hooguit
`duplicate`, nooit een dubbele rij. Elke gegroeide versie van een gesprek
komt automatisch in Chronicle (en via de forward in Foundation) terecht.

De knoppen blijven: handmatig forceren en bulk blijven nuttig voor
gesprekken van vóór de installatie en voor situaties waarin de
interceptor een endpoint-wijziging niet overleeft.

## Bulk-export

De tweede knop — **⇊ Alles naar Chronicle** (onder de gewone knop) — haalt de
volledige gesprekkenlijst op via de interne API van de provider (alle pagina's)
en levert elk gesprek af alsof je de gewone knop gebruikte. De listener dedupt
per levering, dus een bulk-run is idempotent: tweede keer draaien geeft overal
`duplicate` (of `update` bij gegroeide gesprekken) en levert niets nieuws.

- Claude: `GET /api/organizations/{org}/chat_conversations` (cursor-paginering)
- ChatGPT: `GET /backend-api/conversations` (offset-paginering)
- Voortgang staat op de knop: `⇊ 12/140 • nieuw 12 • bijgewerkt 0 • bekend 0`
- Eén onbereikbaar gesprek breekt de run niet; mislukte leveringen worden
  apart geteld (en transport-fouten gaan in de retry-queue, zoals altijd)

## Knop-statussen

| Weergave | Betekenis |
|---|---|
| `✓ In Chronicle` | 201 — nieuw in het archief, doorgestuurd naar Foundation |
| `✓ Bijgewerkt` | 200 — gegroeid gesprek, rij bijgewerkt en opnieuw doorgestuurd |
| `✓ Al bekend` | 200 — identieke inhoud, dedup heeft hem geslikt (geen dubbele levering) |
| `⏳ In wachtrij` | Chronicle onbereikbaar — de service worker bewaart de levering en spoelt de wachtrij door bij herstart |
| `✗ …` | 4xx — het antwoord van de listener (bijv. een typeward-422), leesbaar teruggezet op de knop |

## Bouwvorm

- `manifest.json` — MV3, host-permissies alleen `claude.ai`, `chatgpt.com`
  en `127.0.0.1`.
- `service-worker.js` — de enige plek met het token; client-side typeward
  (server-owned velden worden al in de plugin geweigerd, vóór verzending)
  en een retry-queue die alleen transport-fouten bewaart (4xx is definitief
  en wordt niet eindeloos herhaald).
- `content/claude.js` — haalt het gesprek via de interne API van claude.ai
  (`/api/organizations/{org}/chat_conversations/{uuid}`), DOM-fallback erachter.
  *(Let op: géén ES-modules — MV3 content scripts worden als gewone scripts
  geïnjecteerd; `normalize.js` laadt vóór de providers en hangt zijn helpers
  op `window.__chronicleUI`.)*
- `content/chatgpt.js` — haalt het gesprek via `/backend-api/conversation/{id}`
  (mapping-tree → geordende turns, zelfde regels als `utils/sourceParsers.ts`),
  DOM-fallback erachter.
- `content/normalize.js` — gedeelde knop + statusfeedback + de
  ParsedConversation-whitelist.
- `options/` — listener-URL + token (`chrome.storage.local`).
- **Toolbar-knop** — het extensie-icoon in de werkbalk triggert dezelfde export
  op het actieve tab (handig als de zwevende knop door site-CSS wordt bedekt).

## Contract

De plugin verstuurt uitsluitend de raw velden die de listener accepteert:
`content`, `turns`, `title`, `url`, `sourceProvider`, `occurredAt`. Server-owned
velden (`status`, `providerConversationId`, `contentHash`, `id`, ...) worden
aan de plugin-kant én de listener-kant geweigerd — hetzelfde typeward-beleid
als Foundation's `ingestPolicy.js`. De conversation-URL is first-class: zonder
`url` heeft een levering geen dedup-identiteit.

## Aandachtspunten

- Beide providerscripts gebruiken de **interne** API's van Anthropic/OpenAI;
  die kunnen wijzigen. De DOM-fallback vangt dat op, maar kan afwijken in
  detailvorming (bijlagen, artifacts). Controleer na een site-update even of
  de turns compleet zijn.
- De org-id van claude.ai wordt uit `localStorage.lastActiveOrg` gelezen; als
  een installatie een andere sleutel gebruikt, valt de knop terug op de DOM.
- De automatische "elke API-call onderscheppen"-variant is bewust **niet**
  gebouwd; deze knop-versie is robuuster en volstaat voor de
  acceptance-test van de pijp (bouwen in fases).
