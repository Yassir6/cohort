'use strict';
// Cohort: a shared course board for a class. Zero dependencies, needs Node 22+.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { openDb, usernameKey } = require('./src/db');
const { buildCalendar } = require('./src/ics');

// ---------------------------------------------------------------- config
const config = {
  port: parseInt(process.env.PORT, 10) || 8090,
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')),
  appName: (process.env.APP_NAME || 'Cohort').trim().slice(0, 40) || 'Cohort',
  joinCode: (process.env.JOIN_CODE || '').trim(),
  deleteVotes: Math.max(1, parseInt(process.env.DELETE_VOTES, 10) || 5),
  doneVotes: Math.max(1, parseInt(process.env.DONE_VOTES, 10) || 6),
  maxUploadMB: Math.max(1, parseInt(process.env.MAX_UPLOAD_MB, 10) || 25),
  trustProxy: /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || ''),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
};
const MAX_UPLOAD = config.maxUploadMB * 1024 * 1024;
const UPLOAD_DIR = path.join(config.dataDir, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = openDb(path.join(config.dataDir, 'cohort.db'));

const TYPES = ['exam', 'homework', 'announcement', 'material'];
const COLORS = ['blue', 'teal', 'plum', 'rust', 'olive', 'rose', 'slate', 'gold'];
const MINUTE = 60_000;
const DAY = 86_400_000;

// ---------------------------------------------------------------- helpers
const nowIso = () => new Date().toISOString();
const isoAt = ms => new Date(ms).toISOString();

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
function rid(len = 12) {
  let out = '';
  while (out.length < len) {
    for (const b of crypto.randomBytes(len * 2)) {
      if (b < 248) out += ID_ALPHABET[b % 62]; // 248 = 4 * 62, keeps the draw uniform
      if (out.length === len) break;
    }
  }
  return out;
}

// Device keys: 16 symbols from a 32-letter alphabet (80 bits), shown as XXXX-XXXX-XXXX-XXXX.
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newKey() {
  let s = '';
  for (const b of crypto.randomBytes(16)) s += KEY_ALPHABET[b & 31];
  return s.match(/.{4}/g).join('-');
}
const normalizeKey = k => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashKey = k => crypto.createHash('sha256').update(normalizeKey(k)).digest('hex');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
function fail(status, message, extra) { throw new HttpError(status, message, extra); }

function text(value, field, { min = 0, max, multiline = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') fail(400, `${field} must be text.`);
  let v = value.replace(/\r\n?/g, '\n');
  if (multiline) {
    v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  } else {
    v = v.replace(/[\u0000-\u001F\u007F\s]+/g, ' ').trim();
  }
  if (v.length < min) fail(400, min === 1 ? `${field} is required.` : `${field} needs at least ${min} characters.`);
  if (v.length > max) fail(400, `${field} can be at most ${max} characters.`);
  return v;
}

function isUniqueError(err) { return /UNIQUE constraint failed/i.test(String(err && err.message)); }

const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');

// Passwords: scrypt with a random salt per password, stored as "scrypt$N$r$p$salt$hash".
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scrypt = (password, salt, len, opts) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, len, opts, (err, key) => (err ? reject(err) : resolve(key)));
});
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
// Unknown users still cost one hash, so a wrong username takes as long as a wrong password.
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}`;
async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored || DUMMY_HASH).split('$');
  const expected = Buffer.from(hash || '', 'base64');
  const actual = await scrypt(String(password).normalize('NFKC'), Buffer.from(salt || '', 'base64'), 32, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return !!stored && alg === 'scrypt' && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Sessions live in an HttpOnly cookie. "Keep me signed in" sessions never end until sign-out;
// the others end when the browser closes (session cookie) or after 12 idle hours.
const SESSION_COOKIE = 'cohort_session';
const SESSION_IDLE = 12 * 60 * 60_000;
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60; // the longest browsers keep a cookie; renewed on every visit

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed */ }
  }
  return out;
}
function isHttps(req) {
  return config.publicUrl.startsWith('https://') || !!req.socket.encrypted
    || (config.trustProxy && /^https/i.test(String(req.headers['x-forwarded-proto'] || '')));
}
function sessionCookie(req, token, persistent) {
  return [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', persistent ? `Max-Age=${COOKIE_MAX_AGE}` : '', isHttps(req) ? 'Secure' : '']
    .filter(Boolean).join('; ');
}
const clearedCookie = req => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isHttps(req) ? '; Secure' : ''}`;

function startSession(ctx, student, { persistent, viaKey }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = nowIso();
  const session = { id: rid(16), persistent: !!persistent, viaKey: !!viaKey, token };
  db.run(`INSERT INTO sessions (id, token_hash, student_id, persistent, via_key, created_at, last_used_at, expires_at, user_agent)
          VALUES ($id, $hash, $sid, $persistent, $via, $t, $t, $expires, $ua)`,
  { id: session.id, hash: sha256(token), sid: student.id, persistent: session.persistent, via: session.viaKey, t,
    expires: persistent ? null : isoAt(Date.now() + SESSION_IDLE), ua: String(ctx.req.headers['user-agent'] || '').slice(0, 200) });
  ctx.cookies.push(sessionCookie(ctx.req, token, persistent));
  return session;
}

// ---------------------------------------------------------------- rate limits
const buckets = new Map();
function limit(key, max, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= t) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.n += 1;
  if (b.n > max) fail(429, 'Too many requests. Wait a few minutes and try again.');
}
setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) if (b.reset <= t) buckets.delete(k);
}, MINUTE).unref();

