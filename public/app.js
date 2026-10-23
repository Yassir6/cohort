// Cohort client. Plain JS, no build step. Views render HTML strings through the
// `html` tag below, which escapes every interpolated value unless wrapped in raw().

// ------------------------------------------------------------------ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

class Html { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = s => new Html(String(s));
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function flat(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Html) return v.s;
  if (Array.isArray(v)) return v.map(flat).join('');
  return escapeHtml(v);
}
function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += flat(values[i]) + strings[i + 1];
  return new Html(out);
}
const bool = v => (v ? 'true' : 'false');
const icon = (name, cls = '') => raw(`<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`);
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const firstName = name => String(name || '').trim().split(/\s+/)[0] || 'there';
const enc = encodeURIComponent;

const store = {
  get(k, fallback = null) {
    try { const v = localStorage.getItem('cohort:' + k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem('cohort:' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem('cohort:' + k); } catch { /* storage blocked */ } },
};

const DAY = 86_400_000;
const TYPES = ['exam', 'homework', 'announcement', 'material'];
const COLORS = ['blue', 'teal', 'plum', 'rust', 'olive', 'rose', 'slate', 'gold'];
const TYPE_LABEL = { exam: 'Exam', homework: 'Homework', announcement: 'Announcement', material: 'Material' };
const TYPE_PLURAL = { exam: 'Exams', homework: 'Homework', announcement: 'Announcements', material: 'Materials' };
const TYPE_PHRASE = { exam: 'an exam', homework: 'homework', announcement: 'an announcement', material: 'material' };
const TYPE_HELP = {
  exam: 'Midterms, finals, quizzes. Date, room and weight.',
  homework: 'Assignments, projects, reports. Due date and where to submit.',
  announcement: 'News from the course: changes, cancellations, reminders.',
  material: 'Slides, notes, past papers and other files.',
};
const HUES = [215, 255, 290, 330, 5, 25, 42, 140, 165, 185, 200, 235];
const INLINE_MIME = /^(application\/pdf|image\/(png|jpeg|gif|webp)|video\/(mp4|webm)|audio\/(mpeg|mp4|wav)|text\/plain)$/;
const isTask = p => p.type === 'exam' || p.type === 'homework';
const colorOf = c => (COLORS.includes(c) ? c : 'slate');

// ------------------------------------------------------------------ dates
const hour12 = (() => {
  try { return !!new Intl.DateTimeFormat(navigator.language, { hour: 'numeric' }).resolvedOptions().hour12; } catch { return false; }
})();
const fmt = opts => new Intl.DateTimeFormat('en-GB', opts);
const F = {
  dow: fmt({ weekday: 'short' }),
  dowLetter: fmt({ weekday: 'narrow' }),
  mon: fmt({ month: 'short' }),
  date: fmt({ weekday: 'short', day: 'numeric', month: 'short' }),
  dateYear: fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
  monthYear: fmt({ month: 'long', year: 'numeric' }),
  time: new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hour12 }),
};
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayKeyOf = p => (p.hasTime ? ymd(new Date(p.dueAt)) : p.dueDate);
const displayDate = p => (p.hasTime ? new Date(p.dueAt) : new Date(p.dueDate + 'T12:00'));
const fullDate = iso => { const d = new Date(iso); return `${F.dateYear.format(d)}, ${F.time.format(d)}`; };

function whenText(p) {
  if (!p || !p.dueAt) return 'Date not set';
  const d = displayDate(p);
  const date = (d.getFullYear() === new Date().getFullYear() ? F.date : F.dateYear).format(d);
  if (p.hasTime) return `${date}, ${F.time.format(d)}`;
  return p.type === 'homework' ? `${date}, end of day` : date;
}
function timeLabel(p) {
  if (p.hasTime) return F.time.format(new Date(p.dueAt));
  return p.type === 'homework' ? 'End of day' : 'All day';
}
function dur(ms) {
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return h % 24 && d < 10 ? `${d} d ${h % 24} h` : `${d} d`;
  if (h >= 1) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.max(1, min)} min`;
}
function durParts(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return { d: Math.floor(m / 1440), h: Math.floor((m % 1440) / 60), m: m % 60 };
}
function countdownLabel(p, now = Date.now()) {
  if (!p.dueAt) return 'Date TBA';
  const ms = Date.parse(p.dueAt) - now;
  if (p.done || (ms < 0 && isTask(p))) return 'Done';
  if (ms < 0) return 'Passed';
  return `in ${dur(ms)}`;
}
function urgency(p, now = Date.now()) {
  if (!p.dueAt || p.done) return '';
  const ms = Date.parse(p.dueAt) - now;
  if (ms < 0) return 'past';
  if (ms < DAY) return 'today';
  if (ms < 3 * DAY) return 'soon';
  return '';
}
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return F.date.format(new Date(iso));
}
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
const hello = () => (state.me ? `${greeting()}, ${firstName(state.me.name)}` : greeting());
function firstDayOfWeek() {
  try {
    const loc = new Intl.Locale(navigator.language);
    const info = (loc.getWeekInfo && loc.getWeekInfo()) || loc.weekInfo;
    if (info && info.firstDay) return info.firstDay % 7;
  } catch { /* older browsers */ }
  return 1;
}
const recentMove = p => p.dueChange && Date.now() - Date.parse(p.dueChange.at) < 14 * DAY;
const sizeText = b => (b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const extOf = name => (String(name).includes('.') ? name.split('.').pop() : 'file').slice(0, 4);

// ------------------------------------------------------------------ text formatting
const unescapeHtml = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function inline(text, mentions = []) {
  let out = escapeHtml(text);
  // Mentions become placeholders first so bold and links can't split them; longest names go first.
  const marks = [];
  for (const m of [...mentions].sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(escapeHtml('@' + m.name))})(?![\\p{L}\\p{N}])`, 'giu');
    out = out.replace(re, (all, pre, found) => {
      marks.push(`<span class="mention${state.me && m.id === state.me.id ? ' is-me' : ''}">${found}</span>`);
      return `${pre}\u0000${marks.length - 1}\u0000`;
    });
  }
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/https?:\/\/[^\s<]+/g, match => {
    const [, href, trail] = /^(.*?)((?:[.,;:!?)\]]|&quot;|&#39;)*)$/.exec(match);
    const plain = unescapeHtml(href).replace(/^https?:\/\//, '');
    const label = escapeHtml(plain.length > 60 ? plain.slice(0, 57) + '…' : plain);
    return `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>${trail}`;
  });
  return marks.length ? out.replace(/\u0000(\d+)\u0000/g, (_, i) => marks[i]) : out;
}
// Paragraphs split on blank lines; inside one, runs of "- " or "1. " lines become lists.
const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;
function richText(text, { mentions = [] } = {}) {
  const fmt = line => inline(line, mentions);
  const out = [];
  for (const block of String(text || '').split(/\n{2,}/)) {
    if (!block.trim()) continue;
    const runs = [];
    for (const line of block.split('\n')) {
      const kind = BULLET.test(line) ? 'ul' : NUMBERED.test(line) ? 'ol' : 'p';
      if (!runs.length || runs[runs.length - 1].kind !== kind) runs.push({ kind, lines: [] });
      runs[runs.length - 1].lines.push(line);
    }
    for (const { kind, lines } of runs) {
      if (kind === 'p') out.push(`<p dir="auto">${lines.map(fmt).join('<br>')}</p>`);
      else out.push(`<${kind} dir="auto">${lines.map(l => `<li>${fmt(l.replace(kind === 'ul' ? BULLET : NUMBERED, ''))}</li>`).join('')}</${kind}>`);
    }
  }
  return raw(out.join(''));
}
function highlight(text, q) {
  if (!q) return escapeHtml(text);
  const re = new RegExp(escapeRe(q), 'gi');
  let out = '';
  let last = 0;
  for (const m of String(text).matchAll(re)) {
    out += escapeHtml(text.slice(last, m.index)) + `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

// Word-level diff: trim the shared start and end, then an LCS over the middle.
const tokenize = s => String(s || '').split(/(\s+)/).filter(t => t !== '');
function diffWords(a, b) {
  const A = tokenize(a);
  const B = tokenize(b);
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) { endA--; endB--; }
  const midA = A.slice(start, endA);
  const midB = B.slice(start, endB);
  const ops = midA.length * midB.length > 250000
    ? [...midA.map(t => ['-', t]), ...midB.map(t => ['+', t])]
    : lcsOps(midA, midB);
  let out = escapeHtml(A.slice(0, start).join(''));
  let i = 0;
  while (i < ops.length) {
    const op = ops[i][0];
    let chunk = '';
    while (i < ops.length && ops[i][0] === op) chunk += ops[i++][1];
    out += op === '=' ? escapeHtml(chunk) : op === '-' ? `<del>${escapeHtml(chunk)}</del>` : `<ins>${escapeHtml(chunk)}</ins>`;
  }
  return raw(out + escapeHtml(A.slice(endA).join('')));
}
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push(['=', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', a[i++]]);
    else ops.push(['+', b[j++]]);
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

const words = s => new Set(String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1 || /\d/.test(w)));
function similarity(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

// ------------------------------------------------------------------ state & API
const state = { config: null, me: null, route: null, view: null, viewJson: '', started: false, editor: null };

class ApiError extends Error { constructor(status, message, data) { super(message); this.status = status; this.data = data; } }
async function api(method, path, body, { allow401 = false } = {}) {
  const headers = {};
  if (method !== 'GET') headers['X-Cohort'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    if (res.status === 401 && !allow401 && state.me) signedOut('You were signed out. Sign in again.');
    throw new ApiError(res.status, (data && data.error) || `Something went wrong (${res.status}).`, data);
  }
  return data;
}
const get = path => api('GET', path);

function uploadFile(file, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('X-Cohort', '1');
    xhr.setRequestHeader('X-File-Name', enc(file.name));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 200 && data) resolve(data);
      else reject(new Error((data && data.error) || 'The upload failed. Try again.'));
    };
    xhr.onerror = () => reject(new Error('The upload failed. Check your connection.'));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    xhr.send(file);
  });
  return { promise, xhr };
}

// Before accounts existed, the browser kept the device key itself. It is traded once for a sign-in.
function legacyKey() {
  const m = /(?:^|;\s*)cohort_key=([^;]+)/.exec(document.cookie || '');
  return store.get('key') || (m ? decodeURIComponent(m[1]) : null);
}
function clearLegacyKey() {
  store.del('key');
  try { document.cookie = 'cohort_key=; max-age=0; path=/; samesite=strict'; } catch { /* cookies blocked */ }
}
function normalizeKeyInput(v) {
  const s = String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (s.match(/.{1,4}/g) || []).join('-');
}

// ------------------------------------------------------------------ small components
const appName = () => (state.config && state.config.appName) || 'Cohort';
const brandMark = () => raw('<svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true"><rect class="bm-bg" width="64" height="64" rx="15"/><path class="bm-hl" d="M9 39.5 55 35.5v11L9 50z"/><path class="bm-check" d="m17.5 29 9.5 9.5L47 17" fill="none" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/></svg>');
const tag = type => html`<span class="tag t-${type}">${TYPE_LABEL[type]}</span>`;
function courseChip(c, { link = false, name = false } = {}) {
  if (name && c.name) return html`<span class="course-chip is-name cc-${colorOf(c.color)}" title="${c.code}"><span class="cc-label" dir="auto">${c.name}</span></span>`;
  return link
    ? html`<a class="course-chip cc-${colorOf(c.color)}" href="#/course/${c.id}">${c.code}</a>`
    : html`<span class="course-chip cc-${colorOf(c.color)}">${c.code}</span>`;
}
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const picked = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [parts[0] || '?'];
  return picked.map(p => [...p][0]).join('').toUpperCase();
}
const avatar = (person, cls = '') => html`<span class="avatar ${cls}" style="--h:${HUES[((person && person.color) || 0) % 12]}" aria-hidden="true">${initials(person && person.name)}</span>`;

function dateBlock(p) {
  if (p.dueAt) {
    const d = displayDate(p);
    return html`<div class="date-block" aria-hidden="true"><span class="dow">${F.dow.format(d)}</span><span class="dom">${d.getDate()}</span><span class="mon">${F.mon.format(d)}</span></div>`;
  }
  if (p.type === 'material') return html`<div class="date-block is-file" aria-hidden="true">${icon('clip', 'i-lg')}</div>`;
  if (p.type === 'announcement') {
    const d = new Date(p.createdAt);
    return html`<div class="date-block is-tba" aria-hidden="true"><span class="dow">Posted</span><span class="dom">${d.getDate()}</span><span class="mon">${F.mon.format(d)}</span></div>`;
  }
  return html`<div class="date-block is-tba" aria-hidden="true"><span class="dow">Date</span><span class="dom">TBA</span><span class="mon">&nbsp;</span></div>`;
}

function postBadges(p) {
  const prev = state.me && state.me.prevVisitAt;
  const out = [];
  if (prev && p.createdAt > prev) out.push(html`<span class="badge badge-new">New</span>`);
  else if (prev && p.version > 1 && p.updatedAt > prev) out.push(html`<span class="badge badge-new">Updated</span>`);
  if (recentMove(p)) out.push(html`<span class="badge badge-moved" title="The date changed ${ago(p.dueChange.at)}">${icon('arrow')}Date changed</span>`);
  if (p.deleteVotes) out.push(html`<span class="badge badge-delete">${icon('trash')}Delete vote ${p.deleteVotes}/${state.config.deleteVotes}</span>`);
  if (p.up - p.down <= -2) out.push(html`<span class="badge badge-disputed">Disputed</span>`);
  return out;
}
function stats(p) {
  const out = [];
  if (p.up || p.down) out.push(html`<span title="${p.up} up, ${p.down} down">${icon('vote-up')}${p.up - p.down}</span>`);
  if (p.comments) out.push(html`<span title="${plural(p.comments, 'comment')}">${icon('comment')}${p.comments}</span>`);
  if (p.files) out.push(html`<span title="${plural(p.files, 'file')}">${icon('clip')}${p.files}</span>`);
  return out;
}
function rowMeta(p) {
  const out = [];
  if (p.dueAt) out.push(html`<span>${icon('clock')}${timeLabel(p)}</span>`);
  if (p.location) out.push(html`<span>${icon(p.type === 'homework' ? 'upload' : 'pin')}<span dir="auto">${p.location}</span></span>`);
  if (p.weight) out.push(html`<span>${icon('percent')}${p.weight}</span>`);
  if (!p.dueAt && !isTask(p)) out.push(html`<span>${avatar(p.author, 'avatar-sm')}${p.author.name} · ${ago(p.createdAt)}</span>`);
  return out;
}
function postRow(p, { now = Date.now(), showCourse = true, titleHtml = null } = {}) {
  const u = urgency(p, now);
  const side = p.dueAt
    ? html`<span class="countdown" data-due="${p.dueAt}" data-type="${p.type}" data-done="${p.done ? 1 : 0}" title="${whenText(p)}">${countdownLabel(p, now)}</span>`
    : isTask(p) ? html`<span class="countdown muted">Date TBA</span>` : '';
  return html`
  <div class="row ${p.done ? 'is-done' : ''}" data-urgency="${u}" data-day="${p.dueAt ? dayKeyOf(p) : ''}">
    ${dateBlock(p)}
    <div class="row-main">
      <div class="row-top">${tag(p.type)}${showCourse ? courseChip(p.course, { name: true }) : ''}${postBadges(p)}</div>
      <a class="row-link row-title" href="#/post/${p.id}" dir="auto">${titleHtml || p.title}</a>
      <div class="row-meta">${rowMeta(p)}</div>
    </div>
    <div class="row-side">
      <div class="row-when">${side}<span class="row-stats">${stats(p)}</span></div>
    </div>
  </div>`;
}

function annCard(p, { showCourse = false } = {}) {
  return html`
  <article class="ann-card">
    <div class="row-top">${tag(p.type)}${showCourse ? courseChip(p.course, { name: true }) : ''}${postBadges(p)}</div>
    <a class="row-link row-title" href="#/post/${p.id}" dir="auto">${p.title}</a>
    ${p.excerpt ? html`<p class="excerpt" dir="auto">${p.excerpt}</p>` : ''}
    <div class="row-meta">
      <span>${avatar(p.author, 'avatar-sm')}${p.author.name}</span><span>${ago(p.createdAt)}</span>
      ${p.dueAt ? html`<span>${icon('calendar')}${whenText(p)}</span>` : ''}
      <span class="row-stats">${stats(p)}</span>
    </div>
  </article>`;
}

const trackButton = (c, cls = '') => html`<button class="btn btn-sm track-btn ${cls}" type="button" data-action="toggle-track" data-id="${c.id}" data-code="${c.code}" aria-pressed="${bool(c.tracked)}">
  <span class="when-off">${icon('plus', 'i-sm')}Track</span><span class="when-on">${icon('check', 'i-sm')}Tracking</span><span class="when-hover">${icon('x', 'i-sm')}Untrack</span></button>`;

function emptyState(title, text, actions = '') {
  return html`<div class="empty"><div class="empty-title">${title}</div><p>${text}</p>${actions ? html`<div class="form-actions">${actions}</div>` : ''}</div>`;
}

function activitySentence(a) {
  const d = a.data || {};
  const who = html`<b>${(a.actor && a.actor.name) || 'Someone'}</b>`;
  const post = a.postId ? html`<a href="#/post/${a.postId}" dir="auto">${d.title}</a>` : html`<b dir="auto">${d.title}</b>`;
  switch (a.kind) {
    case 'post_created': return html`${who} added ${TYPE_PHRASE[d.type] || 'a post'}: ${post}`;
    case 'post_edited': return html`${who} edited ${post}${d.fields && d.fields.length ? html` <span class="muted">(${d.fields.join(', ')})</span>` : ''}`;
    case 'comment_added': return html`${who} commented on ${post}`;
    case 'delete_requested': return html`${who} asked to delete ${post}`;
    case 'post_deleted': return html`${post} was deleted after ${d.votes} classmates agreed`;
    case 'course_created': return html`${who} added the course ${a.course ? html`<a href="#/course/${a.course.id}">${d.code} · ${d.name}</a>` : html`<b>${d.code}</b>`}`;
    case 'course_edited': return html`${who} updated the course details of ${a.course ? a.course.code : 'a course'}`;
    default: return html`${who} made a change`;
  }
}
function movePill(due, type) {
  return html`<span class="feed-move">${icon('calendar', 'i-sm')}${whenText({ ...due.from, type })} ${icon('arrow', 'i-sm')} ${due.to.dueAt ? whenText({ ...due.to, type }) : 'no date'}</span>`;
}
function activityExtra(a) {
  const d = a.data || {};
  if (a.kind === 'post_edited' && d.due) return html`<div class="feed-extra">${movePill(d.due, d.type)}</div>`;
  if (a.kind === 'post_edited' && d.note) return html`<div class="feed-extra"><span class="feed-quote" dir="auto">${d.note}</span></div>`;
  if (a.kind === 'comment_added' && d.excerpt) return html`<div class="feed-extra"><span class="feed-quote" dir="auto">${d.excerpt}</span></div>`;
  if (a.kind === 'delete_requested' && d.reason) return html`<div class="feed-extra"><span class="feed-quote" dir="auto">${d.reason}</span></div>`;
  if (a.kind === 'post_created' && d.due) return html`<div class="feed-extra"><span class="muted nowrap">${whenText({ ...d.due, type: d.type })}</span></div>`;
  return '';
}

// ------------------------------------------------------------------ home
async function viewHome() {
  const data = await get('/api/home');
  return { title: 'Up next', data, html: homeHtml };
}

// Sections in time order: one per day ("Today", "Tomorrow", "In 8 days"), then undated.
// Anything whose due time has passed is done for everyone and leaves the list.
function groupUpcoming(items, now, showDone) {
  const today = startOfDay(new Date(now));
  const todayKey = ymd(today);
  const tba = [];
  const days = new Map();
  let hiddenDone = 0;
  for (const p of items) {
    const passed = p.dueAt && Date.parse(p.dueAt) < now;
    if (passed && dayKeyOf(p) !== todayKey) continue;
    if ((p.done || passed) && !showDone) { hiddenDone++; continue; }
    if (!p.dueAt) { tba.push(p); continue; }
    const key = dayKeyOf(p);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(p);
  }
  const dayTitle = key => {
    const n = Math.round((new Date(key + 'T12:00') - new Date(todayKey + 'T12:00')) / DAY);
    return n <= 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`;
  };
  const sections = [];
  for (const key of [...days.keys()].sort()) sections.push({ key: `d-${key}`, title: dayTitle(key), items: days.get(key) });
  if (tba.length) sections.push({ key: 'tba', title: 'Date not announced', items: tba });
  return { sections, hiddenDone };
}

