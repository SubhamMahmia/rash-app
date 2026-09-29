// Smart Recall v2 search index (docs/SMART_RECALL_V2.md, phase 2).
//
// Keeps a chunk-level index of every non-vault record: the text split into ~250-word chunks, each
// with an embedding (Ollama, nomic-embed-text) and an FTS5 keyword entry, plus an append-only log
// of when each record was saved. All of it is derived data: it can be deleted and rebuilt from the
// records table at any time, and vault records (is_sensitive = 1) never get any of it.
//
// Saving never waits for this module. Save paths call enqueue(); one background worker does the
// embedding, a batch at a time, pausing while a question is being answered.
'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Every tunable in one place.
// ---------------------------------------------------------------------------
const CONFIG = {
  OLLAMA_URL: 'http://127.0.0.1:11434',
  EMBED_MODEL: process.env.RASH_EMBED_MODEL || 'nomic-embed-text',
  EMBED_DIMS: 768,
  // llama3.2:3b by default: on this CPU-only laptop it is about twice as fast as llama3.1:8b, and
  // at 2.6 GB (vs 5.6 GB) it is the same model the rest of RaSh already uses, so only one LLM ever
  // has to stay in memory. Set RASH_ANSWER_MODEL=llama3.1:8b for the bigger model.
  ANSWER_MODEL: process.env.RASH_ANSWER_MODEL || 'llama3.2:3b',
  // One num_ctx for every call to the answer model, from any part of RaSh: a different value makes
  // Ollama unload and reload it (measured: 8.3 s each time). 6144 because page summaries need it.
  ANSWER_NUM_CTX: 6144,
  ANSWER_NUM_PREDICT: 160, // 1-3 sentences
  ANSWER_TIMEOUT_MS: Number(process.env.RASH_ANSWER_TIMEOUT_MS) || 60000,
  // Memory text sent to the model, in (estimated) tokens. Lowest-ranked memories are dropped first.
  MEMORY_TOKEN_BUDGET: 600,
  // While RaSh runs, the answer and embedding models get a tiny request this often, so they are
  // never unloaded (keep_alive is 30 min) and Windows doesn't page their weights out while idle.
  KEEP_WARM_EVERY_MS: 10 * 60 * 1000,
  // Besides the best match, only memories within this much similarity of it go to the model
  // (or ones matching every topic word).
  SIM_MARGIN: 0.08,
  CHUNK_WORDS: 250,
  CHUNK_OVERLAP: 40,
  MAX_CHUNKS_PER_RECORD: 200, // a huge PDF shouldn't monopolise the worker; the first 200 chunks cover ~50k words
  // The 1,200-token memory budget usually fits ~3 chunks, so TOP_K mostly caps the candidates.
  TOP_K: Number(process.env.RASH_TOP_K) || 4,
  // Cosine similarity a record's best chunk needs to count as a match (unless enough of the
  // question's topic words match instead). Measured over the eval fixtures: 17 answerable questions
  // scored 0.603-0.859 (the 0.603 one also matched 3/3 keywords; the lowest similarity-only pass was
  // 0.626), 12 not-in-memory questions scored 0.469-0.607. 0.61 keeps every answerable one and
  // rejects every unanswerable one before any LLM call. The margins are thin, so the answer model's
  // "I couldn't find that" stays as a second gate.
  RELEVANCE_FLOOR: Number(process.env.RASH_RELEVANCE_FLOOR) || 0.61,
  DOC_PREFIX: 'search_document: ', // nomic-embed-text task prefixes - it is trained to expect them
  QUERY_PREFIX: 'search_query: ',
  EMBED_BATCH: 16, // chunks per /api/embed call
  RECORDS_PER_BATCH: 4, // records per worker step; the worker checks for a waiting question between steps
  EMBED_TIMEOUT_MS: 60000, // one batch call (the first one also loads the model)
  QUERY_EMBED_TIMEOUT_MS: 8000,
  KEEP_ALIVE: '30m',
  RETRY_AFTER_MS: [5000, 15000, 30000, 60000, 120000], // back-off while Ollama is unreachable
  CHUNKER_VERSION: 1, // bump when the chunking code changes, to force a re-index
};

let db = null;
let helpers = null;
let backend = 'none';

