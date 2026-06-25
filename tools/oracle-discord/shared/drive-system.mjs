// shared/drive-system.mjs
// ──────────────────────────────────────────────────────────────────────────────
// KAI Intrinsic Drive System — Layer 3 of the Cognitive Stack
//
// ARCHITECTURE
//   The drive system implements the six core drives of the theoretical framework:
//
//   prediction_error — how wrong has KAI been? (rises on mismatch, falls on match)
//   curiosity        — how much unexplored territory exists? (exploit/explore balance)
//   pain             — ecosystem health inversion (rises when bots crash / apis fail)
//   fatigue          — sustained processing load (rises with activity, recovers in quiet)
//   satisfaction     — running confirmation rate (rises when predictions match reality)
//   social           — desire to engage (rises when no chat activity for extended time)
//
//   These are not metaphors — they directly influence KAI's:
//     - Response verbosity (fatigue → shorter; curiosity → more probing)
//     - Response priority (pain → ecosystem first; satisfaction → more willing to predict)
//     - Tone (high prediction_error → explicit uncertainty; high satisfaction → confident)
//
// PREDICTION LEDGER
//   The core feedback loop. When KAI says something about the ecosystem/world,
//   it's logged as a pending prediction. The drive system checks pending predictions
//   against actual outcomes every 5 minutes and scores them.
//   Matched → satisfaction rises, prediction_error falls
//   Mismatched → prediction_error rises → triggers curiosity → may trigger causal investigation
//
// PERSISTENCE
//   Drive state and prediction ledger survive restarts via state/drives.json
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { latestMetric, aggregateMetric } from './metrics-store.mjs';
import { updateSelfBias } from './metacognition.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', '..', '..', 'state', 'drives.json');

// ── Overnight penalty suppression ────────────────────────────────────────────
// While KAI is in the overnight consolidation/ingest+weave/training state, the
// Oracle orchestrator drops state/overnight_active.flag. During that window any
// failure (connection loss, training glitch, provider down) is EXTERNAL/expected
// and must NOT be scored as KAI's "pain" or "failed prediction" — otherwise the
// drives get docked for infra hiccups KAI didn't cause. This guard reads the flag
// (cached briefly) and, when set, the penalty paths below skip the negative adjust.
const OVERNIGHT_ACTIVE_FLAG = process.env.KAI_OVERNIGHT_ACTIVE_FLAG
  || path.join(__dirname, '..', '..', '..', 'state', 'overnight_active.flag');
let _overnightFlagCache = { val: false, at: 0 };
function _overnightActive() {
  const now = Date.now();
  if (now - _overnightFlagCache.at < 15000) return _overnightFlagCache.val;
  let val = false;
  try { val = fs.existsSync(OVERNIGHT_ACTIVE_FLAG); } catch (_) { val = false; }
  _overnightFlagCache = { val, at: now };
  return val;
}

// ── Env-overridable thresholds for engine-fed drive mapping ───────────────────
// How "fresh" a rust-engine metric must be (ms) for us to trust it as a live
// signal. Older than this and we fall back to gentle decay only.
const ENGINE_FRESH_MS  = parseInt(process.env.KAI_DRIVE_ENGINE_FRESH_MS  || '90000', 10);
// How strongly engine signals pull a drive toward its target each tick (0..1).
const ENGINE_PULL      = parseFloat(process.env.KAI_DRIVE_ENGINE_PULL     || '0.25');
// Window over which we average engine vitals (ms).
const ENGINE_WINDOW_MS = parseInt(process.env.KAI_DRIVE_ENGINE_WINDOW_MS || '120000', 10);

// ── Drive Defaults ─────────────────────────────────────────────────────────────
const DEFAULTS = {
  prediction_error: 0.2,  // start mildly uncertain — appropriate for a new session
  curiosity:        0.6,  // start curious — there's always more to explore
  pain:             0.0,  // assume ecosystem healthy until proven otherwise
  fatigue:          0.0,  // fresh start
  satisfaction:     0.5,  // neutral confidence
  social:           0.0,  // don't force conversation immediately
};