function homeSummary(items, now) {
  const weekEnd = addDays(new Date(now), 8).getTime();
  const open = items.filter(p => p.dueAt && !p.done && isTask(p));
  const week = open.filter(p => { const t = Date.parse(p.dueAt); return t >= now && t < weekEnd; });
  const exams = week.filter(p => p.type === 'exam').length;
  return {
    total: week.length, exams, homework: week.length - exams,
    later: open.filter(p => Date.parse(p.dueAt) >= weekEnd).length,
  };
}

function homeHtml(data) {
  const now = Date.now();
  const me = state.me;
  if (!data.trackedCourses) {
    return html`
    <div class="page-head"><div><div class="eyebrow">${hello()}</div><h1 class="page-title">${me ? 'Pick the courses you take' : 'Nothing here yet'}</h1>
      <p class="page-sub">Up next fills with the exams, homework and announcements of the courses you track, sorted by what's due first.</p></div></div>
    ${data.totalCourses
      ? emptyState(`${plural(data.totalCourses, 'course')} already added by classmates`, 'Track yours and their deadlines show up here.', html`<a class="btn btn-primary" href="#/courses">${icon('courses')}Browse courses</a>`)
      : emptyState('No courses yet', 'Be the first: add a course you take, then post its exam dates and homework.', html`<button class="btn btn-primary" type="button" data-action="add-course">${icon('plus')}Add a course</button>`)}`;
  }
  const filter = store.get('homeFilter', 'all');
  const showDone = store.get('showDone', false);
  const sum = homeSummary(data.upcoming, now);
  const subParts = [
    sum.exams && plural(sum.exams, 'exam'),
    sum.homework && `${sum.homework} homework`,
    sum.later && `${sum.later} more after that`,
  ].filter(Boolean);
  const next = data.upcoming.find(p => p.dueAt && !p.done && isTask(p) && Date.parse(p.dueAt) >= now);
  const matches = p => filter === 'all' || (filter === 'event' ? p.type === 'announcement' : p.type === filter);
  // The "Next up" card already shows the first deadline, so the list starts after it.
  const filtered = data.upcoming.filter(p => p !== next && matches(p));
  const grouped = groupUpcoming(filtered, now, showDone);
  const hiddenDone = grouped.hiddenDone;
  const sections = grouped.sections.map(g => html`
    <section class="group-day" aria-labelledby="g-${g.key}">
      <div class="group-head"><h2 class="section-title" id="g-${g.key}">${g.title}</h2></div>
      <div class="list">${g.items.map(p => postRow(p, { now }))}</div>
    </section>`);

  return html`
  <div class="home">
    <div class="home-main">
      <div class="home-head">
        <div>
          <div class="eyebrow">${hello()}</div>
          <h1 class="page-title">${sum.total ? `${plural(sum.total, 'deadline')} in the next 7 days` : 'Nothing due in the next 7 days'}</h1>
          ${subParts.length ? html`<p class="page-sub">${subParts.join(' · ')}</p>` : ''}
        </div>
      </div>
      ${next ? heroHtml(next, now) : html`<div class="panel hero-clear">${icon('check')}<div><b>You're clear.</b> <span class="muted">No open exams or homework in your courses right now.</span></div></div>`}
      <div class="agenda-tools">
        <div class="chips" role="group" aria-label="Show">
          ${[['all', 'All'], ['exam', 'Exams'], ['homework', 'Homework'], ['event', 'Events']].map(([v, l]) => html`<button class="chip" type="button" data-action="home-filter" data-value="${v}" aria-pressed="${bool(filter === v)}">${l}</button>`)}
        </div>
        <label class="switch"><input type="checkbox" id="show-done" ${raw(showDone ? 'checked' : '')}>Show done</label>
      </div>
      <div class="agenda">
        ${sections.length ? sections
          : next && matches(next) ? html`<p class="note">${filter === 'all' ? 'Nothing else coming up.' : `No other ${TYPE_PLURAL[filter].toLowerCase()} coming up.`}</p>`
          : emptyState(filter === 'all' ? 'Nothing coming up' : `No ${filter === 'event' ? 'events' : TYPE_PLURAL[filter].toLowerCase()} coming up`,
            'When a classmate posts an exam or homework in one of your courses, it shows up here.',
            html`<a class="btn" href="#/new">${icon('plus')}Post one</a>`)}
        ${hiddenDone ? html`<p class="hidden-note">${plural(hiddenDone, 'done item')} hidden. <button type="button" data-action="show-done">Show</button></p>` : ''}
      </div>
    </div>
    <aside class="rail" aria-label="Announcements">${announcementsHtml(data)}</aside>
  </div>`;
}

function countParts(ms) {
  const { d, h, m } = durParts(ms);
  return d > 0
    ? html`<b>${d}</b><small>d</small><b>${pad(h)}</b><small>h</small><b>${pad(m)}</b><small>m</small>`
    : html`<b>${h}</b><small>h</small><b>${pad(m)}</b><small>m</small>`;
}
function heroHtml(p, now) {
  const ms = Date.parse(p.dueAt) - now;
  return html`
  <section class="hero ${ms < DAY ? 'is-urgent' : ''}" aria-label="Next deadline">
    <div>
      <div class="hero-top"><span class="eyebrow">Next up</span>${tag(p.type)}${courseChip(p.course, { name: true })}${recentMove(p) ? html`<span class="badge badge-moved">${icon('arrow')}Date changed</span>` : ''}</div>
      <a class="hero-link" href="#/post/${p.id}"><h2 class="hero-title" dir="auto">${p.title}</h2></a>
      <div class="hero-meta">
        <span>${icon('calendar')}${whenText(p)}</span>
        ${p.location ? html`<span>${icon(p.type === 'homework' ? 'upload' : 'pin')}<span dir="auto">${p.location}</span></span>` : ''}
        ${p.weight ? html`<span>${icon('percent')}${p.weight} of the grade</span>` : ''}
      </div>
    </div>
    <div class="hero-side">
      <div class="hero-count" data-countdown="${p.dueAt}" aria-label="Time left: ${dur(ms)}">${countParts(ms)}</div>
      <div class="hero-caption">${p.type === 'exam' ? 'until the exam' : 'until it is due'}</div>
    </div>
  </section>`;
}

function announcementsHtml(data) {
  return html`
  <section class="panel panel-pad">
    <div class="panel-head"><h2 class="section-title">Announcements</h2></div>
    ${data.announcements.length ? html`<div>${data.announcements.slice(0, 5).map(p => html`
      <div class="ann"><a class="row-link ann-title" href="#/post/${p.id}" dir="auto">${p.title}</a>
        <div class="ann-meta">${courseChip(p.course, { name: true })}<span>${ago(p.createdAt)}</span>${postBadges(p)}</div></div>`)}</div>`
      : html`<p class="note">No announcements in the last 30 days.</p>`}
  </section>`;
}

// ------------------------------------------------------------------ courses
async function viewCourses() {
  const courses = await get('/api/courses');
  return { title: 'Courses', data: courses, html: coursesHtml, mount: mountCourses };
}
function courseCard(c) {
  return html`
  <article class="course-card cc-${colorOf(c.color)}" data-search="${`${c.code} ${c.name} ${c.instructor}`.toLowerCase()}">
    <div class="course-card-top"><span class="course-code">${c.code}</span>${trackButton(c)}</div>
    <a class="row-link course-name" href="#/course/${c.id}" dir="auto">${c.name}</a>
    <div class="course-meta">${c.instructor ? html`<span dir="auto">${c.instructor}</span>` : ''}<span>${c.followers} tracking</span><span>${c.upcoming} upcoming</span></div>
    <div class="course-next">${c.next
      ? html`${tag(c.next.type)}<span class="t" dir="auto">${c.next.title}</span><span class="countdown">${countdownLabel(c.next)}</span>`
      : html`<span class="muted">Nothing due yet</span>`}</div>
  </article>`;
}
function coursesHtml(courses) {
  const mine = courses.filter(c => c.tracked);
  const others = courses.filter(c => !c.tracked);
  const section = (title, list) => html`<section class="course-section"><h2 class="section-title">${title}<span class="count">${list.length}</span></h2><div class="course-grid">${list.map(courseCard)}</div></section>`;
  return html`
  <div class="page-head">
    <div><div class="eyebrow">${plural(courses.length, 'course')}</div><h1 class="page-title">Courses</h1>
      <p class="page-sub">Track the courses you take. Their exams, homework and announcements go into your Up next list and your calendar.</p></div>
    <button class="btn btn-primary" type="button" data-action="add-course">${icon('plus')}Add a course</button>
  </div>
  ${courses.length ? html`
    <div class="toolbar"><div class="filter-input">${icon('search')}<label class="sr-only" for="course-filter">Filter courses</label><input class="input" id="course-filter" type="search" placeholder="Filter by code, name or instructor" autocomplete="off"></div></div>
    <div class="stack">
      ${mine.length ? section('Your courses', mine) : ''}
      ${others.length ? section(mine.length ? 'Other courses' : 'All courses', others) : ''}
      <p class="note" id="no-course-match" hidden>No course matches that. <button class="linkish" type="button" data-action="add-course">Add it</button></p>
    </div>`
    : emptyState('No courses yet', 'Add the first course. Use the code from your timetable so classmates find it.', html`<button class="btn btn-primary" type="button" data-action="add-course">${icon('plus')}Add a course</button>`)}`;
}
function mountCourses(main) {
  const input = $('#course-filter', main);
  if (!input) return;
  const apply = () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    for (const card of $$('.course-card', main)) {
      const hit = !q || card.dataset.search.includes(q);
      card.hidden = !hit;
      if (hit) shown++;
    }
    for (const sec of $$('.course-section', main)) sec.hidden = !$$('.course-card:not([hidden])', sec).length;
    $('#no-course-match', main).hidden = shown > 0;
  };
  input.addEventListener('input', apply);
  apply();
}

// ------------------------------------------------------------------ course page
async function viewCourse(route) {
  const data = await get(`/api/courses/${route.params[0]}`);
  const type = TYPES.includes(route.query.get('type')) ? route.query.get('type') : 'all';
  return { title: data.course.code, data, html: d => courseHtml(d, type) };
}
function materialRow(p) {
  return html`
  <div class="row">
    ${dateBlock(p)}
    <div class="row-main">
      <div class="row-top">${tag(p.type)}${postBadges(p)}</div>
      <a class="row-link row-title" href="#/post/${p.id}" dir="auto">${p.title}</a>
      <div class="row-meta"><span>${plural(p.files, 'file')}</span><span>${avatar(p.author, 'avatar-sm')}${p.author.name}</span><span>${ago(p.createdAt)}</span></div>
    </div>
    <div class="row-side"><span class="row-stats">${stats(p)}</span></div>
  </div>`;
}
function courseHtml(data, type) {
  const c = data.course;
  const posts = data.posts;
  const now = Date.now();
  const counts = {};
  for (const p of posts) counts[p.type] = (counts[p.type] || 0) + 1;
  const list = type === 'all' ? posts : posts.filter(p => p.type === type);
  const startToday = startOfDay(new Date(now)).getTime();
  const byDue = (a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt);
  const dated = list.filter(p => p.dueAt).sort(byDue);
  const upcoming = dated.filter(p => Date.parse(p.dueAt) >= startToday);
  const past = dated.filter(p => Date.parse(p.dueAt) < startToday).reverse();
  const tba = list.filter(p => !p.dueAt && isTask(p));
  const anns = list.filter(p => p.type === 'announcement' && (type === 'announcement' || !p.dueAt));
  const mats = list.filter(p => p.type === 'material');
  const sec = (title, n, body) => html`<section><h2 class="section-title">${title}<span class="count">${n}</span></h2>${body}</section>`;
  const rows = items => html`<div class="list">${items.map(p => postRow(p, { now, showCourse: false }))}</div>`;

  let body;
  if (!posts.length) {
    body = emptyState(`Nothing posted for ${c.code} yet`, 'Start with what you know: the exam dates from the syllabus, the first homework, or a file from the lecture.',
      html`<a class="btn btn-primary" href="#/new?course=${c.id}">${icon('plus')}New post</a>`);
  } else if (!list.length) {
    body = emptyState(`No ${TYPE_PLURAL[type].toLowerCase()} yet`, `Nobody has posted ${TYPE_PHRASE[type]} for ${c.code}.`,
      html`<a class="btn" href="#/new?course=${c.id}&type=${type}">${icon('plus')}Post ${TYPE_PHRASE[type]}</a>`);
  } else if (type === 'announcement') {
    body = html`<div class="ann-cards">${list.map(p => annCard(p))}</div>`;
  } else if (type === 'material') {
    body = html`<div class="list">${list.map(materialRow)}</div>`;
  } else {
    body = html`
      ${upcoming.length ? sec(type === 'all' ? 'Coming up' : `Upcoming ${TYPE_PLURAL[type].toLowerCase()}`, upcoming.length, rows(upcoming)) : ''}
      ${tba.length ? sec('Date not announced', tba.length, rows(tba)) : ''}
      ${type === 'all' && anns.length ? sec('Announcements', anns.length, html`<div class="ann-cards">${anns.map(p => annCard(p))}</div>`) : ''}
      ${type === 'all' && mats.length ? sec('Materials', mats.length, html`<div class="list">${mats.map(materialRow)}</div>`) : ''}
      ${past.length ? html`<details class="fold"><summary>${icon('down', 'i-sm')}Past<span class="count">${past.length}</span></summary><div class="fold-body">${rows(past)}</div></details>` : ''}`;
  }

  return html`
  <div class="course-hero cc-${colorOf(c.color)}">
    <div>
      <span class="course-code">${c.code}</span>
      <h1 class="page-title" dir="auto">${c.name}</h1>
      <div class="course-meta">${c.instructor ? html`<span dir="auto">${c.instructor}</span>` : ''}<span>${c.followers} tracking</span><span>${c.upcoming} upcoming</span></div>
    </div>
    <div class="form-actions">${trackButton(c)}
      <button class="btn btn-sm" type="button" data-action="edit-course">${icon('edit', 'i-sm')}Edit details</button>
      <a class="btn btn-sm btn-primary" href="#/new?course=${c.id}">${icon('plus', 'i-sm')}New post</a></div>
  </div>
  <div class="chips" role="group" aria-label="Filter posts">
    ${['all', ...TYPES].map(t => html`<a class="chip" href="#/course/${c.id}${t === 'all' ? '' : '?type=' + t}" aria-current="${bool(t === type)}">${t === 'all' ? 'All' : TYPE_PLURAL[t]}<span class="n">${t === 'all' ? posts.length : counts[t] || 0}</span></a>`)}
  </div>
  <div class="course-sections">
    ${body}
    ${data.deleted.length ? html`<details class="fold"><summary>${icon('down', 'i-sm')}Recently deleted<span class="count">${data.deleted.length}</span></summary>
      <div class="fold-body deleted-list">${data.deleted.map(p => html`<div>${tag(p.type)} <a href="#/post/${p.id}" dir="auto">${p.title}</a> · deleted ${ago(p.deletedAt)}</div>`)}</div></details>` : ''}
  </div>`;
}

// ------------------------------------------------------------------ post page
// Which reply box or comment edit is open on the current post. Kept outside the HTML so live refreshes redraw it.
let postUi = { postId: null, reply: null, editing: null, scrolledTo: null, attach: { comment: [], reply: [], edit: [] } };
async function viewPost(route) {
  if (postUi.postId !== route.params[0]) postUi = { postId: route.params[0], reply: null, editing: null, scrolledTo: null, attach: { comment: [], reply: [], edit: [] } };
  const data = await get(`/api/posts/${route.params[0]}`);
  return { title: data.post.title, data, html: postHtml, mount: mountPost };
}
function factsHtml(p, now) {
  const fact = (label, value, extra = '') => html`<div class="fact" ${raw(extra)}><div class="fact-label">${label}</div><div class="fact-value">${value}</div></div>`;
  const facts = [];
  if (p.dueAt) {
    const d = displayDate(p);
    facts.push(fact(p.type === 'exam' ? 'Date' : p.type === 'homework' ? 'Due' : 'When', (d.getFullYear() === new Date().getFullYear() ? F.date : F.dateYear).format(d)));
    facts.push(fact('Time', timeLabel(p)));
  } else if (isTask(p)) {
    facts.push(fact(p.type === 'exam' ? 'Date' : 'Due', html`<span class="muted">Not announced yet</span>`));
  }
  if (p.location) facts.push(fact(p.type === 'homework' ? 'Submit via' : 'Where', html`<span dir="auto">${raw(inline(p.location))}</span>`));
  if (p.weight) facts.push(fact('Weight', p.weight));
  if (p.dueAt) {
    const past = Date.parse(p.dueAt) < now;
    facts.push(html`<div class="fact" data-urgency="${urgency(p, now)}"><div class="fact-label">${past || p.done ? 'Status' : 'Time left'}</div>
      <div class="fact-value big"><span data-due="${p.dueAt}" data-type="${p.type}" data-done="${p.done ? 1 : 0}">${countdownLabel(p, now)}</span></div></div>`);
  }
  if (!facts.length) return '';
  return html`<div class="facts">${facts}</div>
  ${p.dueAt ? html`<div class="cal-actions">
    <a class="btn btn-sm" href="${googleCalUrl(p)}" target="_blank" rel="noopener">${icon('cal-plus', 'i-sm')}Add to Google Calendar</a>
    <button class="btn btn-sm" type="button" data-action="ics">${icon('download', 'i-sm')}Apple or Outlook (.ics)</button></div>` : ''}`;
}
function fileRow(f) {
  const opens = INLINE_MIME.test(f.mime);
  return html`
  <div class="file">
    <span class="file-icon">${extOf(f.name)}</span>
    <div class="file-main">
      <a class="row-link file-name" href="${f.url}" ${raw(opens ? 'target="_blank" rel="noopener"' : 'download')}>${f.name}</a>
      <div class="file-meta">${sizeText(f.size)}${f.uploadedBy ? ` · added by ${f.uploadedBy.name}` : ''}</div>
    </div>
    ${icon(opens ? 'external' : 'download')}
  </div>`;
}
function attachmentsHtml(files) {
  const images = files.filter(f => /^image\/(png|jpeg|gif|webp)$/.test(f.mime));
  return html`
  <section class="attachments">
    <h2 class="section-title">Files<span class="count">${files.length}</span></h2>
    ${images.length ? html`<div class="thumbs">${images.map(f => html`<a class="thumb" href="${f.url}" target="_blank" rel="noopener"><img src="${f.url}" alt="${f.name}" loading="lazy"></a>`)}</div>` : ''}
    <div class="files">${files.map(fileRow)}</div>
  </section>`;
}
function voteHelp(p) {
  const score = p.up - p.down;
  if (!p.up && !p.down) return 'Vote up if this matches what the instructor said. Vote down if something is wrong, and say what in a comment.';
  const verdict = score >= 3 ? ' Confirmed by classmates.' : score <= -2 ? ' Classmates think something is off. Check the comments.' : '';
  return `${p.up} up · ${p.down} down.${verdict}`;
}
// Done is shared: it happens when the due time passes, or early when enough classmates agree.
function doneBox(d) {
  const p = d.post;
  const n = d.doneThreshold;
  const voters = d.doneVoters || [];
  const passed = p.dueAt && Date.parse(p.dueAt) <= Date.now();
  if (passed || p.doneBy === 'time') {
    return html`<section class="panel rail-card donebox is-done" aria-label="Done">
      <div class="donebox-head">${icon('check')}<span>Done</span></div>
      <p class="vote-help">The due time has passed, so this is done for the whole class.</p>
    </section>`;
  }
  if (p.doneBy === 'votes') {
    return html`<section class="panel rail-card donebox is-done" aria-label="Done">
      <div class="donebox-head">${icon('check')}<span>Done</span></div>
      <p class="vote-help">${voters.length} classmates agreed it's done: ${voters.map(v => v.name).join(', ')}.</p>
    </section>`;
  }
  const left = Math.max(0, n - voters.length);
  // Gray while nobody has voted, yellow once someone has, green when it's done.
  return html`<section class="panel rail-card donebox ${voters.length ? 'is-some' : ''}" aria-label="Mark as done">
    <div class="donebox-top"><h2 class="section-title">Is it done?</h2><span class="num">${voters.length} of ${n}</span></div>
    <div class="delbar donebar" style="--n:${n}" aria-hidden="true">${Array.from({ length: n }, (_, i) => html`<span class="${i < voters.length ? 'on' : ''}"></span>`)}</div>
    ${voters.length ? html`<div class="who">Agreed so far: ${voters.map(v => v.name).join(', ')}</div>` : ''}
    ${p.myDone
      ? html`<button class="btn btn-block btn-vote" type="button" data-action="toggle-done" data-id="${p.id}" data-done="0">Take back my vote</button>`
      : html`<button class="btn btn-block ${voters.length ? 'btn-vote' : ''}" type="button" data-action="toggle-done" data-id="${p.id}" data-done="1">${icon('check')}Mark as done</button>`}
    <p class="vote-help">${voters.length ? (left === 1 ? 'One more student' : `${left} more students`) : `${n} students`} must agree before it's done early. It's done for everyone, and leaves Up next. After the due time it's done by itself.</p>
  </section>`;
}
function deleteBox(d) {
  const p = d.post;
  const n = d.threshold;
  const votes = d.deleteVotes;
  const mine = votes.some(v => v.mine);
  const first = votes[0];
  const left = Math.max(0, n - votes.length);
  return html`
  <section class="delbox" aria-label="Deletion vote">
    <div class="delbox-head"><span>Vote to delete</span><span class="num">${votes.length} of ${n}</span></div>
    <div class="delbar" style="--n:${n}" aria-hidden="true">${Array.from({ length: n }, (_, i) => html`<span class="${i < votes.length ? 'on' : ''}"></span>`)}</div>
    ${first && first.reason ? html`<div><q dir="auto">${first.reason}</q><div class="who">${first.student.name} asked ${ago(first.createdAt)}</div></div>` : ''}
    <div class="who">Agreed so far: ${votes.map(v => v.student.name).join(', ')}</div>
    ${mine
      ? html`<button class="btn btn-sm" type="button" data-action="del-withdraw" data-id="${p.id}">Take back my vote</button>`
      : html`<button class="btn btn-danger btn-sm" type="button" data-action="del-agree" data-id="${p.id}">${icon('trash', 'i-sm')}Agree to delete</button>`}
    <p class="hint">${left === 1 ? 'One more vote deletes it.' : `${left} more votes needed.`} If it should stay, don't vote, and say why in the comments.</p>
  </section>`;
}
function deleteForm(p) {
  return html`
  <form class="form del-form" data-form="delete-request" data-id="${p.id}">
    <div class="field"><label class="label" for="del-kind">Why delete it?</label>
      <select class="select" id="del-kind">
        <option value="Duplicate">It's a duplicate</option>
        <option value="Wrong information">The information is wrong</option>
        <option value="Outdated">It's outdated</option>
        <option value="Spam or abuse">Spam or abuse</option>
        <option value="Other">Another reason</option>
      </select></div>
    <div class="field"><label class="label" for="del-note">Details <span class="opt">(optional)</span></label>
      <input class="input" id="del-note" maxlength="150" placeholder="e.g. Same as the post from Monday" dir="auto"></div>
    <p class="hint">It's deleted once ${state.config.deleteVotes} classmates agree, counting you. A wrong date is better fixed with Edit.</p>
    <div class="form-actions"><button class="btn btn-danger btn-sm" type="submit">Start the vote</button><button class="btn btn-ghost btn-sm" type="button" data-action="del-cancel">Cancel</button></div>
  </form>`;
}
function commentItem(c, { threadId, isReply = false }) {
  if (c.deleted) {
    return html`<div class="comment is-deleted ${isReply ? 'is-reply' : ''}" id="c-${c.id}"><span class="avatar is-ghost ${isReply ? 'avatar-sm' : ''}" aria-hidden="true"></span>
      <p class="note">This comment was deleted.</p></div>`;
  }
  const editing = postUi.editing === c.id;
  return html`
  <div class="comment ${isReply ? 'is-reply' : ''}" id="c-${c.id}">
    ${avatar(c.author, isReply ? 'avatar-sm' : '')}
    <div class="comment-main">
      <div class="comment-head"><span class="comment-name">${c.author.name}</span>
        <time class="comment-time" datetime="${c.createdAt}" title="${fullDate(c.createdAt)}">${ago(c.createdAt)}</time>
        ${c.editedAt ? html`<span class="comment-edited" title="Edited ${fullDate(c.editedAt)}">edited</span>` : ''}</div>
      ${editing ? html`
      <form class="comment-edit" data-form="edit-comment" data-id="${c.id}">
        <div class="mention-wrap"><label class="sr-only" for="edit-body-${c.id}">Edit your comment</label>
          <textarea class="textarea" id="edit-body-${c.id}" maxlength="2000" dir="auto">${c.body}</textarea></div>
        <div class="up-list attach-list" id="attach-edit">${postUi.attach.edit.map(u => uploadRow(u, 'edit'))}</div>
        <div class="form-actions"><button class="btn btn-primary btn-sm" type="submit">Save</button>
          ${attachButton('edit')}
          <button class="btn btn-ghost btn-sm" type="button" data-action="cancel-edit-comment">Cancel</button></div>
      </form>` : html`
      ${c.body ? html`<div class="comment-body">${richText(c.body, { mentions: c.mentions })}</div>` : ''}
      ${c.files && c.files.length ? commentFiles(c.files) : ''}
      <div class="comment-actions">
        <button class="linkish-sm" type="button" data-action="reply" data-thread="${threadId}" data-parent="${c.id}" data-name="${isReply && !c.mine ? c.author.name : ''}">${icon('reply', 'i-sm')}Reply</button>
        ${c.mine ? html`<button class="linkish-sm" type="button" data-action="edit-comment" data-id="${c.id}">${icon('edit', 'i-sm')}Edit</button>
        <button class="linkish-sm danger" type="button" data-action="comment-delete" data-id="${c.id}">${icon('trash', 'i-sm')}Delete</button>` : ''}
      </div>`}
    </div>
  </div>`;
}
// Files on a comment: pictures as small previews, everything else as a compact link.
function commentFiles(files) {
  const isImage = f => /^image\/(png|jpeg|gif|webp)$/.test(f.mime);
  const opens = f => /^(image\/|video\/|audio\/|application\/pdf|text\/plain)/.test(f.mime);
  return html`<div class="comment-files">
    ${files.filter(isImage).map(f => html`<a class="comment-thumb" href="${f.url}" target="_blank" rel="noopener" title="${f.name}"><img src="${f.url}" alt="${f.name}" loading="lazy"></a>`)}
    ${files.filter(f => !isImage(f)).map(f => html`<a class="comment-file" href="${f.url}" title="${f.name} · ${sizeText(f.size)}" ${raw(opens(f) ? 'target="_blank" rel="noopener"' : 'download')}><span class="file-icon">${extOf(f.name)}</span><span class="comment-file-name" dir="auto">${f.name}</span><span class="comment-file-size">${sizeText(f.size)}</span></a>`)}
  </div>`;
}
const attachButton = kind => html`<label class="btn btn-ghost btn-sm attach-btn">${icon('clip', 'i-sm')}Attach<input type="file" class="sr-only" data-attach="${kind}" multiple aria-label="Attach files"></label>`;
function renderAttach(kind) {
  const list = $(`#attach-${kind}`);
  if (list) list.innerHTML = postUi.attach[kind].map(u => uploadRow(u, kind).s).join('');
}
function addAttachFiles(kind, fileList) {
  const max = state.config.maxUploadMB * 1048576;
  const list = postUi.attach[kind];
  for (const file of fileList) {
    if (list.length >= 6) { toast('A comment can have at most 6 files.', true); break; }
    const u = { key: 'u' + Math.random().toString(36).slice(2), name: file.name || 'pasted-image.png', size: file.size, status: 'uploading', progress: 0 };
    list.push(u);
    if (file.size > max) { Object.assign(u, { status: 'error', error: `Too large. Files can be at most ${state.config.maxUploadMB} MB.` }); continue; }
    if (!file.size) { Object.assign(u, { status: 'error', error: 'This file is empty.' }); continue; }
    const { promise, xhr } = uploadFile(file, p => { u.progress = p; paintUploadProgress(u); });
    u.xhr = xhr;
    promise
      .then(r => Object.assign(u, { id: r.id, size: r.size, status: 'done' }))
      .catch(err => Object.assign(u, { status: 'error', error: err.message }))
      .finally(() => { u.xhr = null; renderAttach(kind); });
  }
  renderAttach(kind);
}
function clearAttach(kind) {
  for (const u of postUi.attach[kind]) if (u.xhr) u.xhr.abort();
  postUi.attach[kind] = [];
}
// The ids of finished uploads, or null (with a message) while some are still uploading.
function readyAttach(kind) {
  const list = postUi.attach[kind];
  if (list.some(u => u.status === 'uploading')) { toast('Wait until the files finish uploading.', true); return null; }
  return list.filter(u => u.status === 'done').map(u => u.id);
}
function replyForm(threadId, parentId, prefill) {
  return html`
  <form class="reply-form" data-form="reply" data-post="${postUi.postId}" data-parent="${parentId}">
    ${avatar(state.me, 'avatar-sm')}
    <div class="comment-main">
      <div class="mention-wrap"><label class="sr-only" for="reply-body-${threadId}">Write a reply</label>
        <textarea class="textarea" id="reply-body-${threadId}" maxlength="2000" dir="auto" placeholder="Write a reply">${prefill}</textarea></div>
      <div class="up-list attach-list" id="attach-reply">${postUi.attach.reply.map(u => uploadRow(u, 'reply'))}</div>
      <div class="form-actions"><button class="btn btn-primary btn-sm" type="submit">${icon('reply', 'i-sm')}Reply</button>
        ${attachButton('reply')}
        <button class="btn btn-ghost btn-sm" type="button" data-action="cancel-reply">Cancel</button></div>
    </div>
  </form>`;
}
function commentsHtml(d) {
  const p = d.post;
  const threads = d.comments.filter(c => !c.parentId);
  const count = d.comments.filter(c => !c.deleted).length;
  return html`
  <div class="comments-head"><h2 class="section-title">Comments<span class="count">${count}</span></h2></div>
  ${threads.length
    ? html`<div class="comment-list">${threads.map(t => {
      const replies = d.comments.filter(c => c.parentId === t.id);
      const open = postUi.reply && postUi.reply.thread === t.id;
      return html`<div class="thread">${commentItem(t, { threadId: t.id })}
        ${replies.length || open ? html`<div class="replies">${replies.map(r => commentItem(r, { threadId: t.id, isReply: true }))}${open ? replyForm(t.id, postUi.reply.parent, postUi.reply.prefill) : ''}</div>` : ''}
      </div>`;
    })}</div>`
    : html`<p class="note comment-empty">No comments yet. Ask a question or add what you heard in class.</p>`}
  ${!state.me ? html`<div class="guest-cta">${icon('comment')}<span>Sign up to comment, reply and attach files.</span>
    <button class="btn btn-primary btn-sm" type="button" data-action="join">Sign up</button></div>` : html`<form class="composer" data-form="comment" data-id="${p.id}">
    ${avatar(state.me)}
    <div>
      <div class="mention-wrap"><label class="sr-only" for="comment-body">Write a comment</label>
        <textarea class="textarea" id="comment-body" placeholder="Add a comment or ask a question" maxlength="2000" dir="auto"></textarea></div>
      <div class="up-list attach-list" id="attach-comment">${postUi.attach.comment.map(u => uploadRow(u, 'comment'))}</div>
      <div class="composer-foot"><span class="hint">Type @ to mention a classmate · Ctrl + Enter sends</span>
        <div class="composer-btns">${attachButton('comment')}<button class="btn btn-primary btn-sm" type="submit">${icon('comment', 'i-sm')}Comment</button></div></div>
    </div>
  </form>`}`;
}
function postHtml(d) {
  const p = d.post;
  const crumb = html`<a class="crumb" href="#/course/${p.course.id}">${icon('left', 'i-sm')}${courseChip(p.course)}<span dir="auto">${p.course.name}</span></a>`;
  if (p.deleted) {
    return html`${crumb}
    <div class="tombstone">
      <div class="post-tags">${tag(p.type)}<span class="badge badge-delete">${icon('trash')}Deleted</span></div>
      <h1 class="post-title" dir="auto">${p.title}</h1>
      <p class="page-sub">Deleted ${fullDate(p.deletedAt)} after ${plural(d.deleteVotes.length, 'classmate')} agreed.</p>
      ${d.deleteVotes.length ? html`<div class="panel panel-pad mt-20"><div class="mini-list">${d.deleteVotes.map(v => html`
        <div class="mini">${avatar(v.student, 'avatar-sm')}<div><b>${v.student.name}</b>${v.reason ? html`: <span dir="auto">${v.reason}</span>` : ' agreed'}<span class="mini-when">${ago(v.createdAt)}</span></div></div>`)}</div></div>` : ''}
      <div class="form-actions mt-20"><a class="btn" href="#/post/${p.id}/history">${icon('history')}See its versions</a><a class="btn btn-ghost" href="#/course/${p.course.id}">Back to ${p.course.code}</a></div>
    </div>`;
  }
  const now = Date.now();
  const score = p.up - p.down;
  const ch = p.dueChange;
  return html`${crumb}
  <div class="post-layout">
    <article class="post-main">
      <div class="post-tags">${tag(p.type)}
        ${p.version > 1 ? html`<a class="badge badge-edited" href="#/post/${p.id}/history">${icon('history')}Edited · ${plural(p.version, 'version')}</a>` : ''}
        ${recentMove(p) ? html`<span class="badge badge-moved">${icon('arrow')}Date changed</span>` : ''}
        ${score >= 3 ? html`<span class="badge badge-confirmed">${icon('check')}Confirmed by ${p.up}</span>` : score <= -2 ? html`<span class="badge badge-disputed">${icon('alert')}Disputed</span>` : ''}
      </div>
      <h1 class="post-title" dir="auto">${p.title}</h1>
      <div class="byline">${avatar(p.author, 'avatar-sm')}<span>Posted by <b>${p.author.name}</b> · <time datetime="${p.createdAt}" title="${fullDate(p.createdAt)}">${ago(p.createdAt)}</time></span>
        ${p.editor ? html`<span>· Last edited by <b>${p.editor.name}</b> <time datetime="${p.updatedAt}" title="${fullDate(p.updatedAt)}">${ago(p.updatedAt)}</time></span>` : ''}</div>
      ${recentMove(p) ? html`<div class="notice" role="note">${icon('alert')}<div><b>The date changed ${ago(ch.at)}</b> (edited by ${ch.byName}).
        It was <span class="from">${whenText({ ...ch.from, type: p.type })}</span>, now it's <b>${ch.to.dueAt ? whenText({ ...ch.to, type: p.type }) : 'not set'}</b>.
        <a href="#/post/${p.id}/history">Compare versions</a></div></div>` : ''}
      ${factsHtml(p, now)}
      ${p.body ? html`<div class="prose">${richText(p.body)}</div>` : html`<p class="prose-empty">No details yet. If you know more, <a href="#/edit/${p.id}">edit this post</a> and add them.</p>`}
      ${d.files.length ? attachmentsHtml(d.files) : ''}
    </article>
    <aside class="post-rail" aria-label="Actions">
      <section class="panel rail-card">
        <h2 class="section-title">Is this right?</h2>
        <div class="vote" role="group" aria-label="Vote">
          <button class="v-up" type="button" data-action="vote" data-id="${p.id}" data-value="1" aria-pressed="${bool(p.myVote === 1)}" aria-label="Vote up: this is correct" title="This is correct">${icon('vote-up')}</button>
          <span class="score" aria-live="polite">${score}</span>
          <button class="v-down" type="button" data-action="vote" data-id="${p.id}" data-value="-1" aria-pressed="${bool(p.myVote === -1)}" aria-label="Vote down: something is wrong" title="Something is wrong">${icon('vote-down')}</button>
        </div>
        <p class="vote-help">${voteHelp(p)}</p>
      </section>
      ${isTask(p) ? doneBox(d) : ''}
      <section class="panel rail-card">
        <div class="rail-actions">
          <a class="btn btn-ghost" href="#/edit/${p.id}">${icon('edit')}Edit</a>
          <a class="btn btn-ghost" href="#/post/${p.id}/history">${icon('history')}History <span class="muted mono">${p.version}</span></a>
          <button class="btn btn-ghost" type="button" data-action="share" data-id="${p.id}">${icon('link')}Copy link</button>
          ${d.deleteVotes.length ? '' : html`<button class="btn btn-ghost" type="button" data-action="del-start">${icon('trash')}Ask to delete</button>`}
        </div>
        <div id="del-form-slot"></div>
      </section>
      ${d.deleteVotes.length ? deleteBox(d) : ''}
    </aside>
    <section class="post-comments" id="comments" aria-label="Comments">${commentsHtml(d)}</section>
  </div>`;
}
function mountPost(main) {
  for (const ta of $$('.mention-wrap textarea', main)) {
    attachMentions(ta);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.form.requestSubmit(); }
    });
  }
  // Coming from a notification: bring that comment into view once.
  const target = state.route && state.route.query.get('c');
  const el = target && postUi.scrolledTo !== target ? $('#c-' + CSS.escape(target), main) : null;
  if (el) {
    postUi.scrolledTo = target;
    requestAnimationFrame(() => { el.scrollIntoView({ block: 'center' }); el.classList.add('is-target'); });
  }
}
const focusEnd = ta => { if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } };

// @mention suggestions: typing "@" plus the start of a name lists matching classmates.
let studentDir = null;
let studentDirAt = 0;
async function students() {
  if (!studentDir || Date.now() - studentDirAt > 60_000) {
    try { studentDir = await get('/api/students'); studentDirAt = Date.now(); } catch { studentDir = studentDir || []; }
  }
  return studentDir;
}
function attachMentions(ta) {
  const menu = document.createElement('div');
  menu.className = 'mention-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  ta.parentElement.appendChild(menu);
  let items = [];
  let active = 0;
  let range = null;
  const close = () => { menu.hidden = true; items = []; range = null; };
  const render = () => {
    menu.innerHTML = items.map((st, i) => html`<button type="button" class="mention-opt ${i === active ? 'is-active' : ''}" role="option" aria-selected="${bool(i === active)}" data-i="${i}">${avatar(st, 'avatar-sm')}<span>${st.name}</span></button>`.s).join('');
    menu.hidden = !items.length;
  };
  const update = async () => {
    const before = ta.value.slice(0, ta.selectionStart);
    const m = /(^|\s)@([^@\n]{0,30})$/.exec(before);
    if (!m) return close();
    const q = m[2].toLowerCase();
    const list = (await students()).filter(st => st.id !== state.me.id
      && (st.name.toLowerCase().startsWith(q) || st.name.toLowerCase().split(/\s+/).some(w => w.startsWith(q))));
    if (!list.length || ta.value.slice(0, ta.selectionStart) !== before) return close();
    items = list.slice(0, 6);
    active = 0;
    range = { start: before.length - m[2].length - 1, end: before.length };
    render();
  };
  const pick = i => {
    const st = items[i];
    if (!st || !range) return;
    const insert = `@${st.name} `;
    ta.value = ta.value.slice(0, range.start) + insert + ta.value.slice(range.end);
    const pos = range.start + insert.length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    close();
  };
  ta.addEventListener('input', update);
  ta.addEventListener('keydown', e => {
    if (menu.hidden || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      render();
    } else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  ta.addEventListener('blur', () => setTimeout(close, 150));
  menu.addEventListener('mousedown', e => {
    const b = e.target.closest('.mention-opt');
    if (b) { e.preventDefault(); pick(Number(b.dataset.i)); }
  });
}

function googleCalUrl(p) {
  const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  let dates;
  if (!p.hasTime && p.dueDate) {
    dates = `${p.dueDate.replace(/-/g, '')}/${ymd(addDays(new Date(p.dueDate + 'T12:00'), 1)).replace(/-/g, '')}`;
  } else {
    const s = new Date(p.dueAt);
    dates = `${stamp(s)}/${stamp(new Date(s.getTime() + (p.type === 'homework' ? 30 : 60) * 60000))}`;
  }
  const text = `${p.type === 'homework' ? 'Due' : TYPE_LABEL[p.type]}: ${p.title} (${p.course.code})`;
  const details = `${p.body ? p.body.slice(0, 600) + '\n\n' : ''}${location.origin}/#/post/${p.id}`;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(text)}&dates=${dates}&details=${enc(details)}${p.location ? '&location=' + enc(p.location) : ''}`;
}
function downloadIcs(p) {
  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  const stamp = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${appName()}//EN`, 'BEGIN:VEVENT', `UID:${p.id}@cohort`, `DTSTAMP:${stamp(new Date())}`];
  if (!p.hasTime && p.dueDate) {
    lines.push(`DTSTART;VALUE=DATE:${p.dueDate.replace(/-/g, '')}`, `DTEND;VALUE=DATE:${ymd(addDays(new Date(p.dueDate + 'T12:00'), 1)).replace(/-/g, '')}`);
  } else {
    lines.push(`DTSTART:${stamp(new Date(p.dueAt))}`, `DURATION:${p.type === 'homework' ? 'PT30M' : 'PT1H'}`);
  }
  lines.push(`SUMMARY:${esc(`${p.type === 'homework' ? 'Due' : TYPE_LABEL[p.type]}: ${p.title} (${p.course.code})`)}`);
  if (p.location) lines.push(`LOCATION:${esc(p.location)}`);
  lines.push(`DESCRIPTION:${esc(`${p.body ? p.body.slice(0, 600) + '\n\n' : ''}${location.origin}/#/post/${p.id}`)}`);
  lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P1D', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR');
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${p.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 50) || 'event'}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ------------------------------------------------------------------ history
async function viewHistory(route) {
  const data = await get(`/api/posts/${route.params[0]}/history`);
  return { title: `History · ${data.post.title}`, data, html: historyHtml };
}
function snapshotHtml(s) {
  return html`
  <div class="post-tags">${tag(s.type)}</div>
  <h3 class="row-title" dir="auto">${s.title}</h3>
  <div class="row-meta">
    ${s.dueAt ? html`<span>${icon('calendar')}${whenText(s)}</span>` : ''}
    ${s.location ? html`<span>${icon('pin')}<span dir="auto">${s.location}</span></span>` : ''}
    ${s.weight ? html`<span>${icon('percent')}${s.weight}</span>` : ''}
  </div>
  ${s.body ? html`<div class="prose">${richText(s.body)}</div>` : html`<p class="note mt-8">No details.</p>`}
  ${s.files.length ? html`<div class="files mt-12">${s.files.map(f => fileRow({ ...f, url: `/files/${f.id}/${enc(f.name)}` }))}</div>` : ''}`;
}
function diffSnapshots(a, b) {
  const out = [];
  const row = (label, val) => html`<div class="change"><div class="change-label">${label}</div><div class="change-val">${val}</div></div>`;
  const swap = (from, to) => html`${from ? html`<del dir="auto">${from}</del>` : html`<span class="muted">empty</span>`}<span class="arrow">→</span>${to ? html`<ins dir="auto">${to}</ins>` : html`<span class="muted">empty</span>`}`;
  if (a.type !== b.type) out.push(row('Type', html`${tag(a.type)}<span class="arrow">→</span>${tag(b.type)}`));
  if (a.title !== b.title) out.push(row('Title', html`<span dir="auto">${diffWords(a.title, b.title)}</span>`));
  if (a.dueAt !== b.dueAt || a.hasTime !== b.hasTime || a.dueDate !== b.dueDate) {
    out.push(row('Date', swap(a.dueAt ? whenText(a) : '', b.dueAt ? whenText(b) : '')));
  }
  if (a.location !== b.location) out.push(row('Where', swap(a.location, b.location)));
  if (a.weight !== b.weight) out.push(row('Weight', swap(a.weight, b.weight)));
  if (a.body !== b.body) out.push(row('Details', html`<div class="diff" dir="auto">${diffWords(a.body, b.body)}</div>`));
  const ids = list => new Set(list.map(f => f.id));
  const added = b.files.filter(f => !ids(a.files).has(f.id));
  const removed = a.files.filter(f => !ids(b.files).has(f.id));
  if (added.length || removed.length) {
    out.push(row('Files', html`${added.map(f => html`<ins>+ ${f.name}</ins> `)}${removed.map(f => html`<del>− ${f.name}</del> `)}`));
  }
  return out.length ? out : [html`<p class="note">No visible changes.</p>`];
}
function historyHtml({ post, versions }) {
  const edits = versions.length - 1;
  return html`
  <a class="crumb" href="#/post/${post.id}">${icon('left', 'i-sm')}Back to the post</a>
  <div class="page-head"><div>
    <div class="eyebrow">${post.course.code} · Version history</div>
    <h1 class="page-title" dir="auto">${post.title}</h1>
    <p class="page-sub">${edits ? `Edited ${plural(edits, 'time')}. Every version stays here, so nothing is lost when someone edits.` : 'Nobody has edited this post yet.'}</p>
  </div></div>
  <div class="versions">
    ${versions.map((v, i) => {
      const prev = versions[i + 1];
      return html`
      <article class="panel version">
        <div class="version-head">
          <div class="version-num">${v.version === 1 ? 'Original' : `Version ${v.version}`}${i === 0 ? html`<span class="badge badge-new">Current</span>` : ''}</div>
          <div class="byline">${avatar(v.editor, 'avatar-sm')}<span><b>${v.editor.name}</b> · ${fullDate(v.createdAt)}</span></div>
        </div>
        ${v.note ? html`<p class="version-note" dir="auto">“${v.note}”</p>` : ''}
        ${prev ? html`<div class="changes">${diffSnapshots(prev.snapshot, v.snapshot)}</div>` : ''}
        <details class="fold mt-12" ${raw(prev ? '' : 'open')}>
          <summary>${icon('down', 'i-sm')}${prev ? 'Show this version in full' : 'Content'}</summary>
          <div class="fold-body snapshot">${snapshotHtml(v.snapshot)}</div>
        </details>
      </article>`;
    })}
  </div>`;
}