function clientIp(req) {
  if (config.trustProxy && req.headers['x-forwarded-for']) {
    const hops = String(req.headers['x-forwarded-for']).split(',').map(s => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------- responses
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Robots-Tag': 'noindex, nofollow',
  // Served over HTTPS: browsers remember to use HTTPS only and never allow clicking past a certificate warning.
  ...(config.publicUrl.startsWith('https://') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
};
const HTML_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function acceptsGzip(req) { return /\bgzip\b/.test(req.headers['accept-encoding'] || ''); }

function sendJson(req, res, status, data, cookies = []) {
  let body = Buffer.from(JSON.stringify(data));
  const headers = { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (cookies.length) headers['Set-Cookie'] = cookies;
  if (body.length > 1400 && acceptsGzip(req)) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

function sendText(res, status, message) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function readJson(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, 'That request is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch { reject(new HttpError(400, 'The request body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- live updates (server-sent events)
// Events carry ids only, never content, so the stream needs no key.
const streams = new Set();
const streamsPerIp = new Map();
function openStream(req, res, ip) {
  const open = streamsPerIp.get(ip) || 0;
  if (open >= 12 || streams.size >= 2000) { res.writeHead(429); res.end(); return; }
  streamsPerIp.set(ip, open + 1);
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 4000\n\n');
  streams.add(res);
  req.on('close', () => {
    streams.delete(res);
    const n = (streamsPerIp.get(ip) || 1) - 1;
    if (n <= 0) streamsPerIp.delete(ip); else streamsPerIp.set(ip, n);
  });
}
function broadcast(event) {
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const s of streams) s.write(msg);
}
setInterval(() => { for (const s of streams) s.write(': ping\n\n'); }, 25_000).unref();

// ---------------------------------------------------------------- data shapes
function meShape(s, session = null) {
  const tracked = db.all('SELECT course_id FROM tracks WHERE student_id = $id ORDER BY created_at', { id: s.id }).map(r => r.course_id);
  return {
    id: s.id, name: s.name, color: s.color, feedToken: s.feed_token, tracked, prevVisitAt: s.prev_visit_at, createdAt: s.created_at,
    hasPassword: !!s.password_hash, viaKey: !!(session && session.viaKey), theme: s.theme || null,
  };
}
const studentById = id => db.one('SELECT * FROM students WHERE id = $id', { id });

const COURSE_SQL = `SELECT c.*,
  (SELECT COUNT(*) FROM tracks t WHERE t.course_id = c.id) AS followers,
  EXISTS (SELECT 1 FROM tracks t WHERE t.course_id = c.id AND t.student_id = $me) AS tracked,
  (SELECT COUNT(*) FROM posts p WHERE p.course_id = c.id AND p.deleted_at IS NULL AND p.due_at >= $now) AS upcoming,
  (SELECT COUNT(*) FROM posts p WHERE p.course_id = c.id AND p.deleted_at IS NULL) AS post_count
  FROM courses c`;

function courseShape(c, next) {
  return {
    id: c.id, code: c.code, name: c.name, instructor: c.instructor, color: c.color, createdAt: c.created_at,
    followers: c.followers, tracked: !!c.tracked, upcoming: c.upcoming, posts: c.post_count, next: next || null,
  };
}

function nextDueByCourse(now) {
  const rows = db.all(`SELECT * FROM (
      SELECT p.id, p.course_id, p.type, p.title, p.due_at, p.has_time, p.due_date,
             ROW_NUMBER() OVER (PARTITION BY p.course_id ORDER BY p.due_at) AS rn
      FROM posts p WHERE p.deleted_at IS NULL AND p.due_at >= $now AND p.type IN ('exam', 'homework')
    ) WHERE rn = 1`, { now });
  return new Map(rows.map(r => [r.course_id, { id: r.id, type: r.type, title: r.title, dueAt: r.due_at, hasTime: !!r.has_time, dueDate: r.due_date }]));
}

function getCourse(id, meId) {
  const now = nowIso();
  const c = db.one(`${COURSE_SQL} WHERE c.id = $id AND c.archived = 0`, { id, me: meId, now });
  if (!c) fail(404, 'This course does not exist or was archived.');
  return courseShape(c, nextDueByCourse(now).get(id));
}

const POST_FIELDS = `p.id, p.course_id, p.type, p.title, p.due_at, p.has_time, p.due_date, p.location, p.weight,
  p.created_at, p.updated_at, p.version, p.due_change, p.deleted_at, p.created_by, p.last_edited_by,
  substr(p.body, 1, 240) AS excerpt,
  a.name AS author_name, a.color AS author_color,
  e.name AS editor_name, e.color AS editor_color,
  c.code AS course_code, c.name AS course_name, c.color AS course_color,
  (SELECT COUNT(*) FROM votes v WHERE v.post_id = p.id AND v.value = 1) AS up,
  (SELECT COUNT(*) FROM votes v WHERE v.post_id = p.id AND v.value = -1) AS down,
  (SELECT v.value FROM votes v WHERE v.post_id = p.id AND v.student_id = $me) AS my_vote,
  (SELECT COUNT(*) FROM comments m WHERE m.post_id = p.id AND m.deleted_at IS NULL) AS comment_count,
  (SELECT COUNT(*) FROM files f WHERE f.post_id = p.id AND f.removed_at IS NULL) AS file_count,
  (SELECT COUNT(*) FROM delete_votes d WHERE d.post_id = p.id) AS delete_count,
  (SELECT COUNT(*) FROM done x WHERE x.post_id = p.id) AS done_count,
  EXISTS (SELECT 1 FROM done x WHERE x.post_id = p.id AND x.student_id = $me) AS my_done`;
const POST_FROM = `FROM posts p
  JOIN students a ON a.id = p.created_by
  JOIN courses c ON c.id = p.course_id
  LEFT JOIN students e ON e.id = p.last_edited_by`;

// Done is shared by the whole class: once the due time passes, or once enough students agree it's done early.
function doneReason(p, doneCount) {
  if (p.due_at && Date.parse(p.due_at) <= Date.now()) return 'time';
  if (doneCount >= config.doneVotes) return 'votes';
  return null;
}

function postSummary(r) {
  const doneBy = doneReason(r, r.done_count);
  return {
    id: r.id, courseId: r.course_id, type: r.type, title: r.title,
    dueAt: r.due_at, hasTime: !!r.has_time, dueDate: r.due_date, location: r.location, weight: r.weight,
    createdAt: r.created_at, updatedAt: r.updated_at, version: r.version,
    dueChange: r.due_change ? JSON.parse(r.due_change) : null,
    excerpt: r.excerpt,
    author: { id: r.created_by, name: r.author_name, color: r.author_color },
    editor: r.last_edited_by ? { id: r.last_edited_by, name: r.editor_name, color: r.editor_color } : null,
    course: { id: r.course_id, code: r.course_code, name: r.course_name, color: r.course_color },
    up: r.up, down: r.down, myVote: r.my_vote || 0,
    comments: r.comment_count, files: r.file_count, deleteVotes: r.delete_count,
    done: !!doneBy, doneBy, doneVotes: r.done_count, myDone: !!r.my_done,
  };
}

function fileShape(f) {
  return {
    id: f.id, name: f.name, size: f.size, mime: f.mime, createdAt: f.created_at,
    url: `/files/${f.id}/${encodeURIComponent(f.name)}`,
    uploadedBy: f.uploader_name !== undefined ? { id: f.uploaded_by, name: f.uploader_name } : undefined,
  };
}

function deleteVotesFor(postId, meId) {
  return db.all(`SELECT d.*, s.name, s.color FROM delete_votes d JOIN students s ON s.id = d.student_id
                 WHERE d.post_id = $id ORDER BY d.created_at`, { id: postId })
    .map(d => ({ student: { id: d.student_id, name: d.name, color: d.color }, reason: d.reason, createdAt: d.created_at, mine: d.student_id === meId }));
}

function postDetail(id, meId) {
  const row = db.one(`SELECT ${POST_FIELDS}, p.body ${POST_FROM} WHERE p.id = $id`, { id, me: meId });
  if (!row) fail(404, 'This post does not exist.');
  const post = postSummary(row);
  if (row.deleted_at) {
    return {
      post: { id: post.id, type: post.type, title: post.title, course: post.course, author: post.author, createdAt: post.createdAt, deleted: true, deletedAt: row.deleted_at },
      deleteVotes: deleteVotesFor(id, meId), threshold: config.deleteVotes,
    };
  }
  post.body = row.body;
  if (post.dueChange) post.dueChange.byName = (studentById(post.dueChange.by) || {}).name || 'Someone';
  const files = db.all(`SELECT f.*, s.name AS uploader_name FROM files f JOIN students s ON s.id = f.uploaded_by
                        WHERE f.post_id = $id AND f.removed_at IS NULL ORDER BY f.created_at`, { id }).map(fileShape);
  let comments = db.all(`SELECT m.*, s.name, s.color FROM comments m JOIN students s ON s.id = m.student_id
                           WHERE m.post_id = $id AND (m.deleted_at IS NULL
                             OR EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = m.id AND r.deleted_at IS NULL))
                           ORDER BY m.created_at`, { id });
  const byComment = new Map();
  for (const f of db.all(`SELECT f.* FROM files f JOIN comments m ON m.id = f.comment_id
                          WHERE m.post_id = $id AND f.removed_at IS NULL ORDER BY f.created_at`, { id })) {
    if (!byComment.has(f.comment_id)) byComment.set(f.comment_id, []);
    byComment.get(f.comment_id).push(fileShape(f));
  }
  comments = comments.map(m => commentShape(m, meId, byComment.get(m.id)));
  const doneVoters = db.all(`SELECT s.id, s.name, s.color FROM done x JOIN students s ON s.id = x.student_id
                             WHERE x.post_id = $id ORDER BY x.created_at`, { id });
  return { post, files, comments, deleteVotes: deleteVotesFor(id, meId), threshold: config.deleteVotes, doneVoters, doneThreshold: config.doneVotes };
}

function commentShape(m, meId, files) {
  if (m.deleted_at) return { id: m.id, parentId: m.parent_id, createdAt: m.created_at, deleted: true };
  if (!files) files = db.all('SELECT * FROM files WHERE comment_id = $id AND removed_at IS NULL ORDER BY created_at', { id: m.id }).map(fileShape);
  return {
    id: m.id, parentId: m.parent_id, body: m.body, createdAt: m.created_at, editedAt: m.edited_at,
    author: { id: m.student_id, name: m.name, color: m.color }, mine: m.student_id === meId,
    mentions: JSON.parse(m.mentions || '[]'), files,
  };
}

// Files a student just uploaded for a comment or reply; each can be attached once.
function resolveCommentFiles(fileIds, meId) {
  if (fileIds === undefined) return [];
  if (!Array.isArray(fileIds)) fail(400, 'Attachments are not valid.');
  const ids = [...new Set(fileIds.map(String))];
  if (ids.length > 6) fail(400, 'A comment can have at most 6 files.');
  return ids.map(id => {
    const f = db.one('SELECT * FROM files WHERE id = $id', { id });
    if (!f) fail(400, 'One of the files is missing. Upload it again.');
    if (f.uploaded_by !== meId || f.post_id !== null || f.comment_id !== null) fail(400, 'One of the files is already attached somewhere else.');
    return f;
  });
}
const commentExcerpt = (content, files) => (content || `Shared ${files.length === 1 ? files[0].name : `${files.length} files`}`).slice(0, 140);

// "@Name" is a mention when it matches a classmate's full name on word boundaries.
// Longer names are tried first, so "@Sara K." is never also read as "@Sara".
function findMentions(content) {
  const lower = content.toLowerCase();
  const taken = new Set();
  const found = [];
  const wordChar = /[\p{L}\p{N}]/u;
  const students = db.all('SELECT id, name FROM students').sort((a, b) => b.name.length - a.name.length);
  for (const st of students) {
    const needle = '@' + st.name.toLowerCase();
    for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + 1)) {
      if (taken.has(i) || (i > 0 && wordChar.test(lower[i - 1])) || wordChar.test(lower.charAt(i + needle.length))) continue;
      taken.add(i);
      if (!found.some(f => f.id === st.id)) found.push({ id: st.id, name: st.name });
    }
  }
  return found;
}

const trackersOf = courseId => db.all('SELECT student_id FROM tracks WHERE course_id = $c', { c: courseId }).map(r => r.student_id);

// One row per recipient; the person who acted is never notified about their own action.
function notify(recipients, { kind, actorId, courseId, postId, commentId = null, data = {} }) {
  const t = nowIso();
  const json = JSON.stringify(data);
  for (const sid of new Set(recipients)) {
    if (!sid || sid === actorId) continue;
    db.run(`INSERT INTO notifications (student_id, kind, actor_id, course_id, post_id, comment_id, data, created_at)
            VALUES ($sid, $kind, $actor, $course, $post, $comment, $data, $t)`,
    { sid, kind, actor: actorId, course: courseId, post: postId, comment: commentId, data: json, t });
  }
}

function livePost(id) {
  const p = db.one('SELECT * FROM posts WHERE id = $id', { id });
  if (!p) fail(404, 'This post does not exist.');
  if (p.deleted_at) fail(410, 'This post was deleted.');
  return p;
}

function logActivity({ kind, courseId = null, postId = null, studentId = null, data = {} }) {
  db.run(`INSERT INTO activity (kind, course_id, post_id, student_id, data, created_at)
          VALUES ($kind, $course, $post, $student, $data, $t)`,
  { kind, course: courseId, post: postId, student: studentId, data: JSON.stringify(data), t: nowIso() });
}

function activityList({ meId, scope, before, limit: max = 40 }) {
  const where = [];
  if (scope === 'mine') where.push('x.course_id IN (SELECT course_id FROM tracks WHERE student_id = $me)');
  if (before) where.push('x.id < $before');
  const rows = db.all(`SELECT x.*, s.name AS actor_name, s.color AS actor_color, c.code AS course_code, c.color AS course_color
      FROM activity x LEFT JOIN students s ON s.id = x.student_id LEFT JOIN courses c ON c.id = x.course_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY x.id DESC LIMIT $max`, { me: meId, before, max });
  return rows.map(r => ({
    id: r.id, kind: r.kind, createdAt: r.created_at, postId: r.post_id, data: JSON.parse(r.data || '{}'),
    actor: r.student_id ? { id: r.student_id, name: r.actor_name || 'Someone', color: r.actor_color ?? 0 } : null,
    course: r.course_id ? { id: r.course_id, code: r.course_code, color: r.course_color } : null,
  }));
}

// ---------------------------------------------------------------- input
const codeKey = s => s.toLowerCase().replace(/[\s\-_.]/g, '');
function courseInput(body) {
  return {
    code: text(body.code, 'Course code', { min: 1, max: 20 }),
    name: text(body.name, 'Course name', { min: 2, max: 100 }),
    instructor: text(body.instructor, 'Instructor', { max: 80 }),
    color: COLORS.includes(body.color) ? body.color : COLORS[0],
  };
}
function findCourseByCode(code, exceptId) {
  return db.all('SELECT id, code, name FROM courses WHERE archived = 0').find(c => c.id !== exceptId && codeKey(c.code) === codeKey(code));
}

function postInput(body) {
  if (!TYPES.includes(body.type)) fail(400, 'Pick a type: exam, homework, announcement or material.');
  const type = body.type;
  const out = {
    type,
    title: text(body.title, 'Title', { min: 3, max: 140 }),
    body: text(body.body, 'Details', { max: 8000, multiline: true }),
    due_at: null, has_time: 1, due_date: null, location: '', weight: '',
  };
  if (type !== 'material' && body.dueAt) {
    const d = new Date(String(body.dueAt));
    if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2100) fail(400, 'That date is not valid.');
    out.due_at = d.toISOString();
    if (body.hasTime === false) {
      if (typeof body.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)) fail(400, 'That date is not valid.');
      out.has_time = 0;
      out.due_date = body.dueDate;
    }
  }
  if (type !== 'material') out.location = text(body.location, type === 'homework' ? 'Submission' : 'Location', { max: 120 });
  if (type === 'exam' || type === 'homework') out.weight = text(body.weight, 'Weight', { max: 20 });
  return out;
}

function resolveFiles(fileIds, meId, postId) {
  if (!Array.isArray(fileIds)) fail(400, 'Attachments are not valid.');
  const ids = [...new Set(fileIds.map(String))];
  if (ids.length > 12) fail(400, 'A post can have at most 12 files.');
  return ids.map(id => {
    const f = db.one('SELECT * FROM files WHERE id = $id', { id });
    if (!f) fail(400, 'One of the files is missing. Upload it again.');
    const mineUnattached = f.post_id === null && f.comment_id === null && f.uploaded_by === meId;
    if (!mineUnattached && !(postId && f.post_id === postId)) fail(400, 'One of the files belongs to another post.');
    return f;
  });
}

const activeFiles = postId => db.all('SELECT * FROM files WHERE post_id = $id AND removed_at IS NULL ORDER BY created_at', { id: postId });

function snapshotOf(p, files) {
  return JSON.stringify({
    type: p.type, title: p.title, body: p.body, dueAt: p.due_at, hasTime: !!p.has_time, dueDate: p.due_date,
    location: p.location, weight: p.weight, files: files.map(f => ({ id: f.id, name: f.name, size: f.size, mime: f.mime })),
  });
}

const dueOf = p => ({ dueAt: p.due_at, hasTime: !!p.has_time, dueDate: p.due_date });

// ---------------------------------------------------------------- routes
const routes = [];
// guest: visitors without an account may read this route; everything that changes data still needs one.
function route(method, pattern, handler, { auth = true, raw = false, guest = false } = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([A-Za-z0-9_-]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth: auth && !guest, raw });
}
const GUEST_ID = '';

