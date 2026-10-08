
const { app, BrowserWindow, ipcMain, shell, dialog, Notification } = require('electron');
const { startIngestListener } = require('./services/ingest-listener');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/ai_chat_archive';

// Initialize PostgreSQL Pool
const pool = new Pool({ connectionString: DATABASE_URL });

// ── Foundation capture connection ────────────────────────────────────────────
// Chronicle's single connection to Gaia: POST a raw chat to Foundation's
// Ingestie Gateway (POST /api/ingest/chat). This lives in the main process,
// not the renderer, for two reasons:
//   - Foundation's CORS/CSRF guard only allows localhost/127.0.0.1 and
//     chrome-extension origins; a file:// renderer sends `Origin: null` (403).
//   - the Bearer token never has to touch the renderer.
//
// Config resolution (URL and token), highest priority first:
//   1. environment: FOUNDATION_URL / FOUNDATION_TOKEN / FOUNDATION_TOKEN_FILE
//   2. a gitignored `foundation.local.json` ({ "url": "...", "token": "..." })
//      next to the app, or in the userData dir
//   3. the sibling Foundation checkout's server/data/token.txt (local dev)
//   4. the loopback default for the URL
const DEFAULT_FOUNDATION_URL = `http://127.0.0.1:${process.env.CHRONICLE_PORT || 4577}`;

function loadFoundationConfigFile() {
  const candidates = [
    process.env.FOUNDATION_CONFIG_FILE,
    path.join(__dirname, 'foundation.local.json'),
    path.join(app.getPath('userData'), 'foundation.local.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Absent, unreadable or malformed — try the next candidate.
    }
  }
  return {};
}

function readTokenFile(file) {
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

// ── Local source-file copy (Chronicle's byte-for-byte mirror) ────────────────
// Foundation owns the original; Chronicle keeps an identical copy so the two
// can never drift (see Gaia-Documentation/capture-chronicle.md). The copy is
// content-addressed by sha256 exactly like Foundation's store, so the hashes
// are directly comparable and a mirror is provably identical.
const crypto = require('crypto');

function chronicleBlobsDir() {
  return process.env.CHRONICLE_BLOBS_DIR || path.join(app.getPath('userData'), 'source-blobs');
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Writes a local mirror of the source file. Add-only: identical bytes reuse. */
function putLocalBlob(buffer, { filename, mimeType } = {}) {
  const hash = sha256Hex(buffer);
  const dir = path.join(chronicleBlobsDir(), hash.slice(0, 2), hash);
  const metaPath = path.join(dir, 'meta.json');
  if (fs.existsSync(metaPath)) {
    return { ...JSON.parse(fs.readFileSync(metaPath, 'utf8')), reused: true };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'content'), buffer, { flag: 'wx' });
  const meta = {
    hash,
    size: buffer.length,
    filename: filename ? path.basename(filename) : null,
    mimeType: mimeType || 'application/octet-stream',
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  return { ...meta, reused: false };
}

/**
 * Resolves the Foundation URL and Bearer token. Returns
 * `{ url, token, tokenError }`; a null token is reported honestly to the
 * caller instead of sending an unauthenticated request.
 */
function resolveFoundationConfig() {
  const file = loadFoundationConfigFile();
  const url = process.env.FOUNDATION_URL || file.url || DEFAULT_FOUNDATION_URL;

  let token = process.env.FOUNDATION_TOKEN || (typeof file.token === 'string' ? file.token.trim() : null);
  if (!token) {
    const tokenFiles = [
      process.env.FOUNDATION_TOKEN_FILE,
      path.join(__dirname, '..', 'Foundation', 'server', 'data', 'token.txt'),
      path.join(app.getAppPath(), '..', 'Foundation', 'server', 'data', 'token.txt'),
    ].filter(Boolean);
    for (const filePath of tokenFiles) {
      token = readTokenFile(filePath);
      if (token) break;
    }
  }

  return { url, token };
}

// ── Gemini enrichment key ────────────────────────────────────────────────────
// The key must NEVER reach the renderer: a `process.env` reference there breaks
// (Vite doesn't define it) and any "fix" via define would bake it into the
// client bundle. So the key lives here and the Gemini calls are made from the
// main process, exactly like the Foundation token.
function loadEnvLocal() {
  const candidates = [
    path.join(__dirname, '.env.local'),
    path.join(app.getAppPath(), '.env.local'),
  ];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch {
      // absent — try the next candidate
    }
  }
}

function resolveGeminiKey() {
  if (!process.env.API_KEY) loadEnvLocal();
  return process.env.API_KEY || process.env.GEMINI_API_KEY || null;
}


let mainWindow;

/**
 * Ensures the target database exists before the app pool connects to it.
 * Connects to the default "postgres" maintenance database and creates the
 * target database if it is missing, so a fresh local PostgreSQL install works
 * on first launch without manual setup.
 */
async function ensureDatabaseExists() {
  const config = parseConnectionString(DATABASE_URL);
  const targetDatabase = config.database || 'postgres';
  const adminPool = new Pool({ ...config, database: 'postgres' });
  try {
    const result = await adminPool.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [targetDatabase]
    );
    if (result.rowCount === 0) {
      console.log(`[Chronicle] Database "${targetDatabase}" not found, creating it...`);
      await adminPool.query(`CREATE DATABASE "${targetDatabase.replace(/"/g, '""')}"`);
      console.log(`[Chronicle] Database "${targetDatabase}" created.`);
    }
  } finally {
    await adminPool.end();
  }
}