// ------------------------------------------------------------------ editor
async function viewEditor(route) {
  const isEdit = route.name === 'edit';
  const courses = await get('/api/courses');
  let post = null;
  let files = [];
  if (isEdit) {
    const d = await get(`/api/posts/${route.params[0]}`);
    if (d.post.deleted) throw new ApiError(410, 'This post was deleted, so it can no longer be edited.');
    post = d.post;
    files = d.files;
  }
  return {
    title: isEdit ? 'Edit post' : 'New post', data: null, noRefresh: true,
    html: () => editorHtml({ courses, post, query: route.query }),
    mount: main => mountEditor(main, { post, files }),
  };
}
function formValuesFromPost(p) {
  let date = '';
  let time = '';
  if (p.dueAt) {
    if (p.hasTime) { const d = new Date(p.dueAt); date = ymd(d); time = `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
    else date = p.dueDate;
  }
  return { courseId: p.courseId, type: p.type, title: p.title, date, time, location: p.location, weight: p.weight, body: p.body };
}
function editorHtml({ courses, post, query }) {
  const isEdit = !!post;
  const draft = isEdit ? null : store.get('draft', null);
  const v = isEdit ? formValuesFromPost(post) : {
    courseId: query.get('course') || (draft && draft.courseId) || '',
    type: query.get('type') || (draft && draft.type) || '',
    title: (draft && draft.title) || '', date: query.get('date') || (draft && draft.date) || '', time: (draft && draft.time) || '',
    location: (draft && draft.location) || '', weight: (draft && draft.weight) || '', body: (draft && draft.body) || '',
  };
  if (!courses.length) {
    return emptyState('Add a course first', 'Posts belong to a course. Add the course, then post its exams and homework.',
      html`<button class="btn btn-primary" type="button" data-action="add-course">${icon('plus')}Add a course</button>`);
  }
  const tracked = courses.filter(c => c.tracked);
  const others = courses.filter(c => !c.tracked);
  const opt = c => html`<option value="${c.id}" ${raw(c.id === v.courseId ? 'selected' : '')}>${c.code} · ${c.name}</option>`;
  return html`
  <div class="editor">
    <button class="crumb linkish" type="button" data-action="back">${icon('left', 'i-sm')}Back</button>
    <div class="page-head"><div>
      <div class="eyebrow">${isEdit ? `Editing version ${post.version}` : 'New post'}</div>
      <h1 class="page-title">${isEdit ? 'Edit post' : 'Share something with the class'}</h1>
      <p class="page-sub">${isEdit
        ? `Saving makes version ${post.version + 1}. The current version stays in the history, so classmates can compare.`
        : 'Pick the right type. It decides where the post shows up and keeps exams, homework and announcements apart.'}</p>
    </div></div>
    <form class="form" data-form="editor" novalidate>
      <div class="field">
        <label class="label" for="f-course">Course</label>
        <select class="select" id="f-course" ${raw(isEdit ? 'disabled' : '')}>
          <option value="">Choose a course</option>
          ${tracked.length ? html`<optgroup label="Your courses">${tracked.map(opt)}</optgroup>` : ''}
          ${others.length ? html`<optgroup label="${tracked.length ? 'Other courses' : 'All courses'}">${others.map(opt)}</optgroup>` : ''}
        </select>
        <p class="hint">${isEdit ? 'Posts stay in the course they were created in.' : html`Course missing? <button class="linkish" type="button" data-action="add-course">Add it</button>`}</p>
      </div>
      <fieldset class="field">
        <legend class="label">Type</legend>
        <div class="type-picker">${TYPES.map(t => html`
          <div class="type-opt"><input type="radio" name="type" id="f-type-${t}" value="${t}" ${raw(v.type === t ? 'checked' : '')}>
            <label for="f-type-${t}">${tag(t)}<small>${TYPE_HELP[t]}</small></label></div>`)}</div>
      </fieldset>
      <div class="field">
        <label class="label" for="f-title">Title</label>
        <input class="input" id="f-title" maxlength="140" value="${v.title}" placeholder="e.g. Midterm exam" dir="auto" autocomplete="off">
      </div>
      <div id="dup-slot"></div>
      <div class="field-row" id="when-row">
        <div class="field"><label class="label" for="f-date" id="l-date">Date</label><input class="input" type="date" id="f-date" value="${v.date}"></div>
        <div class="field"><label class="label" for="f-time" id="l-time">Time <span class="opt">(optional)</span></label><input class="input" type="time" id="f-time" value="${v.time}"></div>
      </div>
      <p class="hint" id="h-when"></p>
      <div class="field-row" id="where-row">
        <div class="field"><label class="label" for="f-location" id="l-location">Where</label><input class="input" id="f-location" maxlength="120" value="${v.location}" dir="auto" autocomplete="off"></div>
        <div class="field" id="fld-weight"><label class="label" for="f-weight">Weight <span class="opt">(optional)</span></label><input class="input" id="f-weight" maxlength="20" value="${v.weight}" placeholder="e.g. 30%" autocomplete="off"></div>
      </div>
      <div class="field">
        <label class="label" for="f-body">Details <span class="opt">(optional)</span></label>
        <textarea class="textarea" id="f-body" maxlength="8000" dir="auto" placeholder="What's covered, what to bring, how to submit, links…">${v.body}</textarea>
        <p class="hint">Links become clickable. Start lines with “- ” for a list. Wrap words in **double stars** for bold.</p>
      </div>
      <div class="field">
        <span class="label">Files <span class="opt">(optional, up to ${state.config.maxUploadMB} MB each)</span></span>
        <label class="drop" id="drop" for="f-files">${icon('upload')}<span><b>Choose files</b> or drop them here</span><span class="hint">PDFs, slides, documents, images, zip files. You can also paste a screenshot.</span>
          <input type="file" id="f-files" multiple></label>
        <div class="up-list" id="up-list"></div>
      </div>
      ${isEdit ? html`<div class="field"><label class="label" for="f-note">What did you change? <span class="opt">(optional)</span></label>
        <input class="input" id="f-note" maxlength="200" placeholder="e.g. The professor moved the exam in class today" dir="auto" autocomplete="off"></div>` : ''}
      <div id="form-error-slot"></div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit" id="f-submit">${isEdit ? 'Save changes' : 'Post it'}</button>
        <button class="btn btn-ghost" type="button" data-action="back">Cancel</button>
        ${isEdit ? '' : html`<span class="hint" id="draft-note">${draft ? 'Draft restored.' : ''}</span>`}
      </div>
    </form>
  </div>`;
}
const checkedType = () => { const el = $('input[name="type"]:checked'); return el ? el.value : ''; };

function applyType(type) {
  const set = (sel, text) => { const el = $(sel); if (el) el.firstChild.textContent = text; };
  const show = (sel, on) => { const el = $(sel); if (el) el.hidden = !on; };
  const cfg = {
    exam: { date: 'Exam date', time: 'Start time ', where: 'Room or location', wherePh: 'e.g. Hall B', hint: '', weight: true },
    homework: { date: 'Due date', time: 'Due time ', where: 'Where to submit', wherePh: 'e.g. Moodle, by email, in class', hint: 'No time means end of that day.', weight: true },
    announcement: { date: 'Date ', time: 'Time ', where: 'Where ', wherePh: 'e.g. Room 204', hint: 'Add a date if it is about a specific day, like a cancelled lecture.', weight: false },
    material: null,
    '': { date: 'Date', time: 'Time ', where: 'Where', wherePh: '', hint: '', weight: true },
  }[type];
  show('#when-row', !!cfg);
  show('#where-row', !!cfg);
  show('#h-when', !!(cfg && cfg.hint));
  if (!cfg) return;
  set('#l-date', cfg.date);
  set('#l-time', cfg.time);
  set('#l-location', cfg.where);
  $('#f-location').placeholder = cfg.wherePh;
  $('#h-when').textContent = cfg.hint;
  show('#fld-weight', cfg.weight);
  const dateOpt = $('#l-date .opt');
  if (type === 'announcement' && !dateOpt) $('#l-date').insertAdjacentHTML('beforeend', ' <span class="opt">(optional)</span>');
  if (type !== 'announcement' && dateOpt) dateOpt.remove();
  const whereOpt = $('#l-location .opt');
  if (!whereOpt) $('#l-location').insertAdjacentHTML('beforeend', ' <span class="opt">(optional)</span>');
}

function uploadRow(u, kind = '') {
  const pct = Math.round((u.progress || 0) * 100);
  return html`
  <div class="up-item ${u.status === 'error' ? 'is-error' : ''}" data-key="${u.key}">
    <span class="file-icon">${extOf(u.name)}</span>
    <div class="file-main"><div class="file-name" title="${u.name}">${u.name}</div>
      <div class="file-meta">${u.status === 'uploading' ? `Uploading… ${pct}%` : u.status === 'error' ? u.error : sizeText(u.size)}</div></div>
    <button class="icon-btn" type="button" data-action="${kind ? 'attach-remove' : 'remove-upload'}" data-kind="${kind}" data-key="${u.key}" aria-label="Remove ${u.name}">${icon('x')}</button>
    ${u.status === 'uploading' ? html`<span class="progress" style="--p:${pct}%"></span>` : ''}
  </div>`;
}
function renderUploads() {
  const list = $('#up-list');
  if (list && state.editor) list.innerHTML = state.editor.uploads.map(u => uploadRow(u).s).join('');
}
function paintUploadProgress(u) {
  const row = $(`.up-item[data-key="${u.key}"]`);
  if (!row) return;
  const pct = Math.round(u.progress * 100);
  $('.file-meta', row).textContent = `Uploading… ${pct}%`;
  const bar = $('.progress', row);
  if (bar) bar.style.setProperty('--p', pct + '%');
}
function addFiles(fileList) {
  const ed = state.editor;
  const max = state.config.maxUploadMB * 1048576;
  for (const file of fileList) {
    if (ed.uploads.length >= 12) { toast('A post can have at most 12 files.', true); break; }
    const u = { key: 'u' + Math.random().toString(36).slice(2), name: file.name || 'pasted-image.png', size: file.size, status: 'uploading', progress: 0 };
    ed.uploads.push(u);
    if (file.size > max) { Object.assign(u, { status: 'error', error: `Too large. Files can be at most ${state.config.maxUploadMB} MB.` }); continue; }
    if (!file.size) { Object.assign(u, { status: 'error', error: 'This file is empty.' }); continue; }
    const named = file.name ? file : new File([file], u.name, { type: file.type });
    const { promise, xhr } = uploadFile(named, p => { u.progress = p; paintUploadProgress(u); });
    u.xhr = xhr;
    promise
      .then(r => Object.assign(u, { id: r.id, size: r.size, status: 'done' }))
      .catch(err => Object.assign(u, { status: 'error', error: err.message }))
      .finally(() => { u.xhr = null; renderUploads(); });
  }
  renderUploads();
  const input = $('#f-files');
  if (input) input.value = '';
}

let dupTimer = null;
const dupCache = new Map();
async function checkDuplicates() {
  const slot = $('#dup-slot');
  if (!slot || !$('#f-course') || !state.editor || state.editor.post) return;
  const courseId = $('#f-course').value;
  const type = checkedType();
  const title = $('#f-title').value.trim();
  const date = $('#f-date').value;
  if (!courseId || !type || (title.length < 3 && !date)) { slot.innerHTML = ''; return; }
  let posts = dupCache.get(courseId);
  if (!posts) {
    try { posts = (await get(`/api/courses/${courseId}`)).posts; dupCache.set(courseId, posts); } catch { return; }
  }
  const hits = posts.filter(p => p.type === type && ((title.length >= 3 && similarity(p.title, title) >= 0.6) || (date && p.dueAt && dayKeyOf(p) === date))).slice(0, 3);
  slot.innerHTML = hits.length ? html`
    <div class="dup-warn" role="status"><b>Someone may have posted this already</b>
      <ul>${hits.map(p => html`<li><a href="#/post/${p.id}" target="_blank" rel="noopener" dir="auto">${p.title}</a> · ${whenText(p)}</li>`)}</ul>
      <span>If it's the same, vote it up or comment there instead. If the date is wrong there, edit that post.</span></div>`.s : '';
}

function mountEditor(main, { post, files }) {
  const form = $('form[data-form="editor"]', main);
  if (!form) return;
  const isEdit = !!post;
  state.editor = { post, uploads: files.map(f => ({ key: f.id, id: f.id, name: f.name, size: f.size, status: 'done' })) };
  renderUploads();
  applyType(checkedType());
  const saveDraft = () => {
    clearTimeout(state.editor.draftTimer);
    state.editor.draftTimer = setTimeout(() => {
      if (!form.isConnected || state.editor.submitted) return;
      store.set('draft', {
        courseId: $('#f-course').value, type: checkedType(), title: $('#f-title').value, date: $('#f-date').value, time: $('#f-time').value,
        location: $('#f-location').value, weight: $('#f-weight').value, body: $('#f-body').value,
      });
      const note = $('#draft-note');
      if (note) note.textContent = 'Draft saved on this device.';
    }, 600);
  };
  form.addEventListener('change', e => {
    if (e.target.name === 'type') applyType(e.target.value);
    if (e.target.id === 'f-files') addFiles(e.target.files);
    if (e.target.name === 'type' || e.target.id === 'f-course' || e.target.id === 'f-date') checkDuplicates();
    if (!isEdit && e.target.id !== 'f-files') saveDraft();
  });
  form.addEventListener('input', e => {
    if (e.target.id === 'f-title') { clearTimeout(dupTimer); dupTimer = setTimeout(checkDuplicates, 400); }
    if (!isEdit) saveDraft();
  });
  form.addEventListener('paste', e => {
    const pasted = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (pasted.length) { e.preventDefault(); addFiles(pasted); }
  });
  const drop = $('#drop', form);
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('is-over'); }));
  drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));
  checkDuplicates();
}

