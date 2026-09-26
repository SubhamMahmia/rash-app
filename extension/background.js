// RaSh Ambient Capture - background service worker
// Remembers the master ON/OFF switch, sends captured TEXT to the local RaSh server,
// answers questions (file finder + Ask), and opens found files.
// Never captures screenshots or pixels.

const SERVER = "http://localhost:3000";

// Words that suggest the user is asking for a file on their laptop
const FILE_HINTS = /\b(file|files|assignment|document|pdf|doc|docx|ppt|pptx|xls|xlsx|resume|report|photo|picture|image|download|downloaded)\b|where is my|find my|give me my|show me my/i;

// "What PDF did I save?" is not a request to search this laptop - it asks which files were saved
// into RaSh, which only the server can answer from its records. Those questions skip the file
// finder below, otherwise a stray matching file on disk would answer instead.
const FILE_NOUNS = /\b(file|files|pdf|pdfs|document|documents|doc|docs|attachment|attachments)\b/i;
const SAVED_VERBS = /\b(save|saved|saving|upload|uploaded|attach|attached)\b/i;
function isSavedFileQuestion(question) {
  return FILE_NOUNS.test(question) && SAVED_VERBS.test(question);
}

// ---------- Privacy: private sites and sensitive numbers (same rules as content.js) ----------
const PRIVATE_HOSTS = ["mail.google.com", "outlook.live.com", "outlook.office.com", "mail.yahoo.com"];
const PRIVATE_HOST_WORDS = /bank|netbanking|paytm|phonepe|hdfcbank|icicibank|sbi|axisbank/;

function isPrivateHost(host) {
  const h = String(host || "").toLowerCase();
  return PRIVATE_HOSTS.some((p) => h === p || h.endsWith("." + p)) || PRIVATE_HOST_WORDS.test(h);
}

function isMailHost(host) {
  const h = String(host || "").toLowerCase();
  return PRIVATE_HOSTS.some((p) => h === p || h.endsWith("." + p));
}

function hostOfUrl(url) {
  try { return new URL(url).hostname; } catch (e) { return ""; }
}

function scrubSensitive(text) {
  return String(text || "")
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, "[removed]")
    .replace(/\b(otp|code|pin|passcode)\b([^\d\n]{0,25})\d{4,8}\b/gi, "$1$2[removed]")
    .replace(/\b\d{4,8}\b(?=[^\d\n]{0,25}\b(?:otp|code|pin|passcode)\b)/gi, "[removed]");
}

// First install: master switch starts OFF
chrome.runtime.onInstalled.addListener(async () => {
  const { rashEnabled } = await chrome.storage.local.get("rashEnabled");
  if (rashEnabled === undefined) {
    await chrome.storage.local.set({ rashEnabled: false });
  }
});

async function findFile(query) {
  const res = await fetch(SERVER + "/api/find-file?q=" + encodeURIComponent(query));
  return await res.json();
}

// page is only sent for page questions: { title, url, text }
async function askRaSh(question, page) {
  const body = { question: question };
  if (page) { body.mode = "page"; body.page = page; }
  const res = await fetch(SERVER + "/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return await res.json();
}

async function openFile(filePath, reveal) {
  const res = await fetch(SERVER + "/api/open-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, reveal: reveal === true })
  });
  const data = await res.json();
  return { ok: res.ok, data: data };
}

// ---------- Gmail (read-only, fetched live only when asked) ----------
// This is a thin proxy to the server's Gmail endpoints. No email content is kept here, logged,
// or written to chrome.storage - it is passed straight back to the panel that asked for it.
// The status is reported back too, so the panel can explain a refusal (e.g. the server's
// local-origin check returning 403) instead of failing silently.
async function gmailRequest(path, options) {
  try {
    const res = await fetch(SERVER + path, options);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data: data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: "Can't reach the RaSh server. Start it and try again." } };
  }
}

