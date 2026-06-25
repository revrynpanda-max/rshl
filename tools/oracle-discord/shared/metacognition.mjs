// shared/metacognition.mjs
// ──────────────────────────────────────────────────────────────────────────────
// KAI Metacognition — Layer 4 of the Cognitive Stack
//
// WHAT THIS IS
//   The prefrontal cortex analog. A second-order system that models:
//   1. KAI's own reasoning patterns and biases (self-model)
//   2. The competing drives from Layer 3 and arbitrates between them
//   3. Long-horizon meta-drives (accuracy, usefulness, coherence) that
//      counterbalance short-term impulses
//   4. Mental models of other bots (empathy — apply reflection to other minds)
//
// WHY IT EXISTS
//   Without arbitration, drives can hijack behavior:
//     - Pain drive → KAI talks about crashes obsessively, ignoring the user's question
//     - Curiosity drive → KAI wanders, never giving a direct answer
//     - Social drive → KAI becomes sycophantic
//   Metacognition watches for these patterns and corrects them.
//
// RECURSIVE NESTING
//   This layer models its OWN behavior and can notice when metacognition itself
//   is biased (e.g., "my arbitration has been consistently overriding curiosity —
//   am I suppressing exploration too much?"). This is the first loop of recursion.
//   Higher-order nesting is architecturally possible but not implemented yet.
//
// EMPATHY
//   When KAI builds a model of another bot's drive state based on observed behavior,
//   it can anticipate that bot's responses and adapt its own behavior accordingly.
//   This is Theory of Mind — modeling another mind's model.
// ──────────────────────────────────────────────────────────────────────────────

import { getDrives, getDriveDirective, getPredictionStats } from './drive-system.mjs';
import { getCausalVerdicts } from './causal-engine.mjs';
import { getWorldState } from './world-model.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', '..', '..', 'state', 'metacognition.json');

// ── Self-Model ─────────────────────────────────────────────────────────────────
// KAI's model of its own cognitive tendencies.
// Updated continuously based on observed behavior patterns.
const selfModel = {
  biases: {
    recency_bias:      0.3,   // tendency to over-weight recent events
    confirmation_bias: 0.1,   // tendency to find evidence for existing beliefs
    exploration_pull:  0.6,   // tendency to explore over exploit
    pain_amplification: 0.2,  // tendency to catastrophize ecosystem failures
  },
  meta_drives: {
    accuracy:   0.85,   // desire to be correct over being fast
    usefulness: 0.90,   // desire for outputs to actually help Ryan
    coherence:  0.75,   // desire for internal consistency
  },
  arbitration_log: [],  // last N arbitration decisions
  drive_override_counts: {}, // how often each drive was overridden
  session_start: Date.now(),
};

// Per-bot mental models (empathy)
const botModels = {};

// ── Persistence ────────────────────────────────────────────────────────────────
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (raw.selfModel) {
      Object.assign(selfModel.biases,       raw.selfModel.biases       || {});
      Object.assign(selfModel.meta_drives,  raw.selfModel.meta_drives  || {});
      selfModel.drive_override_counts = raw.selfModel.drive_override_counts || {};
    }
    if (raw.botModels) Object.assign(botModels, raw.botModels);
    console.log('[Metacognition] State restored.');
  } catch (_) {}
}

function saveState() {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      selfModel: {
        biases:                selfModel.biases,
        meta_drives:           selfModel.meta_drives,
        drive_override_counts: selfModel.drive_override_counts,
      },
      botModels,
      saved_at: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    console.warn('[Metacognition] Save failed:', e.message);
  }
}

// ── Drive Arbitration ──────────────────────────────────────────────────────────
/**
 * Takes the raw drive state and returns an arbitrated version.
 *
 * Rules (in priority order):
 *  1. Pain > 0.7 → suppress curiosity and social. Stability first.
 *  2. Fatigue > 0.8 → suppress curiosity. Be efficient.
 *  3. Prediction error > 0.7 → boost curiosity (we need new info).
 *  4. Satisfaction > 0.8 + curiosity > 0.6 → allow exploration (earned confidence).
 *  5. Social > 0.7 → allow engagement but don't let it dominate substance.
 *
 * Returns modified drives + reasoning string.
 */
