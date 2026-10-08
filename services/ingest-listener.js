/**
 * Chronicle ingest listener — the local HTTP door for the chat-export plugin.
 *
 * A browser extension on claude.ai / chatgpt.com can only speak HTTP, and an
 * Electron app has no HTTP surface. This module adds the minimal one: a
 * token-protected loopback endpoint that accepts a conversation in the same
 * raw shape utils/sourceParsers.ts produces (ParsedConversation) and runs it
 * through the exact paths the renderer's import flow uses:
 *
 *   1. strict input validation (typeward, mirroring Foundation's ingestPolicy)
 *   2. dedup: URL key first, content hash as fallback (utils/chatDedup)
 *   3. the archive copy in the same chats table (save-database upsert shape)
 *   4. the capture forward: POST {foundation}/api/ingest/chat with
 *      source "chronicle-capture", built by buildChatIngestPayload
 *   5. a `chat-ingested` event to the renderer so the archive view refreshes
 *
 * Chronicle stays the door, not a second gateway: the payload is built by the
 * same builder the renderer uses and forwarded verbatim — nothing added,
 * nothing filtered. Server-owned Foundation fields (status,
 * providerConversationId, contentHash, ...) are rejected here too.
 *
 * Start: startIngestListener({ pool, getMainWindow, resolveFoundationConfig })
 * — called from electron-main.js after initDatabase().
 *
 * Config, highest priority first:
 *   1. CHRONICLE_INGEST_TOKEN / CHRONICLE_INGEST_PORT environment
 *   2. foundation.local.json { "ingestToken": "..." } (gitignored)
 *   3. the Foundation token (shared local secret; see electron-main.js)
 *
 * Binds 127.0.0.1 only. Never 0.0.0.0: the listener is for the plugin on this
 * machine, not for the network.
 */
const http = require('http');
const crypto = require('crypto');

const {
  validateIngestChatInput,
  normalizeIngestChat,
  findExistingRow,
  foundationContentHash,
} = require('../utils/captureIngest.cjs');

