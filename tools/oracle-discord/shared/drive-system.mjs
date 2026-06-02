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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', '..', '..', 'state', 'drives.json');

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
const DECAY = {
  prediction_error: -0.05,  // naturally fades as time passes (uncertainty decays without new evidence)
  curiosity:        +0.04,  // naturally builds when idle (boredom drives exploration)
  pain:             -0.08,  // pain fades quickly when ecosystem stabilizes
  fatigue:          -0.06,  // rest restores energy
  satisfaction:     -0.03,  // satisfaction fades — can't rest on laurels
  social:           +0.03,  // loneliness builds when quiet
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

function applyDecay() {
  for (const [key, rate] of Object.entries(DECAY)) {
    adjust(key, rate);
  }
  saveState();
}

// ── Public Drive Events ────────────────────────────────────────────────────────

/**
 * A bot/API failure occurred — raises pain, raises prediction_error.
 * Called by failure-tracker or world-model events.
 */
export function onEcosystemFailure(severity = 1.0) {
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

/**
 * Check pending predictions against reality.
 * Called every 5 minutes by the drive loop.
 */
async function resolvePendingPredictions() {
  const now = Date.now();
  const pending = predictionLedger.filter(p => !p.resolved && p.check_at <= now && typeof p.checkFn === 'function');

  for (const pred of pending) {
    try {
      const matched = await pred.checkFn();
      pred.resolved = true;
      pred.matched  = matched;
      pred.resolved_at = now;

      if (matched) {
        adjust('satisfaction',     +0.08);
        adjust('prediction_error', -0.06);
        console.log(`[DriveSystem] ✓ Prediction confirmed: "${pred.claim.slice(0, 60)}"`);
      } else {
        adjust('prediction_error', +0.10);
        adjust('satisfaction',     -0.04);
        adjust('curiosity',        +0.06); // mismatch → explore why
        console.log(`[DriveSystem] ✗ Prediction failed: "${pred.claim.slice(0, 60)}" → triggers curiosity`);
      }
    } catch (e) {
      pred.resolved = true;
      pred.matched  = null; // inconclusive
      console.warn(`[DriveSystem] Prediction check error: ${e.message}`);
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
    .map(([k, v]) => `${k}=${(v * 100).toFixed(0)}%`)
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
  const matched  = resolved.filter(p => p.matched === true);
  const accuracy = resolved.length > 0 ? matched.length / resolved.length : null;
  return {
    total:     predictionLedger.length,
    resolved:  resolved.length,
    pending:   predictionLedger.filter(p => !p.resolved).length,
    matched:   matched.length,
    accuracy:  accuracy !== null ? Math.round(accuracy * 100) : null,
  };
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

    console.log(`[DriveSystem] Started. Initial state: ${getDriveStatus()}`);
  },

  stop() {
    if (_decayInterval) { clearInterval(_decayInterval); _decayInterval = null; }
    _initialized = false;
    saveState();
  },
};
