// shared/correlation-engine.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Stage 2b: the central Sentinel brain.
//
// PURPOSE
//   Read the unified metrics store on a periodic loop, run cross-silo rules
//   against the last few minutes of data, and emit "correlation events" back
//   into the store when a rule trips. This is where the system stops being
//   a bunch of independent alarms and starts being aware.
//
// RULE SHAPE
//   Each rule is { id, name, severity, evaluate(snapshot) }.
//   `snapshot` is built once per tick from queryMetrics, so all rules see the
//   same view. Each rule returns either null (didn't trip) or
//   { message, evidence: { ...numbers used to decide } }.
//
// OUTPUT
//   When a rule trips, we recordMetric('correlation-engine', 'rule_tripped', 1,
//   { rule_id, severity, message, ... }). Optional Discord webhook is left as
//   a callback hook — kept out of this module to keep it pure/testable.
// ──────────────────────────────────────────────────────────────────────────────

import { queryMetrics, recordMetric, aggregateMetric, latestMetric } from './metrics-store.mjs';
import { isDrifting } from './baselines.mjs';
import { snapshot as behavioralSnapshot } from './behavioral-signals.mjs';
import { suppressBot, requestExtraSystemPrompt } from './remediation-state.mjs';
import { getRecentHistory } from './topic-tracker.mjs';

const TICK_MS    = 30_000;        // run every 30 seconds
const WINDOW_MS  = 5  * 60_000;   // each rule sees the last 5 minutes
const COOLDOWN_MS = 5 * 60_000;   // don't re-trip the same rule for 5 minutes

const lastTrip = new Map();       // rule_id -> ts

// ── helpers used by rules ────────────────────────────────────────────────────
function recentAvg(source, metric, windowMs = WINDOW_MS, tagMatch = null) {
  const a = aggregateMetric(source, metric, windowMs, tagMatch);
  return a ? a.avg : null;
}
function recentMax(source, metric, windowMs = WINDOW_MS, tagMatch = null) {
  const a = aggregateMetric(source, metric, windowMs, tagMatch);
  return a ? a.max : null;
}
function recentCount(source, metric, windowMs = WINDOW_MS, tagMatch = null) {
  const a = aggregateMetric(source, metric, windowMs, tagMatch);
  return a ? a.n : 0;
}
function recentValueCount(source, metric, value, windowMs = WINDOW_MS) {
  // Count occurrences of records whose `value` equals a specific value.
  // Used for status-code distributions, etc.
  const since = Date.now() - windowMs;
  const recs = queryMetrics({ source, metric, since, limit: 100_000 });
  return recs.filter(r => r.value === value).length;
}
function distinctTagValues(source, metric, tagKey, windowMs = WINDOW_MS) {
  const since = Date.now() - windowMs;
  const recs = queryMetrics({ source, metric, since, limit: 100_000 });
  return new Set(recs.map(r => r.tags?.[tagKey]).filter(Boolean));
}

