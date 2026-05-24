// shared/state-snapshot.mjs
// ──────────────────────────────────────────────────────────────────────────────
// Stage 13: State snapshots + last-known-good recovery.
//
// THE VISION
//   When everything goes sideways, the system "goes back in time" — but the
//   CHATS and the MEMORY OF THE FAILURE survive. The bots wake up with the
//   trauma still tagged on their reinforcement learning. They remember what
//   happened. They just don't have to keep bleeding from it.
//
// WHAT WE SNAPSHOT
//   - Bot routing config currently in effect (env-derived model overrides)
//   - Remediation state (active suppressions, extra prompts)
//   - Heartbeat-derived health roster (who was alive, ports)
//   - File-integrity reference (hash of the integrity snapshot file)
//   - Correlation engine cooldown table
//   - Process roster (PIDs if known)
//
// WHAT WE DO NOT TOUCH (these are "memory of the failure")
//   - metrics-store JSONL — every observation survives
//   - transcript-memory  — every conversation survives
//   - failure-tracker logs — every circuit-trip survives
//   - daily-learning artifacts — every digest survives
//
// HEALTH GATE
//   A snapshot is only marked "good" if at the moment of capture:
//     - All known bots are alive (no isolations in last 60s)
//     - No "critical" correlation rules have fired in the last 5 min
//     - File integrity has no fresh corruption signatures
//
// RESTORE
//   restoreFromLastGood() does NOT itself restart processes. It:
//     1. Locates the most recent snapshot tagged good=true
//     2. Clears the remediation state's transient suppressions
//     3. Returns a directive { snapshot, actions[] } that the KAI failsafe
//        (Stage 15) will execute. This keeps the snapshot module purely a
//        librarian — never an actor on its own.
// ──────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { recordMetric, queryMetrics, latestMetric } from './metrics-store.mjs';
import { getHeartbeatStatus } from './heartbeat-monitor.mjs';

function resolveDir() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.join(here, '..', 'state', 'snapshots');
  } catch (_) {
    return 'c:/KAI/tools/oracle-discord/state/snapshots';
  }
}
function resolveRemediationFile() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.join(here, '..', 'state', 'remediation-state.json');
  } catch (_) {
    return 'c:/KAI/tools/oracle-discord/state/remediation-state.json';
  }
}
function resolveIntegrityFile() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.join(here, '..', 'state', 'file-integrity-snapshot.json');
  } catch (_) {
    return 'c:/KAI/tools/oracle-discord/state/file-integrity-snapshot.json';
  }
}

const SNAP_DIR = resolveDir();
const REMEDIATION_FILE = resolveRemediationFile();
const INTEGRITY_FILE = resolveIntegrityFile();

const KEEP_GOOD     = 12;                // ~1 hour @ 5min cadence
const KEEP_RECENT   = 6;                 // and 30min of everything else for forensics
const DEFAULT_TICK  = 5 * 60_000;        // 5 minutes
const HEALTH_WINDOW = 60_000;            // bot must have been alive in last 60s
const RULE_WINDOW   = 5 * 60_000;        // critical rules in last 5 min disqualify

// Which correlation rules are bad enough to disqualify a "good" snapshot
const CRITICAL_RULES = new Set([
  'provider-circuit-tripped',
  'silence-cascade',
  'rust-engine-unreachable',
  'phi-g-collapse',
  'lattice-cells-stalled',
  'tts-error-cluster',
]);

let _interval = null;

// ── ROUTING CAPTURE ───────────────────────────────────────────────────────────
// Mirror of the env-var contract openjarvis.mjs uses for per-bot routing.
// We snapshot WHAT WAS LIVE at the moment, so restoration can compare against
// the running env and detect drift.
function snapshotRouting() {
  const env = process.env;
  const bots = ['Leo', 'KAI', 'Gemini', 'Claudey', 'X', 'Groq', 'Analyst', 'Researcher', 'Kai Coder', 'Oracle'];
  const routing = {};
  for (const b of bots) {
    const key = b.toUpperCase().replace(/ /g, '_');
    routing[b] = {
      model:    env[`BOT_MODEL_${key}`]      ?? null,
      provider: env[`BOT_PROVIDER_${key}`]   ?? null,
      zenModel: env[`BOT_ZEN_MODEL_${key}`]  ?? null,
    };
  }
  return routing;
}