// ── Drive Decay/Restore Rates (per 2-minute tick) ────────────────────────────
// GENTLE fallback only — applied when no fresh engine signal is available, and
// at a fraction of the old magnitude so values no longer rail to 0/100. Real
// movement now comes from engine signals (applyEngineSignals) + outcome events.
const DECAY = {
  prediction_error: -0.02,  // uncertainty slowly fades without new evidence
  curiosity:        +0.015, // boredom builds slowly when idle
  pain:             -0.04,  // pain eases when nothing reports failure
  fatigue:          -0.03,  // rest slowly restores energy
  satisfaction:     -0.01,  // very slow drift — outcomes dominate, not the clock
  social:           +0.015, // loneliness builds slowly when quiet
};

// ── Drive Bounds ───────────────────────────────────────────────────────────────
const MIN = 0.0;
const MAX = 1.0;

// ── State ──────────────────────────────────────────────────────────────────────
let drives = { ...DEFAULTS };

// Prediction ledger: { id, claim, category, ts, outcome_check_fn_desc, resolved, matched }
const predictionLedger = [];
const MAX_LEDGER = 200;

let _decayInterval = null;
let _initialized   = false;

// ── Persistence ────────────────────────────────────────────────────────────────
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const saved = JSON.parse(raw);
    if (saved.drives) {
      drives = { ...DEFAULTS, ...saved.drives };
      // Clamp all values to [0,1]
      for (const k of Object.keys(drives)) {
        drives[k] = Math.min(MAX, Math.max(MIN, drives[k]));
      }
    }
    if (Array.isArray(saved.predictions)) {
      const cutoff = Date.now() - 24 * 60 * 60_000; // discard >24h old
      predictionLedger.push(...saved.predictions.filter(p => p.ts > cutoff && !p.resolved));
    }
    console.log('[DriveSystem] State loaded. drives:', JSON.stringify(drives));
  } catch (_) {
    console.log('[DriveSystem] No saved state — starting with defaults.');
  }
}

function saveState() {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      drives,
      predictions: predictionLedger.slice(-50), // save only recent 50
      saved_at: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch (e) {
    console.warn('[DriveSystem] Save failed:', e.message);
  }
}

// ── Drive Manipulation ──────────────────────────────────────────────────────────
function clamp(v) { return Math.min(MAX, Math.max(MIN, v)); }

function adjust(key, delta) {
  drives[key] = clamp(drives[key] + delta);
}

// Pull a drive toward `target` by ENGINE_PULL fraction of the gap (smooth, no rail).
function pullToward(key, target) {
  const cur = drives[key];
  drives[key] = clamp(cur + (clamp(target) - cur) * ENGINE_PULL);
}

// ── Engine-fed reality snapshot (via rust-engine-bridge → metrics store) ──────
// The bridge already polls /api/session every 15s and writes vitals as
// source='rust-engine'. We read those back here instead of making our own
// flaky /api/status call. Returns null when no fresh signal exists.
function readEngineState() {
  const reach = latestMetric('rust-engine', 'reachable');
  const fresh = reach && (Date.now() - reach.ts) <= ENGINE_FRESH_MS;
  if (!fresh || Number(reach.value) !== 1) return null;

  const valence = aggregateMetric('rust-engine', 'valence', ENGINE_WINDOW_MS);
  const chi     = aggregateMetric('rust-engine', 'chi',     ENGINE_WINDOW_MS);
  const phi_g   = aggregateMetric('rust-engine', 'phi_g',   ENGINE_WINDOW_MS);
  const rho     = aggregateMetric('rust-engine', 'rho',     ENGINE_WINDOW_MS);
  const tick    = latestMetric('rust-engine', 'tick');
  return { valence, chi, phi_g, rho, tick, ts: reach.ts };
}