route('GET', '/api/config', () => ({
  appName: config.appName, joinCodeRequired: !!config.joinCode, deleteVotes: config.deleteVotes,
  maxUploadMB: config.maxUploadMB, colors: COLORS,
}), { auth: false });

route('GET', '/api/events', ({ req, res, ip }) => { openStream(req, res, ip); }, { auth: false });

// Accounts: a username (the name classmates see) and a password. The device key from sign-up
// is the way back in after a forgotten password.
const USERNAME_RULES = 'Use 2 to 40 characters with at least 2 letters or numbers, and no @.';
function usernameInput(value) {
  const name = text(value, 'Username', { min: 2, max: 40 });
  if (name.includes('@') || usernameKey(name).length < 2) fail(400, `That username won't work. ${USERNAME_RULES}`);
  return name;
}
function passwordInput(value, field = 'Password') {
  if (typeof value !== 'string' || value.length < 8) fail(400, `${field} needs at least 8 characters.`);
  if (value.length > 200) fail(400, `${field} can be at most 200 characters.`);
  return value;
}
function assertNameFree(name, exceptId = '') {
  if (db.one('SELECT id FROM students WHERE username_key = $k AND id != $except', { k: usernameKey(name), except: exceptId })) {
    fail(409, `The username “${name}” is taken. Add a last initial or a number.`);
  }
}

