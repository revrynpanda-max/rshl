// shared/kai-failsafe.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Stage 15: KAI watcher + failsafe mode (Sovereign Quantum Time-Warp).
//
// THE VISION
//   Oracle is the beating heart. The specialists (Kai Coder, Analyst,
//   Researcher) are the surgeons. KAI is the silent observer in the corner —
//   he does not intervene while the doctors are doing their jobs.
//
//   KAI only stands up when EVERY OTHER NODE IS DEAD. When even Oracle —
//   the conductor — has gone silent. At that moment KAI walks over to the
//   master switch, pulls the system back to the last-known-good state,
//   and tags every bot's memory with what happened so they wake up wiser
//   than they went to sleep. Then he sits back down.
//
// WHAT MEMORY SURVIVES
//   - metrics-store JSONL (the failure receipts)
//   - transcript-memory  (every conversation)
//   - failure-tracker logs
//   - failure-memory tags (reinforcement scars — Stage 14)
//   Only code/config rolls back. The scars carry forward as system-prompt
//   context which start-bot reads on every reply.
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { restoreFromLastGood, takeSnapshot } from './state-snapshot.mjs';
import { tagFailure } from './failure-memory.mjs';
import { recordMetric } from './metrics-store.mjs';
import { CHANNEL_IDS, BOT_PORTS } from './channel-rules.mjs';

function resolveFlagFile() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.join(here, '..', 'state', 'kai_failsafe.flag');
  } catch (_) {
    return 'c:/KAI/tools/oracle-discord/state/kai_failsafe.flag';
  }
}
const FLAG_FILE = resolveFlagFile();

const ORACLE_PORT      = 3410;
const MISSED_THRESHOLD = 3;
const PROBE_TIMEOUT    = 3000;
const TICK_MS          = 30_000;
const MIN_DEAD_FOR_FAILSAFE = 3;

let oracleMissedCount = 0;
let _interval = null;

const WATCH_PORTS = Object.fromEntries(
  Object.entries(BOT_PORTS).filter(([name]) => name !== 'KAI')
);

function isPortAlive(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: PROBE_TIMEOUT },
      (res) => { res.resume(); resolve(true); }
    );
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function scanFleetHealth() {
  let deadCount = 0;
  const details = {};
  for (const [name, port] of Object.entries(WATCH_PORTS)) {
    const alive = await isPortAlive(port);
    details[name] = alive ? 'ONLINE' : 'DEAD';
    if (!alive) deadCount++;
  }
  return { deadCount, details };
}