function composeDue(date, time) {
  if (!date) return { dueAt: null, hasTime: true, dueDate: null };
  if (time) return { dueAt: new Date(`${date}T${time}`).toISOString(), hasTime: true, dueDate: null };
  return { dueAt: new Date(`${date}T23:59`).toISOString(), hasTime: false, dueDate: date };
}

// ------------------------------------------------------------------ calendar
async function viewCalendar(route) {
  const today = new Date();
  const m = /^(\d{4})-(\d{2})$/.exec(route.query.get('m') || '');
  const first = m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : new Date(today.getFullYear(), today.getMonth(), 1);
  const offset = (first.getDay() - firstDayOfWeek() + 7) % 7;
  const gridStart = addDays(first, -offset);
  const monthDays = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((offset + monthDays) / 7);
  const gridEnd = addDays(gridStart, weeks * 7);
  const scope = state.me ? store.get('calScope', 'mine') : 'all';
  const data = await get(`/api/agenda?from=${enc(gridStart.toISOString())}&to=${enc(gridEnd.toISOString())}${scope === 'all' ? '&scope=all' : ''}`);
  const monthKey = ymd(first).slice(0, 7);
  const selected = route.query.get('d') || (ymd(today).startsWith(monthKey) ? ymd(today) : ymd(first));
  const ctx = { first, gridStart, weeks, scope, selected };
  return { title: 'Calendar', data, html: d => calendarHtml(d, ctx), ctx };
}
function dayPanelHtml(posts, day) {
  const items = posts.filter(p => dayKeyOf(p) === day);
  const d = new Date(day + 'T12:00');
  return html`
  <h2 class="section-title">${F.dateYear.format(d)}${items.length ? html`<span class="count">${items.length}</span>` : ''}</h2>
  ${items.length ? html`<div class="list">${items.map(p => postRow(p))}</div>` : html`<p class="note">Nothing on this day.</p>`}
  <a class="btn btn-sm mt-12" href="#/new?date=${day}">${icon('plus', 'i-sm')}Add something on this day</a>`;
}
function calendarHtml(data, ctx) {
  const { first, gridStart, weeks, scope, selected } = ctx;
  const today = ymd(new Date());
  const byDay = new Map();
  for (const p of data.posts) {
    const k = dayKeyOf(p);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(p);
  }
  const prev = new Date(first.getFullYear(), first.getMonth() - 1, 1);
  const next = new Date(first.getFullYear(), first.getMonth() + 1, 1);
  const cells = Array.from({ length: weeks * 7 }, (_, i) => {
    const date = addDays(gridStart, i);
    const key = ymd(date);
    const items = byDay.get(key) || [];
    const out = date.getMonth() !== first.getMonth();
    const label = `${F.date.format(date)}${items.length ? ': ' + items.map(p => `${TYPE_LABEL[p.type]} ${p.title}`).join('; ') : ''}`;
    return html`<button type="button" class="cal-cell ${out ? 'is-out' : ''} ${key === today ? 'is-today' : ''} ${key === selected ? 'is-selected' : ''}"
      data-action="cal-day" data-day="${key}" aria-label="${label}" aria-pressed="${bool(key === selected)}">
      <span class="cal-dom">${date.getDate()}</span>
      ${items.slice(0, 3).map(p => html`<span class="cal-item t-${p.type} cc-${colorOf(p.course.color)} ${p.done ? 'is-done' : ''}"><span dir="auto">${p.title}</span></span>`)}
      ${items.length > 3 ? html`<span class="cal-more">+${items.length - 3} more</span>` : ''}
      ${items.length ? html`<span class="cal-dots">${items.slice(0, 4).map(p => html`<i class="cc-${colorOf(p.course.color)}"></i>`)}</span>` : ''}
    </button>`;
  });
  const dows = Array.from({ length: 7 }, (_, i) => F.dow.format(addDays(gridStart, i)));
  const feed = state.me ? `${location.origin}/cal/${state.me.feedToken}.ics` : '';
  const webcal = feed.replace(/^https?:/, 'webcal:');
  return html`
  <div class="page-head">
    <div><div class="eyebrow">Calendar</div><h1 class="page-title">Deadlines by month</h1></div>
    ${state.me ? html`<div class="chips" role="group" aria-label="Courses shown">
      <button class="chip" type="button" data-action="cal-scope" data-value="mine" aria-pressed="${bool(scope === 'mine')}">My courses</button>
      <button class="chip" type="button" data-action="cal-scope" data-value="all" aria-pressed="${bool(scope === 'all')}">All courses</button>
    </div>` : ''}
  </div>
  <div class="cal-layout">
    <div>
      <div class="cal-toolbar">
        <h2 class="cal-month">${F.monthYear.format(first)}</h2>
        <div class="cal-nav">
          <a class="btn btn-sm" href="#/calendar?m=${ymd(prev).slice(0, 7)}" aria-label="Previous month">${icon('left', 'i-sm')}</a>
          <a class="btn btn-sm" href="#/calendar">Today</a>
          <a class="btn btn-sm" href="#/calendar?m=${ymd(next).slice(0, 7)}" aria-label="Next month">${icon('right', 'i-sm')}</a>
        </div>
      </div>
      <div class="panel cal">
        <div class="cal-dows" aria-hidden="true">${dows.map(d => html`<div>${d}</div>`)}</div>
        <div class="cal-grid">${cells}</div>
      </div>
    </div>
    <aside>
      <section class="panel panel-pad day-panel" id="day-panel">${dayPanelHtml(data.posts, selected)}</section>
      ${feed ? html`<section class="panel panel-pad sub-panel">
        <h2 class="section-title">Get it in your phone's calendar</h2>
        <p class="note">Subscribe once. Every exam and homework from the courses you track appears in your calendar app, with a reminder the day before, and changes sync on their own.</p>
        <div class="feed-url mt-12"><label class="sr-only" for="feed-url">Your calendar link</label><input class="input" id="feed-url" readonly value="${feed}">
          <button class="btn btn-sm" type="button" data-action="copy" data-copy="${feed}">${icon('copy', 'i-sm')}Copy</button></div>
        <div class="steps">
          <div><b>Google Calendar:</b> <a href="https://calendar.google.com/calendar/r?cid=${enc(webcal)}" target="_blank" rel="noopener">add it here</a>, or on a computer open Other calendars → + → From URL and paste the link.</div>
          <div><b>iPhone or Mac:</b> <a href="${webcal}">subscribe in Apple Calendar</a>, or go to Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar.</div>
          <div><b>Outlook:</b> Add calendar → Subscribe from web, then paste the link.</div>
        </div>
        <p class="hint mt-12">The link is personal: it follows the courses you track. Calendar apps check it every few hours, so ${appName()} itself always has the latest.</p>
      </section>` : ''}
    </aside>
  </div>`;
}

// ------------------------------------------------------------------ activity
async function viewActivity() {
  const scope = state.me ? store.get('actScope', 'mine') : 'all';
  const r = await get(`/api/activity?scope=${scope}`);
  return { title: 'Activity', data: { items: r.items, end: r.items.length < 50 }, html: d => activityHtml(d, scope) };
}
function activityHtml(data, scope) {
  const today = ymd(new Date());
  const yesterday = ymd(addDays(new Date(), -1));
  const days = [];
  for (const a of data.items) {
    const k = ymd(new Date(a.createdAt));
    if (!days.length || days[days.length - 1].key !== k) days.push({ key: k, items: [] });
    days[days.length - 1].items.push(a);
  }
  const dayLabel = k => (k === today ? 'Today' : k === yesterday ? 'Yesterday' : F.dateYear.format(new Date(k + 'T12:00')));
  return html`
  <div class="page-head">
    <div><div class="eyebrow">Activity</div><h1 class="page-title">What changed</h1>
      <p class="page-sub">Every post, edit, comment and deletion vote, newest first. Date changes are marked so you never miss a moved deadline.</p></div>
    <div class="chips" role="group" aria-label="Courses shown">
      ${state.me ? html`<button class="chip" type="button" data-action="act-scope" data-value="mine" aria-pressed="${bool(scope === 'mine')}">My courses</button>
      <button class="chip" type="button" data-action="act-scope" data-value="all" aria-pressed="${bool(scope === 'all')}">All courses</button>` : ''}
    </div>
  </div>
  <div class="feed">
    ${days.length ? days.map(d => html`
      <section class="feed-day"><h2 class="section-title">${dayLabel(d.key)}</h2>
        ${d.items.map(a => html`
        <div class="feed-item">
          ${a.actor ? avatar(a.actor) : html`<span class="feed-icon">${icon('trash', 'i-sm')}</span>`}
          <div><div class="feed-text">${activitySentence(a)} ${a.course ? courseChip(a.course, { link: true }) : ''}</div>${activityExtra(a)}</div>
          <time class="feed-time" datetime="${a.createdAt}" title="${fullDate(a.createdAt)}">${F.time.format(new Date(a.createdAt))}</time>
        </div>`)}
      </section>`)
      : emptyState('Nothing here yet', scope === 'mine' ? 'Activity from the courses you track shows up here.' : 'Nobody has posted anything yet.')}
    ${!data.end && data.items.length ? html`<div><button class="btn" type="button" data-action="load-more">Load older activity</button></div>` : ''}
  </div>`;
}

// ------------------------------------------------------------------ search
async function viewSearch(route) {
  const q = (route.query.get('q') || '').trim();
  const data = q.length >= 2 ? await get(`/api/search?q=${enc(q)}`) : { posts: [], courses: [] };
  return { title: q ? `Search: ${q}` : 'Search', data, html: d => searchHtml(d, q), mount: mountSearch, noRefresh: true };
}
function searchResultsHtml(data, q) {
  if (q.length < 2) return html`<p class="note">Type at least two letters. Search covers post titles, details and places, plus course codes, names and instructors.</p>`;
  if (!data.posts.length && !data.courses.length) return emptyState(`Nothing found for “${q}”`, 'Try a course code, a word from the title, or the instructor’s name.');
  return html`
    ${data.courses.length ? html`<section><h2 class="section-title">Courses<span class="count">${data.courses.length}</span></h2><div class="course-grid">${data.courses.map(courseCard)}</div></section>` : ''}
    ${data.posts.length ? html`<section><h2 class="section-title">Posts<span class="count">${data.posts.length}</span></h2>
      <div class="list">${data.posts.map(p => postRow(p, { titleHtml: raw(highlight(p.title, q)) }))}</div></section>` : ''}`;
}
function searchHtml(data, q) {
  return html`
  <div class="search-page">
    <div class="page-head"><div><div class="eyebrow">Search</div><h1 class="page-title">Find a post or course</h1></div></div>
    <div class="filter-input">${icon('search')}<label class="sr-only" for="search-q">Search</label>
      <input class="input" id="search-q" type="search" value="${q}" placeholder="Search posts and courses" autocomplete="off" dir="auto"></div>
    <div class="stack" id="search-results">${searchResultsHtml(data, q)}</div>
  </div>`;
}
function mountSearch(main) {
  const input = $('#search-q', main);
  if (!input) return;
  if (!input.value) input.focus();
  let timer = null;
  let seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      history.replaceState(null, '', q ? `#/search?q=${enc(q)}` : '#/search');
      const mySeq = ++seq;
      let data = { posts: [], courses: [] };
      if (q.length >= 2) {
        try { data = await get(`/api/search?q=${enc(q)}`); } catch (err) { toast(err.message, true); return; }
      }
      if (mySeq === seq) $('#search-results').innerHTML = searchResultsHtml(data, q).s;
    }, 250);
  });
}