/**
 * Database Initialization for PostgreSQL
 */
async function initDatabase() {
  await ensureDatabaseExists();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Create core table with assets column
    await client.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        type TEXT DEFAULT 'chat',
        title TEXT,
        content TEXT,
        summary TEXT,
        tags JSONB,
        source TEXT,
        createdAt BIGINT,
        updatedAt BIGINT,
        fileName TEXT,
        embedding double precision[],
        assets JSONB DEFAULT '[]',
        capture JSONB,
        foundation JSONB,
        "sourceFile" JSONB,
        archived BOOLEAN DEFAULT FALSE,
        "contentHash" TEXT
      )
    `);

    // Create Links Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS links (
        id SERIAL PRIMARY KEY,
        from_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        to_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        link_type TEXT,
        created_at BIGINT,
        UNIQUE(from_id, to_id)
      )
    `);

    // Optimized Indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_chats_created_at ON chats(createdAt DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_chats_source ON chats(source)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_chats_type ON chats(type)');

    // Capture columns, added after the table already existed in the wild —
    // capture holds the raw fields for (re)sending to Foundation, foundation
    // holds the delivery status. Neither ever leaves the archive.
    await client.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS capture JSONB');
    await client.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS foundation JSONB');
    await client.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS "sourceFile" JSONB');
    await client.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE');
    await client.query('ALTER TABLE chats ADD COLUMN IF NOT EXISTS "contentHash" TEXT');

    await client.query('COMMIT');
    console.log('[Chronicle] PostgreSQL Schema verified.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Chronicle] DB Init Error:', err);
  } finally {
    client.release();
  }
}

// IPC Handlers
ipcMain.handle('save-database', async (event, items) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      await client.query(`
        INSERT INTO chats (id, type, title, content, summary, tags, source, createdAt, updatedAt, fileName, embedding, assets, capture, foundation, "sourceFile", archived, "contentHash")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        ON CONFLICT (id) DO UPDATE SET
          type = EXCLUDED.type,
          title = EXCLUDED.title,
          content = EXCLUDED.content,
          summary = EXCLUDED.summary,
          tags = EXCLUDED.tags,
          source = EXCLUDED.source,
          updatedAt = EXCLUDED.updatedAt,
          embedding = EXCLUDED.embedding,
          assets = EXCLUDED.assets,
          capture = EXCLUDED.capture,
          foundation = EXCLUDED.foundation,
          "sourceFile" = EXCLUDED."sourceFile",
          archived = EXCLUDED.archived,
          "contentHash" = EXCLUDED."contentHash"
      `, [
        item.id,
        item.type || 'chat',
        item.title,
        item.content,
        item.summary,
        JSON.stringify(item.tags),
        item.source,
        item.createdAt,
        item.updatedAt || item.createdAt,
        item.fileName,
        item.embedding,
        JSON.stringify(item.assets || []),
        item.capture ? JSON.stringify(item.capture) : null,
        item.foundation ? JSON.stringify(item.foundation) : null,
        item.sourceFile ? JSON.stringify(item.sourceFile) : null,
        !!item.archived,
        item.contentHash || null
      ]);
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Chronicle] Save Error:', err);
    return false;
  } finally {
    client.release();
  }
});

