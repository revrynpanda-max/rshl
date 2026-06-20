// ─────────────────────────────────────────────────────────────────────────────
// user-warehouse.mjs — the per-user "memory palace", keyed by DISCORD USER ID.
//
// This is the structured fact layer the raw transcript log never had. Each user
// (their Discord snowflake) gets a warehouse of ROOMS (categories) and DRAWERS
// (key=value facts): home = "4501 Rainbow Lane…", favorite_ice_cream = "mint", etc.
//
// HYBRID, each engine in its lane:
//   • SQLite (this file, in transcripts.db)  → exact, fast, deterministic key=value
//     lookup + survives the Rust engine being down. The source of truth.
//   • RSHL lattice (mirror via lattice-bridge) → semantic/associative recall, per-user
//     cells (the engine already cellularizes by user_id). Best-effort, non-blocking.
//
// DEDUP BY DESIGN: facts are upserted by (user_id, key) — one value per drawer, no
// duplicates, so the store stays small as users grow. Fingerprints (quotable claims
// for contradiction detection) are de-duplicated on a normalized form.
// ─────────────────────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'transcripts.db');

let _db = null;
function getDB() {
  if (_db) return _db;
  _db = new Database(dbPath, { timeout: 15000 });
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS user_facts (
      user_id    TEXT NOT NULL,        -- Discord snowflake (the key for everything)
      room       TEXT NOT NULL,        -- category: identity | location | preferences | relationships | misc
      key        TEXT NOT NULL,        -- canonical drawer name: home, work, favorite_ice_cream, ...
      value      TEXT NOT NULL,        -- the fact value
      source     TEXT,                 -- where it came from (leo-voice, dm, extractor)
      updated_at INTEGER,
      PRIMARY KEY (user_id, key)       -- one value per drawer per user => dedup by design
    );
    CREATE INDEX IF NOT EXISTS idx_user_facts_uid ON user_facts(user_id);

    CREATE TABLE IF NOT EXISTS user_fingerprints (
      id        TEXT PRIMARY KEY,
      user_id   TEXT NOT NULL,
      norm      TEXT NOT NULL,         -- normalized claim (for dedup + contradiction matching)
      quote     TEXT NOT NULL,         -- the exact thing they said (so it can be quoted back)
      topic     TEXT,                  -- coarse subject tag
      meta      TEXT,                  -- JSON refs: { time:[...], location:[...] } so the judge can tell
                                       -- "went in 2020" vs "went in 2022" (not a conflict) from "never" vs "went"
      said_at   INTEGER,
      channel_id TEXT
    );`);
  try { _db.exec(`ALTER TABLE user_fingerprints ADD COLUMN meta TEXT`); } catch (_) {/* already has it */}
  _db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fp_uid ON user_fingerprints(user_id);
  `);
  return _db;
}

// ── Canonical keys + aliases ─────────────────────────────────────────────────
// Keep the store as typed CONFIG, not free sentences. Aliases map the many ways a
// person refers to a drawer onto one canonical key, so "my house"/"where I live"
// and "home" all land in the same drawer.
const KEY_ALIASES = {
  home: ['home', 'my home', 'my house', 'my place', 'where i live', 'my address', 'house', 'home address'],
  work: ['work', 'my work', 'my job', 'workplace', 'office', 'where i work'],
  last_location: ['last location', 'where i am', 'where i was', 'my location', 'current location', 'my current location', 'my whereabouts'],
  timezone: ['timezone', 'time zone', 'my timezone', 'my time zone', 'tz'],
  favorite_ice_cream: ['favorite ice cream', 'fav ice cream', 'favourite ice cream', 'ice cream'],
  favorite_food: ['favorite food', 'fav food', 'favourite food'],
  favorite_color: ['favorite color', 'fav color', 'favourite colour', 'favorite colour'],
  birthday: ['birthday', 'my birthday', 'bday', 'date of birth', 'born on'],
  pet: ['pet', 'my pet', 'my dog', 'my cat'],
  nickname: ['nickname', 'call me', 'my name is', 'preferred name'],
};
const ROOM_OF = {
  home: 'location', work: 'location', last_location: 'location', timezone: 'identity',
  favorite_ice_cream: 'preferences', favorite_food: 'preferences', favorite_color: 'preferences',
  birthday: 'identity', nickname: 'identity', pet: 'relationships',
};

export function resolveAlias(rawKey) {
  const k = String(rawKey || '').trim().toLowerCase();
  if (!k) return null;
  for (const [canon, alts] of Object.entries(KEY_ALIASES)) {
    if (canon === k || alts.includes(k)) return canon;
  }
  // Unknown but well-formed key → snake_case it and keep (extensible drawers).
  return k.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || null;
}