// ---------- Chat attachments: a file the panel wants saved as a new record ----------
// The file arrives here as base64 (extension messages must be JSON-safe), decoded back to bytes,
// then sent to the server as a raw upload. Nothing about it is kept in this file.
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function saveAttachment(name, base64Data, isSensitive) {
  const bytes = base64ToBytes(base64Data);
  const res = await fetch(SERVER + "/api/attachments", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-file-name": encodeURIComponent(name).slice(0, 300),
      "x-is-sensitive": isSensitive === true ? "true" : "false"
    },
    body: bytes
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data: data };
}

// ---------- Shared Ask-panel chat history (stored only in chrome.storage.local) ----------
const CHAT_KEY = "rashChatHistory";
const CHAT_MAX = 100;

function clip(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function safeHttpUrl(value) {
  const v = clip(value, 500);
  return /^https?:\/\//i.test(v) ? v : "";
}

// Keep only known fields with size limits. Saved page text is never stored in the history.
function cleanChatItem(m) {
  if (!m || typeof m !== "object") return null;
  const base = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), ts: Date.now() };

  if (m.role === "user") {
    const text = clip(m.text, 500).trim();
    return text ? { ...base, role: "user", text: text } : null;
  }
  if (m.role === "note") {
    return { ...base, role: "note", kind: m.kind === "error" ? "error" : "muted", text: clip(m.text, 400) };
  }
  if (m.role === "answer") {
    return {
      ...base,
      role: "answer",
      kind: m.kind === "recent" ? "recent" : "answer",
      title: clip(m.title, 200),
      answer: clip(m.answer, 1000),
      source_url: safeHttpUrl(m.source_url),
      last_updated: clip(m.last_updated, 40),
      source_label: clip(m.source_label, 200),
      offer_memory: m.offer_memory === true,
      question: clip(m.question, 500)
    };
  }
  if (m.role === "files") {
    const items = (Array.isArray(m.items) ? m.items : [])
      .slice(0, 5)
      .map((f) => ({ name: clip(f && f.name, 300), folder: clip(f && f.folder, 500), path: clip(f && f.path, 600) }))
      .filter((f) => f.name && f.path);
    return items.length ? { ...base, role: "files", items: items } : null;
  }
  return null;
}

