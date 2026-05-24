// shared/diagnostic-router.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Stage 12: diagnostic router — surgical question routing.
//
// When something fails (Oracle's heartbeat-monitor flags a bot dead, or a
// correlation rule trips), this module decides:
//   - WHICH industrial AI is the right specialist to consult, and
//   - WHAT directive to send them, given recent metrics.
//
// The mapping is intentionally explicit (not LLM-driven) — Oracle's job is
// CONTAINMENT + ROUTING. Free thought belongs in the specialist's reply.
//
// Specialists:
//   Kai Coder    code-side bugs (TTS path, IPC handlers, file I/O)
//   Analyst      system-level / structural / lattice-coherence problems
//   Researcher   citation / topic / external-knowledge issues
//   Sentinel     provider / circuit-breaker / API health
//   KAI (passive) every directive is also copied to KAI's observer log
// ──────────────────────────────────────────────────────────────────────────────

import { sendBotSignal } from './ipc.mjs';
import { recordMetric, queryMetrics } from './metrics-store.mjs';
import { BOT_PORTS, CHANNEL_IDS } from './channel-rules.mjs';

// ── Failure classification ───────────────────────────────────────────────────
function classifyFailure(evt) {
  // evt shape: { bot?, port?, reason, error?, ruleId?, evidence? }
  const reason = (evt.reason || '').toLowerCase();
  const error  = (evt.error  || '').toLowerCase();
  const rule   = (evt.ruleId || '').toLowerCase();

  // Provider / quota / auth issues → Sentinel
  if (/401|403|429|provider|moonshot|opencode|elevenlabs|quota|unauthorized/.test(reason + error + rule)) {
    return { specialist: 'Sentinel', category: 'provider' };
  }
  // Lattice / phi_g / cells / RSHL → Analyst
  if (/lattice|phi_g|cells|rshl|coherence|claim/.test(reason + error + rule)) {
    return { specialist: 'Analyst', category: 'lattice' };
  }
  // Hallucination / citation / topic → Researcher
  if (/hallucination|citation|kohlstedt|fabricat|topic-stuck/.test(reason + error + rule)) {
    return { specialist: 'Researcher', category: 'epistemic' };
  }
  // Bot death / IPC / network / TTS / voice → Kai Coder
  if (/heartbeat_lost|fetch failed|tts|voice|ipc|epipe|crash|network/.test(reason + error + rule)) {
    return { specialist: 'Kai Coder', category: 'runtime' };
  }
  // Default: send to Kai Coder for code-side investigation
  return { specialist: 'Kai Coder', category: 'general' };
}

// ── Recent metrics context (the questions Oracle pre-loads for the specialist) ─
function gatherContext(evt) {
  const since = Date.now() - 10 * 60_000;
  const ctx = {};
  if (evt.bot) {
    ctx.bot_status      = queryMetrics({ source: 'heartbeat-monitor', metric: 'bot_alive', tagMatch: { bot: evt.bot }, since, limit: 20 });
    ctx.bot_tts_status  = queryMetrics({ source: 'tts-engine',        metric: 'tts_status', tagMatch: { bot: evt.bot }, since, limit: 20 });
  }
  ctx.recent_failures   = queryMetrics({ source: 'failure-tracker',   metric: 'provider_failure',     since, limit: 20 });
  ctx.tripped_rules     = queryMetrics({ source: 'correlation-engine',metric: 'rule_tripped',         since, limit: 20 });
  ctx.gpu_recent        = queryMetrics({ source: 'performance-monitor',metric: 'gpu_pct',              since, limit: 5 });
  return ctx;
}