// ── RSHL mirror (best-effort, non-blocking) ──────────────────────────────────
async function mirrorToLattice(userId, who, key, value) {
  try {
    const { storeLattice } = await import('./lattice-bridge.mjs');
    await storeLattice(
      `${who || 'user'}'s ${key.replace(/_/g, ' ')} is "${value}".`,
      'user-profile', 2.0, 'identity', userId
    );
  } catch (_) { /* engine down or bridge unavailable — SQLite remains the source of truth */ }
}

// ── Facts (rooms/drawers) ────────────────────────────────────────────────────
export function setFact(userId, rawKey, value, { room = null, source = 'unknown', who = null } = {}) {
  if (!userId || !rawKey || value == null || String(value).trim() === '') return null;
  const key = resolveAlias(rawKey);
  if (!key) return null;
  const val = String(value).trim().slice(0, 500);
  const rm = room || ROOM_OF[key] || 'misc';
  getDB().prepare(`
    INSERT INTO user_facts (user_id, room, key, value, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET
      value=excluded.value, room=excluded.room, source=excluded.source, updated_at=excluded.updated_at
  `).run(String(userId), rm, key, val, source, Date.now());
  mirrorToLattice(userId, who, key, val);  // fire-and-forget semantic mirror
  return { user_id: String(userId), room: rm, key, value: val };
}

export function getFact(userId, rawKey) {
  if (!userId || !rawKey) return null;
  const key = resolveAlias(rawKey);
  if (!key) return null;
  const row = getDB().prepare(`SELECT room, key, value, source, updated_at FROM user_facts WHERE user_id=? AND key=?`)
    .get(String(userId), key);
  return row || null;
}

export function listFacts(userId, room = null) {
  if (!userId) return [];
  const db = getDB();
  return room
    ? db.prepare(`SELECT room, key, value, updated_at FROM user_facts WHERE user_id=? AND room=? ORDER BY room, key`).all(String(userId), room)
    : db.prepare(`SELECT room, key, value, updated_at FROM user_facts WHERE user_id=? ORDER BY room, key`).all(String(userId));
}

export function forgetFact(userId, rawKey) {
  if (!userId || !rawKey) return false;
  const key = resolveAlias(rawKey);
  const info = getDB().prepare(`DELETE FROM user_facts WHERE user_id=? AND key=?`).run(String(userId), key);
  return info.changes > 0;
}