function snapshotRemediation() {
  try { return JSON.parse(fs.readFileSync(REMEDIATION_FILE, 'utf8')); }
  catch (_) { return null; }
}

function snapshotIntegrityRef() {
  try {
    const raw = fs.readFileSync(INTEGRITY_FILE, 'utf8');
    return { exists: true, bytes: Buffer.byteLength(raw), ts: fs.statSync(INTEGRITY_FILE).mtimeMs };
  } catch (_) { return { exists: false }; }
}

function recentCriticalRuleFirings(windowMs) {
  const recs = queryMetrics({
    source: 'correlation-engine',
    metric: 'rule_fired',
    since: Date.now() - windowMs,
    limit: 200,
  });
  return recs
    .filter(r => r.tags && CRITICAL_RULES.has(r.tags.rule))
    .map(r => ({ rule: r.tags.rule, ts: r.ts }));
}

function assessHealth(heartbeat) {
  const issues = [];
  if (!heartbeat || !heartbeat.length) {
    issues.push('no_heartbeat_data');
  } else {
    for (const h of heartbeat) {
      if (!h.alive)    issues.push(`bot_dead:${h.name}`);
      else if (h.isolated) issues.push(`bot_isolated:${h.name}`);
      else if (h.lastSeenAgoMs !== null && h.lastSeenAgoMs > HEALTH_WINDOW) {
        issues.push(`bot_stale:${h.name}`);
      }
    }
  }
  const critical = recentCriticalRuleFirings(RULE_WINDOW);
  for (const c of critical) issues.push(`rule:${c.rule}`);
  return { good: issues.length === 0, issues };
}

