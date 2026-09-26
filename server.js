const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const chokidar = require('chokidar');
const pdfParse = require('pdf-parse');
const sqliteVec = require('sqlite-vec');

const app = express();
const PORT = 3000;

const crypto = require('crypto');

// The one place to choose the local Ollama model. Override with the RASH_MODEL environment variable if needed.
const OLLAMA_MODEL = process.env.RASH_MODEL || 'llama3.1:8b';

// Summarising a document means feeding the model 1500 words at a time, and on a machine with no
// GPU that cost scales hard with model size: the same chunk measured 98.4s on llama3.1:8b against
// 51.0s on llama3.2:3b. So the big model answers questions, and a smaller one does the chunk
// summarising, where speed matters more than eloquence.
const SUMMARY_MODEL = process.env.RASH_SUMMARY_MODEL || 'llama3.2:3b';

// Looking at an attached image. Two very different jobs, so two different tools:
//  - describing a picture goes to a small vision model
//  - reading printed text goes to Tesseract, because the vision model misreads digits confidently
//    (measured: it reported an invoice total of 138.50 that actually read 1284.50)
const VISION_MODEL = process.env.RASH_VISION_MODEL || 'moondream';
const OCR_TESSDATA_DIR = path.join(__dirname, 'tessdata'); // eng.traineddata lives here, so no CDN fetch
// Tesseract's own confidence, 0-100. Measured: clean text 95, small grey noisy text 77, a photo with
// no text at all 34. Below this RaSh says it couldn't read the image instead of answering from noise.
const OCR_MIN_CONFIDENCE = Number(process.env.RASH_OCR_MIN_CONFIDENCE || 60);

// Vault PIN comes from vault.pin (git-ignored). Missing or empty file = unlock is refused.
const VAULT_PIN = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'vault.pin'), 'utf8').trim() || null; }
  catch (_) { return null; }
})();
if (!VAULT_PIN) console.warn('[Vault] vault.pin is missing or empty: the Vault cannot be unlocked.');

// TEMPORARY: accept the old "x-vault-unlocked: true" header until app.js sends x-vault-token.
// Set to false as soon as app.js has been updated, otherwise the header still bypasses the PIN.
const ALLOW_LEGACY_UNLOCK_HEADER = true;

const VAULT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const vaultTokens = new Map(); // token -> expiry time (memory only, cleared on server restart)
let failedUnlocks = [];        // timestamps of recent wrong PINs

function isLocalRequest(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// This machine only, and if an origin is sent, it must be the extension or RaSh's own page.
// Shared by newer endpoints (attachments); older endpoints keep their own separate checks unchanged.
function isStrictLocalRequest(req) {
  if (!isLocalRequest(req)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin.startsWith('chrome-extension://') || origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
}

function vaultUnlocked(req) {
  const tok = req.headers['x-vault-token'];
  const exp = typeof tok === 'string' ? vaultTokens.get(tok) : 0;
  if (exp && exp > Date.now()) return true;
  if (exp) vaultTokens.delete(tok);
  return ALLOW_LEGACY_UNLOCK_HEADER && req.headers['x-vault-unlocked'] === 'true';
}

// Initialize SQLite database
const db = new Database('rash.db', { allowExtension: true });
db.pragma('journal_mode = WAL');

// Schema setup
db.exec(`
  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_name TEXT NOT NULL UNIQUE,
    category TEXT DEFAULT 'Uncategorized',
    tags TEXT DEFAULT '',
    content TEXT NOT NULL,
    is_sensitive INTEGER DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ---------------------------------------------------------------------------
// RAG: local vector search over saved records, using sqlite-vec (an in-process SQLite
// extension, no network) and Ollama's embedding model (127.0.0.1 only, same as the rest of
// this file's Ollama calls). If the extension fails to load for any reason, vector search is
// simply unavailable and /api/ask falls back to the existing keyword search - nothing crashes.
// ---------------------------------------------------------------------------
const EMBED_MODEL = process.env.RASH_EMBED_MODEL || 'nomic-embed-text';
const EMBED_DIMENSIONS = 768; // nomic-embed-text's output size

// Cosine distance, because nomic-embed-text returns unnormalized vectors (plain L2 distance on
// those ranks poorly and gives numbers you can't set a meaningful threshold on).
//
// The cutoff is deliberately generous. Measured against the real saved records: questions that DO
// have an answer here scored 0.299-0.493, and questions that do NOT scored 0.429-0.576 - those
// ranges overlap, so no single number separates them on its own. 0.55 keeps every real answer
// (worst was 0.493) while still rejecting the obviously unrelated (0.565+). The overlap cases are
// caught by the second gate instead: the model is told to reply NOT_FOUND when the retrieved text
// doesn't actually contain the answer, which already becomes found: false.
const EMBED_METRIC = 'cosine';
const EMBED_MAX_DISTANCE = Number(process.env.RASH_EMBED_MAX_DISTANCE || 0.55);

let vectorSearchAvailable = false;
try {
  sqliteVec.load(db);

  // An older build of this file created vec_records with the default L2 metric. If that's what is
  // on disk, drop it: the embeddings are regenerated automatically by the sweep below, so the only
  // cost is re-embedding once, and the alternative is silently searching with the wrong metric.
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_records'").get();
  if (existing && existing.sql && !/distance_metric\s*=\s*cosine/i.test(existing.sql)) {
    console.log('[RAG] Rebuilding vec_records to use cosine distance; embeddings will be regenerated.');
    db.exec('DROP TABLE vec_records');
  }

  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_records USING vec0(embedding float[${EMBED_DIMENSIONS}] distance_metric=${EMBED_METRIC})`);
  vectorSearchAvailable = true;
  console.log('[RAG] sqlite-vec loaded; vector search is available.');
} catch (err) {
  console.warn('[RAG] sqlite-vec could not be loaded, vector search is disabled and /api/ask will use keyword search only:', err.message);
}

// Turns a saved record's id into the BigInt sqlite-vec requires for its rowid (a plain
// JS number is rejected: "Only integers are allows for primary key values").
function vecRowId(recordId) {
  return BigInt(recordId);
}

// nomic-embed-text has a 2048-token context. 8000 characters of dense text overflows it and the
// model answers "the input length exceeds the context length", so long records are sent at 6000
// characters and retried shorter if even that is too dense to fit.
const EMBED_CHAR_BUDGETS = [6000, 4000, 2000];

// Calls Ollama's local embedding model. Returns a Float32Array, or null if it's unavailable
// right now (Ollama not running, model not pulled, etc.) - callers must handle null gracefully.
async function embedText(text) {
  const full = String(text || '');
  if (!full.trim()) return null;

  for (let i = 0; i < EMBED_CHAR_BUDGETS.length; i++) {
    const budget = EMBED_CHAR_BUDGETS[i];
    try {
      const response = await fetch('http://127.0.0.1:11434/api/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, prompt: full.slice(0, budget) }),
      });

      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data.embedding) && data.embedding.length === EMBED_DIMENSIONS) {
          return new Float32Array(data.embedding);
        }
        console.warn('[RAG] Embedding response had an unexpected shape.');
        return null;
      }

      // Too much text for the model's context: try again with less of it.
      const problem = await response.json().catch(() => ({}));
      const message = problem && problem.error ? String(problem.error) : `HTTP ${response.status}`;
      if (/context length|too long|exceeds/i.test(message) && i < EMBED_CHAR_BUDGETS.length - 1) continue;

      console.warn(`[RAG] Embedding failed at ${budget} chars: ${message}`);
      return null;
    } catch (err) {
      console.warn('[RAG] Embedding call failed:', err.message);
      return null;
    }
  }
  return null;
}