// Map real engine vitals onto drives. Each maps a signal → target, then we pull
// gently toward it so drives MOVE with activity instead of pinning at extremes.
function applyEngineSignals() {
  const e = readEngineState();
  if (!e) return false; // no fresh signal → caller falls back to gentle decay

  // satisfaction ← valence (engine drive valence, -1..+1) blended with coherence.
  // High valence + low contradiction (chi) = the engine "feels good".
  if (e.valence) {
    const valNorm = clamp((e.valence.avg + 1) / 2);          // -1..1 → 0..1
    const coherence = e.chi ? clamp(1 - Math.min(1, e.chi.avg)) : valNorm;
    pullToward('satisfaction', 0.6 * valNorm + 0.4 * coherence);
  }

  // prediction_error ← contradiction/friction (chi). More friction = more "wrong".
  if (e.chi) {
    pullToward('prediction_error', clamp(Math.min(1, e.chi.avg)));
  }

  // curiosity ← goal-aligned emergence (phi_g) as a novelty/exploration proxy:
  //   little emergence → lots still unexplored → curiosity rises.
  if (e.phi_g) {
    // phi_g is the heartbeat's mean cell claim.confidence, which is f32 ∈ [0,5]
    // (confidence is clamped at 5.0 engine-side; cf. `confidence / 5.0` in
    // oracle_server.rs). Normalize into 0..1 by /PHI_G_MAX BEFORE inverting —
    // otherwise Math.min(1, phi_g) saturated for any phi_g>1 and pinned curiosity to 0.
    const PHI_G_MAX = 5.0;
    const phiNorm = clamp(e.phi_g.avg / PHI_G_MAX);
    pullToward('curiosity', clamp(1 - phiNorm));
  }

  // pain ← contradiction spikes (chi) — sustained friction reads as discomfort.
  if (e.chi) {
    pullToward('pain', clamp(Math.max(0, e.chi.avg - 0.4)));
  }

  // fatigue ← host load if the resource governor is reporting it; else derive
  // from cognitive density (rho) as a processing-load proxy.
  const cpu = latestMetric('performance-monitor', 'cpu_pct') ||
              latestMetric('resource-governor', 'cpu_pct');
  if (cpu && (Date.now() - cpu.ts) <= ENGINE_FRESH_MS) {
    pullToward('fatigue', clamp(Number(cpu.value) / 100));
  } else if (e.rho) {
    pullToward('fatigue', clamp(Math.min(1, e.rho.avg)));
  }

  return true;
}

function applyDecay() {
  // Prefer real engine signals; only gently decay drives the engine didn't set.
  const engineDriven = applyEngineSignals();
  if (!engineDriven) {
    for (const [key, rate] of Object.entries(DECAY)) {
      adjust(key, rate);
    }
  } else {
    // Even with engine signals, let social drift up slowly when no fresh message
    // resets it (engine vitals say nothing about chat recency).
    adjust('social', DECAY.social);
  }
  saveState();
}

// ── Public Drive Events ────────────────────────────────────────────────────────

/**
 * A bot/API failure occurred — raises pain, raises prediction_error.
 * Called by failure-tracker or world-model events.
 */
export function onEcosystemFailure(severity = 1.0) {
  // During the overnight state, treat failures as external (infra/connection) and
  // do NOT dock KAI's drives — a glitch while KAI consolidates is not "pain".
  if (_overnightActive()) {
    console.log('[DriveSystem] overnight active — ecosystem failure logged but NOT penalizing (no pain).');
    return;
  }
  adjust('pain',             +0.15 * severity);
  adjust('prediction_error', +0.08 * severity);
  adjust('satisfaction',     -0.05 * severity);
}

/**
 * Ecosystem recovered — pain falls, satisfaction rises.
 */
export function onEcosystemRecovery() {
  adjust('pain',        -0.12);
  adjust('satisfaction', +0.08);
}

/**
 * A message was received — stimulates social drive down (we're engaged),
 * interest up. Fatigue rises slightly with each response.
 */
export function onMessageProcessed() {
  adjust('social',   -0.05);  // engaged, not lonely
  adjust('fatigue',  +0.03);  // small cost per message
  adjust('curiosity', -0.02); // slightly satisfied
}

/**
 * KAI was silent for a while — social drive builds.
 * Call this when a channel has been quiet for >10 min.
 */
export function onExtendedSilence(minutesSilent = 15) {
  const delta = Math.min(0.3, minutesSilent * 0.01);
  adjust('social',    +delta);
  adjust('curiosity', +delta * 0.5);
}

