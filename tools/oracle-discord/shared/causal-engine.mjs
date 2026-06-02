// shared/causal-engine.mjs
// ──────────────────────────────────────────────────────────────────────────────
// KAI Causal Reasoning Engine — Layer 2 of the Cognitive Stack
//
// MOTIVATION
//   Correlation is not causation. The correlation engine can detect that
//   metric A and metric B move together. But it cannot determine:
//     - Does A cause B?
//     - Does B cause A?
//     - Does a third factor C cause both?
//
//   Classic example: ice cream sales and drowning incidents correlate strongly.
//   Naively concluding "ice cream causes drowning" is the trap. The real cause
//   is temperature — a confounder that drives both.
//
//   KAI cannot physically experiment. But it CAN:
//     1. Check TEMPORAL ORDERING — does A consistently precede B?
//     2. Find NATURAL EXPERIMENTS — windows where A was absent; did B still occur?
//     3. SEARCH FOR CONFOUNDERS — find a third metric C that correlates with both
//     4. Combine evidence to produce a CAUSAL VERDICT
//
// HOW IT WORKS
//   When the correlation engine fires an alert, causal-engine registers a
//   Hypothesis. Over the next N samples it accumulates evidence through the
//   metrics store (non-destructively — read-only). When evidence threshold is
//   met, it renders a verdict and stores it in the lattice for KAI to use.
//
// VERDICTS
//   causal        — A likely causes B (strong temporal order, no ablation counterexamples)
//   spurious      — correlation is coincidence (B occurs without A regularly)
//   confounded    — third factor C explains both (C found and named)
//   inconclusive  — not enough data to decide
// ──────────────────────────────────────────────────────────────────────────────

import { aggregateMetric, getMetricHistory } from './metrics-store.mjs';
import { storeLattice } from './lattice-bridge.mjs';
import { recordWorldEvent } from './world-model.mjs';
import { onEcosystemFailure } from './drive-system.mjs';

// ── Hypothesis Ledger ──────────────────────────────────────────────────────────
const hypotheses = new Map(); // id → Hypothesis
const MAX_HYPOTHESES = 50;
const VERDICT_THRESHOLD = 5; // minimum evidence samples before rendering verdict

/**
 * A causal hypothesis between two observed metrics.
 */
class Hypothesis {
  constructor(id, metricA, metricB, correlationObs, sourceRule) {
    this.id            = id;
    this.metric_a      = metricA;   // { source, metric } — the potential cause
    this.metric_b      = metricB;   // { source, metric } — the potential effect
    this.correlation   = correlationObs;
    this.source_rule   = sourceRule; // which correlation rule triggered this
    this.created_at    = Date.now();
    this.evidence      = [];        // { type, finding, ts }
    this.verdict       = 'pending'; // pending | causal | spurious | confounded | inconclusive
    this.confounder    = null;      // name of confounder if found
    this.verdict_at    = null;
  }

  addEvidence(type, finding) {
    this.evidence.push({ type, finding, ts: Date.now() });
  }

  hasEnoughEvidence() {
    return this.evidence.length >= VERDICT_THRESHOLD;
  }
}

// ── Hypothesis Registration ────────────────────────────────────────────────────
/**
 * Register a new causal hypothesis to investigate.
 * Called by correlation-engine when a rule fires.
 */
export function registerHypothesis(metricA, metricB, correlation, sourceRule = 'unknown') {
  const id = `hyp_${metricA.source}_${metricA.metric}__${metricB.source}_${metricB.metric}`;

  // Don't re-register if already active
  if (hypotheses.has(id) && hypotheses.get(id).verdict === 'pending') {
    return id;
  }

  if (hypotheses.size >= MAX_HYPOTHESES) {
    // Evict oldest resolved hypothesis
    const oldest = [...hypotheses.entries()]
      .filter(([, h]) => h.verdict !== 'pending')
      .sort((a, b) => a[1].created_at - b[1].created_at)[0];
    if (oldest) hypotheses.delete(oldest[0]);
  }

  const h = new Hypothesis(id, metricA, metricB, correlation, sourceRule);
  hypotheses.set(id, h);
  console.log(`[CausalEngine] New hypothesis: ${metricA.source}.${metricA.metric} → ${metricB.source}.${metricB.metric} (r=${correlation.toFixed(2)})`);
  return id;
}

