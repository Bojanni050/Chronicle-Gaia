#!/usr/bin/env node
/**
 * Chronicle export-watcher — de officiële Claude-export automatisch de pijp in.
 *
 * Claude's officiële data-export (Settings → Export data) levert een ZIP met
 * conversations.json — exact het formaat dat utils/sourceParsers.ts al leest
 * via de UploadModal. Deze watcher maakt die handmatige import-loop overbodig:
 * hij bewaakt een map, herkent een nieuwe export (ZIP óf los
 * conversations.json), parsed de gesprekken met dezelfde parsers als de app,
 * en levert ze af bij de ingest listener (POST /ingest/chat) — dezelfde pijp
 * als de browserplugin: dedup, archiefkopie, forward naar Foundation.
 *
 * Gebruik:
 *   node scripts/watch-exports.js [map]        # default: ./claude-exports
 *
 * Config (omgeving):
 *   CHRONICLE_INGEST_URL    default http://127.0.0.1:4580
 *   CHRONICLE_INGEST_TOKEN  hetzelfde token als de plugin (of ingestToken)
 *   CHRONICLE_WATCH_ONCE    "1" = één scan en stop (voor een cron/scheduled task)
 *
 * Herhaalde levering is veilig: de listener dedupt op URL/contentHash, dus
 * dezelfde export nogmaals droppen levert overal duplicate/update op.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WATCH_DIR = process.argv[2] || path.join(process.cwd(), 'claude-exports');
const INGEST_URL = (process.env.CHRONICLE_INGEST_URL || 'http://127.0.0.1:4580').replace(/\/$/, '');

/**
 * Token-resolutie, dezelfde volgorde als de listener (services/ingest-listener.js):
 *   1. CHRONICLE_INGEST_TOKEN (env)
 *   2. ingestToken in foundation.local.json (repo-root of naast dit script)
 *   3. token in foundation.local.json (de gedeelde Foundation-token)
 */
function resolveToken() {
  if (process.env.CHRONICLE_INGEST_TOKEN) return process.env.CHRONICLE_INGEST_TOKEN;
  const candidates = [
    path.join(__dirname, '..', 'foundation.local.json'),
    path.join(process.cwd(), 'foundation.local.json'),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed.ingestToken === 'string' && parsed.ingestToken.trim()) return parsed.ingestToken.trim();
      if (parsed && typeof parsed.token === 'string' && parsed.token.trim()) return parsed.token.trim();
    } catch {
      // afwezig of onleesbaar — volgende kandidaat
    }
  }
  return '';
}

const TOKEN = resolveToken();
const ONCE = process.env.CHRONICLE_WATCH_ONCE === '1';

const { parseClaudeExport, parseConversationJson, parseMarkdownTranscript } = require('../utils/sourceParsers.cjs');

/** Bestanden die al verwerkt zijn, gemarkeerd met een bijrijgend .done-bestand. */
function isProcessed(file) {
  return fs.existsSync(file + '.chronicle-done');
}

function markProcessed(file) {
  fs.writeFileSync(file + '.chronicle-done', new Date().toISOString());
}

function readZipJsonEntries(zipPath) {
  // Node heeft geen ingebouwde ZIP-reader; we gebruiken dezelfde aanpak als
  // de UploadModal: een ZIP is een bestandsarchief — hier wordt hij via een
  // losse unzip gestreamd naar een tijdelijke map. Bestaat unzip niet, dan
  // valt de watcher terug op losse JSON/MD-bestanden (de eerlijke fout).
  const os = require('os');
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-export-'));
  try {
    execFileSync('unzip', ['-o', zipPath, '-d', tmp], { stdio: 'ignore' });
  } catch {
    console.error(`[watch-exports] kan ${path.basename(zipPath)} niet uitpakken — is 'unzip' geïnstalleerd?`);
    fs.rmSync(tmp, { recursive: true, force: true });
    return [];
  }
  const entries = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else entries.push(full);
    }
  };
  walk(tmp);
  return { files: entries, tmp };
}

