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
const searchIndex = require('./search-index');
const smartRecall = require('./smart-recall');

const app = express();
// RASH_PORT / RASH_DB_PATH / RASH_TEST_MODE exist for scripts/eval-ask.js, which runs a second
// server against a throwaway database. Unset, everything behaves exactly as before.
const PORT = Number(process.env.RASH_PORT) || 3000;
// Test mode: no inbox watcher, no disk scan, no MCP child, no cron/digest email. The embedding
// worker still runs, so questions are answered the same way the real server answers them.
const TEST_MODE = process.env.RASH_TEST_MODE === '1';

const crypto = require('crypto');

// Hardware-adaptive default: a CPU-only machine (no GPU, no Apple Silicon) runs the 8b model
// painfully slowly (measured elsewhere in this file: 98.4s/chunk vs 51.0s on the 3b model), so it
// gets the smaller model as its default. RASH_MODEL always wins when set, on any hardware.
function detectHardwareTier() {
  if (os.platform() === 'darwin' && os.arch() === 'arm64') return 'apple-silicon';
  if (hasNvidiaGpuSync()) return 'gpu';
  return 'cpu';
}

// A synchronous, best-effort probe (no new dependency) - nvidia-smi only exists when an NVIDIA
// GPU and its driver are installed, so its mere presence is a good enough signal here.
function hasNvidiaGpuSync() {
  try {
    require('child_process').execFileSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch (_) {
    return false;
  }
}

const HARDWARE_TIER = detectHardwareTier();

// The one place to choose the local Ollama model. Override with the RASH_MODEL environment variable if needed.
const OLLAMA_MODEL = process.env.RASH_MODEL || (HARDWARE_TIER === 'cpu' ? 'llama3.2:3b' : 'llama3.1:8b');

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

// The only way in is a token from POST /api/vault/unlock, which checks the real PIN. The old
// "x-vault-unlocked: true" header is ignored: it let any request see the vault without the PIN.
function vaultUnlocked(req) {
  const tok = req.headers['x-vault-token'];
  const exp = typeof tok === 'string' ? vaultTokens.get(tok) : 0;
  if (exp && exp > Date.now()) return true;
  if (exp) vaultTokens.delete(tok);
  return false;
}

// Initialize SQLite database
const db = new Database(process.env.RASH_DB_PATH || 'rash.db', { allowExtension: true });
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
const EMBED_METRIC = 'cosine';

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
        // keep_alive as everywhere else: without it, each of these calls cut the embedding model's
        // stay in memory back to Ollama's 5-minute default.
        body: JSON.stringify({ model: EMBED_MODEL, prompt: full.slice(0, budget), keep_alive: searchIndex.CONFIG.KEEP_ALIVE }),
        signal: AbortSignal.timeout(30000), // Ollama hung: give up, the record is retried by the next sweep
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
      // Deleted or moved into the vault while this was being embedded: store nothing.
      const still = db.prepare('SELECT is_sensitive FROM records WHERE id = ?').get(recordId);
      if (!still || still.is_sensitive === 1) return;
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
      WHERE v.rowid IS NULL AND r.is_sensitive = 0
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
    const left = legacyVectorsPending();
    console.log(left === 0 ? '[RAG] Embedding sweep finished; every record is searchable.' : `[RAG] Embedding sweep finished, ${left} record(s) still missing (will retry on next start).`);
  });
  embedQueue = embedQueue.catch(() => {});
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
    WHERE v.rowid IS NULL AND r.is_sensitive = 0
    ORDER BY r.id ASC
  `).all();
}

// Non-vault records still waiting for their legacy whole-record vector (used until phase 3 moves
// /api/ask onto the chunk index).
function legacyVectorsPending() {
  if (!vectorSearchAvailable) return 0;
  return db.prepare('SELECT COUNT(*) AS n FROM records r LEFT JOIN vec_records v ON v.rowid = r.id WHERE v.rowid IS NULL AND r.is_sensitive = 0').get().n;
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
  const total = db.prepare('SELECT COUNT(*) AS n FROM records WHERE is_sensitive = 0').get().n;
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

// Vault records never keep index data. Older builds embedded them into vec_records; remove those.
if (vectorSearchAvailable) {
  const vaultIds = db.prepare('SELECT id FROM records WHERE is_sensitive = 1').all();
  for (const { id } of vaultIds) deleteEmbedding(id);
}

// Smart Recall v2 chunk index (search-index.js). Creates its tables, then indexes in the background.
searchIndex.init({
  db,
  vecLoaded: vectorSearchAvailable,
  helpers: { recordTitle, recordUrl, recordBody, attachmentDisplayName },
});

try {
  db.exec("ALTER TABLE records ADD COLUMN category TEXT DEFAULT 'Uncategorized'");
} catch (_) {}
try {
  db.exec("ALTER TABLE records ADD COLUMN tags TEXT DEFAULT ''");
} catch (_) {}

// ---------------------------------------------------------------------------
// WHO MAY TALK TO THIS SERVER (runs first, before the body is even parsed)
// Websites the user visits must never read or write memories here. Browsers add headers a web page
// cannot fake: Origin on cross-origin requests and on POSTs, and Sec-Fetch-Site on every request. So:
//   - Origin present: only RaSh's own extensions (their exact IDs) and RaSh's own dashboard page.
//   - No Origin: refused when the browser marks it as coming from another site (an <img>, <script> or
//     form a web page set up), except a plain GET page navigation (a link, or Google's OAuth redirect).
//     The RaSh extension's own GETs carry no Origin but are marked Sec-Fetch-Site: none, so they pass.
//   - Neither header: a program on this computer (the eval, curl, scripts). It could read rash.db
//     directly anyway, so it is allowed.
// Every request must also come from this computer and name localhost as its Host (stops DNS rebinding).
// Anything refused gets 403 with a JSON reason, and the server log says why.
// ---------------------------------------------------------------------------

// Chrome's ID for an unpacked extension is a hash of its folder path, so the server works out the IDs of
// RaSh's two extension folders itself (no settings, no change to the extensions). For a copy loaded from
// another folder, add its ID to RASH_EXTENSION_IDS (comma-separated).
function unpackedExtensionId(dir) {
  let p = fs.realpathSync.native(dir);
  if (process.platform === 'win32' && /^[a-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
  const hex = crypto.createHash('sha256').update(Buffer.from(p, process.platform === 'win32' ? 'utf16le' : 'utf8')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
const RASH_EXTENSIONS = new Map(); // extension ID -> name
for (const [dir, name] of [[path.join(__dirname, 'extension'), 'RaSh Ambient Capture'], [__dirname, 'RaSh Web Capture']]) {
  try { if (fs.existsSync(path.join(dir, 'manifest.json'))) RASH_EXTENSIONS.set(unpackedExtensionId(dir), name); } catch (_) {}
}
for (const raw of String(process.env.RASH_EXTENSION_IDS || '').split(',')) {
  const id = raw.trim().toLowerCase();
  if (/^[a-p]{32}$/.test(id)) RASH_EXTENSIONS.set(id, 'from RASH_EXTENSION_IDS');
}
const RASH_PAGE_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

function isRaShOrigin(origin) {
  if (RASH_PAGE_ORIGINS.has(origin)) return true;
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin || '');
  return !!m && RASH_EXTENSIONS.has(m[1]);
}
function isLoopbackAddress(a) {
  return a === '::1' || /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a || '');
}
// Why a request is refused, or '' if it may go on
function blockReason(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return 'it did not come from this computer';
  if (!LOCAL_HOSTS.has(String(req.headers.host || '').toLowerCase())) return `unexpected Host "${req.headers.host || ''}"`;
  const origin = req.headers.origin;
  if (origin) return isRaShOrigin(origin) ? '' : `origin ${origin} is not the RaSh extension or dashboard`;
  const site = req.headers['sec-fetch-site'];
  const pageNavigation = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate';
  if ((site === 'cross-site' || site === 'same-site') && !pageNavigation) return 'a web page on another site sent it';
  return '';
}
const blockLoggedAt = new Map(); // one log line per reason per minute, so a noisy page can't flood the log
app.use((req, res, next) => {
  const why = blockReason(req);
  if (why) {
    if (Date.now() - (blockLoggedAt.get(why) || 0) > 60000) {
      blockLoggedAt.set(why, Date.now());
      console.warn(`[Security] Blocked ${req.method} ${req.path}: ${why}.` +
        (/chrome-extension:/.test(why) ? ' If this is your RaSh extension loaded from another folder, add its ID to RASH_EXTENSION_IDS.' : ''));
    }
    return res.status(403).json({ error: `Blocked: RaSh's server only answers the RaSh extension and its own dashboard (${why}).` });
  }
  const origin = req.headers.origin;
  if (origin) { // CORS for exactly that origin, never "*"
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-vault-unlocked, x-vault-token, x-file-name, x-is-sensitive');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
console.log('[Security] Browser requests accepted only from: ' +
  [...RASH_EXTENSIONS].map(([id, name]) => `chrome-extension://${id} (${name})`).concat([...RASH_PAGE_ORIGINS]).join(', '));

// Middleware
app.use(express.json({ limit: '10mb' }));

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
      signal: AbortSignal.timeout(120000), // the vision model is slow on CPU, but must never hang
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
        keep_alive: searchIndex.CONFIG.KEEP_ALIVE,
        options: {
          temperature: 0.1,
          num_predict: 40,
          num_ctx: numCtxFor(OLLAMA_MODEL, 4096), // unset, Ollama used its own default and reloaded the model
        }
      }),
      signal: AbortSignal.timeout(20000), // a hung Ollama must not hold a save; falls back to "General"
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
    RETURNING id, last_updated
  `);

  const sensitive = is_sensitive ? 1 : 0;
  const row = upsertStmt.get({
    form_name,
    category: category || 'General',
    tags: tags || '',
    content,
    is_sensitive: sensitive,
  });
  if (!row || !row.id) return null;

  // A vault record (new, or just moved into the vault) keeps no index data of any kind.
  if (sensitive) {
    deleteEmbedding(row.id);
    searchIndex.purgeRecord(row.id);
    return row.id;
  }

  // The save is already done at this point. Indexing happens afterwards, in the background, so
  // saving never waits on the embedding model. The save event is logged now, so "what did I read
  // before X" stays right even when a page is saved again later.
  searchIndex.recordEvent(row.id, row.last_updated);
  searchIndex.enqueue(row.id);
  queueEmbedding(row.id, content);
  return row.id;
}

// Offline Inbox Directory Watcher (Text + Markdown + PDF)
const inboxDir = path.join(__dirname, 'rash-inbox');
if (!fs.existsSync(inboxDir)) {
  fs.mkdirSync(inboxDir, { recursive: true });
}

const watcher = TEST_MODE ? null : chokidar.watch(inboxDir, {
  ignored: /(^|[\/\\])\../,
  persistent: true,
  ignoreInitial: false,
  depth: 10
});

if (watcher) watcher.on('add', async (filePath) => {
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
  // iCloud Drive lives inside ~/Library, which the scan below skips on macOS, so it is listed on its own
  process.platform === 'darwin' ? path.join(homeDir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs') : '',
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
// macOS keeps app data in ~/Library (Containers, Mail, Messages, caches...). Walking it makes macOS ask
// whether Terminal may "access data from other apps" and fills the index with app internals, so the scan
// skips that one folder. A folder named Library anywhere else is still searched.
const SKIP_PATHS = new Set(process.platform === 'darwin' ? [path.join(path.resolve(homeDir), 'Library')] : []);

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
          if (depth < max && !SKIP_DIRS.has(entry.name.toLowerCase()) && !SKIP_PATHS.has(full)) {
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
    searchIndex.purgeRecord(Number(id));
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

// Smart Recall's answer model is always loaded with the same num_ctx: if any other call here
// happens to use that same model (e.g. RASH_MODEL set to it), it gets that value too, because a
// different num_ctx makes Ollama unload and reload the model.
function numCtxFor(model, wanted) {
  return model === searchIndex.CONFIG.ANSWER_MODEL ? searchIndex.CONFIG.ANSWER_NUM_CTX : wanted;
}

async function runOllama(prompt, numPredict, timeoutMs, model, numCtx) {
  const controller = new AbortController();
  const limit = timeoutMs || OLLAMA_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), limit);
  const useModel = model || OLLAMA_MODEL;
  try {
    const response = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: useModel,
        prompt,
        stream: false,
        keep_alive: searchIndex.CONFIG.KEEP_ALIVE,
        options: { temperature: 0.1, num_predict: numPredict, num_ctx: numCtxFor(useModel, numCtx || 4096) },
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
async function callOllama(prompt, numPredict, timeoutMs, model, numCtx) {
  const result = await runOllama(prompt, numPredict, timeoutMs, model, numCtx);
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

// ---------------------------------------------------------------------------
// Time wording for answers. Saved times are stored in UTC; answers use the laptop's local time zone (IST).
// ---------------------------------------------------------------------------
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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

// "File: 2026-09-22T11-54-28-432Z-unit 3 chem.pdf" -> "unit 3 chem.pdf"
function attachmentDisplayName(formName) {
  return String(formName || '')
    .replace(/^File:\s*/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/, '') // the collision-proof upload stamp
    .trim();
}

// "Elon Musk - Wikipedia (en.wikipedia.org)" -> "Elon Musk (Wikipedia)"
function readableTitle(record, maxLen) {
  let t = recordTitle(record).replace(/\s*\((?:[a-z0-9-]+\.)+[a-z]{2,}\)\s*$/i, '').trim();
  const m = t.match(/^(.+?)\s+[|–—-]\s+([^|–—-]{2,30})$/);
  if (m) t = m[1] + ' (' + m[2].trim() + ')';
  const limit = maxLen || 90;
  return t.length > limit ? t.slice(0, limit - 3) + '...' : t;
}

// ---------------------------------------------------------------------------
// INSTANT ANSWERS: time/date/day, answered with zero LLM calls. Typo/one-word forms
// ("tym", "wat time", "dat") are matched too, since these get typed in a hurry.
// ---------------------------------------------------------------------------
const RASH_TIMEZONE = 'Asia/Kolkata';
const INSTANT_TIME_RE = /^\s*(?:wh?at'?s?\s+)?(?:the\s+)?t(?:i|y)m(?:es?)?(?:\s+is\s+it)?\s*\??\s*$/i;
const INSTANT_DATE_RE = /^\s*(?:wh?at'?s?\s+)?(?:today'?s?\s+|the\s+)?da?te?\s*\??\s*$/i;
const INSTANT_DAY_RE = /^\s*(?:wh?at\s+)?day\s+is\s+it\s*\??\s*$|^\s*wh?at\s+day\s*(?:is\s+(?:it|today))?\s*\??\s*$/i;

// "and before that?" / "what about after that" has no topic of its own - resolve it against the
// last assistant turn's quoted page title, into the same shape Smart Recall's time-order route expects
// ("the page before/after X"). Shared by POST /api/ask and GET /api/ask/stream.
const FOLLOW_UP_RE = /^(?:and\s+|what\s+about\s+)*(before|after)\s+that\??$/;
function resolveFollowUpQuestion(cleanQuestion, history) {
  const followUpMatch = cleanQuestion.match(FOLLOW_UP_RE);
  if (!followUpMatch || !Array.isArray(history)) return cleanQuestion;
  const dir = followUpMatch[1];
  const lastAssistant = [...history].reverse()
    .find((m) => m && m.role === 'assistant' && typeof m.text === 'string');
  // The LAST quoted title is the one the answer ended on: in 'Right before "X", you were reading
  // "Y"', "before that" means before Y.
  const quotes = lastAssistant ? [...lastAssistant.text.matchAll(/"([^"]{3,120})"/g)] : [];
  const quoted = quotes.length ? quotes[quotes.length - 1] : null;
  return quoted ? `the page ${dir} ${quoted[1]}`.toLowerCase() : cleanQuestion;
}

function instantResult(answer) {
  return {
    found: true, kind: 'instant', source: 'system', source_label: 'Instant answer',
    title: '', answer, source_url: '', form_name: '', last_updated: '',
  };
}

// Returns a ready response, or null if this isn't one of the fixed set of instant intents.
function instantAnswer(rawQuestion) {
  const q = String(rawQuestion || '').trim();
  if (!q) return null;
  const now = new Date();
  const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: RASH_TIMEZONE, ...opts }).format(now);

  if (INSTANT_TIME_RE.test(q)) {
    return instantResult(instantWording('time', fmt({ hour: 'numeric', minute: '2-digit', hour12: true })));
  }
  if (INSTANT_DAY_RE.test(q)) {
    return instantResult(instantWording('day', fmt({ weekday: 'long' })));
  }
  if (INSTANT_DATE_RE.test(q)) {
    return instantResult(instantWording('date', fmt({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })));
  }
  return null;
}

// A few warm phrasings per instant answer, rotating; each states exactly the same time or date.
const INSTANT_WORDINGS = {
  time: [(v) => `It's ${v} (IST).`, (v) => `Right now it's ${v} (IST).`, (v) => `${v} (IST), on the dot-ish.`, (v) => `The clock says ${v} (IST).`],
  day: [(v) => `Today is ${v}.`, (v) => `It's ${v} today.`, (v) => `${v}, all day today.`],
  date: [(v) => `Today is ${v}.`, (v) => `It's ${v}.`, (v) => `Today's date: ${v}.`],
};
const instantTurn = { time: 0, day: 0, date: 0 };
function instantWording(kind, value) {
  const list = INSTANT_WORDINGS[kind];
  return list[instantTurn[kind]++ % list.length](value);
}

