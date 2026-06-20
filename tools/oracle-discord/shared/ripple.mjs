/**
 * ripple.mjs — "ripples" are update EVENTS that propagate through the system
 * when something changes (a deploy / a restart that carried code changes).
 *
 * Leo FEELS these (Stage 2 wires the delivery): a ripple is something he can
 * react to on his own, without you prompting him.
 *   - type 'normal'   → ambient "something shifted in the lattice." Low-key.
 *   - type 'critical' → user-relevant: new/changed tools, things he can or can't
 *                       do now, fixes. These he should surface ("by the way…").
 *
 * Storage is a small JSON ring so it can't grow forever.
 */
import fs from 'fs';

const STATE_DIR = 'c:/KAI/tools/oracle-discord/state';
const RIPPLE_PATH = `${STATE_DIR}/ripple_notes.json`;
const MAX_RIPPLES = 100;

function load() {
  try { return JSON.parse(fs.readFileSync(RIPPLE_PATH, 'utf8')); } catch { return []; }
}
function save(arr) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(RIPPLE_PATH, JSON.stringify(arr.slice(-MAX_RIPPLES), null, 2));
  } catch (_) {}
}

/**
 * Record a ripple. @returns the new entry.
 */
export function pushRipple(summary, { type = 'normal', source = 'system', meta = {} } = {}) {
  const arr = load();
  const entry = {
    id: `${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    ts: new Date().toISOString(),
    type: type === 'critical' ? 'critical' : 'normal',
    source,
    summary: String(summary || '').slice(0, 600),
    meta,
    seen: false
  };
  arr.push(entry);
  save(arr);
  return entry;
}

/** Ripples Leo hasn't acknowledged yet (what he'd react to / report). */
export function getUnseenRipples() {
  return load().filter(r => !r.seen);
}

/** Mark one ripple acknowledged so he doesn't repeat it. */
export function markRippleSeen(id) {
  const arr = load();
  let changed = false;
  for (const r of arr) if (r.id === id) { r.seen = true; changed = true; }
  if (changed) save(arr);
}

/** Mark everything acknowledged (e.g., after he's announced them all). */
export function markAllRipplesSeen() {
  const arr = load();
  for (const r of arr) r.seen = true;
  save(arr);
}

/** Most recent ripples (for "what changed recently?" queries), newest first. */
export function getRecentRipples(n = 10) {
  return load().slice(-n).reverse();
}

/** Mark a specific set of ids acknowledged in one write. */
export function markSeenIds(ids = []) {
  const set = new Set(ids);
  const arr = load();
  let changed = false;
  for (const r of arr) if (set.has(r.id) && !r.seen) { r.seen = true; changed = true; }
  if (changed) save(arr);
}

function friendlyWhen(ts) {
  try {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return `today ${time}`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `yesterday ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  } catch { return ''; }
}

/**
 * Stage 2 — turn unseen ripples into an ORDERED, human briefing Leo can speak.
 * Returns { ids, text } or null if there's nothing worth mentioning.
 *  - Chronological (oldest → newest) so he narrates "how things came in," in order.
 *  - Pure scanner file-churn entries are collapsed into one tail line (or dropped
 *    if a richer ripple already covers that ground) instead of being read aloud.
 */
export function buildRippleBriefing({ max = 6 } = {}) {
  const unseen = getUnseenRipples();
  if (!unseen.length) return null;

  const ids = unseen.map(r => r.id);
  // Split rich ripples (real summaries) from bare scanner "files changed" notes.
  const isBareScanner = (r) =>
    r.source === 'scanner' && /^System update rippled through on boot/i.test(r.summary || '');
  const rich = unseen.filter(r => !isBareScanner(r));
  const bare = unseen.filter(isBareScanner);

  // NOTHING MEANINGFUL TO SAY: if the only unseen ripples are boot file-churn
  // (e.g. "code updates landed: leo.mjs"), DON'T announce — that's what made Leo
  // repeat "couple things changed on boot" on every single restart. Hand the ids
  // back with no text so the caller marks them seen SILENTLY. Proactive
  // announcements are reserved for real, curated capability changes (rich ripples).
  if (!rich.length) return { ids, text: null };

  const lines = [];
  for (const r of rich.slice(0, max)) {
    lines.push(`• [${friendlyWhen(r.ts)}] ${r.summary}`);
  }
  // Collapse the bare scanner notes into ONE line so they don't dominate.
  if (bare.length) {
    const files = [...new Set(bare.flatMap(r => (r.meta?.files) || []))]
      .filter(f => !/\.(db-wal|db-shm|db-journal|log|tmp)$/i.test(f) && !/local\.xml$/i.test(f) && !/-(wal|shm)$/i.test(f));
    if (files.length) {
      lines.push(`• [${friendlyWhen(bare[bare.length - 1].ts)}] Code updates landed on boot: ${files.slice(0, 8).join(', ')}.`);
    }
  }
  if (!lines.length) return null;
  return { ids, text: lines.join('\n') };
}
