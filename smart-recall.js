// Smart Recall v2 question router and answers (docs/SMART_RECALL_V2.md, phases 3-4).
//
// Every memory question to /api/ask (and /api/ask/stream) comes through answer(). Fast rules
// (regex/keywords only - no extra LLM call) pick a route:
//   time-order   "what did i read before hardik pandya"   -> neighbouring save events, no LLM
//   list         "last 3 files", "what did I do yesterday" -> SQL ordered by time, no LLM
//   file         "where's my unit 3 assignment"            -> hybrid search over saved files, no LLM
//   hybrid       everything else                           -> vector + keyword (RRF), then the LLM
// Routes combine with time windows ("yesterday", "on Thursday at night") and site filters ("on
// YouTube"). A rule route that finds nothing falls back to hybrid search. If nothing is a strong
// match, the answer is the fixed not-found sentence - RaSh never guesses.
'use strict';

const searchIndex = require('./search-index');

const { CONFIG } = searchIndex;
const NOT_FOUND = "I couldn't find that in your memory.";
const RRF_K = 60;

let db = null;
let h = null; // helpers from server.js

function init(options) {
  db = options.db;
  h = options.helpers;
}

// ---------------------------------------------------------------------------
// Local-time wording. The model never does date math: every time it sees is already worded here.
// Day parts: morning 5-12, afternoon 12-17, evening 17-21, night 21-5.
// ---------------------------------------------------------------------------
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PART_HOURS = { morning: [5, 12], afternoon: [12, 17], evening: [17, 21], night: [21, 29] }; // 29 = 5 AM next day

function dayStart(d, offsetDays = 0) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetDays);
}
function daysBetween(from, to) {
  return Math.round((dayStart(to) - dayStart(from)) / 86400000);
}
function clock(d) {
  const hr = d.getHours();
  return (hr % 12 || 12) + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + (hr >= 12 ? 'PM' : 'AM');
}
function dayPart(hour) {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 21) return 'evening';
  return 'night';
}
function dateLabel(d, now) {
  return WEEKDAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '');
}
function partPhrase(part) {
  return part === 'night' ? 'at night' : 'in the ' + part;
}

// "today at 2:33 PM", "yesterday evening (6:40 PM)", "last night (10:05 PM)",
// "Thursday 24 Sep at night (10:05 PM)"
function when(d, now) {
  const ago = daysBetween(d, now);
  const part = dayPart(d.getHours());
  if (ago <= 0) return 'today at ' + clock(d);
  if (ago === 1) {
    if (part === 'night') return d.getHours() >= 21 ? `last night (${clock(d)})` : `yesterday at ${clock(d)}`;
    return `yesterday ${part} (${clock(d)})`;
  }
  return `${dateLabel(d, now)} ${partPhrase(part)} (${clock(d)})`;
}

// when() as it reads mid-sentence: "saved on Thursday 24 Sep ...", but "saved today at 2:33 PM".
function whenPhrase(text) {
  return /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/.test(text) ? 'on ' + text : text;
}

