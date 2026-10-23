#!/usr/bin/env node
'use strict';
// Moderation from the server's terminal: node admin.js <command> [args]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb } = require('./src/db');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const db = openDb(path.join(dataDir, 'cohort.db'));
const [cmd, ...args] = process.argv.slice(2);
const now = () => new Date().toISOString();

function need(value, usage) {
  if (!value) { console.error(`Usage: node admin.js ${usage}`); process.exit(1); }
  return value;
}
function table(rows) {
  if (!rows.length) return console.log('(none)');
  console.table(rows.map(r => ({ ...r })));
}

const commands = {
  stats() {
    const n = sql => db.one(sql).n;
    console.log({
      students: n('SELECT COUNT(*) AS n FROM students'),
      courses: n('SELECT COUNT(*) AS n FROM courses WHERE archived = 0'),
      posts: n('SELECT COUNT(*) AS n FROM posts WHERE deleted_at IS NULL'),
      deletedPosts: n('SELECT COUNT(*) AS n FROM posts WHERE deleted_at IS NOT NULL'),
      comments: n('SELECT COUNT(*) AS n FROM comments WHERE deleted_at IS NULL'),
      files: n('SELECT COUNT(*) AS n FROM files WHERE post_id IS NOT NULL'),
    });
  },
  students() {
    table(db.all(`SELECT s.id, s.name AS username, s.password_hash IS NOT NULL AS has_password, s.blocked, substr(s.created_at, 1, 10) AS joined, substr(s.last_active_at, 1, 16) AS last_active,
      (SELECT COUNT(*) FROM posts p WHERE p.created_by = s.id) AS posts FROM students s ORDER BY s.created_at`));
  },
  courses() {
    table(db.all(`SELECT c.id, c.code, c.name, c.archived, (SELECT COUNT(*) FROM tracks t WHERE t.course_id = c.id) AS tracking
      FROM courses c ORDER BY c.code`));
  },
  posts() {
    const courseId = args[0];
    table(db.all(`SELECT p.id, c.code, p.type, p.title, substr(p.created_at, 1, 10) AS created, p.deleted_at IS NOT NULL AS deleted
      FROM posts p JOIN courses c ON c.id = p.course_id ${courseId ? 'WHERE p.course_id = $course' : ''}
      ORDER BY p.created_at DESC LIMIT 100`, { course: courseId }));
  },
  deleted() {
    table(db.all(`SELECT p.id, c.code, p.type, p.title, p.deleted_at FROM posts p JOIN courses c ON c.id = p.course_id
      WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC`));
  },
  restore() {
    const id = need(args[0], 'restore <postId>');
    db.tx(() => {
      const r = db.run('UPDATE posts SET deleted_at = NULL WHERE id = $id AND deleted_at IS NOT NULL', { id });
      if (!r.changes) throw new Error('No deleted post with that id.');
      db.run('DELETE FROM delete_votes WHERE post_id = $id', { id });
    });
    console.log(`Restored ${id}. Its deletion votes were cleared.`);
  },
  'remove-post'() {
    const id = need(args[0], 'remove-post <postId>');
    const r = db.run('UPDATE posts SET deleted_at = $t WHERE id = $id AND deleted_at IS NULL', { t: now(), id });
    console.log(r.changes ? `Removed ${id}. Undo with: node admin.js restore ${id}` : 'No live post with that id.');
  },
  'archive-course'() {
    const id = need(args[0], 'archive-course <courseId>');
    const r = db.run('UPDATE courses SET archived = 1 WHERE id = $id', { id });
    console.log(r.changes ? `Archived ${id}. Undo with: node admin.js unarchive-course ${id}` : 'No course with that id.');
  },
  // Permanent: the course, its posts with their versions, comments, votes and files, plus its activity and notifications.
  'delete-course'() {
    const id = need(args[0], 'delete-course <courseId>');
    const course = db.one('SELECT id, code, name FROM courses WHERE id = $id', { id });
    if (!course) throw new Error('No course with that id.');
    const posts = db.all('SELECT id FROM posts WHERE course_id = $id', { id });
    const files = db.all(`SELECT f.id FROM files f JOIN posts p ON p.id = f.post_id WHERE p.course_id = $id
      UNION SELECT f.id FROM files f JOIN comments m ON m.id = f.comment_id JOIN posts p ON p.id = m.post_id WHERE p.course_id = $id`, { id });
    db.tx(() => {
      db.run('DELETE FROM files WHERE comment_id IN (SELECT m.id FROM comments m JOIN posts p ON p.id = m.post_id WHERE p.course_id = $id)', { id });
      for (const t of ['revisions', 'votes', 'comments', 'done', 'delete_votes', 'files']) {
        db.run(`DELETE FROM ${t} WHERE post_id IN (SELECT id FROM posts WHERE course_id = $id)`, { id });
      }
      db.run('DELETE FROM notifications WHERE course_id = $id OR post_id IN (SELECT id FROM posts WHERE course_id = $id)', { id });
      db.run('DELETE FROM activity WHERE course_id = $id', { id });
      db.run('DELETE FROM posts WHERE course_id = $id', { id });
      db.run('DELETE FROM tracks WHERE course_id = $id', { id });
      db.run('DELETE FROM courses WHERE id = $id', { id });
    });
    for (const f of files) fs.rmSync(path.join(dataDir, 'uploads', f.id), { force: true });
    console.log(`Deleted ${course.code} · ${course.name} with ${posts.length} posts and ${files.length} files.`);
  },
  'unarchive-course'() {
    const id = need(args[0], 'unarchive-course <courseId>');
    const r = db.run('UPDATE courses SET archived = 0 WHERE id = $id', { id });
    console.log(r.changes ? `Course ${id} is visible again.` : 'No course with that id.');
  },
  block() {
    const id = need(args[0], 'block <studentId>');
    const r = db.run('UPDATE students SET blocked = 1 WHERE id = $id', { id });
    console.log(r.changes ? `Blocked ${id}. They can still read but cannot post, vote or comment.` : 'No student with that id.');
  },
  unblock() {
    const id = need(args[0], 'unblock <studentId>');
    const r = db.run('UPDATE students SET blocked = 0 WHERE id = $id', { id });
    console.log(r.changes ? `Unblocked ${id}.` : 'No student with that id.');
  },
  backup() {
    const out = path.resolve(args[0] || path.join(dataDir, `backup-${now().slice(0, 10)}.db`));
    db.raw.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    console.log(`Database copied to ${out}. Uploaded files are in ${path.join(dataDir, 'uploads')}.`);
  },
  'new-key'() {
    const id = need(args[0], 'new-key <studentId>');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const key = [...crypto.randomBytes(16)].map(b => alphabet[b & 31]).join('').match(/.{4}/g).join('-');
    const hash = crypto.createHash('sha256').update(key.replace(/-/g, '')).digest('hex');
    const r = db.run('UPDATE students SET key_hash = $h WHERE id = $id', { h: hash, id });
    console.log(r.changes ? `New device key for ${id}: ${key}\nGive it to the student. They sign in with it, then choose a new password.` : 'No student with that id.');
  },
  rename() {
    const id = need(args[0], 'rename <studentId> <new name>');
    const name = need(args.slice(1).join(' ').trim(), 'rename <studentId> <new name>');
    db.run('UPDATE students SET name = $name WHERE id = $id', { id, name });
    console.log(`Renamed ${id} to ${name}.`);
  },
};

if (!commands[cmd]) {
  console.log(`Commands:
  stats                          counts of students, courses, posts
  students | courses | posts [courseId] | deleted
  restore <postId>               bring back a deleted post
  remove-post <postId>           delete a post right away (spam)
  archive-course <courseId>      hide a course; unarchive-course <courseId> to undo
  delete-course <courseId>       remove a course and everything in it for good (back up first)
  block <studentId>              stop a profile from posting; unblock <studentId> to undo
  new-key <studentId>            new device key for a student who lost their password and key
  rename <studentId> <name>      change someone's display name
  backup [file]                  safe copy of the database while the app runs`);
  process.exit(cmd ? 1 : 0);
}
try { commands[cmd](); } catch (err) { console.error(err.message); process.exit(1); }