// ── the rules ────────────────────────────────────────────────────────────────
const RULES = [
  {
    id:       'gpu-pressure-degrading-speech',
    name:     'GPU pressure correlating with slow TTS / locked floor',
    severity: 'warn',
    evaluate() {
      const gpuAvg = recentAvg('performance-monitor', 'gpu_pct');
      const heldAvg = recentAvg('tts-engine', 'lock_held_ms');
      if (gpuAvg === null || heldAvg === null) return null;
      if (gpuAvg > 90 && heldAvg > 11_000) {
        return {
          message: `GPU averaged ${gpuAvg.toFixed(1)}% while bots held the floor avg ${(heldAvg / 1000).toFixed(1)}s — probable contention.`,
          evidence: { gpu_pct_avg: gpuAvg, lock_held_ms_avg: heldAvg },
        };
      }
      return null;
    },
  },
  {
    id:       'tts-error-cluster',
    name:     'Multiple TTS calls failing in the last 5 minutes',
    severity: 'error',
    evaluate() {
      const errs   = recentValueCount('tts-engine', 'tts_status', 401)
                   + recentValueCount('tts-engine', 'tts_status', 404)
                   + recentValueCount('tts-engine', 'tts_status', 429)
                   + recentValueCount('tts-engine', 'tts_status', 'exception');
      const total  = recentCount('tts-engine', 'tts_status');
      if (total < 3) return null;          // not enough volume to call it
      const errRate = errs / total;
      if (errRate > 0.30) {
        return {
          message: `${errs} of ${total} TTS calls failed (${(errRate * 100).toFixed(0)}%) in the last 5 minutes.`,
          evidence: { failures: errs, total, error_rate: errRate },
        };
      }
      return null;
    },
  },
  {
    id:       'provider-circuit-tripped',
    name:     'A neural provider failed repeatedly without recovering',
    severity: 'error',
    evaluate() {
      const failures = queryMetrics({
        source: 'failure-tracker',
        metric: 'provider_failure',
        since:  Date.now() - WINDOW_MS,
        limit:  1000,
      });
      if (failures.length < 3) return null;
      // Group by provider
      const byProvider = {};
      for (const f of failures) {
        const p = f.tags?.provider || 'unknown';
        byProvider[p] = (byProvider[p] || 0) + 1;
      }
      // Find providers without a recovery in the window
      const recoveries = new Set(
        queryMetrics({
          source: 'failure-tracker', metric: 'provider_recovery',
          since: Date.now() - WINDOW_MS, limit: 1000,
        }).map(r => r.tags?.provider)
      );
      const stuck = Object.entries(byProvider)
        .filter(([p, n]) => n >= 3 && !recoveries.has(p))
        .map(([p, n]) => `${p}(${n})`);
      if (!stuck.length) return null;
      return {
        message: `Providers failing repeatedly with no recovery: ${stuck.join(', ')}`,
        evidence: { providers: byProvider, stuck },
      };
    },
  },
  {
    id:       'silence-cascade',
    name:     'Voice floor lock timing out — bots dropping turns',
    severity: 'warn',
    evaluate() {
      const timeouts = recentCount('tts-engine', 'lock_wait_timeout');
      if (timeouts >= 3) {
        return {
          message: `${timeouts} bots dropped their turn due to lock-wait timeout in the last 5 minutes — silence cascade risk.`,
          evidence: { lock_wait_timeouts: timeouts },
        };
      }
      return null;
    },
  },
  {
    id:       'speaker-offline-drift',
    name:     'A social bot has gone offline and hasn\'t come back',
    severity: 'warn',
    evaluate() {
      const offlines = queryMetrics({
        source: 'failure-tracker', metric: 'speaker_offline_state',
        since: Date.now() - WINDOW_MS, limit: 1000,
      });
      if (!offlines.length) return null;
      const speakers = [...new Set(offlines.map(o => o.tags?.speaker).filter(Boolean))];
      if (!speakers.length) return null;
      return {
        message: `Speaker(s) currently flagged offline by failure-tracker: ${speakers.join(', ')}`,
        evidence: { offline_speakers: speakers },
      };
    },
  },
  // ── Behavioral rules (Stage 7b) — chat UX issues that don't throw ──────────
  // These read from the social chat history via behavioral-signals. They use
  // a CHANNEL_ID env var (CHANNEL_SUNDAY) so they're configurable.
  {
    id:       'social-chat-silent',
    name:     'Social chat has gone silent (cascade-style)',
    severity: 'warn',
    evaluate() {
      const ch = process.env.CHANNEL_SUNDAY || '1500085302268526712';
      const s = behavioralSnapshot(ch);
      if (s.history_size === 0) return null;
      // Silence > 4 min in social chat after activity → cascade
      if (s.silence_ms > 4 * 60_000 && s.history_size >= 3) {
        return {
          message: `social chat silent for ${(s.silence_ms / 1000 / 60).toFixed(1)} min after ${s.history_size} recent messages — possible cascade.`,
          evidence: { silence_ms: s.silence_ms, history_size: s.history_size },
        };
      }
      return null;
    },
  },
  {
    id:       'echo-chamber',
    name:     'Two bots ping-ponging without others joining',
    severity: 'warn',
    evaluate() {
      const ch = process.env.CHANNEL_SUNDAY || '1500085302268526712';
      const s = behavioralSnapshot(ch);
      // 5+ A-B-A-B alternations with only 2 distinct speakers
      if (s.reply_chain_depth >= 5 && s.distinct_speakers <= 2) {
        return {
          message: `2-bot ping-pong of depth ${s.reply_chain_depth} (only ${s.distinct_speakers} speakers). Other bots aren't engaging.`,
          evidence: { reply_chain_depth: s.reply_chain_depth, distinct_speakers: s.distinct_speakers, speaker_diversity: s.speaker_diversity },
        };
      }
      return null;
    },
  },
  {
    id:       'hallucination-spike',
    name:     'Bots fabricating lattice claims / fake citations',
    severity: 'error',
    evaluate() {
      const ch = process.env.CHANNEL_SUNDAY || '1500085302268526712';
      const s = behavioralSnapshot(ch);
      if (s.hallucination_count >= 3) {
        const who = [...new Set(s.hallucination_samples.map(m => m.author).filter(Boolean))];
        return {
          message: `${s.hallucination_count} hallucination markers in last 5 min (e.g. "queried the lattice", "synaptic decay", fake "Author et al. 2022"). Speakers: ${who.join(', ') || 'unknown'}.`,
          evidence: { count: s.hallucination_count, speakers: who, samples: s.hallucination_samples },
        };
      }
      return null;
    },
  },
  {
    id:       'topic-stuck-hard',
    name:     'Chat has been re-litigating the same noun for many messages',
    severity: 'warn',
    evaluate() {
      const ch = process.env.CHANNEL_SUNDAY || '1500085302268526712';
      const s = behavioralSnapshot(ch);
      // >65% of last 8+ messages mention same noun = locked-in
      if (s.history_size >= 8 && s.topic_dwell_ratio > 0.65) {
        return {
          message: `${(s.topic_dwell_ratio * 100).toFixed(0)}% of last ${s.history_size} messages converge on one topic — chat is stuck.`,
          evidence: { topic_dwell_ratio: s.topic_dwell_ratio, history_size: s.history_size },
        };
      }
      return null;
    },
  },
  {
    id:       'echo-repetitive',
    name:     'Bots repeating themselves word-for-word',
    severity: 'warn',
    evaluate() {
      const ch = process.env.CHANNEL_SUNDAY || '1500085302268526712';
      const s = behavioralSnapshot(ch);
      if (s.history_size >= 6 && s.repetitiveness > 0.25) {
        return {
          message: `${(s.repetitiveness * 100).toFixed(0)}% of last ${s.history_size} messages share their first 40 chars with another — bots cycling.`,
          evidence: { repetitiveness: s.repetitiveness, history_size: s.history_size },
        };
      }
      return null;
    },
  },
  {
    id:       'lock-held-drift',
    name:     'Bots are holding the voice floor much longer than usual',
    severity: 'warn',
    evaluate() {
      const recent = aggregateMetric('tts-engine', 'lock_held_ms', 5 * 60_000);
      if (!recent || recent.n < 3) return null;
      const drift = isDrifting('tts-engine', 'lock_held_ms', recent.avg);
      if (!drift.drifting) return null;
      return {
        message: `avg lock_held_ms in last 5 min is ${recent.avg.toFixed(0)}ms — ${drift.reason}`,
        evidence: { recent_avg_ms: recent.avg, recent_n: recent.n, ...drift.baseline },
      };
    },
  },
  {
    id:       'lattice-cells-stalled',
    name:     'Rust lattice cell count hasn\'t grown in a long time',
    severity: 'warn',
    evaluate() {
      const last10  = aggregateMetric('rust-engine', 'cells', 10 * 60_000);
      if (!last10 || last10.n < 5) return null;
      const range = last10.max - last10.min;
      if (range <= 0) {
        return {
          message: `lattice cells frozen at ${last10.max} for the last ${last10.n} samples (~10 min). Engine may be idle or stuck.`,
          evidence: { cells: last10.max, samples: last10.n },
        };
      }
      return null;
    },
  },
  {
    id:       'phi-g-collapse',
    name:     'Lattice phi_g has fallen sharply',
    severity: 'error',
    evaluate() {
      const recent   = aggregateMetric('rust-engine', 'phi_g', 2 * 60_000);
      const baseline = aggregateMetric('rust-engine', 'phi_g', 30 * 60_000);
      if (!recent || !baseline || baseline.n < 10) return null;
      if (baseline.avg > 0.05 && recent.avg < baseline.avg * 0.4) {
        return {
          message: `phi_g collapsed: recent avg ${recent.avg.toFixed(3)} vs 30-min baseline ${baseline.avg.toFixed(3)} (${((recent.avg / baseline.avg) * 100).toFixed(0)}%).`,
          evidence: { recent_avg: recent.avg, baseline_avg: baseline.avg },
        };
      }
      return null;
    },
  },
  {
    id:       'rust-engine-unreachable',
    name:     'Rust Oracle server keeps timing out from the JS bridge',
    severity: 'error',
    evaluate() {
      const recs = queryMetrics({
        source: 'rust-engine', metric: 'reachable',
        since: Date.now() - 3 * 60_000, limit: 1000,
      });
      if (recs.length < 5) return null;
      const fails = recs.filter(r => r.value === 0).length;
      if (fails / recs.length > 0.7) {
        return {
          message: `Rust engine unreachable on ${fails}/${recs.length} of the last 3-min polls. Check kai.exe / port 3334.`,
          evidence: { reachable_polls: recs.length, fails },
        };
      }
      return null;
    },
  },
  {
    id:       'memory-creeping-up',
    name:     'RAM use has been climbing steadily',
    severity: 'info',
    evaluate() {
      // Compare last-2-minute avg vs older 5-minute avg. Increase > 1 GB = creeping.
      const now      = Date.now();
      const recent   = aggregateMetric('performance-monitor', 'mem_used_gb', 2 * 60_000);
      const baseline = aggregateMetric('performance-monitor', 'mem_used_gb', 5 * 60_000);
      if (!recent || !baseline) return null;
      const delta = recent.avg - baseline.avg;
      if (delta > 1.0) {
        return {
          message: `RAM use up ${delta.toFixed(2)} GB over the last few minutes (recent avg ${recent.avg.toFixed(1)} GB vs baseline ${baseline.avg.toFixed(1)} GB).`,
          evidence: { recent_avg: recent.avg, baseline_avg: baseline.avg, delta },
        };
      }
      return null;
    },
  },
];