// ---------------------------------------------------------------------------
// Schema: additive only.
// ---------------------------------------------------------------------------
function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding BLOB,
      UNIQUE (record_id, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_record ON chunks (record_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5 (
      text,
      tokenize = 'porter unicode61 remove_diacritics 2'
    );

    CREATE TABLE IF NOT EXISTS record_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id INTEGER NOT NULL,
      at DATETIME NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_record_events_at ON record_events (at);
    CREATE INDEX IF NOT EXISTS idx_record_events_record ON record_events (record_id);

    CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function currentSettings() {
  return JSON.stringify({
    embedModel: CONFIG.EMBED_MODEL,
    dims: CONFIG.EMBED_DIMS,
    chunkWords: CONFIG.CHUNK_WORDS,
    chunkOverlap: CONFIG.CHUNK_OVERLAP,
    maxChunks: CONFIG.MAX_CHUNKS_PER_RECORD,
    docPrefix: CONFIG.DOC_PREFIX,
    chunker: CONFIG.CHUNKER_VERSION,
  });
}

// If the model or chunking changed since the index was built, the old vectors aren't comparable
// with new ones - drop the derived index and let the worker rebuild it.
function checkSettings() {
  const want = currentSettings();
  const row = db.prepare("SELECT value FROM index_meta WHERE key = 'settings'").get();
  if (row && row.value === want) return;
  const had = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
  if (had > 0) console.log(`[Index] Embedding or chunk settings changed; re-indexing everything (${had} old chunks dropped).`);
  db.transaction(() => {
    db.exec('DELETE FROM chunks_fts');
    db.exec('DELETE FROM chunks');
    db.prepare("INSERT INTO index_meta (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(want);
  })();
}

// Housekeeping on every start: no index data may exist for vault records or deleted records.
function removeStrayIndexData() {
  db.transaction(() => {
    const stray = db.prepare(`
      SELECT c.id FROM chunks c LEFT JOIN records r ON r.id = c.record_id
      WHERE r.id IS NULL OR r.is_sensitive = 1
    `).all();
    const delFts = db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
    for (const { id } of stray) delFts.run(id);
    db.exec(`
      DELETE FROM chunks WHERE record_id NOT IN (SELECT id FROM records WHERE is_sensitive = 0);
      DELETE FROM record_events WHERE record_id NOT IN (SELECT id FROM records WHERE is_sensitive = 0);
    `);
  })();
}

// Records saved before this table existed get one event, at their last_updated.
function backfillEvents() {
  const r = db.prepare(`
    INSERT INTO record_events (record_id, at)
    SELECT r.id, r.last_updated FROM records r
    WHERE r.is_sensitive = 0
      AND NOT EXISTS (SELECT 1 FROM record_events e WHERE e.record_id = r.id)
  `).run();
  if (r.changes > 0) console.log(`[Index] Backfilled ${r.changes} save event(s) from last_updated.`);
}

function detectBackend(vecLoaded) {
  if (vecLoaded) {
    try {
      const probe = blob(new Float32Array([1, 0, 0]));
      db.prepare('SELECT vec_distance_cosine(?, ?) AS d').get(probe, probe);
      return 'sqlite-vec';
    } catch (_) { /* fall through to the JS fallback */ }
  }
  return 'js';
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------
function contentHash(record) {
  return crypto.createHash('sha256').update(String(record.form_name) + '\u0000' + String(record.content)).digest('hex');
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

// "Jeff Bezos - Wikipedia (en.wikipedia.org)", "File: Unit 3 Chemistry Assignment.pdf",
// "Email: ... (Gmail)" - so a chunk read on its own still says what and where it came from.
function chunkHeader(record) {
  const name = String(record.form_name || '');
  if (/^file:/i.test(name)) return 'File: ' + helpers.attachmentDisplayName(name);
  const title = helpers.recordTitle(record);
  if (/^email:/i.test(name)) return title.replace(/\s*\([0-9a-f]{8,}\)$/i, '') + ' (Gmail)'; // drop the message id
  const host = hostOf(helpers.recordUrl(record));
  return host && !title.toLowerCase().includes(host.toLowerCase()) ? `${title} (${host})` : title;
}

function wordCount(s) {
  return s.split(/\s+/).filter(Boolean).length;
}

// Paragraphs, then sentences; a sentence longer than a whole chunk is cut by words.
function sentencesOf(body) {
  const out = [];
  for (const para of String(body).split(/\n\s*\n|\r?\n/)) {
    const p = para.replace(/\s+/g, ' ').trim();
    if (!p) continue;
    for (const s of p.split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/)) {
      const words = s.split(' ').filter(Boolean);
      for (let i = 0; i < words.length; i += CONFIG.CHUNK_WORDS) out.push(words.slice(i, i + CONFIG.CHUNK_WORDS).join(' '));
    }
  }
  return out;
}

function chunkRecord(record) {
  const header = chunkHeader(record);
  const sentences = sentencesOf(helpers.recordBody(record));
  if (sentences.length === 0) return [header];

  const chunks = [];
  let current = [];
  let words = 0;
  for (const s of sentences) {
    const n = wordCount(s);
    if (words > 0 && words + n > CONFIG.CHUNK_WORDS) {
      chunks.push(current.join(' '));
      if (chunks.length >= CONFIG.MAX_CHUNKS_PER_RECORD) break;
      // Overlap: carry the last sentences (up to ~CHUNK_OVERLAP words) into the next chunk.
      const carry = [];
      let carried = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const w = wordCount(current[i]);
        if (carried + w > CONFIG.CHUNK_OVERLAP) break;
        carry.unshift(current[i]);
        carried += w;
      }
      current = carry;
      words = carried;
    }
    current.push(s);
    words += n;
  }
  if (current.length && chunks.length < CONFIG.MAX_CHUNKS_PER_RECORD) chunks.push(current.join(' '));
  return chunks.map((c) => header + '\n' + c);
}

// ---------------------------------------------------------------------------
// Embeddings (Ollama on localhost only, always with a timeout)
// ---------------------------------------------------------------------------
let ollamaState = { up: null, checkedAt: 0 };

function blob(f32) {
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

async function embedBatch(texts, prefix, timeoutMs) {
  try {
    const res = await fetch(CONFIG.OLLAMA_URL + '/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: CONFIG.EMBED_MODEL, input: texts.map((t) => prefix + t), truncate: true, keep_alive: CONFIG.KEEP_ALIVE }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      ollamaState = { up: true, checkedAt: Date.now() }; // reachable, but refused (e.g. model not pulled)
      return null;
    }
    const data = await res.json();
    ollamaState = { up: true, checkedAt: Date.now() };
    const vectors = Array.isArray(data.embeddings) ? data.embeddings : [];
    if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v) || v.length !== CONFIG.EMBED_DIMS)) return null;
    return vectors.map((v) => new Float32Array(v));
  } catch (_) {
    ollamaState = { up: false, checkedAt: Date.now() };
    return null;
  }
}

// A question's embedding, or null (Ollama off, slow, or missing the model) - callers then fall
// back to keyword search.
async function embedQuery(text) {
  const vectors = await embedBatch([String(text || '')], CONFIG.QUERY_PREFIX, CONFIG.QUERY_EMBED_TIMEOUT_MS);
  return vectors ? vectors[0] : null;
}

async function ollamaUp() {
  if (Date.now() - ollamaState.checkedAt < 10000 && ollamaState.up !== null) return ollamaState.up;
  try {
    const res = await fetch(CONFIG.OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(2000) });
    ollamaState = { up: res.ok, checkedAt: Date.now() };
  } catch (_) {
    ollamaState = { up: false, checkedAt: Date.now() };
  }
  return ollamaState.up;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
const queue = new Set(); // record ids waiting to be (re)indexed
const inFlight = new Set();
let workerRunning = false;
let activeQueries = 0;
let failures = 0;
let progress = { done: 0, target: 0, loggedAt: 0 };

function enqueue(recordId) {
  const id = Number(recordId);
  if (!db || !Number.isInteger(id) || id <= 0) return;
  if (!queue.has(id)) {
    if (progress.done >= progress.target) progress = { done: 0, target: 0, loggedAt: 0 };
    progress.target++;
    queue.add(id);
  }
  scheduleWorker(0);
}

let workerTimer = null;
function scheduleWorker(delayMs) {
  if (workerRunning || workerTimer) return;
  workerTimer = setTimeout(() => { workerTimer = null; runWorker(); }, delayMs);
  if (workerTimer.unref) workerTimer.unref();
}

// /api/ask calls these around each question so indexing never competes with an answer for the CPU.
function beginQuery() { activeQueries++; }
function endQuery() { activeQueries = Math.max(0, activeQueries - 1); }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (queue.size > 0) {
      while (activeQueries > 0) await sleep(200);
      const batch = [...queue].slice(0, CONFIG.RECORDS_PER_BATCH);
      batch.forEach((id) => { queue.delete(id); inFlight.add(id); });
      let ok = false;
      try {
        ok = await indexRecords(batch);
      } catch (err) {
        console.warn('[Index] Worker step failed:', err.message);
      }
      batch.forEach((id) => inFlight.delete(id));
      if (!ok) {
        batch.forEach((id) => queue.add(id)); // resumable: nothing is lost, it's just retried later
        const wait = CONFIG.RETRY_AFTER_MS[Math.min(failures, CONFIG.RETRY_AFTER_MS.length - 1)];
        if (failures === 0) console.warn(`[Index] Embedding model unavailable; ${queue.size} record(s) waiting, retrying in ${wait / 1000}s.`);
        failures++;
        workerRunning = false;
        scheduleWorker(wait);
        return;
      }
      if (failures > 0) console.log('[Index] Embedding model is back; indexing resumed.');
      failures = 0;
      progress.done += batch.length;
      if (queue.size === 0 || Date.now() - progress.loggedAt > 3000) {
        progress.loggedAt = Date.now();
        console.log(`[Index] Indexed ${Math.min(progress.done, progress.target)}/${progress.target}`);
      }
    }
  } finally {
    workerRunning = false;
  }
}