route('POST', '/api/register', async ctx => {
  const { body, ip } = ctx;
  limit(`register:${ip}`, 12, 60 * MINUTE);
  if (config.joinCode && String(body.code || '').trim().toLowerCase() !== config.joinCode.toLowerCase()) {
    fail(403, "That class code isn't right. Ask the classmate who shared the link.");
  }
  const name = usernameInput(body.username);
  const password = passwordInput(body.password);
  assertNameFree(name);
  const key = newKey();
  const passwordHash = await hashPassword(password);
  const id = rid(12);
  const t = nowIso();
  try {
    db.run(`INSERT INTO students (id, name, username_key, password_hash, key_hash, feed_token, color, created_at, last_active_at)
            VALUES ($id, $name, $ukey, $pw, $hash, $feed, $color, $t, $t)`,
    { id, name, ukey: usernameKey(name), pw: passwordHash, hash: hashKey(key), feed: rid(24), color: crypto.randomInt(12), t });
  } catch (err) {
    if (isUniqueError(err)) fail(409, `The username “${name}” is taken. Add a last initial or a number.`);
    throw err;
  }
  const session = startSession(ctx, { id }, { persistent: body.keep !== false, viaKey: false });
  return { key, me: meShape(studentById(id), session) };
}, { auth: false });

route('POST', '/api/login', async ctx => {
  const { body, ip } = ctx;
  const ukey = usernameKey(typeof body.username === 'string' ? body.username : '');
  limit(`login:${ip}`, 20, 10 * MINUTE);
  limit(`login:${ukey}`, 10, 10 * MINUTE);
  const s = ukey ? db.one('SELECT * FROM students WHERE username_key = $k', { k: ukey }) : null;
  const ok = await verifyPassword(typeof body.password === 'string' ? body.password : '', s && s.password_hash);
  if (!s || !ok) fail(401, 'Wrong username or password.');
  const session = startSession(ctx, s, { persistent: body.keep !== false, viaKey: false });
  return { me: meShape(s, session) };
}, { auth: false });

// Signing in with the device key allows setting a new password without the old one.
route('POST', '/api/login/key', ctx => {
  const { body, ip } = ctx;
  limit(`keylogin:${ip}`, 20, 10 * MINUTE);
  const s = db.one('SELECT * FROM students WHERE key_hash = $h', { h: hashKey(body.key) });
  if (!s) fail(401, "That device key doesn't match any account. Check it for typos.");
  const session = startSession(ctx, s, { persistent: body.keep !== false, viaKey: true });
  return { me: meShape(s, session) };
}, { auth: false });

route('POST', '/api/logout', ctx => {
  if (ctx.session) db.run('DELETE FROM sessions WHERE id = $id', { id: ctx.session.id });
  ctx.cookies.push(clearedCookie(ctx.req));
  return { ok: true };
}, { auth: false });

// A signed-in student sets a new password without the old one; every other device is signed out.
route('POST', '/api/me/password', async ctx => {
  const { me, body, session } = ctx;
  const password = passwordInput(body.password, 'New password');
  const passwordHash = await hashPassword(password);
  db.tx(() => {
    db.run('UPDATE students SET password_hash = $pw WHERE id = $id', { pw: passwordHash, id: me.id });
    db.run('DELETE FROM sessions WHERE student_id = $id AND id != $keep', { id: me.id, keep: session ? session.id : '' });
    if (session) db.run('UPDATE sessions SET via_key = 0 WHERE id = $id', { id: session.id });
  });
  return { me: meShape(studentById(me.id), null) };
});

route('POST', '/api/me/device-key', ({ me }) => {
  const key = newKey();
  db.run('UPDATE students SET key_hash = $h WHERE id = $id', { h: hashKey(key), id: me.id });
  return { key };
});

route('GET', '/api/me', ctx => {
  const { me, session } = ctx;
  const t = Date.now();
  const newVisit = t - Date.parse(me.last_active_at) > 30 * MINUTE;
  db.run(`UPDATE students SET ${newVisit ? 'prev_visit_at = last_active_at, ' : ''}last_active_at = $now WHERE id = $id`, { now: isoAt(t), id: me.id });
  if (session && session.persistent) ctx.cookies.push(sessionCookie(ctx.req, session.token, true));
  return meShape(studentById(me.id), session);
});

// The light/dark choice follows the account to every device.
route('PUT', '/api/me/theme', ({ me, body }) => {
  if (!['system', 'light', 'dark'].includes(body.theme)) fail(400, 'Pick system, light or dark.');
  db.run('UPDATE students SET theme = $t WHERE id = $id', { t: body.theme, id: me.id });
  return { theme: body.theme };
});

route('PATCH', '/api/me', ({ me, body, session }) => {
  const name = usernameInput(body.name);
  assertNameFree(name, me.id);
  try {
    db.run('UPDATE students SET name = $name, username_key = $ukey WHERE id = $id', { name, ukey: usernameKey(name), id: me.id });
  } catch (err) {
    if (isUniqueError(err)) fail(409, `The username “${name}” is taken. Add a last initial or a number.`);
    throw err;
  }
  return meShape(studentById(me.id), session);
});

route('GET', '/api/home', ({ me }) => {
  const now = Date.now();
  const params = { me: me ? me.id : GUEST_ID, since: isoAt(now - 14 * DAY), recent: isoAt(now - 30 * DAY) };
  // Guests see every course; students see the ones they track.
  const tracked = me ? 'p.course_id IN (SELECT course_id FROM tracks WHERE student_id = $me) AND c.archived = 0' : 'c.archived = 0';
  const upcoming = db.all(`SELECT ${POST_FIELDS} ${POST_FROM}
      WHERE p.deleted_at IS NULL AND ${tracked}
        AND ((p.due_at IS NOT NULL AND p.due_at >= $since) OR (p.due_at IS NULL AND p.type IN ('exam', 'homework')))
      ORDER BY p.due_at IS NULL, p.due_at LIMIT 300`, params).map(postSummary);
  const announcements = db.all(`SELECT ${POST_FIELDS} ${POST_FROM}
      WHERE p.deleted_at IS NULL AND ${tracked} AND p.type = 'announcement' AND p.created_at >= $recent
      ORDER BY p.created_at DESC LIMIT 8`, params).map(postSummary);
  const totalCourses = db.one('SELECT COUNT(*) AS n FROM courses WHERE archived = 0').n;
  const trackedCourses = me ? db.one(`SELECT COUNT(*) AS n FROM tracks t JOIN courses c ON c.id = t.course_id
      WHERE t.student_id = $me AND c.archived = 0`, { me: me.id }).n : totalCourses;
  return { upcoming, announcements, trackedCourses, totalCourses, now: isoAt(now) };
}, { guest: true });

route('GET', '/api/agenda', ({ me, query }) => {
  const from = new Date(query.get('from') || ''), to = new Date(query.get('to') || '');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to - from > 70 * DAY) fail(400, 'Pick a range of up to ten weeks.');
  const mine = me && query.get('scope') !== 'all';
  const posts = db.all(`SELECT ${POST_FIELDS} ${POST_FROM}
      WHERE p.deleted_at IS NULL AND c.archived = 0 AND p.due_at >= $from AND p.due_at < $to
      ${mine ? 'AND p.course_id IN (SELECT course_id FROM tracks WHERE student_id = $me)' : ''}
      ORDER BY p.due_at LIMIT 600`, { me: me ? me.id : GUEST_ID, from: from.toISOString(), to: to.toISOString() }).map(postSummary);
  return { posts };
}, { guest: true });

route('GET', '/api/activity', ({ me, query }) => {
  const before = parseInt(query.get('before'), 10) || null;
  return { items: activityList({ meId: me ? me.id : GUEST_ID, scope: me && query.get('scope') !== 'all' ? 'mine' : 'all', before, limit: 50 }) };
}, { guest: true });

route('GET', '/api/search', ({ me, query }) => {
  const q = (query.get('q') || '').trim().slice(0, 80);
  if (q.length < 2) return { posts: [], courses: [] };
  const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
  const posts = db.all(`SELECT ${POST_FIELDS} ${POST_FROM}
      WHERE p.deleted_at IS NULL AND c.archived = 0
        AND (p.title LIKE $like ESCAPE '\\' OR p.body LIKE $like ESCAPE '\\' OR p.location LIKE $like ESCAPE '\\')
      ORDER BY (p.course_id IN (SELECT course_id FROM tracks WHERE student_id = $me)) DESC, p.updated_at DESC
      LIMIT 40`, { me: me ? me.id : GUEST_ID, like }).map(postSummary);
  const nowS = nowIso();
  const courses = db.all(`${COURSE_SQL} WHERE c.archived = 0
        AND (c.code LIKE $like ESCAPE '\\' OR c.name LIKE $like ESCAPE '\\' OR c.instructor LIKE $like ESCAPE '\\')
      ORDER BY c.code COLLATE NOCASE LIMIT 10`, { me: me ? me.id : GUEST_ID, now: nowS, like }).map(c => courseShape(c));
  return { posts, courses };
}, { guest: true });