// ── Investigation Steps ────────────────────────────────────────────────────────

/**
 * Step 1: Temporal ordering.
 * Does A consistently precede B by a detectable lag?
 * Uses 60-minute windows from the metrics store.
 */
function investigateTemporalOrder(h) {
  try {
    const windowMs = 60 * 60_000; // 1 hour
    const histA = getMetricHistory(h.metric_a.source, h.metric_a.metric, windowMs);
    const histB = getMetricHistory(h.metric_b.source, h.metric_b.metric, windowMs);

    if (!histA || histA.length < 5 || !histB || histB.length < 5) {
      h.addEvidence('temporal', 'insufficient_data');
      return;
    }

    // Find peaks of A (top 20%) and check if B spikes within 5 minutes after
    const aValues = histA.map(p => p.value);
    const aThreshold = aValues.sort((x, y) => y - x)[Math.floor(aValues.length * 0.2)];
    const aPeaks = histA.filter(p => p.value >= aThreshold);

    let precedes = 0;
    let checked  = 0;
    for (const peak of aPeaks) {
      checked++;
      const bAfter = histB.filter(p => p.ts > peak.ts && p.ts < peak.ts + 5 * 60_000);
      const bBefore = histB.filter(p => p.ts < peak.ts && p.ts > peak.ts - 5 * 60_000);
      if (bAfter.length > 0 && bBefore.length === 0) precedes++;
    }

    const orderScore = checked > 0 ? precedes / checked : 0;
    const finding = orderScore > 0.6
      ? `A precedes B in ${Math.round(orderScore * 100)}% of peaks (supports causation)`
      : `No consistent temporal order (A precedes B in only ${Math.round(orderScore * 100)}%)`;

    h.addEvidence('temporal', finding);
    console.log(`[CausalEngine] ${h.id} temporal: ${finding}`);
  } catch (e) {
    h.addEvidence('temporal', `error: ${e.message}`);
  }
}

/**
 * Step 2: Natural experiment — ablation.
 * Find windows where A was LOW or ABSENT. Did B still occur?
 * If yes → A is NOT necessary for B → spurious or confounded.
 */
function investigateAblation(h) {
  try {
    const windowMs = 120 * 60_000; // 2 hours
    const histA = getMetricHistory(h.metric_a.source, h.metric_a.metric, windowMs);
    const histB = getMetricHistory(h.metric_b.source, h.metric_b.metric, windowMs);

    if (!histA || histA.length < 10 || !histB || histB.length < 10) {
      h.addEvidence('ablation', 'insufficient_data');
      return;
    }

    const aValues = histA.map(p => p.value);
    const aMedian = aValues.sort((x, y) => x - y)[Math.floor(aValues.length / 2)];
    const aLowWindows = histA.filter(p => p.value < aMedian * 0.5); // A is very low

    let bOccursDespiteLowA = 0;
    for (const lowA of aLowWindows) {
      // Did B spike within 10 minutes of this low-A period?
      const bValues = histB.filter(p => Math.abs(p.ts - lowA.ts) < 10 * 60_000);
      const bMedian = histB.reduce((sum, p) => sum + p.value, 0) / histB.length;
      if (bValues.some(p => p.value > bMedian * 1.2)) {
        bOccursDespiteLowA++;
      }
    }

    const ablationRate = aLowWindows.length > 0 ? bOccursDespiteLowA / aLowWindows.length : 0;
    const finding = ablationRate > 0.4
      ? `B occurs when A is absent in ${Math.round(ablationRate * 100)}% of cases (suggests A is not necessary — possible confounder)`
      : `B rarely occurs when A is absent (${Math.round(ablationRate * 100)}% — supports A as necessary condition)`;

    h.addEvidence('ablation', finding);
    console.log(`[CausalEngine] ${h.id} ablation: ${finding}`);
  } catch (e) {
    h.addEvidence('ablation', `error: ${e.message}`);
  }
}

/**
 * Step 3: Confounder search.
 * Find metrics that correlate with BOTH A and B — the temperature in the ice cream example.
 * Candidate confounders: CPU, memory, time-of-day, call volume, active bots.
 */