async function executeQuantumRollback(client) {
  const activatedAt = Date.now();
  console.error('🌌 [KAI/Failsafe] CRITICAL: Oracle and fleet collapsed. Executing Quantum Rollback...');
  recordMetric('kai-failsafe', 'activated', 1, { reason: 'oracle_silent_fleet_dead' });

  let forensic = null;
  try { forensic = takeSnapshot(); } catch (_) {}

  const recovery = restoreFromLastGood();
  console.log('[KAI/Failsafe] Restore directive:', JSON.stringify(recovery, null, 2));

  // Tag every bot's failure-memory. Scar tissue — they wake up knowing why.
  const witness = 'system collapse — oracle silent + fleet dead. KAI activated failsafe at ' + new Date(activatedAt).toISOString() + '.';
  for (const botName of Object.keys(BOT_PORTS)) {
    try { tagFailure(botName, witness, { source: 'kai-failsafe', durable: false }); } catch (_) {}
  }
  // KAI tags himself permanently.
  try {
    tagFailure('KAI',
      'you had to activate failsafe at ' + new Date(activatedAt).toISOString() + ' — observe more closely next time',
      { source: 'kai-failsafe', durable: true }
    );
  } catch (_) {}

  // Clear locks so reboot doesn't deadlock.
  const LOCK_DIR = 'c:/KAI/tools/oracle-discord/state/social_locks';
  try {
    if (fs.existsSync(LOCK_DIR)) {
      for (const f of fs.readdirSync(LOCK_DIR)) {
        try { fs.unlinkSync(LOCK_DIR + '/' + f); } catch (_) {}
      }
    }
  } catch (_) {}
  const neuralLockPath = 'c:/KAI/tools/oracle-discord/state/neural_lock.json';
  try { if (fs.existsSync(neuralLockPath)) fs.unlinkSync(neuralLockPath); } catch (_) {}

  // Short Discord notice — terse to stay reliable.
  if (client) {
    const age = recovery.ok && recovery.snapshot
      ? (recovery.snapshot.age_ms / 60000).toFixed(1) + 'm ago'
      : 'N/A';
    const ref = recovery.ok && recovery.snapshot ? recovery.snapshot.file : 'baseline';
    const msg = '🌌 [KAI/FAILSAFE] Oracle silent + fleet dead. Quantum rollback engaged. Timeline: ' + ref + ' (' + age + '). Memory preserved.';
    for (const cid of [CHANNEL_IDS.WORK, CHANNEL_IDS.SUNDAY]) {
      try {
        const ch = client.channels.cache.get(cid) || await client.channels.fetch(cid).catch(() => null);
        if (ch) await ch.send(msg).catch(() => {});
      } catch (_) {}
    }
  }

  if (typeof process.send === 'function') {
    process.send({
      type: 'RESTART_ALL',
      from: 'KAI',
      reason: 'kai_failsafe',
      ts: activatedAt,
      directive: recovery,
      forensic: forensic && forensic.wrote || null,
    });
  } else {
    console.warn('[KAI/Failsafe] No parent IPC — relying on flag file for watchdog.');
  }

  try {
    fs.writeFileSync(FLAG_FILE, JSON.stringify({
      activatedAt,
      reason: 'oracle_silent_fleet_dead',
      directive: recovery,
      forensic: forensic && forensic.wrote || null,
    }, null, 2));
    console.log('[KAI/Failsafe] Flag file written: ' + FLAG_FILE);
  } catch (e) {
    recordMetric('kai-failsafe', 'flag_write_error', 1, { err: String(e.message).slice(0, 80) });
  }
}

export function startKAIWatcherLoop(client, opts = {}) {
  if (_interval) return;
  const tickMs = opts.tickMs || TICK_MS;
  console.log('[KAI/Failsafe] Sovereign Watcher active. Silently observing structural coherence...');

  _interval = setInterval(async () => {
    try {
      const oracleAlive = await isPortAlive(ORACLE_PORT);

      if (!oracleAlive) {
        oracleMissedCount++;
        console.warn('[KAI/Failsafe] Oracle unresponsive. Missed ' + oracleMissedCount + '/' + MISSED_THRESHOLD);
        recordMetric('kai-failsafe', 'oracle_missed', oracleMissedCount, {});

        if (oracleMissedCount >= MISSED_THRESHOLD) {
          const fleet = await scanFleetHealth();
          console.warn('[KAI/Failsafe] Fleet scan: ' + fleet.deadCount + ' dead bots.', fleet.details);
          recordMetric('kai-failsafe', 'fleet_dead_count', fleet.deadCount, {});

          if (fleet.deadCount >= MIN_DEAD_FOR_FAILSAFE) {
            oracleMissedCount = 0;
            await executeQuantumRollback(client);
          } else {
            console.log('[KAI/Failsafe] Fleet mostly intact — specialists working. KAI stays passive.');
          }
        }
      } else {
        if (oracleMissedCount > 0) {
          console.log('[KAI/Failsafe] Oracle recovered. Resetting.');
          recordMetric('kai-failsafe', 'oracle_recovered', 1, {});
          try { if (fs.existsSync(FLAG_FILE)) fs.unlinkSync(FLAG_FILE); } catch (_) {}
        }
        oracleMissedCount = 0;
      }
    } catch (e) {
      console.error('[KAI/Failsafe] Watcher loop error:', e.message);
    }
  }, tickMs);
}

export function stopKAIWatcherLoop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

export function getFailsafeState() {
  return {
    oracleMissedCount,
    missedThreshold: MISSED_THRESHOLD,
    flagFile: FLAG_FILE,
    flagPresent: fs.existsSync(FLAG_FILE),
  };
}