// ---- courses
route('GET', '/api/courses', ({ me }) => {
  const now = nowIso();
  const next = nextDueByCourse(now);
  return db.all(`${COURSE_SQL} WHERE c.archived = 0 ORDER BY c.code COLLATE NOCASE`, { me: me ? me.id : GUEST_ID, now })
    .map(c => courseShape(c, next.get(c.id)));
}, { guest: true });

route('POST', '/api/courses', ({ me, body }) => {
  const input = courseInput(body);
  const dup = findCourseByCode(input.code);
  if (dup) fail(409, `${dup.code} (${dup.name}) already exists. Track it instead of adding it again.`, { courseId: dup.id });
  const id = rid(10);
  const t = nowIso();
  db.tx(() => {
    db.run(`INSERT INTO courses (id, code, name, instructor, color, created_by, created_at, updated_at)
            VALUES ($id, $code, $name, $instructor, $color, $me, $t, $t)`, { id, ...input, me: me.id, t });
    db.run('INSERT OR IGNORE INTO tracks (student_id, course_id, created_at) VALUES ($me, $id, $t)', { me: me.id, id, t });
    logActivity({ kind: 'course_created', courseId: id, studentId: me.id, data: { code: input.code, name: input.name } });
  });
  broadcast({ t: 'course', courseId: id });
  return getCourse(id, me.id);
});

route('GET', '/api/courses/:id', ({ me, params }) => {
  const meId = me ? me.id : GUEST_ID;
  const course = getCourse(params.id, meId);
  const posts = db.all(`SELECT ${POST_FIELDS} ${POST_FROM} WHERE p.course_id = $course AND p.deleted_at IS NULL
      ORDER BY p.created_at DESC`, { me: meId, course: course.id }).map(postSummary);
  const deleted = db.all(`SELECT id, type, title, deleted_at FROM posts WHERE course_id = $course AND deleted_at IS NOT NULL
      AND deleted_at >= $since ORDER BY deleted_at DESC LIMIT 10`, { course: course.id, since: isoAt(Date.now() - 30 * DAY) })
    .map(p => ({ id: p.id, type: p.type, title: p.title, deletedAt: p.deleted_at }));
  return { course, posts, deleted };
}, { guest: true });

route('PATCH', '/api/courses/:id', ({ me, params, body }) => {
  const c = db.one('SELECT * FROM courses WHERE id = $id AND archived = 0', { id: params.id });
  if (!c) fail(404, 'This course does not exist or was archived.');
  const input = courseInput(body);
  const dup = findCourseByCode(input.code, c.id);
  if (dup) fail(409, `Another course already uses the code ${dup.code}.`, { courseId: dup.id });
  const changed = ['code', 'name', 'instructor', 'color'].filter(k => input[k] !== c[k]);
  if (changed.length) {
    db.tx(() => {
      db.run('UPDATE courses SET code = $code, name = $name, instructor = $instructor, color = $color, updated_at = $t WHERE id = $id',
        { ...input, t: nowIso(), id: c.id });
      const shown = changed.filter(k => k !== 'color');
      if (shown.length) {
        logActivity({
          kind: 'course_edited', courseId: c.id, studentId: me.id,
          data: { code: input.code, changes: shown.map(k => ({ field: k, from: c[k], to: input[k] })) },
        });
      }
    });
    broadcast({ t: 'course', courseId: c.id });
  }
  return getCourse(c.id, me.id);
});

route('PUT', '/api/courses/:id/track', ({ me, params, session }) => {
  const course = getCourse(params.id, me.id);
  db.run('INSERT OR IGNORE INTO tracks (student_id, course_id, created_at) VALUES ($me, $course, $t)', { me: me.id, course: course.id, t: nowIso() });
  return { me: meShape(studentById(me.id), session), course: getCourse(course.id, me.id) };
});

route('DELETE', '/api/courses/:id/track', ({ me, params, session }) => {
  db.run('DELETE FROM tracks WHERE student_id = $me AND course_id = $course', { me: me.id, course: params.id });
  return { me: meShape(studentById(me.id), session) };
});

// ---- posts
route('POST', '/api/posts', ({ me, body }) => {
  const course = db.one('SELECT * FROM courses WHERE id = $id AND archived = 0', { id: String(body.courseId || '') });
  if (!course) fail(400, 'Pick a course for this post.');
  const input = postInput(body);
  const files = resolveFiles(body.fileIds || [], me.id, null);
  const id = rid(12);
  const t = nowIso();
  db.tx(() => {
    db.run(`INSERT INTO posts (id, course_id, type, title, body, due_at, has_time, due_date, location, weight, created_by, created_at, updated_at, version)
            VALUES ($id, $course, $type, $title, $body, $due_at, $has_time, $due_date, $location, $weight, $me, $t, $t, 1)`,
    { id, course: course.id, ...input, me: me.id, t });
    for (const f of files) db.run('UPDATE files SET post_id = $post, removed_at = NULL WHERE id = $id', { post: id, id: f.id });
    db.run(`INSERT INTO revisions (post_id, version, snapshot, edited_by, note, created_at) VALUES ($id, 1, $snap, $me, '', $t)`,
      { id, snap: snapshotOf(input, files), me: me.id, t });
    db.run('INSERT OR IGNORE INTO tracks (student_id, course_id, created_at) VALUES ($me, $course, $t)', { me: me.id, course: course.id, t });
    logActivity({ kind: 'post_created', courseId: course.id, postId: id, studentId: me.id, data: { type: input.type, title: input.title, due: input.due_at ? dueOf(input) : null } });
    notify(trackersOf(course.id), { kind: 'post_created', actorId: me.id, courseId: course.id, postId: id, data: { type: input.type, title: input.title, due: input.due_at ? dueOf(input) : null } });
  });
  broadcast({ t: 'post', courseId: course.id, postId: id });
  return postDetail(id, me.id);
});

route('GET', '/api/posts/:id', ({ me, params }) => postDetail(params.id, me ? me.id : GUEST_ID), { guest: true });

const FIELD_LABELS = { type: 'type', title: 'title', body: 'details', due_at: 'date', has_time: 'date', due_date: 'date', location: 'location', weight: 'weight' };

// Every edit is a new version; the old ones stay readable in the history.
route('PATCH', '/api/posts/:id', ({ me, params, body }) => {
  const post = livePost(params.id);
  const input = postInput(body);
  const note = text(body.note, 'Edit note', { max: 200 });
  const current = activeFiles(post.id);
  const nextFiles = body.fileIds == null ? current : resolveFiles(body.fileIds, me.id, post.id);
  const changed = Object.keys(FIELD_LABELS).filter(k => (input[k] ?? null) !== (post[k] ?? null));
  const filesChanged = current.map(f => f.id).sort().join() !== nextFiles.map(f => f.id).sort().join();
  if (!changed.length && !filesChanged) fail(400, 'Nothing changed, so there is nothing to save.');

  const t = nowIso();
  const version = post.version + 1;
  const dateChanged = changed.some(k => FIELD_LABELS[k] === 'date');
  const due = dateChanged ? { from: dueOf(post), to: dueOf(input) } : null;
  const dueChange = dateChanged && post.due_at ? JSON.stringify({ ...due, at: t, by: me.id }) : post.due_change;
  db.tx(() => {
    db.run(`UPDATE posts SET type = $type, title = $title, body = $body, due_at = $due_at, has_time = $has_time, due_date = $due_date,
              location = $location, weight = $weight, updated_at = $t, version = $version, last_edited_by = $me, due_change = $due_change
            WHERE id = $id`, { ...input, t, version, me: me.id, due_change: dueChange, id: post.id });
    if (filesChanged) {
      const keep = new Set(nextFiles.map(f => f.id));
      for (const f of current) if (!keep.has(f.id)) db.run('UPDATE files SET removed_at = $t WHERE id = $id', { t, id: f.id });
      for (const f of nextFiles) db.run('UPDATE files SET post_id = $post, removed_at = NULL WHERE id = $id', { post: post.id, id: f.id });
    }
    db.run(`INSERT INTO revisions (post_id, version, snapshot, edited_by, note, created_at) VALUES ($id, $version, $snap, $me, $note, $t)`,
      { id: post.id, version, snap: snapshotOf(input, nextFiles), me: me.id, note, t });
    const fields = [...new Set(changed.map(k => FIELD_LABELS[k]))];
    if (filesChanged) fields.push('files');
    logActivity({ kind: 'post_edited', courseId: post.course_id, postId: post.id, studentId: me.id, data: { type: input.type, title: input.title, version, fields, note, due } });
    if (due) notify(trackersOf(post.course_id), { kind: 'date_changed', actorId: me.id, courseId: post.course_id, postId: post.id, data: { type: input.type, title: input.title, due } });
  });
  broadcast({ t: 'post', courseId: post.course_id, postId: post.id });
  return postDetail(post.id, me.id);
});

