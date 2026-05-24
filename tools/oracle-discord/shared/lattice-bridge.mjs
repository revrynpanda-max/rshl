/**
 * lattice-bridge.mjs — RSHL Lattice Query/Store Interface (Production Edition)
 *
 * Optimized for Discord-scale traffic with:
 *   - LRU query cache (prevents redundant lattice hits)
 *   - Fast-path for common queries
 *   - Connection-aware health checks
 *   - Batched corpus logging
 *
 * The RSHL (Recursive Sparse Hyperdimensional Lattice) runs at
 * http://127.0.0.1:3334.  If it's not running, every function returns
 * empty results gracefully — no crash, no hang.
 */

const LATTICE_URL = process.env.ORACLE_API_URL || "http://127.0.0.1:3334";

// Timeouts tuned for production Discord traffic
const QUERY_TIMEOUT_MS = 1500;   // was 4000 — 1.5s is the UX pain threshold
const STORE_TIMEOUT_MS = 1000;   // store should be fire-and-forget fast
const CORPUS_TIMEOUT_MS = 800;   // corpus logging must never block chat
const CHAT_TIMEOUT_MS = 5000;    // native voice can take longer

// ── LRU Cache ───────────────────────────────────────────────────────────────
// Simple in-memory cache for queryLattice. Key = "question|limit|region|userId"
// Prevents hammering the Rust engine with identical queries from multiple bots.
const queryCache = new Map();
const CACHE_TTL_MS = 30000;      // 30s freshness
const CACHE_MAX_SIZE = 200;

function cacheKey(question, limit, region, userId) {
  return `${question.trim().toLowerCase()}|${limit}|${region}|${userId}`;
}

function getCached(key) {
  const entry = queryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    queryCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value) {
  if (queryCache.size >= CACHE_MAX_SIZE) {
    const oldest = queryCache.keys().next().value;
    queryCache.delete(oldest);
  }
  queryCache.set(key, { value, ts: Date.now() });
}

// ── Connection Health ───────────────────────────────────────────────────────
let lastHealthCheck = 0;
let isHealthy = true;
const HEALTH_CHECK_INTERVAL_MS = 10000;

async function ensureHealth() {
  const now = Date.now();
  if (now - lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) return isHealthy;
  lastHealthCheck = now;
  try {
    const res = await fetch(`${LATTICE_URL}/api/status`, {
      signal: AbortSignal.timeout(500)
    });
    isHealthy = res.ok;
    return isHealthy;
  } catch {
    isHealthy = false;
    return false;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Query the RSHL lattice — cached, fast, graceful.
 */
export async function queryLattice(question, limit = 5, region = "", userId = "") {
  if (!question || question.trim().length < 3) return [];

  const key = cacheKey(question, limit, region, userId);
  const cached = getCached(key);
  if (cached !== null) return cached;

  const healthy = await ensureHealth();
  if (!healthy) return [];

  try {
    const res = await fetch(`${LATTICE_URL}/api/rshl/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: question.trim(),
        limit,
        region: region || undefined,
        user_id: userId || undefined
      }),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS)
    });

    if (!res.ok) return [];
    const hits = await res.json();
    const result = Array.isArray(hits) ? hits : [];
    setCached(key, result);
    return result;
  } catch (e) {
    return [];
  }
}

/**
 * Store a fact — fire-and-forget, no waiting.
 */
export async function storeLattice(text, source = 'oracle', strength = 2.0, region = 'general', userId = "") {
  if (!text || text.trim().length < 5) return false;

  // Don't block on health check — try anyway
  try {
    const res = await fetch(`${LATTICE_URL}/api/rshl/store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.trim(),
        source,
        strength,
        region,
        user_id: userId || undefined
      }),
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS)
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// ── Batched Corpus Logging ──────────────────────────────────────────────────
// Multiple bots may call logTrainingCorpus simultaneously.  We batch them
// into a single HTTP POST every 2 seconds to reduce connection overhead.

let corpusBatch = [];
let corpusFlushTimer = null;

async function flushCorpusBatch() {
  if (corpusBatch.length === 0) return;
  const batch = corpusBatch.splice(0, corpusBatch.length);
  try {
    await fetch(`${LATTICE_URL}/api/corpus-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch }),
      signal: AbortSignal.timeout(CORPUS_TIMEOUT_MS)
    });
  } catch (e) {
    // Silent — training must never block
  }
}

export async function logTrainingCorpus(input, reply, meta = {}) {
  if (!input || !reply) return false;

  corpusBatch.push({
    input: input.trim(),
    reply: reply.trim(),
    user_id: meta.user_id || "",
    channel_id: meta.channel_id || "",
    confidence: meta.confidence ?? 0.0,
    conflict: meta.conflict ?? 0.0,
    valence: meta.valence ?? 0.0,
    mood: meta.mood || "",
    hits: meta.hits || []
  });

  if (corpusBatch.length >= 10) {
    await flushCorpusBatch();
  } else if (!corpusFlushTimer) {
    corpusFlushTimer = setTimeout(() => {
      corpusFlushTimer = null;
      flushCorpusBatch();
    }, 2000);
  }
  return true;
}

/**
 * Route through KAI's native generative voice.
 */
export async function chatWithKaiNative(prompt, userId = "") {
  if (!prompt || prompt.trim().length < 2) return null;

  const healthy = await ensureHealth();
  if (!healthy) return null;

  try {
    const res = await fetch(`${LATTICE_URL}/api/discord-turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: userId ? `discord-${userId}` : "DiscordUser",
        text: prompt.trim(),
        user_id: userId || undefined
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS)
    });

    if (!res.ok) return null;
    const json = await res.json();
    return json?.reply || json?.kai_reply || null;
  } catch (e) {
    return null;
  }
}

/**
 * Quick lattice health check.
 */
export async function isLatticeOnline() {
  return ensureHealth();
}

/**
 * Clear the query cache (useful after major lattice ingestion).
 */
export function invalidateLatticeCache() {
  queryCache.clear();
}

/**
 * Force-flush any pending corpus logs (call before shutdown).
 */
export async function flushTrainingLogs() {
  await flushCorpusBatch();
}