// ── Directive builder ────────────────────────────────────────────────────────
function buildDirective(evt, route, ctx) {
  const lines = [];
  lines.push(`[ORACLE/DIAGNOSTIC]  Routed to ${route.specialist}  (category: ${route.category})`);
  if (evt.bot)     lines.push(`Subject:           bot "${evt.bot}"`);
  lines.push(`Reason:            ${evt.reason || 'unspecified'}`);
  if (evt.error)   lines.push(`Original error:    ${String(evt.error).slice(0, 200)}`);
  if (evt.ruleId)  lines.push(`Tripped rule:      ${evt.ruleId}`);

  lines.push('');
  lines.push('Recent context (last 10 min):');
  if (ctx.bot_status?.length)
    lines.push(`  - bot_alive samples: ${ctx.bot_status.map(r => r.value).join(',')}`);
  if (ctx.bot_tts_status?.length) {
    const codes = {};
    for (const r of ctx.bot_tts_status) codes[r.value] = (codes[r.value] || 0) + 1;
    lines.push(`  - TTS status distribution: ${JSON.stringify(codes)}`);
  }
  if (ctx.recent_failures?.length) {
    const byP = {};
    for (const f of ctx.recent_failures) byP[f.tags?.provider || '?'] = (byP[f.tags?.provider || '?'] || 0) + 1;
    lines.push(`  - provider failures: ${JSON.stringify(byP)}`);
  }
  if (ctx.tripped_rules?.length) {
    const ruleIds = [...new Set(ctx.tripped_rules.map(r => r.tags?.rule_id).filter(Boolean))];
    lines.push(`  - other rules tripped recently: ${ruleIds.join(', ') || 'none'}`);
  }
  if (ctx.gpu_recent?.length) {
    const avg = ctx.gpu_recent.reduce((a, b) => a + b.value, 0) / ctx.gpu_recent.length;
    lines.push(`  - GPU% avg last few samples: ${avg.toFixed(0)}`);
  }

  lines.push('');
  // Specialist-specific question prompt
  if (route.specialist === 'Kai Coder')   lines.push('Question: Is this a code-side bug? Locate the failing module, propose a sandbox patch, do NOT auto-apply if blast-radius ≥ 10.');
  if (route.specialist === 'Analyst')     lines.push('Question: Is the lattice structurally healthy? Check coherence, cell growth, phi_g stability over the last hour.');
  if (route.specialist === 'Researcher')  lines.push('Question: Are bots fabricating sources? Identify the false claims, propose what should replace them.');
  if (route.specialist === 'Sentinel')    lines.push('Question: Is this a provider-side outage we should ride out, or a key/config issue we need to act on? Check streaks + cooldowns.');

  return lines.join('\n');
}

// ── Public API ───────────────────────────────────────────────────────────────
/**
 * Receive a failure event, classify, build directive, dispatch via IPC,
 * and emit a metric so the audit trail is complete.
 */
export async function routeDiagnostic(evt) {
  const route = classifyFailure(evt);
  const ctx   = gatherContext(evt);
  const directive = buildDirective(evt, route, ctx);

  recordMetric('diagnostic-router', 'diagnostic_routed', 1, {
    specialist: route.specialist,
    category:   route.category,
    subject:    evt.bot || evt.ruleId || 'unknown',
  });

  const port = BOT_PORTS[route.specialist];
  if (port) {
    await sendBotSignal(port, {
      channelId: CHANNEL_IDS?.WORK || null,
      type: 'DIAGNOSTIC_QUESTION',
      taskId: `DIAG-${(evt.bot || route.specialist).toUpperCase()}-${Date.now().toString().slice(-5)}`,
      silent: true,
      context: directive,
      route,
    });
    console.log(`[diagnostic-router] dispatched to ${route.specialist} (port ${port}): ${route.category}`);
  } else {
    console.warn(`[diagnostic-router] no port for ${route.specialist} — directive recorded but not dispatched`);
  }

  // Copy to KAI as observer (passive)
  const kaiPort = BOT_PORTS['KAI'];
  if (kaiPort) {
    sendBotSignal(kaiPort, {
      type: 'OBSERVE',
      observer: true,
      payload: { route, directive: directive.slice(0, 500) },
    }).catch(() => {});
  }

  return { route, directive };
}

export function classify(evt) { return classifyFailure(evt); }