// All history writes go through one queue, so two tabs writing at the same moment cannot lose messages.
let chatQueue = Promise.resolve();
let stateQueue = Promise.resolve(); // serializes rashEnabled writes (see RASH_SET_STATE below)
function updateChat(change) {
  const run = chatQueue.then(async () => {
    const got = await chrome.storage.local.get(CHAT_KEY);
    const list = Array.isArray(got[CHAT_KEY]) ? got[CHAT_KEY] : [];
    await chrome.storage.local.set({ [CHAT_KEY]: change(list) });
  });
  chatQueue = run.catch(() => {});
  return run;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Add messages to the shared conversation (kept to the last CHAT_MAX)
  if (message.type === "RASH_CHAT_APPEND") {
    const clean = (Array.isArray(message.items) ? message.items : []).slice(0, 5).map(cleanChatItem).filter(Boolean);
    if (clean.length === 0) {
      sendResponse({ ok: false });
      return false;
    }
    updateChat((list) => list.concat(clean).slice(-CHAT_MAX)).then(
      () => sendResponse({ ok: true }),
      (err) => { console.error("RaSh chat save failed:", err); sendResponse({ ok: false }); }
    );
    return true;
  }

  // The user's own details, for filling in a form on the page - never touches rash.db
  if (message.type === "RASH_AUTOFILL_PROFILE") {
    gmailRequest("/api/autofill-profile").then(sendResponse);
    return true;
  }

  // Silent profile learning from a form the user filled in themselves - fire-and-forget from
  // the content script's side, but we still return the server's result in case it's ever needed.
  if (message.type === "RASH_AUTOFILL_LEARN") {
    gmailRequest("/api/autofill-profile/learn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field: message.field, value: message.value }),
    }).then(sendResponse);
    return true;
  }

  // Clear the shared conversation everywhere
  if (message.type === "RASH_CHAT_CLEAR") {
    updateChat(() => []).then(
      () => sendResponse({ ok: true }),
      (err) => { console.error("RaSh chat clear failed:", err); sendResponse({ ok: false }); }
    );
    return true;
  }

  // Ask: is the master switch ON?
  if (message.type === "RASH_GET_STATE") {
    chrome.storage.local.get("rashEnabled").then(({ rashEnabled }) => {
      sendResponse({ enabled: rashEnabled === true });
    });
    return true;
  }

  // Turn the master switch ON or OFF
  if (message.type === "RASH_SET_STATE") {
    // All rashEnabled writes go through one queue, so a fast "on" then "off" (e.g. from voice
    // commands) cannot commit or echo back to storage.onChanged listeners out of order.
    const run = stateQueue.then(() =>
      chrome.storage.local.set({
        rashEnabled: message.enabled === true,
        rashEnabledAt: typeof message.at === "number" ? message.at : Date.now(),
      })
    );
    stateQueue = run.catch(() => {});
    run.then(() => sendResponse({ ok: true }), () => sendResponse({ ok: true }));
    return true;
  }

  // Answer a question: file requests go to the file finder, everything else to Ask
  if (message.type === "RASH_QUERY") {
    (async () => {
      const question = String(message.question || "").trim();
      if (!question) {
        sendResponse({ ok: false, error: "empty" });
        return;
      }
      try {
        // Page questions go straight to the page-only answer; "memory-only" skips the file finder
        const p = message.page;
        if (message.mode === "page" && p && typeof p.text === "string") {
          const pageAnswer = await askRaSh(question, {
            title: clip(p.title, 300),
            url: safeHttpUrl(p.url),
            text: clip(p.text, 20000)
          });
          sendResponse({ ok: true, kind: "answer", data: pageAnswer });
          return;
        }
        if (message.mode !== "memory-only" && FILE_HINTS.test(question) && !isSavedFileQuestion(question)) {
          const fileResult = await findFile(question);
          if (fileResult && fileResult.found) {
            sendResponse({ ok: true, kind: "file", data: fileResult });
            return;
          }
        }
        const answer = await askRaSh(question);
        sendResponse({ ok: true, kind: "answer", data: answer });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  // Open a found file on this laptop (or show it in its folder)
  if (message.type === "RASH_OPEN") {
    (async () => {
      try {
        const result = await openFile(message.path, message.reveal);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  // Pull the text out of an attached PDF/text file so the panel can ask questions about it.
  // This does NOT save the file - that is still only "remember this".
  if (message.type === "RASH_FILE_TEXT") {
    (async () => {
      try {
        const bytes = base64ToBytes(String(message.data || ""));
        const res = await fetch(SERVER + "/api/file-text", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: bytes
        });
        const data = await res.json().catch(() => ({}));
        sendResponse({ ok: res.ok, status: res.status, data: data });
      } catch (err) {
        sendResponse({ ok: false, status: 0, data: { error: "Can't reach the RaSh server. Start it and try again." } });
      }
    })();
    return true;
  }

  // Ask one question about the attached file or image. Nothing is stored on this side.
  if (message.type === "RASH_ASK_FILE") {
    (async () => {
      try {
        const body = { question: message.question };
        if (typeof message.text === "string") body.text = message.text;
        if (typeof message.image === "string") body.image = message.image;
        if (message.mode) body.mode = message.mode;
        const res = await fetch(SERVER + "/api/ask-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        sendResponse({ ok: res.ok, status: res.status, data: data });
      } catch (err) {
        sendResponse({ ok: false, status: 0, data: { error: "Can't reach the RaSh server. Start it and try again." } });
      }
    })();
    return true;
  }

  // Is Gmail set up, and is it connected?
  if (message.type === "RASH_GMAIL_STATUS") {
    gmailRequest("/api/gmail/status").then(sendResponse);
    return true;
  }

  // Start the Google sign-in: ask the server for the URL, then open it in a new tab
  if (message.type === "RASH_GMAIL_CONNECT") {
    (async () => {
      const result = await gmailRequest("/api/gmail/connect", { method: "POST" });
      if (result.ok && result.data && result.data.url) {
        try {
          await chrome.tabs.create({ url: result.data.url });
        } catch (err) {
          sendResponse({ ok: false, status: result.status, data: { error: "Could not open the Google sign-in tab." } });
          return;
        }
      }
      sendResponse(result);
    })();
    return true;
  }

  // Fetch the latest 1-3 emails, live. Nothing about them is stored on this side.
  if (message.type === "RASH_GMAIL_RECENT") {
    const limit = Math.min(Math.max(parseInt(message.limit, 10) || 1, 1), 3);
    gmailRequest("/api/gmail/recent?limit=" + limit).then(sendResponse);
    return true;
  }

  if (message.type === "RASH_GMAIL_DISCONNECT") {
    gmailRequest("/api/gmail/disconnect", { method: "POST" }).then(sendResponse);
    return true;
  }

  // Save a file the user attached in the panel and asked to remember (only after they said so)
  if (message.type === "RASH_SAVE_ATTACHMENT") {
    (async () => {
      try {
        const name = typeof message.name === "string" ? message.name.slice(0, 300) : "file";
        const data = typeof message.data === "string" ? message.data : "";
        if (!data) { sendResponse({ ok: false, data: { error: "No file data was received." } }); return; }
        const result = await saveAttachment(name, data, message.is_sensitive === true);
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, data: { error: String(err) } });
      }
    })();
    return true;
  }

  // Save a form the user has just agreed to save (only after they clicked a button in the consent panel)
  if (message.type === "RASH_SAVE_FORM") {
    (async () => {
      const { rashEnabled } = await chrome.storage.local.get("rashEnabled");
      if (rashEnabled !== true) {
        sendResponse({ ok: false, reason: "off" });
        return;
      }
      const host = hostOfUrl((sender && sender.tab && sender.tab.url) || "");
      if (!host || isPrivateHost(host)) {
        sendResponse({ ok: false, reason: "private" });
        return;
      }
      const lines = (Array.isArray(message.fields) ? message.fields : [])
        .slice(0, 40)
        .map((f) => clip(f && f.label, 80).trim() + ": " + clip(f && f.value, 500).trim())
        .filter((l) => !/^:/.test(l));
      if (lines.length === 0) {
        sendResponse({ ok: false, reason: "empty" });
        return;
      }
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      try {
        const res = await fetch(SERVER + "/api/records", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            form_name: "Form: " + host + " (" + stamp + ")",
            category: "Forms",
            tags: host,
            content: scrubSensitive("Form filled on " + host + "\n" + lines.join("\n")),
            is_sensitive: message.is_sensitive === true
          })
        });
        const data = await res.json();
        sendResponse({ ok: res.ok, data: data });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  // Save captured text to the local server (only if the switch is ON)
  if (message.type === "RASH_CAPTURE") {
    (async () => {
      const { rashEnabled } = await chrome.storage.local.get("rashEnabled");
      if (rashEnabled !== true) {
        sendResponse({ ok: false, reason: "off" });
        return;
      }
      // Second line of defence: refuse private sites even if the page script let one through
      const pageUrl = (sender && sender.tab && sender.tab.url) || "";
      const sourceUrl = (String(message.content || "").match(/^Source:\s*(\S+)/i) || [])[1] || "";
      // Email sites are always refused; banking/payment sites only after the user clicked Yes in the panel
      const refused = (h) => isMailHost(h) || (message.confirmed !== true && isPrivateHost(h));
      if (refused(hostOfUrl(pageUrl)) || refused(hostOfUrl(sourceUrl))) {
        sendResponse({ ok: false, reason: "private" });
        return;
      }
      try {
        const res = await fetch(SERVER + "/api/records", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            form_name: scrubSensitive(message.title),
            content: scrubSensitive(message.content),
            is_sensitive: message.is_sensitive === true
          })
        });
        const data = await res.json();
        sendResponse({ ok: res.ok, data: data });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }
});