// ------------------------------------------------------------------ dialogs & toasts
const dlg = () => $('#dlg');
function openDialog(title, body) {
  const d = dlg();
  d.innerHTML = html`<div class="dlg-head"><h2 class="dlg-title" id="dlg-title">${title}</h2>
    <button class="icon-btn" type="button" data-action="close-dialog" aria-label="Close">${icon('x')}</button></div>
    <div class="dlg-body">${body}</div>`.s;
  if (!d.open) d.showModal();
}
function closeDialog() { if (dlg().open) dlg().close(); }

function toast(message, isError = false) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' is-error' : '');
  el.setAttribute('role', isError ? 'alert' : 'status');
  el.innerHTML = html`${icon(isError ? 'alert' : 'check')}<span>${message}</span>`.s;
  (dlg().open ? dlg() : box).appendChild(el);
  if (dlg().open) { el.style.position = 'fixed'; el.style.left = '50%'; el.style.bottom = '24px'; el.style.translate = '-50% 0'; el.style.zIndex = '70'; }
  setTimeout(() => el.remove(), isError ? 6000 : 3200);
}
const toastError = err => toast(err.message || 'Something went wrong.', true);

function showFormError(slotSel, message) {
  const slot = $(slotSel);
  if (!slot) return;
  slot.innerHTML = message ? html`<div class="form-error" role="alert">${icon('alert')}<span>${message}</span></div>`.s : '';
}
function busy(form, on) {
  const btn = $('[type="submit"]', form);
  if (btn) btn.disabled = on;
}
function armed(el, label) {
  if (el.classList.contains('is-armed')) return true;
  const original = el.innerHTML;
  el.classList.add('is-armed');
  el.textContent = label;
  setTimeout(() => { if (el.isConnected) { el.classList.remove('is-armed'); el.innerHTML = original; } }, 4000);
  return false;
}
async function copyText(text, message = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    (dlg().open ? dlg() : document.body).appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    if (ok) toast(message); else toast('Copying is blocked here. Select the text and copy it yourself.', true);
  }
}

function courseDialog(course) {
  const isEdit = !!course;
  const used = new Set((state.view && Array.isArray(state.view.data) ? state.view.data : []).map(c => c.color));
  const pick = (course && course.color) || COLORS.find(c => !used.has(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];
  openDialog(isEdit ? `Edit ${course.code}` : 'Add a course', html`
    <form class="form" data-form="course" data-id="${isEdit ? course.id : ''}">
      <div class="field-row">
        <div class="field"><label class="label" for="c-code">Course code</label><input class="input" id="c-code" maxlength="20" value="${isEdit ? course.code : ''}" placeholder="e.g. CS 512" autocomplete="off"></div>
        <div class="field"><label class="label" for="c-instructor">Instructor <span class="opt">(optional)</span></label><input class="input" id="c-instructor" maxlength="80" value="${isEdit ? course.instructor : ''}" placeholder="e.g. Dr. Haddad" dir="auto" autocomplete="off"></div>
      </div>
      <div class="field"><label class="label" for="c-name">Course name</label><input class="input" id="c-name" maxlength="100" value="${isEdit ? course.name : ''}" placeholder="e.g. Advanced Machine Learning" dir="auto" autocomplete="off"></div>
      <fieldset class="field"><legend class="label">Color</legend>
        <div class="swatches">${COLORS.map(c => html`<label class="swatch cc-${c}" title="${c}"><input type="radio" name="c-color" value="${c}" aria-label="${c}" ${raw(c === pick ? 'checked' : '')}><span></span></label>`)}</div>
        <p class="hint">Helps you tell courses apart in lists and the calendar.</p>
      </fieldset>
      <div id="course-error"></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">${isEdit ? 'Save' : 'Add course'}</button><button class="btn btn-ghost" type="button" data-action="close-dialog">Cancel</button></div>
    </form>`);
  $('#c-code').focus();
}

const keyBox = key => html`<div class="key-box"><span class="k">${key}</span><button class="btn btn-sm" type="button" data-action="copy" data-copy="${key}">${icon('copy', 'i-sm')}Copy</button></div>`;
const pwField = (id, label, autocomplete, hint = '') => html`
  <div class="field"><label class="label" for="${id}">${label}</label>
    <div class="pw-wrap"><input class="input" id="${id}" type="password" autocomplete="${autocomplete}" maxlength="200" spellcheck="false" autocapitalize="off">
      <button class="pw-toggle" type="button" data-action="toggle-pw" data-for="${id}" aria-label="Show password">Show</button></div>
    ${hint ? html`<p class="hint">${hint}</p>` : ''}</div>`;
// A hidden username lets password managers save the password under the right account.
const pwUsername = () => html`<input class="sr-only" type="text" autocomplete="username" value="${state.me.name}" tabindex="-1" aria-hidden="true">`;

// Android browsers offer a real install prompt; on iPhone it only exists in Safari's Share menu.
let installEvent = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; });
window.addEventListener('appinstalled', () => { installEvent = null; });
const UA = navigator.userAgent;
const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/.test(UA);
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const canAddToHome = () => (IS_IOS || IS_ANDROID) && !isInstalled();
const installButton = (cls = '') => (canAddToHome()
  ? html`<button class="btn ${cls}" type="button" data-action="install">${icon('phone', 'i-sm')}Add to home screen</button>` : '');
function installSteps() {
  if (IS_IOS) {
    return html`<ol class="steps-list">
      <li>Tap <b>Share</b> ${icon('ios-share', 'i-inline')} in Safari's toolbar: at the bottom on iPhone, top right on iPad.</li>
      <li>Scroll down and tap <b>Add to Home Screen</b>.</li>
      <li>Tap <b>Add</b>. ${appName()} now opens from your home screen like an app.</li>
    </ol>
    <p class="hint">Opened the link inside WhatsApp or another app? Open it in Safari first. The app asks you to sign in once.</p>`;
  }
  return html`<ol class="steps-list">
      <li>Tap the menu <b>⋮</b> in the top corner of your browser.</li>
      <li>Tap <b>Add to Home screen</b> or <b>Install app</b>.</li>
      <li>Tap <b>Add</b> or <b>Install</b>.</li>
    </ol>
    <p class="hint">Opened the link inside WhatsApp or another app? Open it in Chrome first.</p>`;
}
async function addToHome() {
  if (installEvent) {
    const ev = installEvent;
    installEvent = null;
    closeDialog();
    ev.prompt();
    const choice = await ev.userChoice.catch(() => null);
    if (choice && choice.outcome === 'accepted') toast(`${appName()} is on your home screen.`);
    return;
  }
  openDialog('Add to your home screen', html`${installSteps()}
    <div class="form-actions"><button class="btn btn-primary" type="button" data-action="close-dialog">Done</button></div>`);
}