// ── Fingerprints (quotable claims → contradiction detection) ─────────────────
function normalizeClaim(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(i|im|i'm|the|a|an|is|are|was|were|to|of|my|that|this|it|so|just|really|kinda)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pull TIME/DATE and LOCATION references out of a statement so the contradiction
// judge has the extra axes you flagged: "went to California in 2020" vs "...in 2022"
// is NOT a conflict; "never been" vs "went" IS. Without these, time/place-only
// differences are a blind spot. (Not saying a thing = vagueness, never a conflict.)
function extractRefs(text) {
  const lower = String(text || '').toLowerCase();
  const refs = {};
  const time = lower.match(/\b(today|tomorrow|yesterday|tonight|this (?:morning|afternoon|evening|week|month|year|summer|winter|spring|fall)|last (?:week|month|year|night|summer|winter|spring|fall)|next (?:week|month|year)|\d{4}|\d{1,2}(?::\d{2})?\s?(?:am|pm)|(?:mon|tues|wednes|thurs|fri|satur|sun)day|january|february|march|april|june|july|august|september|october|november|december)\b/g);
  if (time) refs.time = [...new Set(time.map(s => s.trim()))].slice(0, 6);
  const loc = String(text || '').match(/\b(?:in|at|to|from|near|around)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/g);
  if (loc) refs.location = [...new Set(loc.map(s => s.replace(/^\s*(?:in|at|to|from|near|around)\s+/i, '').trim()))].slice(0, 6);
  // POLARITY + SCOPE — the words that actually DECIDE a contradiction. A bare
  // repeated event ("went in 2020" / "went in 2022") is compatible; it's a
  // uniqueness or negation SCOPE that makes a later instance a real conflict.
  refs.polarity = /\b(?:never|not|n't|no longer|no more|none|nobody|nothing|nowhere)\b/.test(lower) ? 'negative' : 'affirmative';
  const scope = [];
  if (/\b(?:never|no longer|no more)\b/.test(lower)) scope.push('negate-universal');
  if (/\b(?:only|sole|single|just once|one time)\b/.test(lower)) scope.push('unique');
  if (/\b(?:last|first|final)\s+time\b/.test(lower)) scope.push('ordinal');
  if (/\b(?:always|every|each|all|whenever|every ?time)\b/.test(lower)) scope.push('universal');
  if (scope.length) refs.scope = scope;
  return refs;
}

export function addFingerprint(userId, quote, { topic = null, channelId = null } = {}) {
  if (!userId || !quote || String(quote).trim().split(/\s+/).length < 4) return null; // skip trivial
  const norm = normalizeClaim(quote);
  if (!norm) return null;
  const db = getDB();
  // Dedup: don't store a near-identical claim twice.
  const dup = db.prepare(`SELECT id FROM user_fingerprints WHERE user_id=? AND norm=?`).get(String(userId), norm);
  if (dup) return dup.id;
  const id = `${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const refs = extractRefs(quote);
  db.prepare(`INSERT INTO user_fingerprints (id, user_id, norm, quote, topic, meta, said_at, channel_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, String(userId), norm, String(quote).slice(0, 500), topic, refs ? JSON.stringify(refs) : null, Date.now(), channelId);
  return id;
}

export function getFingerprints(userId, { topic = null, limit = 25 } = {}) {
  if (!userId) return [];
  const db = getDB();
  return topic
    ? db.prepare(`SELECT quote, topic, said_at FROM user_fingerprints WHERE user_id=? AND topic=? ORDER BY said_at DESC LIMIT ?`).all(String(userId), topic, limit)
    : db.prepare(`SELECT quote, topic, said_at FROM user_fingerprints WHERE user_id=? ORDER BY said_at DESC LIMIT ?`).all(String(userId), limit);
}

// Lightweight contradiction surface: return prior claims that share most content
// words with a new statement, so the prompt layer can flag a possible conflict.
// (Heavy negation analysis lives in contradiction-detector.mjs — this is the recall half.)
export function findPossibleContradictions(userId, statement, { limit = 3 } = {}) {
  if (!userId || !statement) return [];
  const words = [...new Set(normalizeClaim(statement).split(' ').filter(w => w.length > 3))];
  if (!words.length) return [];
  const distinctive = new Set(words.filter(w => w.length >= 6)); // places / names / specifics
  const rows = getDB().prepare(`SELECT quote, norm, meta, said_at FROM user_fingerprints WHERE user_id=? ORDER BY said_at DESC LIMIT 400`).all(String(userId));
  const scored = [];
  for (const r of rows) {
    const rw = new Set(r.norm.split(' '));
    let overlap = 0, hitDistinctive = false;
    for (const w of words) { if (rw.has(w)) { overlap++; if (distinctive.has(w)) hitDistinctive = true; } }
    const score = overlap / words.length;
    let refs = null; try { refs = r.meta ? JSON.parse(r.meta) : null; } catch (_) {}
    // Generous RECALL: surface a candidate if a third of content words match OR a
    // distinctive word (place/name/specific) is shared — e.g. "never been to
    // California" vs "went to California" share only "California". The precise
    // polarity call (negation flip) is left to contradiction-detector.mjs / the prompt.
    if (score >= 0.34 || hitDistinctive) scored.push({ quote: r.quote, said_at: r.said_at, overlap: score, refs });
  }
  return scored.sort((a, b) => b.overlap - a.overlap).slice(0, limit);
}

// Turn overlapping candidates into an actual VERDICT using polarity + scope — the
// "many angles" rule. A date/place difference alone is NOT a conflict; a difference
// UNDER a negation ("never") or uniqueness ("only/last time") scope IS.
//   contradiction          → prior "never/no longer X" but new asserts X;
//                            or prior "only/last time was T1" but new gives T2.
//   possible-contradiction → opposite polarity on an overlapping claim.
//   candidate              → same topic only (could just be vague/broad — not a conflict).
export function judgeContradiction(userId, statement) {
  const sref = extractRefs(statement) || {};
  const candidates = findPossibleContradictions(userId, statement, { limit: 10 });
  const out = [];
  for (const c of candidates) {
    const p = c.refs || {};
    let verdict = 'candidate', reason = 'same topic — may just be vague or broad, not a conflict';
    if ((p.scope || []).includes('negate-universal') && sref.polarity === 'affirmative') {
      verdict = 'contradiction';
      reason = 'they previously said never / no longer, but the new statement asserts it';
    } else if ((p.scope || []).some(s => s === 'unique' || s === 'ordinal') &&
               sref.time && p.time && JSON.stringify(sref.time) !== JSON.stringify(p.time)) {
      verdict = 'contradiction';
      reason = 'they claimed the only/last time, but the new statement gives a different time';
    } else if (p.polarity && sref.polarity && p.polarity !== sref.polarity && c.overlap >= 0.34) {
      verdict = 'possible-contradiction';
      reason = 'opposite polarity on an overlapping claim';
    }
    out.push({ quote: c.quote, said_at: c.said_at, verdict, reason });
  }
  const rank = { 'contradiction': 0, 'possible-contradiction': 1, 'candidate': 2 };
  return out.sort((a, b) => rank[a.verdict] - rank[b.verdict]).slice(0, 3);
}

export default { resolveAlias, setFact, getFact, listFacts, forgetFact, addFingerprint, getFingerprints, findPossibleContradictions, judgeContradiction };
