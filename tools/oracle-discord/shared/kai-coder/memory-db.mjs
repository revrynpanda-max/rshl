// shared/kai-coder/memory-db.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Kai Coder — Memory / Pattern Database (FOUNDATION module, NEW)
//
// PURPOSE
//   A dependency-light, durable store that gives Kai Coder a memory across
//   tasks. It holds two collections:
//
//     1. TASKS / CHECKLISTS  — { id, goal, steps[], status, ... }
//        A task is a unit of work with an ordered checklist of steps. Each step
//        carries its own status so the agent can resume / report partial work.
//
//     2. LEARNED PATTERNS    — { signature, context, approach_taken,
//                                outcome:'success'|'fail', score, evidence }
//        A pattern is "when I saw a problem like THIS (signature), in THIS
//        context, I tried THIS approach, and it WORKED or FAILED, with THIS
//        much confidence (score) and THIS evidence." The reinforcement loop
//        (rl.mjs) reads/writes these to learn what works.
//
// STORAGE
//   JSON-backed by default (no native build step, works everywhere). A single
//   JSON file per collection under:
//       c:/KAI/tools/oracle-discord/state/kai-coder/
//   Patterns are kept as a bounded RING (oldest, lowest-scored entries are
//   evicted once MAX_PATTERNS is exceeded) so the file can never grow without
//   bound on the 16GB host.
//
//   OPTIONAL: if `better-sqlite3` is installed (it is, per package.json) AND
//   the env var KAI_CODER_DB=sqlite is set, the same API is served from a
//   SQLite file instead. This is OFF by default to keep the running fleet
//   unaffected — JSON is the safe, additive default.
//
// LATTICE HOOK (design intent)
//   recordOutcome() writes outcomes in a CLEAN, INGESTABLE shape (see
//   toLatticeRecord) so the KAI RSHL lattice can later ingest the
//   success/fail signal. The same "words Kai Coder scans" are meant to pass
//   through KAI's contradiction + alignment detector — we leave a clean hook
//   (detectorHook) and stub it here.
//
// CONCURRENCY
//   Single-writer assumption (Kai Coder is one agent). We still write
//   atomically (temp file + rename) so a crash mid-write can't corrupt the
//   store. Reads tolerate a missing/corrupt file by falling back to empty.
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createRequire } from 'module';

// ── Paths ──────────────────────────────────────────────────────────────────────
const STORE_DIR    = 'c:/KAI/tools/oracle-discord/state/kai-coder';
const TASKS_FILE   = path.join(STORE_DIR, 'tasks.json');
const PATTERNS_FILE = path.join(STORE_DIR, 'patterns.json');
const LATTICE_FEED = path.join(STORE_DIR, 'lattice-feed.jsonl'); // clean, ingestable outcomes

const MAX_PATTERNS = 2000;   // ring cap — evict lowest-scored/oldest beyond this
const MAX_TASKS    = 1000;   // keep recent tasks; trim oldest completed beyond this

// ── Backend selection (JSON default; sqlite opt-in) ─────────────────────────────
const USE_SQLITE = (process.env.KAI_CODER_DB || 'json').toLowerCase() === 'sqlite';

function ensureDir() {
  try { fs.mkdirSync(STORE_DIR, { recursive: true }); } catch (_) {}
}