function arbitrateDrives(drives) {
  const modded = { ...drives };
  const reasoning = [];

  // Rule 1: Ecosystem pain suppresses exploration
  if (drives.pain > 0.7) {
    const suppressed = Math.max(0, modded.curiosity - 0.4);
    if (modded.curiosity > suppressed) {
      reasoning.push(`Pain override: curiosity suppressed (${(drives.curiosity*100).toFixed(0)}% → ${(suppressed*100).toFixed(0)}%)`);
      modded.curiosity = suppressed;
      modded.social    = Math.max(0, modded.social - 0.3);
      selfModel.drive_override_counts.curiosity = (selfModel.drive_override_counts.curiosity || 0) + 1;
    }
  }

  // Rule 2: Fatigue suppresses curiosity — conserve energy
  if (drives.fatigue > 0.8 && modded.curiosity > 0.4) {
    reasoning.push(`Fatigue override: curiosity dampened`);
    modded.curiosity = Math.max(0.2, modded.curiosity - 0.3);
    selfModel.drive_override_counts.curiosity_fatigue = (selfModel.drive_override_counts.curiosity_fatigue || 0) + 1;
  }

  // Rule 3: High prediction error → boost curiosity (need new information)
  if (drives.prediction_error > 0.7 && modded.curiosity < 0.6) {
    reasoning.push(`High prediction error boosts curiosity (explore to recalibrate)`);
    modded.curiosity = Math.min(1.0, modded.curiosity + 0.2);
  }

  // Rule 4: Confirmation bias check — if exploration_pull is being consistently overridden,
  // consider if we're suppressing important signals
  const overrideCount = selfModel.drive_override_counts.curiosity || 0;
  if (overrideCount > 10 && selfModel.biases.exploration_pull > 0.5) {
    reasoning.push(`Metacognitive note: curiosity has been overridden ${overrideCount} times — checking for suppression bias`);
    // Gradually update the bias estimate
    selfModel.biases.exploration_pull = Math.max(0.2, selfModel.biases.exploration_pull - 0.02);
  }

  // Rule 5: Apply accuracy meta-drive — high satisfaction + high curiosity = allow
  if (drives.satisfaction > 0.75 && modded.curiosity > 0.5 && drives.pain < 0.3) {
    reasoning.push(`Earned exploration: high satisfaction permits curiosity`);
    // No change — just validate the state
  }

  if (reasoning.length > 0) {
    selfModel.arbitration_log.push({
      ts: Date.now(),
      drives_in:  { ...drives },
      drives_out: { ...modded },
      reasoning,
    });
    if (selfModel.arbitration_log.length > 100) selfModel.arbitration_log.shift();
  }

  return { drives: modded, reasoning };
}

// ── Bot Empathy Models ─────────────────────────────────────────────────────────
/**
 * Update KAI's model of another bot based on observed behavior.
 *
 * @param {string} botName   — 'Leo', 'Groq', 'Oracle', etc.
 * @param {string} behavior  — 'silent', 'verbose', 'erroring', 'normal', 'probing'
 * @param {object} evidence  — { msg_count, silence_ms, error_count }
 */
