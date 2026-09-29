// RaSh Ambient Capture - content script
// Draws the floating widget (Ask panel + ON/OFF switch) and reads page TEXT.
// Never screenshots or pixels. Text is only saved when the master switch is ON.

(function () {
  // Only run in the top page of normal websites
  if (window.top !== window) return;
  if (!/^https?:$/.test(location.protocol)) return;
  // Never capture RaSh's own local server pages
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return;
  // Don't inject twice (extension reload / duplicate injection)
  if (document.getElementById("rash-widget-host")) return;

  // Bumped whenever routing changes, so a stale content script in an already-open tab is obvious
  // from the console instead of looking like a detection bug. Chrome keeps running the old script
  // in open tabs until the extension is reloaded AND the tab refreshed.
  console.log("[RaSh] content script loaded (routing v2: gmail + file recall + page/memory)");

  const MAX_CHARS = 8000;
  const MIN_CHARS = 80;
  const CHAT_KEY = "rashChatHistory"; // shared conversation in chrome.storage.local (see background.js)

  // ---------- Privacy: private sites and sensitive numbers ----------
  const PRIVATE_HOSTS = ["mail.google.com", "outlook.live.com", "outlook.office.com", "mail.yahoo.com"];
  const PRIVATE_HOST_WORDS = /bank|netbanking|paytm|phonepe|hdfcbank|icicibank|sbi|axisbank/;

  function isPrivateHost(host) {
    const h = String(host || "").toLowerCase();
    return PRIVATE_HOSTS.some((p) => h === p || h.endsWith("." + p)) || PRIVATE_HOST_WORDS.test(h);
  }

  // Remove OTP-like numbers (4-8 digits near otp / code / pin) and card-like numbers (13-19 digits)
  function scrubSensitive(text) {
    return String(text || "")
      .replace(/\b(?:\d[ -]?){12,18}\d\b/g, "[removed]")
      .replace(/\b(otp|code|pin|passcode)\b([^\d\n]{0,25})\d{4,8}\b/gi, "$1$2[removed]")
      .replace(/\b\d{4,8}\b(?=[^\d\n]{0,25}\b(?:otp|code|pin|passcode)\b)/gi, "[removed]");
  }

  let enabled = false;
  let lastCaptured = "";
  let panelOpen = false;

  // Every local change to `enabled` is timestamped. The cross-tab sync listener further down only
  // accepts an incoming update if it's not older than the last one this tab has already applied, so
  // a delayed echo of a stale change (from this tab's own earlier write, or another tab's) can never
  // clobber a more recent local change, no matter how many rapid on/off cycles happen in between.
  let lastEnabledChangeAt = 0;
  function setEnabledLocally(next, callback) {
    const at = Date.now();
    lastEnabledChangeAt = at;
    enabled = next;
    render();
    safeSend({ type: "RASH_SET_STATE", enabled: next, at: at }, callback);
  }

  // ---------- Icons (small inline SVG, no emoji) ----------
  const ICON_PATHS = {
    send: '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
    close: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
    clip: '<path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.48"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/>',
    sheet: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16"/><path d="M4 15h16"/><path d="M10 4v16"/>',
    slides: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 9"/>',
    archive: '<path d="M4 8h16v12H4z"/><path d="M3 4h18v4H3z"/><path d="M10 12h4"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'
  };
  function icon(name, size) {
    return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON_PATHS[name] || "") + '</svg>';
  }

  // ---------- Floating widget (Shadow DOM keeps it isolated from the page) ----------
  const host = document.createElement("div");
  host.id = "rash-widget-host";
  host.style.cssText = "all:initial;position:fixed;top:0;right:0;width:0;height:0;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .wrap {
        position: fixed; top: 50%; right: 0; display: flex; align-items: center;
        font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
        font-size: 13px; line-height: 1.5; color: #F2F2F4; -webkit-font-smoothing: antialiased;
        transform: translateY(-50%) translateX(calc(100% - 28px));
        transition: transform 0.2s ease;
      }
      .wrap.open { transform: translateY(-50%) translateX(0); }
      button { font-family: inherit; }
      .switch:focus-visible, .x:focus-visible, .chip:focus-visible, .send:focus-visible,
      .mic:focus-visible, .btn:focus-visible, .dock:focus-visible, a.source:focus-visible {
        outline: 2px solid rgba(242,242,244,0.55); outline-offset: 2px;
      }

      /* ---- Panel ---- */
      .panel {
        display: none; flex-direction: column;
        width: 360px; max-width: calc(100vw - 76px); max-height: min(560px, 80vh);
        margin-right: 10px;
        background: rgba(17,17,20,0.94);
        -webkit-backdrop-filter: blur(18px) saturate(140%); backdrop-filter: blur(18px) saturate(140%);
        border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; overflow: hidden;
        box-shadow: 0 12px 40px rgba(0,0,0,0.45);
      }
      .panel.show { display: flex; animation: enter 0.2s ease; }
      @keyframes enter { from { opacity: 0; transform: translateX(8px); } to { opacity: 1; transform: none; } }

      .head {
        display: flex; align-items: center; gap: 10px; padding: 14px 12px 12px 16px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
      }
      .logo {
        width: 28px; height: 28px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
        border-radius: 8px; background: #1A1A1F; border: 1px solid rgba(255,255,255,0.1);
        color: #F2F2F4; font-weight: 600; font-size: 13px;
      }
      .titles { flex: 1; min-width: 0; }
      .ttl { font-weight: 600; font-size: 14px; letter-spacing: -0.01em; color: #F2F2F4; }
      .sub { font-size: 12px; color: #9A9AA5; display: flex; align-items: center; gap: 6px; }
      .dot { width: 6px; height: 6px; border-radius: 50%; background: #55555E; transition: background 0.2s ease; }
      .dot.on { background: #2FBF71; }
      .onoff { flex-shrink: 0; font-size: 12px; font-weight: 500; white-space: nowrap; color: #9A9AA5; transition: color 0.2s ease; }
      .onoff.on { color: #2FBF71; }

      .switch {
        all: unset; cursor: pointer; position: relative; flex-shrink: 0;
        width: 38px; height: 22px; border-radius: 999px; background: #3A3A42;
        transition: background 0.2s ease;
      }
      .switch::after {
        content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
        border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.35);
        transition: transform 0.2s ease;
      }
      .switch.on { background: #2FBF71; }
      .switch.on::after { transform: translateX(16px); }

      .x {
        all: unset; cursor: pointer; width: 28px; height: 28px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        border-radius: 8px; color: #9A9AA5; transition: background 0.2s ease, color 0.2s ease;
      }
      .x:hover { background: rgba(255,255,255,0.07); color: #F2F2F4; }
      .x[hidden] { display: none; }

      /* ---- Attached file (paperclip / drag-and-drop) ---- */
      .attach-row[hidden] { display: none; }
      .attach-row { padding: 0 16px; }
      .attach-row .card { padding: 10px 12px; }
      .attach-row .file { padding: 0; border: none; }
      .panel.drag-over { outline: 2px dashed rgba(255,255,255,0.4); outline-offset: -2px; }
      .x.confirm {
        width: auto; padding: 0 9px; font-size: 12px; font-weight: 500; white-space: nowrap;
        color: #E6B8BA; border: 1px solid rgba(229,72,77,0.35); background: rgba(229,72,77,0.06);
      }

      /* ---- Conversation ---- */
      .chat {
        flex: 1; min-height: 160px; overflow-y: auto; padding: 16px;
        display: flex; flex-direction: column; gap: 12px;
        scrollbar-width: thin; scrollbar-color: #3A3A42 transparent;
      }
      .empty { text-align: center; padding: 14px 4px 4px; color: #9A9AA5; }
      .empty .big { font-size: 15px; font-weight: 600; color: #F2F2F4; margin-bottom: 4px; letter-spacing: -0.01em; }
      .chips { display: flex; flex-direction: column; gap: 8px; margin-top: 18px; }
      .chip {
        all: unset; cursor: pointer; text-align: left; padding: 10px 12px; border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.1); color: #C9C9D1; font-size: 13px;
        transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
      }
      .chip:hover { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.18); color: #F2F2F4; }

      .me {
        align-self: flex-end; max-width: 85%; padding: 8px 12px; word-break: break-word;
        background: #24242B; color: #F2F2F4; border-radius: 12px 12px 4px 12px;
      }
      .card {
        align-self: stretch; padding: 12px 14px; border-radius: 12px;
        background: transparent; border: 1px solid rgba(255,255,255,0.08);
      }
      .card.muted { color: #9A9AA5; }
      .card.error { border-color: rgba(229,72,77,0.35); background: rgba(229,72,77,0.05); color: #E6B8BA; }
      .label {
        font-size: 11px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase;
        color: #9A9AA5; margin-bottom: 6px;
      }
      .ctitle { font-weight: 600; color: #F2F2F4; margin-bottom: 4px; word-break: break-word; letter-spacing: -0.005em; }
      .body { color: #D4D4DA; word-break: break-word; white-space: pre-wrap; }
      .meta { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 12px; font-size: 12px; color: #9A9AA5; }
      a.source {
        display: inline-flex; align-items: center; gap: 5px; max-width: 100%;
        padding: 3px 10px; border-radius: 999px; text-decoration: none;
        border: 1px solid rgba(255,255,255,0.12); color: #C9C9D1;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        transition: background 0.2s ease, color 0.2s ease;
      }
      a.source:hover { background: rgba(255,255,255,0.06); color: #F2F2F4; }
      a.source svg { flex-shrink: 0; }

      /* Sources under an answer, and the [n] badges in its text that point at them */
      .cite {
        all: unset; cursor: pointer; display: inline-block; min-width: 9px; padding: 0 4px; margin: 0 1px;
        font-size: 10.5px; line-height: 15px; text-align: center; vertical-align: 1px;
        border-radius: 5px; background: rgba(255,255,255,0.08); color: #C9C9D1;
        transition: background 0.2s ease, color 0.2s ease;
      }
      .cite:hover, .cite:focus-visible { background: rgba(47,191,113,0.18); color: #F2F2F4; }
      .srcs { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
      .src {
        all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 9px; width: 100%;
        padding: 6px 9px; border-radius: 9px; border: 1px solid rgba(255,255,255,0.08); cursor: pointer;
        font-family: inherit; transition: background 0.2s ease, border-color 0.2s ease;
      }
      .src:hover, .src:focus-visible { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.16); }
      .src.static { cursor: default; }
      .src.static:hover { background: transparent; border-color: rgba(255,255,255,0.08); }
      .src.flash { border-color: rgba(47,191,113,0.55); background: rgba(47,191,113,0.07); }
      .src .n { flex-shrink: 0; min-width: 10px; font-size: 10.5px; color: #8A8A94; text-align: right; }
      .src .av {
        flex-shrink: 0; width: 22px; height: 22px; border-radius: 6px; background: #1A1A1F; color: #C9C9D1;
        display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600;
      }
      .src .txt { min-width: 0; flex: 1; display: flex; flex-direction: column; }
      .src .st { color: #E4E4E8; font-size: 12.5px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .src .sm { color: #9A9AA5; font-size: 11.5px; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .card.calm { background: rgba(255,255,255,0.02); color: #C9C9D1; }
      .tip { margin-top: 6px; font-size: 12px; color: #8A8A94; }

      .file {
        display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; margin-top: 8px;
        border-radius: 10px; border: 1px solid rgba(255,255,255,0.08);
      }
      .frow1 { display: flex; gap: 10px; align-items: center; }
      .ficon {
        width: 32px; height: 32px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
        border-radius: 8px; background: #1A1A1F; color: #9A9AA5;
      }
      .fname { font-weight: 500; color: #F2F2F4; word-break: break-word; }
      .fpath { font-size: 12px; color: #9A9AA5; }
      .frow { display: flex; gap: 8px; }
      .btn {
        all: unset; cursor: pointer; padding: 6px 12px; border-radius: 8px; font-size: 12px; font-weight: 500;
        background: #F2F2F4; color: #111114; transition: background 0.2s ease, border-color 0.2s ease;
      }
      .btn:hover { background: #FFFFFF; }
      .btn.ghost { background: transparent; color: #F2F2F4; border: 1px solid rgba(255,255,255,0.14); padding: 5px 11px; }
      .btn.ghost:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.22); }

      .thinking {
        align-self: flex-start; display: flex; gap: 5px; padding: 12px 14px; border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.08);
      }
      .thinking i { width: 5px; height: 5px; border-radius: 50%; background: #9A9AA5; animation: blink 1.1s infinite ease-in-out; }
      .thinking i:nth-child(2) { animation-delay: 0.15s; }
      .thinking i:nth-child(3) { animation-delay: 0.3s; }
      @keyframes blink { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }

      /* ---- Input ---- */
      .foot { display: flex; gap: 8px; padding: 12px; border-top: 1px solid rgba(255,255,255,0.06); }
      input {
        flex: 1; min-width: 0; height: 36px; padding: 0 12px; border-radius: 10px; outline: none;
        border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04);
        color: #F2F2F4; font-size: 13px; font-family: inherit;
        transition: border-color 0.2s ease, background 0.2s ease;
      }
      input::placeholder { color: #6E6E78; }
      input:focus { border-color: rgba(255,255,255,0.3); background: rgba(255,255,255,0.06); }
      .mic, .send {
        all: unset; box-sizing: border-box; cursor: pointer; width: 36px; height: 36px; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center; border-radius: 10px;
        transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
      }
      .mic { border: 1px solid rgba(255,255,255,0.1); color: #C9C9D1; }
      .mic:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.18); }
      .mic.listening { border-color: rgba(229,72,77,0.55); background: rgba(229,72,77,0.12); color: #F0A9AC; animation: pulse 1.2s infinite; }
      .send { background: #F2F2F4; color: #111114; }
      .send:hover { background: #FFFFFF; }
      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(229,72,77,0.35); }
        70% { box-shadow: 0 0 0 7px rgba(229,72,77,0); }
        100% { box-shadow: 0 0 0 0 rgba(229,72,77,0); }
      }

      /* ---- Status pill ---- */
      .status {
        display: none; position: absolute; right: 12px; bottom: calc(100% + 10px);
        font-size: 12px; color: #F2F2F4; white-space: nowrap;
        background: rgba(17,17,20,0.94); border: 1px solid rgba(255,255,255,0.08);
        padding: 6px 12px; border-radius: 999px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      }

      /* ---- Edge tab (slim pill; the "Ask" label slides out with the widget) ---- */
      .dock {
        all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: stretch;
        filter: drop-shadow(0 8px 20px rgba(0,0,0,0.4));
      }
      .dock .lbl, .dock .strip {
        background: #131316; border: 1px solid rgba(255,255,255,0.08); border-right: none;
        transition: background 0.2s ease;
      }
      /* The slim pill (always visible on the edge) comes first; the "Ask" label follows and slides out with it */
      .dock .strip {
        width: 28px; padding: 14px 0; border-radius: 12px 0 0 12px;
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
      }
      .dock .lbl {
        width: 46px; border-radius: 0; display: flex; align-items: center; justify-content: center;
        font-size: 12px; font-weight: 500; color: #C9C9D1;
      }
      .dock:hover .lbl, .dock:hover .strip { background: #19191D; }
      .dock .name {
        writing-mode: vertical-rl; transform: rotate(180deg);
        font-size: 10px; font-weight: 600; letter-spacing: 0.14em; color: #B4B4BD;
      }
      .dock .state { width: 6px; height: 6px; border-radius: 50%; background: #2FBF71; opacity: 0; transition: opacity 0.2s ease; }
      .dock .state.on { opacity: 1; }

      /* ---- "RaSh is watching" pulse (only while ON) and save toast ---- */
      .dock .state.on { animation: watch 2.6s ease-in-out infinite; }
      @keyframes watch { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
      .toast {
        position: fixed; top: 16px; right: 16px; max-width: min(320px, calc(100vw - 32px));
        padding: 8px 14px; border-radius: 999px; pointer-events: none;
        background: rgba(17,17,20,0.94); border: 1px solid rgba(255,255,255,0.1);
        box-shadow: 0 8px 24px rgba(0,0,0,0.4); color: #F2F2F4;
        font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 12px; line-height: 1.4;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        opacity: 0; transform: translateY(-6px); transition: opacity 0.2s ease, transform 0.2s ease;
      }
      .toast.show { opacity: 1; transform: none; }

      /* ---- Form consent panel ---- */
      .consent {
        position: fixed; right: 16px; bottom: 16px; width: 340px; max-width: calc(100vw - 32px);
        padding: 16px; border-radius: 14px; background: rgba(17,17,20,0.97);
        border: 1px solid rgba(255,255,255,0.12); box-shadow: 0 12px 40px rgba(0,0,0,0.5);
        font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 13px; line-height: 1.5; color: #F2F2F4;
      }
      .consent .ctext { margin-bottom: 12px; }
      .consent .crow { display: flex; flex-wrap: wrap; gap: 8px; }

      /* ---- "Hey RaSh" wake-phrase row ---- */
      .wakerow {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 9px 16px; border-bottom: 1px solid rgba(255,255,255,0.06);
        font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
        font-size: 12px; color: #9A9AA5;
      }
      .wakerow.on { color: #C9C9D1; }

      @media (prefers-reduced-motion: reduce) {
        * { animation: none !important; transition: none !important; }
      }
    </style>
    <div class="wrap" id="wrap">
      <div class="status" id="status"></div>
      <div class="panel" id="panel" role="dialog" aria-label="Ask RaSh">
        <div class="head">
          <div class="logo">R</div>
          <div class="titles">
            <div class="ttl">Ask RaSh</div>
            <div class="sub"><span class="dot" id="dot"></span><span id="subtext">Not saving pages</span></div>
          </div>
          <span class="onoff" id="onoff">RaSh OFF</span>
          <button id="toggle" class="switch" role="switch" aria-checked="false" title="Save pages I read"></button>
          <button id="clear" class="x" title="Clear history" aria-label="Clear history" hidden>${icon("trash", 15)}</button>
          <button id="settings" class="x" title="Options" aria-label="Options">${icon("gear", 15)}</button>
          <button id="close" class="x" title="Close (Esc)" aria-label="Close">${icon("close", 16)}</button>
        </div>
        <div class="wakerow" id="wakeRow">
          <span id="wakeLabel">Listen for &quot;Hey RaSh&quot;</span>
          <button id="wakeToggle" class="switch" role="switch" aria-checked="false" title="Listen for 'Hey RaSh, turn on' / 'turn off'"></button>
        </div>
        <div class="chat" id="answer"></div>
        <div class="attach-row" id="attachRow" hidden></div>
        <div class="foot">
          <input id="q" type="text" placeholder="Ask about anything you've read..."
            autocomplete="off" autocorrect="off" spellcheck="false" name="rash-question"
            data-lpignore="true" data-1p-ignore="true" data-form-type="other" />
          <input id="attachFile" type="file" accept=".pdf,.txt,image/png,image/jpeg,image/gif,image/webp" hidden />
          <button id="attach" class="mic" title="Attach a file" aria-label="Attach a file">${icon("clip", 16)}</button>
          <button id="mic" class="mic" title="Speak your question" aria-label="Speak your question">${icon("mic", 16)}</button>
          <button id="go" class="send" title="Ask" aria-label="Send">${icon("send", 16)}</button>
        </div>
      </div>
      <button id="ask" class="dock" title="Ask RaSh">
        <span class="strip"><span class="state" id="state"></span><span class="name" aria-hidden="true">RaSh</span></span>
        <span class="lbl">Ask</span>
      </button>
    </div>
  `;
  const wrap = shadow.getElementById("wrap");
  const panel = shadow.getElementById("panel");
  const answerEl = shadow.getElementById("answer");
  const input = shadow.getElementById("q");
  const goBtn = shadow.getElementById("go");
  const micBtn = shadow.getElementById("mic");
  const attachBtn = shadow.getElementById("attach");
  const attachFileInput = shadow.getElementById("attachFile");
  const attachRow = shadow.getElementById("attachRow");
  const wakeRow = shadow.getElementById("wakeRow");
  const wakeToggleBtn = shadow.getElementById("wakeToggle");
  const settingsBtn = shadow.getElementById("settings");
  const closeBtn = shadow.getElementById("close");
  const clearBtn = shadow.getElementById("clear");
  const askBtn = shadow.getElementById("ask");
  const toggleBtn = shadow.getElementById("toggle");
  const statusEl = shadow.getElementById("status");
  const dotEl = shadow.getElementById("dot");
  const subEl = shadow.getElementById("subtext");
  const stateEl = shadow.getElementById("state");
  const onoffEl = shadow.getElementById("onoff");

  // ---------- Slide in / slide out ----------
  let closeTimer = null;
  function openWidget() {
    clearTimeout(closeTimer);
    wrap.classList.add("open");
  }
  function scheduleClose(ms) {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!panelOpen) wrap.classList.remove("open");
    }, ms);
  }
  wrap.addEventListener("mouseenter", openWidget);
  wrap.addEventListener("mouseleave", () => scheduleClose(800));

  function render() {
    toggleBtn.classList.toggle("on", enabled);
    toggleBtn.setAttribute("aria-checked", enabled ? "true" : "false");
    dotEl.classList.toggle("on", enabled);
    stateEl.classList.toggle("on", enabled);
    subEl.textContent = enabled ? "Saving pages" : "Not saving pages";
    onoffEl.textContent = enabled ? "RaSh ON" : "RaSh OFF";
    onoffEl.classList.toggle("on", enabled);
    if (!enabled) { closeSensitive(); closeDest(); } // OFF discards anything waiting for an answer
  }

  let statusTimer = null;
  function setStatus(msg) {
    statusEl.textContent = msg;
    statusEl.style.display = "block";
    openWidget();
    scheduleClose(3000);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { statusEl.style.display = "none"; }, 3000);
  }

  function safeSend(message, callback) {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) { callback && callback(null); return; }
        callback && callback(response);
      });
    } catch (e) {
      callback && callback(null); // extension was reloaded; refresh the page
    }
  }

  // ---------- Ask panel: open / close ----------
  function openPanel() {
    panelOpen = true;
    panel.classList.add("show");
    openWidget();
    scrollToEnd(); // messages may have arrived while the panel was hidden
    input.focus();
  }
  function closePanel() {
    panelOpen = false;
    panel.classList.remove("show");
    scheduleClose(800);
  }

  closeBtn.addEventListener("click", closePanel);
  askBtn.addEventListener("click", () => {
    if (panelOpen) closePanel();
    else openPanel();
  });

  // Esc closes the panel (also when the page has focus)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panelOpen) closePanel();
  });

  // ---------- Push-to-talk microphone ----------
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;
  let listening = false;

  if (SpeechRecognitionCtor) {
    recognizer = new SpeechRecognitionCtor();
    recognizer.continuous = false;
    recognizer.interimResults = false;
    recognizer.lang = "en-US";

    recognizer.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      input.value = transcript;
      input.focus();
    };

    recognizer.onerror = (event) => {
      setStatus("Mic error: " + (event.error || "unknown"));
    };

    recognizer.onend = () => {
      listening = false;
      micBtn.classList.remove("listening");
    };
  } else {
    micBtn.style.display = "none"; // browser doesn't support speech recognition
  }

  micBtn.addEventListener("click", () => {
    if (!recognizer) return;
    if (listening) {
      recognizer.stop();
      listening = false;
      micBtn.classList.remove("listening");
      return;
    }
    openPanel();
    try {
      recognizer.start();
      listening = true;
      micBtn.classList.add("listening");
      setStatus("Listening...");
    } catch (e) {
      // start() throws if called twice in a row too quickly; ignore
    }
  });

  // ---------- "Hey RaSh, turn on / turn off" wake phrase ----------
  // A separate, continuous recognizer from the push-to-talk mic above. Off by default; nothing about
  // what is heard is saved anywhere, it is only checked in memory against the two phrases below.
  const WAKE_ENABLED_KEY = "rashWakeWordEnabled"; // shared across tabs, like rashEnabled
  const WAKE_NOTICE_KEY = "rashWakeNoticeSeen"; // the one-time consent notice, shown once ever
  const WAKE_WORD = "(?:hey\\s+)?(?:rash|rashe|rasch|rach|rush|rosh|rosch|roach|roche|raj|ra\\s*sh)\\b";
  const WAKE_ON = new RegExp(WAKE_WORD + ".{0,12}\\bturn(?:ed)?\\s+on\\b", "i");
  const WAKE_OFF = new RegExp(WAKE_WORD + ".{0,12}\\bturn(?:ed)?\\s+off\\b", "i");

  // Observation only: when neither pattern above matches but the phrase still ends "turn on/off",
  // log the likely stand-in word for "RaSh" so the accepted list above can be grown from real samples.
  // This never changes the switch or shows anything in the panel.
  const WAKE_TAIL = /\bturn\s+(on|off)\s*$/i;
  const WAKE_FALLBACK_SKIP = new Set(["hey", "the", "please", "okay", "ok", "turn", "on", "off"]);
  function logPossibleWakePhrase(text) {
    if (!WAKE_TAIL.test(text)) return;
    const words = text.toLowerCase().replace(/[^a-z\s]/g, "").trim().split(/\s+/);
    const candidate = words.slice(0, 3).find((w) => w.length >= 3 && w.length <= 6 && !WAKE_FALLBACK_SKIP.has(w));
    if (candidate) {
      console.log("[RaSh Voice] possible unmatched wake phrase:", JSON.stringify(text), "- candidate word:", candidate);
    }
  }

  let wakeEnabled = false;      // reflected in the switch; mirrors WAKE_ENABLED_KEY
  let wakeRecognizer = null;
  let wakeShouldRun = false;    // the user's intent (on/off), independent of whether it is running right now
  let wakeActive = false;       // whether wakeRecognizer.start() has been called and not yet ended
  let wakeRestartTimer = null;
  let wakeErrorStreak = 0;
  let wakeHandledIndices = new Set(); // result indices already acted on; reset each time the recognizer (re)starts

  function setWakeToggleUI(on) {
    wakeEnabled = on;
    wakeToggleBtn.classList.toggle("on", on);
    wakeToggleBtn.setAttribute("aria-checked", on ? "true" : "false");
    wakeRow.classList.toggle("on", on);
  }

  function ensureWakeRecognizer() {
    if (wakeRecognizer || !SpeechRecognitionCtor) return;
    wakeRecognizer = new SpeechRecognitionCtor();
    wakeRecognizer.lang = "en-US";
    wakeRecognizer.continuous = true;
    wakeRecognizer.interimResults = true;

    // Finds where a pattern's LAST match starts in the text, or -1 if it doesn't match at all.
    // Used when both "turn on" and "turn off" are present in one growing transcript, so we act on
    // whichever was actually said most recently, not just whichever regex happens to be checked first.
    function lastMatchIndex(re, text) {
      const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      let last = -1, m;
      while ((m = g.exec(text))) last = m.index;
      return last;
    }

    wakeRecognizer.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = ((result[0] && result[0].transcript) || "").trim();
        console.log("[RaSh Voice] onresult:", i, "isFinal:", result.isFinal, "text:", JSON.stringify(text));
        if (!text) continue;
        wakeErrorStreak = 0;

        // Only ignore repeats of THIS SAME utterance (same result index) — a later, different
        // utterance can still fire, without needing to wait for the recognizer to restart.
        if (wakeHandledIndices.has(i)) continue;

        // Checked on every result, interim or final, so the switch reacts the moment the phrase is
        // heard instead of waiting for the browser to decide the utterance is finished.
        const isOn = WAKE_ON.test(text);
        const isOff = WAKE_OFF.test(text);
        // If both are present in this same growing transcript, the one that appears LAST is the
        // one most recently said, and is the one we should act on.
        let action = null;
        if (isOn && isOff) {
          action = lastMatchIndex(WAKE_OFF, text) > lastMatchIndex(WAKE_ON, text) ? "off" : "on";
        } else if (isOn) {
          action = "on";
        } else if (isOff) {
          action = "off";
        }
        console.log("[RaSh Voice] match check:", { text: text, matchedOn: isOn, matchedOff: isOff, action: action, currentlyEnabled: enabled, isFinal: result.isFinal });
        if (action === "on" && !enabled) {
          wakeHandledIndices.add(i);
          setEnabledLocally(true);
          if (enabled) capture();
          showToast("RaSh is turned on.");
        } else if (action === "off" && enabled) {
          wakeHandledIndices.add(i);
          setEnabledLocally(false);
          showToast("RaSh is turned off.");
        } else if (result.isFinal && !action) {
          logPossibleWakePhrase(text);
        }
      }
    };

    wakeRecognizer.onerror = (event) => {
      const err = event.error;
      console.log("[RaSh Voice] onerror:", err);
      if (err === "no-speech") return; // harmless; onend will restart it
      if (err === "audio-capture" || err === "not-allowed" || err === "service-not-allowed") {
        // The mic is unavailable or access was denied/revoked; stop, and don't keep re-prompting
        wakeShouldRun = false;
        setWakeToggleUI(false);
        try { chrome.storage.local.set({ [WAKE_ENABLED_KEY]: false }); } catch (e) {}
        setStatus(err === "audio-capture"
          ? "No microphone found for 'Hey RaSh'."
          : "Microphone access was blocked. Allow it in this site's settings to use 'Hey RaSh' again.");
        return;
      }
      wakeErrorStreak++; // a network hiccup or similar: back off a little more each time, then give up
    };

    wakeRecognizer.onend = () => {
      wakeActive = false;
      console.log("[RaSh Voice] onend");
      if (!wakeShouldRun || document.hidden) return; // paused (tab hidden) or turned off: do not restart
      if (wakeErrorStreak > 6) {
        wakeShouldRun = false;
        setWakeToggleUI(false);
        setStatus("'Hey RaSh' listening stopped after repeated errors.");
        return;
      }
      clearTimeout(wakeRestartTimer);
      wakeRestartTimer = setTimeout(startWakeRecognizer, wakeErrorStreak > 0 ? 1200 : 250);
    };
  }

  function startWakeRecognizer() {
    if (!wakeShouldRun || wakeActive || document.hidden) return;
    ensureWakeRecognizer();
    if (!wakeRecognizer) return;
    try {
      wakeRecognizer.start();
      wakeActive = true;
      wakeHandledIndices = new Set(); // a fresh listening session: forget which utterances were already handled
      console.log("[RaSh Voice] SpeechRecognition.start() called successfully");
    } catch (e) {
      console.log("[RaSh Voice] SpeechRecognition.start() threw:", e && e.message);
      // start() throws if called while already starting; the existing onend/onerror cycle will retry
    }
  }

  function stopWakeRecognizer() {
    wakeShouldRun = false;
    clearTimeout(wakeRestartTimer);
    if (wakeRecognizer && wakeActive) {
      try { wakeRecognizer.stop(); } catch (e) {}
    }
  }

  function beginWakeListening() {
    wakeShouldRun = true;
    wakeErrorStreak = 0;
    if (!document.hidden) startWakeRecognizer();
  }

  // Pause while the tab is hidden (no point listening on a tab you're not looking at), resume when visible
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (wakeActive && wakeRecognizer) { try { wakeRecognizer.stop(); } catch (e) {} }
    } else if (wakeShouldRun) {
      startWakeRecognizer();
    }
  });

  let wakeNoticeEl = null;
  function closeWakeNotice() {
    if (wakeNoticeEl) { wakeNoticeEl.remove(); wakeNoticeEl = null; }
  }

  // Shown once, ever, before the microphone is used for this feature for the first time
  function showWakeNotice() {
    closeWakeNotice();
    wakeNoticeEl = el("div", "consent");
    wakeNoticeEl.setAttribute("role", "dialog");
    wakeNoticeEl.setAttribute("aria-label", "Turn on 'Hey RaSh' listening");
    wakeNoticeEl.appendChild(el("div", "ctext", "Turning this on lets RaSh listen for “Hey RaSh, turn on/off.”"));
    wakeNoticeEl.appendChild(el("div", "fpath", "Chrome sends what it hears to Google to convert it to text, so this isn't fully local. Continue?"));
    const row = el("div", "crow");
    row.style.marginTop = "12px";
    const yes = el("button", "btn", "Continue");
    const no = el("button", "btn ghost", "Cancel");
    yes.addEventListener("click", () => {
      closeWakeNotice();
      try { chrome.storage.local.set({ [WAKE_NOTICE_KEY]: true, [WAKE_ENABLED_KEY]: true }); } catch (e) {}
      setWakeToggleUI(true);
      beginWakeListening();
    });
    no.addEventListener("click", closeWakeNotice);
    row.appendChild(yes);
    row.appendChild(no);
    wakeNoticeEl.appendChild(row);
    shadow.appendChild(wakeNoticeEl);
  }

  if (!SpeechRecognitionCtor) {
    wakeRow.style.display = "none"; // browser doesn't support speech recognition
  } else {
    wakeToggleBtn.addEventListener("click", () => {
      if (wakeEnabled) {
        setWakeToggleUI(false);
        stopWakeRecognizer();
        try { chrome.storage.local.set({ [WAKE_ENABLED_KEY]: false }); } catch (e) {}
        return;
      }
      try {
        chrome.storage.local.get(WAKE_NOTICE_KEY, (r) => {
          const seen = !chrome.runtime.lastError && r && r[WAKE_NOTICE_KEY] === true;
          if (!seen) { showWakeNotice(); return; }
          setWakeToggleUI(true);
          beginWakeListening();
          try { chrome.storage.local.set({ [WAKE_ENABLED_KEY]: true }); } catch (e) {}
        });
      } catch (e) {
        showWakeNotice();
      }
    });

    // Restore state on load, and follow it if it's changed from another tab
    try {
      chrome.storage.local.get(WAKE_ENABLED_KEY, (r) => {
        if (!chrome.runtime.lastError && r && r[WAKE_ENABLED_KEY] === true) {
          setWakeToggleUI(true);
          beginWakeListening(); // permission was already granted on an earlier use; this should not re-prompt
        }
      });
    } catch (e) {}
  }

  // ---------- Conversation rendering ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function scrollToEnd() {
    answerEl.scrollTop = answerEl.scrollHeight;
  }

  // ---------- Shared conversation ----------
  // The conversation lives in chrome.storage.local (key rashChatHistory), so every tab shows the same
  // messages. Tabs read it on load and re-render whenever it changes. Writes go through background.js.
  let history = [];
  let renderedIds = [];
  let busy = false;       // this tab is waiting for an answer (local only)
  let thinkingEl = null;  // "..." dots, local only

  // Streaming: a request id guards against a token from an old/aborted question landing after a
  // new one has started. The live bubble is local-only, exactly like the thinking dots it
  // replaces - the real answer is still only ever persisted once the full response arrives.
  let streamRequestSeq = 0;
  let activeStreamRequestId = null;
  let streamingEl = null;
  let streamingTextEl = null;

  function removeThinking() {
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  }

  function appendStreamingToken(text) {
    if (!streamingEl) {
      removeThinking();
      streamingEl = el("div", "card");
      streamingTextEl = el("div", "body", "");
      streamingEl.appendChild(streamingTextEl);
      answerEl.appendChild(streamingEl);
    }
    streamingTextEl.textContent += text;
    scrollToEnd();
  }

  function removeStreamingAnswer() {
    if (streamingEl) { streamingEl.remove(); streamingEl = null; streamingTextEl = null; }
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === "RASH_STREAM_TOKEN" && message.requestId === activeStreamRequestId) {
        appendStreamingToken(message.text || "");
      }
    });
  } catch (e) {}

  // Last 4 real turns (user question / assistant answer), for the server to resolve short
  // follow-ups like "and before that?" - file cards and notes aren't part of the conversation text.
  function recentHistoryForServer() {
    return history
      .map((m) => {
        if (m.role === "user") return { role: "user", text: m.text || "" };
        if (m.role === "answer") return { role: "assistant", text: m.answer || "" };
        return null;
      })
      .filter(Boolean)
      .slice(-4);
  }

  function showThinking() {
    removeThinking();
    thinkingEl = el("div", "thinking");
    thinkingEl.appendChild(el("i"));
    thinkingEl.appendChild(el("i"));
    thinkingEl.appendChild(el("i"));
    answerEl.appendChild(thinkingEl);
    scrollToEnd();
  }

  function messageNode(m) {
    if (m.role === "user") return el("div", "me", m.text || "");
    if (m.role === "files") return fileCard(m.items || []);
    if (m.role === "answer") return answerCard(m);
    if (m.role === "note" && m.text === NOT_FOUND_TEXT) return notFoundCard(m.text);
    return el("div", "card " + (m.kind === "error" ? "error" : "muted"), m.text || "");
  }

  function renderHistory(list) {
    history = Array.isArray(list) ? list : [];
    const ids = history.map((m) => m.id);
    // Only append new messages when the old ones are unchanged; otherwise redraw everything
    const unchanged = renderedIds.length <= ids.length && renderedIds.every((id, i) => id === ids[i]);
    removeThinking();
    if (!unchanged || history.length === 0) {
      answerEl.textContent = "";
      renderedIds = [];
    }
    if (history.length === 0) {
      showEmptyState();
    } else {
      const empty = answerEl.querySelector(".empty");
      if (empty) empty.remove();
      history.slice(renderedIds.length).forEach((m) => {
        answerEl.appendChild(messageNode(m));
        renderedIds.push(m.id);
      });
    }
    if (busy) showThinking();
    clearBtn.hidden = history.length === 0;
    scrollToEnd();
  }

  function loadHistory() {
    try {
      chrome.storage.local.get(CHAT_KEY, (r) => {
        if (chrome.runtime.lastError) { renderHistory([]); return; }
        renderHistory(r && r[CHAT_KEY]);
      });
    } catch (e) {
      renderHistory([]); // extension was reloaded; refresh the page
    }
  }

  function addToHistory(items, done) {
    safeSend({ type: "RASH_CHAT_APPEND", items: items }, (ack) => {
      if (!ack || !ack.ok) {
        // Could not save (for example the extension was reloaded): still show it in this tab
        const empty = answerEl.querySelector(".empty");
        if (empty) empty.remove();
        items.forEach((m) => answerEl.appendChild(messageNode(m)));
        scrollToEnd();
      }
      if (done) done();
    });
  }

  // "Clear history" asks twice (second click within 3s) so it cannot be triggered by accident
  let clearTimer = null;
  function resetClearBtn() {
    clearTimeout(clearTimer);
    clearBtn.classList.remove("confirm");
    clearBtn.setAttribute("aria-label", "Clear history");
    clearBtn.innerHTML = icon("trash", 15);
  }
  clearBtn.addEventListener("click", () => {
    if (!clearBtn.classList.contains("confirm")) {
      clearBtn.classList.add("confirm");
      clearBtn.setAttribute("aria-label", "Confirm clear history");
      clearBtn.textContent = "Clear all?";
      clearTimer = setTimeout(resetClearBtn, 3000);
      return;
    }
    resetClearBtn();
    pendingAttachment = null; // clearing the conversation also drops the attached file and its text
    updateAttachChip();
    safeSend({ type: "RASH_CHAT_CLEAR" });
  });

  const SUGGESTIONS = [
    "What was the last article I read?",
    "Find my resume file",
    "Summarize my last page"
  ];

  function showEmptyState() {
    const box = el("div", "empty");
    box.appendChild(el("div", "big", "What do you want to remember?"));
    box.appendChild(el("div", "", "Ask about pages you've read or files on this laptop."));
    const chips = el("div", "chips");
    SUGGESTIONS.forEach((s) => {
      const c = el("button", "chip", s);
      c.addEventListener("click", () => { input.value = s; submitQuestion(); });
      chips.appendChild(c);
    });
    box.appendChild(chips);
    answerEl.appendChild(box);
  }

  function lastFolderName(folderPath) {
    const parts = String(folderPath || "").split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  function fileIcon(name) {
    const ext = (String(name).split(".").pop() || "").toLowerCase();
    if (["pdf", "doc", "docx", "txt", "md", "rtf"].includes(ext)) return icon("doc", 18);
    if (["xls", "xlsx", "csv"].includes(ext)) return icon("sheet", 18);
    if (["ppt", "pptx"].includes(ext)) return icon("slides", 18);
    if (["png", "jpg", "jpeg", "gif", "webp", "heic"].includes(ext)) return icon("image", 18);
    if (["zip", "rar", "7z"].includes(ext)) return icon("archive", 18);
    return icon("file", 18);
  }

  function timeAgo(sqlDate) {
    if (!sqlDate) return "";
    const t = Date.parse(String(sqlDate).replace(" ", "T") + "Z"); // SQLite stores UTC
    if (isNaN(t)) return "";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }

  function safeHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
  }

  function doOpen(filePath, reveal, btn, label) {
    btn.textContent = "Opening...";
    safeSend({ type: "RASH_OPEN", path: filePath, reveal: reveal }, (res) => {
      if (res && res.ok) {
        btn.textContent = reveal ? "Shown" : "Opened";
      } else {
        btn.textContent = "Failed";
        const msg = res && res.data && res.data.error ? res.data.error : "Could not open the file. Is the RaSh server running?";
        addToHistory([{ role: "note", kind: "error", text: msg }]);
      }
      setTimeout(() => { btn.textContent = label; }, 2500);
    });
  }

  function fileCard(items) {
    const card = el("div", "card");
    card.appendChild(el("div", "label", items.length > 1 ? "Found these files" : "Found your file"));
    items.forEach((f) => {
      const box = el("div", "file");

      const top = el("div", "frow1");
      const ficon = el("div", "ficon");
      ficon.innerHTML = fileIcon(f.name); // fixed inline SVG from our own icon table, no page or file text
      top.appendChild(ficon);
      const info = el("div", "");
      info.appendChild(el("div", "fname", f.name));
      info.appendChild(el("div", "fpath", "in " + lastFolderName(f.folder)));
      top.appendChild(info);

      const row = el("div", "frow");
      const openBtn = el("button", "btn", "Open");
      openBtn.addEventListener("click", () => doOpen(f.path, false, openBtn, "Open"));
      const showBtn = el("button", "btn ghost", "Show in folder");
      showBtn.addEventListener("click", () => doOpen(f.path, true, showBtn, "Show in folder"));
      row.appendChild(openBtn);
      row.appendChild(showBtn);

      box.appendChild(top);
      box.appendChild(row);
      card.appendChild(box);
    });
    return card;
  }

  // ---------- Sources under an answer ----------
  // Everything here comes from saved web pages, so it is untrusted: built with createElement and
  // textContent only, never innerHTML (the only innerHTML is our own fixed icon SVG).
  const NOT_FOUND_TEXT = "I couldn't find that in your memory.";
  const AI_DOWN_TEXT = "RaSh's AI engine isn't responding right now. Here are the closest matches.";
  const snippetById = new Map(); // record id -> snippet, this tab only: saved page text never goes into history

  // "today at 2:21 PM" -> "today 2:21 PM", "yesterday evening (6:40 PM)" -> "yesterday 6:40 PM",
  // "Thursday 24 Sep at night (10:05 PM)" -> "Thu 24 Sep 10:05 PM"
  function compactWhen(when) {
    const w = String(when || "");
    const clock = (w.match(/\d{1,2}:\d{2}\s?[AP]M/i) || [""])[0];
    if (/^today/i.test(w)) return ("today " + clock).trim();
    if (/^(yesterday|last night)/i.test(w)) return ("yesterday " + clock).trim();
    const m = w.match(/^(?:on\s+)?([A-Z][a-z]{2})[a-z]*\s+(\d{1,2}\s+[A-Z][a-z]{2}(?:\s+\d{4})?)/);
    if (m) return (m[1] + " " + m[2] + (clock ? " " + clock : "")).trim();
    return w;
  }

  // "en.wikipedia.org" -> "wikipedia.org", "www.youtube.com" -> "youtube.com"
  function shortSite(site) {
    const s = String(site || "");
    if (!/\./.test(s)) return s; // "Gmail", "Saved file"
    const parts = s.replace(/^www\./i, "").split(".");
    if (parts.length >= 3 && /^([a-z]{2}|m|mobile)$/i.test(parts[0])) parts.shift();
    return parts.join(".");
  }

  function isWebUrl(u) {
    if (!/^https?:\/\//i.test(String(u || ""))) return false;
    try { const p = new URL(u); return p.protocol === "http:" || p.protocol === "https:"; } catch (e) { return false; }
  }

  function sourceAvatar(src) {
    const av = el("span", "av");
    if (src.site === "Saved file") av.innerHTML = icon("doc", 13); // fixed inline SVG
    else if (src.site === "Gmail") av.innerHTML = icon("mail", 13); // fixed inline SVG
    else av.textContent = (shortSite(src.site).replace(/[^a-z0-9]/gi, "").charAt(0) || "•").toUpperCase();
    return av;
  }

  function openSourceFile(filePath, chip) {
    chip.classList.add("flash");
    safeSend({ type: "RASH_OPEN", path: filePath, reveal: false }, (res) => {
      setTimeout(() => chip.classList.remove("flash"), 600);
      if (!res || !res.ok) {
        const msg = res && res.data && res.data.error ? res.data.error : "Could not open the file. Is the RaSh server running?";
        addToHistory([{ role: "note", kind: "error", text: msg }]);
      }
    });
  }

  // One chip per source: web pages open in a new tab (http/https only), saved files through the
  // usual open-file flow, anything else (an email) is shown but not clickable.
  function sourceChip(src) {
    let chip;
    if (isWebUrl(src.urlOrPath)) {
      chip = el("a", "src");
      chip.href = src.urlOrPath;
      chip.target = "_blank";
      chip.rel = "noopener noreferrer";
    } else if (src.site === "Saved file" && src.urlOrPath) {
      chip = el("button", "src");
      chip.type = "button";
      chip.addEventListener("click", () => openSourceFile(src.urlOrPath, chip));
    } else {
      chip = el("div", "src static");
    }
    const meta = [shortSite(src.site), compactWhen(src.when)].filter(Boolean).join(" · ");
    chip.appendChild(el("span", "n", String(src.n)));
    chip.appendChild(sourceAvatar(src));
    const txt = el("span", "txt");
    txt.appendChild(el("span", "st", src.title || "Saved memory"));
    if (meta) txt.appendChild(el("span", "sm", meta));
    chip.appendChild(txt);
    chip.title = snippetById.get(src.id) || [src.title, meta].filter(Boolean).join("\n");
    return chip;
  }

  function sourcesBlock(sources) {
    const block = el("div", "srcs");
    const byN = new Map();
    sources.forEach((src) => {
      const chip = sourceChip(src);
      byN.set(src.n, chip);
      block.appendChild(chip);
    });
    return { block, byN };
  }

  // The answer text, with each [n] that matches a source turned into a small badge that points at
  // its chip. Plain text nodes only.
  function answerBody(text, byN) {
    const body = el("div", "body");
    const s = String(text || "");
    const re = /\[(\d{1,2})\]/g;
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      const chip = byN && byN.get(Number(m[1]));
      if (!chip) continue;
      if (m.index > last) body.appendChild(document.createTextNode(s.slice(last, m.index)));
      const badge = el("button", "cite", m[1]);
      badge.type = "button";
      badge.setAttribute("aria-label", "Source " + m[1]);
      badge.addEventListener("click", () => {
        chip.scrollIntoView({ block: "nearest", behavior: "smooth" });
        chip.classList.add("flash");
        setTimeout(() => chip.classList.remove("flash"), 1200);
      });
      body.appendChild(badge);
      last = m.index + m[0].length;
    }
    if (last < s.length) body.appendChild(document.createTextNode(s.slice(last)));
    return body;
  }

  // Not found: calm, with a small tip. The sentence itself is exactly what the server sent.
  function notFoundCard(text) {
    const card = el("div", "card calm");
    card.appendChild(el("div", "body", text));
    card.appendChild(el("div", "tip", "Tip: RaSh only remembers pages saved while it's ON."));
    return card;
  }

  function answerCard(d) {
    const card = el("div", "card");
    const sources = Array.isArray(d.sources) ? d.sources : [];
    if (sources.length) {
      // Smart Recall answer: the text with [n] badges, then its sources as chips
      const { block, byN } = sourcesBlock(sources);
      if (d.answer === AI_DOWN_TEXT) card.classList.add("calm");
      card.appendChild(answerBody(d.answer, byN));
      card.appendChild(block);
    } else if (d.source_label) {
      // New style: one short answer, then a small line saying where it came from
      card.appendChild(el("div", "body", d.answer || "I could not find that."));
      const from = el("div", "fpath", d.source_label);
      from.style.marginTop = "8px";
      card.appendChild(from);
    } else {
      card.appendChild(el("div", "label", d.kind === "recent" ? "Last page you read" : "From your memory"));
      if (d.title) card.appendChild(el("div", "ctitle", d.title));
      card.appendChild(el("div", "body", d.answer || "No answer."));
    }

    const meta = el("div", "meta");
    if (!sources.length && d.source_url && /^https?:\/\//i.test(d.source_url)) { // chips already link it
      const a = el("a", "source");
      a.innerHTML = icon("external", 12); // fixed inline SVG
      a.appendChild(document.createTextNode(safeHost(d.source_url) || "Open page"));
      a.href = d.source_url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      meta.appendChild(a);
    }
    const ago = d.source_label || sources.length ? "" : timeAgo(d.last_updated); // the source line/chips already name the saved date
    if (ago) meta.appendChild(el("span", "", "Saved " + ago));
    if (meta.childNodes.length) card.appendChild(meta);

    // Unclear question answered from the page: let the user try their saved memory instead
    if (d.offer_memory && d.question) {
      const more = el("button", "btn ghost", "Search my memory instead?");
      more.style.marginTop = "10px";
      more.addEventListener("click", () => {
        if (busy) return;
        more.disabled = true;
        busy = true;
        showThinking();
        safeSend({ type: "RASH_QUERY", question: d.question, mode: "memory-only", history: recentHistoryForServer() }, (res) => {
          busy = false;
          removeThinking();
          addToHistory(resultToItems(res));
        });
      });
      card.appendChild(more);
    }
    return card;
  }

  // Turn the server's reply into the small records kept in the shared history
  // (a file result keeps only name, folder and path; nothing from saved pages is copied)
  function resultToItems(res, opts) {
    if (!res || !res.ok) {
      return [{ role: "note", kind: "error", text: "Can't reach the RaSh server. Start it (node server.js) and try again." }];
    }
    if (res.kind === "file") {
      const files = ((res.data && res.data.results) || []).slice(0, 3)
        .map((f) => ({ name: f.name, folder: f.folder, path: f.path }));
      return [{ role: "files", items: files }];
    }
    const d = res.data || {};
    if (d.found) {
      const sources = Array.isArray(d.sources) ? d.sources : [];
      // Snippets are page text: kept in this tab for the hover only, never saved into the history.
      sources.forEach((s) => { if (s && s.id && s.snippet) snippetById.set(s.id, String(s.snippet)); });
      return [{
        role: "answer", kind: d.kind === "recent" ? "recent" : "answer",
        title: d.title || "", answer: d.answer || "", source_url: d.source_url || "", last_updated: d.last_updated || "",
        source_label: d.source_label || "",
        sources: sources.map((s) => ({ n: s.n, id: s.id, title: s.title, urlOrPath: s.urlOrPath, site: s.site, category: s.category, when: s.when })),
        offer_memory: !!(opts && opts.offer), question: opts && opts.offer ? opts.question : ""
      }];
    }
    if (d.error) return [{ role: "note", kind: "error", text: d.error }];
    return [{ role: "note", kind: "muted", text: d.message || "I could not find that." }];
  }

  // ---------- Instant time/date/day: answered from the browser clock, before any routing
  // decision or server call. This is what stops "time?" from ever reaching page mode: without
  // this check, a question with no recall-words and no page-words match falls through to
  // classifyQuestion's "unclear" branch, which runQuery treats the same as "page" - it reads the
  // page and sends mode:"page" to the server, where the server's own instant-answer check used to
  // be skipped for page mode. Typo-tolerant via a small fixed alias list plus a length-gated
  // Levenshtein fallback (only for words of 4+ letters, matched only against 4+ letter keywords),
  // so short unrelated words like "page" or "may" can't get misread as "date"/"day".
  const RASH_TIMEZONE = "Asia/Kolkata";
  const INSTANT_KEY_TOKENS = ["time", "current", "date", "today", "day"];
  const INSTANT_ALIASES = {
    tym: "time", tim: "time", tme: "time",
    curent: "current", curnt: "current", currnt: "current",
    dat: "date", dte: "date",
    tdy: "today",
    rn: "now", wat: "what", wats: "whats",
  };

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const row = new Array(n + 1);
    for (let j = 0; j <= n; j++) row[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = row[j];
        row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
        prev = tmp;
      }
    }
    return row[n];
  }

  // Corrects only the handful of words this router cares about; a typo anywhere else in the
  // question is left completely alone, so this never changes the meaning of a real question.
  function correctInstantWords(question) {
    return String(question || "").toLowerCase().split(/\s+/).map((raw) => {
      const w = raw.replace(/[^a-z']/g, "");
      if (!w) return raw;
      if (INSTANT_ALIASES[w]) return INSTANT_ALIASES[w];
      if (INSTANT_KEY_TOKENS.includes(w)) return raw;
      if (w.length < 4) return raw; // too short to fuzzy-match safely ("day"/"may"/"way" collisions)
      let best = null, bestDist = Infinity;
      for (const key of INSTANT_KEY_TOKENS) {
        if (key.length < 4) continue; // "day" only ever matches via an alias or its exact spelling
        const d = levenshtein(w, key);
        if (d < bestDist) { bestDist = d; best = key; }
      }
      return best && bestDist <= 1 ? best : raw;
    }).join(" ");
  }

  const INSTANT_TIME_RE = /^\s*(?:wh?at'?s?\s+)?(?:the\s+)?(?:current\s+)?time(?:\s+is\s+it)?(?:\s+now)?(?:\s+in\s+[a-z]+)?\s*\??\s*$/i;
  const INSTANT_DATE_RE = /^\s*(?:wh?at\s+is\s+|wh?at'?s?\s+)?(?:today'?s?\s+|the\s+)?date\s*\??\s*$/i;
  const INSTANT_DAY_RE = /^\s*(?:wh?at\s+)?day\s+is\s+it\s*\??\s*$|^\s*wh?at\s+day\s*(?:is\s+(?:it|today))?\s*\??\s*$|^\s*day\s+today\s*\??\s*$/i;

  // Pure routing decision: "time" | "date" | "day" | null. No DOM, no server, unit-testable as-is.
  function classifyInstantIntent(rawQuestion) {
    const q = String(rawQuestion || "").trim();
    if (!q) return null;
    const corrected = correctInstantWords(q);
    if (INSTANT_TIME_RE.test(corrected)) return "time";
    if (INSTANT_DAY_RE.test(corrected)) return "day";
    if (INSTANT_DATE_RE.test(corrected)) return "date";
    return null;
  }

  // A few warm phrasings, rotating; each states exactly the same time or date.
  const INSTANT_WORDINGS = {
    time: [(v) => "It's " + v + " (IST).", (v) => "Right now it's " + v + " (IST).", (v) => v + " (IST), on the dot-ish.", (v) => "The clock says " + v + " (IST)."],
    day: [(v) => "Today is " + v + ".", (v) => "It's " + v + " today.", (v) => v + ", all day today."],
    date: [(v) => "Today is " + v + ".", (v) => "It's " + v + ".", (v) => "Today's date: " + v + "."],
  };
  const instantTurn = { time: 0, day: 0, date: 0 };

  function instantClockAnswer(kind) {
    const now = new Date();
    const fmt = (opts) => new Intl.DateTimeFormat("en-US", { timeZone: RASH_TIMEZONE, ...opts }).format(now);
    const value = kind === "time" ? fmt({ hour: "numeric", minute: "2-digit", hour12: true })
      : kind === "day" ? fmt({ weekday: "long" })
      : fmt({ weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const list = INSTANT_WORDINGS[kind] || INSTANT_WORDINGS.date;
    return list[instantTurn[kind in instantTurn ? kind : "date"]++ % list.length](value);
  }

  // ---------- Where should a question be answered from? ----------
  // recall words -> saved memory; page words -> this page only; otherwise this page plus a "search memory" button
  const RECALL_WORDS = /\b(what|which|where)\s+(did|was|have|were)\s+i\s+(read|visit|visited|see|saw|open|opened|browse|browsed|watch|watched|look|looked|save|saved)|\bdid\s+i\s+(read|save|visit|see|open|watch)\b|\b(yesterday|today|tonight|last night|last week|last month|this week|this morning|this afternoon|this evening|earlier|days? ago|weeks? ago|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(last|latest|most recent|previous)\s+(article|page|site|website|tab|thing|post|blog|video)\b|\bthe\s+(page|article|site|post|video)\s+(about|on|called|named)\b|\bmy\s+(memory|memories)\b|\b(kal|parso|pichle|pichhle|padha|padhi|padhe|dekha|dekhi)\b/i;
  const PAGE_WORDS = /\b(he|him|his|she|her|hers|this|that|it|its|here|these|those|they|them|their|person|screen|page|article)\b|\b(summari[sz]e|summary|written|explain|tl;?dr)\b|\b(yeh|ye|yahi|isse|iske|iska|iski|isme|yahan|kaun|kya|batao|bataiye)\b/i;

  function isFileRequest(q) {
    return /\b(file|files|document|documents|pdf|docx?|pptx?|xlsx?|resume|photo|picture|image|assignment)\b/i.test(q) &&
      /\b(find|where|locate|open|give me|show me|send me)\b/i.test(q);
  }

  function classifyQuestion(q) {
    if (RECALL_WORDS.test(q) || isFileRequest(q)) return "memory"; // saved memory (and the file finder), as before
    return PAGE_WORDS.test(q) ? "page" : "unclear";
  }

  // "What's on this page" vs "where did he study": both route to mode "page", but a whole-page
  // summary needs different extraction (first ~3,000 words in reading order, not the passages
  // that happen to match the question's own keywords) and a different prompt.
  const SUMMARY_INTENT = /\bsummar(y|ize|ise)\b|\btl;?dr\b|\bwhat'?s\s+(this|on\s+(my\s+)?screen)\b|\bwhats\s+(this|on\s+(my\s+)?screen)\b|\b(this|current)\s+(page|article|site|tab)\b|\bwhat\s+is\s+this\b|^\s*page\??\s*$/i;
  function isSummaryRequest(q) {
    return SUMMARY_INTENT.test(String(q || "").trim());
  }

  // ---------- Reading the current page as plain text (used only to answer; never saved) ----------
  const PAGE_NOISE = 'nav, header, footer, aside, form, script, style, noscript, iframe, button, select, ' +
    '[role="navigation"], [role="banner"], [role="complementary"], [role="search"], [aria-hidden="true"], ' +
    '[aria-label*="advert" i], [id*="cookie" i], [class*="cookie" i], [class*="advert" i], [class*="sidebar" i], ' +
    '[class*="navbox" i], [class*="reflist" i], [class*="mw-editsection"], [class*="menu" i], .ad, .ads, #ad';
  const PAGE_BLOCKS = "h1,h2,h3,h4,p,li,td,th,blockquote,figcaption,dd,dt,pre";
  const FOOTNOTES = /\[\[[^\]]{1,20}\]\]|\[\d{1,3}\]|\[[a-z]\]|\[(?:citation needed|edit|note \d+|clarification needed|when\?|who\?|dubious[^\]]*)\]/gi;
  const PAGE_MAX_CHARS = 8000;
  const PAGE_SUMMARY_MAX_CHARS = 18000; // a whole-page summary needs far more room than one targeted fact does - stays under the server's 20,000-char limit
  const SUMMARY_WORD_LIMIT = 3000;

  const INFOBOX = 'table[class*="infobox"], .infobox, .vcard, [class*="infobox"], [class*="quick-facts"], [class*="key-facts"], [class*="factbox"], [class*="fact-box"]';

  // Words that mean the same thing when looking for the right passage ("education" also finds "attended college")
  const SYNONYM_GROUPS = [
    ["education", "educated", "school", "college", "university", "study", "studied", "degree", "graduate", "graduated", "attended", "attend", "dropped out", "alumnus", "padhai", "shiksha"],
    ["born", "birth", "birthday", "birthplace", "age", "old", "umar", "janm"],
    ["spouse", "married", "marry", "marriage", "wife", "husband", "shaadi", "biwi", "patni"],
    ["job", "work", "works", "worked", "occupation", "profession", "career", "ceo", "founder", "chairman", "employer", "kaam", "naukri"],
    ["launch", "launched", "found", "founded", "founder", "established", "created", "started", "co-founder"],
    ["net worth", "worth", "wealth", "billion", "billionaire", "salary", "income"],
    ["children", "child", "kids", "daughter", "daughters", "son", "sons"],
    ["resides", "residence", "lives", "live", "home", "based", "residing"],
    ["height", "tall"],
    ["award", "awards", "prize", "honors", "honours"],
    ["died", "death", "dead", "passed away"],
    ["parents", "parent", "mother", "father"],
    ["nationality", "citizenship", "citizen", "country"]
  ];
  const SCORE_SKIP = new Set(["what", "when", "where", "which", "who", "whom", "does", "did", "this", "that", "with", "about", "tell",
    "his", "her", "him", "she", "the", "and", "was", "are", "you", "for", "how", "why", "can", "could", "has", "have", "from", "they",
    "them", "their", "there", "these", "those", "person", "screen", "page", "article", "explain", "summarize", "summary", "written",
    "please", "yeh", "isse", "iske", "iska", "iski", "isme", "kaun", "kya", "batao", "bataiye", "hai", "hain"]);

  function cleanPageText(t) {
    return String(t || "")
      .replace(/https?:\/\/\S+|www\.\S+/gi, "")
      .replace(FOOTNOTES, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  function blockText(n) {
    return (n.innerText || "").replace(/\s+/g, " ").trim();
  }

  function insideNoise(n, root) {
    const noise = n.closest(PAGE_NOISE);
    return !!(noise && noise !== root && root.contains(noise));
  }

  // Info box / key-facts tables, one "Label: value" line per row
  function keyFacts(root) {
    const lines = [];
    root.querySelectorAll(INFOBOX).forEach((box) => {
      if (box.parentElement && box.parentElement.closest(INFOBOX)) return; // outermost box only
      const rows = box.querySelectorAll("tr");
      if (rows.length === 0) { lines.push(blockText(box).slice(0, 1500)); return; }
      rows.forEach((tr) => {
        const th = tr.querySelector("th");
        const td = tr.querySelector("td");
        const a = th ? blockText(th) : "";
        const b = td ? blockText(td).slice(0, 300) : "";
        if (a && b) lines.push(a + ": " + b);
        else if (a || b) lines.push(a || b);
      });
    });
    return lines.slice(0, 60).join("\n");
  }

  // The first three real paragraphs
  function introParagraphs(root) {
    const out = [];
    for (const p of root.querySelectorAll("p")) {
      if (insideNoise(p, root) || p.closest(INFOBOX)) continue;
      const t = cleanPageText(blockText(p));
      if (t.length >= 60) out.push(t);
      if (out.length === 3) break;
    }
    return out;
  }

  // The question's words (weight 2) plus their synonyms (weight 1), as whole-word patterns
  function expandQuestion(question) {
    const words = question.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length >= 3 && !SCORE_SKIP.has(w));
    const weights = new Map();
    words.forEach((w) => {
      const n = w.replace(/(ing|ed|es|s)$/, "");
      if (n.length >= 3) weights.set(n, 2);
      SYNONYM_GROUPS.forEach((group) => {
        if (group.some((t) => t === w || t === n || (n.length >= 4 && t.startsWith(n)))) {
          group.forEach((t) => { if (!weights.has(t)) weights.set(t, 1); });
        }
      });
    });
    return [...weights].map(([term, weight]) => ({
      re: new RegExp("\\b" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (term.length <= 4 ? "\\b" : ""), "i"),
      weight: weight
    }));
  }

  // Fill the space that is left with the lines that best match the question
  function pickPassages(lines, question, budget) {
    if (budget <= 0 || lines.length === 0) return "";
    const total = lines.reduce((n, l) => n + l.length + 1, 0);
    if (total <= budget) return lines.join("\n");
    const terms = expandQuestion(question);
    const scored = lines.map((line, i) => ({ i, line, s: terms.reduce((n, t) => n + (t.re.test(line) ? t.weight : 0), 0) }));
    let order = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i);
    if (order.length === 0) order = scored; // nothing matched: the start of the page
    const keep = [];
    let size = 0;
    for (const x of order) {
      if (size + x.line.length + 1 > budget) {
        if (keep.length === 0) keep.push({ i: x.i, line: x.line.slice(0, budget - 1) }); // one very long paragraph
        continue;
      }
      keep.push(x);
      size += x.line.length + 1;
    }
    return keep.sort((a, b) => a.i - b.i).map((x) => x.line).join("\n");
  }

  // Headings in reading order (h1-h6), deduped - gives a summary prompt the page's own outline
  // even when the question has no keywords of its own to search for.
  function pageHeadings(root) {
    const seen = new Set();
    const out = [];
    root.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
      if (insideNoise(h, root)) return;
      const t = cleanPageText(blockText(h));
      if (t.length < 2 || t.length > 200 || seen.has(t)) return;
      seen.add(t);
      out.push(t);
    });
    return out.slice(0, 25).join("\n");
  }

  // The first N words of a block of text, in its original order - used for whole-page summaries,
  // where the goal is broad coverage rather than the passages that best match the question.
  function takeFirstWords(text, maxWords) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return words.join(" ");
    return words.slice(0, maxWords).join(" ");
  }

  // Title, key facts, first three paragraphs, then the best matching passages, within PAGE_MAX_CHARS
  function buildPageText(question, summaryMode) {
    const root = document.querySelector("article") || document.querySelector("main") || document.body;
    const headings = pageHeadings(root);
    const intro = introParagraphs(root);
    const introText = intro.join("\n").slice(0, 2500);
    const introSet = new Set(intro);

    let rest = [];
    root.querySelectorAll(PAGE_BLOCKS).forEach((n) => {
      if (n.querySelector(PAGE_BLOCKS)) return; // only the innermost blocks, so nothing is repeated
      if (insideNoise(n, root) || n.closest(INFOBOX)) return;
      const t = cleanPageText(blockText(n));
      if (t.length > 1 && !introSet.has(t)) rest.push(t);
    });
    if (rest.join("").length + introText.length < 200) { // pages built from plain divs
      rest = cleanPageText(root.innerText || "").split("\n").filter((l) => l.trim().length > 1);
    }

    let text = "Page title: " + (document.title || "") + "\n";
    if (headings) text += "Headings:\n" + headings + "\n";

    if (summaryMode) {
      // "What's this page about" needs broad, front-loaded coverage in reading order - not the
      // narrow, keyword-scored passages the fact-lookup path below uses.
      const bodyText = takeFirstWords([introText, rest.join("\n")].filter(Boolean).join("\n"), SUMMARY_WORD_LIMIT);
      if (!headings && !bodyText) return "";
      if (bodyText) text += "Main content:\n" + bodyText;
      return text.slice(0, PAGE_SUMMARY_MAX_CHARS).trim();
    }

    const facts = cleanPageText(keyFacts(root)).slice(0, 2500);
    if (facts) text += "Key facts:\n" + facts + "\n";
    if (introText) text += "Introduction:\n" + introText + "\n";
    const picked = pickPassages(rest, question, PAGE_MAX_CHARS - text.length - 20);
    if (!headings && !facts && !introText && !picked) return "";
    if (picked) text += "Other passages:\n" + picked;
    return text.slice(0, PAGE_MAX_CHARS).trim();
  }

  // Mail, banking, payment and login pages are never read
  function pageNotReadable() {
    return isPrivateHost(location.hostname) || isSensitivePage() ||
      /\b(checkout|payment|billing|netbanking|login|signin|sign-in)\b/i.test(location.pathname);
  }

  // ---------- Gmail (read-only, fetched live only when asked; never saved anywhere) ----------
  let gmailConnected = false;
  let gmailPollTimer = null;
  let gmailPollsLeft = 0;

  // Turns a refused or failed request into something that explains itself, rather than a silent no-op
  function gmailProblem(res) {
    if (!res) return "The RaSh extension could not send that request. Try reloading the page.";
    if (res.status === 403) {
      return "The RaSh server refused that request (403). It only accepts Gmail requests from this extension, on this computer.";
    }
    if (res.data && res.data.error) return res.data.error;
    if (res.status === 0) return "Can't reach the RaSh server. Start it (node server.js) and try again.";
    return "Gmail request failed (" + (res.status || "unknown") + ").";
  }

  // Status is only ever asked for when something actually needs it (the settings popover), because
  // /api/gmail/recent already reports connected: false when a question can't be answered.
  function fetchGmailStatus(done) {
    safeSend({ type: "RASH_GMAIL_STATUS" }, (res) => {
      gmailConnected = !!(res && res.ok && res.data && res.data.connected === true);
      done(res && res.ok ? res.data : null, res);
    });
  }

  function stopGmailPolling() {
    clearTimeout(gmailPollTimer);
    gmailPollsLeft = 0;
  }

  // Opens the Google sign-in tab, then waits for the server to report a token (about two minutes).
  // onConnected runs once it succeeds, which is how the question that triggered this gets re-asked.
  function startGmailConnect(onConnected, onProblem) {
    safeSend({ type: "RASH_GMAIL_CONNECT" }, (res) => {
      if (!res || !res.ok || !res.data || !res.data.url) {
        onProblem(gmailProblem(res));
        return;
      }
      setStatus("Finish signing in on the Google tab that just opened.");

      stopGmailPolling();
      gmailPollsLeft = 60;
      const tick = () => {
        if (gmailPollsLeft-- <= 0) {
          onProblem("Gmail sign-in wasn't completed. Ask again to retry.");
          return;
        }
        fetchGmailStatus((status) => {
          if (status && status.connected === true) {
            stopGmailPolling();
            showToast("Gmail connected.");
            onConnected();
            return;
          }
          gmailPollTimer = setTimeout(tick, 2000);
        });
      };
      gmailPollTimer = setTimeout(tick, 2000);
    });
  }

  // "any new emails", "show me my last 3 emails". A mail word alone isn't enough - "what did I read
  // about email marketing" is an ordinary memory question - so a possessive or recency word is also
  // required. This runs before the usual routing, otherwise an old saved Gmail *page* in memory
  // could answer instead of the live inbox.
  const MAIL_NOUNS = /\b(email|emails|e-mail|e-mails|gmail|inbox|mail)\b/i;
  const MAIL_SIGNALS = /\b(my|new|recent|recently|latest|last|any|unread|check)\b/i;

  function isGmailQuestion(q) {
    return MAIL_NOUNS.test(q) && MAIL_SIGNALS.test(q);
  }

  // Explicit number wins; otherwise a plural asks for 3 and a singular for 1. The server caps at 3.
  function askedEmailCount(q) {
    const m = q.match(/\b(\d{1,2}|one|two|three)\s+(?:most\s+recent\s+|recent\s+|latest\s+|last\s+|new\s+|unread\s+)?(?:e-?mails?|messages?)\b/i);
    if (m) {
      const words = { one: 1, two: 2, three: 3 };
      const n = words[m[1].toLowerCase()] || parseInt(m[1], 10);
      return Math.min(Math.max(Number.isFinite(n) ? n : 1, 1), 3);
    }
    return /\b(e-?mails|messages)\b/i.test(q) ? 3 : 1;
  }

  // Email content is deliberately NOT put through addToHistory: that is saved to chrome.storage.
  // The card below lives in this tab's DOM only, and is gone on reload.
  function emailCard(emails) {
    const card = el("div", "card");
    card.appendChild(el("div", "label", emails.length === 1 ? "Your most recent email" : "Your " + emails.length + " most recent emails"));
    emails.forEach((mail) => {
      const box = el("div", "file");
      box.appendChild(el("div", "fname", (mail.from || "Unknown sender") + " - " + (mail.subject || "(no subject)")));
      if (mail.when) box.appendChild(el("div", "fpath", mail.when));
      if (mail.preview) box.appendChild(el("div", "body", mail.preview));
      card.appendChild(box);
    });
    const note = el("div", "fpath", "Shown live from Gmail. Not saved anywhere.");
    note.style.marginTop = "10px";
    card.appendChild(note);
    return card;
  }

  // Draws straight into the chat area, bypassing the saved history
  function showSessionOnly(node) {
    const empty = answerEl.querySelector(".empty");
    if (empty) empty.remove();
    answerEl.appendChild(node);
    scrollToEnd();
  }

  // Shown in the chat itself when Gmail isn't connected, instead of a row that sits there all the time.
  // Connecting from here re-runs the question that prompted it, so the user doesn't have to retype it.
  function connectPromptCard(reason, retryQuestion) {
    const card = el("div", "card");
    const text = el("div", "body", reason);
    card.appendChild(text);
    const btn = el("button", "btn", "Connect Gmail");
    btn.style.marginTop = "10px";
    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "Waiting for Google...";
      startGmailConnect(
        () => {
          card.remove(); // the question is about to be answered properly, so drop the prompt
          if (retryQuestion) {
            busy = true;
            showThinking();
            runGmailQuery(retryQuestion);
          }
        },
        (problem) => {
          btn.disabled = false;
          btn.textContent = "Connect Gmail";
          text.textContent = problem;
        }
      );
    });
    card.appendChild(btn);
    return card;
  }

  function runGmailQuery(q) {
    const finish = (items) => { busy = false; removeThinking(); if (items) addToHistory(items); };

    safeSend({ type: "RASH_GMAIL_RECENT", limit: askedEmailCount(q) }, (res) => {
      if (!res || !res.ok) {
        finish([{ role: "note", kind: "error", text: gmailProblem(res) }]);
        return;
      }
      const data = res.data || {};

      if (data.connected === false) {
        busy = false;
        removeThinking();
        gmailConnected = false;
        showSessionOnly(connectPromptCard("Gmail isn't connected yet, so I can't read your inbox.", q));
        return;
      }
      gmailConnected = true;
      if (!data.found || !Array.isArray(data.emails) || data.emails.length === 0) {
        finish([{ role: "note", kind: "muted", text: data.message || 'No emails found in your inbox.' }]);
        return;
      }

      busy = false;
      removeThinking();
      showSessionOnly(emailCard(data.emails));
      // Only a content-free placeholder is saved, so the conversation still reads sensibly later
      addToHistory([{
        role: "note",
        kind: "muted",
        text: 'Showed your ' + data.emails.length + (data.emails.length === 1 ? ' most recent email' : ' most recent emails') + ' (not saved).',
      }]);
    });
  }

  // ---------- Settings popover (gear in the header) ----------
  // A quiet home for things that shouldn't sit in the chat view. Gmail's Disconnect lives here, and
  // the status is only fetched when the popover is actually opened.
  let settingsEl = null;

  function closeSettings() {
    if (settingsEl) { settingsEl.remove(); settingsEl = null; }
  }

  function openSettings() {
    closeSettings();
    settingsEl = el("div", "consent");
    settingsEl.setAttribute("role", "dialog");
    settingsEl.setAttribute("aria-label", "RaSh options");
    settingsEl.appendChild(el("div", "ctext", "Options"));

    const line = el("div", "fpath", "Checking Gmail...");
    settingsEl.appendChild(line);

    const row = el("div", "crow");
    row.style.marginTop = "12px";
    const close = el("button", "btn ghost", "Close");
    close.addEventListener("click", closeSettings);

    fetchGmailStatus((status, res) => {
      if (!settingsEl) return; // closed while the status was in flight
      if (!status) {
        line.textContent = gmailProblem(res);
      } else if (status.configured !== true) {
        line.textContent = "Gmail isn't set up on the server yet.";
      } else if (status.connected !== true) {
        line.textContent = "Gmail is not connected. Just ask about your email to connect it.";
      } else {
        line.textContent = "Gmail is connected.";
        const disconnect = el("button", "btn", "Disconnect Gmail");
        disconnect.addEventListener("click", () => {
          disconnect.disabled = true;
          safeSend({ type: "RASH_GMAIL_DISCONNECT" }, (dres) => {
            if (dres && dres.ok) {
              gmailConnected = false;
              closeSettings();
              showToast("Gmail disconnected.");
            } else {
              disconnect.disabled = false;
              line.textContent = gmailProblem(dres);
            }
          });
        });
        row.insertBefore(disconnect, close);
      }
    });

    row.appendChild(close);
    settingsEl.appendChild(row);
    shadow.appendChild(settingsEl);
  }

  settingsBtn.addEventListener("click", () => {
    if (settingsEl) closeSettings();
    else openSettings();
  });

  // ---------- Chat attachment (paperclip / drag-and-drop) ----------
  // Held in page memory only, until either "remember this" saves it, or the message is sent without
  // a save phrase (then it is simply discarded). Never written to chrome.storage or the chat history.
  const ATTACH_MAX_BYTES = 20 * 1024 * 1024;
  const SAVE_INTENT = /\b(remember|save|keep|store)\s+(this|it)\b|\bplease\s+(remember|save)\b/i;
  // The attached file stays "active" after a question is asked, so follow-ups about the same file
  // work without attaching it again. Cleared by the x on the chip, by saving it, by clearing the
  // conversation, or by reloading the page. { name, size, buffer, kind, text? }
  let pendingAttachment = null;

  function attachFileIcon(name) {
    const ext = (String(name).split(".").pop() || "").toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return icon("image", 18);
    return icon("doc", 18);
  }

  function updateAttachChip() {
    attachRow.innerHTML = "";
    if (!pendingAttachment) { attachRow.hidden = true; return; }
    attachRow.hidden = false;
    const card = el("div", "card");
    const box = el("div", "file");
    const top = el("div", "frow1");
    const ic = el("div", "ficon");
    ic.innerHTML = attachFileIcon(pendingAttachment.name);
    top.appendChild(ic);
    const info = el("div", "");
    info.appendChild(el("div", "fname", pendingAttachment.name));
    // An image is read or described, never saved as a memory, so it gets its own wording
    const sizeKb = Math.max(1, Math.round(pendingAttachment.size / 1024));
    const hint = isImageAttachment(pendingAttachment)
      ? sizeKb + " KB - ask what's in it"
      : sizeKb + " KB - ask about it, or say \"remember this\" to save it";
    info.appendChild(el("div", "fpath", hint));
    top.appendChild(info);
    const remove = el("button", "x", "");
    remove.innerHTML = icon("close", 14);
    remove.title = "Remove attachment";
    remove.setAttribute("aria-label", "Remove attachment");
    remove.addEventListener("click", () => { pendingAttachment = null; updateAttachChip(); });
    top.appendChild(remove);
    box.appendChild(top);
    card.appendChild(box);
    attachRow.appendChild(card);
  }

  async function handleAttachedFile(file) {
    if (!file) return;
    if (file.size > ATTACH_MAX_BYTES) { setStatus("That file is larger than 20 MB."); return; }
    const okType = /\.(pdf|txt)$/i.test(file.name) || /^image\/(png|jpeg|gif|webp)$/i.test(file.type);
    if (!okType) { setStatus("I can only attach PDF, text or image files."); return; }
    try {
      const buffer = await file.arrayBuffer();
      pendingAttachment = { name: file.name, size: file.size, buffer: buffer };
      updateAttachChip();
      openPanel();
    } catch (e) {
      setStatus("Could not read that file.");
    }
  }

  // Chrome extension messages must be JSON-safe, so the file goes to background.js as base64
  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  // ---------- Asking about the attached file ----------
  // "read the total" style questions need the printed characters exactly right, so they go to the
  // server's text reader. "what is this" style questions go to the vision model. The user never
  // picks; the wording decides, the same way every other route in this panel is chosen.
  const IMAGE_READ_WORDS = /\b(read|reads|reading|says?|said|text|written|writing|transcribe|transcription|word|words|number|numbers|code|total|amount|price|cost|due|date|invoice|receipt|reference|serial|how much|what does it say)\b/i;

  function wantsImageText(q) {
    return IMAGE_READ_WORDS.test(q);
  }

  // Deciding between "about the attached file" and "about my saved memories".
  // Pointing words win outright: "what does this say" is about the attachment even though it also
  // looks a bit like a recall question. Otherwise the memory phrases below keep their normal route,
  // so having a file attached never hijacks "what did I read yesterday".
  const POINTS_AT_ATTACHMENT = /\b(this|these|attached|attachment)\b/i;
  const SAVED_FILE_NOUNS = /\b(file|files|pdf|pdfs|document|documents|doc|docs|attachment|attachments)\b/i;
  const SAVED_FILE_RECALL = /\b(save|saved|saving|upload|uploaded|attach|attached|added|recent|recently|last|latest)\b/i;

  // Mirrors the server's file-recall rule, so "what were the last 3 files I saved" still goes to memory
  function isFileRecallPhrase(q) {
    return SAVED_FILE_NOUNS.test(q) && SAVED_FILE_RECALL.test(q);
  }

  function isAboutAttachment(q) {
    if (POINTS_AT_ATTACHMENT.test(q)) return true;
    return !RECALL_WORDS.test(q) && !isFileRequest(q) && !isFileRecallPhrase(q);
  }

  function isImageAttachment(file) {
    return /^image\//i.test(file.type || "") || /\.(png|jpe?g|gif|webp)$/i.test(file.name || "");
  }

  // Shrinks a photo before sending it: the models don't need more than this, and it keeps the
  // request small enough for the server's JSON limit.
  function downscaleImage(file, maxSide, done) {
    try {
      const blob = new Blob([file.buffer], { type: file.type || "image/png" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
          URL.revokeObjectURL(url);
          done(dataUrl.slice(dataUrl.indexOf(",") + 1));
        } catch (e) {
          URL.revokeObjectURL(url);
          done(null);
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); done(null); };
      img.src = url;
    } catch (e) {
      done(null);
    }
  }

  // Reads a PDF/text file's text once, then keeps it on the attachment for follow-up questions
  function ensureFileText(file, done) {
    if (typeof file.text === "string") { done(file.text); return; }
    safeSend({ type: "RASH_FILE_TEXT", data: bufferToBase64(file.buffer) }, (res) => {
      if (res && res.ok && res.data && typeof res.data.text === "string") {
        file.text = res.data.text;
        done(file.text);
      } else {
        done(null, (res && res.data && res.data.error) || "I couldn't read that file.");
      }
    });
  }

  function answerFromFile(q, file) {
    const done = (items) => { busy = false; removeThinking(); addToHistory(items); };
    const card = (data) => {
      if (data.found) {
        // Only the one-sentence answer is kept. The file's text and the image itself never are.
        done([{
          role: "answer", kind: "answer", title: "", answer: data.answer || "",
          source_url: "", last_updated: "", source_label: data.source_label || "From this file",
        }]);
      } else {
        done([{ role: "note", kind: "muted", text: data.message || "I couldn't answer from this file." }]);
      }
    };
    const failed = (res) => done([{ role: "note", kind: "error", text: gmailProblem(res) }]);

    if (isImageAttachment(file)) {
      const mode = wantsImageText(q) ? "read" : "describe";
      console.log("[RaSh] file question: image,", mode);

      // Text already read out of this image? Then follow-ups need no second look at it.
      if (mode === "read" && typeof file.text === "string" && file.text) {
        safeSend({ type: "RASH_ASK_FILE", question: q, text: file.text.slice(0, 300000) }, (res) => {
          if (!res || !res.ok) { failed(res); return; }
          card(res.data || {});
        });
        return;
      }

      downscaleImage(file, 1024, (base64) => {
        if (!base64) { done([{ role: "note", kind: "error", text: "I couldn't open that image." }]); return; }
        safeSend({ type: "RASH_ASK_FILE", question: q, image: base64, mode: mode }, (res) => {
          if (!res || !res.ok) { failed(res); return; }
          const data = res.data || {};
          if (typeof data.extracted_text === "string" && data.extracted_text) file.text = data.extracted_text;
          card(data);
        });
      });
      return;
    }

    console.log("[RaSh] file question: document");
    ensureFileText(file, (text, problem) => {
      if (!text) { done([{ role: "note", kind: "error", text: problem || "I couldn't read that file." }]); return; }
      safeSend({ type: "RASH_ASK_FILE", question: q, text: text.slice(0, 300000) }, (res) => {
        if (!res || !res.ok) { failed(res); return; }
        card(res.data || {});
      });
    });
  }

  function saveAttachedFile(file) {
    chooseDestination((vault) => {
      safeSend(
        { type: "RASH_SAVE_ATTACHMENT", name: file.name, data: bufferToBase64(file.buffer), is_sensitive: vault },
        (res) => {
          busy = false;
          removeThinking();
          if (res && res.ok && res.data && res.data.success) {
            addToHistory([{ role: "note", kind: "muted", text: 'Saved "' + file.name + '" as a new record.' + (vault ? " It's in your Vault." : "") }]);
          } else {
            addToHistory([{ role: "note", kind: "error", text: (res && res.data && res.data.error) || "Could not save that file." }]);
          }
        }
      );
    });
  }

  attachBtn.addEventListener("click", () => attachFileInput.click());
  attachFileInput.addEventListener("change", () => {
    const f = attachFileInput.files && attachFileInput.files[0];
    attachFileInput.value = "";
    if (f) handleAttachedFile(f);
  });

  // Dropping a file onto the open panel attaches it, the same as using the paperclip button
  ["dragover", "dragenter"].forEach((evt) => panel.addEventListener(evt, (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
      e.preventDefault();
      panel.classList.add("drag-over");
    }
  }));
  ["dragleave", "drop"].forEach((evt) => panel.addEventListener(evt, () => panel.classList.remove("drag-over")));
  panel.addEventListener("drop", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    handleAttachedFile(e.dataTransfer.files[0]);
  });

  function submitQuestion() {
    const q = input.value.trim();
    if (!q || busy) return; // an attachment with no typed text at all: do nothing (Send is a no-op)
    input.value = "";

    // Instant time/date/day: answered from the browser clock, before anything else - no server
    // call, no page read, no attachment/Gmail/routing checks at all.
    const instantKind = classifyInstantIntent(q);
    if (instantKind) {
      console.log("[RaSh] route: instant |", JSON.stringify(q));
      addToHistory([
        { role: "user", text: q },
        { role: "answer", kind: "answer", title: "", answer: instantClockAnswer(instantKind), source_url: "", last_updated: "", source_label: "Instant answer" },
      ]);
      return;
    }

    busy = true;
    showThinking();

    const attachment = pendingAttachment;

    // Saving consumes the attachment, as before. Asking about it does not: it stays active so
    // follow-up questions about the same file work without attaching it again.
    if (attachment && SAVE_INTENT.test(q)) {
      pendingAttachment = null;
      updateAttachChip();
      addToHistory([{ role: "user", text: q }], () => saveAttachedFile(attachment));
      return;
    }

    // Asking about the inbox goes to Gmail, live, before any page or memory search
    if (isGmailQuestion(q)) {
      console.log("[RaSh] route: gmail |", JSON.stringify(q));
      addToHistory([{ role: "user", text: q }], () => runGmailQuery(q));
      return;
    }

    // A file is attached: answer about it, unless the wording is clearly about saved memories
    // ("what did I read yesterday", "what PDF did I save"), which should still reach memory.
    if (attachment && isAboutAttachment(q)) {
      console.log("[RaSh] route: attached-file |", JSON.stringify(q));
      addToHistory([{ role: "user", text: q }], () => answerFromFile(q, attachment));
      return;
    }

    // No attachment, or a question aimed at memory instead: answer as usual.
    // If a file IS attached and we got here, the wording was memory-ish ("the last 3 files I
    // saved"), so it goes to memory - never to page mode, which would read the web page behind
    // the panel and answer from something the user isn't even asking about.
    const mode = attachment ? "memory" : classifyQuestion(q);
    console.log("[RaSh] route:", mode, "|", JSON.stringify(q));
    addToHistory([{ role: "user", text: q }], () => runQuery(q, mode));
  }

  function runQuery(q, mode) {
    const done = (items) => { busy = false; removeThinking(); addToHistory(items); };

    if (mode === "memory") {
      const requestId = ++streamRequestSeq;
      activeStreamRequestId = requestId;
      safeSend(
        { type: "RASH_QUERY", question: q, history: recentHistoryForServer(), requestId: requestId },
        (res) => {
          if (activeStreamRequestId === requestId) activeStreamRequestId = null;
          removeStreamingAnswer();
          done(resultToItems(res));
        }
      );
      return;
    }

    // "page" or "unclear": answer only from this page's text. Unclear questions also offer the memory search.
    const opts = mode === "unclear" ? { offer: true, question: q } : null;
    const cardOnly = (answer, label) => done([{
      role: "answer", kind: "answer", title: "", answer: answer, source_url: "", last_updated: "",
      source_label: label, offer_memory: !!opts, question: opts ? q : ""
    }]);

    if (pageNotReadable()) {
      cardOnly("I'm sorry, I can't read this page because it looks sensitive. Thank you for understanding.", "This page was not read");
      return;
    }
    const summaryIntent = isSummaryRequest(q);
    const text = buildPageText(q, summaryIntent);
    if (!text) { cardOnly("I could not find that.", "From this page"); return; }

    safeSend(
      { type: "RASH_QUERY", question: q, mode: "page", page: { title: document.title || "", url: location.href, text: text, summary: summaryIntent }, history: recentHistoryForServer() },
      (res) => {
        // Only a server that confirms it answered from the page may answer; an old server would search memory
        const d = res && res.data;
        if (res && res.ok && d && !d.error && d.source !== "page") {
          cardOnly("Sorry, I could not answer from this page. Please restart the RaSh server so it has the latest update.", "This page was not answered");
          return;
        }
        done(resultToItems(res, opts));
      }
    );
  }

  // Keep the page's own keyboard shortcuts from firing while typing in the box
  ["keydown", "keyup", "keypress"].forEach((evt) => {
    input.addEventListener(evt, (e) => {
      e.stopPropagation();
      if (evt === "keydown" && e.key === "Enter") submitQuestion();
      if (evt === "keydown" && e.key === "Escape") closePanel();
    });
  });
  goBtn.addEventListener("click", submitQuestion);

  loadHistory();

  // ---------- Pure text extraction from the page DOM ----------
  function extractText() {
    const root = document.querySelector("article") || document.querySelector("main") || document.body;
    let text = (root.innerText || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text.slice(0, MAX_CHARS);
  }

  // Login / payment pages must never be auto-saved
  function isSensitivePage() {
    return !!document.querySelector('input[type="password"], input[autocomplete*="cc-number"], input[autocomplete*="current-password"], input[autocomplete*="new-password"]');
  }

  // Left over from the old content-based sensitivity prompt. Nothing sets these now that an
  // automatic capture never asks anything; closeSensitive() is kept because render() calls it.
  let sensitiveEl = null;
  let pendingCapture = null;

  function closeSensitive() {
    pendingCapture = null; // discard anything that was waiting
    if (sensitiveEl) { sensitiveEl.remove(); sensitiveEl = null; }
  }

  // Small, non-blocking note that fades after about 4 seconds. Only called after the server confirmed a save.
  let toastEl = null;
  let toastTimer = null;
  function showToast(text) {
    clearTimeout(toastTimer);
    if (!toastEl) {
      toastEl = el("div", "toast");
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      shadow.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add("show");
    toastTimer = setTimeout(() => { if (toastEl) toastEl.classList.remove("show"); }, 4000);
  }

  // ---------- Vault or Normal ----------
  // Every page save asks "Save to Vault or Normal?" unless the user ticked "Remember my choice" earlier.
  // The page text waits in page memory until they answer; nothing is sent before that.
  const CHOICE_KEY = "rashSaveChoice"; // "vault" or "normal" in chrome.storage.local
  let destEl = null;

  function closeDest() {
    if (destEl) { destEl.remove(); destEl = null; }
  }

  // onChoose(vaultBool) runs once the user (or a remembered choice) has picked a destination.
  // Whether that destination applies (e.g. only while RaSh is ON) is for the caller to decide.
  function askDestination(onChoose) {
    closeDest();
    destEl = el("div", "consent");
    destEl.setAttribute("role", "dialog");
    destEl.setAttribute("aria-label", "Save destination");
    if (consentEl || sensitiveEl) destEl.style.bottom = "170px"; // do not cover another panel
    destEl.appendChild(el("div", "ctext", "Save to Vault or Normal?"));
    destEl.appendChild(el("div", "fpath", "Vault keeps it private behind your PIN. Nothing is saved until you choose."));

    const remember = el("input");
    remember.type = "checkbox";
    remember.id = "rash-remember";
    remember.style.cssText = "flex:none;width:14px;height:14px;min-width:14px;padding:0;margin:0;";
    const rememberLabel = el("label", "fpath", "Remember my choice");
    rememberLabel.setAttribute("for", "rash-remember");
    rememberLabel.style.cursor = "pointer";
    const rememberRow = el("div", "");
    rememberRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:10px;";
    rememberRow.appendChild(remember);
    rememberRow.appendChild(rememberLabel);
    destEl.appendChild(rememberRow);

    const row = el("div", "crow");
    row.style.marginTop = "12px";
    const pick = (dest, label, cls) => {
      const b = el("button", cls, label);
      b.addEventListener("click", () => {
        const keep = remember.checked;
        closeDest();
        if (keep) {
          try { chrome.storage.local.set({ [CHOICE_KEY]: dest }); } catch (e) {}
        }
        onChoose(dest === "vault");
      });
      return b;
    };
    row.appendChild(pick("vault", "Vault", "btn"));
    row.appendChild(pick("normal", "Normal", "btn ghost"));
    destEl.appendChild(row);
    shadow.appendChild(destEl);
  }

  function chooseDestination(onChoose) {
    try {
      chrome.storage.local.get(CHOICE_KEY, (r) => {
        const saved = !chrome.runtime.lastError && r ? r[CHOICE_KEY] : null;
        if (saved === "vault" || saved === "normal") onChoose(saved === "vault");
        else askDestination(onChoose);
      });
    } catch (e) {
      askDestination(onChoose); // extension was reloaded; still ask, never guess
    }
  }

  function sendCapture(payload, confirmed, vault) {
    safeSend(
      { type: "RASH_CAPTURE", title: payload.title, content: payload.content, confirmed: confirmed === true, is_sensitive: vault === true },
      (res) => {
        if (res && res.ok) showToast("RaSh saved: " + (document.title || location.hostname).trim().slice(0, 60));
        else if (res && res.reason === "private") setStatus("Not saved: private site");
        else if (res && res.reason === "off") setStatus("RaSh is OFF");
        else setStatus("Server not reachable");
      }
    );
  }

  // Whether the page itself is the kind of place where saving deserves a choice. Only the host
  // and path are checked, never the query string: searching Google for "bank" must not make the
  // results page look like a bank.
  const SENSITIVE_URL = /(login|signin|sign-in|signup|sign-up|account|payment|checkout|bank|wallet|otp|verify|password|auth)/i;
  function isSensitiveUrl() {
    return SENSITIVE_URL.test(location.hostname + location.pathname);
  }

  function capture() {
    if (!enabled) return;
    // Email sites are never saved and never asked about
    if (PRIVATE_HOSTS.some((p) => location.hostname === p || location.hostname.endsWith("." + p))) {
      setStatus("Not saved: private site");
      return;
    }
    if (pendingCapture) return; // still waiting for an answer about another page
    const raw = extractText();
    if (raw.length < MIN_CHARS) { setStatus("Not enough text here"); return; }
    const key = location.href + "|" + raw.length;
    if (key === lastCaptured) return;
    lastCaptured = key;
    closeDest(); // a newer page replaces an unanswered Vault/Normal question (the older text is discarded)

    // Card numbers and one-time codes are stripped from the text before it ever leaves the page
    const payload = {
      title: scrubSensitive((document.title || location.hostname) + " (" + location.hostname + ")"),
      content: "Source: " + location.href + "\n\n" + scrubSensitive(raw)
    };
    // On a sign-in, payment or banking address, where the choice is worth making, ask once.
    if (isSensitiveUrl()) {
      chooseDestination((vault) => sendCapture(payload, false, vault));
      return;
    }
    // Everywhere else: saved as Normal, silently. No prompt, no modal, no interaction.
    // (Card numbers and one-time codes are still stripped from the text by scrubSensitive above.)
    sendCapture(payload, false, false);
  }

  // ---------- Form consent ----------
  // When RaSh is ON and a form is submitted, the field labels and values are read into a variable in this
  // page only. Nothing is sent anywhere until the user clicks one of the buttons in the panel below.
  const SECRET_FIELD = /\bpass(word|wd|code)?\b|passwd|card|cc-|ccnum|cvv|cvc|csc|otp|one.?time|verification.?code|\bpin\b|security.?code|expir/i;
  let pendingForm = null; // { fields: [{label, value}] } - lives in page memory only
  let consentEl = null;

  function fieldLabel(f) {
    let label = "";
    try { if (f.labels && f.labels[0]) label = f.labels[0].textContent; } catch (e) {}
    return (label || f.getAttribute("aria-label") || f.placeholder || f.name || f.id || f.type || "Field")
      .replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function isSecretField(f) {
    if (f.type === "password") return true;
    const ac = (f.getAttribute("autocomplete") || "").toLowerCase();
    if (/^cc-|current-password|new-password|one-time-code/.test(ac)) return true;
    if (f.inputMode === "numeric" && f.maxLength >= 3 && f.maxLength <= 4 && /cv|sec/i.test(f.name + f.id)) return true;
    return SECRET_FIELD.test([f.name, f.id, f.placeholder, f.getAttribute("aria-label"), fieldLabel(f)].join(" "));
  }

  function collectForm(form) {
    // A login / sign-up form (any password field) is never offered for saving
    if (form.querySelector('input[type="password"]')) return null;
    const fields = [];
    Array.from(form.elements || []).forEach((f) => {
      const tag = (f.tagName || "").toLowerCase();
      if (tag !== "input" && tag !== "textarea" && tag !== "select") return;
      const type = (f.type || "").toLowerCase();
      if (["hidden", "password", "file", "submit", "button", "reset", "image"].includes(type)) return;
      if ((type === "checkbox" || type === "radio") && !f.checked) return;
      if (isSecretField(f)) return;
      let value = tag === "select"
        ? Array.from(f.selectedOptions || []).map((o) => o.textContent).join(", ")
        : (type === "checkbox" || type === "radio" ? "Yes" : f.value);
      value = scrubSensitive(String(value || "").trim()).slice(0, 500);
      if (!value) return;
      fields.push({ label: fieldLabel(f), value: value, type: type });
    });
    if (fields.length === 0) return null;
    // A lone search box is not a form worth saving
    if (fields.length === 1 && (fields[0].type === "search" || /^(q|query|search|s|keyword|keywords)$/i.test(fields[0].label))) return null;
    if ((form.getAttribute("role") || "").toLowerCase() === "search") return null;
    return fields.map((f) => ({ label: f.label, value: f.value }));
  }

  function closeConsent() {
    pendingForm = null; // drop the collected data from memory
    if (consentEl) { consentEl.remove(); consentEl = null; }
  }

  function showConsent(fields) {
    closeConsent();
    pendingForm = { fields: fields };
    consentEl = el("div", "consent");
    consentEl.setAttribute("role", "dialog");
    consentEl.setAttribute("aria-label", "Save form information");
    consentEl.appendChild(el("div", "ctext", "RaSh noticed you filled a form on " + location.hostname + ". Save this information?"));
    const row = el("div", "crow");
    const choose = (sensitive, label) => {
      const b = el("button", sensitive === "vault" ? "btn" : "btn ghost", label);
      b.addEventListener("click", () => {
        const data = pendingForm;
        closeConsent();
        if (sensitive === null || !data) return; // "Don't save": do nothing at all
        safeSend({ type: "RASH_SAVE_FORM", fields: data.fields, is_sensitive: sensitive === "vault" }, (res) => {
          if (res && res.ok) setStatus(sensitive === "vault" ? "Saved to Vault" : "Saved to RaSh");
          else if (res && res.reason === "private") setStatus("Not saved: private site");
          else setStatus("Could not save the form");
        });
      });
      return b;
    };
    row.appendChild(choose("vault", "Save to Vault"));
    row.appendChild(choose("normal", "Save normally"));
    row.appendChild(choose(null, "Don't save"));
    consentEl.appendChild(row);
    shadow.appendChild(consentEl);
  }

  // Capture phase: read the values before the page's own handlers can clear or send them
  document.addEventListener("submit", (e) => {
    if (!enabled || isPrivateHost(location.hostname)) return;
    const form = e.target;
    if (!form || form.tagName !== "FORM") return;
    try {
      const fields = collectForm(form);
      if (fields) showConsent(fields);
    } catch (err) {}
  }, true);

  // ---------- Smart form autofill ----------
  // Detects a form's fields, matches them against the user's own saved profile (a flat local
  // file, never rash.db), and offers to fill it - only while RaSh is ON, never on a private or
  // sign-in/payment-looking page, and never into a password, OTP, card or CVV field.
  const AUTOFILL_DOB_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december"];

  // Pure, DOM-independent field classification: given the field's combined text (name, id,
  // placeholder, aria-label, associated <label>) plus its type/autocomplete, decide what it is.
  // Kept free of any DOM access so it can be tested directly against plain strings.
  const AUTOFILL_CATEGORIES = [
    ["firstName", /\bfirst[\s_-]?name\b|\bfname\b|\bgiven[\s_-]?name\b/i],
    ["lastName", /\blast[\s_-]?name\b|\blname\b|\bsurname\b|\bfamily[\s_-]?name\b/i],
    ["email", /\be-?mail\b/i],
    ["phone", /\bphone\b|\bmobile\b|\bcell\b|\bcontact[\s_-]?(no|number)\b|\btel(ephone)?\b/i],
    ["pincode", /\bpin[\s_-]?code\b|\bpincode\b/i],
    ["zip", /\bzip(code)?\b|\bpostal[\s_-]?code\b/i],
    ["street", /\bstreet\b|\baddress(\s*line\s*1?)?\b|\baddr(1)?\b/i],
    ["city", /\bcity\b|\btown\b/i],
    ["state", /\bstate\b|\bprovince\b/i],
    ["college", /\bcollege\b|\buniversity\b/i],
    ["gender", /\bgender\b|\bsex\b/i],
    ["day", /\bd[.\s_-]?o[.\s_-]?b[.\s_-]?day\b|\bbirth[\s_-]?day\b|\bday\b|\bdd\b/i],
    ["month", /\bd[.\s_-]?o[.\s_-]?b[.\s_-]?month\b|\bbirth[\s_-]?month\b|\bmonth\b|\bmm\b/i],
    ["year", /\bd[.\s_-]?o[.\s_-]?b[.\s_-]?year\b|\bbirth[\s_-]?year\b|\byear\b|\byyyy\b|\byy\b/i],
  ];

  function classifyAutofillField(signal, type, autocomplete) {
    const ac = (autocomplete || "").toLowerCase();
    if (type === "email" || ac === "email") return "email";
    if (type === "tel" || ac === "tel") return "phone";
    for (const [category, re] of AUTOFILL_CATEGORIES) {
      if (re.test(signal)) return category;
    }
    return null;
  }

  // Never autofilled, full stop - reuses the same password/card/CVV/OTP pattern already trusted
  // elsewhere in this file, plus a login PIN. "PIN Code"/"Pincode" is deliberately NOT caught here
  // (it is a real, requested profile field, an Indian postal code, not a security PIN) - only a
  // bare "PIN" with no "code"/"postal" nearby is treated as a login PIN.
  function isNeverAutofillField(signal, type, autocomplete) {
    if (type === "password") return true;
    const ac = (autocomplete || "").toLowerCase();
    if (/^cc-/.test(ac) || ac === "current-password" || ac === "new-password" || ac === "one-time-code") return true;
    if (SECRET_FIELD.test(signal)) {
      // SECRET_FIELD's bare \bpin\b would also catch a legitimate "PIN Code" field - let that
      // one through unless it's clearly a login PIN with nothing postal/code-like alongside it.
      const isBarePinOnly = /\bpin\b/i.test(signal) && !/\bpin[\s_-]?code\b|\bpincode\b|\bpostal\b/i.test(signal);
      const matchesSomethingElseToo = /\bpass(word|wd|code)?\b|passwd|card|cc-|ccnum|cvv|cvc|csc|otp|one.?time|verification.?code|security.?code|\bexpir/i.test(signal);
      if (matchesSomethingElseToo || isBarePinOnly) return true;
      return false; // only matched because of the bare-pin part, and it's actually a postal code
    }
    return false;
  }

  function autofillFieldSignal(f) {
    return [f.name, f.id, f.placeholder, f.getAttribute && f.getAttribute("aria-label"), fieldLabel(f)]
      .filter(Boolean).join(" ").toLowerCase();
  }

  // A <select> with no name/id/label of its own, sitting in a row of similar anonymous selects
  // under one "Date of Birth" heading - very common on Indian forms. Guessed from its own options,
  // only ever used as a fallback when name/id/label matching found nothing for that field.
  function guessDobSelectFromOptions(select) {
    const options = Array.from(select.options || []).map((o) => (o.value || o.textContent || "").trim().toLowerCase()).filter(Boolean);
    if (options.length < 3) return null;
    const numeric = options.map(Number).filter((n) => !isNaN(n));
    if (numeric.length >= options.length - 1) {
      if (numeric.every((n) => n >= 1 && n <= 31) && Math.max(...numeric) > 12) return "day";
      if (numeric.every((n) => n >= 1 && n <= 12)) return "month";
      if (numeric.every((n) => n >= 1900 && n <= 2100)) return "year";
    }
    if (options.some((o) => AUTOFILL_DOB_MONTHS.includes(o))) return "month";
    return null;
  }

  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  // Sets a value the way a real user typing would, so frameworks (React, Vue, ...) that hook the
  // native property setter still notice the change - a plain "el.value = x" is often invisible to
  // them, leaving the on-screen text right but the form's real state empty on submit.
  function setAutofillValue(f, value) {
    const tag = (f.tagName || "").toLowerCase();
    if (tag === "select") {
      const proto = Object.getPrototypeOf(f);
      const setter = Object.getOwnPropertyDescriptor(proto, "value") || Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
      if (setter && setter.set) setter.set.call(f, value); else f.value = value;
    } else {
      const proto = Object.getPrototypeOf(f);
      const setter = Object.getOwnPropertyDescriptor(proto, "value") || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (setter && setter.set) setter.set.call(f, value); else f.value = value;
    }
    f.dispatchEvent(new Event("input", { bubbles: true }));
    f.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // A <select> for gender: match the option whose value/text is closest to "male"/"female"/"other"
  function fillGenderSelect(select, gender) {
    const target = String(gender || "").toLowerCase();
    if (!target) return false;
    const option = Array.from(select.options || []).find((o) => {
      const t = (o.value + " " + o.textContent).toLowerCase();
      if (target === "male") return /\bmale\b/.test(t) && !/female/.test(t) || /^m$/.test(t.trim());
      if (target === "female") return /\bfemale\b/.test(t) || /^f$/.test(t.trim());
      return /\bother\b|\bprefer|\bnon-binary\b/.test(t);
    });
    if (!option) return false;
    setAutofillValue(select, option.value);
    return true;
  }

  // A group of radio buttons named e.g. "gender": check the one matching the target value
  function fillGenderRadios(radios, gender) {
    const target = String(gender || "").toLowerCase();
    if (!target) return false;
    const match = radios.find((r) => {
      const t = (r.value + " " + autofillFieldSignal(r)).toLowerCase();
      if (target === "male") return /\bmale\b/.test(t) && !/female/.test(t) || /^m$/.test((r.value || "").trim());
      if (target === "female") return /\bfemale\b/.test(t) || /^f$/.test((r.value || "").trim());
      return /\bother\b|\bprefer|\bnon-binary\b/.test(t);
    });
    if (!match) return false;
    match.checked = true;
    match.dispatchEvent(new Event("input", { bubbles: true }));
    match.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // Scans one form, returns [{ field, category, value }] for every field RaSh can confidently
  // and safely fill - already excluding anything secret, and already excluding a category the
  // profile has nothing to offer for.
  function planFormAutofill(form, profile) {
    const plan = [];
    const claimed = new Set(); // one field per category per form, first match wins
    const genderRadiosByName = new Map();

    const elements = Array.from(form.elements || []).filter((f) => {
      const tag = (f.tagName || "").toLowerCase();
      return (tag === "input" || tag === "select" || tag === "textarea") && !f.disabled && !f.readOnly && isVisible(f);
    });

    // Radios are grouped by name first, since a group is one logical field, not many
    elements.forEach((f) => {
      if ((f.type || "").toLowerCase() === "radio" && f.name) {
        if (!genderRadiosByName.has(f.name)) genderRadiosByName.set(f.name, []);
        genderRadiosByName.get(f.name).push(f);
      }
    });

    for (const f of elements) {
      const type = (f.type || "").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image", "file", "checkbox"].includes(type)) continue;

      const signal = autofillFieldSignal(f);
      const autocomplete = f.getAttribute("autocomplete") || "";
      if (isNeverAutofillField(signal, type, autocomplete)) continue;

      if (type === "radio") {
        if (!/\bgender\b|\bsex\b/i.test(f.name + " " + signal)) continue;
        if (claimed.has("gender")) continue;
        const group = genderRadiosByName.get(f.name) || [f];
        if (!profile.gender) continue;
        claimed.add("gender");
        plan.push({ field: null, category: "gender", value: profile.gender, fillGroup: group });
        continue;
      }

      let category = classifyAutofillField(signal, type, autocomplete);
      if (!category && (f.tagName || "").toLowerCase() === "select") {
        category = guessDobSelectFromOptions(f);
      }
      if (!category || claimed.has(category)) continue;

      const value = profile[category];
      if (!value) continue; // nothing saved for this category - don't offer it

      claimed.add(category);
      plan.push({ field: f, category, value });
    }

    return plan;
  }

  function applyAutofillPlan(plan) {
    let filled = 0;
    for (const item of plan) {
      try {
        if (item.category === "gender" && item.fillGroup) {
          if (fillGenderRadios(item.fillGroup, item.value)) filled++;
          continue;
        }
        if ((item.field.tagName || "").toLowerCase() === "select" && item.category === "gender") {
          if (fillGenderSelect(item.field, item.value)) filled++;
          continue;
        }
        setAutofillValue(item.field, item.value);
        filled++;
      } catch (e) {}
    }
    return filled;
  }

  const autofillBannerByForm = new WeakMap();
  const autofillDismissedForms = new WeakSet();

  function showAutofillBanner(form, plan) {
    if (autofillDismissedForms.has(form) || autofillBannerByForm.has(form)) return;

    const host = document.createElement("div");
    host.style.cssText = "all:initial;display:block;margin-bottom:10px;";
    const bannerShadow = host.attachShadow({ mode: "open" });
    bannerShadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .bar {
          display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
          font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
          font-size: 13px; color: #F2F2F4; padding: 10px 14px; border-radius: 10px;
          background: rgba(17,17,20,0.94); border: 1px solid rgba(255,255,255,0.1);
        }
        .msg { flex: 1; min-width: 160px; }
        button {
          all: unset; cursor: pointer; padding: 6px 12px; border-radius: 8px; font-size: 12px; font-weight: 500;
          font-family: inherit;
        }
        .fill { background: #F2F2F4; color: #111114; }
        .fill:hover { background: #fff; }
        .dismiss { color: #C9C9D1; border: 1px solid rgba(255,255,255,0.14); }
        .dismiss:hover { background: rgba(255,255,255,0.06); }
      </style>
      <div class="bar" role="dialog" aria-label="RaSh autofill">
        <span class="msg">RaSh can fill ${plan.length} field${plan.length === 1 ? "" : "s"} — Autofill?</span>
        <button class="fill">Fill</button>
        <button class="dismiss">Dismiss</button>
      </div>
    `;

    bannerShadow.querySelector(".fill").addEventListener("click", () => {
      const filled = applyAutofillPlan(plan);
      bannerShadow.querySelector(".msg").textContent = filled > 0 ? `Filled ${filled} field${filled === 1 ? "" : "s"}.` : "Could not fill those fields.";
      bannerShadow.querySelector(".fill").remove();
      bannerShadow.querySelector(".dismiss").textContent = "Close";
      setTimeout(() => { host.remove(); autofillBannerByForm.delete(form); }, 2000);
    });
    bannerShadow.querySelector(".dismiss").addEventListener("click", () => {
      autofillDismissedForms.add(form);
      host.remove();
      autofillBannerByForm.delete(form);
    });

    try {
      form.parentNode.insertBefore(host, form);
      autofillBannerByForm.set(form, host);
    } catch (e) {}
  }

  function scanFormsForAutofill(profile) {
    if (!enabled || isPrivateHost(location.hostname) || isSensitiveUrl()) return;
    document.querySelectorAll("form").forEach((form) => {
      if (autofillDismissedForms.has(form) || autofillBannerByForm.has(form)) return;
      // A login/sign-up form (any password field) is never offered autofill either
      if (form.querySelector('input[type="password"]')) return;
      let plan;
      try { plan = planFormAutofill(form, profile); } catch (e) { return; }
      if (plan.length > 0) showAutofillBanner(form, plan);
    });
  }

  function startAutofillWhenReady() {
    safeSend({ type: "RASH_AUTOFILL_PROFILE" }, (res) => {
      if (!res || !res.ok || !res.data) return;
      const profile = res.data;
      scanFormsForAutofill(profile);
      // Forms in a single-page app can appear well after the initial load
      let rescans = 0;
      const rescanTimer = setInterval(() => {
        if (!enabled || ++rescans > 20) { clearInterval(rescanTimer); return; }
        scanFormsForAutofill(profile);
      }, 3000);
    });
  }

  // enabled is still its initial false here (the real state arrives asynchronously via
  // RASH_GET_STATE below); the check that matters lives inside scanFormsForAutofill itself,
  // both on this first call and on every periodic rescan, so this works correctly whether RaSh
  // was already ON when the page loaded or gets turned on a few seconds later.
  setTimeout(startAutofillWhenReady, 1500);

  // ---------- Smart profile learning ----------
  // The mirror image of autofill: when the user fills a form THEMSELVES and submits it, quietly
  // learn from what they typed so next time RaSh can offer to fill it. Same classifier, same
  // safety exclusions as autofill itself - a field RaSh would never fill is also one it never reads.
  const AUTOFILL_LOW_CONFIDENCE_VALUES = new Set(["test", "asdf", "xxxx", "123"]);
  const capturedFormsForLearning = new WeakSet();

  function captureFormForLearning(form) {
    if (!enabled || isPrivateHost(location.hostname) || isSensitiveUrl()) return;
    if (capturedFormsForLearning.has(form)) return;
    if (form.querySelector('input[type="password"]')) return; // login/sign-up form - never read
    capturedFormsForLearning.add(form);

    let elements;
    try {
      elements = Array.from(form.elements || []).filter((f) => {
        const tag = (f.tagName || "").toLowerCase();
        return (tag === "input" || tag === "select" || tag === "textarea") && !f.disabled && isVisible(f);
      });
    } catch (e) { return; }

    const claimed = new Set(); // same one-field-per-category rule as autofill, in reverse
    const genderRadiosByName = new Map();
    elements.forEach((f) => {
      if ((f.type || "").toLowerCase() === "radio" && f.name) {
        if (!genderRadiosByName.has(f.name)) genderRadiosByName.set(f.name, []);
        genderRadiosByName.get(f.name).push(f);
      }
    });

    const learned = [];
    for (const f of elements) {
      const type = (f.type || "").toLowerCase();
      if (["hidden", "submit", "button", "reset", "image", "file", "checkbox"].includes(type)) continue;

      const signal = autofillFieldSignal(f);
      const autocomplete = f.getAttribute("autocomplete") || "";
      if (isNeverAutofillField(signal, type, autocomplete)) continue;

      if (type === "radio") {
        if (!/\bgender\b|\bsex\b/i.test(f.name + " " + signal) || claimed.has("gender")) continue;
        const group = genderRadiosByName.get(f.name) || [f];
        const checked = group.find((r) => r.checked);
        if (!checked) continue;
        const t = (checked.value + " " + autofillFieldSignal(checked)).toLowerCase();
        const value = /\bmale\b/.test(t) && !/female/.test(t) ? "male" : /\bfemale\b/.test(t) ? "female" : /\bother\b|non-binary/.test(t) ? "other" : "";
        if (!value) continue;
        claimed.add("gender");
        learned.push({ field: "gender", value });
        continue;
      }

      let category = classifyAutofillField(signal, type, autocomplete);
      if (!category && (f.tagName || "").toLowerCase() === "select") category = guessDobSelectFromOptions(f);
      if (!category || claimed.has(category)) continue;

      let value = (f.value || "").trim();
      if (category === "gender" && (f.tagName || "").toLowerCase() === "select") {
        const t = value.toLowerCase();
        value = /\bmale\b/.test(t) && !/female/.test(t) ? "male" : /\bfemale\b/.test(t) ? "female" : /\bother\b|non-binary/.test(t) ? "other" : "";
      }
      if (value.length < 2 || AUTOFILL_LOW_CONFIDENCE_VALUES.has(value.toLowerCase())) continue;

      claimed.add(category);
      learned.push({ field: category, value });
    }

    // Fire-and-forget, one message per field - no UI, no notification, nothing shown to the user
    for (const item of learned) {
      try { safeSend({ type: "RASH_AUTOFILL_LEARN", field: item.field, value: item.value }, () => {}); } catch (e) {}
    }
  }

  document.addEventListener("submit", (e) => {
    if (e.target && e.target.tagName === "FORM") {
      try { captureFormForLearning(e.target); } catch (err) {}
    }
  }, true);

  window.addEventListener("beforeunload", () => {
    if (!enabled) return;
    try { document.querySelectorAll("form").forEach((form) => captureFormForLearning(form)); } catch (e) {}
  });

  // ---------- Wiring ----------
  toggleBtn.addEventListener("click", () => {
    openWidget();
    scheduleClose(2500);
    setEnabledLocally(!enabled, () => {
      if (enabled) capture();
      else setStatus("RaSh is OFF");
    });
  });

  // Keep every tab's widget in sync when the switch or the shared conversation changes anywhere
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.rashEnabled) {
        const at = (changes.rashEnabledAt && changes.rashEnabledAt.newValue) || 0;
        if (at >= lastEnabledChangeAt) {
          lastEnabledChangeAt = at;
          enabled = changes.rashEnabled.newValue === true;
          render();
        } // else: a delayed echo of an older change this tab has already moved past — ignore it
      }
      if (changes[CHAT_KEY]) renderHistory(changes[CHAT_KEY].newValue);
      if (SpeechRecognitionCtor && changes[WAKE_ENABLED_KEY]) {
        const on = changes[WAKE_ENABLED_KEY].newValue === true;
        setWakeToggleUI(on);
        if (on) beginWakeListening();
        else stopWakeRecognizer();
      }
    });
  } catch (e) {}

  safeSend({ type: "RASH_GET_STATE" }, (res) => {
    enabled = !!(res && res.enabled);
    render();
    // If already ON, capture this page shortly after it loads
    if (enabled) setTimeout(capture, 4000);
  });

  // Single-page apps change the address without reloading: capture the new page too (only while ON)
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    if (enabled) setTimeout(capture, 2500); // capture() checks the switch again before saving
  }, 1000);

  render();
  document.documentElement.appendChild(host);

  // Login pages and single-page apps often rebuild the DOM; put the widget back if it gets removed
  let reattachTimer = null;
  new MutationObserver(() => {
    if (host.isConnected) return;
    clearTimeout(reattachTimer);
    reattachTimer = setTimeout(() => {
      if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
    }, 200);
  }).observe(document.documentElement, { childList: true });

  // Peek out briefly when the page loads so you know it's there
  openWidget();
  scheduleClose(2500);
})();
