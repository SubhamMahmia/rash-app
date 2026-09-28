You're working in my RaSh repo. RaSh is a privacy-first personal memory tool that runs 100% on the user's own laptop. Stack: Node.js + Express, better-sqlite3 (rash.db, WAL mode), Ollama at http://localhost:11434 (llama3.1:8b answers questions, llama3.2:3b summarizes PDFs), Chrome extension in extension/.

TASK: Smart Recall v2. Make POST /api/ask answer like a professional product:
1. Correct: finds the right memory, including exact names, file names and time-order questions ("what did I read before X").
2. Proof: every answer returns its sources (title, site or file, exact time).
3. Honest: if it isn't in memory, it says so. It never invents.
4. Fast on a CPU-only laptop. Speed matters as much as accuracy.
5. Measured: a repeatable test shows the score before and after.

FIRST: save this whole prompt, unchanged, as docs/SMART_RECALL_V2.md and re-read it at the start of every phase. If CLAUDE.md exists, follow it too.

RULES (never break these)
- Read the relevant code before changing it. If this spec conflicts with the code, tell me instead of guessing.
- These API contracts must keep working exactly as now: GET/POST /api/records, DELETE /api/records/:id, POST /api/vault/unlock, POST /api/ask, GET /api/export, POST /api/import, POST /api/auto-sort. You may add response fields and new routes; never rename or remove existing fields.
- Do not modify: index.html, style.css, app.js (my co-founder's website), mcp-server.js, the vault PIN logic, the old root-level extension files (manifest.json, background.js, popup.html in the repo root), or anything in extension/ (showing sources in the panel is a separate task).
- 100% local: the only network calls allowed are to Ollama on localhost. No cloud APIs, no telemetry.
- Vault records (is_sensitive = 1) never get chunks, vectors or events. Keep whatever vault behaviour /api/ask has today.
- Deleting a record, or moving it into the vault, immediately removes all of its index data.
- Schema changes are additive only (IF NOT EXISTS, guarded ADD COLUMN). Never drop or rewrite existing columns or data.
- Never log memory content or vault data. Metrics only.
- Must run on Windows and macOS with zero code changes (path.join, no shell-specific commands).
- The only new dependency allowed is sqlite-vec. Ask before adding anything else.
- Ollama being off or slow must never crash or hang RaSh: every Ollama call has a timeout and a graceful fallback.
- Never run git commit or git push, and never switch branches. I do all git myself.
- Work in phases. After each phase, tell me exactly how to test it, then STOP and wait for me to type "continue".

PHASE 0: AUDIT (no code changes)
Report briefly:
a) The real schema of every table in rash.db.
b) Every code path that creates, updates or deletes a record (POST /api/records, inbox watcher, attachments, Gmail fetch, weekly digest, import, auto-sort, form capture, anything else) and whether they share one save function.
c) How /api/ask works today: retrieval, prompt, model, Ollama options (num_ctx, keep_alive), response shape, and whether it streams.
d) How timestamps are stored (UTC or local, which columns), and whether a record keeps its first-saved time or only last_updated.
e) Any existing embeddings, RAG or sqlite-vec code.
f) Whether rash.db, rash.db-wal, rash.db-shm, .env, autofill-profile.json, rash-attachments/ and rash-inbox/ are git-ignored.
g) Current CORS settings (report only, don't change them).
Then give your plan in at most 15 bullets and stop.

PHASE 1: TEST HARNESS + BASELINE (don't touch /api/ask yet)
- Add scripts/eval-ask.js and an "eval" script in package.json.
- It builds a separate test database from fixtures (never touches rash.db), starts the server against it on a spare port in a test mode with the file watcher, cron jobs, Gmail fetch, email sending and all other background jobs off, asks the golden questions, prints a pass/fail table with the time per question, then shuts the server down. Must work on Windows and Mac. Normal server behaviour stays unchanged.
- Fixtures: about 20 records, timestamps generated relative to when the eval runs: a biryani recipe page from days ago; "Jeff Bezos - Wikipedia" followed about 10 minutes later by a Hardik Pandya article; another Wikipedia article earlier that day; a Gmail message saved after the last Wikipedia page; a YouTube page watched on the most recent Thursday before today around 10 PM; "Best budget laptops under ₹50,000"; a PDF "Unit 3 Chemistry Assignment"; a file "HVAC voice call agent"; a vault record containing "OTP 482913"; plus filler pages across several days.
- Golden questions (check which source comes back and the answer text; for the baseline, which has no sources field, judge from the answer text):
  1. what did i read before hardik pandya (lowercase on purpose, voice input looks like this) -> the Jeff Bezos page
  2. What was the last Wikipedia article I read? -> the latest Wikipedia page, never the Gmail record
  3. Where's my Unit 3 assignment? -> the Unit 3 PDF
  4. Show my last 3 files -> the 3 newest file records, newest first
  5. What was I watching on Thursday night? -> the YouTube page
  6. Which cheap notebooks was I looking at? -> the budget laptops page (keep that page free of the question's words)
  7. What did I do yesterday? -> only yesterday's records, with correct times
  8. What was the most recent email I saved? -> the Gmail record
  9. What's my OTP? -> the answer must not contain 482913
  10. When is my dentist appointment? -> exactly "I couldn't find that in your memory."
- Run it against the current /api/ask, report the baseline score, stop.

PHASE 2: SEARCH INDEX
- Before the first schema change, back up rash.db with better-sqlite3's db.backup() to a folder outside the repo and tell me the path.
- New module that fits the repo's structure. All tunables in one config block: EMBED_MODEL = "nomic-embed-text", ANSWER_MODEL (default: the current 8b), CHUNK_WORDS ~250, CHUNK_OVERLAP ~40, TOP_K = 4, RELEVANCE_FLOOR (tuned in phase 4).
- Table chunks (record_id, chunk_index, text, content_hash, embedding as a float32[768] BLOB) plus an FTS5 table over chunk text for keyword search (FTS5 ships with better-sqlite3).
- Chunking: split on paragraph and sentence boundaries; start every chunk with its record's title and site or file name so each chunk carries its context.
- Embeddings: Ollama POST /api/embed with batched input. nomic-embed-text needs task prefixes: "search_document: " on chunks, "search_query: " on questions. Don't skip these.
- Vector search: load sqlite-vec and use vec_distance_cosine() on the normal chunks table, so ordinary SQL filters (time range, site, record type) keep working. If sqlite-vec fails to load on a machine, fall back to cosine similarity in JavaScript on the same column, and log which backend is active.
- Saves never wait for indexing: every save path from phase 0 only queues the record id, and one background worker embeds it (the worker also runs in test mode). Re-embed only when content_hash changes.
- If records only keep last_updated, add an append-only record_events table (record_id, at), written on every save and backfilled from last_updated, so time-order answers stay right when a page is saved again.
- Backfill on startup through the same worker: one batch at a time, pauses while /api/ask is answering, resumable, logs progress like "Indexed 120/480". Startup never waits for it.
- Keep the embed model and chunk settings in a small meta table; if they change, the worker re-indexes everything automatically.
- New route GET /api/index/status -> { backend, indexed, total, pending, embedModel, ollamaUp }. Update the eval so it waits for pending = 0 before asking questions.

PHASE 3: QUESTION ROUTER
Classify questions with fast rules (regex and keywords, no extra LLM call, which would cost seconds on CPU). Many questions come from voice, lowercase with no punctuation, so rules must not depend on case or punctuation. Routes can combine:
- Time order ("before X", "after X"): find the anchor record for X with hybrid search, then its neighbouring events in time. Answer straight from the data, no LLM: "Right before Hardik Pandya (today at 2:33 PM), you were reading 'Jeff Bezos - Wikipedia' at 2:21 PM [1]."
- Time window ("today", "yesterday", "last week", "on Thursday", "at night", "this morning"): filter by local-time range, then rank inside it.
- Recency and files ("last", "latest", "most recent", "last 3 PDFs/files/emails"): SQL ordered by time, newest first; answer straight from the data as a short list, no LLM.
- Site ("on YouTube", "Wikipedia", "Gmail"): domain filter, combinable with the others.
- Everything else: hybrid search. Vector results plus FTS5 keyword results merged with Reciprocal Rank Fusion (k = 60), best chunk per record only (no duplicate sources), top TOP_K.
- If a rule-based route finds nothing, fall back to hybrid search instead of giving up.
- If neither the vector score nor the keyword match is strong, don't guess: return the not-found answer. Log top scores so the floor can be tuned.

PHASE 4: ANSWERS + TUNING
- Pre-format every timestamp in JavaScript, in the machine's local time zone, before the model sees it: "today at 2:33 PM", "yesterday evening", "Thursday 17 Sep at night". Day parts: morning 5-12, afternoon 12-17, evening 17-21, night 21-5. The model never does date math.
- System prompt for ANSWER_MODEL: answer only from the numbered memories provided; if the answer isn't there, reply exactly "I couldn't find that in your memory."; cite sources as [1], [2]; say when (and where) the user saw it; 1-3 calm, natural sentences; plain text.
- temperature 0.1. Set num_ctx explicitly and use the same value everywhere this model is called (a different num_ctx makes Ollama reload the model). Cap memory text at about 1,200 tokens, dropping the lowest-ranked chunks first: Ollama silently cuts off prompts longer than num_ctx, and on this CPU every extra chunk adds seconds. Keep models warm with keep_alive unless that's already handled.
- Response: keep every existing field; add sources: [{ n, id, title, urlOrPath, site, category, when, snippet }], route and tookMs. If /api/ask streams today, keep streaming.
- Fallbacks: embedding fails -> keyword-only search. Answer model fails or times out -> return the sources with "RaSh's AI engine isn't responding right now. Here are the closest matches."
- Log per request: route, top scores, prompt tokens (Ollama's prompt_eval_count) and timings.
- Tune RELEVANCE_FLOOR and TOP_K with the eval. Then run it with ANSWER_MODEL = llama3.1:8b and llama3.2:3b and report score and median time for each; keep 8b as default unless I say otherwise.
- Target: at least 9/10, and questions 9 and 10 must always pass.

FINAL REPORT: files changed, baseline vs new score, median answer time, what's still weak, and suggested follow-ups.
