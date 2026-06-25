import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { HUMAN_IDS, AI_IDS } from './identities.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'transcripts.db');

// Retention / cleanup tuning (env-overridable). RAW transcripts are kept only
// for a recent window; older BOT-to-BOT chatter is deleted while human lines and
// all structured-memory tables (user_profile_memories, message_meta) are KEPT.
const RETENTION_DAYS = Math.max(1, Number(process.env.TRANSCRIPT_RETENTION_DAYS) || 14);
const DEDUP_WINDOW_MS = Math.max(0, Number(process.env.TRANSCRIPT_DEDUP_WINDOW_MS) || 4000);

let _db = null;
function getDB() {
  if (!_db) {
    _db = new Database(dbPath, { timeout: 15000 });
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    // Let VACUUM/auto-vacuum actually return freed pages to the OS over time.
    try { _db.pragma('auto_vacuum = INCREMENTAL'); } catch (_) {}
    _db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
        speaker,
        user_id UNINDEXED,
        content,
        context,
        channel_id UNINDEXED,
        timestamp UNINDEXED
      );
      
      CREATE TABLE IF NOT EXISTS user_profile_memories (
        id TEXT PRIMARY KEY,
        userId TEXT,
        username TEXT,
        channelId TEXT,
        timestamp INTEGER,
        content TEXT,
        previousContent TEXT,
        previousSpeaker TEXT,
        intent TEXT,
        tags TEXT,
        metadata TEXT
      );

      -- Per-message cognition sidecar (item 5). transcript_fts is an FTS5 virtual
      -- table and cannot take ALTER TABLE ADD COLUMN, so the captured vitals live
      -- here keyed by the FTS rowid (transcript_fts exposes an implicit rowid).
      -- BACKWARD-COMPATIBLE: old transcript rows simply have no sidecar row, and
      -- readers must treat a missing row / NULL column as "not captured" (never 0).
      CREATE TABLE IF NOT EXISTS message_meta (
        fts_rowid   INTEGER PRIMARY KEY,
        channel_id  TEXT,
        thread_id   TEXT,
        timestamp   INTEGER,
        phi_g       REAL,
        coherence   REAL,
        contradiction INTEGER,
        learned_by_kai INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_message_meta_chan_ts
        ON message_meta(channel_id, timestamp);

      -- STRUCTURED CATEGORIZED MEMORY (the small, valuable store). One row per
      -- discrete fact ABOUT a person/AI, filed under a CATEGORY (like / dislike /
      -- does / doesnt / pattern / says / fact — extensible). This is what lets Leo
      -- load "who this person is" on demand WITHOUT replaying the raw transcript.
      -- Deduped by (entity_id, category, key_norm): a repeated signal bumps
      -- mentions + last_seen instead of inserting a duplicate row. Kept SMALL.
      CREATE TABLE IF NOT EXISTS entity_facts (
        id          TEXT PRIMARY KEY,
        entity_id   TEXT,          -- Discord user id (or AI id)
        entity_name TEXT,          -- display name at capture time
        category    TEXT,          -- like|dislike|does|doesnt|pattern|says|fact
        key_norm    TEXT,          -- normalized dedup key (lowercased subject)
        value       TEXT,          -- human-readable fact text
        confidence  REAL,          -- 0..1 heuristic confidence
        source      TEXT,          -- 'auto' (heuristic) | 'explicit' (API set)
        first_seen  INTEGER,
        last_seen   INTEGER,
        mentions    INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_facts_dedup
        ON entity_facts(entity_id, category, key_norm);
      CREATE INDEX IF NOT EXISTS idx_entity_facts_entity
        ON entity_facts(entity_id, category);
    `);
    // Speed up channel/timestamp scans used by dedup, recency and retention.
    // (FTS5 external content tables can't be indexed directly, but its shadow
    //  rowid ordering already tracks insert order; this index is for the
    //  duplicate-detection / retention SELECTs that filter by channel+time.)
    try {
      _db.exec(`CREATE INDEX IF NOT EXISTS idx_fts_chan_ts
                  ON transcript_fts(channel_id, timestamp);`);
    } catch (_) { /* fts5 may reject; dedup falls back to a content scan */ }
  }
  return _db;
}

// ── Deferred / batched write queue ──────────────────────────────────────────
// FTS5 index maintenance is the expensive part of an ingest. We take the caller
// off that critical path: ingestMessage records the row into an in-memory queue
// and returns immediately; a microtask/timer flushes the batch inside ONE
// transaction (one fts index update for the whole batch instead of N inline
// ones). Writes still land — just not synchronously on the caller's thread.
const _writeQueue = [];
let _flushScheduled = false;
const _FLUSH_DELAY_MS = Math.max(0, Number(process.env.TRANSCRIPT_FLUSH_MS) || 150);

function _scheduleFlush() {
  if (_flushScheduled) return;
  _flushScheduled = true;
  // setImmediate keeps it off the caller's stack; the timer batches bursts.
  const fire = () => { _flushScheduled = false; _flushQueue(); };
  if (_FLUSH_DELAY_MS === 0) setImmediate(fire);
  else setTimeout(fire, _FLUSH_DELAY_MS).unref?.();
}

function _flushQueue() {
  if (_writeQueue.length === 0) return;
  const batch = _writeQueue.splice(0, _writeQueue.length);
  const db = getDB();
  const insFts = db.prepare(`
    INSERT INTO transcript_fts (speaker, user_id, content, context, channel_id, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const insMeta = db.prepare(`
    INSERT OR REPLACE INTO message_meta
      (fts_rowid, channel_id, thread_id, timestamp, phi_g, coherence, contradiction, learned_by_kai)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insProfile = db.prepare(`
    INSERT INTO user_profile_memories (id, userId, username, channelId, timestamp, content, previousContent, previousSpeaker, intent, tags, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  try {
    db.transaction((rows) => {
      for (const r of rows) {
        const ins = insFts.run(r.speaker, r.userId, r.content, r.content, r.channelId, r.ts);
        if (r.haveMeta) {
          insMeta.run(Number(ins.lastInsertRowid), r.channelId, r.threadId, r.ts,
                      r.phiG, r.coher, r.contra, r.learned);
        }
        insProfile.run(r.memoryId, String(r.userId).toLowerCase(), r.speaker.toLowerCase(),
                       r.channelId, r.ts, r.content, r.previousContent, r.previousSpeaker,
                       r.intent, r.tags, r.metadata);
      }
    })(batch);
  } catch (e) {
    console.error('[TranscriptMemory] deferred flush failed:', e.message);
  }
}

// Flush anything still queued on process exit so nothing is silently dropped.
try {
  process.once('beforeExit', () => { try { _flushQueue(); } catch (_) {} });
} catch (_) {}

/**
 * Ingest a single message into the episodic transcript memory.
 * @param {string} speaker - Name of the sender (e.g. "Ryan", "Leo")
 * @param {string} userId - Discord User ID
 * @param {string} content - Message text
 * @param {string} channelId - Discord channel ID
 * @param {object} [meta] - OPTIONAL per-message cognition vitals captured at send
 *   time, sourced from what the engine/bot already has — NOT a new engine call.
 *   Any field that is genuinely unavailable should be omitted/undefined so it is
 *   persisted as NULL and surfaced as "not captured" (never 0). Shape:
 *   { threadId?:string, phiG?:number, coherence?:number,
 *     contradiction?:number|boolean, learnedByKai?:boolean }
 */
export function ingestMessage(speaker, userId, content, channelId, meta) {
  if (!content || content.trim() === '') return;

  const db = getDB();
  const nowTs = Date.now();

  // 0. DEDUP — the same line is ingested 2-3x (each bot process re-stores the
  // same post; voice + text paths overlap). Skip if an identical row (same
  // speaker + content + channel) was written within DEDUP_WINDOW_MS. We check
  // BOTH the pending in-memory queue and the FTS table so memory + FTS stay in
  // sync (we never half-insert). This kills the duplicate bloat at the source.
  try {
    const dupInQueue = _writeQueue.some(r =>
      r.channelId === channelId && r.speaker === speaker && r.content === content &&
      (nowTs - r.ts) <= DEDUP_WINDOW_MS);
    if (dupInQueue) return;
    if (DEDUP_WINDOW_MS > 0) {
      const recent = db.prepare(`
        SELECT 1 FROM transcript_fts
        WHERE channel_id = ? AND speaker = ? AND content = ? AND timestamp >= ?
        LIMIT 1`).get(channelId, speaker, content, nowTs - DEDUP_WINDOW_MS);
      if (recent) return; // duplicate within the window → drop silently
    }
  } catch (e) {
    console.warn('[TranscriptMemory] dedup check failed (continuing):', e.message);
  }

  // 1. Capture conversational context (the message immediately preceding this
  // one in the channel). Also consult the pending queue so context is correct
  // even before the previous row has flushed to disk.
  let previousSpeaker = null;
  let previousContent = null;
  try {
    const queuedPrev = [..._writeQueue].reverse().find(r => r.channelId === channelId);
    if (queuedPrev) {
      previousSpeaker = queuedPrev.speaker;
      previousContent = queuedPrev.content;
    } else {
      const lastMsg = db.prepare(`
        SELECT speaker, content FROM transcript_fts
        WHERE channel_id = ?
        ORDER BY timestamp DESC
        LIMIT 1
      `).get(channelId);
      if (lastMsg) {
        previousSpeaker = lastMsg.speaker;
        previousContent = lastMsg.content;
      }
    }
  } catch (e) {
    console.warn('[TranscriptMemory] Previous message query failed:', e.message);
  }

  // 2. Normalize the per-message cognition vitals (item 5) + thread_id (item 6).
  // Only fields actually provided are stored; everything else stays NULL → read
  // side labels it "not captured". A sidecar (message_meta) row is only written
  // when we have at least one real captured value or a thread.
  const m = meta || {};
  const threadId = (m.threadId != null && String(m.threadId) !== '') ? String(m.threadId) : null;
  const phiG     = (typeof m.phiG === 'number' && isFinite(m.phiG)) ? m.phiG : null;
  const coher    = (typeof m.coherence === 'number' && isFinite(m.coherence)) ? m.coherence : null;
  const contra   = (m.contradiction === undefined || m.contradiction === null)
                     ? null : (m.contradiction ? Number(m.contradiction) : 0);
  const learned  = (m.learnedByKai === undefined || m.learnedByKai === null)
                     ? null : (m.learnedByKai ? 1 : 0);
  const haveMeta = threadId !== null || phiG !== null || coher !== null
                     || contra !== null || learned !== null;

  // 3. Extract keywords (tags) for search optimization
  const stopwords = new Set(["about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "aren't", "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "can't", "cannot", "could", "couldn't", "did", "didn't", "do", "does", "doesn't", "doing", "don't", "down", "during", "each", "few", "for", "from", "further", "had", "hadn't", "has", "hasn't", "have", "haven't", "having", "he", "he'd", "he'll", "he's", "her", "here", "here's", "hers", "herself", "him", "himself", "his", "how", "how's", "i", "i'd", "i'll", "i'm", "i've", "if", "in", "into", "is", "isn't", "it", "it's", "its", "itself", "let's", "me", "more", "most", "mustn't", "my", "myself", "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves", "out", "over", "own", "same", "shan't", "she", "she'd", "she'll", "she's", "should", "shouldn't", "so", "some", "such", "than", "that", "that's", "the", "their", "theirs", "them", "themselves", "then", "there", "there's", "these", "they", "they'd", "they'll", "they're", "they've", "this", "those", "through", "to", "too", "under", "until", "up", "very", "was", "wasn't", "we", "we'd", "we'll", "we're", "we've", "were", "weren't", "what", "what's", "when", "when's", "where", "where's", "which", "while", "who", "who's", "whom", "why", "why's", "with", "won't", "would", "wouldn't", "you", "you'd", "you'll", "you're", "you've", "your", "yours", "yourself", "yourselves"]);
  const words = content.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/);
  const tagsList = [...new Set(words.filter(w => w.length > 4 && !stopwords.has(w)))];
  const tags = tagsList.join(',');

  // 4. Deduce a structured intent tag dynamically
  let intent = "statement";
  if (content.endsWith('?')) intent = "question";
  else if (content.toLowerCase().includes("build") || content.toLowerCase().includes("code") || content.toLowerCase().includes("repo")) intent = "development plan";
  else if (content.toLowerCase().includes("love") || content.toLowerCase().includes("like") || content.toLowerCase().includes("fire")) intent = "preference expression";
  else if (content.toLowerCase().includes("hate") || content.toLowerCase().includes("bloat") || content.toLowerCase().includes("garbage")) intent = "strong opposition";

  // 5. Enqueue the row for a deferred, batched, transactional write. The caller
  // returns now; _flushQueue lands the FTS row, the sidecar and the profile row
  // together so all three stay consistent. Signature/return are unchanged.
  const memoryId = `${userId}_${nowTs}_${Math.floor(Math.random() * 10000)}`;
  _writeQueue.push({
    speaker, userId, content, channelId, ts: nowTs,
    haveMeta, threadId, phiG, coher, contra, learned,
    memoryId, previousContent, previousSpeaker, intent, tags,
    metadata: JSON.stringify({ dateString: new Date(nowTs).toISOString() })
  });
  _scheduleFlush();
}

// ── Cached KAI vitals (phi_g) ────────────────────────────────────────────────
// Bots already display the engine's /api/status phi_g (see openjarvis.mjs). To
// stamp it onto each persisted reply WITHOUT a fresh engine call per message,
// we cache the last good value for a few seconds and reuse it. Returns the
// numeric phi_g, or null if the engine isn't reachable (→ "not captured").
let _phiCache = { value: null, ts: 0 };
const _PHI_TTL_MS = 5000;
export async function getCachedPhiG() {
  const now = Date.now();
  if (_phiCache.value !== null && (now - _phiCache.ts) < _PHI_TTL_MS) return _phiCache.value;
  try {
    const url = (process.env.ORACLE_API_URL || 'http://127.0.0.1:3334') + '/api/status';
    const res = await fetch(url, { signal: AbortSignal.timeout(500) });
    if (res.ok) {
      const data = await res.json();
      const phi = (typeof data.phi_g === 'number') ? data.phi_g
                : (typeof data.phi === 'number') ? data.phi : null;
      if (phi !== null) { _phiCache = { value: phi, ts: now }; return phi; }
    }
  } catch (_) { /* engine down → not captured */ }
  return null;
}

/**
 * Read the per-message cognition sidecar for the FTS row that best matches a
 * channel + timestamp window. Returns null when no sidecar row exists (old rows
 * / values genuinely not captured at send time). READ-ONLY.
 * @param {string} channelId
 * @param {number} tsMs - message timestamp in ms
 * @param {number} [windowMs=2000]
 */
export function readMessageMeta(channelId, tsMs, windowMs = 2000) {
  const db = getDB();
  try {
    return db.prepare(
      `SELECT thread_id, phi_g, coherence, contradiction, learned_by_kai, timestamp
         FROM message_meta
        WHERE channel_id = ? AND timestamp BETWEEN ? AND ?
        ORDER BY ABS(timestamp - ?) LIMIT 1`
    ).get(String(channelId), tsMs - windowMs, tsMs + windowMs, tsMs) || null;
  } catch (e) {
    console.warn('[TranscriptMemory] readMessageMeta failed:', e.message);
    return null;
  }
}

/**
 * List the real captured thread_ids for a channel (item 6) — read straight from
 * the sidecar, not inferred. Returns [] when nothing was captured.
 */
export function listCapturedThreads(channelId) {
  const db = getDB();
  try {
    return db.prepare(
      `SELECT thread_id AS threadId, COUNT(*) AS messages, MAX(timestamp) AS lastTs
         FROM message_meta
        WHERE channel_id = ? AND thread_id IS NOT NULL AND thread_id != ?
        GROUP BY thread_id ORDER BY lastTs DESC`
    ).all(String(channelId), String(channelId));
  } catch (e) {
    console.warn('[TranscriptMemory] listCapturedThreads failed:', e.message);
    return [];
  }
}

/**
 * Fetch the transcript messages persisted under a given thread_id (item 6),
 * joining the sidecar back to transcript_fts by rowid. Read-only.
 */
export function readThreadMessages(threadId, limit = 100) {
  const db = getDB();
  try {
    return db.prepare(
      `SELECT f.speaker, f.user_id, f.content, f.channel_id, f.timestamp
         FROM message_meta m JOIN transcript_fts f ON f.rowid = m.fts_rowid
        WHERE m.thread_id = ?
        ORDER BY f.timestamp ASC LIMIT ?`
    ).all(String(threadId), Number(limit));
  } catch (e) {
    console.warn('[TranscriptMemory] readThreadMessages failed:', e.message);
    return [];
  }
}

/**
 * Search the transcript memory for context related to a query.
 * @param {string} query - The search terms
 * @param {number} limit - Max number of results to return
 * @returns {Array} List of matching transcripts
 */
export function recallMemory(query, limit = 5) {
  if (!query || query.trim() === '') return [];

  // FTS5 is sensitive. We sanitize and wrap the query to prevent syntax errors.
  const safeQuery = query.replace(/[^\w\s]/g, '').trim().split(/\s+/).join(' OR ');

  try {
    const db = getDB();
    const stmt = db.prepare(`
      SELECT speaker, content, channel_id, timestamp 
      FROM transcript_fts 
      WHERE context MATCH ? 
      ORDER BY rank 
      LIMIT ?
    `);

    return stmt.all(safeQuery, limit);
  } catch (err) {
    console.error('[TranscriptMemory] Search failed:', err.message);
    return [];
  }
}

/**
 * Fetch the last N messages to establish recent context.
 * @param {number} limit - Number of messages to retrieve
 */
export function getRecentContext(limit = 10, channelId = null) {
  const db = getDB();
  // SCOPE TO ONE CHANNEL when given. Without this, recall returned the globally
  // newest rows — which were mostly other bots' cross-channel chatter and Leo's
  // own re-posts — instead of THIS conversation. Pass the user's transcript
  // channel to get the real back-and-forth.
  const stmt = channelId
    ? db.prepare(`SELECT speaker, user_id, content, channel_id, timestamp
                  FROM transcript_fts WHERE channel_id = ?
                  ORDER BY timestamp DESC LIMIT ?`)
    : db.prepare(`SELECT speaker, user_id, content, channel_id, timestamp
                  FROM transcript_fts ORDER BY timestamp DESC LIMIT ?`);
  const rows = channelId ? stmt.all(channelId, limit) : stmt.all(limit);
  return rows.reverse();
}

/**
 * Advanced query engine for user profile memories with flexible metadata filters.
 * @param {string} userId - Discord User ID or username
 * @param {Object} filters - Search filters (query, channelId, limit, dateStart, dateEnd)
 */
export function recallProfileMemories(userId, filters = {}) {
  const db = getDB();
  const lookupId = String(userId).toLowerCase();
  
  let sql = `SELECT * FROM user_profile_memories WHERE (userId = ? OR username = ?)`;
  const params = [lookupId, lookupId];

  if (filters.channelId) {
    sql += ` AND channelId = ?`;
    params.push(filters.channelId);
  }

  if (filters.dateStart) {
    sql += ` AND timestamp >= ?`;
    params.push(Number(filters.dateStart));
  }

  if (filters.dateEnd) {
    sql += ` AND timestamp <= ?`;
    params.push(Number(filters.dateEnd));
  }

  if (filters.query) {
    const searchWords = filters.query.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);
    if (searchWords.length > 0) {
      sql += ` AND (`;
      const clauses = [];
      searchWords.forEach(word => {
        clauses.push(`(content LIKE ? OR tags LIKE ? OR intent LIKE ?)`);
        const searchPattern = `%${word}%`;
        params.push(searchPattern, searchPattern, searchPattern);
      });
      sql += clauses.join(' OR ');
      sql += `)`;
    }
  }

  sql += ` ORDER BY timestamp DESC`;

  if (filters.limit) {
    sql += ` LIMIT ?`;
    params.push(Number(filters.limit));
  } else {
    sql += ` LIMIT 5`;
  }

  try {
    return db.prepare(sql).all(...params);
  } catch (e) {
    console.error('[TranscriptMemory/ProfileMemories] Recall failed:', e.message);
    return [];
  }
}

// ── STRUCTURED CATEGORIZED MEMORY (entity_facts) ─────────────────────────────
// The small, high-value store: discrete facts ABOUT a person/AI, categorized.
// CATEGORIES: like, dislike, does, doesnt, pattern, says, fact (extensible).
// Capture is CHEAP — regex/keyword heuristics only, NO LLM call on the write
// path. It deliberately only fires on clear self-statements ("I like X",
// "I hate X", "I always/never …"). Everything is deduped by entity+category+
// normalized-key so a repeated signal just bumps mentions/last_seen.

const _FACT_CATEGORIES = new Set(['like', 'dislike', 'does', 'doesnt', 'pattern', 'says', 'fact']);

// Normalize a subject for dedup: lowercase, strip punctuation, collapse spaces,
// drop leading articles, cap length. Keeps the key SMALL and collision-stable.
function _normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/^\s*(the|a|an|to|that)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Upsert a categorized fact about an entity. Explicit API for set/correct, and
 * the heuristic capture below calls it too. Deduped: same entity+category+key
 * bumps mentions + last_seen (and refreshes value/confidence) instead of
 * inserting a duplicate. Cheap, synchronous, never throws to the caller.
 * @returns {boolean} true if stored/updated
 */
export function setEntityFact(entityId, entityName, category, value, opts = {}) {
  try {
    const cat = String(category || '').toLowerCase();
    if (!_FACT_CATEGORIES.has(cat)) return false;
    const val = String(value || '').replace(/\s+/g, ' ').trim();
    if (!entityId || !val) return false;
    const keyNorm = _normKey(opts.key != null ? opts.key : val);
    if (!keyNorm) return false;
    const db = getDB();
    const now = Date.now();
    const conf = (typeof opts.confidence === 'number') ? Math.max(0, Math.min(1, opts.confidence)) : 0.6;
    const source = opts.source || 'auto';
    const eid = String(entityId);
    const existing = db.prepare(
      `SELECT id, mentions FROM entity_facts WHERE entity_id = ? AND category = ? AND key_norm = ?`
    ).get(eid, cat, keyNorm);
    if (existing) {
      db.prepare(
        `UPDATE entity_facts SET value = ?, confidence = MAX(confidence, ?), source = ?,
           last_seen = ?, mentions = mentions + 1, entity_name = ? WHERE id = ?`
      ).run(val, conf, source, now, String(entityName || ''), existing.id);
    } else {
      const id = `${eid}_${cat}_${now}_${Math.floor(Math.random() * 10000)}`;
      db.prepare(
        `INSERT INTO entity_facts
           (id, entity_id, entity_name, category, key_norm, value, confidence, source, first_seen, last_seen, mentions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(id, eid, String(entityName || ''), cat, keyNorm, val, conf, source, now, now);
    }
    return true;
  } catch (e) {
    console.warn('[TranscriptMemory/Facts] setEntityFact failed:', e.message);
    return false;
  }
}

// Heuristic patterns → (category, capture-group index). Conservative on purpose:
// only clear first-person self-statements. The "X" subject is captured raw, then
// trimmed to a short clause so the stored fact stays compact and recallable.
const _SUBJECT_TRIM = (s) => String(s || '').split(/[.,;!?]| because | but | and then /i)[0].trim().slice(0, 100);
const _FACT_RULES = [
  // dislikes (check negatives BEFORE positives so "don't like" isn't a "like")
  { cat: 'dislike', re: /\bi\s+(?:really\s+)?(?:hate|despise|can'?t stand|loathe)\s+(.+)/i, conf: 0.7 },
  { cat: 'dislike', re: /\bi\s+(?:do\s*n'?t|don'?t|dont)\s+(?:really\s+)?(?:like|enjoy|want)\s+(.+)/i, conf: 0.7 },
  // likes
  { cat: 'like',    re: /\bi\s+(?:really\s+)?(?:love|adore)\s+(.+)/i, conf: 0.7 },
  { cat: 'like',    re: /\bi\s+(?:really\s+)?(?:like|enjoy|prefer|am into|favou?rite is)\s+(.+)/i, conf: 0.6 },
  // doesnt-do (negative habit)
  { cat: 'doesnt',  re: /\bi\s+(?:never|don'?t ever)\s+(.+)/i, conf: 0.6 },
  // patterns (habitual)
  { cat: 'pattern', re: /\bi\s+(?:usually|always|tend to|normally|generally|mostly)\s+(.+)/i, conf: 0.55 },
  // does (activity / habit)
  { cat: 'does',    re: /\bi\s+(?:do|make|build|play|work on|study|practice)\s+(.+)/i, conf: 0.5 },
];

/**
 * CHEAP heuristic capture from one message. Detects clear like/dislike/activity/
 * pattern self-statements and records the categorized fact. No LLM, no network,
 * regex only. Returns the array of facts it stored (often empty — that's fine).
 * Safe to call on the hot path. Misses are acceptable; false-positives are kept
 * low by requiring explicit first-person verbs.
 */
export function captureEntityFacts(entityId, entityName, content) {
  const out = [];
  try {
    const text = String(content || '').trim();
    if (!entityId || text.length < 4 || text.length > 600) return out;
    // First-person only — third-person/quoted text is too ambiguous to trust.
    if (!/\bi\b/i.test(text)) return out;
    for (const rule of _FACT_RULES) {
      const m = text.match(rule.re);
      if (m && m[1]) {
        const subject = _SUBJECT_TRIM(m[1]);
        if (subject.length < 2) continue;
        if (setEntityFact(entityId, entityName, rule.cat, subject, { confidence: rule.conf, source: 'auto' })) {
          out.push({ category: rule.cat, value: subject });
        }
        break; // one fact per message keeps it conservative + cheap
      }
    }
  } catch (e) {
    console.warn('[TranscriptMemory/Facts] captureEntityFacts failed:', e.message);
  }
  return out;
}

/**
 * RECALL the categorized profile for an entity — the "who is this person" load,
 * NOT the raw transcript. Returns { entityId, name, categories:{like:[...],...},
 * facts:[...], summary } where summary is a short human-readable string ready
 * for prompt injection.
 */
export function getEntityProfile(entityId, opts = {}) {
  const limit = Number(opts.limit) || 60;
  const empty = { entityId: String(entityId || ''), name: '', categories: {}, facts: [], summary: '' };
  try {
    if (!entityId) return empty;
    const db = getDB();
    const rows = db.prepare(
      `SELECT entity_name, category, value, confidence, mentions, last_seen
         FROM entity_facts WHERE entity_id = ?
        ORDER BY category, mentions DESC, last_seen DESC LIMIT ?`
    ).all(String(entityId), limit);
    if (!rows.length) return empty;
    const categories = {};
    for (const r of rows) {
      (categories[r.category] ||= []).push(r.value);
    }
    const name = rows[0].entity_name || '';
    // Compact human-readable summary, e.g. "likes: X, Y; dislikes: Z; pattern: …"
    const labelMap = { like: 'likes', dislike: 'dislikes', does: 'does', doesnt: "doesn't", pattern: 'patterns', says: 'says', fact: 'facts' };
    const parts = [];
    for (const cat of ['like', 'dislike', 'does', 'doesnt', 'pattern', 'says', 'fact']) {
      if (categories[cat]?.length) parts.push(`${labelMap[cat]}: ${categories[cat].slice(0, 6).join(', ')}`);
    }
    const summary = parts.length ? `${name ? name + ' — ' : ''}${parts.join('; ')}` : '';
    return { entityId: String(entityId), name, categories, facts: rows, summary };
  } catch (e) {
    console.warn('[TranscriptMemory/Facts] getEntityProfile failed:', e.message);
    return empty;
  }
}

// ── KAI ENGINE OFFLOAD / RECALL (RSHL lattice) ───────────────────────────────
// The engine is the deep/bulk memory store; SQLite is a thin rolling cache +
// the small structured facts above. These talk to the Rust oracle_server over
// HTTP. Endpoints CONFIRMED against C:\KAI\src\bridge\oracle_server.rs:
//   • POST /api/bulk-ingest  body { entries:[{ text, region, source, strength, user_id }] }
//       → 200 "Stored N / M entries"  (store_or_reinforce into the lattice)
//   • POST /api/rshl/query   body { query, n }
//       → 200 [{ label, text, region, score, strength, source, timestamp, user_id, ... }]
// ALL calls are async + short-timeout-guarded so they NEVER stall a caller.
//
// HONEST STATUS: the engine binary is currently FROZEN (needs a `cargo build
// --release` rebuild). Until that rebuild, these calls will simply fail-soft
// (timeout / connection refused) and:
//   • offload returns ok:false  → retention DEFERS pruning (nothing deleted),
//   • recall returns []         → callers fall back to the rolling SQLite window
//                                 + structured facts.
// Once the engine is rebuilt and live, deep/bulk recall activates with no code
// change here.
const _ENGINE_URL = process.env.ORACLE_API_URL || process.env.KAI_ENGINE_URL || 'http://127.0.0.1:3334';
const _ENGINE_INGEST_TIMEOUT_MS = Math.max(500, Number(process.env.KAI_INGEST_TIMEOUT_MS) || 4000);
const _ENGINE_QUERY_TIMEOUT_MS  = Math.max(500, Number(process.env.KAI_QUERY_TIMEOUT_MS) || 3000);

/**
 * Offload a batch of raw transcript rows to the KAI engine's bulk-ingest so the
 * memory is condensed into the lattice BEFORE the raw SQLite rows are pruned.
 * Resilient: short timeout, swallows errors, returns ok:false when the engine is
 * unreachable so the caller can DEFER deletion (never lose un-offloaded memory).
 * @param {Array<{speaker,user_id,content,channel_id,timestamp}>} rows
 * @returns {Promise<{ok:boolean, stored:number, error?:string}>}
 */
export async function offloadToEngine(rows) {
  const list = Array.isArray(rows) ? rows.filter(r => r && String(r.content || '').trim()) : [];
  if (list.length === 0) return { ok: true, stored: 0 };
  const entries = list.map(r => ({
    // Carry speaker + time inline so the lattice keeps attribution after the raw
    // SQLite row is gone. region/source label it as archived transcript memory.
    text: `${r.speaker ? r.speaker + ': ' : ''}${String(r.content).slice(0, 2000)}`,
    region: 'transcript',
    source: 'transcript-archive',
    strength: 0.5,
    user_id: String(r.user_id || '')
  }));
  try {
    const res = await fetch(_ENGINE_URL + '/api/bulk-ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
      signal: AbortSignal.timeout(_ENGINE_INGEST_TIMEOUT_MS)
    });
    if (!res.ok) return { ok: false, stored: 0, error: `engine ${res.status}` };
    return { ok: true, stored: entries.length };
  } catch (e) {
    // Engine down / frozen / unreachable → DO NOT signal success. Caller defers.
    return { ok: false, stored: 0, error: e.message };
  }
}

/**
 * Recall deep/bulk memory from the KAI engine by query. Returns the lattice hits
 * (compact) or [] if the engine is unreachable (→ caller uses the rolling SQLite
 * window + structured facts). Fully activates once the engine binary is rebuilt.
 * @param {string} query
 * @param {number} [n=5]
 * @returns {Promise<Array<{text,score,source,timestamp,user_id}>>}
 */
export async function recallFromEngine(query, n = 5) {
  const q = String(query || '').trim();
  if (!q) return [];
  try {
    const res = await fetch(_ENGINE_URL + '/api/rshl/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, n: Math.max(1, Number(n) || 5) }),
      signal: AbortSignal.timeout(_ENGINE_QUERY_TIMEOUT_MS)
    });
    if (!res.ok) return [];
    const hits = await res.json();
    if (!Array.isArray(hits)) return [];
    return hits.map(h => ({
      text: h.text, score: h.score, strength: h.strength,
      source: h.source, timestamp: h.timestamp, user_id: h.user_id, region: h.region
    }));
  } catch (_) {
    // Engine frozen/down → empty; recent memory carried by SQLite window + facts.
    return [];
  }
}

/**
 * MEMORY CONSOLIDATION (not pruning) — compress OLD verbatim messages into
 * compact per-person, per-day digests that keep the gist (names, facts,
 * decisions, reminders, preferences) and drop the filler. The active DB shrinks
 * and stays searchable; nothing is lost because every raw row is archived to a
 * cold file BEFORE it's removed. This is KAI's hippocampus model applied to the
 * chat log: recent = verbatim, older = consolidated.
 *
 * @param {(username:string, dayStr:string, joinedText:string)=>Promise<string>} summarizeFn
 *        Produces the digest for one person-day (you supply a local LLM).
 * @param {{olderThanDays?:number, minGroup?:number, dryRun?:boolean}} opts
 * @returns {Promise<object>} report
 */
export async function consolidateOldMemories(summarizeFn, opts = {}) {
  const { olderThanDays = 30, minGroup = 3, dryRun = false } = opts;
  const db = getDB();
  const cutoff = Date.now() - olderThanDays * 86400000;
  const dayKey = (ts) => new Date(Number(ts)).toISOString().slice(0, 10); // YYYY-MM-DD
  const archivePath = 'c:/KAI/data/transcript_archive.jsonl';
  const report = { groups: 0, messagesCompressed: 0, digestsCreated: 0, skippedSmall: 0, dryRun };

  // Old, non-digest profile memories (the rich per-person store).
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT id, userId, username, content, timestamp FROM user_profile_memories
        WHERE timestamp < ? AND content NOT LIKE '[DIGEST]%' ORDER BY userId, timestamp`
    ).all(cutoff);
  } catch (e) { return { ...report, error: e.message }; }

  // Group by person + day.
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.userId}|${dayKey(r.timestamp)}`;
    if (!groups.has(key)) groups.set(key, { userId: r.userId, username: r.username, day: dayKey(r.timestamp), items: [] });
    groups.get(key).items.push(r);
  }

  const fs = await import('fs');
  for (const g of groups.values()) {
    if (g.items.length < minGroup) { report.skippedSmall += g.items.length; continue; }
    report.groups++;
    report.messagesCompressed += g.items.length;
    if (dryRun) continue;

    let digest;
    try { digest = await summarizeFn(g.username || 'user', g.day, g.items.map(it => it.content).join('\n')); }
    catch (e) { console.warn('[Consolidate] summarize failed for', g.day, e.message); continue; }
    if (!digest || !digest.trim()) continue;

    // 1) Archive raw rows to cold storage BEFORE any delete — nothing is lost.
    try {
      for (const it of g.items) fs.appendFileSync(archivePath, JSON.stringify(it) + '\n');
    } catch (e) { console.warn('[Consolidate] archive failed — skipping group to stay safe:', e.message); continue; }

    // 2) Atomic: insert the digest, delete the originals from BOTH tables.
    const dayTs = new Date(g.day + 'T12:00:00Z').getTime();
    const dayStart = new Date(g.day + 'T00:00:00Z').getTime();
    const dayEnd = dayStart + 86400000;
    const digestContent = `[DIGEST] ${g.day} — ${digest.trim()}`;
    const ids = g.items.map(it => it.id);
    try {
      db.transaction(() => {
        db.prepare(`INSERT INTO user_profile_memories (id, userId, username, channelId, timestamp, content, previousContent, previousSpeaker, intent, tags, metadata)
          VALUES (?, ?, ?, '', ?, ?, '', '', 'digest', 'digest,consolidated', '')`)
          .run(`${g.userId}_digest_${dayTs}`, g.userId, g.username || '', dayTs, digestContent);
        db.prepare(`INSERT INTO transcript_fts (speaker, user_id, content, context, channel_id, timestamp)
          VALUES (?, ?, ?, ?, '', ?)`).run(g.username || 'user', g.userId, digestContent, digestContent, dayTs);
        const ph = ids.map(() => '?').join(',');
        db.prepare(`DELETE FROM user_profile_memories WHERE id IN (${ph})`).run(...ids);
        db.prepare(`DELETE FROM transcript_fts WHERE user_id = ? AND timestamp >= ? AND timestamp < ? AND content NOT LIKE '[DIGEST]%'`)
          .run(g.userId, dayStart, dayEnd);
      })();
      report.digestsCreated++;
    } catch (e) { console.warn('[Consolidate] transaction failed for', g.day, e.message); }
  }
  return report;
}

// ── ROLLING RETENTION / AUTO-CLEANUP ────────────────────────────────────────
// Keeps the RAW transcript log bounded so the DB file stops bloating. Inside ONE
// transaction it deletes raw transcript_fts rows OLDER than the retention window
// that were spoken by a known AI (bot-to-bot chatter), and the message_meta
// sidecar rows that hang off them. It DELIBERATELY KEEPS:
//   • every human line (user_id ∈ HUMAN_IDS) regardless of age,
//   • any [DIGEST] rollup rows (consolidated long-term memory),
//   • everything inside the recent window,
//   • ALL structured-memory tables: user_profile_memories (person/quote/profile
//     facts), and message_meta rows that still point at a surviving FTS row.
// After deleting it runs an incremental VACUUM + FTS 'optimize' so the file
// actually shrinks. Transactional and idempotent — safe to call repeatedly.
//
// @param {{retentionDays?:number, vacuum?:boolean, offload?:boolean}} opts
// @returns {Promise<object>} report { deletedTranscripts, deletedMeta, offloaded, deferred, retentionDays, vacuumed }
//
// NOTE: now async because it FIRST offloads the soon-to-be-pruned raw rows to the
// KAI engine (condensed into the lattice) so the memory is PRESERVED before the
// bloat is removed. If the engine is unreachable (frozen/down) the offload fails
// soft and we DEFER pruning — nothing is deleted that wasn't safely offloaded.
// Set opts.offload === false to skip the engine step (e.g. local-only maintenance).
export async function runRetention(opts = {}) {
  const retentionDays = Math.max(1, Number(opts.retentionDays) || RETENTION_DAYS);
  const doVacuum = opts.vacuum !== false;
  const doOffload = opts.offload !== false;
  const db = getDB();
  const cutoff = Date.now() - retentionDays * 86400000;
  const report = { deletedTranscripts: 0, deletedMeta: 0, offloaded: 0, deferred: false, retentionDays, vacuumed: false, cutoff };

  // Flush any queued writes first so we never delete around half-written rows.
  try { _flushQueue(); } catch (_) {}

  const aiIds = [...AI_IDS];
  if (aiIds.length === 0) return { ...report, note: 'no AI ids registered; nothing deleted' };
  const aiPh = aiIds.map(() => '?').join(',');

  // ── OFFLOAD-BEFORE-DELETE ──────────────────────────────────────────────────
  // Select the exact raw AI rows that retention is about to prune, hand them to
  // the KAI engine's bulk-ingest so they're condensed into the lattice, and only
  // proceed to delete if the engine confirms. Engine down → DEFER (keep rows).
  if (doOffload) {
    try {
      const stale = db.prepare(`
        SELECT speaker, user_id, content, channel_id, timestamp
          FROM transcript_fts
         WHERE timestamp < ? AND user_id IN (${aiPh})
           AND content NOT LIKE '[DIGEST]%'
         LIMIT 5000`).all(cutoff, ...aiIds);
      if (stale.length > 0) {
        const off = await offloadToEngine(stale);
        if (!off.ok) {
          // Engine frozen/unreachable — preserve memory: defer, delete nothing.
          console.warn('[TranscriptMemory] retention DEFERRED — engine offload unavailable:', off.error);
          return { ...report, deferred: true, note: 'engine unreachable; pruning deferred to preserve memory' };
        }
        report.offloaded = off.stored;
      }
    } catch (e) {
      // Any failure in the offload path must not risk data loss → defer.
      console.warn('[TranscriptMemory] retention DEFERRED — offload error:', e.message);
      return { ...report, deferred: true, error: e.message };
    }
  }

  try {
    db.transaction(() => {
      // 1. Drop the sidecar rows whose parent FTS row is about to be deleted.
      //    (Old AI chatter rows, beyond the window, not digests.)
      const metaRes = db.prepare(`
        DELETE FROM message_meta
        WHERE fts_rowid IN (
          SELECT rowid FROM transcript_fts
          WHERE timestamp < ? AND user_id IN (${aiPh})
            AND content NOT LIKE '[DIGEST]%'
        )`).run(cutoff, ...aiIds);
      report.deletedMeta = metaRes.changes || 0;

      // 2. Delete the raw bot-to-bot transcript lines beyond the window. Humans
      //    (user_id ∈ HUMAN_IDS) and digests are excluded by construction.
      const txRes = db.prepare(`
        DELETE FROM transcript_fts
        WHERE timestamp < ? AND user_id IN (${aiPh})
          AND content NOT LIKE '[DIGEST]%'`).run(cutoff, ...aiIds);
      report.deletedTranscripts = txRes.changes || 0;
    })();
  } catch (e) {
    console.error('[TranscriptMemory] retention transaction failed:', e.message);
    return { ...report, error: e.message };
  }

  // 3. Reclaim space + tidy the FTS index (outside the txn). 'optimize' merges
  //    the FTS b-tree; incremental_vacuum returns freed pages to the OS.
  if (doVacuum) {
    try { db.exec(`INSERT INTO transcript_fts(transcript_fts) VALUES('optimize');`); } catch (_) {}
    try { db.pragma('incremental_vacuum'); report.vacuumed = true; } catch (e) {
      console.warn('[TranscriptMemory] incremental_vacuum failed:', e.message);
    }
  }
  return report;
}

// ── Auto-cleanup wiring (startup-once, throttled, + periodic) ────────────────
// Runs retention shortly after import (off the boot critical path via a deferred
// timer) and then on a long interval. Throttled by a marker file so multiple bot
// processes don't all VACUUM at once. Disable with TRANSCRIPT_AUTOCLEAN=0.
const _RETENTION_INTERVAL_MS = Math.max(
  3600000, Number(process.env.TRANSCRIPT_RETENTION_INTERVAL_MS) || 6 * 3600000); // 6h
const _RETENTION_THROTTLE_MS = Math.max(
  3600000, Number(process.env.TRANSCRIPT_RETENTION_THROTTLE_MS) || 6 * 3600000);

function _retentionLockPath() {
  return path.join(__dirname, '..', '.transcript-retention.lock');
}

async function _maybeRunRetention(reason) {
  if (String(process.env.TRANSCRIPT_AUTOCLEAN ?? '1') === '0') return;
  let fs;
  try { fs = await import('fs'); } catch (_) { return; }
  const lock = _retentionLockPath();
  // Cross-process throttle: skip if another process ran recently.
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs < _RETENTION_THROTTLE_MS) return;
  } catch (_) { /* no lock yet → proceed */ }
  try { fs.writeFileSync(lock, String(Date.now())); } catch (_) {}
  try {
    const rep = await runRetention();
    console.log(`[TranscriptMemory] retention (${reason}) →`, JSON.stringify(rep));
  } catch (e) {
    console.warn('[TranscriptMemory] retention run failed:', e.message);
  }
}

// Startup-once: deferred so it never blocks boot. Then periodic.
try {
  if (String(process.env.TRANSCRIPT_AUTOCLEAN ?? '1') !== '0') {
    setTimeout(() => { _maybeRunRetention('startup'); }, 30000).unref?.();
    setInterval(() => { _maybeRunRetention('periodic'); }, _RETENTION_INTERVAL_MS).unref?.();
  }
} catch (_) {}