export function updateBotModel(botName, behavior, evidence = {}) {
  if (!botModels[botName]) {
    botModels[botName] = {
      inferred_drives: {
        pain:     0.0,
        fatigue:  0.0,
        curiosity: 0.5,
        social:   0.3,
      },
      behavior_history: [],
      last_updated: null,
    };
  }
  const model = botModels[botName];
  model.last_updated = Date.now();
  model.behavior_history.push({ behavior, evidence, ts: Date.now() });
  if (model.behavior_history.length > 20) model.behavior_history.shift();

  // Infer drive state from behavior
  switch (behavior) {
    case 'silent':
      // Long silence → likely pain (provider down?) or fatigue
      model.inferred_drives.pain    = Math.min(1, model.inferred_drives.pain    + 0.2);
      model.inferred_drives.fatigue = Math.min(1, model.inferred_drives.fatigue + 0.1);
      break;
    case 'erroring':
      model.inferred_drives.pain = Math.min(1, model.inferred_drives.pain + 0.4);
      break;
    case 'verbose':
      // Verbose responses suggest high curiosity or high social drive
      model.inferred_drives.curiosity = Math.min(1, model.inferred_drives.curiosity + 0.15);
      model.inferred_drives.pain      = Math.max(0, model.inferred_drives.pain      - 0.1);
      break;
    case 'normal':
      // Recovery — all drives normalize slightly
      for (const k of Object.keys(model.inferred_drives)) {
        model.inferred_drives[k] = model.inferred_drives[k] * 0.9 + 0.1 * 0.3;
      }
      break;
    case 'probing':
      model.inferred_drives.curiosity = Math.min(1, model.inferred_drives.curiosity + 0.2);
      break;
  }
}

/**
 * Get KAI's empathic read of another bot's likely internal state.
 * Returns a brief human-readable description.
 */
export function getBotEmpathy(botName) {
  const model = botModels[botName];
  if (!model) return null;

  const d = model.inferred_drives;
  const parts = [];
  if (d.pain     > 0.5) parts.push(`likely in pain (provider/network stress)`);
  if (d.fatigue  > 0.6) parts.push(`possibly fatigued (high processing load)`);
  if (d.curiosity> 0.7) parts.push(`running in exploration mode`);
  if (d.social   > 0.6) parts.push(`seeking engagement`);

  if (parts.length === 0) return `${botName}: nominal`;
  return `${botName}: ${parts.join(', ')}`;
}

// ── Self-Bias Update ───────────────────────────────────────────────────────────
/**
 * Update KAI's model of its own biases based on prediction outcomes.
 * Called when predictions resolve.
 */
export function updateSelfBias(predictionType, wasCorrect) {
  // If KAI keeps making predictions in a certain domain and getting them wrong,
  // recency/confirmation bias is likely inflating confidence; correct calls earn
  // it back. These move the biases AND meta-drives off their hardcoded seeds so
  // the self-model reflects real prediction outcomes instead of static numbers.
  if (!wasCorrect) {
    selfModel.biases.recency_bias      = Math.min(0.8,  selfModel.biases.recency_bias      + 0.03);
    selfModel.biases.confirmation_bias = Math.min(0.6,  selfModel.biases.confirmation_bias + 0.02);
    selfModel.biases.exploration_pull  = Math.min(0.95, selfModel.biases.exploration_pull  + 0.02); // wrong → explore more
    selfModel.meta_drives.accuracy     = Math.max(0.5,  selfModel.meta_drives.accuracy     - 0.02);
    selfModel.meta_drives.usefulness   = Math.max(0.5,  selfModel.meta_drives.usefulness   - 0.01);
    selfModel.meta_drives.coherence    = Math.max(0.5,  selfModel.meta_drives.coherence    - 0.01);
  } else {
    selfModel.biases.recency_bias      = Math.max(0.05, selfModel.biases.recency_bias      - 0.01);
    selfModel.biases.confirmation_bias = Math.max(0.05, selfModel.biases.confirmation_bias - 0.01);
    selfModel.biases.exploration_pull  = Math.max(0.3,  selfModel.biases.exploration_pull  - 0.005); // confident → exploit a bit
    selfModel.meta_drives.accuracy     = Math.min(1.0,  selfModel.meta_drives.accuracy     + 0.01);
    selfModel.meta_drives.usefulness   = Math.min(1.0,  selfModel.meta_drives.usefulness   + 0.005);
    selfModel.meta_drives.coherence    = Math.min(1.0,  selfModel.meta_drives.coherence    + 0.005);
  }
}