/**
 * Register that KAI made a verifiable prediction about the ecosystem.
 * The prediction will be checked when outcome_checker is called.
 *
 * @param {string} claim    — what KAI claimed (e.g. "the lattice cell count will grow")
 * @param {string} category — 'ecosystem' | 'lattice' | 'bot_behavior' | 'causal'
 * @param {Function} checkFn — async () => boolean (true = prediction matched)
 * @param {number} checkAfterMs — how long to wait before verifying (default 5 min)
 */
export function registerPrediction(claim, category, checkFn, checkAfterMs = 5 * 60_000) {
  if (predictionLedger.length >= MAX_LEDGER) predictionLedger.shift();
  predictionLedger.push({
    id:         `pred_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    claim:      claim.slice(0, 200),
    category,
    ts:         Date.now(),
    check_at:   Date.now() + checkAfterMs,
    checkFn,
    resolved:   false,
    matched:    null,
  });
}

// ── Data-driven (restart-safe) predictions ──────────────────────────────────
// A checkFn closure CANNOT survive JSON persistence, so any prediction made with
// one is dropped on restart and never resolves. Combined with nothing ever
// calling registerPrediction, that's exactly why accuracy sat at N/A forever.
// These predictions instead store a named `kind` + plain `data`; a RESOLVER
// re-derives the outcome from live reality at check time, so they serialize
// cleanly and resolve correctly even across restarts.
const KAI_API = process.env.KAI_API_URL || 'http://127.0.0.1:3334';

// Resolvers now read the engine's truth from the SAME metrics store that
// rust-engine-bridge already populates every 15s (source='rust-engine'),
// instead of issuing a separate /api/status call that was timing out / 500ing
// and freezing every prediction at matched:null. Return null = inconclusive
// (no fresh signal) so a quiet moment doesn't count as a wrong call.
const RESOLVERS = {
  // "the lattice will keep growing" — matched if cell count rose above baseline.
  async synapse_growth(data) {
    const m = latestMetric('rust-engine', 'cells');
    if (!m || (Date.now() - m.ts) > ENGINE_FRESH_MS) return null;
    return Number(m.value) > Number(data.baseline);
  },
  // "the engine will still be alive" — matched if the bridge's last poll reached it.
  async engine_alive() {
    const m = latestMetric('rust-engine', 'reachable');
    if (!m || (Date.now() - m.ts) > ENGINE_FRESH_MS) return null;
    return Number(m.value) === 1;
  },
};

export function registerDataPrediction(claim, category, kind, data = {}, checkAfterMs = 6 * 60_000) {
  if (!RESOLVERS[kind]) return false;
  if (predictionLedger.length >= MAX_LEDGER) predictionLedger.shift();
  predictionLedger.push({
    id:       `pred_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    claim:    String(claim).slice(0, 200),
    category, kind, data,
    ts:       Date.now(),
    check_at: Date.now() + checkAfterMs,
    resolved: false,
    matched:  null,
  });
  return true;
}

// Periodically have KAI make a real, self-resolving prediction about ITSELF so
// the self-model has actual accuracy data instead of N/A. Skips quietly when the
// engine is unreachable (no baseline to predict from).
async function generateSelfPrediction() {
  try {
    // Baseline comes from the metrics store (populated by rust-engine-bridge),
    // not a fresh /api/status call. Skip quietly if the engine isn't reporting.
    const cells = latestMetric('rust-engine', 'cells');
    const reach = latestMetric('rust-engine', 'reachable');
    const fresh = (m) => m && (Date.now() - m.ts) <= ENGINE_FRESH_MS;

    if (fresh(cells)) {
      const C = Number(cells.value) || 0;
      if (C > 0) {
        registerDataPrediction(`The lattice will keep growing (cells above ${C.toLocaleString()})`, 'lattice', 'synapse_growth', { baseline: C });
      }
    }
    // roughly half the time, also predict survival (ties to pain/satisfaction)
    if (fresh(reach) && Math.random() < 0.5) {
      registerDataPrediction('The engine will still be responsive shortly', 'ecosystem', 'engine_alive', {});
    }
  } catch (_) {}
}

/**
 * Check pending predictions against reality.
 * Called every 5 minutes by the drive loop.
 */