function profileDialog() {
  const me = state.me;
  const theme = currentTheme();
  const invite = `${location.origin}/`;
  openDialog('Your profile', html`
    <section class="dlg-section">
      <div class="who-row">${avatar(me, 'avatar-lg')}<div><b>${me.name}</b><div class="hint">Joined ${fullDate(me.createdAt)}</div></div></div>
    </section>
    <section class="dlg-section">
      <h3>Username</h3>
      <form class="inline-form" data-form="rename"><label class="sr-only" for="p-name">Username</label>
        <input class="input" id="p-name" maxlength="40" value="${me.name}" dir="auto" autocomplete="off" spellcheck="false"><button class="btn btn-sm" type="submit">Rename</button></form>
      <p class="hint">You sign in with this name, and classmates see it on your posts.</p>
    </section>
    <section class="dlg-section">
      <h3>Password</h3>
      ${me.hasPassword ? '' : html`<p class="hint">You don't have a password yet. Set one to sign in on any device.</p>`}
      <form class="form form-tight" data-form="change-password">
        ${pwUsername()}
        ${pwField('p-new', 'New password', 'new-password', 'At least 8 characters.')}
        ${pwField('p-confirm', 'Confirm new password', 'new-password')}
        <div id="pw-error"></div>
        <div><button class="btn btn-sm" type="submit">${me.hasPassword ? 'Change password' : 'Set password'}</button></div>
      </form>
    </section>
    <section class="dlg-section">
      <h3>Device key</h3>
      <p class="hint">Your device key gets you back in if you forget your password. You saw it when you created your account. Lost it? Make a new one; the old key stops working.</p>
      <div id="new-key-slot"><button class="btn btn-sm" type="button" data-action="new-device-key">${icon('key', 'i-sm')}Make a new device key</button></div>
    </section>
    <section class="dlg-section">
      <h3>Invite classmates</h3>
      <p class="hint">Share this link in your class group.${state.config.joinCodeRequired ? ' They will also need the class code.' : ''}</p>
      <div class="feed-url"><input class="input" readonly value="${invite}" aria-label="Invite link"><button class="btn btn-sm" type="button" data-action="copy" data-copy="${invite}">${icon('copy', 'i-sm')}Copy</button></div>
    </section>
    <section class="dlg-section">
      <h3>Appearance</h3>
      <div class="seg" role="group" aria-label="Theme">${['system', 'light', 'dark'].map(t => html`<button type="button" data-action="theme" data-value="${t}" aria-pressed="${bool(theme === t)}">${icon(t === 'system' ? 'monitor' : t === 'light' ? 'sun' : 'moon', 'i-sm')}${t[0].toUpperCase() + t.slice(1)}</button>`)}</div>
    </section>
    <section class="dlg-section">
      <h3>Calendar</h3>
      <p class="hint">Get every exam and homework in Google, Apple or Outlook Calendar. <a href="#/calendar" data-action="close-dialog-nav">Set it up</a></p>
    </section>
    <section class="dlg-section">
      ${canAddToHome() ? html`<div>${installButton('btn-sm')}</div><p class="hint">${appName()} then opens like an app, without the browser bars.</p>` : ''}
      <div><button class="btn btn-sm" type="button" data-action="signout">${icon('logout', 'i-sm')}Sign out</button></div>
      ${me.hasPassword ? '' : html`<p class="hint">Set a password first, or you'll need your device key to get back in.</p>`}
    </section>`);
}

function accountCreatedDialog(key) {
  openDialog('Save your device key', html`
    <p>Welcome, <b>${state.me.name}</b>. If you ever forget your password, this key gets you back in. Save it now in your notes or as a screenshot: it is shown only once.</p>
    ${keyBox(key)}
    <p class="hint">Keep it private. Lost it? Make a new one any time under your initials at the top.</p>
    <div class="form-actions"><button class="btn btn-primary" type="button" data-action="close-dialog">I saved it</button>${installButton()}</div>`);
}

// After a device-key sign-in (forgotten password) or for accounts made before passwords existed.
function passwordDialog({ reason, key = '' }) {
  const upgrade = reason === 'upgrade';
  openDialog(upgrade ? 'Set a password' : 'Choose a new password', html`
    ${upgrade
      ? html`<p>${appName()} now has sign-in with a username and password. Your username is <b>${state.me.name}</b>. Choose a password so you can sign in on any device.</p>`
      : html`<p>You signed in with your device key. Choose a new password; your other devices will be signed out.</p>`}
    <form class="form form-tight" data-form="change-password" data-then="close">
      ${pwUsername()}
      ${pwField('p-new', 'New password', 'new-password', 'At least 8 characters.')}
      ${pwField('p-confirm', 'Confirm new password', 'new-password')}
      <div id="pw-error"></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Save password</button><button class="btn btn-ghost" type="button" data-action="close-dialog">Later</button></div>
    </form>
    ${upgrade && key ? html`<section class="dlg-section"><h3>Your device key</h3><p class="hint">Save it too: it gets you back in if you forget your password.</p>${keyBox(key)}</section>` : ''}`);
  setTimeout(() => { const el = $('#p-new'); if (el) el.focus(); }, 60);
}

// ------------------------------------------------------------------ welcome
function sampleSheet() {
  const rows = [
    { type: 'exam', title: 'Midterm exam', code: 'CS 512', color: 'teal', days: 2, meta: '10:00 · Hall B · 30%' },
    { type: 'homework', title: 'Problem set 4', code: 'STAT 601', color: 'plum', days: 5, meta: 'End of day · Moodle' },
    { type: 'announcement', title: 'Lecture moved to room 204', code: 'CS 512', color: 'teal', days: 6, meta: 'Tuesday only' },
  ];
  const now = new Date();
  return html`
  <div class="sheet" aria-hidden="true">
    <div class="sheet-head"><span class="eyebrow">Example</span><span class="eyebrow">Up next</span></div>
    ${rows.map(r => {
      const d = addDays(now, r.days);
      return html`<div class="row">
        <div class="date-block"><span class="dow">${F.dow.format(d)}</span><span class="dom">${d.getDate()}</span><span class="mon">${F.mon.format(d)}</span></div>
        <div class="row-main"><div class="row-top">${tag(r.type)}<span class="course-chip cc-${r.color}">${r.code}</span></div>
          <span class="row-title">${r.title}</span><div class="row-meta"><span>${r.meta}</span></div></div>
        <div class="row-side" ${raw(r.days <= 2 ? 'data-urgency="soon"' : '')}><span class="countdown">in ${r.days} d</span></div>
      </div>`;
    })}
  </div>`;
}
function authCard(mode, notice = '') {
  const keep = html`<label class="check"><input type="checkbox" id="a-keep" checked><span>Keep me signed in</span></label>`;
  const note = notice ? html`<div class="form-note" role="status">${icon('check', 'i-sm')}<span>${notice}</span></div>` : '';
  const tabs = html`<div class="seg seg-full" role="group" aria-label="Account">
    <button type="button" data-action="auth-mode" data-mode="signin" aria-pressed="${bool(mode === 'signin')}">Sign in</button>
    <button type="button" data-action="auth-mode" data-mode="register" aria-pressed="${bool(mode === 'register')}">Create account</button></div>`;
  if (mode === 'register') {
    const code = new URLSearchParams(location.search).get('code') || '';
    return html`
    <div><h2>Create your account</h2><p class="page-sub">A username and a password. No email needed.</p></div>
    ${tabs}${note}
    <form class="form" data-form="register" novalidate>
      <div class="field"><label class="label" for="a-user">Username</label>
        <input class="input" id="a-user" maxlength="40" autocomplete="username" autocapitalize="words" spellcheck="false" placeholder="e.g. Yasir A." dir="auto">
        <p class="hint">Classmates see it on your posts. Your first name and a last initial work well.</p></div>
      ${pwField('a-pass', 'Password', 'new-password', 'At least 8 characters.')}
      ${state.config.joinCodeRequired ? html`<div class="field"><label class="label" for="a-code">Class code</label>
        <input class="input input-key" id="a-code" value="${code}" autocomplete="off" spellcheck="false" autocapitalize="off">
        <p class="hint">Ask the classmate who shared the link.</p></div>` : ''}
      ${keep}
      <div id="auth-error"></div>
      <button class="btn btn-primary btn-block" type="submit">Create account</button>
    </form>`;
  }
  if (mode === 'key') {
    return html`
    <div><h2>Use your device key</h2><p class="page-sub">The key you saved when you created your account. After you sign in, choose a new password.</p></div>
    ${note}
    <form class="form" data-form="key-signin" novalidate>
      <div class="field"><label class="label" for="a-key">Device key</label>
        <input class="input input-key" id="a-key" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" autocapitalize="characters"></div>
      ${keep}
      <div id="auth-error"></div>
      <button class="btn btn-primary btn-block" type="submit">Continue</button>
    </form>
    <p class="welcome-switch"><button type="button" data-action="auth-mode" data-mode="signin">Back to sign in</button></p>`;
  }
  return html`
    <div><h2>Welcome back</h2><p class="page-sub">Sign in to see your deadlines.</p></div>
    ${tabs}${note}
    <form class="form" data-form="signin" novalidate>
      <div class="field"><label class="label" for="a-user">Username</label>
        <input class="input" id="a-user" maxlength="40" autocomplete="username" autocapitalize="words" spellcheck="false" value="${store.get('lastUser', '')}" dir="auto"></div>
      ${pwField('a-pass', 'Password', 'current-password')}
      ${keep}
      <div id="auth-error"></div>
      <button class="btn btn-primary btn-block" type="submit">Sign in</button>
    </form>
    <p class="welcome-switch">Forgot your password? <button type="button" data-action="auth-mode" data-mode="key">Use your device key</button></p>`;
}
function focusAuth() {
  if (!matchMedia('(min-width: 861px)').matches) return;
  const user = $('#a-user');
  const el = $('#a-key') || (user && !user.value ? user : $('#a-pass'));
  if (el) el.focus();
}
function showWelcome({ mode, notice = '' } = {}) {
  state.me = null;
  state.guest = false;
  document.title = appName();
  const start = mode || (new URLSearchParams(location.search).get('code') ? 'register' : store.get('lastUser') ? 'signin' : 'register');
  $('#app').innerHTML = html`
  <div class="welcome">
    <section class="welcome-art">
      <span class="brand">${brandMark()}<span>${appName()}</span></span>
      <h1>Every exam and deadline, <em>in one place</em>.</h1>
      <p class="lede">Our class keeps this list together. Anyone can add an exam, homework or announcement, fix a wrong date, and vote on what's right.</p>
      <p class="welcome-skip"><button class="btn" type="button" data-action="browse">Skip for now and look around${icon('arrow', 'i-sm')}</button></p>
      ${sampleSheet()}
    </section>
    <section class="welcome-form"><div class="welcome-card" id="welcome-card">${authCard(start, notice)}</div></section>
  </div>`.s;
  focusAuth();
}
// Guests can read everything but change nothing; any attempt asks them to sign up.
function browseAsGuest() {
  state.me = null;
  state.guest = true;
  store.set('browse', true);
  startApp();
}
function joinPrompt() {
  openDialog('Join your class to take part', html`
    <p>You're looking around as a guest. Create a free account (a username and a password, no email) to post, vote, comment, mark things done and track your courses.</p>
    <div class="form-actions"><button class="btn btn-primary" type="button" data-action="join">Create account</button>
      <button class="btn" type="button" data-action="guest-signin">I have an account</button></div>`);
}
function signedIn(me) {
  state.me = me;
  // A new account keeps the look chosen before signing up; an existing one brings its own.
  if (me.theme) useAccountTheme(me);
  else if (store.get('theme', null)) api('PUT', '/api/me/theme', { theme: currentTheme() }).then(() => { me.theme = currentTheme(); }).catch(() => {});
  state.guest = false;
  store.del('browse');
  store.set('lastUser', me.name);
  clearLegacyKey();
  startApp();
}
function signedOut(notice) {
  closeDialog();
  history.replaceState(null, '', location.pathname);
  showWelcome({ mode: 'signin', notice });
}

// ------------------------------------------------------------------ notifications
const notifs = { items: [], unread: 0, open: false, highlight: new Set() };
const NOTIF_ICON = { post_created: 'plus', date_changed: 'calendar', comment_on_post: 'comment', reply: 'reply', mention: 'at' };

function setTitle() {
  const base = state.view ? `${state.view.title} · ${appName()}` : appName();
  document.title = notifs.unread ? `(${notifs.unread}) ${base}` : base;
}
function paintBell() {
  const badge = $('#notif-count');
  if (!badge) return;
  badge.hidden = !notifs.unread;
  badge.textContent = notifs.unread > 99 ? '99+' : String(notifs.unread);
  $('#notif-btn').setAttribute('aria-label', notifs.unread ? `Notifications, ${notifs.unread} new` : 'Notifications');
  setTitle();
}
function notifSentence(n) {
  const who = html`<b>${n.actor ? n.actor.name : 'Someone'}</b>`;
  const title = html`<b dir="auto">${n.post ? n.post.title : 'a post'}</b>`;
  switch (n.kind) {
    case 'post_created': return html`${who} added ${TYPE_PHRASE[n.post && n.post.type] || 'a post'}: ${title}`;
    case 'date_changed': return n.due && n.due.from && n.due.from.dueAt ? html`${who} changed the date of ${title}` : html`${who} set the date of ${title}`;
    case 'comment_on_post': return html`${who} commented on your post ${title}`;
    case 'reply': return html`${who} replied to your comment on ${title}`;
    case 'mention': return html`${who} mentioned you on ${title}`;
    default: return html`${who} updated ${title}`;
  }
}
function notifItem(n) {
  const type = n.post && n.post.type;
  const href = n.post ? `#/post/${n.post.id}${n.commentId ? '?c=' + n.commentId : ''}` : '#/';
  const due = n.kind === 'date_changed' && n.due;
  return html`
  <a class="notif-item ${!n.read || notifs.highlight.has(n.id) ? 'is-unread' : ''}" href="${href}" data-action="notif-open">
    <span class="notif-ava">${n.actor ? avatar(n.actor, 'avatar-sm') : html`<span class="avatar avatar-sm is-ghost"></span>`}<span class="notif-kind">${icon(NOTIF_ICON[n.kind] || 'bell')}</span></span>
    <span class="notif-body">
      <span class="notif-text">${notifSentence(n)}</span>
      ${due ? html`<span class="notif-move">${due.from && due.from.dueAt ? html`<s>${whenText({ ...due.from, type })}</s> → ` : ''}${due.to && due.to.dueAt ? whenText({ ...due.to, type }) : 'no date'}</span>` : ''}
      ${n.excerpt ? html`<span class="notif-quote" dir="auto">${n.excerpt}</span>` : ''}
      <span class="notif-when">${n.course ? courseChip(n.course) : ''}<span>${ago(n.createdAt)}</span></span>
    </span>
  </a>`;
}
function paintNotifPanel() {
  const panel = $('#notif-panel');
  if (!panel) return;
  const fresh = notifs.items.filter(n => !n.read || notifs.highlight.has(n.id)).length;
  panel.innerHTML = html`
    <div class="notif-head"><h2 class="section-title">Notifications</h2>${fresh ? html`<span class="badge badge-new">${fresh} new</span>` : ''}</div>
    ${notifs.items.length ? html`<div class="notif-list">${notifs.items.map(notifItem)}</div>`
      : html`<p class="note notif-empty">Nothing yet. New posts in your courses, date changes, replies to you and mentions of you show up here.</p>`}`.s;
}
async function loadNotifications() {
  if (!state.me) return;
  try {
    const r = await get('/api/notifications');
    notifs.items = r.items;
    notifs.unread = r.unread;
  } catch { return; }
  paintBell();
  if (notifs.open) paintNotifPanel();
}
let notifTimer = null;
const scheduleNotifRefresh = () => { clearTimeout(notifTimer); notifTimer = setTimeout(loadNotifications, 1500); };

// Opening the bell marks what it shows as read; items stay highlighted until the panel closes.
async function openNotifs() {
  notifs.open = true;
  $('#notif-panel').hidden = false;
  $('#notif-btn').setAttribute('aria-expanded', 'true');
  paintNotifPanel();
  await loadNotifications();
  if (!notifs.open) return;
  const newest = notifs.items[0];
  if (!notifs.unread || !newest) return;
  notifs.items.filter(n => !n.read).forEach(n => notifs.highlight.add(n.id));
  try {
    const r = await api('POST', '/api/notifications/read', { upTo: newest.id });
    notifs.items.forEach(n => { n.read = true; });
    notifs.unread = r.unread;
    paintBell();
  } catch { /* the badge stays until the next try */ }
}
function closeNotifs() {
  if (!notifs.open) return;
  notifs.open = false;
  notifs.highlight = new Set();
  const panel = $('#notif-panel');
  if (panel) panel.hidden = true;
  const btn = $('#notif-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// ------------------------------------------------------------------ shell, routing, live updates
const NAV = [
  { key: 'home', href: '#/', icon: 'next', label: 'Up next' },
  { key: 'courses', href: '#/courses', icon: 'courses', label: 'Courses' },
  { key: 'calendar', href: '#/calendar', icon: 'calendar', label: 'Calendar' },
  { key: 'activity', href: '#/activity', icon: 'activity', label: 'Activity' },
];
const ROUTES = [
  { name: 'home', re: /^\/?$/, view: viewHome, nav: 'home' },
  { name: 'courses', re: /^\/courses$/, view: viewCourses, nav: 'courses' },
  { name: 'course', re: /^\/course\/([\w-]+)$/, view: viewCourse, nav: 'courses' },
  { name: 'post', re: /^\/post\/([\w-]+)$/, view: viewPost, nav: '' },
  { name: 'history', re: /^\/post\/([\w-]+)\/history$/, view: viewHistory, nav: '' },
  { name: 'new', re: /^\/new$/, view: viewEditor, nav: 'new' },
  { name: 'edit', re: /^\/edit\/([\w-]+)$/, view: viewEditor, nav: '' },
  { name: 'calendar', re: /^\/calendar$/, view: viewCalendar, nav: 'calendar' },
  { name: 'activity', re: /^\/activity$/, view: viewActivity, nav: 'activity' },
  { name: 'search', re: /^\/search$/, view: viewSearch, nav: '' },
];

function renderShell() {
  $('#app').innerHTML = html`
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="#/">${brandMark()}<span>${appName()}</span></a>
      <nav class="tabs" aria-label="Main">${NAV.map(n => html`<a href="${n.href}" data-nav="${n.key}">${icon(n.icon)}<span>${n.label}</span></a>`)}</nav>
      <form class="topbar-search" role="search" data-form="search-top">${icon('search')}<label class="sr-only" for="top-q">Search</label>
        <input id="top-q" type="search" placeholder="Search posts and courses" autocomplete="off"><kbd aria-hidden="true">/</kbd></form>
      <div class="topbar-actions">
        <span class="live" id="live" title="Connecting…">Live</span>
        <a class="icon-btn mobile-only" href="#/search" aria-label="Search">${icon('search')}</a>
        ${state.me ? html`<div class="notif" id="notif">
          <button class="icon-btn notif-btn" id="notif-btn" type="button" data-action="toggle-notifs" aria-expanded="false" aria-controls="notif-panel" aria-label="Notifications">${icon('bell')}<span class="notif-count" id="notif-count" hidden></span></button>
          <div class="notif-panel" id="notif-panel" role="region" aria-label="Notifications" hidden></div>
        </div>` : ''}
        ${state.me ? html`<a class="btn btn-primary new-post" href="#/new">${icon('plus')}New post</a>
        <button class="avatar-btn" id="me-btn" type="button" data-action="profile" aria-label="Your profile">${avatar(state.me, 'avatar-lg')}</button>`
        : html`<button class="btn btn-ghost guest-signin" type="button" data-action="guest-signin">Sign in</button>
        <button class="btn btn-primary" type="button" data-action="join">Sign up</button>`}
      </div>
    </div>
  </header>
  ${state.me ? '' : html`<div class="guest-bar" role="note"><span>You're looking around as a guest. Sign up to post, vote, comment and track your courses.</span>
    <button class="linkish" type="button" data-action="join">Create an account</button></div>`}
  <main class="main" id="main" tabindex="-1"></main>
  <nav class="bottombar" aria-label="Main">
    ${NAV.slice(0, 2).map(n => html`<a href="${n.href}" data-nav="${n.key}">${icon(n.icon)}<span>${n.label}</span></a>`)}
    <a href="#/new" class="bb-new" data-nav="new" aria-label="New post"><span class="bb-plus">${icon('plus')}</span><span>Post</span></a>
    ${NAV.slice(2).map(n => html`<a href="${n.href}" data-nav="${n.key}">${icon(n.icon)}<span>${n.label}</span></a>`)}
  </nav>`.s;
}
function updateNav(key) {
  for (const a of $$('[data-nav]')) {
    if (a.dataset.nav === key) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}
function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const i = h.indexOf('?');
  return { path: i < 0 ? h : h.slice(0, i), query: new URLSearchParams(i < 0 ? '' : h.slice(i + 1)) };
}

function captureForm(root) {
  const fields = $$('input[id], textarea[id], select[id]', root)
    .filter(el => el.type !== 'file')
    .map(el => ({ id: el.id, value: el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value }));
  const a = document.activeElement;
  const active = a && a.id && root.contains(a) ? { id: a.id, start: a.selectionStart, end: a.selectionEnd } : null;
  const open = $$('details[id]', root).filter(d => d.open).map(d => d.id);
  return { fields, active, open };
}
function restoreForm(root, snap) {
  for (const f of snap.fields) {
    const el = root.querySelector('#' + CSS.escape(f.id));
    if (!el) continue;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = f.value; else el.value = f.value;
  }
  for (const id of snap.open) { const d = root.querySelector('#' + CSS.escape(id)); if (d) d.open = true; }
  if (snap.active) {
    const el = root.querySelector('#' + CSS.escape(snap.active.id));
    if (el) {
      el.focus({ preventScroll: true });
      try { if (snap.active.start != null) el.setSelectionRange(snap.active.start, snap.active.end); } catch { /* not a text field */ }
    }
  }
}
function paint(view, soft) {
  const main = $('#main');
  const snap = soft ? captureForm(main) : null;
  const openDetails = soft ? $$('details', main).map(d => d.open) : null;
  main.classList.toggle('no-anim', soft);
  main.innerHTML = view.html(view.data).s;
  if (openDetails) $$('details', main).forEach((d, i) => { if (openDetails[i]) d.open = true; });
  if (view.mount) view.mount(main, view.data);
  if (snap) restoreForm(main, snap);
}
function setViewData(data) {
  state.view.data = data;
  state.viewJson = JSON.stringify(data);
  paint(state.view, true);
}

let routeSeq = 0;
async function route({ soft = false } = {}) {
  if (!state.me && !state.guest) return;
  const { path, query } = parseHash();
  let match = null;
  for (const r of ROUTES) {
    const m = r.re.exec(path);
    if (m) { match = { ...r, params: m.slice(1), query }; break; }
  }
  if (!match) { location.replace('#/'); return; }
  if (!state.me && (match.name === 'new' || match.name === 'edit')) {
    if (state.route) history.back(); else location.replace('#/');
    joinPrompt();
    return;
  }
  const samePage = state.route && state.route.name === match.name && state.route.params.join() === match.params.join();
  if (!soft) closeNotifs();
  state.route = match;
  updateNav(match.nav);
  const seq = ++routeSeq;
  const main = $('#main');
  main.setAttribute('aria-busy', 'true');
  try {
    const view = await match.view(match);
    if (seq !== routeSeq) return;
    const json = JSON.stringify(view.data);
    if (soft && json === state.viewJson) return;
    state.view = view;
    state.viewJson = json;
    if (!soft && match.name !== 'new' && match.name !== 'edit') state.editor = null;
    paint(view, soft || samePage);
    setTitle();
    if (!soft && !samePage) {
      window.scrollTo(0, 0);
      main.focus({ preventScroll: true });
    }
  } catch (err) {
    if (seq !== routeSeq || soft) return;
    state.view = null;
    state.viewJson = '';
    main.innerHTML = emptyState(err.status === 404 || err.status === 410 ? "This page isn't here" : "Couldn't load this page", err.message,
      html`<a class="btn" href="#/">Go to Up next</a><button class="btn btn-ghost" type="button" data-action="retry">Try again</button>`).s;
  } finally {
    if (seq === routeSeq) main.removeAttribute('aria-busy');
  }
}
const refreshCurrent = () => route({ soft: true });

// Live updates: the server announces changes by id; the open page refetches when it is affected.
let liveTimer = null;
let pendingRefresh = false;
function isTyping() {
  const a = document.activeElement;
  return !!(a && $('#main') && $('#main').contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'radio');
}
function softRefresh() {
  if (!state.route || (state.view && state.view.noRefresh)) return;
  if (dlg().open || isTyping()) { pendingRefresh = true; return; }
  pendingRefresh = false;
  refreshCurrent();
}
function onLive(evt) {
  if (evt.t !== 'vote') scheduleNotifRefresh();
  const r = state.route;
  if (!r || (!state.me && !state.guest)) return;
  const mine = !state.me || !evt.courseId || state.me.tracked.includes(evt.courseId);
  const relevant = {
    home: mine || evt.t === 'course', calendar: true, activity: true, courses: true,
    course: evt.courseId === r.params[0], post: evt.postId === r.params[0], history: evt.postId === r.params[0],
  }[r.name];
  if (!relevant) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(softRefresh, 700);
}
function connectLive() {
  if (!('EventSource' in window)) return;
  const live = () => $('#live');
  const es = new EventSource('/api/events');
  es.onopen = () => { const el = live(); if (el) { el.classList.add('is-on'); el.title = 'Live: changes from classmates appear on their own'; } };
  es.onerror = () => { const el = live(); if (el) { el.classList.remove('is-on'); el.title = 'Reconnecting…'; } };
  es.onmessage = e => { try { onLive(JSON.parse(e.data)); } catch { /* ignore malformed */ } };
}

function tick() {
  const now = Date.now();
  for (const el of $$('[data-due]')) {
    const p = { dueAt: el.dataset.due, type: el.dataset.type, done: el.dataset.done === '1' };
    el.textContent = countdownLabel(p, now);
    const holder = el.closest('[data-urgency]');
    if (holder) holder.dataset.urgency = urgency(p, now);
  }
  const hero = $('[data-countdown]');
  if (hero) hero.innerHTML = countParts(Date.parse(hero.dataset.countdown) - now).s;
}

// ------------------------------------------------------------------ actions
const actions = {
  async 'toggle-done'(el) {
    const done = el.dataset.done === '1';
    el.disabled = true;
    try {
      const d = await api('PUT', `/api/posts/${el.dataset.id}/done`, { done });
      setViewData(d);
      toast(d.post.done ? 'Done for the whole class.' : done ? 'Your vote was counted.' : 'Your vote was taken back.');
    } catch (err) { el.disabled = false; toastError(err); await refreshCurrent(); }
  },
  async vote(el) {
    const id = el.dataset.id;
    const value = Number(el.dataset.value);
    const p = state.view.data.post;
    const next = p.myVote === value ? 0 : value;
    try {
      const r = await api('PUT', `/api/posts/${id}/vote`, { value: next });
      Object.assign(p, r);
      setViewData(state.view.data);
    } catch (err) { toastError(err); }
  },
  async 'toggle-track'(el) {
    const on = el.getAttribute('aria-pressed') !== 'true';
    el.setAttribute('aria-pressed', bool(on));
    try {
      const r = await api(on ? 'PUT' : 'DELETE', `/api/courses/${el.dataset.id}/track`);
      state.me = r.me;
      toast(on ? `Tracking ${el.dataset.code}. Its deadlines are now in Up next.` : `Stopped tracking ${el.dataset.code}.`);
      refreshCurrent();
    } catch (err) {
      el.setAttribute('aria-pressed', bool(!on));
      toastError(err);
    }
  },
  'home-filter'(el) { store.set('homeFilter', el.dataset.value); paint(state.view, true); },
  'show-done'() { store.set('showDone', true); paint(state.view, true); },
  profile() { profileDialog(); },
  'add-course'() { courseDialog(null); },
  'edit-course'() { courseDialog(state.view.data.course); },
  'close-dialog'() { closeDialog(); },
  'close-dialog-nav'() { closeDialog(); },
  'del-start'() {
    $('#del-form-slot').innerHTML = deleteForm(state.view.data.post).s;
    $('#del-kind').focus();
  },
  'del-cancel'() { $('#del-form-slot').innerHTML = ''; },
  async 'del-agree'(el) {
    el.disabled = true;
    try {
      const d = await api('POST', `/api/posts/${el.dataset.id}/delete-votes`, { reason: '' });
      setViewData(d);
      toast(d.post.deleted ? `Deleted. ${d.deleteVotes.length} classmates agreed.` : 'Your vote is counted.');
    } catch (err) { el.disabled = false; toastError(err); }
  },
  async 'del-withdraw'(el) {
    el.disabled = true;
    try { setViewData(await api('DELETE', `/api/posts/${el.dataset.id}/delete-votes`)); toast('Your vote was taken back.'); }
    catch (err) { el.disabled = false; toastError(err); }
  },
  'toggle-notifs'() { if (notifs.open) closeNotifs(); else openNotifs(); },
  'notif-open'() { closeNotifs(); },
  reply(el) {
    if (!postUi.reply || postUi.reply.thread !== el.dataset.thread) clearAttach('reply');
    postUi.reply = { thread: el.dataset.thread, parent: el.dataset.parent, prefill: el.dataset.name ? `@${el.dataset.name} ` : '' };
    postUi.editing = null;
    paint(state.view, true);
    focusEnd($(`#reply-body-${el.dataset.thread}`));
  },
  browse() { browseAsGuest(); },
  join() { closeDialog(); showWelcome({ mode: 'register' }); },
  'guest-signin'() { closeDialog(); showWelcome({ mode: 'signin' }); },
  'cancel-reply'() { postUi.reply = null; clearAttach('reply'); paint(state.view, true); },
  'attach-remove'(el) {
    const kind = el.dataset.kind;
    const u = postUi.attach[kind].find(x => x.key === el.dataset.key);
    if (!u) return;
    postUi.attach[kind] = postUi.attach[kind].filter(x => x !== u);
    if (u.xhr) u.xhr.abort();
    renderAttach(kind);
  },
  'edit-comment'(el) {
    const c = state.view.data.comments.find(x => x.id === el.dataset.id);
    clearAttach('edit');
    postUi.attach.edit = (c && c.files || []).map(f => ({ key: f.id, id: f.id, name: f.name, size: f.size, status: 'done' }));
    postUi.editing = el.dataset.id;
    postUi.reply = null;
    paint(state.view, true);
    focusEnd($(`#edit-body-${el.dataset.id}`));
  },
  'cancel-edit-comment'() { postUi.editing = null; clearAttach('edit'); paint(state.view, true); },
  async 'comment-delete'(el) {
    if (!armed(el, 'Confirm delete')) return;
    try { await api('DELETE', `/api/comments/${el.dataset.id}`); toast('Comment deleted.'); refreshCurrent(); } catch (err) { toastError(err); }
  },
  copy(el) { copyText(el.dataset.copy); },
  share(el) { copyText(`${location.origin}/#/post/${el.dataset.id}`, 'Link copied. Paste it in your class group.'); },
  ics() { downloadIcs(state.view.data.post); },
  'cal-day'(el) {
    const day = el.dataset.day;
    const ctx = state.view.ctx;
    if (day.slice(0, 7) !== ymd(ctx.first).slice(0, 7)) { location.hash = `#/calendar?m=${day.slice(0, 7)}&d=${day}`; return; }
    ctx.selected = day;
    for (const c of $$('.cal-cell')) { const on = c.dataset.day === day; c.classList.toggle('is-selected', on); c.setAttribute('aria-pressed', bool(on)); }
    $('#day-panel').innerHTML = dayPanelHtml(state.view.data.posts, day).s;
    history.replaceState(null, '', `#/calendar?m=${day.slice(0, 7)}&d=${day}`);
    state.route.query = parseHash().query;
    if (matchMedia('(max-width: 1100px)').matches) $('#day-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },
  'cal-scope'(el) { store.set('calScope', el.dataset.value); route(); },
  'act-scope'(el) { store.set('actScope', el.dataset.value); route(); },
  async 'load-more'(el) {
    const items = state.view.data.items;
    el.disabled = true;
    try {
      const r = await get(`/api/activity?scope=${store.get('actScope', 'mine')}&before=${items[items.length - 1].id}`);
      setViewData({ items: [...items, ...r.items], end: r.items.length < 50 });
    } catch (err) { el.disabled = false; toastError(err); }
  },
  theme(el) {
    const t = el.dataset.value;
    store.set('theme', t);
    applyTheme(t);
    for (const b of $$('[data-action="theme"]')) b.setAttribute('aria-pressed', bool(b.dataset.value === t));
    if (state.me) api('PUT', '/api/me/theme', { theme: t }).then(() => { state.me.theme = t; }).catch(toastError);
  },
  'auth-mode'(el) { $('#welcome-card').innerHTML = authCard(el.dataset.mode).s; focusAuth(); },
  'toggle-pw'(el) {
    const input = $('#' + el.dataset.for);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el.textContent = show ? 'Hide' : 'Show';
    el.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  },
  async 'new-device-key'(el) {
    if (!armed(el, 'Yes, replace my key')) return;
    el.disabled = true;
    try {
      const r = await api('POST', '/api/me/device-key');
      $('#new-key-slot').innerHTML = html`${keyBox(r.key)}<p class="hint">Save it now: it is shown only once. Your old key no longer works.</p>`.s;
    } catch (err) { el.disabled = false; toastError(err); }
  },
  install() { addToHome(); },
  async signout(el) {
    if (!state.me.hasPassword && !armed(el, 'Sign out anyway')) return;
    try { await api('POST', '/api/logout', {}); } catch { /* the session ends here either way */ }
    signedOut('You signed out.');
  },
  back() { if (history.length > 1) history.back(); else location.hash = '#/'; },
  retry() { route(); },
  'remove-upload'(el) {
    const ed = state.editor;
    const u = ed.uploads.find(x => x.key === el.dataset.key);
    if (!u) return;
    ed.uploads = ed.uploads.filter(x => x !== u);
    if (u.xhr) u.xhr.abort();
    renderUploads();
  },
};
const FOLLOW_LINK = new Set(['close-dialog-nav', 'notif-open']);

const forms = {
  async register(f) {
    const username = $('#a-user').value.trim();
    const password = $('#a-pass').value;
    const codeEl = $('#a-code');
    const stop = (msg, sel) => { showFormError('#auth-error', msg); if (sel) $(sel).focus(); };
    if (username.length < 2) return stop('Choose a username of at least 2 characters.', '#a-user');
    if (password.length < 8) return stop('Your password needs at least 8 characters.', '#a-pass');
    if (codeEl && !codeEl.value.trim()) return stop('Enter the class code.', '#a-code');
    busy(f, true);
    try {
      const r = await api('POST', '/api/register', { username, password, code: codeEl ? codeEl.value.trim() : '', keep: $('#a-keep').checked });
      if (location.search) history.replaceState(null, '', location.pathname + location.hash);
      signedIn(r.me);
      accountCreatedDialog(r.key);
    } catch (err) { stop(err.message); busy(f, false); }
  },
  async signin(f) {
    const username = $('#a-user').value.trim();
    const password = $('#a-pass').value;
    if (!username || !password) { showFormError('#auth-error', 'Enter your username and password.'); return; }
    busy(f, true);
    try {
      const r = await api('POST', '/api/login', { username, password, keep: $('#a-keep').checked }, { allow401: true });
      signedIn(r.me);
      toast(`Welcome back, ${firstName(r.me.name)}.`);
    } catch (err) {
      showFormError('#auth-error', err.message);
      busy(f, false);
      $('#a-pass').select();
    }
  },
  async 'key-signin'(f) {
    const key = normalizeKeyInput($('#a-key').value);
    if (key.replace(/-/g, '').length !== 16) { showFormError('#auth-error', 'A device key has 16 letters and numbers, like ABCD-EFGH-JKLM-NPQR.'); return; }
    busy(f, true);
    try {
      const r = await api('POST', '/api/login/key', { key, keep: $('#a-keep').checked }, { allow401: true });
      signedIn(r.me);
      passwordDialog({ reason: 'recover' });
    } catch (err) { showFormError('#auth-error', err.message); busy(f, false); }
  },
  async 'change-password'(f) {
    const password = $('#p-new').value;
    if (password.length < 8) { showFormError('#pw-error', 'The new password needs at least 8 characters.'); $('#p-new').focus(); return; }
    if ($('#p-confirm').value !== password) { showFormError('#pw-error', "The two passwords don't match. Type the same password in both boxes."); $('#p-confirm').focus(); return; }
    const had = state.me.hasPassword;
    busy(f, true);
    try {
      const r = await api('POST', '/api/me/password', { password });
      state.me = r.me;
      if (f.dataset.then === 'close') closeDialog(); else profileDialog();
      toast(had ? 'Password changed. Your other devices were signed out.' : 'Password saved. You can now sign in anywhere.');
    } catch (err) { showFormError('#pw-error', err.message); busy(f, false); }
  },
  async reply(f) {
    const ta = $('textarea', f);
    const body = ta.value.trim();
    const fileIds = readyAttach('reply');
    if (!fileIds) return;
    if (!body && !fileIds.length) { ta.focus(); return; }
    busy(f, true);
    try {
      await api('POST', `/api/posts/${f.dataset.post}/comments`, { body, parentId: f.dataset.parent, fileIds });
      postUi.reply = null;
      postUi.attach.reply = [];
      paint(state.view, true);
      await refreshCurrent();
    } catch (err) { toastError(err); busy(f, false); }
  },
  async 'edit-comment'(f) {
    const ta = $('textarea', f);
    const body = ta.value.trim();
    const fileIds = readyAttach('edit');
    if (!fileIds) return;
    if (!body && !fileIds.length) { ta.focus(); return; }
    busy(f, true);
    try {
      await api('PATCH', `/api/comments/${f.dataset.id}`, { body, fileIds });
      postUi.editing = null;
      postUi.attach.edit = [];
      paint(state.view, true);
      await refreshCurrent();
    } catch (err) { toastError(err); busy(f, false); }
  },
  async comment(f) {
    const ta = $('#comment-body');
    const body = ta.value.trim();
    const fileIds = readyAttach('comment');
    if (!fileIds) return;
    if (!body && !fileIds.length) { ta.focus(); return; }
    busy(f, true);
    try {
      await api('POST', `/api/posts/${f.dataset.id}/comments`, { body, fileIds });
      ta.value = '';
      postUi.attach.comment = [];
      renderAttach('comment');
      ta.blur();
      await refreshCurrent();
      const last = $$('.comment').pop();
      if (last) last.scrollIntoView({ block: 'nearest' });
    } catch (err) { toastError(err); } finally { busy(f, false); }
  },
  async editor(f) {
    const ed = state.editor;
    const isEdit = !!ed.post;
    const type = checkedType();
    const courseId = $('#f-course').value;
    const title = $('#f-title').value.trim();
    const date = $('#f-date').value;
    const time = $('#f-time').value;
    const stop = (msg, sel) => { showFormError('#form-error-slot', msg); if (sel) $(sel).focus(); };
    if (!isEdit && !courseId) return stop('Choose the course this is for.', '#f-course');
    if (!type) return stop('Choose a type: exam, homework, announcement or material.', '#f-type-exam');
    if (title.length < 3) return stop('Give it a title of at least 3 characters.', '#f-title');
    if (type !== 'material' && time && !date) return stop('Add a date for that time, or clear the time.', '#f-date');
    if (ed.uploads.some(u => u.status === 'uploading')) return stop('Wait for the files to finish uploading.');
    showFormError('#form-error-slot', null);
    const due = type === 'material' ? composeDue('', '') : composeDue(date, time);
    const body = {
      courseId, type, title, body: $('#f-body').value, ...due,
      location: $('#f-location').value, weight: $('#f-weight').value,
      fileIds: ed.uploads.filter(u => u.status === 'done').map(u => u.id),
      note: $('#f-note') ? $('#f-note').value : '',
    };
    busy(f, true);
    try {
      const d = isEdit ? await api('PATCH', `/api/posts/${ed.post.id}`, body) : await api('POST', '/api/posts', body);
      ed.submitted = true;
      clearTimeout(ed.draftTimer);
      if (!isEdit) store.del('draft');
      if (!state.me.tracked.includes(d.post.courseId)) state.me.tracked.push(d.post.courseId);
      dupCache.delete(d.post.courseId);
      toast(isEdit ? `Saved as version ${d.post.version}.` : 'Posted. Classmates can see it now.');
      location.hash = `#/post/${d.post.id}`;
    } catch (err) {
      stop(err.message);
      busy(f, false);
    }
  },
  async course(f) {
    const id = f.dataset.id;
    const body = {
      code: $('#c-code').value, name: $('#c-name').value, instructor: $('#c-instructor').value,
      color: (f.querySelector('input[name="c-color"]:checked') || {}).value,
    };
    busy(f, true);
    try {
      const c = await api(id ? 'PATCH' : 'POST', id ? `/api/courses/${id}` : '/api/courses', body);
      closeDialog();
      if (id) { toast('Course details saved.'); refreshCurrent(); return; }
      if (!state.me.tracked.includes(c.id)) state.me.tracked.push(c.id);
      dupCache.clear();
      toast(`${c.code} added. You're tracking it.`);
      if (state.route && (state.route.name === 'new' || state.route.name === 'edit')) {
        const sel = $('#f-course');
        if (sel) { sel.insertAdjacentHTML('beforeend', html`<option value="${c.id}">${c.code} · ${c.name}</option>`.s); sel.value = c.id; }
      } else location.hash = `#/course/${c.id}`;
    } catch (err) {
      $('#course-error').innerHTML = html`<div class="form-error" role="alert">${icon('alert')}<span>${err.message}
        ${err.data && err.data.courseId ? html` <a href="#/course/${err.data.courseId}" data-action="close-dialog-nav">Open it</a>` : ''}</span></div>`.s;
      busy(f, false);
    }
  },
  async rename(f) {
    const name = $('#p-name').value.trim();
    busy(f, true);
    try {
      state.me = await api('PATCH', '/api/me', { name });
      store.set('lastUser', state.me.name);
      $('#me-btn').innerHTML = avatar(state.me, 'avatar-lg').s;
      profileDialog();
      toast(`Your username is now ${state.me.name}. Use it to sign in.`);
    } catch (err) { toastError(err); busy(f, false); }
  },
  async 'delete-request'(f) {
    const kind = $('#del-kind').value;
    const note = $('#del-note').value.trim();
    busy(f, true);
    try {
      const d = await api('POST', `/api/posts/${f.dataset.id}/delete-votes`, { reason: note ? `${kind}: ${note}` : kind });
      setViewData(d);
      toast(d.post.deleted ? 'Deleted.' : `Vote started. ${d.threshold - d.deleteVotes.length} more needed.`);
    } catch (err) { toastError(err); busy(f, false); }
  },
  'search-top'() {
    const q = $('#top-q').value.trim();
    if (q) location.hash = `#/search?q=${enc(q)}`;
  },
};

// ------------------------------------------------------------------ boot
// New visitors start in light mode; a choice is kept on the device and, once signed in, on the account.
const currentTheme = () => store.get('theme', 'light');
function useAccountTheme(me) {
  if (!me || !me.theme) return;
  store.set('theme', me.theme);
  applyTheme(me.theme);
}
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t); else root.removeAttribute('data-theme');
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0C1120' : '#F2F4F7');
}

function startApp() {
  renderShell();
  loadNotifications();
  if (!state.started) {
    state.started = true;
    window.addEventListener('hashchange', () => route());
    connectLive();
    setInterval(tick, 30_000);
    setInterval(loadNotifications, 120_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); softRefresh(); loadNotifications(); } });
    document.addEventListener('click', e => { if (notifs.open && !e.target.closest('#notif')) closeNotifs(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && notifs.open) { closeNotifs(); $('#notif-btn').focus(); } });
    document.addEventListener('focusout', () => setTimeout(() => { if (pendingRefresh && !isTyping()) softRefresh(); }, 60));
    dlg().addEventListener('close', () => { if (pendingRefresh) setTimeout(softRefresh, 60); });
  }
  route();
}