// Where a saved file lives on disk: uploads keep their stamped name in rash-attachments/, inbox
// files keep their path relative to rash-inbox/.
function filePathFor(record) {
  const stored = String(record.form_name || '').replace(/^File:\s*/i, '');
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/.test(stored) ? path.join(attachmentsDir, stored) : path.join(inboxDir, stored);
}

// Smart Recall v2 (smart-recall.js): routes and answers every memory question. Initialised here,
// after every constant it depends on is defined.
smartRecall.init({
  db,
  helpers: {
    recordTitle, recordUrl, recordBody, attachmentDisplayName, trimAnswer, summarizeRecord, filePathFor,
    isNotFoundReply: (text) => NOT_FOUND_REPLY.test(text),
  },
});

// Loads the answer model right after startup, with the same num_ctx every answer uses, so the first
// question doesn't also pay for reading the model from disk. Best effort: if Ollama is off this
// just logs once.
//
// Then, while RaSh runs, both models get a tiny request every KEEP_WARM_EVERY_MS. keep_alive alone
// wasn't enough: Ollama memory-maps the weights, and on an idle, memory-tight laptop Windows pages
// them out even though Ollama still lists the model as loaded - the next question then re-reads
// gigabytes from disk (measured: a 4-minute first answer). Generating one token runs the whole model
// once, which pulls the weights back into RAM and refreshes keep_alive at the same time.
async function warmModels(first) {
  const { ANSWER_MODEL, EMBED_MODEL, KEEP_ALIVE, ANSWER_NUM_CTX } = searchIndex.CONFIG;
  const t0 = Date.now();
  const post = (route, body, ms) => fetch('http://127.0.0.1:11434' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  }).then((r) => r.ok).catch(() => false);
  const [answerOk, embedOk] = await Promise.all([
    post('/api/generate', { model: ANSWER_MODEL, prompt: '.', stream: false, keep_alive: KEEP_ALIVE, options: { num_ctx: ANSWER_NUM_CTX, num_predict: 1, temperature: 0 } }, 180000),
    post('/api/embed', { model: EMBED_MODEL, input: 'warm', keep_alive: KEEP_ALIVE }, 60000),
  ]);
  const was = answerModelState;
  answerModelState = answerOk ? 'ready' : 'unavailable';
  if (first) {
    console.log(answerOk
      ? `[Ask] Answer model ${ANSWER_MODEL} loaded in ${Date.now() - t0} ms; kept warm while RaSh runs.`
      : `[Ask] Could not load ${ANSWER_MODEL}; is Ollama running?`);
  } else if (was !== answerModelState) {
    console.log(answerOk ? `[Ask] Answer model ${ANSWER_MODEL} is available again.` : `[Ask] Answer model ${ANSWER_MODEL} is not responding.`);
  }
  if (!embedOk && first) console.warn(`[Ask] Could not load ${EMBED_MODEL}; questions will use keyword search until it is back.`);
}
let answerModelState = 'loading';