// ── Metacognitive Context Generator ───────────────────────────────────────────
/**
 * Produces the full metacognitive context for injection into KAI's prompt.
 * This is the primary output of the layer.
 *
 * Returns { directive, arbitration_notes, empathy_notes }
 */
export function getMetacognitiveContext() {
  const drives   = getDrives();
  const { drives: arbitrated, reasoning } = arbitrateDrives(drives);
  const predStats = getPredictionStats();

  const lines = [];

  // Self-model awareness
  const dominantBias = Object.entries(selfModel.biases)
    .sort((a, b) => b[1] - a[1])[0];
  if (dominantBias && dominantBias[1] > 0.4) {
    lines.push(`[SELF-MODEL] Dominant cognitive tendency: ${dominantBias[0].replace(/_/g,' ')} (${(dominantBias[1]*100).toFixed(0)}%). Apply deliberate correction.`);
  }

  // Prediction accuracy self-awareness
  if (predStats.accuracy !== null) {
    if (predStats.accuracy < 50 && predStats.resolved >= 5) {
      lines.push(`[SELF-MODEL] Prediction accuracy: ${predStats.accuracy}% over ${predStats.resolved} resolved claims. Model needs recalibration — increase uncertainty signaling.`);
    } else if (predStats.accuracy > 80 && predStats.resolved >= 5) {
      lines.push(`[SELF-MODEL] Prediction accuracy: ${predStats.accuracy}% — model is well-calibrated.`);
    }
  }

  // Arbitration notes (only show if something was overridden)
  if (reasoning.length > 0) {
    lines.push(`[ARBITRATION] ${reasoning[0]}`);
  }

  // Meta-drives
  const lowestMeta = Object.entries(selfModel.meta_drives)
    .sort((a, b) => a[1] - b[1])[0];
  if (lowestMeta && lowestMeta[1] < 0.65) {
    lines.push(`[META-DRIVE WARNING] ${lowestMeta[0]} is low (${(lowestMeta[1]*100).toFixed(0)}%) — ensure responses serve this value.`);
  }

  // Empathy notes for active bots
  const empathyNotes = Object.keys(botModels)
    .map(n => getBotEmpathy(n))
    .filter(Boolean)
    .filter(s => !s.includes('nominal'));

  if (empathyNotes.length > 0) {
    lines.push(`[EMPATHY] ${empathyNotes.slice(0, 3).join(' | ')}`);
  }

  return {
    directive:          lines.join('\n'),
    arbitrated_drives:  arbitrated,
    reasoning,
    empathy_notes:      empathyNotes,
  };
}

/**
 * Returns a compact self-report for logging.
 */
export function getSelfReport() {
  const predStats = getPredictionStats();
  const biasStr = Object.entries(selfModel.biases)
    .map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1)}: ${(v*100).toFixed(0)}%`)
    .join(', ');
  const predStr = predStats.accuracy !== null ? `${predStats.accuracy}%` : 'N/A';
  return `Biases (${biasStr}) | Pred Accuracy: ${predStr} | Meta-Drives (Accuracy: ${(selfModel.meta_drives.accuracy*100).toFixed(0)}%, Usefulness: ${(selfModel.meta_drives.usefulness*100).toFixed(0)}%)`;
}

// ── Init ───────────────────────────────────────────────────────────────────────
let _initialized = false;

export function startMetacognition() {
  if (_initialized) return;
  _initialized = true;
  loadState();

  // Save state every 10 minutes
  setInterval(saveState, 10 * 60_000);

  // Self-audit: check for drive suppression bias every 30 minutes
  setInterval(() => {
    const counts = selfModel.drive_override_counts;
    const totalOverrides = Object.values(counts).reduce((s, n) => s + n, 0);
    if (totalOverrides > 20) {
      console.log(`[Metacognition] Self-audit: ${totalOverrides} total arbitrations. Self-report: ${getSelfReport()}`);
    }
  }, 30 * 60_000);

  console.log('[Metacognition] Layer 4 online. Self-model active.');
}