/** Parst één exportbestand naar ParsedConversation[] (API-vorm van de parsers). */
function parseExportFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return [];
    }
    if (Array.isArray(json) || Array.isArray(json.conversations)) {
      return parseClaudeExport(json);
    }
    const single = parseConversationJson(json);
    return single ? [single] : [];
  }
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
    const conv = parseMarkdownTranscript(fs.readFileSync(filePath, 'utf8'));
    return conv ? [conv] : [];
  }
  return [];
}

async function deliver(conversation) {
  const response = await fetch(`${INGEST_URL}/ingest/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(conversation),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, ok: response.ok, action: body.action, error: body.error };
}

async function processFile(file) {
  let targets = [{ file, tmp: null }];
  if (path.extname(file).toLowerCase() === '.zip') {
    const unzipped = readZipJsonEntries(file);
    if (!unzipped.files) return;
    targets = unzipped.files
      .filter((f) => ['.json', '.md', '.markdown', '.txt'].includes(path.extname(f).toLowerCase()))
      .map((f) => ({ file: f, tmp: unzipped.tmp }));
    if (!targets.length) {
      console.log(`[watch-exports] ${path.basename(file)}: geen herkende bestanden in de ZIP`);
      markProcessed(file);
      if (unzipped.tmp) fs.rmSync(unzipped.tmp, { recursive: true, force: true });
      return;
    }
  }

  let created = 0;
  let updated = 0;
  let duplicates = 0;
  let failed = 0;
  for (const target of targets) {
    const conversations = parseExportFile(target.file);
    for (const conv of conversations) {
      try {
        const result = await deliver(conv);
        if (result.ok && result.action === 'create') created++;
        else if (result.ok && result.action === 'update') updated++;
        else if (result.ok && result.action === 'duplicate') duplicates++;
        else {
          failed++;
          console.error(`[watch-exports] levering mislukt (${result.status}): ${result.error || ''}`);
        }
      } catch (err) {
        failed++;
        console.error(`[watch-exports] listener onbereikbaar: ${err.message}`);
      }
    }
  }
  console.log(
    `[watch-exports] ${path.basename(file)}: nieuw ${created}, bijgewerkt ${updated}, actueel ${duplicates}${failed ? ', mislukt ' + failed : ''}`
  );
  markProcessed(file);
  for (const t of targets) {
    if (t.tmp) fs.rmSync(t.tmp, { recursive: true, force: true });
  }
}

async function scan() {
  if (!fs.existsSync(WATCH_DIR)) {
    fs.mkdirSync(WATCH_DIR, { recursive: true });
    console.log(`[watch-exports] map aangemaakt: ${WATCH_DIR}`);
    console.log('[watch-exports] drop hier de officiële export (ZIP of conversations.json) — alles landt automatisch in Chronicle.');
    return;
  }
  const files = fs
    .readdirSync(WATCH_DIR)
    .map((name) => path.join(WATCH_DIR, name))
    .filter((f) => fs.statSync(f).isFile() && !f.endsWith('.chronicle-done') && !f.endsWith('.chronicle-done.chronicle-done'));
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!['.zip', '.json', '.md', '.markdown', '.txt'].includes(ext)) continue;
    if (isProcessed(file)) continue;
    await processFile(file);
  }
}

async function main() {
  if (!TOKEN) {
    console.error('[watch-exports] geen token — zet CHRONICLE_INGEST_TOKEN (zelfde token als de listener/plugin)');
    process.exit(1);
  }
  await scan();
  if (ONCE) return;
  console.log(`[watch-exports] bewaak ${WATCH_DIR} (Ctrl+C om te stoppen)`);
  fs.watch(WATCH_DIR, { persistent: true }, () => {
    scan().catch((err) => console.error('[watch-exports] scanfout:', err.message));
  });
}

main().catch((err) => {
  console.error('[watch-exports] onherstelbaar:', err.message);
  process.exit(1);
});