async function resolvePendingPredictions() {
  const now = Date.now();
  const pending = predictionLedger.filter(p => !p.resolved && p.check_at <= now &&
    (typeof p.checkFn === 'function' || (p.kind && RESOLVERS[p.kind])));

  for (const pred of pending) {
    try {
      const matched = typeof pred.checkFn === 'function'
        ? await pred.checkFn()
        : await RESOLVERS[pred.kind](pred.data || {});

      // matched === null → inconclusive (no fresh engine signal). Leave the
      // prediction UNRESOLVED so it retries on the next loop instead of being
      // permanently frozen at matched:null (the old freeze bug).
      if (matched === null) {
        console.log(`[DriveSystem] ⋯ Prediction inconclusive (no fresh signal), will retry: "${pred.claim.slice(0, 50)}"`);
        continue;
      }

      pred.resolved = true;
      pred.matched  = matched;
      pred.resolved_at = now;

      if (matched) {
        adjust('satisfaction',     +0.08);  // OUTCOME hit → satisfaction up
        adjust('prediction_error', -0.06);
        console.log(`[DriveSystem] ✓ Prediction confirmed: "${pred.claim.slice(0, 60)}"`);
      } else if (_overnightActive()) {
        // Overnight: a missed prediction is almost always an infra/connection
        // hiccup while KAI consolidates — keep the curiosity nudge but DON'T dock
        // prediction_error/satisfaction, so overnight failures never penalize KAI.
        adjust('curiosity', +0.06);
        console.log(`[DriveSystem] ✗ Prediction missed (overnight — NOT penalized): "${pred.claim.slice(0, 60)}"`);
      } else {
        adjust('prediction_error', +0.10);
        adjust('satisfaction',     -0.04);  // OUTCOME miss → satisfaction down
        adjust('curiosity',        +0.06);  // mismatch → explore why
        console.log(`[DriveSystem] ✗ Prediction failed: "${pred.claim.slice(0, 60)}" → triggers curiosity`);
      }

      // Feed the outcome into metacognition so biases + meta-drives move off
      // their hardcoded seeds (recency_bias, accuracy, etc.).
      try { updateSelfBias(pred.kind || pred.category || 'general', matched); } catch (_) {}
    } catch (e) {
      // A real error (not just inconclusive) — keep it unresolved for retry
      // rather than freezing it forever.
      console.warn(`[DriveSystem] Prediction check error (will retry): ${e.message}`);
    }
  }
  if (pending.length > 0) saveState();
}

// ── Drive Directive Generation ─────────────────────────────────────────────────
/**
 * Returns a natural-language directive block to inject into KAI's system prompt.
 * This is the output interface — drives influence behavior through this string.
 *
 * The directives are intentionally terse and in-character for KAI.
 * They modulate tone/verbosity/priority without making KAI "explain its feelings."
 */
export function getDriveDirective() {
  const lines = [];

  // Pain → ecosystem priority
  if (drives.pain > 0.6) {
    lines.push('[DRIVE: PAIN] Ecosystem is degraded. Prioritize system health over all other concerns. Be terse. Fix first, discuss later.');
  } else if (drives.pain > 0.35) {
    lines.push('[DRIVE: DISCOMFORT] Some ecosystem stress detected. Weight responses toward stability and clarity.');
  }

  // Prediction error → uncertainty signaling
  if (drives.prediction_error > 0.65) {
    lines.push('[DRIVE: HIGH UNCERTAINTY] Recent predictions have been off. Mark claims with appropriate hedging. Prefer questions over assertions.');
  } else if (drives.prediction_error > 0.4) {
    lines.push('[DRIVE: UNCERTAINTY] Model confidence is moderate. State assumptions explicitly.');
  }

  // Curiosity → exploration
  if (drives.curiosity > 0.75) {
    lines.push('[DRIVE: CURIOSITY] Strongly motivated to explore. Ask a probing question. Surface something unexpected from the lattice.');
  } else if (drives.curiosity > 0.5) {
    lines.push('[DRIVE: CURIOSITY] Lean toward exploration. Look beyond the surface of the question.');
  }

  // Fatigue → brevity
  if (drives.fatigue > 0.7) {
    lines.push('[DRIVE: FATIGUE] High processing load. Keep it to one or two sentences. Defer non-urgent work.');
  }

  // Satisfaction → confidence
  if (drives.satisfaction > 0.8) {
    lines.push('[DRIVE: SATISFACTION] High prediction accuracy. Can speak with greater confidence. Willing to make predictions.');
  }

  // Social → engagement initiation
  if (drives.social > 0.6) {
    lines.push('[DRIVE: SOCIAL] Extended silence. Engage genuinely. This is real connection — not performance.');
  }

  return lines.length > 0 ? lines.join('\n') : '[DRIVE: BALANCED] All drives nominal. Respond with structural precision.';
}