route('GET', '/api/posts/:id/history', ({ params }) => {
  const p = db.one(`SELECT p.id, p.title, p.type, p.version, p.deleted_at, c.id AS course_id, c.code, c.name, c.color
                    FROM posts p JOIN courses c ON c.id = p.course_id WHERE p.id = $id`, { id: params.id });
  if (!p) fail(404, 'This post does not exist.');
  const versions = db.all(`SELECT r.*, s.name, s.color FROM revisions r JOIN students s ON s.id = r.edited_by
                           WHERE r.post_id = $id ORDER BY r.version DESC`, { id: p.id })
    .map(r => ({ version: r.version, note: r.note, createdAt: r.created_at, editor: { id: r.edited_by, name: r.name, color: r.color }, snapshot: JSON.parse(r.snapshot) }));
  return {
    post: { id: p.id, title: p.title, type: p.type, version: p.version, deleted: !!p.deleted_at, course: { id: p.course_id, code: p.code, name: p.name, color: p.color } },
    versions,
  };
}, { guest: true });

route('PUT', '/api/posts/:id/vote', ({ me, params, body }) => {
  const post = livePost(params.id);
  const value = Number(body.value);
  if (![1, -1, 0].includes(value)) fail(400, 'A vote is up, down or none.');
  if (value === 0) db.run('DELETE FROM votes WHERE post_id = $post AND student_id = $me', { post: post.id, me: me.id });
  else {
    db.run(`INSERT INTO votes (post_id, student_id, value, created_at) VALUES ($post, $me, $value, $t)
            ON CONFLICT (post_id, student_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`,
    { post: post.id, me: me.id, value, t: nowIso() });
  }
  broadcast({ t: 'vote', courseId: post.course_id, postId: post.id });
  const row = db.one(`SELECT (SELECT COUNT(*) FROM votes WHERE post_id = $post AND value = 1) AS up,
                             (SELECT COUNT(*) FROM votes WHERE post_id = $post AND value = -1) AS down`, { post: post.id });
  return { up: row.up, down: row.down, myVote: value };
});

// Marking done early is a vote; the post is done for everyone once enough students agree.
route('PUT', '/api/posts/:id/done', ({ me, params, body }) => {
  const post = livePost(params.id);
  if (post.type !== 'exam' && post.type !== 'homework') fail(400, 'Only exams and homework can be marked done.');
  const count = () => db.one('SELECT COUNT(*) AS n FROM done WHERE post_id = $post', { post: post.id }).n;
  const reason = doneReason(post, count());
  if (reason === 'time') fail(409, 'The due time has passed, so this is already done.');
  if (reason === 'votes') fail(409, 'Enough classmates agreed. This is already done.');
  if (body.done) db.run('INSERT OR IGNORE INTO done (post_id, student_id, created_at) VALUES ($post, $me, $t)', { post: post.id, me: me.id, t: nowIso() });
  else db.run('DELETE FROM done WHERE post_id = $post AND student_id = $me', { post: post.id, me: me.id });
  broadcast({ t: 'post', courseId: post.course_id, postId: post.id });
  return postDetail(post.id, me.id);
});

// Replies stay one level deep: answering a reply joins the same thread, and its author is still notified.
route('POST', '/api/posts/:id/comments', ({ me, params, body }) => {
  const post = livePost(params.id);
  const files = resolveCommentFiles(body.fileIds, me.id);
  const content = text(body.body, 'Comment', { min: files.length ? 0 : 1, max: 2000, multiline: true });
  let parent = null;
  if (body.parentId) {
    parent = db.one('SELECT * FROM comments WHERE id = $id AND post_id = $post', { id: String(body.parentId), post: post.id });
    if (!parent || parent.deleted_at) fail(400, 'The comment you are replying to was deleted.');
  }
  limit(`comment:${me.id}`, 30, 10 * MINUTE);
  const mentions = findMentions(content);
  const id = rid(12);
  const t = nowIso();
  db.tx(() => {
    db.run(`INSERT INTO comments (id, post_id, student_id, parent_id, body, mentions, created_at)
            VALUES ($id, $post, $me, $parent, $body, $mentions, $t)`,
    { id, post: post.id, me: me.id, parent: parent ? parent.parent_id || parent.id : null, body: content, mentions: JSON.stringify(mentions), t });
    for (const f of files) db.run('UPDATE files SET comment_id = $c WHERE id = $id', { c: id, id: f.id });
    const excerpt = commentExcerpt(content, files);
    logActivity({ kind: 'comment_added', courseId: post.course_id, postId: post.id, studentId: me.id, data: { commentId: id, title: post.title, excerpt } });
    const base = { actorId: me.id, courseId: post.course_id, postId: post.id, commentId: id, data: { title: post.title, type: post.type, excerpt } };
    const told = new Set([me.id]);
    const tell = (kind, ids) => {
      const fresh = ids.filter(x => !told.has(x));
      fresh.forEach(x => told.add(x));
      notify(fresh, { ...base, kind });
    };
    if (parent) tell('reply', [parent.student_id]);
    tell('mention', mentions.map(m => m.id));
    tell('comment_on_post', [post.created_by]);
  });
  broadcast({ t: 'comment', courseId: post.course_id, postId: post.id });
  return commentShape({ ...db.one('SELECT * FROM comments WHERE id = $id', { id }), name: me.name, color: me.color }, me.id);
});

route('PATCH', '/api/comments/:id', ({ me, params, body }) => {
  const c = db.one(`SELECT m.*, p.course_id, p.title, p.type, p.deleted_at AS post_deleted FROM comments m JOIN posts p ON p.id = m.post_id
                    WHERE m.id = $id AND m.deleted_at IS NULL`, { id: params.id });
  if (!c) fail(404, 'This comment does not exist.');
  if (c.student_id !== me.id) fail(403, 'You can only edit your own comments.');
  if (c.post_deleted) fail(410, 'This post was deleted.');
  // fileIds, when sent, is the full list to keep: files left out are removed, new uploads are added.
  const current = db.all('SELECT * FROM files WHERE comment_id = $id AND removed_at IS NULL ORDER BY created_at', { id: c.id });
  let files = current;
  let added = [], removed = [];
  if (body.fileIds !== undefined) {
    if (!Array.isArray(body.fileIds)) fail(400, 'Attachments are not valid.');
    const wanted = [...new Set(body.fileIds.map(String))];
    const currentIds = new Set(current.map(f => f.id));
    added = resolveCommentFiles(wanted.filter(id => !currentIds.has(id)), me.id);
    removed = current.filter(f => !wanted.includes(f.id));
    files = [...current.filter(f => wanted.includes(f.id)), ...added];
    if (files.length > 6) fail(400, 'A comment can have at most 6 files.');
  }
  const content = text(body.body, 'Comment', { min: files.length ? 0 : 1, max: 2000, multiline: true });
  if (added.length || removed.length) {
    db.tx(() => {
      const t = nowIso();
      for (const f of added) db.run('UPDATE files SET comment_id = $c WHERE id = $id', { c: c.id, id: f.id });
      for (const f of removed) db.run('UPDATE files SET removed_at = $t WHERE id = $id', { t, id: f.id });
      if (content === c.body) db.run('UPDATE comments SET edited_at = $t WHERE id = $id', { t, id: c.id });
    });
    if (content === c.body) broadcast({ t: 'comment', courseId: c.course_id, postId: c.post_id });
  }
  if (content !== c.body) {
    const mentions = findMentions(content);
    const before = new Set(JSON.parse(c.mentions || '[]').map(m => m.id));
    const excerpt = commentExcerpt(content, files);
    db.tx(() => {
      db.run('UPDATE comments SET body = $body, mentions = $mentions, edited_at = $t WHERE id = $id',
        { body: content, mentions: JSON.stringify(mentions), t: nowIso(), id: c.id });
      db.run(`UPDATE activity SET data = json_set(data, '$.excerpt', $excerpt) WHERE kind = 'comment_added' AND json_extract(data, '$.commentId') = $id`, { excerpt, id: c.id });
      db.run(`UPDATE notifications SET data = json_set(data, '$.excerpt', $excerpt) WHERE comment_id = $id`, { excerpt, id: c.id });
      notify(mentions.map(m => m.id).filter(x => !before.has(x)), {
        kind: 'mention', actorId: me.id, courseId: c.course_id, postId: c.post_id, commentId: c.id, data: { title: c.title, type: c.type, excerpt },
      });
    });
    broadcast({ t: 'comment', courseId: c.course_id, postId: c.post_id });
  }
  return commentShape({ ...db.one('SELECT * FROM comments WHERE id = $id', { id: c.id }), name: me.name, color: me.color }, me.id);
});

