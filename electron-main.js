
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
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
  mainWindow.loadFile('index.html');
}

app.whenReady().then(async () => {
  await initDatabase();
  createWindow();
});