// Indexes a few records. Returns false (and writes nothing) if embedding failed, so the batch can
// be retried. A record deleted, moved to the vault or edited while its embeddings were being made
// is skipped, and an edited one is re-queued.
async function indexRecords(ids) {
  const load = db.prepare('SELECT id, form_name, content, is_sensitive FROM records WHERE id = ?');
  const current = db.prepare('SELECT content_hash, COUNT(*) AS n, SUM(embedding IS NULL) AS missing FROM chunks WHERE record_id = ? GROUP BY content_hash');

  const work = [];
  for (const id of ids) {
    const rec = load.get(id);
    if (!rec || rec.is_sensitive === 1) { purgeRecord(id); continue; }
    const hash = contentHash(rec);
    const have = current.all(id);
    if (have.length === 1 && have[0].content_hash === hash && !have[0].missing) continue; // already current
    work.push({ id, hash, texts: chunkRecord(rec) });
  }
  if (work.length === 0) return true;

  const all = work.flatMap((w) => w.texts);
  const vectors = [];
  for (let i = 0; i < all.length; i += CONFIG.EMBED_BATCH) {
    const part = await embedBatch(all.slice(i, i + CONFIG.EMBED_BATCH), CONFIG.DOC_PREFIX, CONFIG.EMBED_TIMEOUT_MS);
    if (!part) return false;
    vectors.push(...part);
  }

  const insertChunk = db.prepare('INSERT INTO chunks (record_id, chunk_index, text, content_hash, embedding) VALUES (?, ?, ?, ?, ?)');
  const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)');
  let offset = 0;
  db.transaction(() => {
    for (const w of work) {
      const vecs = vectors.slice(offset, offset + w.texts.length);
      offset += w.texts.length;
      const rec = load.get(w.id);
      if (!rec || rec.is_sensitive === 1) { deleteChunks(w.id); continue; }
      if (contentHash(rec) !== w.hash) { queue.add(w.id); continue; }
      deleteChunks(w.id);
      w.texts.forEach((text, i) => {
        const r = insertChunk.run(w.id, i, text, w.hash, blob(vecs[i]));
        insertFts.run(r.lastInsertRowid, text);
      });
    }
  })();
  return true;
}

