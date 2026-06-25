// ── SHARED GROQ WHISPER LIMITER + DEDUP ───────────────────────────────────────
// PROBLEM (Bug 2): the whole fleet shares ONE Groq key (20 RPM). When a human
// speaks, Leo + Groq + X + Claudey each independently sent the SAME utterance to
// whisper-large-v3-turbo, so a single sentence burned 4+ requests and tripped
// 'Rate limit ... RPM: Limit 20, Used 20'. Only ONE transcription of the human
// is actually needed per utterance; the rest should reuse it.
//
// This module gives every Whisper call site two cheap, low-risk guards:
//   1) DEDUP CACHE (cross-process, file-backed): keyed by (userId + clip window).
//      The first bot to transcribe a window writes the result; concurrent/later
//      bots within the same window REUSE it instead of calling Groq again.
//   2) TOKEN BUCKET (cross-process, file-backed): a global rolling-window cap of
//      GROQ_STT_RPM requests/min across ALL bots. Over budget -> short backoff,
//      then (if still over) skip rather than pile onto a 429 storm.
//
// Env knobs (all optional):
//   GROQ_STT_RPM            global requests/minute ceiling (default 18, under 20)
//   GROQ_STT_DEDUP_WINDOW_MS   clip-window size for dedup keying (default 6000)
//   GROQ_STT_CACHE_TTL_MS   how long a cached transcript stays reusable (default 15000)
//   GROQ_STT_MAX_WAIT_MS    max backoff before giving up a slot (default 1500)
//
// IMPORTANT: contains NO backticks anywhere (string concat only) — the fleet has
// historically dropped into CORE-SAFE MODE on a stray backtick in a template.

import fs from 'fs';
import path from 'path';

const STATE_DIR = 'c:/KAI/tools/oracle-discord/state';
const BUCKET_FILE = path.join(STATE_DIR, 'groq_stt_bucket.json');
const CACHE_FILE = path.join(STATE_DIR, 'groq_stt_dedup.json');

const RPM = Math.max(1, parseInt(process.env.GROQ_STT_RPM || '18', 10) || 18);
const DEDUP_WINDOW_MS = parseInt(process.env.GROQ_STT_DEDUP_WINDOW_MS || '6000', 10) || 6000;
const CACHE_TTL_MS = parseInt(process.env.GROQ_STT_CACHE_TTL_MS || '15000', 10) || 15000;
const MAX_WAIT_MS = parseInt(process.env.GROQ_STT_MAX_WAIT_MS || '1500', 10) || 1500;

function ensureDir() {
  try { if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (e) {}
}

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { return null; }
}

function writeJson(file, obj) {
  // Atomic-ish: write a tmp then rename, so a concurrent reader never sees a
  // half-written file (which would throw and reset the bucket/cache).
  try {
    ensureDir();
    const tmp = file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  } catch (e) {}
}

// Build the dedup key from who spoke and which ~6s window the clip falls in.
// Same speaker + same window across bots => same key => one shared transcript.
export function sttDedupKey(userId, now) {
  const t = now || Date.now();
  const win = Math.floor(t / DEDUP_WINDOW_MS);
  return String(userId || 'unknown') + ':' + String(win);
}

// TIGHTENING (burst slip): bots finish capture at slightly different instants, so
// one can land at t=5999ms (window N) and another at t=6001ms (window N+1) for the
// SAME utterance — different keys => both transcribed. getCachedTranscript() below
// also checks the PREVIOUS window so that boundary slip reuses, not re-calls.
// Returns a cached transcript for this key (or its boundary-neighbour) if one was
// produced recently, else null. Accepts a single key string (back-compat) and also
// transparently checks the previous window so boundary slips reuse, not re-call.
export function getCachedTranscript(key) {
  const cache = readJson(CACHE_FILE);
  if (!cache) return null;
  // Derive neighbour keys (userId:win) so a clip landing one window over still hits.
  const keys = [key];
  const m = String(key).match(/^(.*):(\d+)$/);
  if (m) keys.push(m[1] + ':' + (parseInt(m[2], 10) - 1));
  for (const k of keys) {
    const entry = cache[k];
    if (entry && entry.text && (Date.now() - entry.ts <= CACHE_TTL_MS)) return entry.text;
  }
  return null;
}