ipcMain.handle('load-database', async () => {
  try {
    const res = await pool.query('SELECT * FROM chats ORDER BY createdAt DESC');
    return res.rows.map(r => {
      const capture = typeof r.capture === 'string' ? JSON.parse(r.capture) : r.capture;
      // Reconcile the archive date. Rows imported before the "archive date =
      // conversation date" rule still carry the import time; capture.occurredAt
      // holds the real moment. Recompute so the archive matches the rule without
      // needing a re-import. Rows without a capture moment keep their stored
      // dates untouched (a hand-written note is "now", and stays that way).
      const occurredMs = capture && capture.occurredAt ? Date.parse(capture.occurredAt) : NaN;
      const reconciled = Number.isFinite(occurredMs);
      return {
        ...r,
        createdAt: reconciled ? occurredMs : Number(r.createdat),
        updatedAt: reconciled ? occurredMs : Number(r.updatedat),
        tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : r.tags,
        assets: typeof r.assets === 'string' ? JSON.parse(r.assets) : r.assets,
        capture,
        foundation: typeof r.foundation === 'string' ? JSON.parse(r.foundation) : r.foundation,
        sourceFile: typeof r.sourceFile === 'string' ? JSON.parse(r.sourceFile) : r.sourceFile,
        archived: r.archived === true || r.archived === 't',
        contentHash: r.contentHash,
        embedding: r.embedding
      };
    });
  } catch (err) {
    console.error('[Chronicle] Load Error:', err);
    return [];
  }
});

ipcMain.handle('load-links', async () => {
  try {
    const res = await pool.query('SELECT from_id, to_id, link_type, created_at FROM links');
    return res.rows.map(r => ({
      fromId: r.from_id,
      toId: r.to_id,
      type: r.link_type,
      createdAt: Number(r.created_at)
    }));
  } catch (err) {
    console.error('[Chronicle] Load Links Error:', err);
    return [];
  }
});

ipcMain.handle('add-link', async (event, { fromId, toId, type }) => {
  try {
    await pool.query(
      'INSERT INTO links (from_id, to_id, link_type, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (from_id, to_id) DO NOTHING',
      [fromId, toId, type || 'related', Date.now()]
    );
    return true;
  } catch (err) {
    console.error('[Chronicle] Add Link Error:', err);
    return false;
  }
});

ipcMain.handle('remove-link', async (event, { fromId, toId }) => {
  try {
    await pool.query(
      'DELETE FROM links WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)',
      [fromId, toId]
    );
    return true;
  } catch (err) {
    console.error('[Chronicle] Remove Link Error:', err);
    return false;
  }
});

ipcMain.handle('get-app-path', () => app.getAppPath());

ipcMain.handle('get-executable-path', () => app.getPath('exe'));

ipcMain.handle('export-chats', async (event, { chats, format }) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `chronicle-export.${format === 'csv' ? 'csv' : 'json'}`,
      filters: format === 'csv'
        ? [{ name: 'CSV', extensions: ['csv'] }]
        : [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) {
      return { success: false, cancelled: true };
    }
    let data;
    if (format === 'csv') {
      const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const headers = ['id', 'type', 'title', 'source', 'createdAt', 'updatedAt', 'summary', 'tags', 'content'];
      const rows = chats.map(c => [
        c.id, c.type, c.title, c.source, c.createdAt, c.updatedAt,
        c.summary, (c.tags || []).join('; '), c.content
      ].map(escape).join(','));
      data = [headers.join(','), ...rows].join('\n');
    } else {
      data = JSON.stringify(chats, null, 2);
    }
    fs.writeFileSync(result.filePath, data, 'utf-8');
    return { success: true, path: result.filePath };
  } catch (err) {
    console.error('[Chronicle] Export Error:', err);
    return { success: false, error: String(err) };
  }
});