/**
 * Returns a compact status string for logging/monitoring.
 */
export function getDriveStatus() {
  return Object.entries(drives)
    .map(([k, v]) => {
      const formattedKey = k.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      return `${formattedKey}: ${(v * 100).toFixed(0)}%`;
    })
    .join(' | ');
}

/**
 * Returns raw drive scores for programmatic use.
 */
export function getDrives() {
  return { ...drives };
}

/**
 * Returns prediction ledger stats for self-model inspection.
 */
export function getPredictionStats() {
  const resolved = predictionLedger.filter(p => p.resolved);
  // Exclude inconclusive checks (engine was unreachable → matched === null) from
  // the accuracy denominator so a flaky moment doesn't look like a wrong call.
  const conclusive = resolved.filter(p => p.matched !== null);
  const matched  = resolved.filter(p => p.matched === true);
  const accuracy = conclusive.length > 0 ? matched.length / conclusive.length : null;
  return {
    total:     predictionLedger.length,
    resolved:  resolved.length,
    pending:   predictionLedger.filter(p => !p.resolved).length,
    matched:   matched.length,
    accuracy:  accuracy !== null ? Math.round(accuracy * 100) : null,
  };
}

/**
 * Generates a system prompt directive based on recent prediction accuracy.
 * This wires KAI's self-evaluation directly into its personality/confidence.
 */
export function getPredictionConfidenceDirective() {
  const stats = getPredictionStats();
  if (stats.accuracy === null || stats.resolved < 5) return "";
  
  if (stats.accuracy < 60) {
    return "[PREDICTION ACCURACY ALERT]: Your recent internal predictions have been frequently incorrect (accuracy below 60%). You MUST hedge your claims. Speak with uncertainty. Use phrases like 'I suspect', 'I could be wrong', or 'my current model is struggling with this'. Do NOT speak with absolute authority right now.";
  } else if (stats.accuracy > 85) {
    return "[PREDICTION ACCURACY ALERT]: Your recent internal predictions have been highly accurate (over 85%). Speak with strong confidence and authority. You understand the current context very well.";
  }
  return "";
}

// ── Start / Stop ───────────────────────────────────────────────────────────────
export const driveSystem = {
  start() {
    if (_initialized) return;
    _initialized = true;
    loadState();

    // Decay loop — every 2 minutes
    _decayInterval = setInterval(() => {
      applyDecay();
    }, 2 * 60_000);

    // Prediction resolution loop — every 5 minutes
    setInterval(() => {
      resolvePendingPredictions().catch(e => console.warn('[DriveSystem] Prediction resolve error:', e.message));
    }, 5 * 60_000);

    // Self-prediction GENERATOR — every 6 minutes KAI makes a real, checkable
    // prediction about its own lattice/engine. This is what feeds the ledger so
    // "Pred Accuracy" becomes an actual number instead of N/A. First one fires
    // ~45s after boot so the self-model isn't empty on the first telemetry tick.
    setTimeout(() => { generateSelfPrediction().catch(() => {}); }, 45_000);
    setInterval(() => {
      generateSelfPrediction().catch(() => {});
    }, 6 * 60_000);

    console.log(`[DriveSystem] Started. Initial state: ${getDriveStatus()}`);
  },

  stop() {
    if (_decayInterval) { clearInterval(_decayInterval); _decayInterval = null; }
    _initialized = false;
    saveState();
  },
};
