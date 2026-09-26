// RaSh MCP server - exposes saved memories to MCP clients (Cursor, etc.) over HTTP+SSE.
//
// Runs as a child process of server.js, which means it cannot literally share the parent's
// better-sqlite3 object: a child process has its own memory. It opens the SAME rash.db file in
// READ-ONLY mode instead. SQLite's WAL journal allows many readers alongside the single writer in
// server.js, so this never blocks or corrupts the main server's writes, and being read-only makes
// it impossible for an MCP client to change anything.
//
// Vault records (is_sensitive = 1) are never returned. MCP has no way to ask for the PIN, so the
// safe default is to leave locked memories out entirely.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

const PORT = Number(process.env.RASH_MCP_PORT || 3001);
const DB_FILE = path.join(__dirname, 'rash.db');
const EMBED_MODEL = process.env.RASH_EMBED_MODEL || 'nomic-embed-text';
const EMBED_DIMENSIONS = 768;
const EMBED_MAX_DISTANCE = Number(process.env.RASH_EMBED_MAX_DISTANCE || 0.55);
const SERVER_NAME = 'rash';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2024-11-05';

// ---------------------------------------------------------------------------
// Database (read-only)
// ---------------------------------------------------------------------------
const db = new Database(DB_FILE, { readonly: true, allowExtension: true });
let vectorSearchAvailable = false;
try {
  sqliteVec.load(db);
  db.prepare('SELECT COUNT(*) AS n FROM vec_records').get();
  vectorSearchAvailable = true;
} catch (err) {
  console.warn('[MCP] Vector search unavailable, falling back to keyword search:', err.message);
}

// Same shapes the main server uses, so results look the same to a client
function recordTitle(record) {
  return String(record.form_name || '').replace(/^(Web|File|Form):\s*/i, '').trim();
}
function recordUrl(record) {
  const m = String(record.content || '').match(/^Source:\s*(https?:\/\/\S+)/i);
  return m ? m[1] : '';
}
function recordBody(record) {
  return String(record.content || '').replace(/^Source:\s*\S+\s*/i, '').trim();
}
function shape(record, extra) {
  return Object.assign({
    title: recordTitle(record),
    form_name: record.form_name,
    content: recordBody(record).slice(0, 4000),
    source_url: recordUrl(record),
    timestamp: record.last_updated,
  }, extra || {});
}

const VISIBLE = 'is_sensitive = 0 OR is_sensitive IS NULL';

async function embedQuestion(text) {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: String(text).slice(0, 6000) }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.embedding) || data.embedding.length !== EMBED_DIMENSIONS) return null;
    return new Float32Array(data.embedding);
  } catch (err) {
    return null;
  }
}

// Meaning-based search, with a keyword search behind it when embeddings aren't available
async function searchMemory(query, limit) {
  const want = Math.min(Math.max(Number(limit) || 5, 1), 20);

  if (vectorSearchAvailable) {
    const embedding = await embedQuestion(query);
    if (embedding) {
      try {
        const rows = db.prepare(`
          WITH nearest AS (
            SELECT rowid AS id, distance FROM vec_records
            WHERE embedding MATCH ? ORDER BY distance LIMIT ?
          )
          SELECT r.*, n.distance AS distance
          FROM nearest n JOIN records r ON r.id = n.id
          WHERE ${VISIBLE}
          ORDER BY n.distance
        `).all(Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength), want * 4);

        const hits = rows.filter((r) => r.distance <= EMBED_MAX_DISTANCE).slice(0, want);
        if (hits.length) return hits.map((r) => shape(r, { match: 'meaning', distance: Number(r.distance.toFixed(4)) }));
      } catch (err) {
        console.warn('[MCP] Vector search failed, using keywords:', err.message);
      }
    }
  }

  const words = String(query).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return [];
  const all = db.prepare(`SELECT * FROM records WHERE ${VISIBLE} ORDER BY last_updated DESC`).all();
  return all
    .map((record) => {
      const hay = (record.form_name + ' ' + record.content).toLowerCase();
      let score = 0;
      for (const w of words) if (hay.includes(w)) score += 1;
      return { record, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, want)
    .map((x) => shape(x.record, { match: 'keyword' }));
}

function getRecent(limit) {
  const n = Math.min(Math.max(Number(limit) || 10, 1), 50);
  return db.prepare(`SELECT * FROM records WHERE ${VISIBLE} ORDER BY last_updated DESC, id DESC LIMIT ?`)
    .all(n)
    .map((r) => shape(r));
}

function getRecord(formName) {
  const name = String(formName || '').trim();
  if (!name) return null;
  const exact = db.prepare(`SELECT * FROM records WHERE form_name = ? AND (${VISIBLE})`).get(name);
  if (exact) return shape(exact);
  // a forgiving match, so a client doesn't have to reproduce the stored name character for character
  const like = db.prepare(`SELECT * FROM records WHERE form_name LIKE ? AND (${VISIBLE}) ORDER BY last_updated DESC LIMIT 1`).get('%' + name + '%');
  return like ? shape(like) : null;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: 'search_memory',
    description: 'Search saved RaSh memories (web pages, files, notes) by meaning, falling back to keywords. Returns the best matching records.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in plain language.' },
        limit: { type: 'number', description: 'How many records to return (default 5, max 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_recent',
    description: 'Return the most recently saved RaSh records, newest first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'How many to return (default 10, max 50).' } },
    },
  },
  {
    name: 'get_record',
    description: 'Return one saved record by its form_name. Falls back to a partial name match.',
    inputSchema: {
      type: 'object',
      properties: { form_name: { type: 'string', description: 'The record name, e.g. "File: notes.pdf".' } },
      required: ['form_name'],
    },
  },
];