function blobFromEmbedding(embedding) {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

// Stores (or replaces) the embedding for one record. No-op if vector search isn't available.
function upsertEmbedding(recordId, embedding) {
  if (!vectorSearchAvailable) return;
  db.prepare('DELETE FROM vec_records WHERE rowid = ?').run(vecRowId(recordId));
  db.prepare('INSERT INTO vec_records (rowid, embedding) VALUES (?, ?)').run(vecRowId(recordId), blobFromEmbedding(embedding));
}

function deleteEmbedding(recordId) {
  if (!vectorSearchAvailable) return;
  db.prepare('DELETE FROM vec_records WHERE rowid = ?').run(vecRowId(recordId));
}

// Embedding one record's content takes a couple of seconds, so it happens AFTER the record is
// already saved (the save itself never waits for it). All embedding work goes through one queue,
// so a bulk save (an inbox drop, an import) can't fire dozens of Ollama calls at once.
let embedQueue = Promise.resolve();
const embedPending = new Set(); // record ids already queued, so a re-save doesn't queue twice

function queueEmbedding(recordId, content) {
  if (!vectorSearchAvailable || !recordId || !content) return;
  if (embedPending.has(recordId)) return;
  embedPending.add(recordId);

  embedQueue = embedQueue.then(async () => {
    embedPending.delete(recordId);
    try {
      const embedding = await embedText(content);
      if (!embedding) {
        // Ollama is down or the model is missing; the startup sweep will pick this record up later
        console.warn(`[RAG] No embedding for record ${recordId} (embedding model unavailable).`);
        return;
      }
      upsertEmbedding(recordId, embedding);
    } catch (err) {
      console.warn(`[RAG] Could not embed record ${recordId}:`, err.message);
    }
  });
  embedQueue = embedQueue.catch(() => {});
}

// Records saved while Ollama was unavailable (or saved before RAG existed) have no embedding yet.
// This runs in the background after the server starts listening, and never blocks startup.
function sweepMissingEmbeddings() {
  if (!vectorSearchAvailable) return;
  let missing;
  try {
    missing = db.prepare(`
      SELECT r.id AS id, r.content AS content
      FROM records r
      LEFT JOIN vec_records v ON v.rowid = r.id
      WHERE v.rowid IS NULL
      ORDER BY r.last_updated DESC
    `).all();
  } catch (err) {
    console.warn('[RAG] Could not check for missing embeddings:', err.message);
    return;
  }
  if (missing.length === 0) {
    console.log('[RAG] All records have embeddings.');
    return;
  }
  console.log(`[RAG] ${missing.length} record(s) need an embedding; working through them in the background.`);
  for (const row of missing) queueEmbedding(row.id, row.content);
  embedQueue = embedQueue.then(() => {
    const left = db.prepare('SELECT COUNT(*) AS n FROM records r LEFT JOIN vec_records v ON v.rowid = r.id WHERE v.rowid IS NULL').get().n;
    console.log(left === 0 ? '[RAG] Embedding sweep finished; every record is searchable.' : `[RAG] Embedding sweep finished, ${left} record(s) still missing (will retry on next start).`);
  });
  embedQueue = embedQueue.catch(() => {});
}

// Finds the records that are closest in MEANING to a question, rather than by shared keywords.
// Returns { ok } so the caller can tell "the embedding model is unavailable, fall back to keyword
// search" apart from "it worked, and genuinely nothing is close enough" - those need different
// answers. `eligible` is the already-filtered candidate list (vault, site, form records).
async function findRecordsByMeaning(question, eligible, wanted) {
  if (!vectorSearchAvailable) return { ok: false, matches: [] };

  const embedding = await embedText(question);
  if (!embedding) return { ok: false, matches: [] };

  const byId = new Map(eligible.map((r) => [r.id, r]));
  let rows;
  try {
    // vec0 needs its LIMIT inside the KNN query itself, so the search runs alone in a CTE.
    // It asks for more candidates than are wanted, because some get filtered out below.
    rows = db.prepare(`
      WITH nearest AS (
        SELECT rowid AS id, distance
        FROM vec_records
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      )
      SELECT id, distance FROM nearest ORDER BY distance
    `).all(blobFromEmbedding(embedding), Math.max(wanted * 4, 15));
  } catch (err) {
    console.warn('[RAG] Vector search failed:', err.message);
    return { ok: false, matches: [] };
  }

  const matches = [];
  for (const row of rows) {
    if (row.distance > EMBED_MAX_DISTANCE) break; // sorted by distance, so the rest are worse still
    const record = byId.get(row.id);
    if (!record) continue; // filtered out: locked vault record, wrong site, or a form record
    matches.push({ record, distance: row.distance });
    if (matches.length >= wanted) break;
  }
  return { ok: true, matches };
}

// ---------------------------------------------------------------------------
// One-time backfill, run from the command line instead of starting the server:
//   node server.js --backfill-embeddings
// The server's own startup sweep does the same job in the background, but this gives you
// progress as it goes, doesn't need port 3000 to be free, and can be re-run any time (it only
// ever works on records that are still missing an embedding, so re-running is safe).
// ---------------------------------------------------------------------------
function listRecordsMissingEmbeddings() {
  return db.prepare(`
    SELECT r.id AS id, r.content AS content
    FROM records r
    LEFT JOIN vec_records v ON v.rowid = r.id
    WHERE v.rowid IS NULL
    ORDER BY r.id ASC
  `).all();
}

async function runBackfillCli(rebuildAll) {
  if (!vectorSearchAvailable) {
    console.error('Vector search is unavailable (sqlite-vec did not load), so there is nothing to back fill.');
    process.exit(1);
  }

  // A full rebuild matters when the embedding model or the character budget changes, so that every
  // record is represented the same way and their distances stay comparable.
  if (rebuildAll) {
    const had = db.prepare('SELECT COUNT(*) AS n FROM vec_records').get().n;
    db.exec('DELETE FROM vec_records');
    console.log(`Cleared ${had} existing embedding(s); rebuilding all of them from scratch.`);
  }

  const missing = listRecordsMissingEmbeddings();
  const total = db.prepare('SELECT COUNT(*) AS n FROM records').get().n;
  if (missing.length === 0) {
    console.log(`Nothing to do: all ${total} record(s) already have an embedding.`);
    process.exit(0);
  }

  console.log(`Backfilling embeddings for ${missing.length} of ${total} record(s), using ${EMBED_MODEL}.`);
  console.log('The first call also loads the model, so it takes a few seconds longer than the rest.\n');

  const startedAt = Date.now();
  let done = 0;
  let failed = 0;

  for (let i = 0; i < missing.length; i++) {
    const row = missing[i];
    const label = `[${i + 1}/${missing.length}] record #${row.id} (${row.content.length} chars)`;
    const t0 = Date.now();
    try {
      const embedding = await embedText(row.content);
      if (!embedding) {
        failed++;
        console.log(`${label} - SKIPPED, the embedding model did not respond`);
        continue;
      }
      upsertEmbedding(row.id, embedding);
      done++;
      console.log(`${label} - done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (err) {
      failed++;
      console.log(`${label} - FAILED: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nEmbedded ${done} record(s) in ${elapsed}s.`);
  if (failed > 0) {
    console.log(`${failed} record(s) could not be embedded. Check that Ollama is running and that "${EMBED_MODEL}" is pulled, then run this again - it will only retry the ones still missing.`);
  }

  const left = listRecordsMissingEmbeddings().length;
  console.log(left === 0 ? 'Every record is now searchable by meaning.' : `${left} record(s) still have no embedding.`);
  db.close();
  process.exit(failed > 0 ? 1 : 0);
}

// This must run before the Express app, inbox watcher and file scanner are set up, so a backfill
// run doesn't start a server, re-ingest the inbox, or scan the disk as a side effect.
//   node server.js --rebuild-embeddings   re-embeds every record, not just the missing ones
if (process.argv.includes('--backfill-embeddings') || process.argv.includes('--rebuild-embeddings')) {
  runBackfillCli(process.argv.includes('--rebuild-embeddings'));
  return; // stops the rest of this file from executing in a backfill run
}

try {
  db.exec("ALTER TABLE records ADD COLUMN category TEXT DEFAULT 'Uncategorized'");
} catch (_) {}
try {
  db.exec("ALTER TABLE records ADD COLUMN tags TEXT DEFAULT ''");
} catch (_) {}

// Middleware
app.use(express.json({ limit: '10mb' }));

// CORS for browser extension
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-vault-unlocked, x-vault-token, x-file-name, x-is-sensitive');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// The dashboard: index.html at the project root, plus its own app.js and style.css. Served
// explicitly, one route per file, so nothing else in the project root is exposed by name.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/app.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'app.js'));
});
app.get('/style.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'style.css'));
});

// Vault Authentication
app.post('/api/vault/unlock', (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ success: false, error: 'Not allowed.' });
  if (!VAULT_PIN) return res.status(503).json({ success: false, error: 'The Vault PIN has not been set up yet.' });
  const password = req.body && req.body.password;
  if (typeof password !== 'string' || password.length > 64) {
    return res.status(400).json({ success: false, error: 'Please enter your PIN.' });
  }
  failedUnlocks = failedUnlocks.filter((t) => Date.now() - t < 60000);
  if (failedUnlocks.length >= 5) {
    return res.status(429).json({ success: false, error: 'Too many attempts. Please wait a minute and try again.' });
  }
  const sha = (s) => crypto.createHash('sha256').update(s).digest();
  if (crypto.timingSafeEqual(sha(password), sha(VAULT_PIN))) {
    const token = crypto.randomBytes(32).toString('hex');
    vaultTokens.set(token, Date.now() + VAULT_TOKEN_TTL_MS);
    return res.json({ success: true, message: 'Vault unlocked.', token });
  }
  failedUnlocks.push(Date.now());
  return res.status(401).json({ success: false, error: 'Incorrect vault password.' });
});

// ---------------------------------------------------------------------------
// CHAT ATTACHMENTS: a file dropped into the Ask panel. Saved only when the user says so ("remember
// this"); the original file is kept so it can be reopened later through the existing file-open code.
// ---------------------------------------------------------------------------
const attachmentsDir = path.join(__dirname, 'rash-attachments');
if (!fs.existsSync(attachmentsDir)) fs.mkdirSync(attachmentsDir, { recursive: true });

const ATTACH_MAX_BYTES = 20 * 1024 * 1024;

function sanitizeAttachmentName(name) {
  let raw = String(name || '');
  // The panel sends the name URI-encoded, because a header can't carry arbitrary characters.
  // Decode it first: otherwise every % becomes _ below and "unit 3 chem.pdf" is stored as
  // "unit_203_20chem.pdf". Decoding before path.basename also means an encoded "..%2F" can't
  // smuggle a directory separator past the check.
  try { raw = decodeURIComponent(raw); } catch (_) { /* not encoded, or malformed - use as sent */ }
  const base = path.basename(raw).replace(/[^\w.\- ]+/g, '_').trim();
  return base ? base.slice(0, 150) : '';
}

// Real file type from its bytes, not the name or the header the client claims
function sniffAttachmentType(buf) {
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image'; // PNG
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image'; // JPEG
  if (buf.length >= 6 && buf.subarray(0, 3).toString('latin1') === 'GIF') return 'image'; // GIF
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image';

  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  if (sample.includes(0)) return null; // a NUL byte means this is not plain text
  let printable = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128) printable++;
  }
  return sample.length > 0 && printable / sample.length > 0.95 ? 'text' : null;
}

app.post('/api/attachments', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  if (!isStrictLocalRequest(req)) return res.status(403).json({ error: 'Not allowed.' });

  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || buf.length === 0) return res.status(400).json({ error: 'No file was received.' });
  if (buf.length > ATTACH_MAX_BYTES) {
    return res.status(413).json({ error: 'That file is larger than 20 MB. Please attach a smaller file.' });
  }

  const safeName = sanitizeAttachmentName(req.headers['x-file-name']);
  if (!safeName) return res.status(400).json({ error: 'Please include a valid file name.' });

  const kind = sniffAttachmentType(buf);
  if (kind === 'image') {
    return res.status(415).json({ error: "I can't save images yet, text extraction for images isn't set up. This will be added once that's approved." });
  }
  if (kind !== 'pdf' && kind !== 'text') {
    return res.status(415).json({ error: 'I can only save PDF or plain text files right now.' });
  }

  let text = '';
  try {
    if (kind === 'pdf') {
      const parsed = await pdfParse(buf);
      text = (parsed && parsed.text) ? String(parsed.text).trim() : '';
    } else {
      text = buf.toString('utf8').trim();
    }
  } catch (err) {
    console.error('[Attachments] Could not extract text:', err);
    return res.status(422).json({ error: 'I could not read the text inside that file.' });
  }
  if (!text) return res.status(422).json({ error: 'I could not find any readable text in that file.' });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const storedName = `${stamp}-${safeName}`;
  const storedPath = path.join(attachmentsDir, storedName);
  try {
    fs.writeFileSync(storedPath, buf);
  } catch (err) {
    console.error('[Attachments] Could not write the file to disk:', err);
    return res.status(500).json({ error: 'Could not save that file on this computer.' });
  }

  // Openable right away through the existing file-open code, without waiting for the next background scan
  try {
    const st = fs.statSync(storedPath);
    fileIndex.push({ name: storedName, folder: attachmentsDir, path: storedPath, size: st.size, modified: st.mtime.toISOString() });
  } catch (_) {}

  const isSensitive = req.headers['x-is-sensitive'] === 'true';
  const formName = `File: ${storedName}`;

  try {
    const { category, tags } = await autoClassifyContent(text, 'attachments');
    saveRecordToDb({ form_name: formName, category, tags, content: text, is_sensitive: isSensitive });
    return res.json({ success: true, message: 'Saved.', form_name: formName, category, tags, file: { name: safeName, path: storedPath } });
  } catch (err) {
    console.error('[Attachments] Could not add the record to the database:', err);
    return res.status(500).json({ error: 'The file was saved on this computer, but I could not add it to your records: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// CHAT ABOUT AN ATTACHED FILE: answering a question about a file in the moment. Nothing here
// saves anything - saving is still only the "remember this" flow through /api/attachments.
// ---------------------------------------------------------------------------

// One Tesseract worker, created on first use and then reused (starting one costs ~250ms). The
// library is required lazily so its WASM core is only loaded if an image is actually read.
let ocrWorker = null;
let ocrWorkerStarting = null;
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  if (!ocrWorkerStarting) {
    ocrWorkerStarting = (async () => {
      const { createWorker } = require('tesseract.js');
      // cachePath points at the language data shipped with RaSh, so this never reaches the network
      ocrWorker = await createWorker('eng', 1, { cachePath: OCR_TESSDATA_DIR, gzip: false });
      return ocrWorker;
    })().catch((err) => {
      ocrWorkerStarting = null;
      throw err;
    });
  }
  return ocrWorkerStarting;
}

// Below this, the reader is not reading words at all - measured 34 on a photo with no text.
const OCR_GARBAGE_CONFIDENCE = Number(process.env.RASH_OCR_GARBAGE_CONFIDENCE || 40);

// Tesseract on a picture with no writing in it returns things like "ZOZOZ" or one enormous
// run-on token. Catch that shape so it never reaches the user as if it were text.
function looksLikeOcrGarbage(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;

  const averageWordLength = words.reduce((total, w) => total + w.length, 0) / words.length;
  if (averageWordLength > 20) return true;

  // a short sequence repeated over and over, e.g. ZOZOZOZO
  if (/([A-Za-z0-9]{1,3})\1{3,}/.test(String(text).replace(/\s+/g, ''))) return true;

  return false;
}

// Reads printed text out of an image. usable is false when there is nothing worth reading, so the
// caller can fall back to describing the picture instead of quoting noise.
async function readTextFromImage(buffer) {
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(buffer);
  const text = String(data.text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const confidence = Math.round(data.confidence || 0);

  if (confidence < OCR_GARBAGE_CONFIDENCE || text.length < 8 || looksLikeOcrGarbage(text)) {
    return { text: '', confidence, usable: false };
  }
  if (confidence < OCR_MIN_CONFIDENCE) return { text: '', confidence, usable: false };
  return { text, confidence, usable: true };
}

// Describes a picture using the local vision model.
async function callOllamaVision(prompt, base64Image) {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: VISION_MODEL,
        prompt,
        images: [base64Image],
        stream: false,
        options: { temperature: 0.1, num_predict: 150 },
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const answer = data.response ? String(data.response).trim() : '';
    return answer || null; // the vision model sometimes returns an empty string
  } catch (err) {
    console.warn('[Vision] Call failed:', err.message);
    return null;
  }
}

// Pulls the text out of an attached PDF or text file so the panel can ask questions about it.
// Saves nothing, and is separate from /api/attachments on purpose.
app.post('/api/file-text', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  if (!isStrictLocalRequest(req)) return res.status(403).json({ error: 'Not allowed.' });

  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || buf.length === 0) return res.status(400).json({ error: 'No file was received.' });
  if (buf.length > ATTACH_MAX_BYTES) {
    return res.status(413).json({ error: 'That file is larger than 20 MB.' });
  }

  const kind = sniffAttachmentType(buf);
  if (kind === 'image') {
    return res.status(415).json({ error: 'Images are read with the image reader, not this one.' });
  }
  if (kind !== 'pdf' && kind !== 'text') {
    return res.status(415).json({ error: 'I can only read PDF or plain text files.' });
  }

  try {
    let text = '';
    if (kind === 'pdf') {
      const parsed = await pdfParse(buf);
      text = (parsed && parsed.text) ? String(parsed.text).trim() : '';
    } else {
      text = buf.toString('utf8').trim();
    }
    if (!text) return res.status(422).json({ error: 'I could not find any readable text in that file.' });
    return res.json({ kind, text: text.slice(0, 120000) });
  } catch (err) {
    console.error('[File text] Could not extract text:', err);
    return res.status(422).json({ error: 'I could not read the text inside that file.' });
  }
});

// A long PDF can't go to the model in one piece, so it is split into chunks of at most this many
// words. Timings depend heavily on the model in OLLAMA_MODEL and on this machine having no GPU.
const CHUNK_WORDS = 1500;
const CHUNK_SUMMARY_TOKENS = 60;
// Chunks are summarised one at a time on purpose. Two at once measured 34.8s against 7.6s
// sequential - Ollama serves one model at a time and thrashes when asked for more.
// The whole request also gets a budget, so a very long document degrades to a partial summary
// instead of running for minutes.
const SUMMARY_BUDGET_MS = Number(process.env.RASH_SUMMARY_BUDGET_MS || 150000);
const MAX_CHUNKS = 20;
// Sized to absorb an Ollama model swap: alternating between the question model and the summary
// model forces a reload of a multi-GB model, and the first chunk after a swap pays that cost.
// Time kept back so the final combining call can still run, the shortest call worth starting,
// and the most any single section may take. Measured in place on this CPU-only machine a single
// section summary runs 35-50s, so these keep the whole request near the ceiling.
const REDUCE_RESERVE_MS = Number(process.env.RASH_REDUCE_RESERVE_MS || 15000);
const MIN_CALL_MS = 4000;
const PER_CHUNK_MAX_MS = Number(process.env.RASH_PER_CHUNK_MAX_MS || 45000);

// Small models like to announce what they are about to do. Drop that opener so the answer starts
// with the actual content.
function stripSummaryPreamble(text) {
  return String(text || '')
    .replace(/^\s*(here (is|are)|this is|below is)[^:.]{0,80}[:.]\s*/i, '')
    .trim();
}

// Small models sometimes decline instead of answering. That is not a summary, so it must never
// reach the user as one. Covers straight and curly apostrophes.
const MODEL_REFUSAL = new RegExp([
  "i\\s*'?m\\s+unable\\s+to",                 // I'm unable to <anything>
  "i\\s+am\\s+unable\\s+to",
  "i\\s+(?:won'?t|will\\s+not)\\s+be\\s+able\\s+to",
  "i\\s+(?:can'?t|cannot|can\\s+not)\\s+(?:fulfill|fulfil|help|assist|comply|provide|complete|answer|summari[sz]e|do\\b)",
  "i\\s+apologi[sz]e,?\\s+but\\s+i\\s*(?:can'?t|cannot)",
  "i'?m\\s+sorry,?\\s+but\\s+i\\s*(?:can'?t|cannot)",
  "unable\\s+to\\s+(?:fulfill|fulfil)",
].join('|'), 'i');

function isRefusal(text) {
  const t = String(text || '').replace(/\u2019/g, "'").trim();
  if (!t) return false;
  return MODEL_REFUSAL.test(t);
}

function chunkByWords(text, maxWords) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += maxWords) chunks.push(words.slice(i, i + maxWords).join(' '));
  return chunks.length ? chunks : [''];
}

// "summarise this", "what is this about", "give me the gist" - questions about the whole document
// rather than one fact inside it.
const SUMMARY_QUESTION = /\b(summar(y|ise|ize|ising|izing)|overview|gist|tl;?dr|key\s+points?|main\s+points?|what'?s?\s+(this|it)\s+about|what\s+is\s+(this|it)\s+about|outline|recap)\b/i;

// For a specific question ("what is the total"), only the chunk that actually mentions the asked
// words is worth sending - searching all of them costs time and buys nothing.
function pickBestChunk(chunks, question) {
  const words = [...new Set(
    String(question).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !ASK_STOP_WORDS.has(w))
  )].map(stem);
  if (words.length === 0) return { chunk: chunks[0], index: 0, score: 0 };

  let best = { chunk: chunks[0], index: 0, score: -1 };
  chunks.forEach((chunk, index) => {
    const low = chunk.toLowerCase();
    let score = 0;
    for (const w of words) {
      const hits = low.split(w).length - 1;
      if (hits > 0) score += 5 + Math.min(hits, 10);
    }
    if (score > best.score) best = { chunk, index, score };
  });
  return best;
}

// Answers one question about an attached file. Three ways in, none of which store anything:
//   { question, text }           - a PDF/text file, or text already read out of an image
//   { question, image, mode:read } - read the printed text in an image, then answer from it
//   { question, image }          - describe the picture
app.post('/api/ask-file', async (req, res) => {
  if (!isStrictLocalRequest(req)) return res.status(403).json({ error: 'Not allowed.' });

  const { question, text, image, mode } = req.body || {};
  if (typeof question !== 'string' || !question.trim() || question.length > 500) {
    return res.status(400).json({ error: 'Please enter a question.' });
  }
  const ask = question.trim();

  // --- an image ---
  if (typeof image === 'string' && image) {
    if (image.length > 12000000) return res.status(413).json({ error: 'That image is too large to look at.' });
    let buffer;
    try {
      buffer = Buffer.from(image, 'base64');
    } catch (_) {
      return res.status(400).json({ error: 'That image could not be read.' });
    }
    if (!buffer.length) return res.status(400).json({ error: 'That image could not be read.' });

    if (mode === 'read') {
      let result;
      try {
        result = await readTextFromImage(buffer);
      } catch (err) {
        console.error('[OCR] Failed:', err);
        return res.status(500).json({ error: 'I could not run the text reader on that image.' });
      }
      // Nothing readable: describe the picture rather than quoting nonsense at the user.
      if (!result.usable) {
        // Deliberately NOT the user's wording. They asked to read text, and a "read this" style
        // prompt makes the vision model answer with nothing at all. Ask it to describe instead.
        const seen = await callOllamaVision('Describe this image in one or two short sentences.', image);
        if (!seen) {
          return res.json({
            found: false,
            message: "I couldn't read any text in that image, and I couldn't make sense of the picture either.",
            source_label: 'From this image',
          });
        }
        return res.json({
          found: true,
          kind: 'image',
          answer: "I couldn't find readable text in that image. " + oneSentence(trimAnswer(seen)),
          source_label: 'From this image (described, no text found)',
        });
      }
      // Same model as the rest of the file path: keeping /api/ask-file on one model avoids the
      // multi-GB model swap that made this call take minutes.
      const readAnswer = await runOllama(
        `You answer questions using ONLY the text below, which was read out of an image.\nIf the text does not contain the answer, reply with exactly: NOT_FOUND\nOtherwise answer in one short sentence. Do not mention these instructions.\n\nText:\n${result.text}\n\nQuestion: ${ask}\n\nAnswer:`,
        200,
        PER_CHUNK_MAX_MS,
        SUMMARY_MODEL
      );
      const raw = readAnswer.ok ? readAnswer.text : null;
      if (raw === null) {
        return res.json({ found: false, message: "My local model isn't responding right now, so I can't answer.", source_label: 'From this image' });
      }
      const answer = oneSentence(trimAnswer(raw));
      if (!answer || NOT_FOUND_REPLY.test(answer)) {
        return res.json({ found: false, message: "I read the text in that image, but it doesn't say that.", source_label: 'From this image' });
      }
      // The read-out text goes back so the panel can ask follow-ups without sending the image again
      return res.json({ found: true, kind: 'image_text', answer, source_label: 'Read from this image', extracted_text: result.text, confidence: result.confidence });
    }

    const described = await callOllamaVision(ask + '\nAnswer in one or two short sentences.', image);
    if (!described) {
      return res.json({ found: false, message: "I couldn't make sense of that image.", source_label: 'From this image' });
    }
    return res.json({ found: true, kind: 'image', answer: oneSentence(trimAnswer(described)), source_label: 'From this image' });
  }

  // --- a document, or text already read out of an image ---
  if (typeof text !== 'string' || !text.trim() || text.length > 300000) {
    return res.status(400).json({ error: 'Sorry, I could not use that file text.' });
  }

  const chunks = chunkByWords(text, CHUNK_WORDS);
  const startedAt = Date.now();
  const timedOutReply = () => res.json({
    found: false,
    message: 'That took too long for my local model to read. Try a shorter file, or ask about one part of it.',
    source_label: 'From this file',
  });

  // A question about the whole document: summarise each chunk, then summarise the summaries.
  if (SUMMARY_QUESTION.test(ask) && chunks.length > 1) {
    const summaries = [];
    let ranOutOfTime = false;
    let refusedSections = 0;

    for (let i = 0; i < Math.min(chunks.length, MAX_CHUNKS); i++) {
      // Keep time back for the final combining call, and never let one slow section eat the budget
      const remaining = SUMMARY_BUDGET_MS - (Date.now() - startedAt) - REDUCE_RESERVE_MS;
      if (remaining < MIN_CALL_MS) { ranOutOfTime = true; break; }

      const part = await runOllama(
        `Summarize the following section of a document in two short sentences. Do not add anything that is not in the text.

Section:
${chunks[i]}

Summary:`,
        CHUNK_SUMMARY_TOKENS,
        Math.min(remaining, PER_CHUNK_MAX_MS),
        SUMMARY_MODEL
      );

      // A section that times out is skipped, not fatal: a partial summary beats no answer at all
      if (part.timedOut) { ranOutOfTime = true; break; }
      if (!part.ok || !part.text) continue;

      // The model declined this section. Skip it and carry on with the rest - a refusal is not a
      // summary, and passing one through would show the user "I can't fulfill this request".
      if (isRefusal(part.text)) { refusedSections++; continue; }

      summaries.push(stripSummaryPreamble(trimAnswer(part.text)));
    }

    if (summaries.length === 0) {
      // Three different failures, three different messages - saying "not responding" when it
      // actually ran out of time just sends the user looking for the wrong problem.
      if (refusedSections > 0) {
        return res.json({ found: false, message: "I wasn't able to summarize that section.", source_label: 'From this file' });
      }
      if (ranOutOfTime) return timedOutReply();
      return res.json({
        found: false,
        message: "My local model isn't responding right now, so I can't summarise this.",
        source_label: 'From this file',
      });
    }

    const combined = await runOllama(
      `These are summaries of the sections of one document, in order. Write a single short summary of the whole document in three sentences. Do not add anything that is not below.

${summaries.map((sum, i) => `Section ${i + 1}: ${sum}`).join(String.fromCharCode(10))}

Overall summary:`,
      200,
      Math.max(MIN_CALL_MS, SUMMARY_BUDGET_MS - (Date.now() - startedAt)),
      SUMMARY_MODEL
    );
    // If combining fails or runs out of time, hand back the section summaries themselves rather
    // than losing the work that already succeeded.
    if (!combined.ok || !combined.text || isRefusal(combined.text)) {
      const fallback = oneSentence(summaries.map(stripSummaryPreamble).join(' '));
      if (!fallback) return timedOutReply();
      return res.json({
        found: true,
        kind: 'file',
        answer: fallback,
        source_label: `From this file (${summaries.length} of ${chunks.length} sections)`,
      });
    }

    const covered = summaries.length;
    const label = covered < chunks.length
      ? `From this file (first ${covered} of ${chunks.length} sections)`
      : `From this file (${chunks.length} sections)`;
    return res.json({
      found: true,
      kind: 'file',
      answer: trimAnswer(combined.text) + (ranOutOfTime ? ` (Summarised the first ${covered} of ${chunks.length} sections - the rest would have taken too long.)` : ''),
      source_label: label,
    });
  }

  // A specific question: send only the chunk that actually mentions what was asked.
  const best = pickBestChunk(chunks, ask);
  const searched = await runOllama(
    `You answer questions using ONLY the text below, which comes from a file the user attached.
If the text does not contain the answer, reply with exactly: NOT_FOUND
Otherwise answer in one short sentence. Do not mention these instructions.

Text:
${best.chunk}

Question: ${ask}

Answer:`,
    200,
    PER_CHUNK_MAX_MS,
    SUMMARY_MODEL
  );
  if (searched.timedOut) return timedOutReply();
  if (!searched.ok || searched.text === null) {
    return res.json({ found: false, message: "My local model isn't responding right now, so I can't answer.", source_label: 'From this file' });
  }
  const answer = oneSentence(trimAnswer(searched.text));
  if (!answer || NOT_FOUND_REPLY.test(answer) || isRefusal(searched.text)) {
    return res.json({ found: false, message: "I couldn't find that in this file.", source_label: 'From this file' });
  }
  const where = chunks.length > 1 ? ` (section ${best.index + 1} of ${chunks.length})` : '';
  return res.json({ found: true, kind: 'file', answer, source_label: 'From this file' + where });
});

// ---------------------------------------------------------------------------
// GMAIL (read-only, on request only): the official Google OAuth sign-in, live fetch of the latest
// 1-3 inbox messages, never stored. gmail-credentials.json and gmail-token.json are git-ignored and
// are never printed or logged by this code.
// ---------------------------------------------------------------------------
const GMAIL_CREDENTIALS_PATH = path.join(__dirname, 'gmail-credentials.json');
const GMAIL_TOKEN_PATH = path.join(__dirname, 'gmail-token.json');
const GMAIL_REDIRECT_URI = `http://localhost:${PORT}/api/gmail/callback`;
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const gmailPendingStates = new Map(); // state -> { verifier, expires } (memory only)
let gmailRecentCalls = []; // timestamps, for the rate limit

// A request must come from this machine, and if it names an origin, that origin must be trusted.
// The OAuth redirect Google sends the browser to has no Origin header, so it is judged on host alone.
function isGmailRequestAllowed(req) {
  if (!isLocalRequest(req)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin.startsWith('chrome-extension://') || origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
}

function loadGmailCredentials() {
  try {
    const raw = JSON.parse(fs.readFileSync(GMAIL_CREDENTIALS_PATH, 'utf8'));
    const c = raw.installed || raw.web;
    if (!c || !c.client_id || !c.client_secret) return null;
    return { clientId: c.client_id, clientSecret: c.client_secret };
  } catch (_) {
    return null;
  }
}

function loadGmailToken() {
  try { return JSON.parse(fs.readFileSync(GMAIL_TOKEN_PATH, 'utf8')); } catch (_) { return null; }
}
function saveGmailToken(tok) {
  fs.writeFileSync(GMAIL_TOKEN_PATH, JSON.stringify(tok, null, 2), { mode: 0o600 });
}
function clearGmailToken() {
  try { fs.unlinkSync(GMAIL_TOKEN_PATH); } catch (_) {}
}

// Exchanges the refresh token for a fresh access token, reusing the cached one while it is still valid
async function getGmailAccessToken() {
  const creds = loadGmailCredentials();
  const token = loadGmailToken();
  if (!creds || !token || !token.refresh_token) return null;
  if (token.access_token && token.expiry && token.expiry - Date.now() > 60000) return token.access_token;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId, client_secret: creds.clientSecret,
        refresh_token: token.refresh_token, grant_type: 'refresh_token',
      }),
    });
    const data = await r.json();
    if (!r.ok || !data.access_token) return null;
    const updated = { refresh_token: token.refresh_token, access_token: data.access_token, expiry: Date.now() + (data.expires_in || 3600) * 1000 };
    saveGmailToken(updated);
    return updated.access_token;
  } catch (_) {
    return null;
  }
}

function gmailHtmlPage(message) {
  return '<!doctype html><html><body style="font-family:sans-serif;padding:40px;text-align:center;">' +
    '<p>' + String(message).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</p>' +
    '<p>You can close this tab.</p></body></html>';
}

app.get('/api/gmail/status', (req, res) => {
  if (!isGmailRequestAllowed(req)) return res.status(403).json({ error: 'Not allowed.' });
  const token = loadGmailToken();
  res.json({ configured: !!loadGmailCredentials(), connected: !!(token && token.refresh_token) });
});

app.post('/api/gmail/connect', (req, res) => {
  if (!isGmailRequestAllowed(req)) return res.status(403).json({ error: 'Not allowed.' });
  const creds = loadGmailCredentials();
  if (!creds) return res.status(503).json({ error: 'gmail-credentials.json was not found. Please finish the Google Cloud setup first.' });

  const now = Date.now();
  for (const [key, val] of gmailPendingStates) if (val.expires < now) gmailPendingStates.delete(key);

  const state = crypto.randomBytes(24).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  gmailPendingStates.set(state, { verifier, expires: now + 10 * 60 * 1000 });

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', creds.clientId);
  url.searchParams.set('redirect_uri', GMAIL_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  res.json({ url: url.toString() });
});

app.get('/api/gmail/callback', async (req, res) => {
  if (!isGmailRequestAllowed(req)) return res.status(403).send('Not allowed.');
  const { code, state, error } = req.query;

  if (error) return res.send(gmailHtmlPage('Google sign-in was cancelled or failed: ' + String(error).slice(0, 200)));
  if (typeof code !== 'string' || code.length > 2048 || typeof state !== 'string' || state.length > 128) {
    return res.send(gmailHtmlPage('Something went wrong with the sign-in link. Please try connecting again.'));
  }
  const pending = gmailPendingStates.get(state);
  gmailPendingStates.delete(state);
  if (!pending || pending.expires < Date.now()) {
    return res.send(gmailHtmlPage('This sign-in link has expired. Please try connecting again.'));
  }
  const creds = loadGmailCredentials();
  if (!creds) return res.send(gmailHtmlPage('gmail-credentials.json is missing.'));

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: creds.clientId, client_secret: creds.clientSecret,
        redirect_uri: GMAIL_REDIRECT_URI, grant_type: 'authorization_code', code_verifier: pending.verifier,
      }),
    });
    const tok = await tokenRes.json();
    const existing = loadGmailToken();
    const refresh_token = tok.refresh_token || (existing && existing.refresh_token);
    if (!tokenRes.ok || !tok.access_token || !refresh_token) {
      return res.send(gmailHtmlPage('Google did not confirm the sign-in. Please try connecting again.'));
    }
    saveGmailToken({ refresh_token, access_token: tok.access_token, expiry: Date.now() + (tok.expires_in || 3600) * 1000 });
    return res.send(gmailHtmlPage('Gmail connected. RaSh can now show your latest emails when you ask.'));
  } catch (err) {
    return res.send(gmailHtmlPage('Could not reach Google. Please check your connection and try again.'));
  }
});

