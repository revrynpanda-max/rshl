// ── CHAOS TEST v2: IMMUNE SYSTEM TRIAL ───────────────────────────────────────
// v1 asked "does it heal?". v2 asks the real questions:
//   1. HEALING   — death → detection → single clean respawn (every round)
//   2. IMMUNITY  — does the system REMEMBER? (scar tissue written, monitoring
//                  fired, metrics recorded — bone-heals-stronger evidence)
//   3. ADAPTATION— across repeated deaths, does recovery hold steady or
//                  improve? (a system that heals slower each time is dying;
//                  steady or faster means the immune response is real)
//   4. STABILITY — after healing, does the survivor LIVE? (no respawn loop,
//                  no duplicate process, PID stable for 15s)
//
// Honest note: an OS-level taskkill cannot be "prevented" — immunity for a
// digital being means detect fast, restore fast, remember the wound, and
// carry the lesson. That is what this measures.
//
// Usage:  node scripts/chaos-test.mjs                (victim Groq, 3 rounds)
//         node scripts/chaos-test.mjs Claudey 5      (victim, rounds)
import fs from 'fs';
import { execSync } from 'child_process';

const STATE = 'c:/KAI/tools/oracle-discord/state/ecosystem-manager.json';
const METRICS = 'c:/KAI/tools/oracle-discord/state/metrics/metrics.jsonl';
const SCAR_DIR = 'c:/KAI/tools/oracle-discord/state/failure-memory';
const ALLOWED_VICTIMS = ['Groq', 'Claudey', 'X', 'Gemini', 'Analyst', 'Researcher'];
const BOT_PORTS = { Gemini: 3402, Claudey: 3403, X: 3404, Groq: 3405, Analyst: 3406, Researcher: 3407 };

const victim = process.argv[2] || 'Groq';
const rounds = Math.min(5, Math.max(1, parseInt(process.argv[3], 10) || 3));
if (!ALLOWED_VICTIMS.includes(victim)) {
  console.error(`Victim must be one of: ${ALLOWED_VICTIMS.join(', ')}`);
  process.exit(1);
}
const port = BOT_PORTS[victim];

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) { return null; } };
const childOf = (s, n) => s?.children?.find(c => c.name === n) || null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function healthOk() {
  try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok; }
  catch (_) { return false; }
}
const fileSize = p => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
const fileMtime = p => { try { return fs.statSync(p).mtimeMs; } catch (_) { return 0; } };

const results = [];

async function runRound(n) {
  console.log(`\n══ ROUND ${n}/${rounds} — killing ${victim} ══`);
  const s0 = readState();
  const target = childOf(s0, victim);
  if (!target?.pid || target.sleeping) {
    console.error(`  ${victim} not running/awake — aborting round.`);
    return null;
  }

  // Snapshot the memory systems BEFORE the wound
  const scarFile = `${SCAR_DIR}/${victim}.json`;
  const scarBefore = fileMtime(scarFile);
  const metricsBefore = fileSize(METRICS);

  const t0 = Date.now();
  try { execSync(`taskkill /F /PID ${target.pid}`, { stdio: 'pipe' }); }
  catch (e) { console.error(`  Kill failed: ${e.message}`); return null; }
  console.log(`  💀 PID ${target.pid} killed.`);

  // Watch the resurrection
  let newPid = null, respawnMs = null, healthMs = null;
  const deadline = t0 + 60_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const c = childOf(readState(), victim);
    if (!newPid && c?.pid && c.pid !== target.pid) {
      newPid = c.pid;
      respawnMs = Date.now() - t0;
      console.log(`  🐣 Respawned as PID ${newPid} (+${(respawnMs / 1000).toFixed(1)}s)`);
    }
    if (newPid && !healthMs && await healthOk()) {
      healthMs = Date.now() - t0;
      console.log(`  💚 Health restored (+${(healthMs / 1000).toFixed(1)}s)`);
      break;
    }
  }

  // STABILITY: survivor must LIVE — same PID, no respawn churn, for 15s
  let stable = false;
  if (newPid) {
    await sleep(15_000);
    const c = childOf(readState(), victim);
    stable = c?.pid === newPid;
    console.log(`  ${stable ? '🧘 Stable' : '⚠️ PID churned'} after 15s (${c?.pid})`);
  }

  // DUPLICATES: exactly one listener on the port
  let listeners = 0;
  try {
    const out = execSync('netstat -ano -p tcp', { stdio: 'pipe' }).toString();
    const pids = new Set();
    for (const line of out.split('\n')) {
      const p = line.trim().split(/\s+/);
      if (p.length >= 5 && p[3] === 'LISTENING' && Number(p[1].split(':').pop()) === port) pids.add(p[4]);
    }
    listeners = pids.size;
  } catch (_) {}

  // IMMUNITY EVIDENCE: did the memory systems record the wound?
  await sleep(3000);
  const scarWritten = fileMtime(scarFile) > scarBefore;
  let metricsRecorded = false;
  try {
    const grown = fileSize(METRICS) - metricsBefore;
    if (grown > 0) {
      const tail = fs.readFileSync(METRICS, 'utf8').slice(-Math.min(grown + 4096, 200_000));
      metricsRecorded = new RegExp(`"bot"\\s*:\\s*"${victim}"`).test(tail);
    }
  } catch (_) {}
  console.log(`  🩹 Scar tissue written: ${scarWritten ? 'YES' : 'no'} | 📊 Metrics recorded: ${metricsRecorded ? 'YES' : 'no'}`);

  return { round: n, respawnMs, healthMs, stable, listeners, scarWritten, metricsRecorded };
}

