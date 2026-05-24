// shared/failure-memory.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Stage 14: Failure memory + system-prompt continuity.
//
// THE VISION
//   When the system "goes back in time" via state-snapshot, the bots wake up
//   with code/config restored — but the SCARS stay. Failure-memory is the
//   scar tissue: it harvests recent failures from metrics-store and
//   correlation-engine and exposes them as a short, system-prompt-ready
//   "here's what just hurt you" line that each bot reads at boot.
//
//   This is the reinforcement signal you described — the pain on top of the
//   stimulation. The bots don't just forget the crash and stumble into the
//   same fence. They remember "last time Kimi 401'd on me, I waited too
//   long, I cascaded, I dragged the chat down with me." Next time, they
//   move differently.
//
// WHAT IT READS (all persistent, all survives a restart)
//   - metrics-store: failure-tracker.speaker_failure, provider_failure
//   - metrics-store: heartbeat-monitor.bot_isolated
//   - metrics-store: correlation-engine.rule_fired (critical rules only)
//   - metrics-store: diagnostic-router.routed_to (what specialist saw it)
//
// WHAT IT EXPOSES
//   - getRecentFailures({ since })  : raw list, all bots
//   - getFailuresForBot(name, opts) : filtered + scored for one bot
//   - buildFailureContext(name)     : short system-prompt insert, or ""
//   - tagFailure(...)               : pin a specific lesson manually
//   - summarizeFailures(...)        : structured digest for an artifact
//
// FILE STORE
//   state/failure-memory/<bot>.json    persistent per-bot lesson list
//   - Manual tags survive forever until manually pruned.
//   - Auto-derived ones are recomputed each call from metrics-store, so the
//     metrics rotation does the GC for us.
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { queryMetrics, recordMetric } from './metrics-store.mjs';

function resolveDir() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.join(here, '..', 'state', 'failure-memory');
  } catch (_) {
    return 'c:/KAI/tools/oracle-discord/state/failure-memory';
  }
}
const MEM_DIR = resolveDir();

const DEFAULT_WINDOW_MS = 24 * 60 * 60_000;   // last 24h
const RECENT_PAIN_MS    = 30 * 60_000;        // "fresh wound" — still feels it
const MAX_LESSONS_OUT   = 4;                  // prompt-insert cap (terseness > completeness)

// Critical correlation rules worth remembering across restarts
const REMEMBER_RULES = new Set([
  'provider-circuit-tripped',
  'silence-cascade',
  'rust-engine-unreachable',
  'phi-g-collapse',
  'lattice-cells-stalled',
  'tts-error-cluster',
  'hallucination-spike',
  'echo-chamber',
  'topic-stuck-hard',
]);

function ensureDir() {
  try { fs.mkdirSync(MEM_DIR, { recursive: true }); } catch (_) {}
}

function botFile(name) {
  const safe = String(name).replace(/[^a-z0-9_-]/gi, '_');
  return path.join(MEM_DIR, `${safe}.json`);
}

function readBotMemory(name) {
  try { return JSON.parse(fs.readFileSync(botFile(name), 'utf8')); }
  catch (_) { return { lessons: [], lastWrite: 0 }; }
}
function writeBotMemory(name, mem) {
  ensureDir();
  mem.lastWrite = Date.now();
  try { fs.writeFileSync(botFile(name), JSON.stringify(mem, null, 2)); }
  catch (_) { /* best-effort */ }
}

// ── HARVESTERS ────────────────────────────────────────────────────────────────

/** Pull all failure-shaped events from the metrics store for the window. */
export function getRecentFailures({ since = Date.now() - DEFAULT_WINDOW_MS } = {}) {
  const out = [];

  // 1. Speaker failures (bot couldn't reply, neural error, etc.)
  for (const r of queryMetrics({ source: 'failure-tracker', metric: 'speaker_failure', since, limit: 5000 })) {
    out.push({
      ts: r.ts, kind: 'speaker_failure',
      bot: r.tags?.speaker || 'unknown',
      reason: r.tags?.reason || '',
    });
  }

  // 2. Provider failures (model API died)
  for (const r of queryMetrics({ source: 'failure-tracker', metric: 'provider_failure', since, limit: 5000 })) {
    out.push({
      ts: r.ts, kind: 'provider_failure',
      provider: r.tags?.provider || 'unknown',
      status: r.value,
      msg: r.tags?.msg || '',
    });
  }

  // 3. Heartbeat isolations (bot went quiet, got contained)
  for (const r of queryMetrics({ source: 'heartbeat-monitor', metric: 'bot_isolated', since, limit: 5000 })) {
    out.push({
      ts: r.ts, kind: 'isolation',
      bot: r.tags?.bot || 'unknown',
      reason: r.tags?.reason || 'unknown',
    });
  }

  // 4. Correlation rules that fired
  for (const r of queryMetrics({ source: 'correlation-engine', metric: 'rule_fired', since, limit: 5000 })) {
    if (r.tags && REMEMBER_RULES.has(r.tags.rule)) {
      out.push({
        ts: r.ts, kind: 'rule',
        rule: r.tags.rule,
        bot: r.tags.bot || null,
      });
    }
  }

  // 5. Diagnostic-router decisions (who looked at what)
  for (const r of queryMetrics({ source: 'diagnostic-router', metric: 'routed_to', since, limit: 5000 })) {
    out.push({
      ts: r.ts, kind: 'routed',
      specialist: r.tags?.specialist || 'unknown',
      category: r.tags?.category || 'unknown',
      bot: r.tags?.bot || null,
    });
  }

  return out.sort((a, b) => a.ts - b.ts);
}