// ── Atomic JSON helpers ─────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    return data;
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  ensureDir();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function appendJsonl(file, record) {
  ensureDir();
  try { fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8'); } catch (_) {}
}

// ── ID + hashing ────────────────────────────────────────────────────────────────
function newId(prefix = 'task') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

// ── Signature computation ───────────────────────────────────────────────────────
// A "signature" is a normalized fingerprint of a problem. Two problems with the
// same signature are "the same kind of bug." We normalize away volatile bits
// (line numbers, paths, hex addresses, quoted strings) so that
//   "ReferenceError: foo is not defined at bots/leo.mjs:412"
//   "ReferenceError: bar is not defined at shared/x.mjs:99"
// produce comparable signatures dominated by the error CLASS + shape.
export function computeSignature(input = {}) {
  // input may be { type, message, file } OR a raw string.
  let type = '';
  let message = '';
  let file = '';
  if (typeof input === 'string') {
    message = input;
  } else {
    type = input.type || '';
    message = input.message || '';
    file = input.file || '';
  }

  const ext = file ? (path.extname(file) || '').toLowerCase() : '';

  let norm = `${type} ${message}`.toLowerCase();
  // Strip volatile specifics so similar errors collapse together.
  norm = norm
    .replace(/0x[0-9a-f]+/g, '<addr>')        // hex addresses
    .replace(/['"`][^'"`]*['"`]/g, '<str>')   // quoted literals (varies per case)
    .replace(/\b\d+\b/g, '<n>')               // line numbers, counts
    .replace(/[a-z]:[\\/][^\s:]+/g, '<path>') // absolute windows paths
    .replace(/[\\/][\w.\-]+\.(mjs|js|cjs|rs|py|ts|json|toml)/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();

  // Keep the file extension as part of the signature (a Rust borrow error and a
  // JS ReferenceError should never collide), plus a short stable hash so the
  // signature is compact and usable as a key.
  const canonical = `${ext}|${norm}`;
  const hash = crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 12);
  return { sig: hash, canonical, ext, normalized: norm };
}

// ── Similarity ──────────────────────────────────────────────────────────────────
// Returns a 0..100 similarity percentage between two canonical signature
// strings. Uses token Jaccard (order-independent set overlap) which is cheap,
// dependency-free, and robust to small wording differences. Extensions must
// match (a .rs and a .js problem are never "similar") or similarity is 0.
export function similarity(canonA, canonB) {
  if (!canonA || !canonB) return 0;
  if (canonA === canonB) return 100;
  const [extA, restA = ''] = canonA.split('|');
  const [extB, restB = ''] = canonB.split('|');
  if (extA !== extB) return 0;

  const toks = (s) => new Set(s.split(/[^a-z0-9<>]+/i).filter(t => t.length > 1));
  const a = toks(restA);
  const b = toks(restB);
  if (a.size === 0 && b.size === 0) return 100;
  if (a.size === 0 || b.size === 0) return 0;

  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return Math.round((inter / union) * 100);
}

// ══════════════════════════════════════════════════════════════════════════════
// JSON BACKEND
// ══════════════════════════════════════════════════════════════════════════════
const jsonBackend = {
  // ── TASKS ────────────────────────────────────────────────────────────────────
  loadTasks() { return readJson(TASKS_FILE, { tasks: [] }); },
  saveTasks(db) {
    // Trim: keep at most MAX_TASKS, dropping oldest completed/failed first.
    if (db.tasks.length > MAX_TASKS) {
      db.tasks.sort((a, b) => {
        const done = (t) => (t.status === 'completed' || t.status === 'failed') ? 0 : 1;
        if (done(a) !== done(b)) return done(a) - done(b); // finished first to drop
        return (a.updatedAt || 0) - (b.updatedAt || 0);    // oldest first
      });
      db.tasks = db.tasks.slice(-MAX_TASKS);
    }
    writeJsonAtomic(TASKS_FILE, db);
  },

  // ── PATTERNS ───────────────────────────────────────────────────────────────────
  loadPatterns() { return readJson(PATTERNS_FILE, { patterns: [] }); },
  savePatterns(db) {
    // Ring eviction: when over cap, drop the lowest-scored, then oldest.
    if (db.patterns.length > MAX_PATTERNS) {
      db.patterns.sort((a, b) => {
        if ((a.score || 0) !== (b.score || 0)) return (a.score || 0) - (b.score || 0);
        return (a.updatedAt || 0) - (b.updatedAt || 0);
      });
      db.patterns = db.patterns.slice(-MAX_PATTERNS);
    }
    writeJsonAtomic(PATTERNS_FILE, db);
  },
};

// ══════════════════════════════════════════════════════════════════════════════
// SQLITE BACKEND (opt-in: KAI_CODER_DB=sqlite). Mirrors the JSON backend's
// load/save shape so the public API below is backend-agnostic. Lazy-loaded so
// the dependency is never touched unless explicitly enabled.
// ══════════════════════════════════════════════════════════════════════════════
let _sqlite = null;
const _require = createRequire(import.meta.url); // CommonJS require shim inside ESM
function sqliteDb() {
  if (_sqlite) return _sqlite;
  ensureDir();
  const Database = _require('better-sqlite3');
  const db = new Database(path.join(STORE_DIR, 'kai-coder.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT, updatedAt INTEGER);
    CREATE TABLE IF NOT EXISTS patterns (id TEXT PRIMARY KEY, data TEXT, score REAL, updatedAt INTEGER);
  `);
  _sqlite = db;
  return db;
}

// SQLite mirrors the JSON load/save interface. We keep it intentionally simple:
// the whole collection is read into memory and written back, same as JSON.
// (Volumes here are small — thousands of rows at most.) If someone later wants
// row-level ops, the table is already keyed by id.
const sqliteBackend = {
  loadTasks() {
    try {
      const db = sqliteDb();
      const rows = db.prepare('SELECT data FROM tasks').all();
      return { tasks: rows.map(r => JSON.parse(r.data)) };
    } catch (_) { return { tasks: [] }; }
  },
  saveTasks(dbObj) {
    try {
      const db = sqliteDb();
      const up = db.prepare('INSERT OR REPLACE INTO tasks (id, data, updatedAt) VALUES (?,?,?)');
      const tx = db.transaction((tasks) => {
        for (const t of tasks) up.run(t.id, JSON.stringify(t), t.updatedAt || Date.now());
      });
      tx(dbObj.tasks);
    } catch (_) { /* fall back silently — JSON file still authoritative if mixed */ }
  },
  loadPatterns() {
    try {
      const db = sqliteDb();
      const rows = db.prepare('SELECT data FROM patterns').all();
      return { patterns: rows.map(r => JSON.parse(r.data)) };
    } catch (_) { return { patterns: [] }; }
  },
  savePatterns(dbObj) {
    try {
      const db = sqliteDb();
      const up = db.prepare('INSERT OR REPLACE INTO patterns (id, data, score, updatedAt) VALUES (?,?,?,?)');
      const tx = db.transaction((patterns) => {
        for (const p of patterns) up.run(p.id, JSON.stringify(p), p.score || 0, p.updatedAt || Date.now());
      });
      tx(dbObj.patterns);
    } catch (_) {}
  },
};

const backend = USE_SQLITE ? sqliteBackend : jsonBackend;

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════════

// ── TASKS / CHECKLISTS ──────────────────────────────────────────────────────────

/**
 * addTask — create a task with an ordered checklist.
 * @param {Object} t
 * @param {string} t.goal      — human-readable objective.
 * @param {Array}  [t.steps]   — array of step strings OR {text,status} objects.
 * @param {Object} [t.context] — arbitrary context (file, type, message, etc.).
 * @returns {Object} the stored task (with id, status, timestamps).
 */
export function addTask({ goal, steps = [], context = {} } = {}) {
  const db = backend.loadTasks();
  const now = Date.now();
  const task = {
    id: newId('task'),
    goal: goal || '(no goal)',
    steps: steps.map((s, i) =>
      typeof s === 'string'
        ? { n: i + 1, text: s, status: 'pending' }
        : { n: i + 1, text: s.text || String(s), status: s.status || 'pending' }
    ),
    status: 'open',          // open | in_progress | completed | failed
    context,
    createdAt: now,
    updatedAt: now,
  };
  db.tasks.push(task);
  backend.saveTasks(db);
  return task;
}

/**
 * updateTask — patch a task by id. Accepts partial fields. To update an
 * individual checklist step, pass { stepUpdate: { n, status } }.
 * @returns {Object|null} the updated task, or null if not found.
 */
export function updateTask(id, patch = {}) {
  const db = backend.loadTasks();
  const task = db.tasks.find(t => t.id === id);
  if (!task) return null;

  const { stepUpdate, steps, ...rest } = patch;
  Object.assign(task, rest);

  if (Array.isArray(steps)) {
    task.steps = steps.map((s, i) =>
      typeof s === 'string'
        ? { n: i + 1, text: s, status: 'pending' }
        : { n: i + 1, text: s.text || String(s), status: s.status || 'pending' }
    );
  }
  if (stepUpdate && typeof stepUpdate.n === 'number') {
    const step = task.steps.find(s => s.n === stepUpdate.n);
    if (step) Object.assign(step, stepUpdate);
  }

  task.updatedAt = Date.now();
  backend.saveTasks(db);
  return task;
}

/** getTask — fetch one task by id. */
export function getTask(id) {
  const db = backend.loadTasks();
  return db.tasks.find(t => t.id === id) || null;
}

/** listTasks — all tasks, optionally filtered by status. Newest first. */
export function listTasks(status = null) {
  const db = backend.loadTasks();
  let tasks = db.tasks.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (status) tasks = tasks.filter(t => t.status === status);
  return tasks;
}

// ── LEARNED PATTERNS ────────────────────────────────────────────────────────────

/**
 * recordOutcome — record/reinforce a learned pattern.
 *
 * A pattern is keyed by its signature. If a pattern with the same signature AND
 * the same approach_taken already exists, we REINFORCE it (adjust score, bump
 * counts) rather than duplicating. Otherwise we insert a new pattern row.
 *
 * @param {Object} pattern
 * @param {string|Object} pattern.signature  — sig string, or the object from
 *                                              computeSignature(), or a raw
 *                                              {type,message,file} to derive one.
 * @param {string} [pattern.context]          — where/why (file, subsystem...).
 * @param {string} pattern.approach_taken     — what was tried (the fix recipe).
 * @param {'success'|'fail'} pattern.outcome  — did it work?
 * @param {number} [pattern.score]            — explicit score; otherwise derived.
 * @param {string} [pattern.evidence]         — proof (syntax-check output, diff,
 *                                              test result, ...).
 * @param {number} [pattern.delta]            — score nudge for an existing
 *                                              pattern (rl.mjs passes +/-).
 * @returns {Object} the stored/updated pattern.
 */
export function recordOutcome(pattern = {}) {
  const db = backend.loadPatterns();
  const now = Date.now();

  // Normalize signature → { sig, canonical }
  let sigObj;
  if (typeof pattern.signature === 'string') {
    // Caller passed a raw sig hash; try to find existing canonical for it.
    const existingCanon = db.patterns.find(p => p.sig === pattern.signature);
    sigObj = { sig: pattern.signature, canonical: existingCanon?.canonical || pattern.signature };
  } else if (pattern.signature && pattern.signature.sig) {
    sigObj = pattern.signature;
  } else {
    sigObj = computeSignature(pattern.signature || pattern);
  }

  const outcome = pattern.outcome === 'success' ? 'success' : (pattern.outcome === 'fail' ? 'fail' : 'unknown');
  const approach = (pattern.approach_taken || '').trim();

  // Find an existing pattern with same signature + same approach to reinforce.
  let row = db.patterns.find(p => p.sig === sigObj.sig && (p.approach_taken || '') === approach);

  if (row) {
    // Reinforce existing.
    if (outcome === 'success') row.successes = (row.successes || 0) + 1;
    else if (outcome === 'fail') row.failures = (row.failures || 0) + 1;

    if (typeof pattern.delta === 'number') {
      row.score = clampScore((row.score || 0) + pattern.delta);
    } else {
      // Derive score from running success ratio if no explicit delta.
      row.score = deriveScore(row.successes || 0, row.failures || 0);
    }
    row.outcome = outcome !== 'unknown' ? outcome : row.outcome;
    if (pattern.evidence) row.evidence = String(pattern.evidence).slice(0, 1000);
    if (pattern.context) row.context = String(pattern.context).slice(0, 500);
    row.updatedAt = now;
  } else {
    // Insert new pattern.
    const successes = outcome === 'success' ? 1 : 0;
    const failures = outcome === 'fail' ? 1 : 0;
    row = {
      id: newId('ptn'),
      sig: sigObj.sig,
      canonical: sigObj.canonical,
      context: pattern.context ? String(pattern.context).slice(0, 500) : '',
      approach_taken: approach,
      outcome,
      successes,
      failures,
      score: typeof pattern.score === 'number'
        ? clampScore(pattern.score)
        : (typeof pattern.delta === 'number' ? clampScore(pattern.delta) : deriveScore(successes, failures)),
      evidence: pattern.evidence ? String(pattern.evidence).slice(0, 1000) : '',
      createdAt: now,
      updatedAt: now,
    };
    db.patterns.push(row);
  }

  backend.savePatterns(db);

  // Lattice feed: write a clean, ingestable outcome record for the KAI lattice.
  appendJsonl(LATTICE_FEED, toLatticeRecord(row, sigObj));

  return row;
}

/**
 * findSimilarPatterns — return past patterns whose signature similarity to the
 * given signature is >= threshold (percent). Results carry their success/fail
 * stats and the approach that was taken, sorted best-first (highest score, then
 * highest similarity). The reinforcement loop uses this to propose the approach
 * most likely to work.
 *
 * @param {string|Object} signature — sig string, computeSignature() object, or
 *                                     raw {type,message,file}.
 * @param {number} [threshold=60]   — minimum similarity percent (0..100).
 * @param {Object} [opts]
 * @param {boolean} [opts.successOnly=false] — only return approaches that have
 *                                             at least one recorded success.
 * @param {number}  [opts.limit=10]
 * @returns {Array} [{ ...pattern, similarity }]
 */
export function findSimilarPatterns(signature, threshold = 60, opts = {}) {
  const { successOnly = false, limit = 10 } = opts;
  const db = backend.loadPatterns();

  // Normalize the query signature to a canonical string.
  let canonical;
  if (typeof signature === 'string') {
    const existing = db.patterns.find(p => p.sig === signature);
    canonical = existing?.canonical || signature;
  } else if (signature && signature.canonical) {
    canonical = signature.canonical;
  } else {
    canonical = computeSignature(signature).canonical;
  }

  const scored = db.patterns
    .map(p => ({ ...p, similarity: similarity(canonical, p.canonical) }))
    .filter(p => p.similarity >= threshold)
    .filter(p => !successOnly || (p.successes || 0) > 0);

  scored.sort((a, b) => {
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    if (b.similarity !== a.similarity) return b.similarity - a.similarity;
    return (b.successes || 0) - (a.successes || 0);
  });

  return scored.slice(0, limit);
}

// ── Scoring helpers ─────────────────────────────────────────────────────────────
// Score is bounded 0..100. It expresses confidence that the approach works.
function clampScore(s) { return Math.max(0, Math.min(100, Math.round(s))); }

// Wilson-ish lower-bound-flavored ratio: rewards consistent successes, punishes
// failures, and stays conservative when evidence is thin. Kept simple + stdlib.
function deriveScore(successes, failures) {
  const n = successes + failures;
  if (n === 0) return 50;                       // unknown → neutral
  const ratio = successes / n;
  // Confidence grows with sample size: blend toward the raw ratio as n rises.
  const confidence = Math.min(1, n / 5);        // saturates at 5 observations
  const blended = 50 * (1 - confidence) + (ratio * 100) * confidence;
  return clampScore(blended);
}

// ── Lattice ingestion shape + contradiction/alignment hook ──────────────────────
// The KAI RSHL lattice (port 3334) ingests text+metadata anchors. We emit a
// flat, stable record per outcome so a later ingester can stream lattice-feed
// .jsonl straight into /api/rshl/anchor with no reshaping.
function toLatticeRecord(row, sigObj) {
  return {
    ts: Date.now(),
    source: 'kai-coder',
    kind: 'code_outcome',
    sig: row.sig,
    signature_canonical: sigObj.canonical || row.canonical,
    context: row.context || '',
    approach: row.approach_taken || '',
    outcome: row.outcome,                 // success | fail | unknown
    score: row.score,
    successes: row.successes || 0,
    failures: row.failures || 0,
    evidence: (row.evidence || '').slice(0, 240),
    // text is what the lattice anchors on — a clean natural-language summary.
    text: `Code outcome [${row.outcome}] for ${sigObj.canonical || row.sig}: approach "${row.approach_taken}" scored ${row.score}.`,
  };
}

/**
 * detectorHook — STUB for KAI's contradiction + alignment detector.
 *
 * Design intent: the words/code Kai Coder scans are read through the SAME
 * contradiction + alignment detection the rest of KAI uses. This hook is the
 * clean seam. A real implementation would POST `text` to the lattice
 * inspector (e.g. ORACLE_HOST + '/api/inspect') and return
 *   { contradiction: 0..1, alignment: 0..1, notes }.
 * For now it returns a neutral, dependency-free stub so callers can wire to it
 * today without a running Oracle server.
 *
 * @param {string} text
 * @returns {Promise<{contradiction:number, alignment:number, notes:string}>}
 */
export async function detectorHook(text = '') {
  // STUB — replace with a real call to KAI's detector when wiring the lattice.
  return { contradiction: 0, alignment: 1, notes: 'detector stub (neutral)', text: String(text).slice(0, 200) };
}

// ── Convenience: stats for dashboards / reports ─────────────────────────────────
export function memoryStats() {
  const tasks = backend.loadTasks().tasks;
  const patterns = backend.loadPatterns().patterns;
  return {
    backend: USE_SQLITE ? 'sqlite' : 'json',
    storeDir: STORE_DIR,
    tasks: {
      total: tasks.length,
      open: tasks.filter(t => t.status === 'open').length,
      in_progress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
    },
    patterns: {
      total: patterns.length,
      with_success: patterns.filter(p => (p.successes || 0) > 0).length,
      avg_score: patterns.length
        ? Math.round(patterns.reduce((s, p) => s + (p.score || 0), 0) / patterns.length)
        : 0,
    },
  };
}

export const _paths = { STORE_DIR, TASKS_FILE, PATTERNS_FILE, LATTICE_FEED };