function deleteChunks(recordId) {
  const ids = db.prepare('SELECT id FROM chunks WHERE record_id = ?').all(recordId);
  const delFts = db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
  for (const { id } of ids) delFts.run(id);
  db.prepare('DELETE FROM chunks WHERE record_id = ?').run(recordId);
}

// Deleted, or moved into the vault: every trace of it leaves the index immediately.
function purgeRecord(recordId) {
  if (!db) return;
  const id = Number(recordId);
  queue.delete(id);
  db.transaction(() => {
    deleteChunks(id);
    db.prepare('DELETE FROM record_events WHERE record_id = ?').run(id);
  })();
}

// Called on every save of a non-vault record, with the time the save wrote to last_updated.
function recordEvent(recordId, at) {
  if (!db) return;
  db.prepare('INSERT INTO record_events (record_id, at) VALUES (?, ?)').run(Number(recordId), at);
}

// On start: queue every non-vault record whose chunks are missing, incomplete or out of date.
function queueStale() {
  const stored = new Map();
  for (const row of db.prepare('SELECT record_id, content_hash, COUNT(*) AS n, SUM(embedding IS NULL) AS missing FROM chunks GROUP BY record_id, content_hash').iterate()) {
    stored.set(row.record_id, stored.has(row.record_id) ? null : row); // two hashes for one record = stale
  }
  let n = 0;
  for (const rec of db.prepare('SELECT id, form_name, content FROM records WHERE is_sensitive = 0').iterate()) {
    const s = stored.get(rec.id);
    if (!s || s.missing || s.content_hash !== contentHash(rec)) { queue.add(rec.id); n++; }
  }
  progress = { done: 0, target: n, loggedAt: 0 };
  const total = db.prepare('SELECT COUNT(*) AS n FROM records WHERE is_sensitive = 0').get().n;
  console.log(n > 0 ? `[Index] ${n} of ${total} record(s) need indexing; working through them in the background.` : `[Index] All ${total} record(s) are indexed.`);
}