// CLAIM (anti-race): the first bot to begin transcribing a window writes a short
// in-flight marker so concurrent bots (which would otherwise all see an empty cache
// and call Groq in parallel — a TOCTOU race that defeats dedup) instead WAIT for the
// winner's transcript. Cross-process + file-backed, mirrors the cache store.
const CLAIM_FILE = path.join(STATE_DIR, 'groq_stt_claim.json');
const CLAIM_TTL_MS = parseInt(process.env.GROQ_STT_CLAIM_TTL_MS || '5000', 10) || 5000;
// Try to atomically claim a key. Returns true if WE own the transcription, false if
// another bot already claimed it (caller should wait + reuse the cached result).
function tryClaim(key) {
  if (!key) return true;
  const now = Date.now();
  const claims = readJson(CLAIM_FILE) || {};
  // prune stale claims
  for (const k of Object.keys(claims)) { if (!claims[k] || now - claims[k] > CLAIM_TTL_MS) delete claims[k]; }
  if (claims[key] && now - claims[key] <= CLAIM_TTL_MS) { writeJson(CLAIM_FILE, claims); return false; }
  claims[key] = now;
  writeJson(CLAIM_FILE, claims);
  return true;
}
function releaseClaim(key) {
  if (!key) return;
  const claims = readJson(CLAIM_FILE) || {};
  if (claims[key]) { delete claims[key]; writeJson(CLAIM_FILE, claims); }
}

export function putCachedTranscript(key, text) {
  if (!text) return;
  const cache = readJson(CACHE_FILE) || {};
  cache[key] = { text: text, ts: Date.now() };
  // prune expired entries so the file does not grow forever
  const cutoff = Date.now() - CACHE_TTL_MS;
  for (const k of Object.keys(cache)) {
    if (!cache[k] || cache[k].ts < cutoff) delete cache[k];
  }
  writeJson(CACHE_FILE, cache);
}

// Try to consume one slot from the global rolling-window token bucket.
// Returns true if a request may proceed, false if we are at the RPM ceiling.
function tryConsumeSlot() {
  const now = Date.now();
  const state = readJson(BUCKET_FILE) || { hits: [] };
  const windowStart = now - 60000;
  const hits = (state.hits || []).filter(ts => ts > windowStart);
  if (hits.length >= RPM) {
    writeJson(BUCKET_FILE, { hits: hits });
    return false;
  }
  hits.push(now);
  writeJson(BUCKET_FILE, { hits: hits });
  return true;
}

// Acquire permission to make a Whisper call. Waits up to MAX_WAIT_MS for a free
// slot; returns true if granted, false if the fleet is saturated (caller should
// skip its redundant transcription rather than add to a 429 storm).
export async function acquireSttSlot() {
  const deadline = Date.now() + MAX_WAIT_MS;
  // first try immediately
  if (tryConsumeSlot()) return true;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    if (tryConsumeSlot()) return true;
  }
  return false;
}

// Convenience wrapper: dedup + rate-limit around a Whisper-calling function.
// - userId: who is speaking (for dedup keying); pass null to disable dedup.
// - doTranscribe: async () => string|null   (the actual Groq Whisper call)
// Returns the transcript string (possibly reused from cache) or null.
export async function limitedTranscribe(userId, doTranscribe, label) {
  const tag = label ? ('[' + label + '/STT]') : '[STT]';
  const key = userId != null ? sttDedupKey(userId) : null;

  if (key) {
    const cached = getCachedTranscript(key);
    if (cached != null) {
      console.log(tag + ' Reusing fleet transcript (dedup hit) for ' + key);
      return cached;
    }
    // ANTI-RACE CLAIM: if another bot already claimed this utterance window, do NOT
    // call Groq in parallel — wait briefly for its transcript and reuse it. This is
    // what stops the 4-bots-hit-Whisper-at-once burst from slipping past the cache.
    if (!tryClaim(key)) {
      const waitDeadline = Date.now() + MAX_WAIT_MS;
      while (Date.now() < waitDeadline) {
        await new Promise(r => setTimeout(r, 150));
        const c = getCachedTranscript(key);
        if (c != null) {
          console.log(tag + ' Reusing fleet transcript (claim winner) for ' + key);
          return c;
        }
      }
      // Winner did not produce in time — fall through and transcribe ourselves.
    }
  }

  const granted = await acquireSttSlot();
  if (!granted) {
    // One more dedup check — another bot may have produced it while we waited.
    if (key) {
      const cached = getCachedTranscript(key);
      if (cached != null) {
        console.log(tag + ' Reusing fleet transcript after backoff for ' + key);
        releaseClaim(key);
        return cached;
      }
    }
    console.warn(tag + ' Groq STT at ' + RPM + ' RPM ceiling — skipping redundant transcription to avoid 429 storm.');
    releaseClaim(key);
    return null;
  }

  try {
    const text = await doTranscribe();
    if (key && text) putCachedTranscript(key, text);
    return text;
  } finally {
    releaseClaim(key);
  }
}
