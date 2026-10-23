'use strict';
// iCalendar (RFC 5545) feed for a student's tracked courses.

const TYPE_LABEL = { exam: 'Exam', homework: 'Due', announcement: 'Event', material: 'Material' };

function esc(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// Lines longer than 75 octets are folded: CRLF + one space, never splitting a UTF-8 character.
function fold(line) {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts = [];
  let cur = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > limit) {
      parts.push(cur);
      cur = '';
      bytes = 0;
      limit = 74; // continuation lines start with a space
    }
    cur += ch;
    bytes += b;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

const stamp = iso => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const dateOnly = ymd => ymd.replace(/-/g, '');

function nextDay(ymd) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function buildCalendar({ appName, studentName, posts, baseUrl }) {
  const now = stamp(new Date().toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${esc(appName)}//Course Board//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`${appName} · ${studentName}`)}`,
    `X-WR-CALDESC:${esc(`Exams, homework and dated announcements from the courses ${studentName} tracks in ${appName}.`)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  for (const p of posts) {
    if (!p.due_at) continue;
    const link = `${baseUrl}/#/post/${p.id}`;
    const summary = `${TYPE_LABEL[p.type] || 'Item'}: ${p.title} (${p.course_code})`;
    const details = [p.weight ? `Weight: ${p.weight}` : '', p.body || '', `Open in ${appName}: ${link}`]
      .filter(Boolean).join('\n\n');

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${p.id}@cohort`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`LAST-MODIFIED:${stamp(p.updated_at)}`);
    lines.push(`SEQUENCE:${p.version || 0}`);
    if (!p.has_time && p.due_date) {
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(p.due_date)}`);
      lines.push(`DTEND;VALUE=DATE:${nextDay(p.due_date)}`);
    } else {
      lines.push(`DTSTART:${stamp(p.due_at)}`);
      lines.push(`DURATION:${p.type === 'homework' ? 'PT30M' : 'PT1H'}`);
    }
    lines.push(`SUMMARY:${esc(summary)}`);
    if (p.location) lines.push(`LOCATION:${esc(p.location)}`);
    lines.push(`DESCRIPTION:${esc(details.slice(0, 1500))}`);
    lines.push(`URL:${link}`);
    lines.push(`CATEGORIES:${esc(TYPE_LABEL[p.type] || 'Item')}`);
    if (p.type === 'exam' || p.type === 'homework') {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-P1D', `DESCRIPTION:${esc(summary)}`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildCalendar };
