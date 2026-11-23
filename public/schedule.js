// Pure helpers for the schedule. No DOM, so they can be unit-tested in Node.

export const CATEGORIES = ['work', 'meeting', 'health', 'personal', 'break', 'errand', 'other'];
const MAX_BLOCKS = 40;

// Accepts "9:00", "09:00", "9:00 PM", "21:00", "9pm". Returns "HH:MM" (24h) or null.
export function normalizeTime(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3] ? m[3][0] : null;
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'p' && h !== 12) h += 12;
    if (ampm === 'a' && h === 12) h = 0;
  }
  if (h === 24 && min === 0) h = 24;
  else if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function clean(str, max) {
  return typeof str === 'string' ? str.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

// Validates whatever the model sent and returns a safe, sorted list of blocks.
export function sanitizeBlocks(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  for (const raw of list.slice(0, MAX_BLOCKS)) {
    if (!raw || typeof raw !== 'object') continue;
    const start = normalizeTime(raw.start);
    let end = normalizeTime(raw.end);
    const title = clean(raw.title, 80);
    if (!start || !title) continue;
    if (!end || toMinutes(end) <= toMinutes(start)) {
      end = minutesToTime(Math.min(toMinutes(start) + 30, 24 * 60));
    }
    const category = CATEGORIES.includes(raw.category) ? raw.category : 'other';
    const note = clean(raw.note, 160);
    out.push({ start, end, title, category, ...(note ? { note } : {}) });
  }
  out.sort((a, b) => toMinutes(a.start) - toMinutes(b.start) || toMinutes(a.end) - toMinutes(b.end));
  return out;
}

export function minutesToTime(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// "13:30" -> "1:30 PM"
export function formatTime(hhmm) {
  let [h, m] = hhmm.split(':').map(Number);
  if (h === 24) h = 0;
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function formatDuration(start, end) {
  const mins = toMinutes(end) - toMinutes(start);
  if (mins <= 0) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m} min`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// Keys of blocks that are new or whose time changed compared with the previous list.
export function changedKeys(prev, next) {
  const before = new Map((prev || []).map((b) => [b.title.toLowerCase(), `${b.start}-${b.end}`]));
  const changed = new Set();
  for (const b of next) {
    const key = b.title.toLowerCase();
    if (before.get(key) !== `${b.start}-${b.end}`) changed.add(key);
  }
  return changed;
}

// Parses the schedule text the assistant sends with set_schedule.
// One block per line: "09:00-10:00 | Client call | meeting | optional note".
// A JSON array of block objects is accepted too, just in case.
export function parseScheduleText(text) {
  if (Array.isArray(text)) return sanitizeBlocks(text);
  const str = String(text ?? '').trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try { return sanitizeBlocks(JSON.parse(str)); } catch {}
  }
  const blocks = [];
  for (const line of str.split(/\r?\n|;(?=\s*\d)/)) {
    const parts = line.replace(/^\s*[-*•]\s*/, '').split('|').map((x) => x.trim());
    const m = /^(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i.exec(parts[0] || '');
    if (!m) continue;
    blocks.push({ start: m[1], end: m[2], title: parts[1] || '', category: (parts[2] || '').toLowerCase(), note: parts[3] || '' });
  }
  return sanitizeBlocks(blocks);
}
