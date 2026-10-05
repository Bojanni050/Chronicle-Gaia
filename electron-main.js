
const { app, BrowserWindow, ipcMain, shell, dialog, Notification } = require('electron');
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
        foundation JSONB
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
        INSERT INTO chats (id, type, title, content, summary, tags, source, createdAt, updatedAt, fileName, embedding, assets, capture, foundation)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
          foundation = EXCLUDED.foundation
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
        item.foundation ? JSON.stringify(item.foundation) : null
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
    return res.rows.map(r => ({
      ...r,
      createdAt: Number(r.createdat),
      updatedAt: Number(r.updatedat),
      tags: typeof r.tags === 'string' ? JSON.parse(r.tags) : r.tags,
      assets: typeof r.assets === 'string' ? JSON.parse(r.assets) : r.assets,
      capture: typeof r.capture === 'string' ? JSON.parse(r.capture) : r.capture,
      foundation: typeof r.foundation === 'string' ? JSON.parse(r.foundation) : r.foundation,
      embedding: r.embedding
    }));
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
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Chat Exports', extensions: ['json', 'md', 'txt'] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, cancelled: true, chats: [], skipped: 0 };
    }
    const existing = new Set(existingIds || []);
    const chats = [];
    let skipped = 0;
    for (const filePath of result.filePaths) {
      const fileName = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const content = fs.readFileSync(filePath, 'utf-8');

      // A file may hold one conversation or many (a Claude export holds all).
      let parsed = [];
      if (ext === '.json') {
        try {
          const json = JSON.parse(content);
          const claude = parseClaudeExport(json);
          parsed = claude.length > 0 ? claude : [parseConversationJson(json)].filter(Boolean);
        } catch {
          parsed = [];
        }
      }
      if (parsed.length === 0) {
        parsed = [{ content, turns: [], title: fileName.replace(/\.[^.]+$/, ''), sourceProvider: guessSource(fileName, content).toLowerCase() }];
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
        chats.push({
          id,
          type: 'chat',
          title: conv.title || fileName.replace(/\.[^.]+$/, ''),
          content: conv.content,
          summary: '',
          tags: ['imported'],
          source: conv.sourceProvider ? capitalize(conv.sourceProvider) : guessSource(fileName, content),
          createdAt: conv.createdAt || Date.now(),
          updatedAt: conv.occurredAt || conv.createdAt || Date.now(),
          fileName: label,
          embedding: undefined,
          assets: [],
          capture: {
            sourceProvider: conv.sourceProvider || guessSource(fileName, content).toLowerCase(),
            ...(conv.url ? { url: conv.url } : {}),
            ...(conv.occurredAt ? { occurredAt: new Date(conv.occurredAt).toISOString() } : {}),
            ...(conv.turns && conv.turns.length ? { turns: conv.turns } : {}),
          },
        });
      }
    }
    return { success: true, chats, skipped };
  } catch (err) {
    console.error('[Chronicle] Import Error:', err);
    return { success: false, error: String(err), chats: [], skipped: 0 };
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
  createWindow();
});