ipcMain.handle('import-chats', async (event, existingIds) => {
  const { parseConversationJson, parseClaudeExport } = require('./utils/sourceParsers.cjs');
  const { isClaudeExportManifest, conversationsFromZip, conversationsFromManifest } = require('./utils/claudeExportZip.cjs');
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import chat exports',
      message: 'Pick a Claude manifest.json, its category .zip files, or a plain JSON/Markdown export.',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Chat Exports', extensions: ['json', 'md', 'txt', 'zip'] },
        { name: 'All Files', extensions: ['*'] },
      ]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, cancelled: true, chats: [], skipped: 0, missing: [] };
    }
    const existing = new Set(existingIds || []);
    const chats = [];
    const missing = [];
    let skipped = 0;

    for (const filePath of result.filePaths) {
      const fileName = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const stem = fileName.replace(/\.[^.]+$/, '');

      // A file may hold one conversation or many — a Claude export holds all.
      let parsed = [];
      let textHint = '';
      let isManifest = false;

      if (ext === '.zip') {
        // A category zip (e.g. conversations-000.zip) or an older all-in-one
        // export. Anything that is not conversations simply yields nothing.
        try {
          parsed = conversationsFromZip(filePath, parseClaudeExport);
        } catch (err) {
          console.error('[Chronicle] zip import failed:', fileName, err);
        }
      } else {
        textHint = fs.readFileSync(filePath, 'utf-8');
        if (ext === '.json') {
          try {
            const json = JSON.parse(textHint);
            if (isClaudeExportManifest(json)) {
              // The newer export: a manifest plus the category zips downloaded
              // next to it. Missing zips are reported, never silently ignored.
              isManifest = true;
              const res = conversationsFromManifest(filePath, json, parseClaudeExport);
              parsed = res.conversations;
              missing.push(...res.missing);
            } else {
              const claude = parseClaudeExport(json);
              parsed = claude.length > 0 ? claude : [parseConversationJson(json)].filter(Boolean);
            }
          } catch {
            parsed = [];
          }
        }
        // Anything that didn't parse as a structured conversation stays an opaque
        // text note (a plain export). A zip's binary never lands here.
        if (parsed.length === 0 && !isManifest) {
          parsed = [{ content: textHint, turns: [], title: stem, sourceProvider: guessSource(fileName, textHint).toLowerCase() }];
        }
      }

      let index = 1;
      for (const conv of parsed) {
        const label = parsed.length > 1 ? `${fileName} (${index})` : fileName;
        const id = `import-${Buffer.from(label).toString('base64').slice(0, 24)}`;
        index++;
        if (existing.has(id)) {
          skipped++;
          continue;
        }
        const source = conv.sourceProvider ? capitalize(conv.sourceProvider) : guessSource(fileName, textHint);
        chats.push({
          id,
          type: 'chat',
          title: conv.title || stem,
          content: conv.content,
          summary: conv.summary || '',
          tags: ['imported'],
          source,
          createdAt: conv.createdAt || Date.now(),
          updatedAt: conv.occurredAt || conv.createdAt || Date.now(),
          fileName: label,
          embedding: undefined,
          assets: [],
          capture: {
            sourceProvider: conv.sourceProvider || source.toLowerCase(),
            ...(conv.url ? { url: conv.url } : {}),
            ...(conv.occurredAt ? { occurredAt: new Date(conv.occurredAt).toISOString() } : {}),
            ...(conv.turns && conv.turns.length ? { turns: conv.turns } : {}),
          },
        });
      }
    }
    return { success: true, chats, skipped, missing };
  } catch (err) {
    console.error('[Chronicle] Import Error:', err);
    return { success: false, error: String(err), chats: [], skipped: 0, missing: [] };
  }
});

