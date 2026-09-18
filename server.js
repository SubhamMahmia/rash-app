const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const pdfParse = require('pdf-parse');

const app = express();
const PORT = 3000;

const VAULT_PASSWORD = '1234';

// Initialize SQLite database
const db = new Database('memoro.db');
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

try {
  db.exec("ALTER TABLE records ADD COLUMN category TEXT DEFAULT 'Uncategorized'");
} catch (_) {}
try {
  db.exec("ALTER TABLE records ADD COLUMN tags TEXT DEFAULT ''");
} catch (_) {}

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS for browser extension
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-vault-unlocked');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Vault Authentication
app.post('/api/vault/unlock', (req, res) => {
  const { password } = req.body;
  if (password === VAULT_PASSWORD) {
    return res.json({ success: true, message: 'Vault unlocked.' });
  }
  return res.status(401).json({ success: false, error: 'Incorrect vault password.' });
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
        model: 'llama3.2:1b',
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
  `);

  upsertStmt.run({
    form_name,
    category: category || 'General',
    tags: tags || '',
    content,
    is_sensitive: is_sensitive ? 1 : 0,
  });
}

// Offline Inbox Directory Watcher (Text + Markdown + PDF)
const inboxDir = path.join(__dirname, 'inbox');
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
  const isUnlocked = req.headers['x-vault-unlocked'] === 'true';

  try {
    const stmt = db.prepare('SELECT * FROM records ORDER BY last_updated DESC');
    const records = stmt.all().map((rec) => {
      if (rec.is_sensitive === 1 && !isUnlocked) {
        return {
          ...rec,
          content: '🔒 LOCKED CONTENT — Enter Master PIN (1234) to decrypt and view.',
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
    res.json({ success: true, message: 'Record deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export records
app.get('/api/export', (req, res) => {
  const isUnlocked = req.headers['x-vault-unlocked'] === 'true';

  try {
    const records = isUnlocked
      ? db.prepare('SELECT * FROM records ORDER BY id ASC').all()
      : db.prepare('SELECT * FROM records WHERE is_sensitive = 0 ORDER BY id ASC').all();

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="memoro-backup.json"');
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

// Direct extraction via Ollama
async function askLocalOllama(question, contextText) {
  try {
    const prompt = `Text:
${contextText}

Question:
${question}

Instructions: Based ONLY on the text above, extract the direct and complete answer. Prioritize the primary action or core fact. Keep it direct and concise, without adding conversational filler.

Answer:`;

    const response = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:1b',
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 40,
        },
      }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data.response ? data.response.trim().replace(/^["']|["']$/g, '') : null;
  } catch (err) {
    console.error('Ollama query failed:', err.message);
    return null;
  }
}

// "Ask, Don't Search"
app.post('/api/ask', async (req, res) => {
  const { question } = req.body;
  const isUnlocked = req.headers['x-vault-unlocked'] === 'true';

  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Please enter a question.' });
  }

  try {
    const records = isUnlocked
      ? db.prepare('SELECT * FROM records').all()
      : db.prepare('SELECT * FROM records WHERE is_sensitive = 0').all();

    const cleanQuestion = question.toLowerCase().trim();
    const stopWords = new Set([
      'what', 'is', 'my', 'the', 'a', 'an', 'in', 'on', 'for', 'did',
      'i', 'write', 'about', 'tell', 'me', 'how', 'long', 'much', 'many', 'does',
    ]);

    const queryWords = cleanQuestion
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 0 && !stopWords.has(w));

    let bestMatch = null;
    let highestScore = 0;

    for (const record of records) {
      const lowerContent = record.content.toLowerCase();
      let score = 0;

      for (const word of queryWords) {
        if (lowerContent.includes(word)) score += 10;
      }

      for (let i = 0; i < queryWords.length - 1; i++) {
        const phrase = `${queryWords[i]} ${queryWords[i + 1]}`;
        if (lowerContent.includes(phrase)) score += 20;
      }

      if (score > highestScore) {
        highestScore = score;
        bestMatch = record;
      }
    }

    if (bestMatch && highestScore > 0) {
      const aiAnswer = await askLocalOllama(question, bestMatch.content);

      res.json({
        found: true,
        answer: aiAnswer || 'Could not parse with AI.',
        form_name: bestMatch.form_name,
        last_updated: bestMatch.last_updated,
      });
    } else {
      res.json({
        found: false,
        message: 'No matching memory found for this question.',
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Memoro server running at http://localhost:${PORT}`);
  console.log(`Watching inbox folder for offline files at: ${inboxDir}`);
});