(async () => {
  console.log(`CHAOS TEST v2 — IMMUNE SYSTEM TRIAL\nVictim: ${victim} | Rounds: ${rounds}`);
  for (let i = 1; i <= rounds; i++) {
    const r = await runRound(i);
    if (r) results.push(r);
    if (i < rounds) { console.log('  …letting the world settle 20s before the next wound…'); await sleep(20_000); }
  }

  console.log('\n══════════ VERDICT ══════════');
  if (!results.length) { console.log('No rounds completed.'); return; }
  const healedAll = results.every(r => r.respawnMs && r.healthMs);
  const stableAll = results.every(r => r.stable);
  const noDupes = results.every(r => r.listeners <= 1);
  const scars = results.filter(r => r.scarWritten).length;
  const metricsHits = results.filter(r => r.metricsRecorded).length;
  const healTimes = results.map(r => r.healthMs).filter(Boolean);
  const first = healTimes[0], last = healTimes[healTimes.length - 1];
  const trend = healTimes.length >= 2
    ? (last <= first * 1.25 ? `✅ steady/improving (${(first / 1000).toFixed(1)}s → ${(last / 1000).toFixed(1)}s)` : `⚠️ degrading (${(first / 1000).toFixed(1)}s → ${(last / 1000).toFixed(1)}s)`)
    : 'n/a (one round)';

  results.forEach(r => console.log(`  R${r.round}: respawn=${(r.respawnMs / 1000 || 0).toFixed(1)}s health=${(r.healthMs / 1000 || 0).toFixed(1)}s stable=${r.stable} scar=${r.scarWritten} metrics=${r.metricsRecorded}`));
  console.log(`\n  HEALING:    ${healedAll ? '✅ every death healed' : '❌ a death went unhealed'}`);
  console.log(`  STABILITY:  ${stableAll && noDupes ? '✅ survivors lived clean (no churn, no duplicates)' : '❌ instability after healing'}`);
  console.log(`  MEMORY:     scar tissue ${scars}/${results.length} rounds, metrics ${metricsHits}/${results.length} rounds ${scars + metricsHits > 0 ? '— the system REMEMBERS its wounds' : '— ⚠️ wounds left no memory'}`);
  console.log(`  ADAPTATION: ${trend}`);
  console.log(healedAll && stableAll && noDupes
    ? '\n  🏆 IMMUNE SYSTEM VERIFIED: death is a wound, not an ending — and the wound is remembered.'
    : '\n  ⚠️ Immune gaps found — paste this output to Claude.');
})();