// What a guest may do: move around and read. Everything else asks them to sign up.
const GUEST_ACTIONS = new Set(['home-filter', 'show-done', 'close-dialog', 'close-dialog-nav', 'cal-day', 'load-more', 'copy', 'share', 'ics',
  'theme', 'back', 'retry', 'join', 'guest-signin', 'browse', 'auth-mode', 'toggle-pw']);
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (state.guest && !GUEST_ACTIONS.has(el.dataset.action)) { e.preventDefault(); joinPrompt(); return; }
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (!FOLLOW_LINK.has(el.dataset.action)) e.preventDefault();
  fn(el, e);
});
document.addEventListener('submit', e => {
  const f = e.target;
  const fn = forms[f.dataset.form];
  if (!fn) return;
  e.preventDefault();
  if (state.guest && f.dataset.form !== 'search-top') { joinPrompt(); return; }
  fn(f, e);
});
document.addEventListener('change', e => {
  if (e.target.id === 'show-done') { store.set('showDone', e.target.checked); paint(state.view, true); }
  if (e.target.dataset.attach && postUi.attach[e.target.dataset.attach]) {
    addAttachFiles(e.target.dataset.attach, e.target.files);
    e.target.value = '';
  }
});
document.addEventListener('keydown', e => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  const a = document.activeElement;
  if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
  const input = $('#top-q');
  if (input && input.offsetParent) { e.preventDefault(); input.focus(); }
  else if (state.me || state.guest) { e.preventDefault(); location.hash = '#/search'; }
});
dlg().addEventListener('click', e => { if (e.target === dlg()) closeDialog(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(currentTheme()));

function fatal(message) {
  $('#app').innerHTML = html`<div class="fatal"><h1 class="page-title">Can't load ${appName()}</h1><p class="page-sub">${message}</p></div>`.s;
}
async function boot() {
  applyTheme(currentTheme());
  try {
    state.config = await (await fetch('/api/config')).json();
  } catch {
    $('#app').innerHTML = html`<div class="fatal"><h1 class="page-title">Can't reach the server</h1><p class="page-sub">Check your connection, then reload the page.</p></div>`.s;
    return;
  }
  document.title = appName();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
  try {
    state.me = await api('GET', '/api/me', undefined, { allow401: true });
    useAccountTheme(state.me);
    clearLegacyKey();
    startApp();
    return;
  } catch (err) {
    if (err.status !== 401) { fatal(err.message); return; }
  }
  const old = legacyKey();
  if (old) {
    try {
      const r = await api('POST', '/api/login/key', { key: old, keep: true }, { allow401: true });
      signedIn(r.me);
      if (!r.me.hasPassword) passwordDialog({ reason: 'upgrade', key: old });
      return;
    } catch (err) {
      if (err.status !== 401) { fatal(err.message); return; }
      clearLegacyKey();
    }
  }
  // Someone who chose to look around before keeps doing so, unless they came from an invite link.
  if (store.get('browse', false) && !new URLSearchParams(location.search).get('code')) { browseAsGuest(); return; }
  showWelcome();
}
boot();