const DEFAULT_PORT = 4580;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB of JSON is a very large conversation
const MAX_TITLE = 500;

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Timing-safe token comparison (constant-time even on early mismatch). */
function tokenMatches(expected, given) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(given || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * The capture forward, shared by the listener. Mirrors the
 * foundation-capture-chat IPC handler: the main process supplies the token
 * and URL, the payload is already built. Never throws — a capture failure is
 * a value stored on the row, not a crash of the listener.
 */
async function captureToFoundation(payload, resolveFoundationConfig) {
  const { url, token } = resolveFoundationConfig();
  if (!token) {
    return { ok: false, error: 'no Foundation token found — set FOUNDATION_TOKEN, add foundation.local.json, or start Foundation' };
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
      return {
        ok: false,
        status: response.status,
        error: body.error || `ingest failed with status ${response.status}`,
        details: body.details,
      };
    }
    return {
      ok: true,
      status: response.status,
      id: body.id,
      insertedNew: body.insertedNew,
      providerConversationId: body.providerConversationId,
      ingestedAt: body.ingestedAt,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

async function insertChatRow(pool, item) {
  await pool.query(
    `INSERT INTO chats (id, type, title, content, summary, tags, source, createdAt, updatedAt, fileName, embedding, assets, capture, foundation, "sourceFile", archived, "contentHash")
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
       "contentHash" = EXCLUDED."contentHash"`,
    [
      item.id,
      item.type || 'chat',
      item.title,
      item.content,
      item.summary,
      JSON.stringify(item.tags),
      item.source,
      item.createdAt,
      item.updatedAt || item.createdAt,
      item.fileName || null,
      item.embedding || null,
      JSON.stringify(item.assets || []),
      item.capture ? JSON.stringify(item.capture) : null,
      item.foundation ? JSON.stringify(item.foundation) : null,
      item.sourceFile ? JSON.stringify(item.sourceFile) : null,
      !!item.archived,
      item.contentHash || null,
    ]
  );
}

/**
 * Handles POST /ingest/chat. Returns { status, body } so the HTTP layer stays
 * dumb and the whole path is testable without a socket.
 */
async function handleIngestChat(pool, getMainWindow, resolveFoundationConfig, raw) {
  const invalid = validateIngestChatInput(raw);
  if (invalid.error) {
    return { status: 422, body: { error: invalid.error, details: invalid.details } };
  }

  const now = Date.now();
  const existingRows = await pool.query('SELECT id, content, "contentHash", createdat, capture FROM chats');
  const normalized = normalizeIngestChat(raw, crypto.randomUUID(), now);

  const existing = findExistingRow(
    existingRows.rows.map((r) => ({ id: r.id, content: r.content, contentHash: r.contentHash, capture: r.capture })),
    normalized.urlKey,
    normalized.item.contentHash
  );

  if (existing) {
    const sameContent =
      (existing.contentHash || foundationContentHash(existing.content)) ===
      normalized.item.contentHash;
    if (sameContent) {
      return { status: 200, body: { action: 'duplicate', id: existing.id } };
    }
    // Same conversation, grown or changed: update the row in place and
    // re-capture so Foundation sees the newer version (ON CONFLICT DO UPDATE).
    const updated = {
      ...normalized.item,
      id: existing.id,
      createdAt: Number(existing.createdAt) || normalized.item.createdAt,
    };
    await insertChatRow(pool, updated);
    const result = await captureToFoundation(normalized.foundationPayload, resolveFoundationConfig);
    const foundation = result.ok
      ? { status: 'sent', providerConversationId: result.providerConversationId, id: result.id, at: now }
      : { status: 'failed', error: result.details?.length ? result.details.join('; ') : result.error, at: now };
    await pool.query('UPDATE chats SET foundation = $1, updatedAt = $2 WHERE id = $3', [
      JSON.stringify(foundation),
      now,
      existing.id,
    ]);
    notifyRenderer(getMainWindow, { id: existing.id, action: 'update', title: updated.title.slice(0, MAX_TITLE) });
    if (!result.ok) {
      return {
        status: 502,
        body: { action: 'update', id: existing.id, captured: false, error: result.error, details: result.details },
      };
    }
    return {
      status: 200,
      body: {
        action: 'update',
        id: existing.id,
        captured: true,
        insertedNew: result.insertedNew,
        providerConversationId: result.providerConversationId,
      },
    };
  }

  await insertChatRow(pool, normalized.item);
  const result = await captureToFoundation(normalized.foundationPayload, resolveFoundationConfig);
  const foundation = result.ok
    ? { status: 'sent', providerConversationId: result.providerConversationId, id: result.id, at: now }
    : { status: 'failed', error: result.details?.length ? result.details.join('; ') : result.error, at: now };
  await pool.query('UPDATE chats SET foundation = $1 WHERE id = $2', [JSON.stringify(foundation), normalized.item.id]);
  notifyRenderer(getMainWindow, {
    id: normalized.item.id,
    action: 'create',
    title: normalized.item.title.slice(0, MAX_TITLE),
  });
  if (!result.ok) {
    return {
      status: 502,
      body: {
        action: 'create',
        id: normalized.item.id,
        captured: false,
        error: result.error,
        details: result.details,
      },
    };
  }
  return {
    status: 201,
    body: {
      action: 'create',
      id: normalized.item.id,
      captured: true,
      insertedNew: result.insertedNew,
      providerConversationId: result.providerConversationId,
    },
  };
}

function notifyRenderer(getMainWindow, payload) {
  try {
    const win = getMainWindow && getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('chat-ingested', payload);
  } catch {
    // The renderer being closed must never break an ingest.
  }
}

/**
 * Starts the loopback listener. Returns the http.Server (its close() shuts
 * the door cleanly).
 */
function startIngestListener({ pool, getMainWindow, resolveFoundationConfig }) {
  const port = Number(process.env.CHRONICLE_INGEST_PORT) || DEFAULT_PORT;
  const token =
    process.env.CHRONICLE_INGEST_TOKEN ||
    (typeof loadIngestTokenFromFile() === 'string' ? loadIngestTokenFromFile() : null) ||
    (resolveFoundationConfig() && resolveFoundationConfig().token);

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, { ok: true, service: 'chronicle-ingest' });
      }
      if (req.method === 'POST' && (req.url === '/ingest/chat' || req.url === '/api/ingest/chat')) {
        if (!token) {
          return sendJson(res, 500, { error: 'no ingest token configured — set CHRONICLE_INGEST_TOKEN or add foundation.local.json' });
        }
        const auth = req.headers.authorization || '';
        const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!given || !tokenMatches(token, given)) {
          return sendJson(res, 401, { error: 'missing or invalid bearer token' });
        }
        const text = await readBody(req);
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          return sendJson(res, 400, { error: 'body is not valid JSON' });
        }
        const result = await handleIngestChat(pool, getMainWindow, resolveFoundationConfig, parsed);
        return sendJson(res, result.status, result.body);
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      if (err && err.statusCode) return sendJson(res, err.statusCode, { error: err.message });
      console.error('[Chronicle] Ingest listener error:', err);
      return sendJson(res, 500, { error: 'internal listener error' });
    }
  });

  // Loopback only — this door is for the plugin on this machine.
  server.listen(port, '127.0.0.1', () => {
    console.log(`[Chronicle] Ingest listener on http://127.0.0.1:${port} (loopback only)`);
  });
  server.on('error', (err) => {
    console.error(`[Chronicle] Ingest listener failed to start on port ${port}:`, err.message);
  });
  return server;
}

function loadIngestTokenFromFile() {
  // foundation.local.json is read by electron-main.js's loadFoundationConfigFile;
  // this reads the same file for the dedicated ingestToken key.
  try {
    const path = require('path');
    const fs = require('fs');
    const candidates = [
      process.env.FOUNDATION_CONFIG_FILE,
      path.join(__dirname, '..', 'foundation.local.json'),
    ].filter(Boolean);
    for (const file of candidates) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed.ingestToken === 'string' && parsed.ingestToken.trim()) {
          return parsed.ingestToken.trim();
        }
      } catch {
        // try next candidate
      }
    }
  } catch {
    // ignore
  }
  return null;
}

module.exports = { startIngestListener, handleIngestChat, captureToFoundation };
