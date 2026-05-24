// shared/process-supervisor.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Stage 18: Surgical restart — closes the auto-repair loop.
//
// THE PROBLEM
//   kai-coder-agent writes a patch to disk and logs "Applied". But the live
//   bot is still running its CACHED ESM module from before the patch. The
//   fix exists on disk and in nobody's memory. The system only picks it up
//   when the bot crashes hard enough to be auto-respawned — which usually
//   means the original bug fires AGAIN first.
//
// WHAT THIS DOES
//   1. requestBotRestart(name, reason) — sends RESTART_BOT IPC to the
//      ecosystem-manager (the parent process). Manager kills+respawns just
//      that one PID. The rest of the fleet keeps running.
//   2. verifyBotHealth(name, timeoutMs) — after the restart, polls the
//      bot's /health endpoint until it answers, or the timeout fires.
//   3. healPath(filePath, opts) — figures out which bot owns the file and
//      runs steps 1 + 2 for it.
//
// HOW IT'S CALLED
//   kai-coder-agent.mjs after a successful auto-apply:
//     await healPath(filePath, { hintedBot, reason: 'auto-patch' });
//   The hint comes from the diagnostic-router's original failure context —
//   "Groq was the bot that failed, this patch is for Groq." When no hint
//   is available we infer from the file path. For shared/*.mjs files with
//   no hint we DON'T restart anyone — that's too broad. The patch stays
//   staged until the next natural restart picks it up.
//
// BONE-HEALS-STRONGER
//   Every healPath call emits metrics: heal_attempted, heal_succeeded,
//   heal_failed_verify. The healing-ledger (Stage 19) will read these.
// ──────────────────────────────────────────────────────────────────────────────

import http from 'http';
import path from 'path';
import { recordMetric } from './metrics-store.mjs';
import { BOT_PORTS } from './channel-rules.mjs';

const HEALTH_POLL_INTERVAL_MS = 1500;
const HEALTH_DEFAULT_TIMEOUT_MS = 30_000;
const HEALTH_PROBE_TIMEOUT_MS = 1500;

/**
 * Map a file path to the bot(s) that should be restarted when it changes.
 * Conservative: only returns names when the mapping is unambiguous.
 * Returns null when the file is too broad (shared/*) or unknown.
 */
export function botForFile(filePath) {
  if (!filePath) return null;
  const norm = String(filePath).replace(/\\/g, '/').toLowerCase();
  if (norm.endsWith('/bots/leo.mjs') || norm.endsWith('\\bots\\leo.mjs') || /[/\\]bots[/\\]leo\.mjs$/.test(norm)) return 'Leo';
  if (/[/\\]bots[/\\]kai\.mjs$/.test(norm)) return 'KAI';
  if (/[/\\]oracle-gateway\.mjs$/.test(norm)) return 'Oracle';
  // bots/start-bot.mjs is shared by all social bots — we can't pick one without a hint
  if (/[/\\]bots[/\\]start-bot\.mjs$/.test(norm)) return null;
  // shared/*.mjs is too broad to auto-restart on
  if (/[/\\]shared[/\\]/.test(norm)) return null;
  return null;
}

/**
 * Probe a bot's /health endpoint once. Returns true if it answered.
 */
function probeHealthOnce(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: HEALTH_PROBE_TIMEOUT_MS },
      (res) => { res.resume(); resolve(res.statusCode === 200); }
    );
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Poll a bot's /health endpoint until it answers or the timeout fires.
 * Returns { ok: boolean, waitedMs: number }.
 */
export async function verifyBotHealth(botName, timeoutMs = HEALTH_DEFAULT_TIMEOUT_MS) {
  const port = BOT_PORTS[botName];
  if (!port) return { ok: false, waitedMs: 0, reason: 'no_port_known' };
  const start = Date.now();
  // Give the manager a moment to kill the old process before we start probing
  await new Promise(r => setTimeout(r, 1500));
  while (Date.now() - start < timeoutMs) {
    if (await probeHealthOnce(port)) {
      const waited = Date.now() - start;
      recordMetric('process-supervisor', 'health_verified', waited, { bot: botName });
      return { ok: true, waitedMs: waited };
    }
    await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  recordMetric('process-supervisor', 'health_verify_timeout', timeoutMs, { bot: botName });
  return { ok: false, waitedMs: Date.now() - start, reason: 'timeout' };
}

/**
 * Send a RESTART_BOT IPC to the ecosystem-manager (our parent process).
 * Returns true if the message was queued, false if we have no IPC channel.
 */
export function requestBotRestart(botName, reason = 'auto-repair') {
  if (!botName) return false;
  if (typeof process.send !== 'function') {
    console.warn('[process-supervisor] No parent IPC — restart of ' + botName + ' cannot be requested.');
    recordMetric('process-supervisor', 'restart_request_no_ipc', 1, { bot: botName, reason: String(reason).slice(0, 60) });
    return false;
  }
  try {
    process.send({ type: 'RESTART_BOT', botName, reason: String(reason).slice(0, 80), ts: Date.now() });
    console.log('[process-supervisor] Restart requested: ' + botName + ' (' + reason + ')');
    recordMetric('process-supervisor', 'restart_requested', 1, { bot: botName, reason: String(reason).slice(0, 60) });
    return true;
  } catch (e) {
    console.warn('[process-supervisor] Restart IPC failed for ' + botName + ':', e.message);
    recordMetric('process-supervisor', 'restart_ipc_error', 1, { bot: botName, err: e.message.slice(0, 60) });
    return false;
  }
}

/**
 * Orchestrate: figure out the bot, request restart, verify health.
 * Returns { healed: bool, bot: string|null, waitedMs: number, reason: string }.
 * Emits heal_attempted / heal_succeeded / heal_failed_verify metrics.
 */
export async function healPath(filePath, opts = {}) {
  const { hintedBot = null, reason = 'auto-patch', verifyMs = HEALTH_DEFAULT_TIMEOUT_MS } = opts;
  const target = hintedBot || botForFile(filePath);
  if (!target) {
    recordMetric('process-supervisor', 'heal_skipped_no_target', 1, { file: String(filePath).slice(-80) });
    console.log('[process-supervisor] No clear bot target for ' + filePath + ' — patch staged, will activate on next restart.');
    return { healed: false, bot: null, waitedMs: 0, reason: 'no_target' };
  }
  recordMetric('process-supervisor', 'heal_attempted', 1, { bot: target, file: String(filePath).slice(-80) });
  const sent = requestBotRestart(target, reason);
  if (!sent) {
    return { healed: false, bot: target, waitedMs: 0, reason: 'restart_request_failed' };
  }
  const health = await verifyBotHealth(target, verifyMs);
  if (health.ok) {
    recordMetric('process-supervisor', 'heal_succeeded', health.waitedMs, { bot: target });
    console.log('[process-supervisor] HEALED ' + target + ' in ' + health.waitedMs + 'ms after patch.');
    return { healed: true, bot: target, waitedMs: health.waitedMs, reason: 'verified' };
  } else {
    recordMetric('process-supervisor', 'heal_failed_verify', 1, { bot: target, reason: health.reason });
    console.warn('[process-supervisor] FAILED to verify ' + target + ' after ' + health.waitedMs + 'ms — patch applied but bot is not responding.');
    return { healed: false, bot: target, waitedMs: health.waitedMs, reason: 'verify_' + health.reason };
  }
}