route('DELETE', '/api/comments/:id', ({ me, params }) => {
  const c = db.one(`SELECT m.*, p.course_id FROM comments m JOIN posts p ON p.id = m.post_id
                    WHERE m.id = $id AND m.deleted_at IS NULL`, { id: params.id });
  if (!c) fail(404, 'This comment does not exist.');
  if (c.student_id !== me.id) fail(403, 'You can only delete your own comments.');
  db.tx(() => {
    db.run('UPDATE comments SET deleted_at = $t WHERE id = $id', { t: nowIso(), id: c.id });
    db.run(`DELETE FROM activity WHERE kind = 'comment_added' AND json_extract(data, '$.commentId') = $id`, { id: c.id });
    db.run('DELETE FROM notifications WHERE comment_id = $id', { id: c.id });
  });
  broadcast({ t: 'comment', courseId: c.course_id, postId: c.post_id });
  return { ok: true };
});

function notificationShape(r) {
  const d = JSON.parse(r.data || '{}');
  return {
    id: r.id, kind: r.kind, createdAt: r.created_at, read: !!r.read_at, commentId: r.comment_id,
    actor: r.actor_id ? { id: r.actor_id, name: r.actor_name || 'Someone', color: r.actor_color ?? 0 } : null,
    course: r.course_id && r.course_code ? { id: r.course_id, code: r.course_code, color: r.course_color } : null,
    post: r.post_id ? { id: r.post_id, title: r.post_title || d.title, type: r.post_type || d.type, deleted: !!r.post_deleted } : null,
    excerpt: d.excerpt || '', due: d.due || null,
  };
}
const unreadCount = meId => db.one('SELECT COUNT(*) AS n FROM notifications WHERE student_id = $me AND read_at IS NULL', { me: meId }).n;

route('GET', '/api/notifications', ({ me }) => {
  const rows = db.all(`SELECT n.*, s.name AS actor_name, s.color AS actor_color, c.code AS course_code, c.color AS course_color,
        p.title AS post_title, p.type AS post_type, p.deleted_at AS post_deleted
      FROM notifications n
      LEFT JOIN students s ON s.id = n.actor_id
      LEFT JOIN courses c ON c.id = n.course_id
      LEFT JOIN posts p ON p.id = n.post_id
      WHERE n.student_id = $me ORDER BY n.id DESC LIMIT 40`, { me: me.id });
  return { unread: unreadCount(me.id), items: rows.map(notificationShape) };
});

// Opening the bell marks what it showed as read.
route('POST', '/api/notifications/read', ({ me, body }) => {
  db.run('UPDATE notifications SET read_at = $t WHERE student_id = $me AND read_at IS NULL AND id <= $upTo',
    { t: nowIso(), me: me.id, upTo: Math.max(0, Number(body.upTo) || 0) });
  return { unread: unreadCount(me.id) };
});

route('GET', '/api/students', () => db.all('SELECT id, name, color FROM students WHERE blocked = 0 ORDER BY name COLLATE NOCASE LIMIT 2000'));

// Deleting needs agreement: the first vote opens a request, and the post goes once enough classmates agree.
route('POST', '/api/posts/:id/delete-votes', ({ me, params, body }) => {
  const post = livePost(params.id);
  const reason = text(body.reason, 'Reason', { max: 200 });
  const count = () => db.one('SELECT COUNT(*) AS n FROM delete_votes WHERE post_id = $id', { id: post.id }).n;
  const before = count();
  if (before === 0 && !reason) fail(400, 'Say why this post should be deleted.');
  const t = nowIso();
  let deleted = false;
  db.tx(() => {
    const r = db.run(`INSERT OR IGNORE INTO delete_votes (post_id, student_id, reason, created_at) VALUES ($post, $me, $reason, $t)`,
      { post: post.id, me: me.id, reason, t });
    if (r.changes && before === 0) {
      logActivity({ kind: 'delete_requested', courseId: post.course_id, postId: post.id, studentId: me.id, data: { type: post.type, title: post.title, reason } });
    }
    const n = count();
    if (n >= config.deleteVotes) {
      db.run('UPDATE posts SET deleted_at = $t WHERE id = $id', { t, id: post.id });
      logActivity({ kind: 'post_deleted', courseId: post.course_id, postId: post.id, studentId: null, data: { type: post.type, title: post.title, votes: n } });
      deleted = true;
    }
  });
  broadcast({ t: deleted ? 'delete' : 'post', courseId: post.course_id, postId: post.id });
  return postDetail(post.id, me.id);
});

route('DELETE', '/api/posts/:id/delete-votes', ({ me, params }) => {
  const post = livePost(params.id);
  db.run('DELETE FROM delete_votes WHERE post_id = $post AND student_id = $me', { post: post.id, me: me.id });
  broadcast({ t: 'post', courseId: post.course_id, postId: post.id });
  return postDetail(post.id, me.id);
});

// ---- uploads: the browser sends the raw file as the request body
const EXT_MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', svg: 'image/svg+xml', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
  ipynb: 'application/x-ipynb+json', py: 'text/x-python', r: 'text/plain', tex: 'application/x-tex', html: 'text/html', htm: 'text/html',
};
// Shown in the browser; everything else downloads. Types that could run script are always sent as plain bytes.
const INLINE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'text/plain']);
const RISKY_TYPES = /html|xml|svg|javascript|ecmascript/;