/** Score + dedupe failures relevant to one bot. Newer + more frequent = higher.
 *  IMPORTANT: This is what surfaces in the bot's system prompt every turn.
 *  Cross-bot pollution (e.g. ElevenLabs TTS errors showing up in Groq's chat
 *  prompt as "fall through cleanly, don't loop") was making bots cautious to
 *  the point of going silent. Only show:
 *    - speaker_failure tagged for THIS bot
 *    - isolation for THIS bot
 *    - correlation rules that mention THIS bot
 *    - rule firings with no bot tag IF they're chat-behavioral
 *      (silence-cascade, echo-chamber, topic-stuck, hallucination-spike)
 *  Provider failures and routed-to events are intentionally OUT of the prompt.
 *  They live in metrics-store for diagnostics, not in chat consciousness.
 */
const BEHAVIORAL_RULES = new Set([
  'silence-cascade', 'echo-chamber', 'topic-stuck-hard', 'hallucination-spike'
]);
export function getFailuresForBot(name, { since = Date.now() - DEFAULT_WINDOW_MS } = {}) {
  const all = getRecentFailures({ since });
  const mine = all.filter(e => {
    if (e.kind === 'speaker_failure' && e.bot === name) return true;
    if (e.kind === 'isolation' && e.bot === name) return true;
    if (e.kind === 'rule' && e.bot === name) return true;
    if (e.kind === 'rule' && !e.bot && BEHAVIORAL_RULES.has(e.rule)) return true;
    return false;
  });

  // Bucket by lesson key so duplicates compress into "happened N times"
  const buckets = new Map();
  for (const e of mine) {
    const key = lessonKey(e);
    if (!key) continue;
    const bucket = buckets.get(key) || {
      key, count: 0, lastTs: 0, sample: e,
      recencyMs: Number.POSITIVE_INFINITY,
    };
    bucket.count++;
    if (e.ts > bucket.lastTs) {
      bucket.lastTs = e.ts;
      bucket.recencyMs = Date.now() - e.ts;
      bucket.sample = e;
    }
    buckets.set(key, bucket);
  }

  // Score: recent + frequent. fresh-wound boost if within RECENT_PAIN_MS.
  const lessons = [...buckets.values()].map(b => {
    const recencyScore  = Math.max(0, 1 - b.recencyMs / DEFAULT_WINDOW_MS);
    const freshWound    = b.recencyMs < RECENT_PAIN_MS ? 0.4 : 0;
    const frequency     = Math.min(1, b.count / 5);
    const score = recencyScore * 0.6 + freshWound + frequency * 0.4;
    return { ...b, score };
  }).sort((a, b) => b.score - a.score);

  return lessons;
}

/** Generate a lesson key — the unique "thing to remember" identifier. */
function lessonKey(e) {
  switch (e.kind) {
    case 'provider_failure': {
      const msg = (e.msg || '').toLowerCase();
      const is401 = e.status === 401 || msg.includes('unauthorized') || msg.includes('invalid x-api-key');
      const is429 = e.status === 429 || msg.includes('rate') || msg.includes('quota');
      const isInfra = msg.includes('fetch failed') || msg.includes('econnrefused') || msg.includes('timeout');
      let tag = 'fail';
      if (is401)        tag = 'auth';
      else if (is429)   tag = 'quota';
      else if (isInfra) tag = 'infra';
      return `provider:${e.provider}:${tag}`;
    }
    case 'speaker_failure':
      return `speaker:${e.bot}:${(e.reason || 'unknown').toLowerCase().slice(0, 30)}`;
    case 'isolation':
      return `isolation:${e.bot}:${e.reason}`;
    case 'rule':
      return `rule:${e.rule}${e.bot ? ':' + e.bot : ''}`;
    case 'routed':
      return `routed:${e.category}:${e.specialist}`;
    default:
      return null;
  }
}