// Gmail sends the body as base64url, not standard base64: '-' instead of '+', '_' instead of
// '/', and the trailing '=' padding stripped. All three have to be corrected before decoding.
function decodeBase64Url(data) {
  if (!data) return '';
  const raw = String(data).replace(/=+$/, ''); // Gmail sometimes sends this already padded, sometimes not
  if (!/^[A-Za-z0-9_-]*$/.test(raw)) return ''; // anything left over means this wasn't base64url at all
  let normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4 !== 0) normalized += '=';
  try {
    return Buffer.from(normalized, 'base64').toString('utf8');
  } catch (_) {
    return '';
  }
}

// A message's body can be a single part (payload.body.data directly) or a MIME tree
// (multipart/mixed containing multipart/alternative containing text/plain + text/html, plus
// attachment parts mixed in). This walks the whole tree and returns the first text/plain part
// found anywhere, or the first text/html part if no plain-text part exists at all.
// Never the human-visible body: delivery-status diagnostics, a forwarded message's raw headers,
// or a nested full message (a bounce report embeds the original email as its own message/rfc822 part).
const NON_BODY_MIME = /^(message\/|text\/rfc822-headers)/i;

function findEmailBody(payload) {
  if (!payload) return { mimeType: '', data: '' };

  let htmlFallback = null;

  // Left-to-right, depth-first: text/plain found earlier in the document always wins over one
  // found later, and a branch is only descended into after its own node has been checked.
  function walk(node) {
    if (!node) return null;
    const mimeType = String(node.mimeType || '').toLowerCase();
    if (NON_BODY_MIME.test(mimeType)) return null;

    const data = node.body && node.body.data;
    if (mimeType === 'text/plain' && data) return { mimeType: 'text/plain', data };
    if (mimeType === 'text/html' && data && !htmlFallback) htmlFallback = { mimeType: 'text/html', data };

    if (Array.isArray(node.parts)) {
      for (const child of node.parts) {
        const found = walk(child);
        if (found) return found;
      }
    }
    return null;
  }

  return walk(payload) || htmlFallback || { mimeType: '', data: '' };
}

