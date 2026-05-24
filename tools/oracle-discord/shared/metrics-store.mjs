// shared/metrics-store.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Unified metrics store — Stage 1 of the self-aware system architecture.
//
// PURPOSE
//   Single append-only place where every silo writes its observations
//   (hardware vitals, bot health, lock state, provider latency, file integrity,
//   anything). Later stages (central Sentinel, drift detection, blast-radius
//   scoring) all read from this store. Without it, every other improvement
//   stays narrow.
//
// FORMAT
//   JSON Lines (.jsonl). One observation per line:
//     {"ts":1747500000000,"source":"performance-monitor","metric":"cpu_pct","value":23,"tags":{"bot":"all"}}
//   - ts:     epoch milliseconds (Date.now())
//   - source: who emitted it ("performance-monitor", "Sentinel", "tts-engine", etc.)
//   - metric: what it measures ("cpu_pct", "lock_held_ms", "tts_latency_ms", ...)
//   - value:  number, string, or small object — caller's discretion
//   - tags:   optional { ... } for filtering ("bot":"Groq", "channel":"social", ...)
//
// ROTATION
//   When the active file exceeds MAX_BYTES, it's rolled to .1, .2, ... up to
//   MAX_ROLLS. Old rolls get dropped. Reads transparently span the active file
//   plus whichever rolls are still on disk.
//
// CONCURRENCY
//   Multiple processes write — each open/append/close per record. The OS
//   guarantees line-atomicity for writes under PIPE_BUF (4KB on Windows),
//   which is plenty for one JSONL record.
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';

const STORE_DIR  = 'c:/KAI/tools/oracle-discord/state/metrics';
const ACTIVE     = path.join(STORE_DIR, 'metrics.jsonl');
const MAX_BYTES  = 5 * 1024 * 1024;   // 5 MB per file before rotating
const MAX_ROLLS  = 5;                  // keep metrics.1 ... metrics.5

function ensureDir() {
  try { fs.mkdirSync(STORE_DIR, { recursive: true }); } catch (_) {}
}

function maybeRotate() {
  try {
    const stat = fs.statSync(ACTIVE);
    if (stat.size < MAX_BYTES) return;
  } catch (_) { return; }  // file doesn't exist yet — nothing to rotate

  // Roll: metrics.4 -> metrics.5, metrics.3 -> metrics.4, ..., active -> metrics.1
  for (let i = MAX_ROLLS - 1; i >= 1; i--) {
    const src = path.join(STORE_DIR, `metrics.${i}.jsonl`);
    const dst = path.join(STORE_DIR, `metrics.${i + 1}.jsonl`);
    if (fs.existsSync(src)) {
      try { fs.renameSync(src, dst); } catch (_) {}
    }
  }
  try { fs.renameSync(ACTIVE, path.join(STORE_DIR, 'metrics.1.jsonl')); } catch (_) {}

  // Drop anything past MAX_ROLLS
  const overflow = path.join(STORE_DIR, `metrics.${MAX_ROLLS + 1}.jsonl`);
  if (fs.existsSync(overflow)) { try { fs.unlinkSync(overflow); } catch (_) {} }
}

/**
 * Record a single observation. Synchronous + atomic (one line per write).
 * Fails silently — instrumentation MUST NOT break the caller.
 */
export function recordMetric(source, metric, value, tags = null) {
  if (!source || !metric) return;
  ensureDir();
  maybeRotate();
  const rec = { ts: Date.now(), source, metric, value };
  if (tags && typeof tags === 'object') rec.tags = tags;
  try {
    fs.appendFileSync(ACTIVE, JSON.stringify(rec) + '\n');
  } catch (_) { /* don't take the caller down because logging hiccupped */ }
}

const fileCache = new Map();

function readJsonl(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const cached = fileCache.get(filePath);
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
      return cached.records;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const records = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        records.push(JSON.parse(line));
      } catch (_) {}
    }
    fileCache.set(filePath, { mtime: stat.mtimeMs, size: stat.size, records });
    return records;
  } catch (_) {
    return [];
  }
}

/**
 * Query recent observations.
 *   opts = {
 *     source?:   string | string[]   — filter by source(s)
 *     metric?:   string | string[]   — filter by metric name(s)
 *     since?:    number              — only records with ts >= since (epoch ms)
 *     until?:    number              — only records with ts <  until
 *     limit?:    number              — cap result length (default 1000)
 *     tagMatch?: { key: value }      — every key/value must match in record.tags
 *   }
 * Returns array of records, oldest first.
 */
export function queryMetrics(opts = {}) {
  const {
    source = null,
    metric = null,
    since  = null,
    until  = null,
    limit  = 1000,
    tagMatch = null,
  } = opts;

  const srcSet = source ? new Set(Array.isArray(source) ? source : [source]) : null;
  const metSet = metric ? new Set(Array.isArray(metric) ? metric : [metric]) : null;

  // Gather files in chronological order: oldest roll first, active last.
  const files = [];
  for (let i = MAX_ROLLS; i >= 1; i--) {
    const p = path.join(STORE_DIR, `metrics.${i}.jsonl`);
    if (fs.existsSync(p)) files.push(p);
  }
  if (fs.existsSync(ACTIVE)) files.push(ACTIVE);

  const out = [];
  for (const f of files) {
    for (const r of readJsonl(f)) {
      if (srcSet && !srcSet.has(r.source)) continue;
      if (metSet && !metSet.has(r.metric)) continue;
      if (since !== null && r.ts < since) continue;
      if (until !== null && r.ts >= until) continue;
      if (tagMatch && typeof tagMatch === 'object') {
        const t = r.tags || {};
        let ok = true;
        for (const k of Object.keys(tagMatch)) {
          if (t[k] !== tagMatch[k]) { ok = false; break; }
        }
        if (!ok) continue;
      }
      out.push(r);
    }
  }
  if (out.length > limit) return out.slice(out.length - limit);  // newest `limit`
  return out;
}

/**
 * Convenience aggregation: latest value of a (source, metric) pair, or null.
 */
export function latestMetric(source, metric, tagMatch = null) {
  const recs = queryMetrics({ source, metric, tagMatch, limit: 1 });
  return recs.length ? recs[recs.length - 1] : null;
}

/**
 * Convenience aggregation: numeric stats over a window (avg/min/max/count).
 * Returns null if no records match or values aren't numeric.
 */
export function aggregateMetric(source, metric, windowMs = 60_000, tagMatch = null) {
  const recs = queryMetrics({
    source, metric, tagMatch,
    since: Date.now() - windowMs,
    limit: 100_000,
  });
  if (!recs.length) return null;
  const nums = recs.map(r => Number(r.value)).filter(n => Number.isFinite(n));
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return {
    n: nums.length,
    avg: sum / nums.length,
    min: Math.min(...nums),
    max: Math.max(...nums),
    first_ts: recs[0].ts,
    last_ts: recs[recs.length - 1].ts,
  };
}
