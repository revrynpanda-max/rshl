// shared/baselines.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Stage 4: statistical baselines + drift detection.
//
// PURPOSE
//   Right now the correlation engine uses absolute thresholds (e.g.
//   "GPU > 90% AND lock_held > 11s"). Those thresholds are guesses, and they
//   age badly — what's "high" depends on the machine and the workload. This
//   module builds rolling per-metric baselines (mean + stddev) from the
//   metrics store, and exposes a function the correlation engine can use:
//     isDrifting(source, metric, value)  ->  { drifting: bool, z: number }
//
//   z = number of stddevs above the baseline. By default z > 2.5 = drift.
//   So future rules can say "lock_held_ms > 2.5 stddev above its 24h baseline"
//   instead of magic numbers.
//
// BASELINE WINDOW
//   Default: last 24 hours of data (configurable). Computed on-demand. We
//   only consider numeric records; non-numeric values are ignored. A baseline
//   needs at least 30 samples to be considered reliable.
// ──────────────────────────────────────────────────────────────────────────────

import { queryMetrics } from './metrics-store.mjs';

const BASELINE_WINDOW_MS = 24 * 60 * 60_000;
const MIN_SAMPLES        = 30;
const CACHE_TTL_MS       = 5 * 60_000;

const cache = new Map();   // key="source::metric::tag-fingerprint" -> { ts, baseline }

function tagFingerprint(tagMatch) {
  if (!tagMatch) return '';
  return Object.entries(tagMatch).sort().map(([k, v]) => `${k}=${v}`).join('&');
}

/**
 * Compute (or return cached) baseline for a (source, metric, [tag]) triple.
 * Returns { n, mean, stddev, min, max, first_ts, last_ts } or null if
 * insufficient data.
 */
export function baselineFor(source, metric, tagMatch = null, windowMs = BASELINE_WINDOW_MS) {
  const key = `${source}::${metric}::${tagFingerprint(tagMatch)}::${windowMs}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && (now - cached.ts) < CACHE_TTL_MS) return cached.baseline;

  const recs = queryMetrics({
    source, metric, tagMatch,
    since: now - windowMs,
    limit: 100_000,
  });
  const nums = recs.map(r => Number(r.value)).filter(Number.isFinite);
  if (nums.length < MIN_SAMPLES) {
    cache.set(key, { ts: now, baseline: null });
    return null;
  }

  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((s, v) => s + (v - mean) ** 2, 0) / nums.length;
  const stddev = Math.sqrt(variance);
  const baseline = {
    n: nums.length,
    mean,
    stddev,
    min: Math.min(...nums),
    max: Math.max(...nums),
    first_ts: recs[0].ts,
    last_ts: recs[recs.length - 1].ts,
  };
  cache.set(key, { ts: now, baseline });
  return baseline;
}

/**
 * Z-score: how many stddevs above (positive) or below (negative) the baseline
 * the current value is. Returns null if no reliable baseline yet.
 */
export function zScore(source, metric, value, tagMatch = null) {
  const b = baselineFor(source, metric, tagMatch);
  if (!b || b.stddev === 0) return null;
  return (value - b.mean) / b.stddev;
}

/**
 * High-level drift check.
 *   isDrifting('tts-engine', 'lock_held_ms', 18000)
 *      -> { drifting: true, z: 3.4, baseline: { mean: 4200, stddev: 4100, ... } }
 *
 * Default threshold: z > 2.5 (and absolute deviation > 0 for very-tight baselines).
 */
export function isDrifting(source, metric, value, tagMatch = null, zThreshold = 2.5) {
  const b = baselineFor(source, metric, tagMatch);
  if (!b) return { drifting: false, z: null, baseline: null, reason: 'insufficient_samples' };
  const z = b.stddev > 0 ? (value - b.mean) / b.stddev : 0;
  return {
    drifting: z > zThreshold,
    z,
    baseline: b,
    reason: z > zThreshold ? `${z.toFixed(1)} stddev above mean ${b.mean.toFixed(1)}` : 'within baseline',
  };
}

/** Clear the in-memory cache (test / forced refresh). */
export function _resetBaselineCache() { cache.clear(); }
