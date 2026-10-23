'use strict';
// SQLite storage (built into Node 22+). One file: data/cohort.db
const { DatabaseSync } = require('node:sqlite');

// Sign-in names compare without case, spaces or punctuation: "yasir a" finds "Yasir A.".
const usernameKey = name => String(name || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS students (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  username_key   TEXT,
  password_hash  TEXT,
  key_hash       TEXT NOT NULL UNIQUE,
  feed_token     TEXT NOT NULL UNIQUE,
  color          INTEGER NOT NULL DEFAULT 0,
  blocked        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  prev_visit_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS students_name ON students(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS courses (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  instructor TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES students(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tracks (
  student_id TEXT NOT NULL REFERENCES students(id),
  course_id  TEXT NOT NULL REFERENCES courses(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (student_id, course_id)
);
CREATE INDEX IF NOT EXISTS tracks_course ON tracks(course_id);

CREATE TABLE IF NOT EXISTS posts (
  id             TEXT PRIMARY KEY,
  course_id      TEXT NOT NULL REFERENCES courses(id),
  type           TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  due_at         TEXT,
  has_time       INTEGER NOT NULL DEFAULT 1,
  due_date       TEXT,
  location       TEXT NOT NULL DEFAULT '',
  weight         TEXT NOT NULL DEFAULT '',
  created_by     TEXT NOT NULL REFERENCES students(id),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  last_edited_by TEXT REFERENCES students(id),
  due_change     TEXT,
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS posts_course ON posts(course_id, deleted_at);
CREATE INDEX IF NOT EXISTS posts_due ON posts(due_at);

CREATE TABLE IF NOT EXISTS revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    TEXT NOT NULL REFERENCES posts(id),
  version    INTEGER NOT NULL,
  snapshot   TEXT NOT NULL,
  edited_by  TEXT NOT NULL REFERENCES students(id),
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (post_id, version)
);

CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  post_id     TEXT REFERENCES posts(id),
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES students(id),
  created_at  TEXT NOT NULL,
  removed_at  TEXT
);
CREATE INDEX IF NOT EXISTS files_post ON files(post_id);

CREATE TABLE IF NOT EXISTS votes (
  post_id    TEXT NOT NULL REFERENCES posts(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  value      INTEGER NOT NULL CHECK (value IN (-1, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, student_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  parent_id  TEXT,
  body       TEXT NOT NULL,
  mentions   TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  edited_at  TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id);

CREATE TABLE IF NOT EXISTS done (
  post_id    TEXT NOT NULL REFERENCES posts(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, student_id)
);

CREATE TABLE IF NOT EXISTS delete_votes (
  post_id    TEXT NOT NULL REFERENCES posts(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  reason     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, student_id)
);

CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  course_id  TEXT,
  post_id    TEXT,
  student_id TEXT,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_course ON activity(course_id, id);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  student_id   TEXT NOT NULL REFERENCES students(id),
  persistent   INTEGER NOT NULL DEFAULT 1,
  via_key      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at   TEXT,
  user_agent   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_student ON sessions(student_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL REFERENCES students(id),
  kind       TEXT NOT NULL,
  actor_id   TEXT,
  course_id  TEXT,
  post_id    TEXT,
  comment_id TEXT,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  read_at    TEXT
);
CREATE INDEX IF NOT EXISTS notifications_student ON notifications(student_id, id);
CREATE INDEX IF NOT EXISTS notifications_comment ON notifications(comment_id);
`;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  // Columns added after the first release: older databases get them in place, data untouched.
  const addColumn = (table, column, ddl) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  };
  addColumn('comments', 'parent_id', 'TEXT');
  addColumn('comments', 'mentions', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('comments', 'edited_at', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS comments_parent ON comments(parent_id)');
  addColumn('files', 'comment_id', 'TEXT');
  addColumn('students', 'theme', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS files_comment ON files(comment_id)');
  addColumn('students', 'username_key', 'TEXT');
  addColumn('students', 'password_hash', 'TEXT');
  const taken = new Set(db.prepare('SELECT username_key FROM students WHERE username_key IS NOT NULL').all().map(r => r.username_key));
  for (const st of db.prepare('SELECT id, name FROM students WHERE username_key IS NULL ORDER BY created_at').all()) {
    const base = usernameKey(st.name) || st.id.toLowerCase();
    let k = base;
    for (let n = 2; taken.has(k); n++) k = base + n;
    taken.add(k);
    db.prepare('UPDATE students SET username_key = ? WHERE id = ?').run(k, st.id);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS students_username ON students(username_key)');

  // Prepared statements are cached per SQL string. Params are passed as one
  // object and filtered to the $names the SQL uses (node:sqlite rejects extras).
  const cache = new Map();
  function prep(sql) {
    let entry = cache.get(sql);
    if (!entry) {
      const names = [...new Set([...sql.matchAll(/\$(\w+)/g)].map(m => m[1]))];
      entry = { stmt: db.prepare(sql), names };
      cache.set(sql, entry);
    }
    return entry;
  }
  function bind(names, params = {}) {
    const out = {};
    for (const n of names) {
      let v = params[n];
      if (v === undefined) v = null;
      else if (typeof v === 'boolean') v = v ? 1 : 0;
      out[n] = v;
    }
    return out;
  }
  const api = {
    raw: db,
    all(sql, params) { const e = prep(sql); return e.names.length ? e.stmt.all(bind(e.names, params)) : e.stmt.all(); },
    one(sql, params) { const e = prep(sql); return e.names.length ? e.stmt.get(bind(e.names, params)) : e.stmt.get(); },
    run(sql, params) { const e = prep(sql); return e.names.length ? e.stmt.run(bind(e.names, params)) : e.stmt.run(); },
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (err) { db.exec('ROLLBACK'); throw err; }
    },
    close() { db.close(); },
  };
  return api;
}

module.exports = { openDb, usernameKey };