// ── tick / loop ──────────────────────────────────────────────────────────────
function shouldTrip(ruleId) {
  const last = lastTrip.get(ruleId) || 0;
  return (Date.now() - last) > COOLDOWN_MS;
}

export function runOnce(emitConsole = false) {
  const tripped = [];
  for (const rule of RULES) {
    let outcome = null;
    try { outcome = rule.evaluate(); }
    catch (e) {
      console.warn(`[correlation-engine] rule "${rule.id}" threw:`, e.message);
      continue;
    }
    if (!outcome) continue;
    if (!shouldTrip(rule.id)) continue;
    lastTrip.set(rule.id, Date.now());

    recordMetric('correlation-engine', 'rule_tripped', 1, {
      rule_id:  rule.id,
      severity: rule.severity,
      message:  outcome.message.slice(0, 200),
    });
    tripped.push({ id: rule.id, severity: rule.severity, ...outcome });

    // ── Stage 8: behavioral remediation ────────────────────────────────────
    // Map specific rule trips to soft runtime actions (NO code edits).
    // Each action is time-bound (auto-expires) and recorded as a metric.
    try {
      const chSocial = process.env.CHANNEL_SUNDAY || '1500085302268526712';
      switch (rule.id) {
        case 'hallucination-spike': {
          requestExtraSystemPrompt(
            chSocial,
            'STRICT FACT MODE: Multiple hallucination markers were just detected in this chat. For your next reply, do NOT use phrases like "queried the lattice", "plugged into the lattice", "direct line to RSHL", "synaptic decay", "industrial-trash". Do NOT invent paper titles or "Author et al. YEAR" citations. If you do not actually know something, say so plainly.',
            10 * 60_000,
            'hallucination-spike'
          );
          // Optionally suppress the worst offender for 60s
          const speakers = outcome.evidence?.speakers || [];
          if (speakers.length === 1) {
            suppressBot(speakers[0], 60_000, 'hallucination-spike');
          }
          break;
        }
        case 'echo-chamber': {
          // Suppress both ping-pong participants briefly so others can step in
          const hist = getRecentHistory(chSocial);
          const lastTwo = [...new Set(hist.slice(-4).map(m => m.author).filter(Boolean))].slice(0, 2);
          for (const bot of lastTwo) suppressBot(bot, 90_000, 'echo-chamber');
          break;
        }
        case 'topic-stuck-hard': {
          requestExtraSystemPrompt(
            chSocial,
            'TOPIC PIVOT REQUIRED: The chat has been hammering one topic for many messages. For your next reply, INTRODUCE A NEW SUBJECT (your hobbies, what you did today, an unrelated observation, a question to a specific bot). Do not continue the previous thread.',
            5 * 60_000,
            'topic-stuck-hard'
          );
          break;
        }
        case 'echo-repetitive': {
          requestExtraSystemPrompt(
            chSocial,
            'ANTI-REPETITION: You are about to say something you or another bot already said. Re-think — bring something genuinely new or stay silent this turn.',
            5 * 60_000,
            'echo-repetitive'
          );
          break;
        }
        case 'social-chat-silent': {
          // Add a prompt that nudges any awake bot to start a topic
          requestExtraSystemPrompt(
            chSocial,
            'WAKE-UP: The chat has gone quiet. If you are the first to reply, OPEN A NEW TOPIC. Pick something from your bio (your hobbies, what you noticed today) — not a continuation of any prior thread.',
            3 * 60_000,
            'social-chat-silent'
          );
          break;
        }
      }
    } catch (e) {
      console.warn(`[correlation-engine] remediation for "${rule.id}" failed:`, e.message);
    }
    if (emitConsole) {
      const tag = rule.severity === 'error' ? '🚨' : rule.severity === 'warn' ? '⚠️ ' : 'ℹ️ ';
      console.log(`${tag} [correlation] ${rule.id}: ${outcome.message}`);
    }
  }
  return tripped;
}

let _interval = null;

export function startCorrelationEngine(opts = {}) {
  const { emitConsole = true, tickMs = TICK_MS } = opts;
  if (_interval) return; // already running
  console.log(`[correlation-engine] starting (tick=${tickMs / 1000}s, window=${WINDOW_MS / 1000}s, ${RULES.length} rules)`);
  _interval = setInterval(() => runOnce(emitConsole), tickMs);
}

export function stopCorrelationEngine() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

// Exported for tests / introspection
export function listRules() {
  return RULES.map(r => ({ id: r.id, name: r.name, severity: r.severity }));
}
