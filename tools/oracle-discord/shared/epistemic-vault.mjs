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
      CREATE TABLE IF NOT EXISTS epistemic_cells (
        id TEXT PRIMARY KEY,
        userId TEXT,
        timestamp INTEGER,
        content TEXT,
        summary TEXT,
        category TEXT,
        tags TEXT,
        confidence REAL,
        emotionalWeight REAL,
        accessCount INTEGER,
        lastAccessed INTEGER,
        relatedCells TEXT
      );
      
      CREATE INDEX IF NOT EXISTS idx_user_id ON epistemic_cells(userId);
      CREATE INDEX IF NOT EXISTS idx_category ON epistemic_cells(category);
    `);
  }
  return _db;
}

/**
 * Store a new Epistemic Cell or update an existing one.
 */
export function storeCell(cell) {
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO epistemic_cells (id, userId, timestamp, content, summary, category, tags, confidence, emotionalWeight, accessCount, lastAccessed, relatedCells)
    VALUES (@id, @userId, @timestamp, @content, @summary, @category, @tags, @confidence, @emotionalWeight, @accessCount, @lastAccessed, @relatedCells)
    ON CONFLICT(id) DO UPDATE SET
      confidence = MIN(1.0, epistemic_cells.confidence + excluded.confidence),
      emotionalWeight = MAX(epistemic_cells.emotionalWeight, excluded.emotionalWeight),
      accessCount = epistemic_cells.accessCount + 1,
      lastAccessed = excluded.lastAccessed
  `);

  stmt.run({
    id: cell.id || Math.random().toString(36).substring(2, 15),
    userId: cell.userId || 'system',
    timestamp: cell.timestamp || Date.now(),
    content: cell.content,
    summary: cell.summary || '',
    category: cell.category || 'general',
    tags: JSON.stringify(cell.tags || []),
    confidence: cell.confidence || 0.1,
    emotionalWeight: cell.emotionalWeight || 0.0,
    accessCount: cell.accessCount || 1,
    lastAccessed: Date.now(),
    relatedCells: JSON.stringify(cell.relatedCells || [])
  });
}

/**
 * Tiered Recall Strategy:
 * 1. User's Personal High-Importance (confidence * emotionalWeight * accessCount)
 * 2. Recent Session Memory (last 1 hour)
 * 3. General User History
 * 4. Shared Roundtable Knowledge
 */
export function recallTiered(userId, queryText, limit = 8) {
  const queryPattern = `%${queryText}%`;
  const oneHourAgo = Date.now() - (60 * 60 * 1000);

  const db = getDB();

  // 1. Matched High-Importance (Tier 1)
  const matched = db.prepare(`
    SELECT *, (confidence * emotionalWeight * (accessCount + 1)) as weight FROM epistemic_cells 
    WHERE userId = ? AND (content LIKE ? OR summary LIKE ?)
    ORDER BY weight DESC LIMIT ?
  `).all(userId, queryPattern, queryPattern, limit);

  // 2. Significance Fallback (If matches are low, pull the MOST IMPORTANT memories for this user)
  let finalCells = [...matched];
  if (finalCells.length < 3) {
    const significant = db.prepare(`
      SELECT *, (confidence * emotionalWeight * (accessCount + 1)) as weight FROM epistemic_cells 
      WHERE userId = ? AND (emotionalWeight > 0.6 OR accessCount > 2)
      AND id NOT IN (${finalCells.map(c => `'${c.id}'`).join(',') || "''"})
      ORDER BY weight DESC LIMIT ?
    `).all(userId, limit - finalCells.length);
    finalCells = [...finalCells, ...significant];
  }

  // 3. Shared Roundtable Knowledge (Tier 4)
  const system = db.prepare(`
    SELECT *, (confidence * emotionalWeight) as weight FROM epistemic_cells 
    WHERE userId = 'system' AND (content LIKE ? OR summary LIKE ?)
    ORDER BY weight DESC LIMIT 2
  `).all(queryPattern, queryPattern);

  const combined = [...finalCells, ...system].slice(0, limit);

  // Boost confidence of accessed cells
  combined.forEach(cell => {
    boostConfidence(cell.id, 0.05);
  });

  return combined.map(c => ({
    ...c,
    tags: JSON.parse(c.tags || '[]'),
    relatedCells: JSON.parse(c.relatedCells || '[]')
  }));
}

/**
 * Strengthen a memory cell.
 */
export function boostConfidence(id, amount = 0.15) {
  const db = getDB();
  const stmt = db.prepare(`
    UPDATE epistemic_cells 
    SET confidence = MIN(1.0, confidence + ?),
        emotionalWeight = MIN(1.0, emotionalWeight + 0.05),
        accessCount = accessCount + 1,
        lastAccessed = ?
    WHERE id = ?
  `);
  stmt.run(amount, Date.now(), id);
}

/**
 * KAI's Pruning Logic: Weaken old, unused memories.
 */
export function pruneLattice(threshold = 0.2) {
  const db = getDB();
  const stmt = db.prepare(`
    DELETE FROM epistemic_cells 
    WHERE confidence < ? AND accessCount < 2 AND (strftime('%s', 'now') - lastAccessed/1000) > 86400
  `);
  const result = stmt.run(threshold);
  return result.changes;
}
