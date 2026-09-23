
const { app, BrowserWindow, ipcMain, shell, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/ai_chat_archive';

// Initialize PostgreSQL Pool
const pool = new Pool({ connectionString: DATABASE_URL });

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
        assets JSONB DEFAULT '[]'
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
        INSERT INTO chats (id, type, title, content, summary, tags, source, createdAt, updatedAt, fileName, embedding, assets)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO UPDATE SET
          type = EXCLUDED.type,
          title = EXCLUDED.title,
          content = EXCLUDED.content,
          summary = EXCLUDED.summary,
          tags = EXCLUDED.tags,
          source = EXCLUDED.source,
          updatedAt = EXCLUDED.updatedAt,
          embedding = EXCLUDED.embedding,
          assets = EXCLUDED.assets
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
        JSON.stringify(item.assets || [])
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
      let content = fs.readFileSync(filePath, 'utf-8');
      let title = fileName.replace(/\.[^.]+$/, '');
      if (ext === '.json') {
        try {
          const parsed = JSON.parse(content);
          content = jsonToTranscript(parsed);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.title) {
            title = parsed.title;
          }
        } catch {
          content = content;
        }
      }
      const id = `import-${Buffer.from(fileName).toString('base64').slice(0, 16)}`;
      if (existing.has(id)) {
        skipped++;
        continue;
      }
      chats.push({
        id,
        type: 'chat',
        title,
        content,
        summary: '',
        tags: ['imported'],
        source: guessSource(fileName, content),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        fileName,
        embedding: undefined,
        assets: []
      });
    }
    return { success: true, chats, skipped };
  } catch (err) {
    console.error('[Chronicle] Import Error:', err);
    return { success: false, error: String(err), chats: [], skipped: 0 };
  }
});

function jsonToTranscript(json) {
  let messages = [];
  if (Array.isArray(json)) {
    messages = json;
  } else if (json && typeof json === 'object') {
    if (Array.isArray(json.messages)) messages = json.messages;
    else if (Array.isArray(json.history)) messages = json.history;
    else if (Array.isArray(json.conversation)) messages = json.conversation;
    else if (Array.isArray(json.mapping)) {
      const nodes = Object.values(json.mapping);
      const byId = new Map(nodes.map(n => [n.id, n]));
      const roots = nodes.filter(n => !n.parent || !byId.has(n.parent));
      const ordered = [];
      const walk = (node) => {
        if (!node) return;
        if (node.message) ordered.push(node.message);
        (node.children || []).forEach(childId => walk(byId.get(childId)));
      };
      roots.forEach(walk);
      messages = ordered.map(m => ({
        role: m.author && m.author.role,
        content: m.content && m.content.parts ? m.content.parts.join('\n') : (m.content && m.content.text) || ''
      }));
    }
  }
  if (messages.length === 0) return '';
  return messages.map(msg => {
    const role = msg.role || msg.from || (msg.type === 'human' ? 'user' : 'model');
    const content = msg.content || msg.value || msg.text || (msg.content && msg.content.parts ? msg.content.parts.join('\n') : '') || '';
    let displayName = 'User';
    const lowerRole = String(role).toLowerCase();
    if (['user', 'human'].includes(lowerRole)) {
      displayName = 'User';
    } else if (['assistant', 'model', 'bot', 'gpt', 'system'].includes(lowerRole)) {
      displayName = lowerRole === 'system' ? 'System' : 'Assistant';
    } else {
      displayName = role ? String(role).charAt(0).toUpperCase() + String(role).slice(1) : 'Assistant';
    }
    return `${displayName}: ${content}`;
  }).filter(l => l.trim().length > 0).join('\n\n');
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