// Turns HTML into plain text: drops anything not meant to be read (script/style, and every <img> -
// this also removes 1x1 tracking pixels, since they are just an <img> tag with no visible content
// anyway), converts block-level tags to line breaks, then decodes the handful of HTML entities
// that show up in real email.
function stripHtmlToText(html) {
  let text = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/?(p|div|tr|h[1-6])[^>]*>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, ' ');

  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));

  return text.replace(/[ \t]+/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Signatures, unsubscribe footers and tracking links are noise, not content, and specifically
// asked to be stripped before an email is saved as a memory.
const SIGNATURE_CUT = /\n--\s?\n[\s\S]*$/; // the RFC 3676 "-- " signature delimiter, on its own line
const MOBILE_SIGNATURE = /\n(sent from my [^\n]{0,40}|get outlook for [^\n]{0,20})\s*$/i;

function stripSignatureAndFooters(text) {
  let out = String(text || '');
  out = out.replace(SIGNATURE_CUT, '');
  out = out.replace(MOBILE_SIGNATURE, '');
  out = out
    .split('\n')
    .filter((line) => !/unsubscribe|update (your )?(email )?preferences|view (this )?(email|message) in (your )?browser|opt.?out of (these|this)/i.test(line))
    .join('\n');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// The full pipeline: pick the best part, decode it, convert HTML if that's what we got, strip
// signatures/footers, and cap the length the same way other saved content is capped elsewhere.
function extractEmailBody(payload) {
  const part = findEmailBody(payload);
  if (!part.data) return '';
  const decoded = decodeBase64Url(part.data);
  const plain = part.mimeType === 'text/html' ? stripHtmlToText(decoded) : decoded.replace(/\r\n/g, '\n').trim();
  return stripSignatureAndFooters(plain).slice(0, 20000);
}

function decodeGmailHeader(headers, name) {
  const h = (headers || []).find((x) => x.name && x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

app.get('/api/gmail/recent', async (req, res) => {
  if (!isGmailRequestAllowed(req)) return res.status(403).json({ error: 'Not allowed.' });

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 3;
  limit = Math.min(limit, 3);

  let from = req.query.from;
  if (from !== undefined && from !== '') {
    from = String(from).slice(0, 80);
    if (!/^[a-zA-Z0-9@._'\- ]+$/.test(from)) {
      return res.status(400).json({ error: 'Please use only letters, numbers and @ . _ - in a sender name.' });
    }
  } else {
    from = '';
  }

  const now = Date.now();
  gmailRecentCalls = gmailRecentCalls.filter((t) => now - t < 60000);
  if (gmailRecentCalls.length >= 20) {
    return res.status(429).json({ error: 'Too many Gmail requests. Please wait a moment and try again.' });
  }
  gmailRecentCalls.push(now);

  const accessToken = await getGmailAccessToken();
  if (!accessToken) return res.json({ connected: false, message: 'Gmail is not connected yet.' });

  try {
    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    listUrl.searchParams.set('maxResults', String(limit));
    listUrl.searchParams.set('q', from ? `in:inbox from:(${from})` : 'in:inbox');
    const listRes = await fetch(listUrl, { headers: { Authorization: 'Bearer ' + accessToken } });
    const listData = await listRes.json();
    if (!listRes.ok) return res.json({ connected: true, found: false, message: 'Gmail did not return your messages right now.' });

    const ids = (listData.messages || []).map((m) => m.id).slice(0, limit);
    if (ids.length === 0) return res.json({ connected: true, found: true, emails: [] });

    const nowDate = new Date();
    const emails = [];
    for (const id of ids) {
      // format=full is needed to get the message body, not just headers - still covered by the
      // gmail.readonly scope already granted, no re-consent required.
      const mUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`;
      const mRes = await fetch(mUrl, { headers: { Authorization: 'Bearer ' + accessToken } });
      if (!mRes.ok) continue;
      const mData = await mRes.json();
      const headers = mData.payload && mData.payload.headers;
      const when = (() => {
        const d = new Date(decodeGmailHeader(headers, 'Date'));
        return isNaN(d.getTime()) ? '' : whenText(d, nowDate);
      })();
      const sender = decodeGmailHeader(headers, 'From').replace(/<.*?>/g, '').replace(/"/g, '').trim().slice(0, 120) || 'Unknown sender';
      const subject = decodeGmailHeader(headers, 'Subject').slice(0, 200) || '(no subject)';
      const body = extractEmailBody(mData.payload);

      // Saved as a normal record, fully searchable (RAG, keyword, and MCP) - this account has
      // explicitly asked for email content to be part of what RaSh and Cursor can search.
      if (body) {
        try {
          saveRecordToDb({
            form_name: `Email: ${subject} from ${sender} (${id})`,
            category: 'Email',
            tags: '',
            content: body,
            is_sensitive: 0,
          });
        } catch (err) {
          console.warn('[Gmail] Could not save email as a record:', err.message);
        }
      }

      emails.push({
        from: sender,
        subject,
        preview: String(mData.snippet || '').slice(0, 200),
        when,
      });
    }
    res.json({ connected: true, found: emails.length > 0, emails });
  } catch (err) {
    res.status(500).json({ error: 'Could not reach Gmail right now.' });
  }
});

app.post('/api/gmail/disconnect', async (req, res) => {
  if (!isGmailRequestAllowed(req)) return res.status(403).json({ error: 'Not allowed.' });
  const token = loadGmailToken();
  if (token && token.refresh_token) {
    try {
      await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(token.refresh_token), { method: 'POST' });
    } catch (_) {}
  }
  clearGmailToken();
  res.json({ success: true, message: 'Gmail disconnected.' });
});

// Autonomous folder classifier using local Ollama
async function autoClassifyContent(text, hintPath = '') {
  try {
    const prompt = `Analyze this text${hintPath ? ` (found in folder path: ${hintPath})` : ''} and assign:
1. A high-level folder category (1 to 3 words maximum, e.g., Sports, College, Personal ID, Finance, Tech, Health).
2. Up to 3 relevant comma-separated tags.

Format your response strictly as:
CATEGORY: <category name>
TAGS: <tag1, tag2, tag3>

Text:
${text.slice(0, 1000)}

Classification:`;

    const response = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 40
        }
      })
    });

    if (!response.ok) throw new Error('Ollama offline');
    const data = await response.json();
    const output = data.response || '';

    const categoryMatch = output.match(/CATEGORY:\s*([^\n\r]+)/i);
    const tagsMatch = output.match(/TAGS:\s*([^\n\r]+)/i);

    const category = categoryMatch ? categoryMatch[1].trim().replace(/[".]/g, '') : 'General';
    const tags = tagsMatch ? tagsMatch[1].trim().replace(/[".]/g, '') : '';

    return { category, tags };
  } catch (err) {
    console.warn('[Auto-Classifier] Ollama fallback:', err.message);
    return { category: 'General', tags: '' };
  }
}

// Database upsert helper
function saveRecordToDb({ form_name, category, tags, content, is_sensitive }) {
  const upsertStmt = db.prepare(`
    INSERT INTO records (form_name, category, tags, content, is_sensitive, last_updated)
    VALUES (@form_name, @category, @tags, @content, @is_sensitive, CURRENT_TIMESTAMP)
    ON CONFLICT(form_name) DO UPDATE SET
      category = excluded.category,
      tags = excluded.tags,
      content = excluded.content,
      is_sensitive = excluded.is_sensitive,
      last_updated = CURRENT_TIMESTAMP
    RETURNING id
  `);

  const row = upsertStmt.get({
    form_name,
    category: category || 'General',
    tags: tags || '',
    content,
    is_sensitive: is_sensitive ? 1 : 0,
  });

  // The save is already done at this point. Its embedding is generated afterwards, in the
  // background, so saving never waits on the embedding model. A re-saved record is re-embedded,
  // so an edited page never keeps a stale vector.
  if (row && row.id) queueEmbedding(row.id, content);
  return row ? row.id : null;
}

// Offline Inbox Directory Watcher (Text + Markdown + PDF)
const inboxDir = path.join(__dirname, 'rash-inbox');
if (!fs.existsSync(inboxDir)) {
  fs.mkdirSync(inboxDir, { recursive: true });
}

const watcher = chokidar.watch(inboxDir, {
  ignored: /(^|[\/\\])\../,
  persistent: true,
  ignoreInitial: false,
  depth: 10
});

watcher.on('add', async (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  const allowedTextExt = ['.txt', '.md', '.json', '.csv', '.log'];

  try {
    let rawContent = '';

    if (allowedTextExt.includes(ext)) {
      rawContent = fs.readFileSync(filePath, 'utf8');
    } else if (ext === '.pdf') {
      const dataBuffer = fs.readFileSync(filePath);
      const parsed = await pdfParse(dataBuffer);
      rawContent = (parsed && parsed.text) ? String(parsed.text) : '';
    } else {
      return;
    }

    if (!rawContent || !rawContent.trim()) return;

    const relativePath = path.relative(inboxDir, filePath);
    const formName = `File: ${relativePath}`;
    const subfolderHint = path.dirname(relativePath) !== '.' ? path.dirname(relativePath) : '';

    console.log(`[Auto-Ingest] Detected: ${relativePath}`);
    const { category, tags } = await autoClassifyContent(rawContent, subfolderHint);

    saveRecordToDb({
      form_name: formName,
      category,
      tags,
      content: rawContent.trim(),
      is_sensitive: 0
    });

    console.log(`[Auto-Ingest] Ingested "${relativePath}" -> [${category}]`);
  } catch (err) {
    console.error(`[Auto-Ingest Error] Failed processing ${filePath}:`, err.message);
  }
});

// ---------------------------------------------------------------------------
// FILE FINDER: index file NAMES and LOCATIONS (never file contents) so the
// user can ask "where is my Unit 3 assignment?" and get the matching file.
// ---------------------------------------------------------------------------
const homeDir = os.homedir();
const oneDriveDir = process.env.OneDrive || process.env.OneDriveConsumer || '';
const candidateRoots = [
  path.join(homeDir, 'Documents'),
  path.join(homeDir, 'Downloads'),
  path.join(homeDir, 'Desktop'),
  path.join(homeDir, 'Pictures'),
  oneDriveDir ? path.join(oneDriveDir, 'Documents') : '',
  oneDriveDir ? path.join(oneDriveDir, 'Desktop') : '',
  inboxDir,
  attachmentsDir
].filter(Boolean);

const fileRoots = [...new Set(candidateRoots.map((p) => path.resolve(p)))].filter((p) => fs.existsSync(p));

const FILE_MAX_COUNT = 100000;
const FILE_MAX_DEPTH = 6;
const HOME_MAX_DEPTH = 4; // the rest of the user home folder is scanned this many levels deep
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'appdata', '$recycle.bin', '__pycache__',
  'program files', 'program files (x86)', 'programdata', 'windows', 'system volume information',
  'system32', 'winsxs', 'application data', 'local settings', 'cookies', 'nethood', 'printhood',
  'recent', 'sendto', 'start menu', 'site-packages',
]);

let fileIndex = [];
// The home folder is scanned too, but only the main folders above count as "watched" for open-file
let fileIndexInfo = { scanning: false, lastScan: null, roots: [...new Set([...fileRoots, path.resolve(homeDir)])] };

async function scanFiles() {
  if (fileIndexInfo.scanning) return;
  fileIndexInfo.scanning = true;

  const found = [];
  const seen = new Set();
  // Stack is last-in-first-out: the home scan goes first so it is handled last, and the main folders keep priority
  const stack = [
    { dir: path.resolve(homeDir), depth: 0, max: HOME_MAX_DEPTH },
    ...fileRoots.map((dir) => ({ dir, depth: 0, max: FILE_MAX_DEPTH })),
  ];

  try {
    while (stack.length > 0 && found.length < FILE_MAX_COUNT) {
      const { dir, depth, max } = stack.pop();
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (depth < max && !SKIP_DIRS.has(entry.name.toLowerCase())) {
            stack.push({ dir: full, depth: depth + 1, max });
          }
        } else if (entry.isFile()) {
          if (entry.name.toLowerCase() === 'desktop.ini') continue;
          const key = full.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          try {
            const st = await fs.promises.stat(full);
            found.push({
              name: entry.name,
              folder: dir,
              path: full,
              size: st.size,
              modified: st.mtime.toISOString()
            });
          } catch (_) {}
        }
      }
    }
    fileIndex = found;
    fileIndexInfo.lastScan = new Date().toISOString();
  } finally {
    fileIndexInfo.scanning = false;
  }
}

const FINDER_STOP_WORDS = new Set([
  'give', 'me', 'my', 'the', 'a', 'an', 'of', 'please', 'file', 'files', 'where',
  'is', 'are', 'find', 'show', 'i', 'have', 'can', 'you', 'get', 'send', 'open',
  'to', 'for', 'in', 'on', 'that', 'this', 'it', 'was', 'and'
]);

function searchFiles(query) {
  const words = String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FINDER_STOP_WORDS.has(w));

  if (words.length === 0) return [];

  const compactQuery = words.join('');
  const results = [];

  for (const f of fileIndex) {
    const nameLower = f.name.toLowerCase();
    const compactName = nameLower.replace(/[^a-z0-9]/g, '');
    const folderLower = f.folder.toLowerCase();

    let score = 0;
    let matched = 0;

    for (const w of words) {
      if (nameLower.includes(w)) {
        score += 10;
        matched++;
      } else if (folderLower.includes(w)) {
        score += 3;
        matched++;
      }
    }

    if (compactName.includes(compactQuery)) score += 30;
    if (matched === words.length) score += 15;

    if (score > 0 && matched >= Math.ceil(words.length / 2)) {
      results.push({ file: f, score });
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.file.modified) - new Date(a.file.modified);
  });

  return results.slice(0, 5).map((r) => ({
    name: r.file.name,
    folder: r.file.folder,
    path: r.file.path,
    size_kb: Math.max(1, Math.round(r.file.size / 1024)),
    modified: r.file.modified
  }));
}

// Only the RaSh extension and RaSh's own localhost pages may use the file finder
function isTrustedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return (
    origin.startsWith('chrome-extension://') ||
    origin === `http://localhost:${PORT}` ||
    origin === `http://127.0.0.1:${PORT}`
  );
}

function handleFindFile(req, res) {
  if (!isTrustedOrigin(req)) {
    return res.status(403).json({ error: 'Not allowed.' });
  }

  const query = (req.method === 'POST' ? (req.body && req.body.query) : req.query.q) || '';
  if (!String(query).trim()) {
    return res.status(400).json({ error: 'Please tell me which file to find.' });
  }

  const results = searchFiles(query);
  if (results.length === 0) {
    return res.json({
      found: false,
      message: 'I could not find a matching file in your Documents, Downloads, Desktop or home folder.'
    });
  }

  res.json({
    found: true,
    answer: `Best match: ${results[0].name} in ${results[0].folder}`,
    results
  });
}

app.get('/api/find-file', handleFindFile);
app.post('/api/find-file', handleFindFile);

app.get('/api/files/status', (req, res) => {
  if (!isTrustedOrigin(req)) {
    return res.status(403).json({ error: 'Not allowed.' });
  }
  res.json({
    indexed_files: fileIndex.length,
    scanning: fileIndexInfo.scanning,
    last_scan: fileIndexInfo.lastScan,
    folders: fileIndexInfo.roots
  });
});

// Open a found file on this laptop in its normal app (or show it in its folder).
// Safety: only files already in RaSh's index, only from the extension or localhost,
// and never program/script files.
const BLOCKED_OPEN_EXT = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.ps1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.scr', '.lnk', '.jar', '.reg', '.hta', '.cpl',
  '.msc', '.pif', '.url', '.chm', '.appx', '.msix', '.msp', '.scf', '.inf', '.application',
  '.gadget', '.psm1', '.wsc', '.wsh', '.py', '.pyw', '.docm', '.xlsm', '.pptm'
]);

// Turn a raw launch failure into a short message the panel can show to the user
function friendlyOpenError(raw) {
  const msg = String(raw || '').replace(/\s+/g, ' ').trim();
  if (/no application is associated|no app is associated/i.test(msg)) {
    return 'No app on this computer is set up to open this type of file. Use "Show in folder" instead.';
  }
  if (/being used by another process|access is denied|not have permission/i.test(msg)) {
    return 'Windows blocked access to this file. It may be in use or protected. Use "Show in folder" instead.';
  }
  if (/timed out/i.test(msg)) {
    return 'Windows took too long to open this file. Try again, or use "Show in folder".';
  }
  return 'Your computer could not open this file' + (msg ? ': ' + msg.slice(0, 140) : '.');
}

app.post('/api/open-file', async (req, res) => {
  if (!isTrustedOrigin(req)) {
    return res.status(403).json({ error: 'Not allowed.' });
  }

  const target = req.body && req.body.path;
  const reveal = !!(req.body && req.body.reveal);
  if (!target) {
    return res.status(400).json({ error: 'No file given.' });
  }

  const resolved = path.resolve(String(target));
  const wanted = resolved.toLowerCase();
  let entry = fileIndex.find((f) => path.resolve(f.path).toLowerCase() === wanted);

  // Files created since the last scan are still fine if they sit inside a folder RaSh watches
  if (!entry) {
    const insideRoot = fileRoots.some((root) => {
      const rel = path.relative(root, resolved);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (insideRoot && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      entry = { name: path.basename(resolved), path: resolved };
    }
  }

  if (!entry) {
    return res.status(404).json({ error: 'That file is not in the RaSh file list.' });
  }
  if (!fs.existsSync(entry.path)) {
    return res.status(404).json({ error: 'That file no longer exists. It may have been moved or deleted.' });
  }

  const ext = path.extname(entry.path).toLowerCase();
  if (!reveal && BLOCKED_OPEN_EXT.has(ext)) {
    return res.status(400).json({ error: 'For safety, RaSh will not run this type of file. Use show in folder instead.' });
  }

  const finish = (err) => {
    if (err) {
      console.error('[Open File] Failed:', entry.path, '-', err);
      return res.status(500).json({ error: friendlyOpenError(err) });
    }
    res.json({ success: true, opened: entry.name, reveal });
  };

  if (process.platform === 'win32') {
    if (reveal) {
      // Explorer needs the path quoted exactly as ["path"]; it also exits with code 1 on success
      execFile('explorer.exe', ['/select,"' + entry.path + '"'], { windowsVerbatimArguments: true }, () => finish(null));
      return;
    }
    // Start-Process -FilePath opens the file with its default app. The path travels in an
    // environment variable, never inside the command text, so spaces, quotes, brackets and &
    // in file names cannot break or inject into the command. A failure prints a clean message.
    execFile(
      'powershell.exe',
      [
        '-NoProfile', '-NonInteractive', '-Command',
        'try { Start-Process -FilePath $env:RASH_OPEN_PATH -ErrorAction Stop } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }'
      ],
      { env: { ...process.env, RASH_OPEN_PATH: entry.path }, windowsHide: true, timeout: 15000 },
      (err, stdout, stderr) => finish(err ? (err.killed ? 'timed out' : (String(stderr || '').trim() || err.message)) : null)
    );
    return;
  }
  if (process.platform === 'darwin') {
    execFile('open', reveal ? ['-R', entry.path] : [entry.path], (err) => finish(err ? err.message : null));
    return;
  }
  execFile('xdg-open', [reveal ? path.dirname(entry.path) : entry.path], (err) => finish(err ? err.message : null));
});

// Auto-sort existing uncategorized records using Ollama
app.post('/api/auto-sort', async (req, res) => {
  try {
    const uncatRecords = db.prepare("SELECT * FROM records WHERE category = 'Uncategorized' OR category = 'Unknown' OR category IS NULL").all();

    for (const record of uncatRecords) {
      const { category, tags } = await autoClassifyContent(record.content);
      db.prepare("UPDATE records SET category = ?, tags = ? WHERE id = ?").run(category, tags, record.id);
    }

    res.json({ success: true, count: uncatRecords.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all records
app.get('/api/records', (req, res) => {
  const isUnlocked = vaultUnlocked(req);

  try {
    const stmt = db.prepare('SELECT * FROM records ORDER BY last_updated DESC');
    const records = stmt.all().map((rec) => {
      if (rec.is_sensitive === 1 && !isUnlocked) {
        return {
          ...rec,
          content: '🔒 LOCKED CONTENT — Enter your Vault PIN to view.',
        };
      }
      return rec;
    });
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save or auto-classify record
app.post('/api/records', async (req, res) => {
  let { form_name, content, is_sensitive, category, tags } = req.body;

  if (!form_name || !content) {
    return res.status(400).json({ error: 'Title and content are required.' });
  }

  if (!category || category === 'Uncategorized') {
    const classification = await autoClassifyContent(content);
    category = classification.category;
    tags = classification.tags;
  }

  try {
    saveRecordToDb({ form_name, category, tags, content, is_sensitive });
    res.json({ success: true, message: 'Record saved.', category, tags });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete record
app.delete('/api/records/:id', (req, res) => {
  const { id } = req.params;
  try {
    const stmt = db.prepare('DELETE FROM records WHERE id = ?');
    stmt.run(id);
    deleteEmbedding(id); // don't leave an orphan vector behind
    res.json({ success: true, message: 'Record deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export records
app.get('/api/export', (req, res) => {
  const isUnlocked = vaultUnlocked(req);

  try {
    const records = isUnlocked
      ? db.prepare('SELECT * FROM records ORDER BY id ASC').all()
      : db.prepare('SELECT * FROM records WHERE is_sensitive = 0 ORDER BY id ASC').all();

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="rash-backup.json"');
    res.json({
      exported_at: new Date().toISOString(),
      vault_included: isUnlocked,
      total_records: records.length,
      records,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import records
app.post('/api/import', (req, res) => {
  const { records } = req.body;

  if (!Array.isArray(records)) {
    return res.status(400).json({ error: 'Invalid backup format.' });
  }

  try {
    const insertMany = db.transaction((items) => {
      let count = 0;
      for (const item of items) {
        if (item.form_name && item.content) {
          saveRecordToDb({
            form_name: item.form_name,
            category: item.category || 'General',
            tags: item.tags || '',
            content: item.content,
            is_sensitive: item.is_sensitive ? 1 : 0,
          });
          count++;
        }
      }
      return count;
    });

    const importedCount = insertMany(records);
    res.json({ success: true, message: `Successfully imported ${importedCount} records.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// ASK: answer questions from saved memories using the local Ollama model.
// ---------------------------------------------------------------------------
// Every Ollama call gets a deadline. Without one a stalled model leaves the request hanging
// forever, which is worse than a clear failure. Returns whether it timed out so the caller can say so.
const OLLAMA_TIMEOUT_MS = Number(process.env.RASH_OLLAMA_TIMEOUT_MS || 60000);

async function runOllama(prompt, numPredict, timeoutMs, model) {
  const controller = new AbortController();
  const limit = timeoutMs || OLLAMA_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    const response = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: numPredict, num_ctx: 4096 },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, timedOut: false, text: null };
    const data = await response.json();
    const text = data.response ? data.response.trim().replace(/^["']|["']$/g, '') : null;
    return { ok: text !== null, timedOut: false, text };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    console.error(timedOut ? `Ollama call timed out after ${limit}ms` : 'Ollama query failed: ' + err.message);
    return { ok: false, timedOut, text: null };
  } finally {
    clearTimeout(timer);
  }
}

// Unchanged contract for every existing caller: the answer, or null if it didn't work.
async function callOllama(prompt, numPredict) {
  const result = await runOllama(prompt, numPredict);
  return result.ok ? result.text : null;
}

const ASK_STOP_WORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'article', 'articles',
  'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'find', 'for',
  'from', 'get', 'give', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'last', 'latest', 'long', 'many', 'me', 'much', 'my', 'of', 'on', 'or', 'page', 'pages', 'please',
  'read', 'recent', 'recently', 'said', 'saw', 'saved', 'show', 'so', 'tell', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up', 'us', 'visited', 'was', 'we', 'were',
  'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'will', 'with', 'would', 'write', 'wrote',
  'you', 'your',
]);

// "what was the last article I read", "most recent page I visited", ...
const RECENT_INTENT = /\b(last|latest|recent(ly)?|previous|just)\b[^.?!]*\b(article|page|site|website|tab|thing|post|blog|video|read|visited|opened|browsed|saw|watched|saved|looked|search|searched|googled)\b|\bwhat (did|was) i (just )?(read|reading|visit|visited|look|looked|browse|browsed)\b/i;
const SEARCH_PAGE = /(google|bing|duckduckgo|yahoo|ecosia|brave)\.[a-z.]+\/(search|\?q=)|[?&]q=/i;

// Crude stemmer so "originate" also matches "origin/originated" and "founders" matches "founder".
function stem(word) {
  for (const suf of ['ations', 'ation', 'ating', 'ated', 'ate', 'ing', 'ies', 'es', 'ed', 's']) {
    if (word.endsWith(suf) && word.length - suf.length >= 4) return word.slice(0, -suf.length);
  }
  return word;
}

function recordTitle(record) {
  return String(record.form_name || '').replace(/^Web:\s*/i, '').trim();
}

function recordUrl(record) {
  const m = String(record.content || '').match(/^Source:\s*(https?:\/\/\S+)/i);
  return m ? m[1] : '';
}

function recordBody(record) {
  return String(record.content || '').replace(/^Source:\s*\S+\s*/i, '').trim();
}

// Pick the passages of a record that best match the question (instead of the first N chars).
function bestPassages(body, words, maxChars) {
  const chunks = body
    .split(/\n{2,}|\n(?=[A-Z0-9])/)
    .map((c) => c.trim())
    .filter((c) => c.length > 30);
  if (chunks.length === 0) return body.slice(0, maxChars);

  const scored = chunks.map((c, i) => {
    const lower = c.toLowerCase();
    let score = 0;
    for (const w of words) if (lower.includes(stem(w))) score += 1;
    return { c, i, score };
  });

  const picked = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 6)
    .sort((a, b) => a.i - b.i);
  const source = picked.length > 0 ? picked : scored.slice(0, 6);

  let out = '';
  for (const s of source) {
    if (out.length + s.c.length > maxChars) {
      out += s.c.slice(0, Math.max(0, maxChars - out.length));
      break;
    }
    out += s.c + '\n\n';
  }
  return out.trim();
}

function trimAnswer(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  // If the model was cut off mid-sentence, end at the last full sentence.
  if (/[.!?)"']$/.test(t)) return t;
  const cut = Math.max(t.lastIndexOf('. '), t.lastIndexOf('! '), t.lastIndexOf('? '));
  return cut > 40 ? t.slice(0, cut + 1) : t;
}

async function summarizeRecord(record) {
  const body = recordBody(record);
  const excerpt = body.slice(0, 2500);
  const summary = await callOllama(
    `Summarize the following web page in 2 short sentences. Say what it is about. Do not add anything that is not in the text.\n\nTitle: ${recordTitle(record)}\n\nText:\n${excerpt}\n\nSummary:`,
    120
  );
  // Never hand back raw page text as a "summary": if the model did not answer, return nothing
  return summary ? trimAnswer(summary) : '';
}

// One short sentence (at most 300 characters) from a model reply
function oneSentence(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  // A sentence ends at . ! ? followed by a capital letter or the end, so "U.S. Army" is not cut in half
  const m = t.match(/^.{15,}?(?<!\b[A-Z])(?<!\b(?:Dr|Mr|Mrs|Ms|St|Jr|Sr|vs|Inc|Ltd|Co|No))[.!?](?=\s+[A-Z"“(]|\s*$)/);
  let s = m ? m[0] : t;
  if (s.length > 400) s = s.slice(0, 400).replace(/\s+\S*$/, '');
  if (s && !/[.!?)"'”]$/.test(s)) s += '.'; // always end on a full stop
  return s;
}

// "I could not find that", and the many ways a model says the same thing
const NOT_FOUND_REPLY = /^(i )?(could not|couldn't|cannot|can't|do not|don't) (find|see)\b|^not[_ ]found\b|\b(not|n't)\s+(mentioned|provided|stated|specified|available|included|found|given)\b|\bno (information|mention|details?)\b|\b(text|passage|page|article)\s+(does not|doesn't|did not)\b/i;

// "From your memory: <title>, <date>"
function memoryLabel(record, now) {
  const when = savedWhen(record, now);
  return 'From your memory: ' + readableTitle(record, 60) + (when ? ', ' + when : '');
}

// ---------------------------------------------------------------------------
// Time wording for answers. Saved times are stored in UTC; answers use the laptop's local time zone (IST).
// ---------------------------------------------------------------------------
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_INDEX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WEEKDAY_INDEX = {
  sunday: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6,
};

function parseSavedTime(value) {
  const d = new Date(String(value || '').replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// Whole days from `from` to `to` (0 = same day, 1 = `to` is the next day)
function dayDiff(from, to) {
  return Math.round((startOfDay(to) - startOfDay(from)) / 86400000);
}

function clockTime(d) {
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  return (h % 12 || 12) + ':' + m + ' ' + (h >= 12 ? 'PM' : 'AM');
}

// morning 5-12, afternoon 12-17, evening 17-21, night 21-5
function dayPart(hour) {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}

function dateLabel(d, now) {
  return WEEKDAY_NAMES[d.getDay()] + ' ' + d.getDate() + ' ' + MONTH_SHORT[d.getMonth()] +
    (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '');
}

// "today at 2:33 PM", "Thursday 17 Sep at night"
function whenText(d, now) {
  if (dayDiff(d, now) <= 0) return 'today at ' + clockTime(d);
  return dateLabel(d, now) + ' at ' + dayPart(d.getHours());
}

// Saved files get an exact clock time even for older dates ("on 22 Sep at 11:54 AM"), unlike page
// answers above, which round to a part of the day. A file arrived at a moment; a page was read over
// one. Includes its own preposition so the sentence reads correctly either way.
function fileWhenText(d, now) {
  const ago = dayDiff(d, now);
  if (ago <= 0) return 'today at ' + clockTime(d);
  if (ago === 1) return 'yesterday at ' + clockTime(d);
  return 'on ' + d.getDate() + ' ' + MONTH_SHORT[d.getMonth()] +
    (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '') + ' at ' + clockTime(d);
}

// ---------------------------------------------------------------------------
// File recall: "what PDF did I save", "the last 3 files I saved". These ask which files exist and
// when they arrived - record metadata - rather than what is written inside them, so they are
// answered straight from the record list, with no meaning-based or keyword search involved.
// ---------------------------------------------------------------------------
const FILE_NOUNS = /\b(file|files|pdf|pdfs|document|documents|doc|docs|attachment|attachments)\b/i;
const FILE_RECALL_WORDS = /\b(save|saved|saving|upload|uploaded|attach|attached|added|recent|recently|last|latest)\b/i;
const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function isFileRecallQuestion(q) {
  return FILE_NOUNS.test(q) && FILE_RECALL_WORDS.test(q);
}

// "last 3 files" / "three documents" -> that many; anything else -> just the most recent one.
// The number has to sit directly in front of the file word, so "unit 3 chem" isn't read as a count.
function askedFileCount(q) {
  const m = q.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:most\s+recent\s+|recent\s+|last\s+|latest\s+)?(?:files?|pdfs?|documents?|docs?|attachments?)\b/i);
  if (!m) return 1;
  const raw = m[1].toLowerCase();
  const n = COUNT_WORDS[raw] || parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), 10) : 1;
}

// "File: 2026-09-22T11-54-28-432Z-unit 3 chem.pdf" -> "unit 3 chem.pdf"
function attachmentDisplayName(formName) {
  return String(formName || '')
    .replace(/^File:\s*/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/, '') // the collision-proof upload stamp
    .trim();
}

// ---------------------------------------------------------------------------
// Site filter, form records and topic helpers for /api/ask
// ---------------------------------------------------------------------------
const SITE_ALIASES = [
  { word: 'wikipedia', label: 'Wikipedia', host: /(^|\.)wikipedia\.org$/ },
  { word: 'youtube', label: 'YouTube', host: /(^|\.)(youtube\.com|youtu\.be)$/ },
  { word: 'gmail', label: 'Gmail', host: /^mail\.google\.com$/ },
  { word: 'google', label: 'Google', host: /(^|\.)google\.[a-z.]+$/ },
  { word: 'github', label: 'GitHub', host: /(^|\.)github\.(com|io)$/ },
  { word: 'reddit', label: 'Reddit', host: /(^|\.)reddit\.com$/ },
  { word: 'linkedin', label: 'LinkedIn', host: /(^|\.)linkedin\.com$/ },
  { word: 'twitter', label: 'Twitter', host: /(^|\.)(twitter\.com|x\.com)$/ },
  { word: 'facebook', label: 'Facebook', host: /(^|\.)facebook\.com$/ },
  { word: 'instagram', label: 'Instagram', host: /(^|\.)instagram\.com$/ },
  { word: 'amazon', label: 'Amazon', host: /(^|\.)amazon\.[a-z.]+$/ },
  { word: 'flipkart', label: 'Flipkart', host: /(^|\.)flipkart\.com$/ },
  { word: 'stackoverflow', label: 'Stack Overflow', host: /(^|\.)stackoverflow\.com$/ },
  { word: 'quora', label: 'Quora', host: /(^|\.)quora\.com$/ },
  { word: 'medium', label: 'Medium', host: /(^|\.)medium\.com$/ },
  { word: 'netflix', label: 'Netflix', host: /(^|\.)netflix\.com$/ },
  { word: 'chatgpt', label: 'ChatGPT', host: /(^|\.)(chatgpt\.com|openai\.com)$/ },
];

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
}

// If the question names a site ("on wikipedia", "on youtube.com"), return how to recognise its pages
function detectSite(q) {
  for (const s of SITE_ALIASES) {
    if (new RegExp('\\b' + s.word + '\\b').test(q)) return { label: s.label, strip: [s.word], test: (h) => s.host.test(h) };
  }
  const m = q.match(/\b((?:[a-z0-9-]+\.)+(?:com|org|net|io|edu|gov|in|co|ai|app|dev))\b/);
  if (m) {
    const domain = m[1].replace(/^www\./, '');
    return {
      label: domain,
      strip: domain.split('.'),
      test: (h) => h === domain || h.endsWith('.' + domain),
    };
  }
  return null;
}

// Records made from the "Save this form?" panel; they are never "pages I read"
function isFormRecord(record) {
  return /^form:/i.test(String(record.form_name || ''));
}

// Words that describe the kind of question, not its topic
const QUESTION_ONLY_WORDS = new Set([
  'thing', 'things', 'post', 'posts', 'blog', 'site', 'sites', 'tab', 'tabs', 'video', 'videos', 'watch',
  'watched', 'watching', 'open', 'opened', 'browse', 'browsed', 'visit', 'look', 'looked', 'search',
  'searched', 'googled', 'most', 'just', 'previous', 'before', 'after', 'immediately', 'first', 'next',
  'doing', 'website', 'websites', 'reading', 'wikipedia', 'youtube', 'gmail', 'one', 'ago', 'tell',
  'today', 'yesterday', 'tonight', 'morning', 'afternoon', 'evening', 'night',
  'summarize', 'summarise', 'summary', 'explain', 'describe', 'earlier', 'again',
]);

function topicWords(q, site) {
  const skip = new Set(site ? site.strip : []);
  return [...new Set(
    q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 1 && !ASK_STOP_WORDS.has(w) && !QUESTION_ONLY_WORDS.has(w) && !skip.has(w))
  )];
}

function wordRegexes(words) {
  return words.map((w) => new RegExp('\\b' + stem(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}

function neededMatches(n) {
  return n === 1 ? 1 : Math.min(n, Math.max(2, Math.ceil(n / 2)));
}

// How many topic words a record mentions (title, address or body)
function topicHits(record, regs) {
  const hay = recordTitle(record) + '\n' + recordUrl(record) + '\n' + recordBody(record);
  return regs.filter((re) => re.test(hay)).length;
}

function savedWhen(record, now) {
  const t = parseSavedTime(record.last_updated);
  return t ? whenText(t, now) : '';
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// "Elon Musk - Wikipedia (en.wikipedia.org)" -> "Elon Musk (Wikipedia)"
function readableTitle(record, maxLen) {
  let t = recordTitle(record).replace(/\s*\((?:[a-z0-9-]+\.)+[a-z]{2,}\)\s*$/i, '').trim();
  const m = t.match(/^(.+?)\s+[|–—-]\s+([^|–—-]{2,30})$/);
  if (m) t = m[1] + ' (' + m[2].trim() + ')';
  const limit = maxLen || 90;
  return t.length > limit ? t.slice(0, limit - 3) + '...' : t;
}

// Local date from parts; with no year it is this year, or last year if that date is still in the future
function buildDate(year, month, day, now) {
  let y = year == null ? now.getFullYear() : year;
  if (y < 100) y += 2000;
  let date = new Date(y, month, day);
  if (date.getMonth() !== month || date.getDate() !== day) return null;
  if (year == null && startOfDay(date) > startOfDay(now)) date = new Date(y - 1, month, day);
  return date;
}

// Finds "yesterday", "Thursday", "17 Sep", "17/09", "last night", ... (plus an optional part of the day)
function parseDayRequest(q, now) {
  const partMatch = q.match(/\b(morning|afternoon|evening|night|tonight)\b/);
  let part = partMatch ? (partMatch[1] === 'tonight' ? 'night' : partMatch[1]) : null;
  const today = startOfDay(now);
  const daysAgo = (n) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
  let date = null;
  let m;

  if (/\blast night\b/.test(q)) {
    date = daysAgo(1);
    part = 'night';
  } else if (/\byesterday\b/.test(q)) {
    date = daysAgo(1);
  } else if (/\b(today|tonight)\b|\bthis (morning|afternoon|evening)\b/.test(q)) {
    date = today;
  } else if ((m = q.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(' + MONTH_RE + ')\\b(?:,?\\s+(\\d{4}))?')))) {
    date = buildDate(m[3] ? +m[3] : null, MONTH_INDEX[m[2].slice(0, 3)], +m[1], now);
  } else if ((m = q.match(new RegExp('\\b(' + MONTH_RE + ')\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?')))) {
    date = buildDate(m[3] ? +m[3] : null, MONTH_INDEX[m[1].slice(0, 3)], +m[2], now);
  } else if ((m = q.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) {
    date = buildDate(+m[1], +m[2] - 1, +m[3], now);
  } else if ((m = q.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/))) {
    date = buildDate(m[3] ? +m[3] : null, +m[2] - 1, +m[1], now); // day/month, the Indian way
  } else if ((m = q.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|mon|tues?|wed|thu|thurs?|fri)\b/))) {
    date = daysAgo((today.getDay() - WEEKDAY_INDEX[m[1]] + 7) % 7); // the most recent such day, today included
  }

  return date ? { date, part } : null;
}

// "today", "yesterday night", "this morning", "on Thursday, 17 Sep at night"
function dayPhrase(date, part, now) {
  const ago = dayDiff(date, now);
  if (ago === 0) return part ? (part === 'night' ? 'tonight' : 'this ' + part) : 'today';
  if (ago === 1) return part ? 'yesterday ' + part : 'yesterday';
  return 'on ' + dateLabel(date, now) + (part ? (part === 'night' ? ' at night' : ' in the ' + part) : '');
}

const LAST_ONE_QUESTION = /\b(last|latest|most recent|previous)\s+(article|page|site|website|tab|thing|post|blog)\b/;
const DAY_QUESTION = /\b(doing|did i|was i|read|reading|visit(?:ed)?|brows(?:e|ed|ing)|look(?:ed|ing)|saw|watch(?:ed|ing)?|search(?:ed)?|pages?|sites?|websites?|articles?|saved|opened)\b/;

app.post('/api/ask', async (req, res) => {
  const { question, mode, page } = req.body;
  const isUnlocked = vaultUnlocked(req);

  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Please enter a question.' });
  }

  // Page question: answered ONLY from the page text sent with the request. Saved memories are not used
  // and nothing is stored. One self-contained message to the local model.
  if (mode === 'page') {
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'Not allowed.' });
    const text = page && page.text;
    const title = page && page.title;
    const url = page && page.url;
    if (
      question.length > 500 ||
      typeof text !== 'string' || !text.trim() || text.length > 20000 ||
      (title !== undefined && (typeof title !== 'string' || title.length > 300)) ||
      (url !== undefined && url !== '' && (typeof url !== 'string' || url.length > 500 || !/^https?:\/\//i.test(url)))
    ) {
      return res.status(400).json({ error: 'Sorry, I could not use that page text. Please try again.' });
    }
    const raw = await callOllama(
      `Answer using only the text below. Reply with one complete sentence. If the answer is not in the text, reply exactly: I could not find that.\n\nText:\n${text}\n\nQuestion: ${question.trim()}\n\nAnswer:`,
      150
    );
    if (raw === null) {
      return res.json({ found: false, source: 'page', message: "My local model isn't responding right now, so I can't answer. Please make sure Ollama is running." });
    }
    const sentence = oneSentence(raw);
    return res.json({
      found: true,
      kind: 'page',
      source: 'page',
      source_label: 'From this page',
      title: '',
      answer: !sentence || NOT_FOUND_REPLY.test(sentence) ? 'I could not find that.' : sentence,
      source_url: '',
      form_name: '',
      last_updated: '',
    });
  }

  try {
    const records = isUnlocked
      ? db.prepare('SELECT * FROM records ORDER BY last_updated DESC, id DESC').all()
      : db.prepare('SELECT * FROM records WHERE is_sensitive = 0 ORDER BY last_updated DESC, id DESC').all();

    const cleanQuestion = question.toLowerCase().trim();

    const now = new Date();

    // File recall runs before everything else. Both the recency branch ("last ... saved") and the
    // day branch would otherwise swallow these questions and answer about web pages instead - and
    // the day branch can't see files at all, since it only considers records that have a URL.
    if (isFileRecallQuestion(cleanQuestion)) {
      const fileRecords = records.filter((r) => /^File:/i.test(String(r.form_name || '')));
      if (fileRecords.length === 0) {
        return res.json({ found: false, message: "You haven't saved any files yet." });
      }

      const chosen = fileRecords.slice(0, askedFileCount(cleanQuestion)); // records are newest-first
      const described = chosen.map((r) => {
        const savedAt = parseSavedTime(r.last_updated);
        return attachmentDisplayName(r.form_name) + (savedAt ? ' ' + fileWhenText(savedAt, now) : '');
      });

      const newest = chosen[0];
      return res.json({
        found: true,
        kind: 'files_saved',
        source: 'memory',
        source_label: 'From your memory: ' + fileRecords.length + (fileRecords.length === 1 ? ' saved file' : ' saved files'),
        title: attachmentDisplayName(newest.form_name),
        answer: chosen.length === 1
          ? 'You saved ' + described[0] + '.'
          : 'You saved these ' + chosen.length + ' files:\n' + described.map((d) => '• ' + d).join('\n'),
        source_url: '',
        form_name: newest.form_name,
        last_updated: newest.last_updated,
      });
    }

    // Site filter: "...on wikipedia" only ever returns pages from that site
    const site = detectSite(cleanQuestion);
    const inSite = (r) => !site || site.test(hostOf(recordUrl(r)));
    const noSiteMessage = () => "I don't have any saved pages from " + site.label + '.';
    // Pages that were read: have a web address, and are never form records
    const readPages = records.filter((r) => recordUrl(r) && !isFormRecord(r));

    // 0a) "What did I read before/after X?" -> find X, then the page saved right before/after it
    const seqMatch = cleanQuestion.match(/^(.*?)\b(before|after)\b\s+(.+)$/);
    if (seqMatch && /\b(read|reading|visited|opened|saw|saved|watched|browsed|page|article|site|tab|video|thing)\b/.test(seqMatch[1])) {
      const dir = seqMatch[2];
      const headSite = detectSite(seqMatch[1]);
      const tailSite = detectSite(seqMatch[3]);
      const words = topicWords(seqMatch[3], tailSite);
      if (words.length === 0) {
        return res.json({ found: false, message: 'Tell me which page you mean, e.g. "What did I read before the Elon Musk article?"' });
      }

      // Locate X: the page whose title/address/text matches the words after "before"/"after"
      const regs = wordRegexes(words);
      const need = neededMatches(words.length);
      let anchorIdx = -1;
      let anchorScore = 0;
      readPages.forEach((r, i) => {
        if (tailSite && !tailSite.test(hostOf(recordUrl(r)))) return;
        if (topicHits(r, regs) < need) return;
        const title = recordTitle(r);
        const score = regs.filter((re) => re.test(title)).length * 25 + topicHits(r, regs);
        if (score > anchorScore) { anchorScore = score; anchorIdx = i; } // newest wins ties
      });
      if (anchorIdx < 0) {
        return res.json({ found: false, message: "I couldn't find a saved page about \"" + words.join(' ') + '" to work from.' });
      }

      // readPages is newest-first: "after" = newer neighbour, "before" = older neighbour
      const anchor = readPages[anchorIdx];
      let neighbour = null;
      for (let i = anchorIdx + (dir === 'after' ? -1 : 1); i >= 0 && i < readPages.length; i += dir === 'after' ? -1 : 1) {
        if (!headSite || headSite.test(hostOf(recordUrl(readPages[i])))) { neighbour = readPages[i]; break; }
      }
      const anchorWhen = savedWhen(anchor, now);
      if (!neighbour) {
        return res.json({
          found: false,
          message: 'I have no saved page ' + (dir === 'after' ? 'after' : 'before') + ' "' + readableTitle(anchor) + '"' + (anchorWhen ? ' (saved ' + anchorWhen + ')' : '') + '.',
        });
      }
      const nWhen = savedWhen(neighbour, now);
      return res.json({
        found: true,
        kind: 'sequence',
        source: 'memory',
        source_label: memoryLabel(neighbour, now),
        title: recordTitle(neighbour),
        answer: (dir === 'after' ? 'Right after' : 'Right before') + ' "' + readableTitle(anchor) + '"' +
          (anchorWhen ? ' (' + anchorWhen + ')' : '') + ', you read "' + readableTitle(neighbour) + '"' +
          (nWhen ? ', saved ' + nWhen : '') + '.',
        source_url: recordUrl(neighbour),
        form_name: neighbour.form_name,
        last_updated: neighbour.last_updated,
      });
    }

    // 0) "What was I doing on Thursday (at night)?" -> every saved page from that day, with its time
    const dayReq = LAST_ONE_QUESTION.test(cleanQuestion) ? null : parseDayRequest(cleanQuestion, now);
    if (dayReq && DAY_QUESTION.test(cleanQuestion)) {
      const phrase = dayPhrase(dayReq.date, dayReq.part, now);
      const dayPages = readPages
        .filter(inSite)
        .map((r) => ({ r, t: parseSavedTime(r.last_updated) }))
        .filter((x) => x.t && dayDiff(x.t, dayReq.date) === 0 && (!dayReq.part || dayPart(x.t.getHours()) === dayReq.part))
        .sort((a, b) => a.t - b.t);

      if (dayPages.length === 0) {
        return res.json({ found: false, message: "I don't have any saved pages from " + phrase + '.' });
      }

      const shown = dayPages.slice(0, 10);
      const lines = shown.map((x) => '• ' + clockTime(x.t) + ' – ' + readableTitle(x.r, 70));
      if (dayPages.length > shown.length) lines.push('...and ' + (dayPages.length - shown.length) + ' more.');
      const newest = dayPages[dayPages.length - 1].r;

      return res.json({
        found: true,
        kind: 'day',
        source: 'memory',
        source_label: 'From your memory: ' + dayPages.length + (dayPages.length === 1 ? ' page' : ' pages') + ', ' + phrase,
        title: capitalize(phrase),
        answer: capitalize(phrase) + ' you read ' + dayPages.length + (dayPages.length === 1 ? ' page' : ' pages') + ':\n' + lines.join('\n'),
        source_url: '',
        form_name: newest.form_name,
        last_updated: newest.last_updated,
      });
    }

    // 1) "What was the last article I read?" -> most recently captured web page, with its exact time
    const recentTopic = topicWords(cleanQuestion, site);
    const asksLatest = /\b(last|latest|most recent)\b/.test(cleanQuestion);
    if (RECENT_INTENT.test(cleanQuestion) || (site && (asksLatest || recentTopic.length === 0))) {
      const wantsSearch = /\b(search|searched|google|googled)\b/.test(cleanQuestion);
      let pages = readPages.filter(inSite); // newest saved first
      if (site && pages.length === 0) return res.json({ found: false, message: noSiteMessage() });

      // "last article about X": only pages that are actually about X
      if (recentTopic.length > 0) {
        const regs = wordRegexes(recentTopic);
        const need = neededMatches(recentTopic.length);
        pages = pages.filter((r) => topicHits(r, regs) >= need);
        if (pages.length === 0) {
          return res.json({ found: false, message: 'I could not find a saved page about that.' });
        }
      }
      const preferred = wantsSearch ? pages : pages.filter((r) => !SEARCH_PAGE.test(recordUrl(r)));
      const list = preferred.length > 0 ? preferred : pages;
      const latest = list[0];

      if (!latest) {
        return res.json({ found: false, message: "I don't have any saved pages yet." });
      }
      {
        const t1 = parseSavedTime(latest.last_updated);
        let answer = '';

        if (t1) {
          answer = capitalize(whenText(t1, now)) + ' you were reading ' + readableTitle(latest) + '.';
          const prev = list[1];
          const t2 = prev ? parseSavedTime(prev.last_updated) : null;
          if (t2) {
            // Same recent day: just the clock time; otherwise spell out the day
            const prevWhen = dayDiff(t1, now) <= 1 && dayDiff(t2, t1) === 0 ? 'at ' + clockTime(t2) : whenText(t2, now);
            answer += ' Before that, ' + prevWhen + ', you read ' + readableTitle(prev) + '.';
          }
        }
        if (!t1 || /\bsummar/.test(cleanQuestion)) {
          const summary = await summarizeRecord(latest);
          if (summary) answer = answer ? answer + '\n\n' + summary : summary;
        }
        if (!answer) return res.json({ found: false, message: 'I could not find that.' });

        return res.json({
          found: true,
          kind: 'recent',
          source: 'memory',
          source_label: memoryLabel(latest, now),
          title: recordTitle(latest),
          answer,
          source_url: recordUrl(latest),
          form_name: latest.form_name,
          last_updated: latest.last_updated,
        });
      }
    }

    // 2) Normal question -> find the best memory by real keyword relevance
    const siteWords = new Set(site ? site.strip : []);
    const queryWords = [...new Set(
      cleanQuestion
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1 && !ASK_STOP_WORDS.has(w) && !siteWords.has(w))
    )];

    // Candidate memories: only the named site's pages, and never form records for "what did I read" questions
    const asksRead = /\b(read|reading|visited|browsed|article|articles|page|pages|website|websites)\b/.test(cleanQuestion);
    if (site && !records.some((r) => recordUrl(r) && inSite(r))) {
      return res.json({ found: false, message: noSiteMessage() });
    }
    const pool = records.filter((r) => (site ? recordUrl(r) && inSite(r) : !(asksRead && isFormRecord(r))));

    if (queryWords.length === 0) {
      return res.json({
        found: false,
        message: 'Try asking with a specific name or topic, e.g. "Who is Mark Zuckerberg?"',
      });
    }

    // Search by meaning first: this finds a record that is about the question even when it shares
    // no keywords with it. If the embedding model can't be reached, fall through to the keyword
    // scoring below instead of failing the question outright.
    let bestMatch = null;
    let contextRecords = [];

    const semantic = await findRecordsByMeaning(question, pool, 4);
    if (semantic.ok) {
      if (semantic.matches.length === 0) {
        // The search worked and nothing was close enough; don't guess with a loosely-related page.
        return res.json({
          found: false,
          message: 'I could not find anything about that in your saved memories.',
        });
      }
      contextRecords = semantic.matches.map((m) => m.record);
      bestMatch = contextRecords[0];
    }

    const wordRes = queryWords.map((w) => new RegExp('\\b' + stem(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    const needed = queryWords.length === 1 ? 1 : Math.min(queryWords.length, Math.max(2, Math.ceil(queryWords.length / 2)));
    const wantsSearchPage = /\b(search|searched|google|googled)\b/.test(cleanQuestion);

    let highestScore = 0;

    for (const record of bestMatch ? [] : pool) {
      const title = recordTitle(record).toLowerCase();
      const body = recordBody(record).toLowerCase();
      let matched = 0;
      let score = 0;

      for (let i = 0; i < queryWords.length; i++) {
        const inTitle = wordRes[i].test(title);
        const hits = (body.match(new RegExp(wordRes[i].source, 'gi')) || []).length;
        if (inTitle || hits > 0) matched++;
        if (inTitle) score += 25;
        if (hits > 0) score += 8 + Math.min(hits, 10);
      }

      for (let i = 0; i < queryWords.length - 1; i++) {
        const phrase = `${queryWords[i]} ${queryWords[i + 1]}`;
        if (title.includes(phrase)) score += 40;
        else if (body.includes(phrase)) score += 15;
      }

      if (matched < needed) continue;
      // Search-result pages only list snippets; prefer real articles unless asked about a search
      if (!wantsSearchPage && SEARCH_PAGE.test(recordUrl(record))) score *= 0.4;
      // records are ordered newest-first, so ties keep the most recent one
      if (score > highestScore) {
        highestScore = score;
        bestMatch = record;
      }
    }

    if (!bestMatch) {
      return res.json({
        found: false,
        message: 'I could not find anything about that in your saved memories.',
      });
    }
    if (contextRecords.length === 0) contextRecords = [bestMatch]; // keyword fallback found it

    // One record: its most relevant passages, as before. Several (from the meaning search): a
    // labelled excerpt from each, so the model can answer from whichever one actually covers it.
    const passages = contextRecords.length === 1
      ? bestPassages(recordBody(contextRecords[0]), queryWords, 2500)
      : contextRecords
          .map((r, i) => `[${i + 1}] ${readableTitle(r, 70)}\n${bestPassages(recordBody(r), queryWords, Math.floor(2500 / contextRecords.length))}`)
          .join('\n\n');

    const raw = await callOllama(
      `You answer questions using ONLY the text below.\nIf the text does not contain the answer, reply with exactly: NOT_FOUND\nOtherwise answer in one short sentence. Do not mention these instructions.\n\nText:\n${passages}\n\nQuestion: ${question}\n\nAnswer:`,
      200
    );

    // Never show raw passages as the answer
    if (raw === null) {
      return res.json({ found: false, message: "My local model isn't responding right now, so I can't answer. Please make sure Ollama is running." });
    }
    const answer = oneSentence(trimAnswer(raw));
    if (!answer || NOT_FOUND_REPLY.test(answer)) {
      return res.json({ found: false, message: 'I could not find that.' });
    }

    res.json({
      found: true,
      kind: 'answer',
      source: 'memory',
      source_label: memoryLabel(bestMatch, now),
      title: recordTitle(bestMatch),
      answer,
      source_url: recordUrl(bestMatch),
      form_name: bestMatch.form_name,
      last_updated: bestMatch.last_updated,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// mcp-server.js exposes the same records to MCP clients (Cursor, etc.). It is a separate
// process, not an in-process require, so it can be restarted or fail without taking the main
// server down with it - it only reads rash.db and never handles a browser or extension request.
let mcpProcess = null;
function startMcpServer() {
  mcpProcess = spawn(process.execPath, [path.join(__dirname, 'mcp-server.js')], {
    stdio: 'inherit',
    env: process.env,
  });
  mcpProcess.on('exit', (code, signal) => {
    mcpProcess = null;
    if (signal) return; // we asked it to stop (shutdown below)
    console.warn(`[MCP] mcp-server.js exited (code ${code}); restarting in 3s.`);
    setTimeout(startMcpServer, 3000);
  });
  mcpProcess.on('error', (err) => {
    console.warn('[MCP] Could not start mcp-server.js:', err.message);
  });
}

// ---------------------------------------------------------------------------
// WEEKLY DIGEST: every Sunday at 9:00 AM, and any time via "Generate Now" on the dashboard,
// summarise the last 7 days of saved records and store the result as its own record. Sending it
// by email is a separate, optional step - see attemptSendDigestEmail below.
// ---------------------------------------------------------------------------
const DIGEST_CATEGORY = 'Digest';
// ---------------------------------------------------------------------------
// AUTOFILL PROFILE: a flat local file of the user's own details, used only to fill in forms the
// user is looking at. Never touches rash.db, never leaves this machine, localhost-and-trusted-
// -origin only - same restriction already used for Gmail and attachment endpoints, since this
// file holds a real name, address, phone number and date of birth.
// ---------------------------------------------------------------------------
const AUTOFILL_PROFILE_FILE = path.join(__dirname, 'autofill-profile.json');
const AUTOFILL_PROFILE_DEFAULTS = {
  firstName: '', lastName: '', email: '', phone: '',
  street: '', city: '', state: '', zip: '', pincode: '',
  college: '', day: '', month: '', year: '', gender: '',
};

app.get('/api/autofill-profile', (req, res) => {
  if (!isStrictLocalRequest(req)) return res.status(403).json({ error: 'Not allowed.' });
  let profile = AUTOFILL_PROFILE_DEFAULTS;
  try {
    const raw = JSON.parse(fs.readFileSync(AUTOFILL_PROFILE_FILE, 'utf8'));
    // Merge over the defaults so a partially-filled-in file (or one missing a newer field)
    // never breaks the extension - it always gets every key, empty string where unset.
    profile = { ...AUTOFILL_PROFILE_DEFAULTS, ...raw };
  } catch (_) {
    // Missing or invalid file: hand back all-empty defaults rather than erroring
  }
  res.json(profile);
});

// Silent learning: never overwrite with an empty or low-confidence value, and only ever touch
// the one field that was sent - a bad guess on one field should never clobber the rest of the file.
const AUTOFILL_LOW_CONFIDENCE_VALUES = new Set(['test', 'asdf', 'xxxx', '123']);
app.post('/api/autofill-profile/learn', (req, res) => {
  if (!isStrictLocalRequest(req)) return res.status(403).json({ error: 'Not allowed.' });
  const { field, value } = req.body || {};
  if (typeof field !== 'string' || !Object.prototype.hasOwnProperty.call(AUTOFILL_PROFILE_DEFAULTS, field)) {
    return res.status(400).json({ error: 'Unknown field.' });
  }
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length < 2 || AUTOFILL_LOW_CONFIDENCE_VALUES.has(trimmed.toLowerCase())) {
    return res.json({ updated: false, field });
  }
  let profile = AUTOFILL_PROFILE_DEFAULTS;
  try {
    const raw = JSON.parse(fs.readFileSync(AUTOFILL_PROFILE_FILE, 'utf8'));
    profile = { ...AUTOFILL_PROFILE_DEFAULTS, ...raw };
  } catch (_) {}
  profile[field] = trimmed;
  fs.writeFileSync(AUTOFILL_PROFILE_FILE, JSON.stringify(profile, null, 2));
  res.json({ updated: true, field });
});

const DIGEST_SETTINGS_FILE = path.join(__dirname, 'digest-settings.json');
// A Google App Password (16 characters, needs 2FA on the account), kept separate from the OAuth
// client in gmail-credentials.json - that file has no password in it and can't authenticate SMTP.
// See attemptSendDigestEmail() for why this file, specifically, is what's needed here.
const GMAIL_SMTP_CREDENTIALS_FILE = path.join(__dirname, 'gmail-smtp-credentials.json');

function loadDigestSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(DIGEST_SETTINGS_FILE, 'utf8'));
    return { recipient: typeof raw.recipient === 'string' ? raw.recipient : '' };
  } catch (_) {
    return { recipient: '' };
  }
}

function saveDigestSettings(settings) {
  fs.writeFileSync(DIGEST_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// Records from the last 7 days, oldest to newest, excluding Vault items and earlier digests
// (a digest should never summarise itself).
function pullLastWeekRecords() {
  return db.prepare(`
    SELECT * FROM records
    WHERE last_updated >= datetime('now', '-7 days')
      AND is_sensitive = 0
      AND category != ?
    ORDER BY last_updated ASC
  `).all(DIGEST_CATEGORY);
}

// Deterministic counts are computed here rather than trusted to the model - Ollama is only asked
// for the parts that genuinely need judgment: topics and a highlight.
function digestCounts(records) {
  let pages = 0;
  let files = 0;
  for (const r of records) {
    if (/^File:/i.test(r.form_name)) files++;
    else if (recordUrl(r)) pages++;
  }
  return { total: records.length, pages, files };
}

async function summariseTopicsAndHighlight(records) {
  if (records.length === 0) return { topics: '', highlight: '' };

  const budget = 40; // enough for a week's worth without overflowing the model's context
  const lines = records.slice(0, budget).map((r) => {
    const title = readableTitle(r, 90);
    const snippet = recordBody(r).replace(/\s+/g, ' ').trim().slice(0, 160);
    return `- ${title}${snippet ? ': ' + snippet : ''}`;
  }).join('\n');

  // Measured directly: the same prompt took 62.1s on OLLAMA_MODEL (llama3.1:8b) and blew past
  // the default 60s timeout, so the topics/highlight came back empty every time. SUMMARY_MODEL is
  // the model already reserved elsewhere in this file for exactly this kind of long-context
  // summarising, and it gets a longer timeout here since a week's worth of titles is a lot of text.
  const result = await runOllama(
    `Below are the titles (and short excerpts) of things saved this week. Using ONLY this list:
1. Name 3-5 top topics, comma-separated.
2. Pick the single most interesting or notable item and describe it in one short sentence.
Do not invent anything not implied by the list. Reply in exactly this format:
TOPICS: <comma-separated topics>
HIGHLIGHT: <one sentence>

List:
${lines}

Answer:`,
    200,
    120000,
    SUMMARY_MODEL
  );
  const raw = result.ok ? result.text : null;

  if (!raw) return { topics: '', highlight: '' };
  const topicsMatch = raw.match(/TOPICS:\s*([^\n\r]+)/i);
  const highlightMatch = raw.match(/HIGHLIGHT:\s*([^\n\r]+)/i);
  return {
    topics: topicsMatch ? topicsMatch[1].trim() : '',
    highlight: highlightMatch ? trimAnswer(highlightMatch[1].trim()) : '',
  };
}

function digestDateLabel(d) {
  return `${WEEKDAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

// Builds the digest's plain-text summary. Counts are always accurate even if Ollama is
// unreachable; only the topics/highlight lines are skipped in that case.
function buildDigestText(records, counts, ai, now) {
  const parts = [];
  parts.push(`Weekly digest for ${digestDateLabel(now)}.`);
  if (counts.total === 0) {
    parts.push("You didn't save anything new this week.");
    return parts.join(' ');
  }
  parts.push(`${counts.total} record${counts.total === 1 ? '' : 's'} saved (${counts.pages} page${counts.pages === 1 ? '' : 's'}, ${counts.files} file${counts.files === 1 ? '' : 's'}).`);
  if (ai.topics) parts.push(`Top topics: ${ai.topics}.`);
  if (ai.highlight) parts.push(`Highlight: ${ai.highlight}`);
  return parts.join(' ');
}

async function runWeeklyDigest() {
  const now = new Date();
  const records = pullLastWeekRecords();
  const counts = digestCounts(records);

  let ai = { topics: '', highlight: '' };
  try {
    ai = await summariseTopicsAndHighlight(records);
  } catch (err) {
    console.warn('[Digest] Could not summarise with Ollama, saving counts only:', err.message);
  }

  const summaryText = buildDigestText(records, counts, ai, now);
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const formName = `weekly-digest-${dateStr}`;

  saveRecordToDb({ form_name: formName, category: DIGEST_CATEGORY, tags: '', content: summaryText, is_sensitive: 0 });
  console.log(`[Digest] Saved "${formName}" (${counts.total} record(s) this week).`);

  const digest = { form_name: formName, date: dateStr, dateLabel: digestDateLabel(now), summary: summaryText, counts };
  await attemptSendDigestEmail(digest);
  return digest;
}

// Email is optional and silent by default. gmail-credentials.json (the Gmail API OAuth client
// used elsewhere in this file) has no password in it and cannot authenticate SMTP, and the
// existing gmail-token.json was only ever granted the read-only scope - neither can send mail.
// Sending is enabled by creating gmail-smtp-credentials.json with a Gmail address and a Google
// App Password: { "address": "you@gmail.com", "appPassword": "xxxx xxxx xxxx xxxx" }.
// If that file doesn't exist, this logs once and returns - exactly the "skip silently" behaviour
// requested, just anchored to a credential that can actually work.
let loggedNoSmtpCredential = false;

function loadGmailSmtpCredentials() {
  try {
    const raw = JSON.parse(fs.readFileSync(GMAIL_SMTP_CREDENTIALS_FILE, 'utf8'));
    if (!raw.address || !raw.appPassword) return null;
    return raw;
  } catch (_) {
    return null;
  }
}

async function attemptSendDigestEmail(digest) {
  const creds = loadGmailSmtpCredentials();
  if (!creds) {
    if (!loggedNoSmtpCredential) {
      console.log('[Digest] No gmail-smtp-credentials.json found; showing the digest on the dashboard only, not emailing it.');
      loggedNoSmtpCredential = true;
    }
    return;
  }

  // The recipient in gmail-smtp-credentials.json is authoritative when present; the dashboard's
  // saved address (digest-settings.json) is only a fallback for anyone using the Settings field
  // instead of editing the credentials file directly.
  const settings = loadDigestSettings();
  const recipient = creds.recipient || settings.recipient;
  if (!recipient) return; // no one to send it to; the dashboard card is enough

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: creds.address, pass: creds.appPassword },
    });

    const html = `
      <div style="font-family: -apple-system, Segoe UI, Arial, sans-serif; max-width: 520px; margin: 0 auto; color: #1a1a1a;">
        <h2 style="margin-bottom: 4px;">Your RaSh Weekly Digest</h2>
        <p style="color: #666; margin-top: 0;">${digest.dateLabel}</p>
        <p style="font-size: 15px; line-height: 1.6;">${digest.summary}</p>
        <p style="margin-top: 24px;">
          <a href="http://localhost:3000" style="background: #111; color: #fff; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-size: 14px;">View Dashboard</a>
        </p>
      </div>
    `;

    await transporter.sendMail({
      from: creds.address,
      to: recipient,
      subject: `RaSh Weekly Digest - ${digest.dateLabel}`,
      text: digest.summary + '\n\nView your dashboard: http://localhost:3000',
      html,
    });
    console.log(`[Digest] Emailed to ${recipient}.`);
  } catch (err) {
    console.warn('[Digest] Could not send the digest email:', err.message);
  }
}

app.get('/api/digest/latest', (req, res) => {
  const row = db.prepare("SELECT * FROM records WHERE category = ? ORDER BY last_updated DESC LIMIT 1").get(DIGEST_CATEGORY);
  if (!row) return res.json({ found: false });
  res.json({ found: true, form_name: row.form_name, summary: row.content, last_updated: row.last_updated });
});

app.post('/api/digest/generate', async (req, res) => {
  try {
    const digest = await runWeeklyDigest();
    res.json({ success: true, digest });
  } catch (err) {
    console.error('[Digest] Manual generation failed:', err);
    res.status(500).json({ error: 'Could not generate the digest: ' + err.message });
  }
});

app.get('/api/digest/settings', (req, res) => {
  res.json(loadDigestSettings());
});

app.post('/api/digest/settings', (req, res) => {
  const recipient = String((req.body && req.body.recipient) || '').trim();
  if (recipient && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    return res.status(400).json({ error: 'That does not look like a valid email address.' });
  }
  saveDigestSettings({ recipient });
  res.json({ success: true, recipient });
});

const server = app.listen(PORT, () => {
  console.log(`RaSh server running at http://localhost:${PORT}`);
  console.log(`Watching inbox folder for offline files at: ${inboxDir}`);

  // Build the file-name index in the background, then refresh it every 5 minutes
  scanFiles().then(() => {
    console.log(`File finder ready: ${fileIndex.length} files indexed from ${fileRoots.length} folders.`);
  });
  setInterval(scanFiles, 5 * 60 * 1000);

  // Catch up on any record that has no embedding yet (old records, or ones saved while Ollama
  // was down). Runs in the background; the server is already answering requests.
  sweepMissingEmbeddings();
  startMcpServer();

  // Every Sunday at 9:00 AM. Logged here so the schedule is verifiable without waiting a week.
  cron.schedule('0 9 * * 0', () => {
    console.log('[Digest] Running the scheduled Sunday 9:00 AM digest.');
    runWeeklyDigest().catch((err) => console.error('[Digest] Scheduled run failed:', err));
  }, { timezone: 'Asia/Kolkata' });
  console.log('[Digest] Weekly digest scheduled for Sundays at 9:00 AM (Asia/Kolkata).');
});

// Without this, a failed listen (e.g. the port is already taken) throws an unhandled 'error' event
// and Node exits with little or no message. This makes the cause visible instead.

// Stop the MCP child process when this server stops, so it never keeps port 3001 held after
// "node server.js" has exited.
function shutdownMcp() {
  if (mcpProcess) { mcpProcess.kill(); mcpProcess = null; }
}
process.on('exit', shutdownMcp);
process.on('SIGINT', () => { shutdownMcp(); process.exit(0); });
process.on('SIGTERM', () => { shutdownMcp(); process.exit(0); });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[RaSh] Port ${PORT} is already in use by another process. Check for a leftover node process (e.g. an earlier "node server.js") and stop it before restarting.`);
  } else {
    console.error('[RaSh] Server failed to start:', err.message);
  }
  process.exit(1);
});