async function callTool(name, args) {
  const input = args || {};
  if (name === 'search_memory') {
    const results = await searchMemory(input.query, input.limit);
    return results.length ? results : { note: 'No saved memory matched that.' };
  }
  if (name === 'get_recent') return getRecent(input.limit);
  if (name === 'get_record') {
    const found = getRecord(input.form_name);
    return found || { note: 'No saved record with that name.' };
  }
  throw new Error('Unknown tool: ' + name);
}

// ---------------------------------------------------------------------------
// MCP over HTTP + SSE
//   GET  /sse       opens the stream and announces where to post
//   POST /messages  carries the JSON-RPC requests; replies travel back over the stream
// ---------------------------------------------------------------------------
const sessions = new Map();

function sendEvent(res, event, data) {
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}

async function handleRpc(message) {
  const { id, method, params } = message;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

  try {
    if (method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const result = await callTool(params && params.name, params && params.arguments);
      return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    }
    // notifications carry no id and expect no reply
    if (id === undefined || id === null) return null;
    return fail(-32601, 'Method not found: ' + method);
  } catch (err) {
    if (id === undefined || id === null) return null;
    return fail(-32603, err.message);
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Streamable HTTP transport (the current MCP spec) - a single endpoint that takes a POST with one
// JSON-RPC message (or a batch array) and, since none of our tools need to push more than one
// reply, answers directly with a JSON body instead of opening a stream. This is what Cursor tries
// first; mounted on '/', '/mcp' and '/sse' so it works regardless of which one a client is
// configured to hit (.cursor/mcp.json here points at '/sse').
async function handleStreamableHttp(req, res) {
  const body = req.body;
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0 || messages.some((m) => !m || typeof m !== 'object')) {
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid JSON-RPC request.' } });
  }

  const responses = [];
  for (const message of messages) {
    const reply = await handleRpc(message);
    if (reply) responses.push(reply);
  }

  // A session id is handed out once, on initialize, and accepted (but never required or checked)
  // on later calls - every tool here is a stateless read, so there is nothing to tie to a session.
  if (messages.some((m) => m.method === 'initialize')) {
    res.setHeader('Mcp-Session-Id', crypto.randomUUID());
  }

  if (responses.length === 0) return res.status(202).end(); // notifications only: nothing to reply with
  res.status(200).json(Array.isArray(body) ? responses : responses[0]);
}

app.post(['/', '/mcp', '/sse'], handleStreamableHttp);
// A client may close its session explicitly; there is no session state to discard, so just accept it.
app.delete(['/', '/mcp', '/sse'], (req, res) => res.status(204).end());

app.get('/mcp', (req, res) => sseHandler(req, res));
app.get('/sse', (req, res) => sseHandler(req, res));

// ---------------------------------------------------------------------------
// Legacy SSE transport (2024-11-05 spec) - GET opens a stream and announces where to POST;
// POST /messages carries the JSON-RPC calls, with replies delivered back over that stream. Kept
// for any client (or Cursor's own fallback) that speaks the older transport instead.
// ---------------------------------------------------------------------------
function sseHandler(req, res) {
  const sessionId = crypto.randomUUID();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  sessions.set(sessionId, res);
  // The transport's first job: tell the client where to POST its messages
  sendEvent(res, 'endpoint', '/messages?sessionId=' + sessionId);

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sessions.delete(sessionId);
  });
}

app.post('/messages', async (req, res) => {
  const stream = sessions.get(String(req.query.sessionId || ''));
  if (!stream) return res.status(404).json({ error: 'Unknown or closed session.' });

  const response = await handleRpc(req.body || {});
  res.status(202).end(); // the answer goes back over the SSE stream, not this request
  if (response) sendEvent(stream, 'message', response);
});

// Handy for a quick check that the server is alive without speaking MCP
app.get('/health', (req, res) => {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM records WHERE ${VISIBLE}`).get().n;
  res.json({ ok: true, records: total, vectorSearch: vectorSearchAvailable, tools: TOOLS.map((t) => t.name) });
});

const server = app.listen(PORT, () => {
  console.log(`[MCP] RaSh MCP server on http://localhost:${PORT}/sse (${TOOLS.length} tools, read-only)`);
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE'
    ? `[MCP] Port ${PORT} is already in use; the MCP server did not start.`
    : '[MCP] Failed to start: ' + err.message);
  process.exit(1);
});

function shutdown() {
  for (const stream of sessions.values()) { try { stream.end(); } catch (_) {} }
  try { db.close(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