function startKeepWarm() {
  warmModels(true);
  const timer = setInterval(() => warmModels(false), searchIndex.CONFIG.KEEP_WARM_EVERY_MS);
  if (timer.unref) timer.unref();
}

// While a question is being answered (/api/ask and /api/ask/stream), the index worker waits, so
// embedding never competes with an answer for the CPU.
app.use('/api/ask', (_req, res, next) => {
  searchIndex.beginQuery();
  let ended = false;
  res.once('close', () => { if (!ended) { ended = true; searchIndex.endQuery(); } });
  next();
});

// { backend, indexed, total, pending, embedModel, ollamaUp }. pending also counts records still
// waiting for their legacy whole-record vector, which /api/ask uses until phase 3.
app.get('/api/index/status', async (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'Not allowed.' });
  try {
    const s = await searchIndex.status();
    s.pending += legacyVectorsPending();
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ask', async (req, res) => {
  const { question, mode, page, history } = req.body;
  const isUnlocked = vaultUnlocked(req);

  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'Please enter a question.' });
  }

  // Runs before page mode too: a page-text payload for "time?" (the widget used to send one, from
  // its own now-fixed misrouting) must never reach the LLM with the page's text instead of the clock.
  const instant = instantAnswer(question);
  if (instant) return res.json(instant);

  // Page question: answered ONLY from the page text sent with the request. Saved memories are not used
  // and nothing is stored. One self-contained message to the local model.
  if (mode === 'page') {
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'Not allowed.' });
    const text = page && page.text;
    const title = page && page.title;
    const url = page && page.url;
    const summary = !!(page && page.summary);
    if (
      question.length > 500 ||
      typeof text !== 'string' || !text.trim() || text.length > 20000 ||
      (title !== undefined && (typeof title !== 'string' || title.length > 300)) ||
      (url !== undefined && url !== '' && (typeof url !== 'string' || url.length > 500 || !/^https?:\/\//i.test(url)))
    ) {
      return res.status(400).json({ error: 'Sorry, I could not use that page text. Please try again.' });
    }

    // "What's this page about" needs a real summary, not the one-liner used for specific-fact
    // questions - a different prompt (and no oneSentence() truncation) so 2-3 sentences survive.
    const prompt = summary
      ? `Using only the text below, write a 2-3 sentence summary of what this page is actually about - its main subject and the key points. Do not answer by repeating the page title alone; describe the real content. If there is not enough text to summarize, reply exactly: I could not find that.\n\nText:\n${text}\n\nQuestion: ${question.trim()}\n\nSummary:`
      : `Answer using only the text below. Reply with one complete sentence. If the answer is not in the text, reply exactly: I could not find that.\n\nText:\n${text}\n\nQuestion: ${question.trim()}\n\nAnswer:`;

    // A whole-page summary can run to ~3,000 words of input - the same long-context territory as
    // PDF summarization, so it gets the same treatment: the smaller model, a longer timeout, and a
    // bigger context window, instead of the fast 8b/60s/4096-token path used for a one-line answer.
    const raw = summary
      ? await callOllama(prompt, 220, 150000, SUMMARY_MODEL, 6144)
      : await callOllama(prompt, 150);
    if (raw === null) {
      return res.json({ found: false, source: 'page', message: "My local model isn't responding right now, so I can't answer. Please make sure Ollama is running." });
    }

    let answer;
    if (summary) {
      let cleaned = String(raw || '').replace(/\s+/g, ' ').trim();
      if (cleaned.length > 700) cleaned = cleaned.slice(0, 700).replace(/\s+\S*$/, '') + '.';
      const looksLikeTitleEcho = title && cleaned.toLowerCase().replace(/[^a-z0-9]/g, '') ===
        String(title).toLowerCase().replace(/[^a-z0-9]/g, '');
      answer = !cleaned || cleaned.length < 20 || looksLikeTitleEcho || NOT_FOUND_REPLY.test(cleaned)
        ? 'I could not find that.'
        : cleaned;
    } else {
      const sentence = oneSentence(raw);
      answer = !sentence || NOT_FOUND_REPLY.test(sentence) ? 'I could not find that.' : sentence;
    }

    return res.json({
      found: true,
      kind: 'page',
      source: 'page',
      source_label: 'From this page',
      title: '',
      answer,
      source_url: '',
      form_name: '',
      last_updated: '',
    });
  }

  try {
    // Conversation follow-ups ("and before that?") have no topic of their own - resolve them
    // against the last assistant turn's quoted title, into the same "page before/after X" shape a
    // fully-spelled-out question would produce. Then Smart Recall routes and answers it.
    const cleanQuestion = resolveFollowUpQuestion(question.toLowerCase().trim(), history);
    const result = await smartRecall.answer({ question, cleanQuestion, unlocked: isUnlocked });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// STREAMING: the same Smart Recall pipeline as POST /api/ask, as server-sent events. Answers that
// come straight from the data (instant, time order, lists, files) arrive as one "done" event; a
// model-written answer streams its tokens first. POST /api/ask stays the non-streaming path.
// ---------------------------------------------------------------------------
app.get('/api/ask/stream', async (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'Not allowed.' });
  const question = String(req.query.question || '').trim();
  if (!question) return res.status(400).json({ error: 'Please enter a question.' });
  let history = null;
  if (typeof req.query.history === 'string' && req.query.history) {
    try { history = JSON.parse(req.query.history); } catch (_) { history = null; }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const instant = instantAnswer(question);
  if (instant) {
    send('done', instant);
    return res.end();
  }

  try {
    const cleanQuestion = resolveFollowUpQuestion(question.toLowerCase().trim(), history);
    const result = await smartRecall.answer({
      question,
      cleanQuestion,
      unlocked: vaultUnlocked(req),
      onToken: (text) => send('token', { text }),
    });
    send('done', result);
  } catch (err) {
    send('done', { found: false, error: err.message });
  }
  res.end();
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
// Which model/hardware tier is actually in play - useful for the dashboard, and for confirming
// RASH_MODEL took effect without having to read server logs.
app.get('/api/system', (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'Not allowed.' });
  res.json({
    tier: HARDWARE_TIER,
    model: OLLAMA_MODEL,
    answerModel: searchIndex.CONFIG.ANSWER_MODEL, // Smart Recall's /api/ask answers
    answerModelState, // 'loading' | 'ready' | 'unavailable' (startup preload)
    ramGB: Math.round(os.totalmem() / (1024 ** 3)),
  });
});

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
  // day/month legitimately run 1-2 digits (e.g. "5"), so the usual 2-character floor would
  // reject valid values there - every other field keeps the original minimum.
  const minLength = (field === 'day' || field === 'month') && /^\d{1,2}$/.test(trimmed) ? 1 : 2;
  if (trimmed.length < minLength || AUTOFILL_LOW_CONFIDENCE_VALUES.has(trimmed.toLowerCase())) {
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

  // Catch up on any record that has no embedding yet (old records, or ones saved while Ollama
  // was down). Runs in the background; the server is already answering requests.
  sweepMissingEmbeddings();
  startKeepWarm();

  if (TEST_MODE) {
    console.log('[RaSh] Test mode: inbox watcher, file scan, MCP server and scheduled digest are off.');
    return;
  }

  console.log(`Watching inbox folder for offline files at: ${inboxDir}`);

  // Build the file-name index in the background, then refresh it every 5 minutes
  scanFiles().then(() => {
    console.log(`File finder ready: ${fileIndex.length} files indexed from ${fileRoots.length} folders.`);
  });
  setInterval(scanFiles, 5 * 60 * 1000);

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