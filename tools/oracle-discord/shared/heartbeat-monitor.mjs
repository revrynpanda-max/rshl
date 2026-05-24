// shared/heartbeat-monitor.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Stage 11: Oracle's heartbeat monitor — the central nervous system.
//
// Oracle polls every bot's /health endpoint every 15s. When a bot misses 3
// consecutive beats, it's marked dead — auto-isolated (suppressed via
// remediation-state) so the chat keeps flowing around it, and a diagnostic
// task is dispatched to the diagnostic-router.
//
// Emits to the metrics store:
//   bot_alive          1 / 0   per (bot)
//   bot_uptime_ms      reported by the bot itself
//   bot_rss_mb         memory footprint
//   bot_isolated       1 / 0   when our containment fires
//
// This is the "Oracle as beating heart" layer: it doesn't try to FIX a dead
// bot. It contains and diagnoses. Recovery happens in a later stage (KAI
// failsafe or state-snapshot restore).
// ──────────────────────────────────────────────────────────────────────────────

import http from 'http';
import { recordMetric } from './metrics-store.mjs';
import { suppressBot } from './remediation-state.mjs';

const TICK_MS    = 15_000;
const TIMEOUT_MS = 3_000;
const MISSES_BEFORE_DEAD = 3;
const ISOLATE_DURATION_MS = 5 * 60_000;  // suppress for 5 min, re-evaluate

// Bot name -> { port, missedBeats, lastSeenTs, isolated }
const STATE = new Map();
let _interval = null;
let _onBotIsolated = null;        // optional callback for diagnostic dispatch

function probe(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: TIMEOUT_MS },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode });
          try { resolve({ ok: true, data: JSON.parse(body) }); }
          catch (_) { resolve({ ok: true, data: null }); }  // server up, just non-JSON
        });
      }
    );
    req.on('error',   () => resolve({ ok: false, err: 'unreachable' }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
    req.end();
  });
}

async function tickOne(name, port) {
  const r = await probe(port);
  const s = STATE.get(name);

  if (r.ok) {
    s.missedBeats = 0;
    s.lastSeenTs  = Date.now();
    recordMetric('heartbeat-monitor', 'bot_alive', 1, { bot: name });
    if (r.data) {
      if (typeof r.data.uptime_ms === 'number') recordMetric('heartbeat-monitor', 'bot_uptime_ms', r.data.uptime_ms, { bot: name });
      if (typeof r.data.rss_mb    === 'number') recordMetric('heartbeat-monitor', 'bot_rss_mb',    r.data.rss_mb,    { bot: name });
    }
    // If previously isolated and now responding again, lift isolation
    if (s.isolated) {
      s.isolated = false;
      recordMetric('heartbeat-monitor', 'bot_recovered', 1, { bot: name });
      console.log(`💚 [heartbeat-monitor] ${name} recovered — heartbeat restored after isolation`);
    }
    return;
  }

  s.missedBeats++;
  recordMetric('heartbeat-monitor', 'bot_alive', 0, { bot: name, missed: s.missedBeats });

  if (s.missedBeats >= MISSES_BEFORE_DEAD && !s.isolated) {
    s.isolated = true;
    suppressBot(name, ISOLATE_DURATION_MS, `heartbeat lost (${s.missedBeats} missed)`);
    recordMetric('heartbeat-monitor', 'bot_isolated', 1, { bot: name, reason: 'missed_heartbeat' });
    console.warn(`💔 [heartbeat-monitor] ${name} DEAD — ${s.missedBeats} consecutive missed beats. Isolated for ${ISOLATE_DURATION_MS / 1000}s.`);

    if (_onBotIsolated) {
      try { await _onBotIsolated({ bot: name, port, reason: 'heartbeat_lost', missedBeats: s.missedBeats }); }
      catch (e) { console.warn(`[heartbeat-monitor] onBotIsolated callback error:`, e.message); }
    }
  }
}

export function startHeartbeatMonitor(botPortMap, { tickMs = TICK_MS, onBotIsolated = null } = {}) {
  if (_interval) return;
  _onBotIsolated = onBotIsolated;

  for (const [name, port] of Object.entries(botPortMap)) {
    if (!STATE.has(name)) STATE.set(name, { port, missedBeats: 0, lastSeenTs: 0, isolated: false });
  }

  const tickAll = async () => {
    await Promise.all([...STATE.entries()].map(([name, s]) => tickOne(name, s.port)));
  };

  console.log(`[heartbeat-monitor] starting — polling ${STATE.size} bots every ${tickMs/1000}s`);
  tickAll();
  _interval = setInterval(tickAll, tickMs);
}

export function stopHeartbeatMonitor() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

/** Read-only snapshot of all known bots' health. */
export function getHeartbeatStatus() {
  return [...STATE.entries()].map(([name, s]) => ({
    name, port: s.port,
    alive: s.missedBeats < MISSES_BEFORE_DEAD,
    isolated: s.isolated,
    missedBeats: s.missedBeats,
    lastSeenAgoMs: s.lastSeenTs ? Date.now() - s.lastSeenTs : null,
  }));
}