function searchForConfounder(h) {
  const CONFOUNDER_CANDIDATES = [
    { source: 'performance-monitor', metric: 'cpu_pct',     label: 'CPU load' },
    { source: 'performance-monitor', metric: 'mem_pct',     label: 'Memory pressure' },
    { source: 'rust-engine',         metric: 'cells',       label: 'Lattice cell count' },
    { source: 'rust-engine',         metric: 'phi_g',       label: 'Lattice coherence (phi_g)' },
    { source: 'rust-engine',         metric: 'chi',         label: 'Lattice friction (chi)' },
  ];

  const windowMs = 60 * 60_000;
  const histA = getMetricHistory(h.metric_a.source, h.metric_a.metric, windowMs);
  const histB = getMetricHistory(h.metric_b.source, h.metric_b.metric, windowMs);

  if (!histA || histA.length < 5 || !histB || histB.length < 5) {
    h.addEvidence('confounder', 'insufficient_data_for_confounder_search');
    return;
  }

  for (const candidate of CONFOUNDER_CANDIDATES) {
    // Skip if candidate is A or B itself
    if (candidate.source === h.metric_a.source && candidate.metric === h.metric_a.metric) continue;
    if (candidate.source === h.metric_b.source && candidate.metric === h.metric_b.metric) continue;

    try {
      const histC = getMetricHistory(candidate.source, candidate.metric, windowMs);
      if (!histC || histC.length < 5) continue;

      const corrAC = approximateCorrelation(histA, histC);
      const corrBC = approximateCorrelation(histB, histC);

      if (corrAC > 0.5 && corrBC > 0.5) {
        const finding = `Confounder found: "${candidate.label}" correlates with both A (r=${corrAC.toFixed(2)}) and B (r=${corrBC.toFixed(2)})`;
        h.addEvidence('confounder', finding);
        h.confounder = candidate.label;
        console.log(`[CausalEngine] ${h.id} ${finding}`);
        return; // Found one — enough for now
      }
    } catch (_) {}
  }

  h.addEvidence('confounder', 'no_strong_confounder_found');
}

// ── Correlation Helper ─────────────────────────────────────────────────────────
/**
 * Approximate Pearson correlation between two time series (sampled to common timestamps).
 */
function approximateCorrelation(seriesA, seriesB) {
  if (seriesA.length < 3 || seriesB.length < 3) return 0;

  // Align by taking N evenly-spaced samples from each series
  const N = Math.min(seriesA.length, seriesB.length, 30);
  const stepA = Math.floor(seriesA.length / N);
  const stepB = Math.floor(seriesB.length / N);

  const vA = Array.from({ length: N }, (_, i) => seriesA[i * stepA]?.value ?? 0);
  const vB = Array.from({ length: N }, (_, i) => seriesB[i * stepB]?.value ?? 0);

  const meanA = vA.reduce((s, v) => s + v, 0) / N;
  const meanB = vB.reduce((s, v) => s + v, 0) / N;
  const cov   = vA.reduce((s, v, i) => s + (v - meanA) * (vB[i] - meanB), 0) / N;
  const stdA  = Math.sqrt(vA.reduce((s, v) => s + (v - meanA) ** 2, 0) / N);
  const stdB  = Math.sqrt(vB.reduce((s, v) => s + (v - meanB) ** 2, 0) / N);

  if (stdA === 0 || stdB === 0) return 0;
  return Math.min(1, Math.max(-1, cov / (stdA * stdB)));
}

