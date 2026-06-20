import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'transcripts.db');

let _db = null;
function getDB() {
  if (!_db) {
    _db = new Database(dbPath, { timeout: 15000 });
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
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
    `);
  }
  return _db;
}

/**
 * Ingest a single message into the episodic transcript memory.
 * @param {string} speaker - Name of the sender (e.g. "Ryan", "Leo")
 * @param {string} userId - Discord User ID
 * @param {string} content - Message text
 * @param {string} channelId - Discord channel ID
 */
export function ingestMessage(speaker, userId, content, channelId) {
  if (!content || content.trim() === '') return;

  const db = getDB();

  // 1. Capture conversational context (the message immediately preceding this one in the channel)
  let previousSpeaker = null;
  let previousContent = null;
  try {
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
  } catch (e) {
    console.warn('[TranscriptMemory] Previous message query failed:', e.message);
  }

  // 2. Ingest into the standard FTS transcript logs
  const stmt = db.prepare(`
    INSERT INTO transcript_fts (speaker, user_id, content, context, channel_id, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(speaker, userId, content, content, channelId, Date.now());

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

  // 5. Store user profile memory row
  try {
    const memoryId = `${userId}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    db.prepare(`
      INSERT INTO user_profile_memories (id, userId, username, channelId, timestamp, content, previousContent, previousSpeaker, intent, tags, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memoryId, 
      String(userId).toLowerCase(), 
      speaker.toLowerCase(), 
      channelId, 
      Date.now(), 
      content, 
      previousContent, 
      previousSpeaker, 
      intent, 
      tags, 
      JSON.stringify({ dateString: new Date().toISOString() })
    );
  } catch (err) {
    console.error('[TranscriptMemory] Profile Memory insertion failed:', err.message);
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