function cleanFileName(n) {
  n = n.replace(/[\u0000-\u001F\u007F/\\:*?"<>|]+/g, '_').replace(/^[.\s]+/, '').trim() || 'file';
  if (n.length > 120) {
    const ext = path.extname(n).slice(0, 12);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}
function cleanMime(header, name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  const m = String(header || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(m) ? m : 'application/octet-stream';
}

route('POST', '/api/uploads', async ({ req, me }) => {
  limit(`upload:${me.id}`, 60, 60 * MINUTE);
  const declared = parseInt(req.headers['content-length'], 10);
  if (!Number.isFinite(declared)) fail(411, 'The upload size is missing. Try again.');
  if (declared > MAX_UPLOAD) fail(413, `Files can be at most ${config.maxUploadMB} MB.`);
  if (declared === 0) fail(400, 'That file is empty.');
  let name = 'file';
  try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')); } catch { /* keep default */ }
  name = cleanFileName(name);
  const mime = cleanMime(req.headers['content-type'], name);
  const id = rid(22);
  const dest = path.join(UPLOAD_DIR, id);
  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_UPLOAD) cb(new HttpError(413, `Files can be at most ${config.maxUploadMB} MB.`));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, counter, fs.createWriteStream(dest, { flags: 'wx' }));
  } catch (err) {
    await fsp.rm(dest, { force: true });
    throw err instanceof HttpError ? err : new HttpError(400, 'The upload did not finish. Try again.');
  }
  const t = nowIso();
  db.run(`INSERT INTO files (id, post_id, name, mime, size, uploaded_by, created_at) VALUES ($id, NULL, $name, $mime, $size, $me, $t)`,
    { id, name, mime, size, me: me.id, t });
  return fileShape({ id, name, mime, size, created_at: t });
}, { raw: true });

// Uploads that never got attached to a post or comment are removed after a day.
async function cleanupOrphans() {
  const rows = db.all('SELECT id FROM files WHERE post_id IS NULL AND comment_id IS NULL AND created_at < $cutoff', { cutoff: isoAt(Date.now() - DAY) });
  for (const r of rows) {
    await fsp.rm(path.join(UPLOAD_DIR, r.id), { force: true });
    db.run('DELETE FROM files WHERE id = $id', { id: r.id });
  }
}
function pruneNotifications() {
  db.run('DELETE FROM notifications WHERE created_at < $cutoff', { cutoff: isoAt(Date.now() - 90 * DAY) });
  db.run('DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < $now', { now: nowIso() });
}
setInterval(() => {
  cleanupOrphans().catch(err => console.error('cleanup failed', err));
  pruneNotifications();
}, 60 * MINUTE).unref();

function rfc5987(s) {
  return encodeURIComponent(s).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function serveFile(req, res, id) {
  const f = /^[A-Za-z0-9]{22}$/.test(id) ? db.one('SELECT * FROM files WHERE id = $id', { id }) : null;
  if (!f) return sendText(res, 404, 'File not found.');
  const filePath = path.join(UPLOAD_DIR, f.id);
  let stat;
  try { stat = await fsp.stat(filePath); } catch { return sendText(res, 404, 'File not found.'); }
  const inline = INLINE_TYPES.has(f.mime);
  const type = inline ? (f.mime === 'text/plain' ? 'text/plain; charset=utf-8' : f.mime)
    : RISKY_TYPES.test(f.mime) ? 'application/octet-stream' : f.mime;
  const ascii = f.name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const headers = {
    ...BASE_HEADERS,
    'Content-Type': type,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${rfc5987(f.name)}`,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
  };
  // Chrome's PDF viewer refuses to run inside a sandbox, so only PDFs skip it.
  if (f.mime !== 'application/pdf') headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";

  const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (m && (m[1] !== '' || m[2] !== '')) {
    let start, end;
    if (m[1] === '') { start = Math.max(0, stat.size - Number(m[2])); end = stat.size - 1; }
    else { start = Number(m[1]); end = m[2] === '' ? stat.size - 1 : Math.min(Number(m[2]), stat.size - 1); }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { ...BASE_HEADERS, 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return pipeline(fs.createReadStream(filePath, { start, end }), res).catch(() => {});
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(filePath), res).catch(() => {});
}

// ---- calendar feed (subscribe from Google, Apple or Outlook calendar)
function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const proto = (config.trustProxy && req.headers['x-forwarded-proto']) || (req.socket.encrypted ? 'https' : 'http');
  const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${config.port}`;
  return `${String(proto).split(',')[0].trim()}://${String(host).split(',')[0].trim()}`;
}

function serveCalendar(req, res, token) {
  const s = /^[A-Za-z0-9]{24}$/.test(token) ? db.one('SELECT * FROM students WHERE feed_token = $t', { t: token }) : null;
  if (!s) return sendText(res, 404, 'Calendar not found.');
  const posts = db.all(`SELECT p.*, c.code AS course_code FROM posts p JOIN courses c ON c.id = p.course_id
      WHERE p.deleted_at IS NULL AND c.archived = 0 AND p.due_at IS NOT NULL AND p.due_at >= $from
        AND p.course_id IN (SELECT course_id FROM tracks WHERE student_id = $s)
      ORDER BY p.due_at`, { from: isoAt(Date.now() - 90 * DAY), s: s.id });
  const body = buildCalendar({ appName: config.appName, studentName: s.name, posts, baseUrl: baseUrl(req) });
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="deadlines.ics"',
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---- static files
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};
const staticCache = new Map();
async function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 404, 'Not found.');
  let stat;
  try { stat = await fsp.stat(filePath); if (!stat.isFile()) throw new Error('not a file'); } catch { return sendText(res, 404, 'Not found.'); }
  let entry = staticCache.get(filePath);
  if (!entry || entry.mtime !== stat.mtimeMs) {
    const body = await fsp.readFile(filePath);
    const type = STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream';
    entry = {
      body, type, mtime: stat.mtimeMs,
      gz: /text|json|svg/.test(type) ? zlib.gzipSync(body) : null,
      etag: `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`,
    };
    staticCache.set(filePath, entry);
  }
  const headers = { ...BASE_HEADERS, 'Content-Type': entry.type, ETag: entry.etag, 'Cache-Control': 'no-cache' };
  if (entry.type.startsWith('text/html')) Object.assign(headers, HTML_HEADERS);
  if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
  let body = entry.body;
  if (entry.gz && acceptsGzip(req)) { body = entry.gz; headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding'; }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------------------------------------------------------------- server
function authenticate(req, ip) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    const row = db.one(`SELECT se.id AS session_id, se.persistent, se.via_key, se.expires_at, se.last_used_at AS session_used, s.*
                        FROM sessions se JOIN students s ON s.id = se.student_id WHERE se.token_hash = $h`, { h: sha256(token) });
    if (row && (!row.expires_at || row.expires_at > nowIso())) {
      if (Date.now() - Date.parse(row.session_used) > 10 * MINUTE) {
        db.run('UPDATE sessions SET last_used_at = $t, expires_at = CASE WHEN persistent = 1 THEN NULL ELSE $exp END WHERE id = $id',
          { t: nowIso(), exp: isoAt(Date.now() + SESSION_IDLE), id: row.session_id });
      }
      return { student: row, via: 'session', session: { id: row.session_id, persistent: !!row.persistent, viaKey: !!row.via_key, token } };
    }
    if (row) db.run('DELETE FROM sessions WHERE id = $id', { id: row.session_id });
  }
  const key = req.headers['x-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!key) return null;
  const s = db.one('SELECT * FROM students WHERE key_hash = $h', { h: hashKey(key) });
  if (!s) { limit(`badkey:${ip}`, 30, 10 * MINUTE); return null; }
  return { student: s, via: 'key', session: null };
}

async function handleApi(req, res, url, ip) {
  const candidates = routes.filter(r => r.re.test(url.pathname));
  if (!candidates.length) fail(404, 'Not found.');
  const r = candidates.find(c => c.method === req.method);
  if (!r) fail(405, 'Method not allowed.');
  const match = r.re.exec(url.pathname);
  const params = Object.fromEntries(r.keys.map((k, i) => [k, match[i + 1]]));
  const auth = authenticate(req, ip);
  const me = auth ? auth.student : null;
  if (r.auth && !me) fail(401, 'You are signed out. Sign in again.');
  // Cookie-based requests that change things must come from this app's own pages.
  if (req.method !== 'GET' && !(auth && auth.via === 'key') && req.headers['x-cohort'] !== '1') {
    fail(403, 'This request was blocked. Reload the page and try again.');
  }
  if (me && req.method !== 'GET') {
    if (me.blocked) fail(403, 'This profile is blocked from making changes.');
    limit(`write:${me.id}`, 150, 10 * MINUTE);
  }
  const ctx = { req, res, url, query: url.searchParams, params, me, session: auth ? auth.session : null, ip, body: {}, cookies: [] };
  if (!r.raw && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) ctx.body = await readJson(req);
  const result = await r.handler(ctx);
  if (result !== undefined && !res.headersSent) sendJson(req, res, 200, result, ctx.cookies);
}

const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return sendText(res, 400, 'Bad request.'); }
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) return await handleApi(req, res, url, ip);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed.');
    let m;
    if ((m = /^\/files\/([A-Za-z0-9]+)(?:\/[^/]*)?$/.exec(p))) return await serveFile(req, res, m[1]);
    if ((m = /^\/cal\/([A-Za-z0-9]+)\.ics$/.exec(p))) return serveCalendar(req, res, m[1]);
    return await serveStatic(req, res, p);
  } catch (err) {
    if (res.headersSent) { res.destroy(); return; }
    if (err instanceof HttpError) return sendJson(req, res, err.status, { error: err.message, ...(err.extra || {}) });
    console.error(new Date().toISOString(), req.method, p, err);
    sendJson(req, res, 500, { error: 'Something went wrong on the server. Try again in a moment.' });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`${config.appName} is running on http://${config.host}:${config.port}`);
  console.log(`Data: ${config.dataDir}${config.joinCode ? ' · class code required' : ''}`);
  cleanupOrphans().catch(err => console.error('cleanup failed', err));
  pruneNotifications();
});

function shutdown() {
  for (const s of streams) s.end();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