function parseUtc(value) {
  const d = new Date(String(value || '').replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}
function sqlUtc(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// Question parsing. Works on lowercased text with punctuation removed, so voice input ("what did
// i read before hardik pandya") and typed input read the same.
// ---------------------------------------------------------------------------
function normalize(q) {
  return String(q || '').toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/'s\b/g, '')
    .replace(/'/g, '')
    .replace(/[^a-z0-9₹\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COUNT_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WEEKDAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};

function num(word) {
  return COUNT_WORDS[word] || parseInt(word, 10);
}

function windowLabel(day, part, now) {
  const ago = daysBetween(day, now);
  if (ago === 0) return part ? { morning: 'This morning', afternoon: 'This afternoon', evening: 'This evening', night: 'Tonight' }[part] : 'Today';
  if (ago === 1) return part ? (part === 'night' ? 'Last night' : 'Yesterday ' + part) : 'Yesterday';
  return 'On ' + dateLabel(day, now) + (part ? ' ' + partPhrase(part) : '');
}

// Finds a time window in the question. Returns { start, end, label, singleDay, hourPart, consumed }
// or null. `consumed` lists the matched phrases so they aren't mistaken for the topic.
function parseWindow(nq, now) {
  const today = dayStart(now);
  const consumed = [];
  const use = (re) => {
    const m = nq.match(re);
    if (m) consumed.push(m[0]);
    return m;
  };
  const partMatch = nq.match(/\b(morning|afternoon|evening|night|tonight)\b/);
  let part = partMatch ? (partMatch[1] === 'tonight' ? 'night' : partMatch[1]) : null;
  if (partMatch) consumed.push(partMatch[0]);

  let day = null;
  let range = null;
  let m;
  if (use(/\blast night\b/)) { day = dayStart(today, -1); part = 'night'; }
  else if (use(/\b(?:the )?day before yesterday\b/)) day = dayStart(today, -2);
  else if (use(/\byesterday\b/)) day = dayStart(today, -1);
  else if (use(/\btoday\b|\bthis (?:morning|afternoon|evening)\b|\btonight\b/)) day = today;
  else if ((m = use(/\b(\d{1,2}|one|two|three|four|five|six|seven)\s+days?\s+ago\b/))) day = dayStart(today, -num(m[1]));
  else if (use(/\b(?:past|last)\s+(?:7|seven)\s+days\b|\b(?:this\s+)?past\s+week\b/)) range = { start: dayStart(today, -7), end: now, label: 'In the past week' };
  else if (use(/\bthis week\b/)) range = { start: dayStart(today, -((today.getDay() + 6) % 7)), end: now, label: 'This week' };
  else if (use(/\blast week\b/)) {
    const monday = dayStart(today, -((today.getDay() + 6) % 7));
    range = { start: dayStart(monday, -7), end: monday, label: 'Last week' };
  } else if (use(/\bthis month\b/)) range = { start: new Date(today.getFullYear(), today.getMonth(), 1), end: now, label: 'This month' };
  else if (use(/\blast month\b/)) range = { start: new Date(today.getFullYear(), today.getMonth() - 1, 1), end: new Date(today.getFullYear(), today.getMonth(), 1), label: 'Last month' };
  else if ((m = use(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(' + MONTH_RE + ')\\b')))) day = pastDate(+m[1], m[2], now);
  else if ((m = use(new RegExp('\\b(' + MONTH_RE + ')\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b')))) day = pastDate(+m[2], m[1], now);
  else if ((m = use(/\b(?:(on|last|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b|\b(on|last|this)\s+(sun|mon|tues?|wed|thu|thurs?|fri|sat)\b/))) {
    const word = m[2] || m[4];
    const back = (today.getDay() - WEEKDAY_INDEX[word] + 7) % 7;
    const isThis = (m[1] || m[3]) === 'this';
    day = dayStart(today, back === 0 && !isThis ? -7 : -back); // "Thursday" said on a Thursday means last week's
  }

  if (range) {
    return { start: range.start, end: range.end, label: range.label, singleDay: false, hourPart: part, consumed };
  }
  if (day) {
    const bounds = part
      ? { start: new Date(day.getFullYear(), day.getMonth(), day.getDate(), PART_HOURS[part][0]), end: new Date(day.getFullYear(), day.getMonth(), day.getDate(), PART_HOURS[part][1]) }
      : { start: day, end: dayStart(day, 1) };
    return { ...bounds, label: windowLabel(day, part, now), singleDay: true, hourPart: null, consumed };
  }
  if (part) {
    // "what was I watching at night" with no day: any night in the last 30 days
    return { start: dayStart(today, -30), end: now, label: part === 'night' ? 'At night' : 'In the ' + part, singleDay: false, hourPart: part, consumed };
  }
  return null;
}

function pastDate(dayNum, monthWord, now) {
  const month = MONTHS.findIndex((mm) => monthWord.startsWith(mm.toLowerCase()));
  let d = new Date(now.getFullYear(), month, dayNum);
  if (d.getMonth() !== month) return null;
  if (d > now) d = new Date(now.getFullYear() - 1, month, dayNum);
  return d;
}

function inHourPart(d, part) {
  if (!part) return true;
  const hr = d.getHours();
  const [a, b] = PART_HOURS[part];
  return b > 24 ? hr >= a || hr < b - 24 : hr >= a && hr < b;
}

// Sites people name. `words` are matched as whole words anywhere in the question.
const SITES = [
  { words: ['wikipedia', 'wiki'], label: 'Wikipedia', hosts: ['wikipedia.org'] },
  { words: ['youtube', 'yt'], label: 'YouTube', hosts: ['youtube.com', 'youtu.be'] },
  { words: ['google'], label: 'Google', hosts: ['google.com', 'google.co.in'] },
  { words: ['github'], label: 'GitHub', hosts: ['github.com', 'github.io'] },
  { words: ['reddit'], label: 'Reddit', hosts: ['reddit.com'] },
  { words: ['linkedin'], label: 'LinkedIn', hosts: ['linkedin.com'] },
  { words: ['twitter'], label: 'Twitter', hosts: ['twitter.com', 'x.com'] },
  { words: ['facebook'], label: 'Facebook', hosts: ['facebook.com'] },
  { words: ['instagram', 'insta'], label: 'Instagram', hosts: ['instagram.com'] },
  { words: ['amazon'], label: 'Amazon', hosts: ['amazon.in', 'amazon.com'] },
  { words: ['flipkart'], label: 'Flipkart', hosts: ['flipkart.com'] },
  { words: ['stackoverflow'], label: 'Stack Overflow', hosts: ['stackoverflow.com'] },
  { words: ['quora'], label: 'Quora', hosts: ['quora.com'] },
  { words: ['medium'], label: 'Medium', hosts: ['medium.com'] },
  { words: ['netflix'], label: 'Netflix', hosts: ['netflix.com'] },
  { words: ['chatgpt'], label: 'ChatGPT', hosts: ['chatgpt.com', 'openai.com'] },
  { words: ['cricinfo', 'espncricinfo'], label: 'ESPNcricinfo', hosts: ['espncricinfo.com'] },
];
const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'netflix.com', 'hotstar.com', 'primevideo.com', 'vimeo.com', 'twitch.tv', 'jiocinema.com'];
const SEARCH_PAGE = /\/\/(?:www\.)?(?:google|bing|duckduckgo|yahoo|ecosia|search\.brave)\.[a-z.]+\/(?:search|\?q=)/i;

// Hosts actually present in memory, so "on moneycontrol" works for any site you've visited.
let hostCache = { key: '', hosts: [] };
function knownHosts() {
  const k = db.prepare('SELECT COUNT(*) AS n, MAX(id) AS m, MAX(last_updated) AS t FROM records WHERE is_sensitive = 0').get();
  const key = `${k.n}|${k.m}|${k.t}`;
  if (key === hostCache.key) return hostCache.hosts;
  const set = new Set();
  for (const row of db.prepare("SELECT substr(content, 1, 400) AS head FROM records WHERE is_sensitive = 0 AND content LIKE 'Source:%'").iterate()) {
    const m = row.head.match(/^Source:\s*(https?:\/\/\S+)/i);
    const host = m ? hostOf(m[1]) : '';
    if (host) set.add(host);
  }
  hostCache = { key, hosts: [...set] };
  return hostCache.hosts;
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; }
}

function detectSites(nq) {
  const found = [];
  for (const s of SITES) {
    const w = s.words.find((word) => new RegExp('\\b' + word + '\\b').test(nq));
    if (w) found.push({ label: s.label, hosts: s.hosts, word: w });
  }
  // A site named by its own domain word, but only in site-like phrasing ("on moneycontrol",
  // "the digit article") so a plain word in the question is never mistaken for a site.
  for (const host of knownHosts()) {
    const labels = host.split('.');
    let main = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    if (['co', 'com', 'org', 'gov', 'ac', 'net'].includes(main) && labels.length >= 3) main = labels[labels.length - 3];
    if (main.length < 3 || found.some((f) => f.word === main)) continue;
    const re = new RegExp(`\\b(?:on|from|at)\\s+${main}\\b|\\b${main}\\s+(?:article|page|site|website|video|post|blog)s?\\b`);
    if (re.test(nq)) found.push({ label: host, hosts: [host], word: main });
  }
  return found;
}

const KIND_WORDS = {
  file: /\b(files?|pdfs?|docx?|docs|documents?|attachments?|assignments?|resume|cv|spreadsheets?|slides|ppts?)\b/,
  email: /\b(e ?mails?|mails?|gmail|inbox)\b/,
  form: /\bforms?\b/,
  video: /\b(videos?|watch|watched|watching)\b/,
  page: /\b(articles?|pages?|websites?|sites?|posts?|blogs?)\b/,
};

const STOP = new Set(('a an the and or but of to in on at for from with about by into as it its this that these those ' +
  'there here what which who whom whose where when why how whats wheres whens hows i me my mine im ive id you your we our ' +
  'us he she they them their can could would should will shall may might must please any some all thing things stuff ' +
  'something anything everything one ones kind sort again ago than then so if do does did done doing is are was were am ' +
  'be been being have has had get got go went show tell give list find found open opened see saw seen look looked looking ' +
  'read reading watch watched watching visit visited visiting check checked checking browse browsed browsing save saved ' +
  'saving download downloaded remember recall know last latest most recent recently newest just previous before after ' +
  'summarize summarise summary tldr file files pdf pdfs doc docs document documents attachment attachments email emails ' +
  'mail mails gmail inbox page pages article articles site sites website websites video videos post posts blog blogs ' +
  'form forms tab tabs link links').split(' '));

function wordsOf(text) {
  return String(text).split(' ').filter(Boolean);
}

function topicOf(text, extraSkip) {
  const skip = new Set(extraSkip || []);
  return wordsOf(text).filter((w) => !STOP.has(w) && !skip.has(w) && (w.length > 1 || /\d/.test(w)));
}

function parseCount(nq) {
  const m = nq.match(/\b(?:last|latest|recent|newest|most recent)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/) ||
    nq.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:most recent\s+|recent\s+|last\s+|latest\s+|newest\s+)?(?:files?|pdfs?|docs?|documents?|attachments?|e ?mails?|mails?|pages?|articles?|videos?|sites?|websites?|things?|forms?)\b/);
  if (!m) return null;
  const n = num(m[1]);
  return Number.isFinite(n) ? { n: Math.min(Math.max(n, 1), 10), text: m[1] } : null;
}

function parseQuestion(raw, now) {
  const nq = normalize(raw);
  const win = parseWindow(nq, now);
  let rest = nq;
  for (const c of win ? win.consumed : []) rest = rest.replace(c, ' ');
  rest = rest.replace(/\s+/g, ' ').trim();

  const count = parseCount(rest);
  const kinds = new Set(Object.keys(KIND_WORDS).filter((k) => KIND_WORDS[k].test(rest)));
  const sites = detectSites(rest);
  const siteWords = sites.map((s) => s.word);
  const skip = [...siteWords];
  if (count) skip.push(count.text);
  const topicWords = topicOf(rest, skip);

  return {
    nq,
    window: win,
    recency: /\b(last|latest|most recent|newest|recent|recently|just|previous)\b/.test(rest),
    count: count ? count.n : null,
    kinds,
    pdfOnly: /\bpdfs?\b/.test(rest),
    articleWord: /\barticles?\b/.test(rest),
    sites,
    topicWords,
    topic: topicWords.join(' '),
    summarize: /\b(summar(y|ize|ise)|tl ?dr)\b/.test(nq),
    wantsSearch: /\b(search|searched|google|googled)\b/.test(nq),
    timeOrder: parseTimeOrder(nq),
  };
}

// "what did i read before hardik pandya", "the page after the elon musk article on wikipedia"
function parseTimeOrder(nq) {
  const m = nq.match(/^(.*?)\b(before|after)\b\s+(.+)$/);
  if (!m) return null;
  if (/\bday\s*$/.test(m[1])) return null; // "the day before yesterday" is a time window
  if (/^(\d|noon|midnight|lunch|dinner|breakfast|that\b|this\b|it\b|then\b|now\b)/.test(m[3])) return null;
  const anchorSites = detectSites(m[3]);
  const anchorTopic = topicOf(m[3], anchorSites.map((s) => s.word));
  if (anchorTopic.length === 0) return null;
  const head = m[1];
  const headKinds = new Set(Object.keys(KIND_WORDS).filter((k) => KIND_WORDS[k].test(head)));
  return {
    dir: m[2],
    anchorText: m[3],
    anchorTopic: anchorTopic.join(' '),
    anchorSites,
    headSites: detectSites(head),
    headKinds,
  };
}

// ---------------------------------------------------------------------------
// Record helpers
// ---------------------------------------------------------------------------
function getRecord(id) {
  return db.prepare('SELECT id, form_name, category, content, is_sensitive, last_updated FROM records WHERE id = ?').get(id);
}

function recordKind(rec) {
  const name = String(rec.form_name || '');
  if (/^file:/i.test(name)) return 'file';
  if (/^email:/i.test(name)) return 'email';
  if (/^form:/i.test(name)) return 'form';
  const host = hostOf(h.recordUrl(rec));
  if (host && VIDEO_HOSTS.some((v) => host === v || host.endsWith('.' + v))) return 'video';
  return host ? 'page' : 'note';
}

function displayTitle(rec) {
  const name = String(rec.form_name || '');
  if (/^file:/i.test(name)) return h.attachmentDisplayName(name);
  if (/^email:/i.test(name)) return name.replace(/^email:\s*/i, '').replace(/\s*\([0-9a-f]{8,}\)$/i, '').trim();
  if (/^form:/i.test(name)) return 'Form on ' + (hostOf(h.recordUrl(rec)) || name.replace(/^form:\s*/i, '').replace(/\s*\(.*\)$/, ''));
  return h.recordTitle(rec).replace(/\s*\((?:[a-z0-9-]+\.)+[a-z]{2,}\)\s*$/i, '').trim();
}

function siteOf(rec) {
  const kind = recordKind(rec);
  if (kind === 'file') return 'Saved file';
  if (kind === 'email') return 'Gmail';
  return hostOf(h.recordUrl(rec));
}

function snippetOf(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function makeSource(n, rec, atDate, text, now) {
  return {
    n,
    id: rec.id,
    title: displayTitle(rec),
    urlOrPath: recordKind(rec) === 'file' ? h.filePathFor(rec) : h.recordUrl(rec),
    site: siteOf(rec),
    category: rec.category || '',
    when: atDate ? when(atDate, now) : '',
    snippet: snippetOf(text !== undefined ? text : h.recordBody(rec)),
  };
}

// Builds the response. Every field /api/ask has always returned is kept; sources and route are new.
function found({ route, kind, answer, sources, primary, label }) {
  return {
    found: true,
    kind,
    source: 'memory',
    source_label: label,
    title: primary ? h.recordTitle(primary) : '',
    answer,
    source_url: primary ? h.recordUrl(primary) : '',
    form_name: primary ? primary.form_name : '',
    last_updated: primary ? primary.last_updated : '',
    sources,
    route,
  };
}

function notFound(route, message) {
  return { found: false, message: message || NOT_FOUND, sources: [], route };
}

// ---------------------------------------------------------------------------
// SQL filters over `records r` (sites, kinds). Vault rows are excluded by the callers.
// ---------------------------------------------------------------------------
function recordFilter({ kinds, pdfOnly, sites, videoOnly }) {
  const parts = ["r.form_name NOT LIKE 'weekly-digest-%'", "(r.category IS NULL OR r.category != 'Digest')"];
  const params = [];
  const hostClause = (hosts) => '(' + hosts.map(() => '(r.content LIKE ? OR r.content LIKE ?)').join(' OR ') + ')';
  const hostParams = (hosts) => hosts.flatMap((s) => [`Source: http%://${s}/%`, `Source: http%://%.${s}/%`]);

  const kindSql = [];
  if (kinds && kinds.has('file')) kindSql.push("r.form_name LIKE 'File:%'" + (pdfOnly ? " AND r.form_name LIKE '%.pdf'" : ''));
  if (kinds && kinds.has('email')) kindSql.push("r.form_name LIKE 'Email:%'");
  if (kinds && kinds.has('form')) kindSql.push("r.form_name LIKE 'Form:%'");
  if (kinds && kinds.has('page')) kindSql.push("(r.content LIKE 'Source: http%' AND r.form_name NOT LIKE 'Form:%')");
  if (kindSql.length) parts.push('(' + kindSql.join(' OR ') + ')');

  if (sites && sites.length) {
    const hosts = sites.flatMap((s) => s.hosts);
    parts.push(hostClause(hosts));
    params.push(...hostParams(hosts));
  }
  if (videoOnly) {
    parts.push(hostClause(VIDEO_HOSTS));
    params.push(...hostParams(VIDEO_HOSTS));
  }
  return { sql: parts.join(' AND '), params };
}

// Save events, newest first, one per record (its latest event in range). Vault records have no
// events; when the vault is unlocked they are included by their last_updated instead, and never
// stored anywhere.
function timeline({ filter, start, end, hourPart, unlocked, excludeSearch, limit = 1000 }) {
  const range = [];
  let rangeSql = '';
  if (start) { rangeSql += ' AND e.at >= ?'; range.push(sqlUtc(start)); }
  if (end) { rangeSql += ' AND e.at < ?'; range.push(sqlUtc(end)); }
  const rows = db.prepare(`
    SELECT e.id AS eventId, e.record_id AS id, e.at AS at
    FROM record_events e JOIN records r ON r.id = e.record_id
    WHERE r.is_sensitive = 0 AND ${filter.sql} ${rangeSql}
    ORDER BY e.at DESC, e.id DESC LIMIT ?
  `).all(...filter.params, ...range, limit);

  if (unlocked) {
    const vRange = rangeSql.replace(/e\.at/g, 'r.last_updated');
    const vault = db.prepare(`
      SELECT 0 AS eventId, r.id AS id, r.last_updated AS at FROM records r
      WHERE r.is_sensitive = 1 AND ${filter.sql} ${vRange}
    `).all(...filter.params, ...range);
    rows.push(...vault);
    rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.eventId - a.eventId));
  }

  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    const atDate = parseUtc(row.at);
    if (!atDate || !inHourPart(atDate, hourPart)) continue;
    const rec = getRecord(row.id);
    if (!rec) continue;
    if (excludeSearch && SEARCH_PAGE.test(h.recordUrl(rec))) continue;
    seen.add(row.id);
    out.push({ rec, at: atDate, eventId: row.eventId });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hybrid search: vector + FTS5 keyword, merged with Reciprocal Rank Fusion (k = 60), best chunk
// per record, top TOP_K. A record only counts if its vector similarity clears RELEVANCE_FLOOR or
// its keyword match covers enough of the topic words - otherwise it's not a match at all.
// ---------------------------------------------------------------------------
function stemLite(w) {
  if (w.length > 5) return w.replace(/(ing|ed|es|s)$/, '');
  if (w.length > 3) return w.replace(/s$/, '');
  return w;
}

function coverage(text, terms) {
  const hay = String(text || '').toLowerCase();
  return terms.filter((t) => new RegExp('(^|[^a-z0-9])' + stemLite(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(hay)).length;
}

function neededTerms(n) {
  return n <= 2 ? n : Math.ceil(n * 0.6);
}

async function hybrid(queryText, topicText, filter, { unlocked = false, k = CONFIG.TOP_K, queryVector, penalizeSearch = false } = {}) {
  const terms = topicOf(normalize(topicText));
  const qvec = queryVector !== undefined ? queryVector : await searchIndex.embedQuery(queryText);
  const vec = qvec ? searchIndex.vectorSearch(qvec, { limit: 40, where: filter.sql, params: filter.params }) : [];
  const kw = terms.length ? searchIndex.keywordSearch(terms.join(' '), { limit: 40, where: filter.sql, params: filter.params }) : [];

  const chunks = new Map();
  const touch = (chunkId, recordId) => {
    if (!chunks.has(chunkId)) chunks.set(chunkId, { chunkId, recordId, rrf: 0, sim: null, cov: 0 });
    return chunks.get(chunkId);
  };
  vec.forEach((r, i) => { const c = touch(r.chunkId, r.recordId); c.rrf += 1 / (RRF_K + i + 1); c.sim = 1 - r.distance; });
  kw.forEach((r, i) => {
    const c = touch(r.chunkId, r.recordId);
    c.rrf += 1 / (RRF_K + i + 1);
    c.cov = coverage(searchIndex.chunkText(r.chunkId), terms);
  });

  const records = new Map();
  for (const c of chunks.values()) {
    const cur = records.get(c.recordId) || { recordId: c.recordId, best: null, sim: null, cov: 0 };
    if (!cur.best || c.rrf > cur.best.rrf) cur.best = c;
    if (c.sim !== null && (cur.sim === null || c.sim > cur.sim)) cur.sim = c.sim;
    cur.cov = Math.max(cur.cov, c.cov);
    records.set(c.recordId, cur);
  }

  // Unlocked vault: a live keyword scan over vault records, held in memory for this answer only.
  if (unlocked && terms.length) {
    const vaultRows = db.prepare(`SELECT r.id, r.form_name, r.content FROM records r WHERE r.is_sensitive = 1 AND ${filter.sql}`).all(...filter.params);
    const hits = vaultRows
      .map((r) => ({ r, cov: coverage(r.form_name + '\n' + r.content, terms) }))
      .filter((x) => x.cov > 0)
      .sort((a, b) => b.cov - a.cov);
    hits.forEach((x, i) => {
      records.set(x.r.id, { recordId: x.r.id, best: { chunkId: null, rrf: 1 / (RRF_K + i + 1), text: vaultWindow(x.r, terms) }, sim: null, cov: x.cov });
    });
  }

  // A search-results page only lists snippets of other pages; when the real page matches too,
  // it should win. (Unless the question is about searches.)
  if (penalizeSearch) {
    for (const r of records.values()) {
      const rec = getRecord(r.recordId);
      if (rec && SEARCH_PAGE.test(h.recordUrl(rec))) r.best = { ...r.best, rrf: r.best.rrf * 0.5 };
    }
  }

  const need = neededTerms(terms.length);
  const ranked = [...records.values()]
    .map((r) => ({ ...r, strong: (r.sim !== null && r.sim >= CONFIG.RELEVANCE_FLOOR) || (terms.length > 0 && r.cov >= need) }))
    .sort((a, b) => b.best.rrf - a.best.rrf);
  const kept = ranked.filter((r) => r.strong).slice(0, k);

  return {
    results: kept.map((r) => ({ recordId: r.recordId, chunkId: r.best.chunkId, text: r.best.text || searchIndex.chunkText(r.best.chunkId), sim: r.sim, cov: r.cov, fullCov: terms.length > 0 && r.cov === terms.length })),
    topSim: ranked.reduce((m, r) => (r.sim !== null && r.sim > m ? r.sim : m), -1),
    topCov: ranked.reduce((m, r) => Math.max(m, r.cov), 0),
    terms: terms.length,
    usedVector: !!qvec,
  };
}

function vaultWindow(rec, terms) {
  const body = String(rec.content || '');
  const lower = body.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(stemLite(t))).filter((i) => i >= 0);
  const start = Math.max(0, (hits.length ? Math.min(...hits) : 0) - 400);
  return displayTitle(rec) + '\n' + body.slice(start, start + 1200);
}

function latestEventAt(recordId, fallback) {
  const row = db.prepare('SELECT at FROM record_events WHERE record_id = ? ORDER BY at DESC, id DESC LIMIT 1').get(recordId);
  return parseUtc(row ? row.at : fallback);
}

// ---------------------------------------------------------------------------
// Warm wording for answers built straight from the data (no LLM, no added time). Each template has
// a few phrasings that rotate; every phrasing states exactly the same facts, titles, times and [n]
// citations - only the words around them change (scripts/eval-ask.js checks that). Casual records
// (food, music, videos, sports, ...) may get a lightly playful phrasing; files, email, forms and
// anything sensitive (health, money, personal) always get a crisp one. Titles stay in double quotes,
// and in time-order answers the neighbour's title is always the LAST quote, because that is what
// "and before that?" follows.
// ---------------------------------------------------------------------------
const CASUAL_CATEGORY = /(food|recipe|cook|music|song|singer|entertain|movie|film|video|comedy|comedian|sport|cricket|football|game|travel|celebrit|social|fun)/i;
const SENSITIVE_CATEGORY = /(health|medical|doctor|finance|money|bank|bill|insurance|loan|tax|legal|personal|private|relationship|grief)/i;

function tone(rec) {
  const kind = recordKind(rec);
  if (kind === 'file' || kind === 'email' || kind === 'form') return 'crisp';
  const cat = String(rec.category || '');
  if (SENSITIVE_CATEGORY.test(cat)) return 'crisp';
  return kind === 'video' || CASUAL_CATEGORY.test(cat) ? 'playful' : 'crisp';
}

const PHRASES = {
  before: {
    crisp: [
      (p) => `Right before "${p.a}", ${p.aw}, you were ${p.ing} "${p.n}" ${p.nt} [1].`,
      (p) => `Just before "${p.a}" ${p.aw}, you were ${p.ing} "${p.n}" ${p.nt} [1].`,
      (p) => `Just before you got to "${p.a}" ${p.aw}, you were ${p.ing} "${p.n}" ${p.nt} [1].`,
    ],
    playful: [
      (p) => `Rewinding a little: just before "${p.a}" ${p.aw}, you were ${p.ing} "${p.n}" ${p.nt} [1].`,
      (p) => `One step back from "${p.a}" ${p.aw}: you were ${p.ing} "${p.n}" ${p.nt} [1].`,
      (p) => `Before "${p.a}" took over ${p.aw}, you were ${p.ing} "${p.n}" ${p.nt} [1].`,
    ],
  },
  after: {
    crisp: [
      (p) => `Right after "${p.a}", ${p.aw}, you ${p.past} "${p.n}" ${p.nt} [1].`,
      (p) => `Just after "${p.a}" ${p.aw}, you ${p.past} "${p.n}" ${p.nt} [1].`,
      (p) => `Next after "${p.a}" ${p.aw}, you ${p.past} "${p.n}" ${p.nt} [1].`,
    ],
    playful: [
      (p) => `Right after "${p.a}" ${p.aw}, you moved on and ${p.past} "${p.n}" ${p.nt} [1].`,
      (p) => `Fast-forward from "${p.a}" ${p.aw}: next you ${p.past} "${p.n}" ${p.nt} [1].`,
      (p) => `Straight after "${p.a}" ${p.aw}, you ${p.past} "${p.n}" ${p.nt} [1].`,
    ],
  },
  nothingAround: {
    crisp: [
      (p) => `I don't have anything saved ${p.dir} "${p.a}", ${p.aw}.`,
      (p) => `Nothing in your memory comes ${p.dir} "${p.a}", ${p.aw}.`,
      (p) => `"${p.a}", ${p.aw}, is as far as your memory goes: nothing saved ${p.dir} it.`,
    ],
  },
  latest: {
    crisp: [
      (p) => `The most recent ${p.sl}${p.noun} you ${p.verb} was "${p.t}", ${p.w} [1].`,
      (p) => `Most recently, you ${p.verb} the ${p.sl}${p.noun} "${p.t}" ${p.wp} [1].`,
      (p) => `Your latest ${p.sl}${p.noun}: "${p.t}", ${p.verb} ${p.wp} [1].`,
    ],
    playful: [
      (p) => `Freshest in your memory: the ${p.sl}${p.noun} "${p.t}", which you ${p.verb} ${p.wp} [1].`,
      (p) => `Most recently, you ${p.verb} the ${p.sl}${p.noun} "${p.t}" ${p.wp} [1].`,
      (p) => `Top of the pile: the ${p.sl}${p.noun} "${p.t}", ${p.verb} ${p.wp} [1].`,
    ],
  },
  onlyOne: {
    crisp: [
      (p) => `You have only one ${p.sl}${p.noun} saved: "${p.t}", ${p.w} [1].`,
      (p) => `There's just one ${p.sl}${p.noun} in your memory so far: "${p.t}", ${p.w} [1].`,
      (p) => `Only one ${p.sl}${p.noun} saved right now: "${p.t}", ${p.w} [1].`,
    ],
  },
  lastN: {
    crisp: [
      (p) => `Your last ${p.count} ${p.sl}${p.nouns}:`,
      (p) => `Here are your last ${p.count} ${p.sl}${p.nouns}, newest first:`,
      (p) => `Your ${p.count} most recent ${p.sl}${p.nouns}:`,
    ],
  },
  onlyN: {
    crisp: [
      (p) => `You have only ${p.count} ${p.sl}${p.nouns} saved:`,
      (p) => `There are just ${p.count} ${p.sl}${p.nouns} in your memory so far:`,
      (p) => `Only ${p.count} ${p.sl}${p.nouns} saved right now:`,
    ],
  },
  recentList: {
    crisp: [
      (p) => `Your recent ${p.sl}${p.nouns}:`,
      (p) => `Here are your recent ${p.sl}${p.nouns}, newest first:`,
      (p) => `Your most recent ${p.sl}${p.nouns}:`,
    ],
  },
  windowOne: {
    crisp: [
      (p) => `${p.label} you ${p.verb} "${p.t}" ${p.at} [1].`,
      (p) => `${p.label}, you ${p.verb} "${p.t}" ${p.at} [1].`,
      (p) => `You ${p.verb} "${p.t}" ${p.at}, ${p.labelLower} [1].`,
    ],
    playful: [
      (p) => `Found it. ${p.label} you ${p.verb} "${p.t}" ${p.at} [1].`,
      (p) => `Easy one: ${p.labelLower}, you ${p.verb} "${p.t}" ${p.at} [1].`,
      (p) => `Got it. ${p.label}, you ${p.verb} "${p.t}" ${p.at} [1].`,
    ],
  },
  windowList: {
    crisp: [
      (p) => `${p.label} you ${p.verb} ${p.count} ${p.nouns}:`,
      (p) => `${p.label}, you ${p.verb} ${p.count} ${p.nouns}:`,
      (p) => `${p.count} ${p.nouns} ${p.verb} ${p.labelLower}:`,
    ],
    playful: [
      (p) => `Here's the rundown. ${p.label} you ${p.verb} ${p.count} ${p.nouns}:`,
      (p) => `${p.label}, you ${p.verb} ${p.count} ${p.nouns}:`,
      (p) => `Quick recap: ${p.labelLower}, you ${p.verb} ${p.count} ${p.nouns}:`,
    ],
  },
  file: {
    crisp: [
      (p) => `I found "${p.t}" in your saved files, saved ${p.wp} [1].`,
      (p) => `"${p.t}" is in your saved files, saved ${p.wp} [1].`,
      (p) => `Here it is: "${p.t}", saved ${p.wp} [1].`,
    ],
  },
  fileOthers: {
    crisp: [
      (p) => ` Other matches: ${p.list}.`,
      (p) => ` Also close: ${p.list}.`,
      (p) => ` You might also mean ${p.list}.`,
    ],
  },
  provenance: {
    crisp: [
      (p) => `You saw this ${p.where} ${p.wp} [${p.n}].`,
      (p) => `That's from ${p.from}, ${p.wp} [${p.n}].`,
      (p) => `You came across this ${p.where} ${p.wp} [${p.n}].`,
      (p) => `Source: ${p.from}, ${p.wp} [${p.n}].`,
    ],
  },
};

const rotation = new Map();
function say(key, toneName, params) {
  const set = PHRASES[key][toneName] || PHRASES[key].crisp;
  const slot = key + ':' + (PHRASES[key][toneName] ? toneName : 'crisp');
  const i = rotation.get(slot) || 0;
  rotation.set(slot, i + 1);
  return set[i % set.length](params);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
function verbs(kind) {
  if (kind === 'video') return { ing: 'watching', past: 'watched' };
  if (kind === 'email') return { ing: 'reading the email', past: 'read the email' };
  if (kind === 'file') return { ing: 'saving the file', past: 'saved the file' };
  if (kind === 'form') return { ing: 'filling in a', past: 'filled in a' };
  return { ing: 'reading', past: 'read' };
}

// Time order: the anchor ("hardik pandya") by hybrid search, then the save event right before or
// after it. Straight from the data, no LLM.
async function timeOrderRoute(p, ctx) {
  const t = p.timeOrder;
  const anchorFilter = recordFilter({ sites: t.anchorSites });
  const search = await hybrid(t.anchorText, t.anchorTopic, anchorFilter, { k: 1 });
  ctx.scores.push(`anchor sim=${fmt(search.topSim)} kw=${search.topCov}/${search.terms}`);
  if (!search.results.length) return null;

  const anchor = getRecord(search.results[0].recordId);
  const ev = db.prepare('SELECT id, at FROM record_events WHERE record_id = ? ORDER BY at DESC, id DESC LIMIT 1').get(anchor.id);
  if (!ev) return null;
  const anchorAt = parseUtc(ev.at);

  const kinds = t.headKinds.size ? t.headKinds : null;
  const filter = recordFilter({ kinds, sites: t.headSites, videoOnly: t.headKinds.has('video') && !t.headKinds.has('page') });
  const before = t.dir === 'before';
  const rows = db.prepare(`
    SELECT e.id, e.record_id AS recordId, e.at FROM record_events e JOIN records r ON r.id = e.record_id
    WHERE r.is_sensitive = 0 AND r.form_name NOT LIKE 'Form:%' AND e.record_id != ? AND ${filter.sql}
      AND ${before ? '(e.at < ? OR (e.at = ? AND e.id < ?))' : '(e.at > ? OR (e.at = ? AND e.id > ?))'}
    ORDER BY e.at ${before ? 'DESC' : 'ASC'}, e.id ${before ? 'DESC' : 'ASC'} LIMIT 50
  `).all(anchor.id, ...filter.params, ev.at, ev.at, ev.id);

  let neighbour = null;
  for (const row of rows) {
    const rec = getRecord(row.recordId);
    if (!rec) continue;
    if (!p.wantsSearch && SEARCH_PAGE.test(h.recordUrl(rec))) continue; // a results page isn't something you "read"
    neighbour = { rec, at: parseUtc(row.at) };
    break;
  }

  const now = ctx.now;
  const anchorTitle = displayTitle(anchor);
  const anchorSource = makeSource(2, anchor, anchorAt, undefined, now);
  if (!neighbour) {
    return {
      ...notFound('time-order', say('nothingAround', 'crisp', { dir: t.dir, a: anchorTitle, aw: whenPhrase(when(anchorAt, now)) })),
      sources: [{ ...anchorSource, n: 1 }],
    };
  }
  const v = verbs(recordKind(neighbour.rec));
  const nTime = daysBetween(neighbour.at, anchorAt) === 0 ? 'at ' + clock(neighbour.at) : whenPhrase(when(neighbour.at, now));
  const answer = say(before ? 'before' : 'after', tone(neighbour.rec), {
    a: anchorTitle, aw: whenPhrase(when(anchorAt, now)), n: displayTitle(neighbour.rec), nt: nTime, ing: v.ing, past: v.past,
  });
  return found({
    route: 'time-order',
    kind: 'sequence',
    answer,
    sources: [makeSource(1, neighbour.rec, neighbour.at, undefined, now), anchorSource],
    primary: neighbour.rec,
    label: `From your memory: ${displayTitle(neighbour.rec)}, ${when(neighbour.at, now)}`,
  });
}

function nounFor(kinds, p, items) {
  const all = (k) => items.length > 0 && items.every((x) => recordKind(x.rec) === k);
  if (p.pdfOnly) return ['PDF', 'PDFs'];
  if (kinds.has('file') || all('file')) return ['file', 'files'];
  if (kinds.has('email') || all('email')) return ['email', 'emails'];
  if (kinds.has('video') || all('video')) return ['video', 'videos'];
  if (kinds.has('form') || all('form')) return ['form', 'forms'];
  if (p.articleWord) return ['article', 'articles'];
  if (kinds.has('page') || all('page')) return ['page', 'pages'];
  return ['thing', 'things'];
}

function pastVerb(noun) {
  if (noun === 'video') return 'watched';
  if (noun === 'page' || noun === 'article') return 'read';
  return 'saved';
}

// Recency, time windows, "my files", "on YouTube": straight from the save log, no LLM.
async function listRoute(p, ctx) {
  const now = ctx.now;
  const w = p.window;
  const activityWatch = p.kinds.has('video');
  const kinds = new Set([...p.kinds].filter((k) => k !== 'video'));
  const filter = recordFilter({ kinds, pdfOnly: p.pdfOnly, sites: p.sites });
  const readingQuestion = !p.wantsSearch && (kinds.has('page') || /\bread\b/.test(p.nq) || p.recency);
  let items = timeline({
    filter,
    start: w ? w.start : null,
    end: w ? w.end : null,
    hourPart: w ? w.hourPart : null,
    unlocked: ctx.unlocked,
    excludeSearch: readingQuestion,
  });

  // "what was I watching": prefer videos when there are any.
  if (activityWatch) {
    const videos = items.filter((x) => recordKind(x.rec) === 'video');
    if (videos.length) items = videos;
  }

  // "the latest article about X": only records that are actually about X.
  if (p.topicWords.length) {
    const search = await hybrid(p.nq, p.topic, filter, { unlocked: ctx.unlocked, k: 50 });
    ctx.scores.push(`topic sim=${fmt(search.topSim)} kw=${search.topCov}/${search.terms}`);
    const ok = new Set(search.results.map((r) => r.recordId));
    items = items.filter((x) => ok.has(x.rec.id));
  }
  if (!items.length) return null;

  const [noun, nouns] = nounFor(kinds.size ? kinds : (activityWatch ? new Set(['video']) : kinds), p, items);
  const siteLabel = p.sites.length === 1 ? p.sites[0].label + ' ' : '';
  const verb = pastVerb(noun);

  // Recency: newest first. A single one reads as a sentence, several as a numbered list.
  if (p.recency || !w) {
    const want = p.count || (p.recency ? 1 : 5);
    const shown = items.slice(0, want);
    const sources = shown.map((x, i) => makeSource(i + 1, x.rec, x.at, undefined, now));
    let answer;
    if (shown.length === 1 && want === 1) {
      const x = shown[0];
      const w1 = when(x.at, now);
      answer = say('latest', tone(x.rec), { sl: siteLabel, noun, verb, t: displayTitle(x.rec), w: w1, wp: whenPhrase(w1) });
      if (p.summarize) {
        const summary = await h.summarizeRecord(x.rec);
        if (summary) answer += '\n\n' + summary;
      }
    } else if (shown.length === 1) {
      // Asked for several, but there is only one: say so rather than "Your last 1 file".
      const x = shown[0];
      answer = say('onlyOne', 'crisp', { sl: siteLabel, noun, t: displayTitle(x.rec), w: when(x.at, now) });
    } else {
      const counts = { count: shown.length, sl: siteLabel, nouns };
      const header = want > 1
        ? say(shown.length < want ? 'onlyN' : 'lastN', 'crisp', counts)
        : say('recentList', 'crisp', counts);
      answer = header + '\n' + shown.map((x, i) => `${i + 1}. "${displayTitle(x.rec)}" – ${when(x.at, now)} [${i + 1}]`).join('\n');
    }
    return found({
      route: 'list:recency' + routeSuffix(p),
      kind: kinds.has('file') ? 'files_saved' : 'recent',
      answer,
      sources,
      primary: shown[0].rec,
      label: shown.length === 1
        ? `From your memory: ${displayTitle(shown[0].rec)}, ${when(shown[0].at, now)}`
        : `From your memory: ${shown.length} ${nouns}`,
    });
  }

  // Time window: in time order, as a short list with clock times.
  const inOrder = items.slice().reverse();
  const shown = inOrder.slice(0, 10);
  const stamp = (d) => (w.singleDay ? clock(d) : `${WEEKDAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${clock(d)}`);
  const sources = shown.map((x, i) => makeSource(i + 1, x.rec, x.at, undefined, now));
  let answer;
  const labelLower = w.label.charAt(0).toLowerCase() + w.label.slice(1);
  const allCasual = shown.every((x) => tone(x.rec) === 'playful');
  if (shown.length === 1) {
    const x = shown[0];
    answer = say('windowOne', tone(x.rec), {
      label: w.label, labelLower, verb, t: displayTitle(x.rec), at: w.singleDay ? 'at ' + clock(x.at) : whenPhrase(when(x.at, now)),
    });
  } else {
    answer = say('windowList', allCasual ? 'playful' : 'crisp', { label: w.label, labelLower, verb, count: inOrder.length, nouns }) + '\n' +
      shown.map((x, i) => `• ${stamp(x.at)} – "${displayTitle(x.rec)}" [${i + 1}]`).join('\n') +
      (inOrder.length > shown.length ? `\n…and ${inOrder.length - shown.length} more.` : '');
  }
  return found({
    route: 'list:time-window' + routeSuffix(p),
    kind: 'day',
    answer,
    sources,
    primary: shown[shown.length - 1].rec,
    label: `From your memory: ${inOrder.length} ${inOrder.length === 1 ? noun : nouns}, ${w.label.toLowerCase()}`,
  });
}

function routeSuffix(p) {
  return (p.sites.length ? '+site' : '') + (p.kinds.size ? '+' + [...p.kinds].join('+') : '');
}

// "Where's my Unit 3 assignment?": hybrid search over saved files only, answered from the data.
async function fileRoute(p, ctx) {
  const filter = recordFilter({ kinds: new Set(['file']), pdfOnly: p.pdfOnly });
  const search = await hybrid(p.nq, p.topic, filter, { unlocked: ctx.unlocked, k: 3 });
  ctx.scores.push(`file sim=${fmt(search.topSim)} kw=${search.topCov}/${search.terms}`);
  if (!search.results.length) return null;
  const now = ctx.now;
  const recs = search.results.map((r) => ({ rec: getRecord(r.recordId), text: r.text })).filter((x) => x.rec);
  const sources = recs.map((x, i) => makeSource(i + 1, x.rec, latestEventAt(x.rec.id, x.rec.last_updated), stripHeader(x.text), now));
  let answer = say('file', 'crisp', { t: sources[0].title, wp: whenPhrase(sources[0].when) });
  if (sources.length > 1) answer += say('fileOthers', 'crisp', { list: sources.slice(1).map((s) => `"${s.title}" [${s.n}]`).join(', ') });
  return found({
    route: 'file',
    kind: 'answer',
    answer,
    sources,
    primary: recs[0].rec,
    label: `From your memory: ${sources[0].title}, ${sources[0].when}`,
  });
}

function stripHeader(chunk) {
  const i = String(chunk || '').indexOf('\n');
  return i >= 0 ? chunk.slice(i + 1) : chunk;
}

// Everything else: hybrid retrieval, then the answer model writes 1-3 sentences from the numbered
// memories only.
async function hybridRoute(p, ctx, route, filter) {
  const search = await hybrid(ctx.question, p.topic, filter || recordFilter({}), { unlocked: ctx.unlocked, penalizeSearch: !p.wantsSearch });
  ctx.scores.push(`sim=${fmt(search.topSim)} kw=${search.topCov}/${search.terms}${search.usedVector ? '' : ' (keyword only)'}`);
  if (!search.results.length) return notFound(route);

  // Only memories nearly as relevant as the best one go to the model: a weaker extra rarely adds
  // anything but seconds (every chunk is ~300 prompt tokens on CPU) and a chance to wander.
  const bestSim = Math.max(...search.results.map((r) => (r.sim === null ? -1 : r.sim)));
  const close = search.results.filter((r, i) => i === 0 || r.fullCov || (r.sim !== null && r.sim >= bestSim - CONFIG.SIM_MARGIN));
  ctx.scores.push(`used=${close.length}/${search.results.length}`);

  const now = ctx.now;
  const recs = close.map((r) => ({ ...r, rec: getRecord(r.recordId) })).filter((x) => x.rec);
  const allSources = recs.map((x, i) => makeSource(i + 1, x.rec, latestEventAt(x.rec.id, x.rec.last_updated), stripHeader(x.text), now));
  const memories = fitToBudget(recs.map((x, i) => ({ source: allSources[i], rec: x.rec, text: stripHeader(x.text) })));
  const generated = await generateAnswer(ctx.question, memories, ctx.onToken);
  ctx.gen = generated;

  const given = memories.map((m) => m.source);
  if (!generated || generated.failed) {
    return found({
      route: route + ':model-unavailable',
      kind: 'answer',
      answer: "RaSh's AI engine isn't responding right now. Here are the closest matches.",
      sources: given,
      primary: memories[0].rec,
      label: `From your memory: ${given[0].title}, ${given[0].when}`,
    });
  }
  if (generated.notFound) return notFound(route);

  // Sources = the memories the answer actually cites (numbering unchanged, so [2] still means
  // source n = 2); if it cites none, every memory it was given.
  const cited = new Set([...generated.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  const citedSources = given.filter((s) => cited.has(s.n));
  const sources = citedSources.length ? citedSources : given;
  const primary = memories.find((m) => m.source.n === sources[0].n).rec;
  return found({
    route,
    kind: 'answer',
    answer: withProvenance(generated.text, sources),
    sources: sources.length ? sources : given,
    primary,
    label: `From your memory: ${(sources[0] || given[0]).title}, ${(sources[0] || given[0]).when}`,
  });
}

// ---------------------------------------------------------------------------
// Answer generation. Always has a timeout; returns { failed: true } instead of throwing, so the
// caller can still show the sources. With onToken (the streaming route), tokens are passed on as
// they arrive - except a leading "NOT_FOUND", which is held back so it never flashes on screen.
// ---------------------------------------------------------------------------
// Static, and sent first in every request, so Ollama can reuse its cached prefix. The examples are
// deliberately about things that aren't in any test fixture.
const SYSTEM_PROMPT = [
  "You are RaSh, the user's private memory assistant: a sharp, warm friend who remembers what they saved. Below the question are numbered memories, each with where and when the user saw it.",
  'Rules:',
  `- Use ONLY facts from the memories; never add facts, names or numbers from your own knowledge. If they don't answer the question, reply exactly: ${NOT_FOUND}`,
  '- Say when and where the user saw it, copying the time exactly as written; never work out a time yourself.',
  '- Put the memory number right after each fact it supports, like [1].',
  '- "You" means only the user, and you only know they saw, read, watched or saved something; people and things in the memories are "he", "she", "it" or their name.',
  '- 1-3 short, warm sentences. Plain text, no lists, no emojis; never mention "memories" or these rules.',
  '- Casual topics (food, music, videos, sports) may get one light, playful phrase that adds no facts. Study, work, files, email, health, money or anything personal: crisp, no jokes. You may acknowledge a feeling the user states, but never guess their mood or claim feelings of your own.',
  'Examples:',
  'You read about Marie Curie on britannica.com yesterday evening (7:10 PM) [1]. She won two Nobel Prizes, in physics and chemistry [1].',
  'You saw a paneer tikka recipe on hebbarskitchen.com on Sunday 27 Sep in the evening (7:30 PM) [1]. The paneer marinates for two hours [1], so good things take time.',
].join('\n');

function memoryHeader(source) {
  return `[${source.n}] ${source.title} (${source.site || 'saved'}, ${source.when})`;
}

// Conservative: plain English runs ~4 characters per token, but saved pages full of names and
// numbers measured closer to 3.3 (a "1,200-token" budget at /4 reached 1,490 real prompt tokens).
function estimateTokens(text) {
  return Math.ceil(String(text).length / 3.3);
}

// Keeps memories in rank order until the budget is spent; the lowest-ranked are dropped first. The
// top memory is always kept, trimmed if it alone is too long.
function fitToBudget(memories) {
  const kept = [];
  let used = 0;
  for (const m of memories) {
    const cost = estimateTokens(memoryHeader(m.source) + '\n' + m.text);
    if (used + cost <= CONFIG.MEMORY_TOKEN_BUDGET) {
      kept.push(m);
      used += cost;
    } else if (kept.length === 0) {
      const room = (CONFIG.MEMORY_TOKEN_BUDGET - estimateTokens(memoryHeader(m.source))) * 4;
      kept.push({ ...m, text: m.text.slice(0, Math.max(200, Math.floor(room * 3.3 / 4))) });
      break;
    } else {
      break;
    }
  }
  return kept;
}

function buildPrompt(question, memories) {
  const block = memories.map((m) => memoryHeader(m.source) + '\n' + m.text).join('\n\n');
  return `Memories:\n${block}\n\nQuestion: ${question}`;
}

// Plain text, at most ~3 sentences, ending on a full sentence.
function cleanAnswer(raw) {
  let t = String(raw || '')
    .replace(/^\s*(answer|rash)\s*:\s*/i, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1') // bold markers only, so "x**2" in code survives
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '') // no emojis in answers, enforced here too
    .replace(/\s+/g, ' ')
    .trim();
  t = h.trimAnswer(t);
  if (t.length > 600) {
    const cut = t.slice(0, 600);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    t = end > 100 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '.';
  }
  return t;
}

// Every model-written answer must carry the exact, pre-formatted time of a source it cites. Small
// models sometimes reword it ("this morning" for 2:27 AM), drop it, or put it first as a bare
// fragment; in those cases RaSh adds the when/where itself, straight from the data.
function withProvenance(text, sources) {
  if (!sources.length) return text;
  let t = text;
  for (const s of sources) {
    if (!s.when) continue;
    const lead = new RegExp('^\\s*' + s.when.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(\\[\\d+\\])?\\s*[.,]\\s*', 'i');
    t = t.replace(lead, ''); // "yesterday evening (7:47 PM) [1]. His debut..." -> "His debut..."
  }
  if (sources.some((s) => s.when && t.includes(s.when))) return t;
  const s = sources[0];
  const where = s.site === 'Gmail' ? 'in Gmail' : s.site === 'Saved file' ? 'in your saved files' : s.site ? 'on ' + s.site : '';
  const from = s.site === 'Gmail' ? 'your Gmail' : s.site === 'Saved file' ? 'your saved files' : s.site || 'your memory';
  const line = say('provenance', 'crisp', { where, from, wp: whenPhrase(s.when), n: s.n });
  return `${t} ${line}`.replace(/\s+/g, ' ').trim();
}

function saysNotFound(text, raw) {
  const t = String(text || '');
  return !t || t.toLowerCase().includes(NOT_FOUND.toLowerCase().replace(/\.$/, '')) || /NOT_FOUND/.test(raw) || h.isNotFoundReply(t);
}

async function generateAnswer(question, memories, onToken) {
  const t0 = Date.now();
  const prompt = buildPrompt(question, memories);
  let raw = '';
  let promptTokens = null;
  try {
    const res = await fetch(CONFIG.OLLAMA_URL + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.ANSWER_MODEL,
        system: SYSTEM_PROMPT,
        prompt,
        stream: !!onToken,
        keep_alive: CONFIG.KEEP_ALIVE,
        options: { temperature: 0.1, num_predict: CONFIG.ANSWER_NUM_PREDICT, num_ctx: CONFIG.ANSWER_NUM_CTX },
      }),
      signal: AbortSignal.timeout(CONFIG.ANSWER_TIMEOUT_MS),
    });
    if (!res.ok) return { failed: true, ms: Date.now() - t0 };

    if (!onToken) {
      const data = await res.json();
      raw = data.response || '';
      promptTokens = data.prompt_eval_count;
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let held = '';
      let released = false;
      let suppressed = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let obj;
          try { obj = JSON.parse(line); } catch (_) { continue; }
          if (obj.done) promptTokens = obj.prompt_eval_count;
          if (!obj.response) continue;
          raw += obj.response;
          if (suppressed) continue;
          if (released) { onToken(obj.response); continue; }
          held += obj.response;
          if (/^\s*(not[_ ]?found|i (?:could|can)n?o?'?t|i couldn)/i.test(held)) { suppressed = true; continue; }
          if (held.trim().length >= 12) { released = true; onToken(held); }
        }
      }
      if (!released && !suppressed && held.trim() && !/not[_ ]?found/i.test(held)) onToken(held);
    }
  } catch (_) {
    return { failed: true, ms: Date.now() - t0 };
  }

  const text = cleanAnswer(raw);
  return { text, notFound: saysNotFound(text, raw), promptTokens, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function answer({ question, cleanQuestion, unlocked, onToken }) {
  const t0 = Date.now();
  const now = new Date();
  const p = parseQuestion(cleanQuestion || question, now);
  const ctx = { question: String(question), now, unlocked: !!unlocked, onToken, scores: [], gen: null };
  let result = null;
  let tried = [];

  try {
    if (p.timeOrder) {
      tried.push('time-order');
      result = await timeOrderRoute(p, ctx);
    }
    const listy = p.recency || (p.window && !p.topicWords.length) || (!p.topicWords.length && (p.sites.length || p.kinds.size));
    if (!result && !p.timeOrder && listy) {
      tried.push('list');
      result = await listRoute(p, ctx);
    }
    if (!result && !p.timeOrder && p.kinds.has('file') && p.topicWords.length && !p.recency && !p.window) {
      tried.push('file');
      result = await fileRoute(p, ctx);
    }
    if (!result && !p.timeOrder && p.topicWords.length && (p.window || p.sites.length || p.kinds.size) && !tried.length) {
      tried.push('filtered');
      const filter = recordFilter({ kinds: new Set([...p.kinds].filter((k) => k !== 'video')), pdfOnly: p.pdfOnly, sites: p.sites, videoOnly: p.kinds.has('video') && p.kinds.size === 1 });
      const windowed = p.window ? withWindow(filter, p.window) : filter;
      const r = await hybridRoute(p, ctx, 'hybrid' + (p.window ? '+time-window' : '') + routeSuffix(p), windowed);
      if (r.found) result = r;
    }
    if (!result) result = await hybridRoute(p, ctx, tried.length ? `hybrid (fallback from ${tried.join(', ')})` : 'hybrid');
  } catch (err) {
    console.warn('[Ask] Smart Recall failed:', err.message);
    result = notFound('error');
  }

  result.tookMs = Date.now() - t0;
  const gen = ctx.gen;
  console.log(`[Ask] route=${result.route} found=${result.found} sources=${result.sources.length} ${ctx.scores.join(' ')}` +
    (gen && gen.promptTokens != null ? ` promptTokens=${gen.promptTokens} genMs=${gen.ms}` : '') + ` took=${result.tookMs}ms`);
  return result;
}

// A time window as an extra SQL filter: records with a save event inside it.
function withWindow(filter, w) {
  return {
    sql: filter.sql + ' AND EXISTS (SELECT 1 FROM record_events we WHERE we.record_id = r.id AND we.at >= ? AND we.at < ?)',
    params: [...filter.params, sqlUtc(w.start), sqlUtc(w.end)],
  };
}

function fmt(n) {
  return n === null || n === undefined || n < 0 ? 'n/a' : n.toFixed(3);
}

module.exports = { init, answer, when, parseQuestion, NOT_FOUND, PHRASES }; // PHRASES: read by scripts/eval-ask.js