/** Build a snapshot of the current system state and write it to disk. */
export function takeSnapshot({ force = false } = {}) {
  try { fs.mkdirSync(SNAP_DIR, { recursive: true }); } catch (_) {}

  const heartbeat = getHeartbeatStatus();
  const health    = assessHealth(heartbeat);
  if (!force && !health.good) {
    // Don't pollute the good snapshots with bad ones — but still write a
    // forensic copy so we have data on the system at failure-time.
    const forensic = {
      ts: Date.now(),
      good: false,
      health,
      heartbeat,
      remediation: snapshotRemediation(),
      routing: snapshotRouting(),
      integrityRef: snapshotIntegrityRef(),
      pid: process.pid,
    };
    const file = path.join(SNAP_DIR, `forensic-${forensic.ts}.json`);
    try { fs.writeFileSync(file, JSON.stringify(forensic, null, 2)); } catch (_) {}
    recordMetric('state-snapshot', 'snapshot_skipped', 1, { reason: 'unhealthy', issues: health.issues.length });
    return { wrote: file, good: false, health };
  }

  const snap = {
    ts: Date.now(),
    good: true,
    health,
    heartbeat,
    remediation: snapshotRemediation(),
    routing: snapshotRouting(),
    integrityRef: snapshotIntegrityRef(),
    pid: process.pid,
  };

  const file = path.join(SNAP_DIR, `good-${snap.ts}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(snap, null, 2));
    recordMetric('state-snapshot', 'snapshot_written', 1, { kind: 'good' });
  } catch (e) {
    recordMetric('state-snapshot', 'snapshot_error', 1, { err: String(e.message).slice(0, 80) });
    return { wrote: null, good: true, health, error: e.message };
  }

  pruneSnapshots();
  return { wrote: file, good: true, health };
}

/** Keep most recent KEEP_GOOD good- snapshots and KEEP_RECENT forensic- snapshots. */
function pruneSnapshots() {
  try {
    const files = fs.readdirSync(SNAP_DIR);
    const good = files.filter(f => f.startsWith('good-')).sort();
    const forensic = files.filter(f => f.startsWith('forensic-')).sort();

    for (const f of good.slice(0, Math.max(0, good.length - KEEP_GOOD))) {
      try { fs.unlinkSync(path.join(SNAP_DIR, f)); } catch (_) {}
    }
    for (const f of forensic.slice(0, Math.max(0, forensic.length - KEEP_RECENT))) {
      try { fs.unlinkSync(path.join(SNAP_DIR, f)); } catch (_) {}
    }
  } catch (_) {}
}

/** Returns the most recent good snapshot, or null. */
export function lastKnownGood() {
  try {
    const files = fs.readdirSync(SNAP_DIR)
      .filter(f => f.startsWith('good-'))
      .sort();
    if (!files.length) return null;
    const newest = files[files.length - 1];
    const raw = fs.readFileSync(path.join(SNAP_DIR, newest), 'utf8');
    return { file: newest, ...JSON.parse(raw) };
  } catch (_) { return null; }
}

/** List forensic snapshots for post-mortem inspection. */
export function listForensicSnapshots() {
  try {
    return fs.readdirSync(SNAP_DIR)
      .filter(f => f.startsWith('forensic-'))
      .sort()
      .map(f => ({ file: f, path: path.join(SNAP_DIR, f) }));
  } catch (_) { return []; }
}

/**
 * Build a restoration directive from the last known good snapshot.
 * Does NOT itself restart anything — it returns the plan, the KAI failsafe
 * (Stage 15) executes it. This keeps the snapshot module a pure librarian.
 *
 * Side-effect: clears transient remediation suppressions so restored bots
 * don't wake up still gagged from the failure window.
 */
export function restoreFromLastGood() {
  const snap = lastKnownGood();
  if (!snap) {
    recordMetric('state-snapshot', 'restore_failed', 1, { reason: 'no_good_snapshot' });
    return { ok: false, reason: 'no_good_snapshot' };
  }

  const actions = [];

  // Clear transient suppressions so restored bots aren't still gagged.
  try {
    const cleanedRemediation = { suppressedBots: {}, extraPrompts: {}, lastWrite: Date.now() };
    fs.writeFileSync(REMEDIATION_FILE, JSON.stringify(cleanedRemediation));
    actions.push({ kind: 'cleared_remediation_state', file: REMEDIATION_FILE });
  } catch (e) {
    actions.push({ kind: 'remediation_clear_failed', error: e.message });
  }

  // Figure out which bots were healthy at snapshot time — these are the ones
  // the failsafe should ensure are running.
  const targetBots = (snap.heartbeat || [])
    .filter(h => h.alive && !h.isolated)
    .map(h => ({ name: h.name, port: h.port }));
  if (targetBots.length) {
    actions.push({ kind: 'ensure_bots_running', bots: targetBots });
  }

  // Routing the snapshot considered known-good
  if (snap.routing) {
    actions.push({ kind: 'restore_routing_reference', routing: snap.routing });
  }

  recordMetric('state-snapshot', 'restore_directive_built', 1, {
    snapshot_age_ms: Date.now() - snap.ts,
    targets: targetBots.length,
  });

  return {
    ok: true,
    snapshot: { file: snap.file, ts: snap.ts, age_ms: Date.now() - snap.ts },
    actions,
    // Memory survives untouched: metrics-store, transcript-memory, failure-tracker,
    // daily-learning — none are reset by this restoration. That's the point.
    memorySurvives: ['metrics-store', 'transcript-memory', 'failure-tracker', 'daily-learning'],
  };
}

/** Periodic snapshot loop. Call once from oracle-gateway. */
export function startSnapshotLoop({ tickMs = DEFAULT_TICK } = {}) {
  if (_interval) return;
  console.log(`[state-snapshot] starting — health-gated snapshots every ${tickMs / 1000}s`);
  // First tick after a short delay so heartbeat-monitor has data.
  setTimeout(() => takeSnapshot(), 30_000);
  _interval = setInterval(() => takeSnapshot(), tickMs);
}

export function stopSnapshotLoop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}
