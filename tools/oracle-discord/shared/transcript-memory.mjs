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
export function getRecentContext(limit = 10) {
  const db = getDB();
  const stmt = db.prepare(`
    SELECT speaker, user_id, content, channel_id, timestamp 
    FROM transcript_fts 
    ORDER BY timestamp DESC 
    LIMIT ?
  `);
  // FTS doesn't have an auto-incrementing ID easily accessible for ORDER BY unless rowid is used.
  // We use timestamp DESC. Then reverse to get chronological order.
  return stmt.all(limit).reverse();
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