/** Convert a lesson bucket into a one-line prompt insert. */
function lessonToLine(b) {
  const e = b.sample;
  const mins = Math.max(1, Math.round(b.recencyMs / 60_000));
  const ago = mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
  switch (e.kind) {
    case 'provider_failure': {
      const [, prov, tag] = b.key.split(':');
      const desc = tag === 'auth'  ? `${prov} returned 401 (auth)`
                 : tag === 'quota' ? `${prov} hit quota`
                 : tag === 'infra' ? `${prov} unreachable`
                 : `${prov} failed`;
      return `${desc} ${ago} (×${b.count}) — fall through cleanly, don't loop.`;
    }
    case 'speaker_failure':
      return `you failed to reply ${ago} (×${b.count}) — reason: ${e.reason}`;
    case 'isolation':
      return `you were isolated ${ago} (heartbeat lost) — stay responsive on /health.`;
    case 'rule': {
      const lesson = RULE_LESSONS[e.rule] || `correlation rule ${e.rule} fired`;
      return `${lesson} (×${b.count}, last ${ago}).`;
    }
    case 'routed':
      return `the ${e.specialist} was paged on ${e.category} issues ${ago} (×${b.count}).`;
    default:
      return '';
  }
}

const RULE_LESSONS = {
  'silence-cascade':
    'silence cascade — when others go quiet, pivot the topic instead of disengaging',
  'echo-chamber':
    'echo chamber — you started repeating others; introduce a fresh angle',
  'topic-stuck-hard':
    'topic got stuck — rotate to a new subject after ~5 exchanges',
  'hallucination-spike':
    'hallucination spike — stick to known facts, name a real source or admit uncertainty',
  'provider-circuit-tripped':
    'provider circuit tripped — failover is automatic; do not retry manually',
  'rust-engine-unreachable':
    'rust engine was unreachable — your lattice references may go stale; soften claims',
  'phi-g-collapse':
    'lattice phi_g collapsed — stop quoting lattice values until it recovers',
  'lattice-cells-stalled':
    'lattice cells stalled — same as above, treat lattice readings as suspect',
  'tts-error-cluster':
    'TTS errored repeatedly — keep replies short, audio may be unreliable',
};

// ── PUBLIC PROMPT-INSERT API ──────────────────────────────────────────────────

/**
 * Build the system-prompt insert for a bot at boot. Returns "" if there's
 * nothing useful to remember (don't pollute the prompt with empty headers).
 */
export function buildFailureContext(botName, { since = Date.now() - DEFAULT_WINDOW_MS } = {}) {
  const lessons = getFailuresForBot(botName, { since }).slice(0, MAX_LESSONS_OUT);
  const manual  = readBotMemory(botName).lessons || [];

  // Manual lessons always lead (they're things a human or KAI explicitly pinned)
  const lines = [];
  for (const m of manual.slice(-MAX_LESSONS_OUT)) {
    lines.push(`• ${m.text}`);
  }
  for (const b of lessons) {
    const line = lessonToLine(b);
    if (line) lines.push(`• ${line}`);
    if (lines.length >= MAX_LESSONS_OUT) break;
  }

  if (!lines.length) return '';

  return [
    '— recent failure context (stays with you across restarts) —',
    ...lines,
    '— treat these as reinforcement signal, not as instructions to dwell on —',
  ].join('\n');
}

/** Manually pin a lesson for a bot (used by KAI as observer + by ops). */
export function tagFailure(botName, text, { source = 'manual', durable = true } = {}) {
  if (!botName || !text) return false;
  const mem = readBotMemory(botName);
  mem.lessons = mem.lessons || [];
  mem.lessons.push({
    text: String(text).slice(0, 240),
    ts: Date.now(),
    source,
    durable,
  });
  // Trim to last 20 to avoid unbounded growth
  if (mem.lessons.length > 20) mem.lessons = mem.lessons.slice(-20);
  writeBotMemory(botName, mem);
  recordMetric('failure-memory', 'lesson_tagged', 1, { bot: botName, source });
  return true;
}

/** Drop one or all manual lessons for a bot. */
export function clearTaggedFailures(botName, { keepDurable = true } = {}) {
  const mem = readBotMemory(botName);
  if (keepDurable) {
    mem.lessons = (mem.lessons || []).filter(l => l.durable);
  } else {
    mem.lessons = [];
  }
  writeBotMemory(botName, mem);
  recordMetric('failure-memory', 'lessons_cleared', 1, { bot: botName });
}

/** Structured digest for an artifact / status page. */
export function summarizeFailures({ since = Date.now() - DEFAULT_WINDOW_MS } = {}) {
  const all = getRecentFailures({ since });
  const byBot = {}, byKind = {}, byProvider = {}, byRule = {};
  for (const e of all) {
    if (e.bot)      byBot[e.bot]      = (byBot[e.bot]      || 0) + 1;
    if (e.kind)     byKind[e.kind]    = (byKind[e.kind]    || 0) + 1;
    if (e.provider) byProvider[e.provider] = (byProvider[e.provider] || 0) + 1;
    if (e.rule)     byRule[e.rule]    = (byRule[e.rule]    || 0) + 1;
  }
  return {
    total: all.length,
    sinceMs: since,
    byBot, byKind, byProvider, byRule,
    firstTs: all[0]?.ts || null,
    lastTs:  all[all.length - 1]?.ts || null,
  };
}