// Sends one already-built chat payload (utils/foundationCapture.ts) to
// Foundation. The renderer builds the payload; this side supplies the token
// and URL so no secret ever leaves the main process. Never throws — a capture
// failure is a value the caller stores as "not yet sent", not a crash.
ipcMain.handle('foundation-capture-chat', async (event, payload) => {
  const { url, token } = resolveFoundationConfig();
  if (!token) {
    return {
      ok: false,
      error: 'no Foundation token found — set FOUNDATION_TOKEN, add foundation.local.json, or start Foundation',
    };
  }
  try {
    const response = await fetch(`${url}/api/ingest/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      // 422 = contract violation (details: [...]), 401 = bad token, 500 = server.
      return {
        ok: false,
        status: response.status,
        error: body.error || `ingest failed with status ${response.status}`,
        details: body.details,
      };
    }
    return {
      ok: true,
      status: response.status, // 201 = new, 200 = upsert of a grown conversation
      id: body.id,
      insertedNew: body.insertedNew,
      providerConversationId: body.providerConversationId,
      ingestedAt: body.ingestedAt,
    };
  } catch (err) {
    console.error('[Chronicle] Foundation capture error:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

// Sends one source file to Foundation: mirrors it locally first (byte-for-byte,
// Chronicle's copy), then uploads the same bytes to Foundation (the owner).
// Returns both hashes so a mismatch is impossible to miss. Never throws.
ipcMain.handle('foundation-capture-source-file', async (event, { path: filePath, filename, mimeType } = {}) => {
  if (!filePath) return { ok: false, error: 'no source file path given' };
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, error: `cannot read source file: ${err.message}` };
  }
  const local = putLocalBlob(bytes, { filename: filename || filePath, mimeType });

  const { url, token } = resolveFoundationConfig();
  if (!token) {
    return { ok: false, hash: local.hash, size: local.size, error: 'no Foundation token found', mirrored: true };
  }
  try {
    const response = await fetch(`${url}/api/source-files`, {
      method: 'POST',
      headers: {
        'Content-Type': mimeType || 'application/octet-stream',
        Authorization: `Bearer ${token}`,
        'X-Source-Filename': encodeURIComponent(filename || path.basename(filePath)),
      },
      body: bytes,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, hash: local.hash, size: local.size, status: response.status, error: body.error || `upload failed (${response.status})`, mirrored: true };
    }
    return {
      ok: true,
      status: response.status,
      hash: local.hash,
      remoteHash: body.hash,
      identical: body.hash === local.hash,
      size: local.size,
      ingestObjectId: body.ingestObjectId,
      reused: body.reused,
      mirrored: true,
    };
  } catch (err) {
    console.error('[Chronicle] Source-file capture error:', err);
    return { ok: false, hash: local.hash, size: local.size, error: err.message || String(err), mirrored: true };
  }
});

// Uploads one attachment (an image that is part of a conversation) to
// Foundation's attachment store and returns its metadata, which the chat
// payload then references. Accepts either a file path or inline bytes (a data
// URL from an export). Never throws.
ipcMain.handle('foundation-upload-attachment', async (event, { path: filePath, dataUrl, filename, mimeType } = {}) => {
  let bytes;
  let resolvedMime = mimeType;
  if (dataUrl) {
    // Bytes carried inline by the export (a data URL), no file on disk.
    const match = String(dataUrl).match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) return { ok: false, error: 'invalid data URL' };
    bytes = Buffer.from(match[3], match[2] ? 'base64' : 'utf8');
    resolvedMime = resolvedMime || match[1] || 'application/octet-stream';
  } else if (filePath) {
    try {
      bytes = fs.readFileSync(filePath);
    } catch (err) {
      return { ok: false, error: `cannot read attachment: ${err.message}` };
    }
  } else {
    return { ok: false, error: 'no attachment path or data given' };
  }
  const { url, token } = resolveFoundationConfig();
  if (!token) return { ok: false, error: 'no Foundation token found' };
  try {
    const response = await fetch(`${url}/api/attachments`, {
      method: 'POST',
      headers: {
        'Content-Type': resolvedMime || 'application/octet-stream',
        Authorization: `Bearer ${token}`,
        'X-Attachment-Filename': encodeURIComponent(filename || (filePath ? path.basename(filePath) : 'attachment')),
      },
      body: bytes,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, status: response.status, error: body.error || `upload failed (${response.status})` };
    }
    return { ok: true, status: response.status, attachment: body };
  } catch (err) {
    console.error('[Chronicle] Attachment upload error:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

// ── Gemini enrichment (runs here so the key stays out of the renderer) ───────
ipcMain.handle('analyze-content', async (event, { content, imageMimeType, preferredModel } = {}) => {
  const apiKey = resolveGeminiKey();
  if (!apiKey) return { ok: false, error: 'no Gemini API key (set API_KEY in .env.local)' };
  try {
    const { GoogleGenAI, Type } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    const isImage = !!imageMimeType;
    const prompt = isImage
      ? 'Describe this image in detail for a searchable digital archive. Provide a suggested title, a summary, and relevant tags.'
      : 'Summarize this AI conversation. Suggest a title of 3 to 10 words and relevant tags.';
    const contentPart = isImage
      ? { inlineData: { data: content, mimeType: imageMimeType } }
      : { text: String(content).substring(0, 10000) };
    const systemInstruction = `You are a professional digital archivist. 
    Return a JSON object with:
    1. "summary": A clear, high-level, one-sentence summary.
    2. "tags": An array of 3-6 relevant, lowercase, single-word tags.
    3. "suggestedTitle": A descriptive title of 3 to 10 words that captures the main topic of the article or conversation.`;
    const response = await ai.models.generateContent({
      // gemini-flash-latest: a stable alias that tracks the current flash model.
      model: isImage ? 'gemini-flash-latest' : (preferredModel || 'gemini-flash-latest'),
      contents: { parts: [contentPart, { text: prompt }] },
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            tags: { type: Type.ARRAY, items: { type: Type.STRING } },
            suggestedTitle: { type: Type.STRING },
          },
          required: ['summary', 'tags', 'suggestedTitle'],
        },
      },
    });
    return { ok: true, metadata: JSON.parse(response.text || '{}') };
  } catch (err) {
    console.error('[Chronicle] analyze-content failed:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('generate-embedding', async (event, { text } = {}) => {
  const apiKey = resolveGeminiKey();
  if (!apiKey) return { ok: false, error: 'no Gemini API key' };
  try {
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });
    // gemini-embedding-001 replaced text-embedding-004; the response is
    // embeddings[0].values (the singular `embedding` field no longer exists).
    const response = await ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: [{ parts: [{ text: String(text).substring(0, 9000) }] }],
    });
    const values = response.embeddings?.[0]?.values;
    return { ok: !!values, embedding: values, error: values ? undefined : 'no embedding returned' };
  } catch (err) {
    console.warn('[Chronicle] generate-embedding failed:', err);
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('fetch-models', async () => {
  const apiKey = resolveGeminiKey();
  if (!apiKey) return { ok: false, error: 'no Gemini API key' };
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!response.ok) return { ok: false, error: `Google API responded with status ${response.status}` };
    const data = await response.json();
    const models = (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace('models/', ''));
    return { ok: true, models: models.length ? models : ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash'] };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

function capitalize(value) {
  if (!value) return 'Other';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function guessSource(fileName, content) {
  const haystack = `${fileName}\n${content.slice(0, 2000)}`.toLowerCase();
  if (haystack.includes('claude')) return 'Claude';
  if (haystack.includes('gemini')) return 'Gemini';
  if (haystack.includes('qwen')) return 'Qwen';
  if (haystack.includes('chatgpt') || haystack.includes('openai')) return 'ChatGPT';
  return 'Other';
}

ipcMain.on('notify', (event, { title, body }) => {
  try {
    new Notification({ title: title || 'Chronicle', body: body || '' }).show();
  } catch (err) {
    console.error('[Chronicle] Notification Error:', err);
  }
});

// Original boilerplate (rest of file) remains unchanged for window creation and other handlers...
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#fefef9',
    webPreferences: { 
      preload: path.join(__dirname, 'electron-preload.js'), 
      contextIsolation: true 
    },
  });
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

app.whenReady().then(async () => {
  await initDatabase();
  startIngestListener({ pool, getMainWindow: () => mainWindow, resolveFoundationConfig });
  createWindow();
});