// ── Verdict Rendering ──────────────────────────────────────────────────────────
function renderVerdict(h) {
  const evidence = h.evidence.map(e => e.finding);

  const hasTemporalSupport   = evidence.some(e => e.includes('precedes B in') && !e.includes('only'));
  const hasAblationChallenge = evidence.some(e => e.includes('B occurs when A is absent'));
  const hasConfounder        = h.confounder !== null;

  let verdict, explanation;

  if (hasConfounder) {
    verdict = 'confounded';
    explanation = `${h.metric_a.metric} and ${h.metric_b.metric} are both driven by "${h.confounder}". Neither causes the other directly. Addressing the confounder addresses both.`;
  } else if (hasAblationChallenge && !hasTemporalSupport) {
    verdict = 'spurious';
    explanation = `${h.metric_a.metric} correlates with ${h.metric_b.metric} but B occurs even when A is absent. The correlation is coincidental or mediated by an undetected factor.`;
  } else if (hasTemporalSupport && !hasAblationChallenge) {
    verdict = 'causal';
    explanation = `${h.metric_a.metric} consistently precedes ${h.metric_b.metric} and B is rare when A is absent. A is likely a causal or contributing factor.`;
  } else {
    verdict = 'inconclusive';
    explanation = `Mixed evidence for ${h.metric_a.metric} → ${h.metric_b.metric}. Need more data or different investigation strategy.`;
  }

  h.verdict    = verdict;
  h.verdict_at = Date.now();

  const verdictStr = `[CAUSAL ANALYSIS] ${h.source_rule}: ${explanation} (Evidence: ${evidence.slice(0, 3).join('; ')})`;
  console.log(`[CausalEngine] Verdict for ${h.id}: ${verdict} — ${explanation}`);

  // Store verdict in the lattice — KAI can recall this when explaining anomalies
  storeLattice(verdictStr, 'causal-engine', 1.5, 'causal-analysis').catch(() => {});

  // Record to world model
  recordWorldEvent('causal_verdict', `${verdict}: ${explanation}`,
    verdict === 'causal' ? 'warn' : 'info');

  return verdict;
}

// ── Investigation Loop ─────────────────────────────────────────────────────────
async function investigatePending() {
  const pending = [...hypotheses.values()].filter(h => h.verdict === 'pending');

  for (const h of pending) {
    const ageMs = Date.now() - h.created_at;

    // Run investigation steps as data accumulates
    if (h.evidence.length === 0) {
      investigateTemporalOrder(h);
    } else if (h.evidence.length === 1 && ageMs > 5 * 60_000) {
      investigateAblation(h);
    } else if (h.evidence.length === 2 && ageMs > 10 * 60_000) {
      searchForConfounder(h);
    }

    // Render verdict when enough evidence or hypothesis is old
    if (h.hasEnoughEvidence() || (ageMs > 30 * 60_000 && h.evidence.length >= 2)) {
      renderVerdict(h);
    }

    // Force inconclusive after 2 hours regardless
    if (ageMs > 2 * 60 * 60_000 && h.verdict === 'pending') {
      h.verdict = 'inconclusive';
      h.verdict_at = Date.now();
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────
/**
 * Get all verdicts (resolved hypotheses).
 */
export function getCausalVerdicts() {
  return [...hypotheses.values()]
    .filter(h => h.verdict !== 'pending')
    .map(h => ({
      id:          h.id,
      metric_a:    `${h.metric_a.source}.${h.metric_a.metric}`,
      metric_b:    `${h.metric_b.source}.${h.metric_b.metric}`,
      verdict:     h.verdict,
      confounder:  h.confounder,
      correlation: h.correlation,
      verdict_at:  new Date(h.verdict_at || 0).toISOString(),
    }));
}

/**
 * Get a brief summary of causal state for injection into prompts.
 */
export function getCausalContext() {
  const verdicts = getCausalVerdicts().slice(-5); // last 5
  if (verdicts.length === 0) return '';

  const lines = verdicts.map(v => {
    const label = v.confounder
      ? `${v.metric_a} ↔ ${v.metric_b}: confounded by ${v.confounder}`
      : `${v.metric_a} → ${v.metric_b}: ${v.verdict}`;
    return `  • ${label}`;
  });

  return `[CAUSAL KNOWLEDGE]\n${lines.join('\n')}`;
}

// ── Module Start ───────────────────────────────────────────────────────────────
let _interval = null;

export const causalEngine = {
  start(tickMs = 5 * 60_000) {
    if (_interval) return;
    _interval = setInterval(() => {
      investigatePending().catch(e => console.warn('[CausalEngine] Tick error:', e.message));
    }, tickMs);
    console.log('[CausalEngine] Started. Investigation loop every 5 minutes.');
  },
  stop() {
    if (_interval) { clearInterval(_interval); _interval = null; }
  },
};