// ---------------------------------------------------------------------------
// Search primitives (the question router in phase 3 builds on these). `where` is extra SQL over
// the joined records row `r` (e.g. a time range or site filter) with its own `params`. Vault
// records are always excluded here, regardless of what the caller passes.
// ---------------------------------------------------------------------------
function vectorSearch(queryVector, { limit = 40, where = '', params = [] } = {}) {
  const filter = `c.embedding IS NOT NULL AND r.is_sensitive = 0 ${where ? 'AND (' + where + ')' : ''}`;
  if (backend === 'sqlite-vec') {
    return db.prepare(`
      SELECT c.id AS chunkId, c.record_id AS recordId, vec_distance_cosine(c.embedding, ?) AS distance
      FROM chunks c JOIN records r ON r.id = c.record_id
      WHERE ${filter}
      ORDER BY distance LIMIT ?
    `).all(blob(queryVector), ...params, limit);
  }
  const rows = db.prepare(`
    SELECT c.id AS chunkId, c.record_id AS recordId, c.embedding AS embedding
    FROM chunks c JOIN records r ON r.id = c.record_id
    WHERE ${filter}
  `).all(...params);
  return rows
    .map((row) => ({ chunkId: row.chunkId, recordId: row.recordId, distance: 1 - cosine(queryVector, toF32(row.embedding)) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

function toF32(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const FTS_STOP = new Set(('a an and are as at be been but by can could did do does for from had has have how i if in into is it ' +
  'its me my of on or our so than that the their them then there these they this to up was we were what when where which who ' +
  'whom why will with would you your show tell find give about last latest recent recently read saw see seen saved open').split(' '));

function ftsQuery(text) {
  const words = String(text || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
    .filter((w) => w.length > 1 && !FTS_STOP.has(w));
  return [...new Set(words)].map((w) => `"${w}"`).join(' OR ');
}

// FTS5 bm25 is "lower is better" and negative; returned as-is, ordered best first.
function keywordSearch(text, { limit = 40, where = '', params = [] } = {}) {
  const match = ftsQuery(text);
  if (!match) return [];
  return db.prepare(`
    SELECT chunks_fts.rowid AS chunkId, c.record_id AS recordId, bm25(chunks_fts) AS score
    FROM chunks_fts
    JOIN chunks c ON c.id = chunks_fts.rowid
    JOIN records r ON r.id = c.record_id
    WHERE chunks_fts MATCH ? AND r.is_sensitive = 0 ${where ? 'AND (' + where + ')' : ''}
    ORDER BY score LIMIT ?
  `).all(match, ...params, limit);
}

function chunkText(chunkId) {
  const row = db.prepare('SELECT text FROM chunks WHERE id = ?').get(chunkId);
  return row ? row.text : '';
}

// ---------------------------------------------------------------------------
// Status and startup
// ---------------------------------------------------------------------------
async function status() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM records WHERE is_sensitive = 0').get().n;
  const pending = queue.size + inFlight.size;
  return {
    backend,
    indexed: Math.max(0, total - pending),
    total,
    pending,
    embedModel: CONFIG.EMBED_MODEL,
    ollamaUp: await ollamaUp(),
  };
}

// Sets up the tables and starts the background worker. Returns immediately: startup never waits
// for embeddings.
function init(options) {
  db = options.db;
  helpers = options.helpers;
  createTables();
  checkSettings();
  removeStrayIndexData();
  backfillEvents();
  backend = detectBackend(options.vecLoaded);
  console.log(`[Index] Vector search backend: ${backend === 'sqlite-vec' ? 'sqlite-vec (vec_distance_cosine)' : 'JavaScript cosine fallback'}.`);
  queueStale();
  scheduleWorker(0);
}

module.exports = {
  CONFIG,
  init,
  enqueue,
  purgeRecord,
  recordEvent,
  beginQuery,
  endQuery,
  status,
  embedQuery,
  vectorSearch,
  keywordSearch,
  chunkText,
  chunkRecord, // exported for tests
};
