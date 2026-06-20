import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { recordMetric } from './metrics-store.mjs';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export const TIERS = {
  NORMAL: 'NORMAL',
  REDUCED: 'REDUCED',
  PROTECT: 'PROTECT'
};

// ── DYNAMIC HOST CALIBRATION ────────────────────────────────────────────────
// KAI's body is whatever device hosts him — a gaming laptop, a 2009 dual-Xeon
// Mac Pro, or a datacenter node. Percentage gates (CPU/GPU/RAM %) are already
// device-relative; the MEMORY BUDGETS below are derived from the host's actual
// RAM at startup instead of being hard-coded for one machine:
//   - project budget (KAI's own footprint): reduce at 35% of total RAM,
//     protect at 45% — always leaving the majority for the OS and the human.
//   - free-memory floors: scale with total, with absolute minimums so tiny
//     hosts are never squeezed to zero.
// Override per-host without code changes via env:
//   KAI_MAX_PROJECT_MEM_MB / KAI_PROTECT_PROJECT_MEM_MB
const _totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
const _envNum = (k) => { const v = Number(process.env[k]); return Number.isFinite(v) && v > 0 ? v : null; };
const _calMaxProject = _envNum('KAI_MAX_PROJECT_MEM_MB') || Math.max(2048, Math.round(_totalMemMB * 0.35));
const _calProtectProject = _envNum('KAI_PROTECT_PROJECT_MEM_MB') || Math.max(3072, Math.round(_totalMemMB * 0.45));
const _calMinFree = Math.max(2048, Math.round(_totalMemMB * 0.12));
const _calProtectFree = Math.max(1536, Math.round(_totalMemMB * 0.07));

// Laptop / limited hardware detection (Codex §21.1 Host Covenant + §21.2 Resource Governor):
// Detect core count + RAM (reliable cross boot) + best-effort battery to run tighter baselines on laptops / low-power rigs.
// This prevents the brute-force full-throttle loops (ingestion, social pulses, tutoring, voice streaming, persistence)
// that slam the shared body (high RAM/CPU, heat, lag, "two people through one doorway") per the exact symptoms observed.
// Tighter = earlier REDUCED entry, larger deliberate pauses, more skips of non-urgent (ingestion/social replies), queue later.
// Voice (Leo) and critical (Oracle/KAI/Sentinel) prioritized. Scales up on better rigs.
// Battery query is async/lazy to avoid top-level ESM issues; cores+RAM give immediate laptop signal.
function detectLimitedHostSync() {
  const cores = os.cpus().length || 4;
  const ramGB = _totalMemMB / 1024;
  // KAI_FORCE_LIMITED=1 forces the tighter, RAM-protective baselines on hosts
  // that don't trip the auto-thresholds (e.g. a laptop with many logical cores
  // and >=20GB RAM, like the Ryzen 5 8645HS / 40GB rig). Set this overnight so
  // KAI backs off learning/ingest EARLY and the machine never reaches a bad point.
  const forced = process.env.KAI_FORCE_LIMITED === '1';
  const isLimited = forced || cores <= 6 || ramGB < 20;
  if (isLimited) {
    if (forced) console.log('[ResourceGovernor] KAI_FORCE_LIMITED=1 → forcing tighter RAM/CPU baselines (overnight-safe).');
    console.log(`[ResourceGovernor] LIMITED HOST DETECTED (laptop-aware per Codex §21.1/§21.2): cores=${cores} RAM=${ramGB.toFixed(1)}GB (battery check deferred) → tighter baseline (earlier throttle, longer pauses, non-urgent skip). Voice prioritized.`);
  }
  return { isLimited, cores, ramGB, batteryCheckPending: true };
}
const _hostLimits = detectLimitedHostSync();

// Async battery probe (called on first real snapshot) to refine limited status without blocking boot.
async function probeBatteryForLimits() {
  if (!_hostLimits.batteryCheckPending) return _hostLimits;
  try {
    const { stdout } = await execAsync('powershell -NoProfile -Command "Get-CimInstance Win32_Battery | Select-Object -First 1 BatteryStatus,EstimatedChargeRemaining | ConvertTo-Json -Compress"', { timeout: 3000, windowsHide: true });
    const trimmed = (stdout || '').trim();
    if (trimmed && trimmed !== 'null') {
      const b = JSON.parse(trimmed);
      const status = Number(b.BatteryStatus || 0);
      const pct = b.EstimatedChargeRemaining != null ? Number(b.EstimatedChargeRemaining) : null;
      const onBattery = status === 1 || (pct != null && pct < 92);
      if (onBattery) {
        _hostLimits.isLimited = true;
        _hostLimits.onBattery = true;
        _hostLimits.batteryPct = pct;
        console.log(`[ResourceGovernor] Battery confirmed limited (on-battery ${pct || '?'}%) — tightening further per Host Covenant.`);
      }
    }
  } catch (_) {}
  _hostLimits.batteryCheckPending = false;
  return _hostLimits;
}

console.log(`[ResourceGovernor] Host calibrated: ${(_totalMemMB / 1024).toFixed(0)}GB RAM, ${os.cpus().length} logical cores → project budget ${_calMaxProject}MB (reduce) / ${_calProtectProject}MB (protect), free floors ${_calMinFree}/${_calProtectFree}MB`);

export const BUDGET_PROFILES = {
  interactive: {
    name: 'interactive',
    // HARD CAPS (user-defined): CPU <= 75%, GPU <= 90%, RAM <= 85%.
    // Percentages are device-relative — they hold on any processor.
    // "reduced" kicks in early to PACE the fleet so usage stays steady
    // instead of spiking to the cap and stuttering.
    reducedCpu: 62,
    protectCpu: 75,
    reducedMem: 75,
    protectMem: 85,
    reducedGpu: 78,
    protectGpu: 90,
    maxProjectMemMB: _calMaxProject,
    protectProjectMemMB: _calProtectProject,
    minFreeMemMB: _calMinFree,
    protectFreeMemMB: _calProtectFree,
    reducedDrift: 70,
    protectDrift: 90,
    socialOverride: true
  },
  overnight: {
    name: 'overnight',
    reducedCpu: 75,
    protectCpu: 90,
    reducedMem: 78,
    protectMem: 92,
    reducedGpu: 75,
    protectGpu: 92,
    maxProjectMemMB: _calMaxProject,
    protectProjectMemMB: _calProtectProject,
    minFreeMemMB: _calMinFree,
    protectFreeMemMB: _calProtectFree,
    reducedDrift: 80,
    protectDrift: 95,
    socialOverride: false
  },
  'proof-run': {
    name: 'proof-run',
    reducedCpu: 65,
    protectCpu: 85,
    reducedMem: 72,
    protectMem: 86,
    reducedGpu: 70,
    protectGpu: 88,
    maxProjectMemMB: 7000,
    protectProjectMemMB: 9500,
    minFreeMemMB: 10000,
    protectFreeMemMB: 6000,
    reducedDrift: 75,
    protectDrift: 92,
    socialOverride: false
  }
};

export function getBudgetProfile(name = process.env.KAI_RESOURCE_PROFILE || process.env.RESOURCE_BUDGET_PROFILE || 'interactive') {
  return BUDGET_PROFILES[name] || BUDGET_PROFILES.interactive;
}

export const RESOURCE_SPOTS = {
  Sentinel:   { priority: 100, reserveCpu: 2,  reserveRamMB: 64,  critical: true,  lane: 'watchdog' },
  Oracle:     { priority: 95,  reserveCpu: 6,  reserveRamMB: 256, critical: true,  lane: 'orchestration' },
  KAI:        { priority: 95,  reserveCpu: 8,  reserveRamMB: 512, critical: true,  lane: 'lattice' },
  Leo:        { priority: 80,  reserveCpu: 8,  reserveRamMB: 384, critical: true,  lane: 'voice' },
  Radio:      { priority: 65,  reserveCpu: 5,  reserveRamMB: 256, critical: false, lane: 'audio' },
  Dashboard:  { priority: 60,  reserveCpu: 2,  reserveRamMB: 128, critical: false, lane: 'visibility' },
  'Kai Coder':{ priority: 55,  reserveCpu: 8,  reserveRamMB: 512, critical: false, lane: 'build' },
  Analyst:    { priority: 50,  reserveCpu: 5,  reserveRamMB: 256, critical: false, lane: 'audit' },
  Researcher: { priority: 45,  reserveCpu: 5,  reserveRamMB: 256, critical: false, lane: 'research' },
  'Overnight Pipeline': { priority: 42, reserveCpu: 6, reserveRamMB: 512, critical: false, lane: 'learning' },
  Groq:       { priority: 35,  reserveCpu: 4,  reserveRamMB: 256, critical: false, lane: 'social' },
  Gemini:     { priority: 30,  reserveCpu: 4,  reserveRamMB: 256, critical: false, lane: 'social' },
  Claudey:    { priority: 30,  reserveCpu: 4,  reserveRamMB: 256, critical: false, lane: 'social' },
  X:          { priority: 30,  reserveCpu: 4,  reserveRamMB: 256, critical: false, lane: 'social' },
  Default:    { priority: 25,  reserveCpu: 2,  reserveRamMB: 128, critical: false, lane: 'background' }
};

const STATE_PATH = 'c:/KAI/tools/oracle-discord/state/self_optimize_state.json';
const ORACLE_URL = (process.env.ORACLE_API_URL || 'http://127.0.0.1:3334').replace(/\/+$/, '');

let currentSnapshot = null;
let lastCheck = 0;
let actionHistory = [];
let lastActionSignature = '';

try {
  if (fs.existsSync(STATE_PATH)) {
    const existing = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (Array.isArray(existing.actionHistory)) actionHistory = existing.actionHistory.slice(-50);
  }
} catch {}

function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : 0));
}

function spotFor(name = 'Default') {
  return RESOURCE_SPOTS[name] || RESOURCE_SPOTS.Default;
}

function powershellEncoded(script) {
  return `powershell -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

function isUserInteracting() {
  const flagPath = 'c:/KAI/tools/oracle-discord/state/user_interaction.flag';
  if (!fs.existsSync(flagPath)) return false;
  try {
    const content = fs.readFileSync(flagPath, 'utf8').trim();
    const ts = parseInt(content, 10);
    const now = Date.now();
    // Interaction within the last 30 minutes
    if (now - ts < 1800000) return true;
    
    // Fallback: Check file mtime
    const stats = fs.statSync(flagPath);
    return (now - stats.mtimeMs) < 1800000;
  } catch (e) {
    return false;
  }
}

// ── VOICE-PRIORITY GATE (Codex §21.1/§21.2: "Voice prioritized") ────────────
// Leo's realtime audio is the most latency-sensitive thing the fleet does. When
// Leo is actively on voice with a human (or mid-read), the WORK bots' autonomous
// consult_oracle / departmental loops must BACK OFF hard so CPU/RAM is freed for
// realtime voice. leo.mjs writes state/leo_voice_active.flag (a Date.now() stamp)
// while a voice session is live and unlinks it when the session ends; we treat a
// recent stamp (or recent mtime, crash-safe) as "Leo is on voice right now".
// Env-tunable, additive, default ON: KAI_VOICE_PRIORITY=1.
const LEO_VOICE_FLAG_PATH = 'c:/KAI/tools/oracle-discord/state/leo_voice_active.flag';
const VOICE_FLAG_FRESH_MS = (Number(process.env.KAI_VOICE_FLAG_FRESH_MS) > 0)
  ? Number(process.env.KAI_VOICE_FLAG_FRESH_MS)
  : 120000; // 2 min: the flag is refreshed continuously while voice is live

export function isVoicePriorityEnabled() {
  // Default ON; only an explicit '0' disables the gate.
  return String(process.env.KAI_VOICE_PRIORITY ?? '1') !== '0';
}

export function isLeoVoiceActive() {
  try {
    if (!fs.existsSync(LEO_VOICE_FLAG_PATH)) return false;
    const now = Date.now();
    const raw = fs.readFileSync(LEO_VOICE_FLAG_PATH, 'utf8').trim();
    const ts = parseInt(raw, 10);
    if (Number.isFinite(ts) && (now - ts) < VOICE_FLAG_FRESH_MS) return true;
    // Crash-safe fallback: trust the file mtime if the contents are stale/garbled.
    const stats = fs.statSync(LEO_VOICE_FLAG_PATH);
    return (now - stats.mtimeMs) < VOICE_FLAG_FRESH_MS;
  } catch (_) {
    return false;
  }
}

function featureCost(features = {}) {
  const weights = {
    voice: 18,
    radio: 12,
    historyIngestion: 18,
    autonomousWork: 14,
    socialLoop: 8,
    dreamCycle: 12,
    coding: 20,
    image: 16
  };

  return Object.entries(weights).reduce((sum, [key, weight]) => {
    const value = features[key];
    if (value === true) return sum + weight;
    if (typeof value === 'number') return sum + Math.max(0, value) * weight;
    return sum;
  }, 0);
}

let stagnantDriftTicks = 0;
let lastPhi = null;

function driftScore(vitals = {}, previousVitals = null) {
  const phi = Number(vitals.phi_g ?? vitals.phi ?? 1);
  const chi = Number(vitals.chi ?? 0);
  const coherence = Number(vitals.coherence ?? (Number.isFinite(chi) ? 1 - chi : 1));
  const phiDelta = previousVitals?.phi_g ? Math.abs(phi - previousVitals.phi_g) : 0;

  if (lastPhi !== null && Math.abs(phi - lastPhi) < 0.001) {
    stagnantDriftTicks++;
  } else {
    stagnantDriftTicks = 0;
    lastPhi = phi;
  }

  let score = 0;
  if (phi < 0.85) score += (0.85 - phi) * 100;
  if (coherence < 0.82) score += (0.82 - coherence) * 120;
  if (chi > 0.08) score += (chi - 0.08) * 500;
  if (phiDelta > 0.03) score += phiDelta * 200;

  // If KAI stops updating vitals (crashed or starved), gracefully decay drift
  // instead of freezing the entire ecosystem at Drift=39 forever.
  if (stagnantDriftTicks > 12) { // About 1 minute of identical vitals
      const decayFactor = Math.max(0, 1 - ((stagnantDriftTicks - 12) * 0.05));
      score *= decayFactor;
  }

  return clamp(score);
}

function decideTier({ cpuLoad, gpuLoad, memLoad, projectPressure, projectMemMB, freeMemMB, drift, profile }) {
  const peak = Math.max(cpuLoad, gpuLoad, memLoad);
  let reducedDrift = Number(profile.reducedDrift ?? 70);
  let protectDrift = Number(profile.protectDrift ?? 90);
  let reducedCpu = profile.reducedCpu;
  let reducedMem = profile.reducedMem;
  let reducedGpu = profile.reducedGpu;

  // Apply laptop/limited-host tighter baselines (Codex §21.1 Host Covenant + Resource Governor §21.2).
  // On limited rigs (battery/<=6c/<20GB): enter REDUCED earlier so non-urgent (ingestion, social replies, background)
  // back off, deliberate pauses inserted via multipliers, voice/critical stay prioritized. This is the direct
  // antidote to the observed brute-force 90%+ slamming + "kai.exe 9.4GB + fleet nodes" pile-up.
  if (_hostLimits && _hostLimits.isLimited) {
    reducedCpu = Math.max(48, Math.round(reducedCpu * 0.82));
    reducedMem = Math.max(60, Math.round(reducedMem * 0.85));
    reducedGpu = Math.max(60, Math.round(reducedGpu * 0.82));
    reducedDrift = Math.max(55, Math.round(reducedDrift * 0.85));
    // Also make project pressure bite sooner
    // (callers see higher effective pressure in REDUCED on laptop)
  }

  if (
    cpuLoad >= profile.protectCpu ||
    gpuLoad >= profile.protectGpu ||
    memLoad >= profile.protectMem ||
    projectMemMB >= profile.protectProjectMemMB ||
    freeMemMB <= profile.protectFreeMemMB ||
    projectPressure >= 88 ||
    drift >= protectDrift
  ) return TIERS.PROTECT;
  if (
    cpuLoad >= reducedCpu ||
    gpuLoad >= reducedGpu ||
    memLoad >= reducedMem ||
    projectMemMB >= profile.maxProjectMemMB ||
    freeMemMB <= profile.minFreeMemMB ||
    projectPressure >= 75 ||
    drift >= reducedDrift ||
    peak >= 90
  ) return TIERS.REDUCED;
  return TIERS.NORMAL;
}

function buildSpotPlan(tier, headroom, projectPressure, profile) {
  const plan = {};
  const activeUser = profile.socialOverride && isUserInteracting();

  for (const [name, spot] of Object.entries(RESOURCE_SPOTS)) {
    const guaranteed = spot.critical;
    const hasReserve = headroom.cpu >= spot.reserveCpu && headroom.ramMB >= spot.reserveRamMB;

    let allowed = true;
    let multiplier = 1.0;
    let reason = 'within reserved spot';

    if (tier === TIERS.REDUCED) {
      // Social bots (priority < 50) are normally deferred in REDUCED tier, 
      // but if the user is interacting, we ALLOW them.
      const learningHasRoom = spot.lane === 'learning' && hasReserve && projectPressure < 70;
      allowed = guaranteed || spot.priority >= 50 || learningHasRoom || (activeUser && spot.lane === 'social');
      multiplier = guaranteed ? 1.25 : 2.0;
      reason = allowed
        ? (learningHasRoom ? 'learning lane has safe headroom' : (activeUser ? 'interaction override' : 'reduced lane active'))
        : 'deferred to protect core lanes';
    }

    if (tier === TIERS.PROTECT) {
      // In PROTECT mode, only critical or high-priority with reserve can run.
      // Even with interaction, we stay strict here to prevent OS crash.
      allowed = guaranteed || (spot.priority >= 75 && hasReserve);
      multiplier = guaranteed ? 1.75 : 5.0;
      reason = allowed ? 'protected reserve only' : 'paused until headroom returns';
    }

    if (!hasReserve && !guaranteed) {
      allowed = false;
      reason = 'reserved CPU/RAM spot unavailable';
    }

    plan[name] = {
      lane: spot.lane,
      priority: spot.priority,
      reserveCpu: spot.reserveCpu,
      reserveRamMB: spot.reserveRamMB,
      allowed,
      multiplier,
      reason,
      pressure: Math.round(projectPressure)
    };
  }
  return plan;
}

export function evaluateSelfOptimize(input = {}) {
  const profile = getBudgetProfile(input.profile);
  const cpuLoad = clamp(input.cpuLoad ?? 0);
  const gpuLoad = clamp(input.gpuLoad ?? 0);
  const memLoad = clamp(input.memLoad ?? 0);
  const projectMemMB = Math.max(0, input.projectMemMB ?? 0);
  const projectProcessCount = Math.max(0, input.projectProcessCount ?? 0);
  const totalMemMB = Math.max(1, input.totalMemMB ?? (os.totalmem() / 1024 / 1024));
  const freeMemMB = Math.max(0, input.freeMemMB ?? (totalMemMB * (1 - memLoad / 100)));
  const featurePressure = featureCost(input.features);
  const projectMemPressure = clamp((projectMemMB / totalMemMB) * 100);
  const processPressure = clamp(projectProcessCount * 3);
  const drift = driftScore(input.vitals, input.previousVitals);

  const projectPressure = clamp(
    projectMemPressure * 0.45 +
    processPressure * 0.25 +
    featurePressure * 0.30
  );

  const tier = decideTier({ cpuLoad, gpuLoad, memLoad, projectPressure, projectMemMB, freeMemMB, drift, profile });
  const headroom = {
    cpu: Math.max(0, 100 - cpuLoad),
    gpu: Math.max(0, 100 - gpuLoad),
    ram: Math.max(0, 100 - memLoad),
    ramMB: freeMemMB
  };

  return {
    timestamp: new Date().toISOString(),
    version: 2,
    profile: profile.name,
    tier,
    sampled: {
      cpuLoad,
      gpuLoad,
      memLoad,
      projectMemMB: Math.round(projectMemMB),
      processCount: projectProcessCount
    },
    cpuLoad,
    gpuLoad,
    memLoad,
    totalMemMB: Math.round(totalMemMB),
    freeMemMB: Math.round(freeMemMB),
    headroom,
    project: {
      processCount: projectProcessCount,
      memoryMB: Math.round(projectMemMB),
      pressure: Math.round(projectPressure),
      featurePressure: Math.round(featurePressure),
      drift: Math.round(drift)
    },
    vitals: input.vitals || {},
    processRows: input.processRows || [],
    topOffenders: (input.processRows || []).slice(0, 8),
    spots: buildSpotPlan(tier, headroom, projectPressure, profile),
    actionHistory: []
  };
}

async function getGpuLoad() {
  try {
    const nvidia = await execAsync('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits', { timeout: 4000 }).catch(() => null);
    if (nvidia?.stdout) {
      const loads = nvidia.stdout.trim().split('\n').map(l => parseInt(l.trim(), 10) || 0);
      return Math.max(...loads, 0);
    }

    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-Counter '\\GPU Engine(*)\\Utilization Percentage' | Select-Object -ExpandProperty CounterSamples | Measure-Object -Property CookedValue -Max | Select-Object -ExpandProperty Maximum"], { timeout: 5000, killSignal: 'SIGKILL', windowsHide: true }).catch(() => ({ stdout: '0' }));
    return Math.round(parseFloat(stdout.trim()) || 0);
  } catch {
    return 0;
  }
}

// NATIVE CPU SAMPLER (governor rework): the old path spawned powershell.exe on
// EVERY snapshot just to read LoadPercentage — and a process whose JOB is to keep
// the PC calm was itself paying a ~150-300ms PowerShell cold-start each sweep.
// os.cpus() exposes cumulative per-core busy/idle times on Windows too, so the
// delta between two reads gives true average utilization over the interval with
// ZERO subprocess spawn. More representative (whole-interval average) and free.
let _prevCpuSample = null; // { idle, total } from the last call
function _cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}
async function getCpuLoad() {
  try {
    const cur = _cpuTimes();
    if (!_prevCpuSample) {
      // First call: take a short 180ms window so we still return a real number.
      await new Promise(r => setTimeout(r, 180));
      const cur2 = _cpuTimes();
      _prevCpuSample = cur2;
      const dIdle = cur2.idle - cur.idle, dTotal = cur2.total - cur.total;
      return dTotal > 0 ? clamp(Math.round((1 - dIdle / dTotal) * 100)) : 0;
    }
    const dIdle = cur.idle - _prevCpuSample.idle, dTotal = cur.total - _prevCpuSample.total;
    _prevCpuSample = cur;
    return dTotal > 0 ? clamp(Math.round((1 - dIdle / dTotal) * 100)) : 0;
  } catch {
    const cpus = os.cpus().length || 1;
    return clamp(Math.round(((os.loadavg()[0] || 0) / cpus) * 100));
  }
}

// The Win32_Process WMI query (with CommandLine) is the heaviest probe in the
// governor — a slow WMI join that can take seconds. Process MEMBERSHIP and memory
// change slowly, so re-running it every snapshot is wasteful. Cache it for 45s;
// CPU/GPU/mem still refresh every snapshot, only this expensive list is reused.
let _procCache = { rows: null, ts: 0 };
const PROC_CACHE_TTL = Number(process.env.KAI_PROC_CACHE_MS) > 0 ? Number(process.env.KAI_PROC_CACHE_MS) : 45000;
async function getProjectProcesses() {
  const now = Date.now();
  if (_procCache.rows && (now - _procCache.ts) < PROC_CACHE_TTL) return _procCache.rows;
  const rows = await _getProjectProcessesLive();
  _procCache = { rows, ts: now };
  return rows;
}
async function _getProjectProcessesLive() {
  const query = `
$procs = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '^(node|kai|powershell|python)(\\.exe)?$' -and
    ($_.CommandLine -match 'C:\\\\KAI|oracle-discord|OpenJarvis|target\\\\release\\\\kai|ecosystem-manager|oracle-gateway|start-bot|bots[\\\\/]|shared[\\\\/]sentinel|dashboard-server|radio-dj|kai\\.mjs|leo\\.mjs')
  } |
  Select-Object ProcessId,Name,CommandLine,WorkingSetSize
$procs | ConvertTo-Json -Compress
`;

  try {
    const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(query, 'utf16le').toString('base64')];
    const { stdout } = await execFileAsync('powershell.exe', args, { maxBuffer: 1024 * 1024, timeout: 8000, killSignal: 'SIGKILL', windowsHide: true });
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.filter(proc => {
      const cmd = String(proc.CommandLine || '');
      return !cmd.includes('Get-CimInstance Win32_Process') &&
        !cmd.includes('-EncodedCommand') &&
        !cmd.includes('self-optimize-sandbox.mjs');
    });
  } catch {
    return [];
  }
}

async function getVitals() {
  try {
    const res = await fetch(`${ORACLE_URL}/api/session`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return {};
    return (await res.json())?.vitals || {};
  } catch {
    return {};
  }
}

function persistSnapshot(snapshot) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(snapshot, null, 2));
  } catch {}
}

function roleFromCommand(commandLine = '', name = '') {
  const cmd = String(commandLine || '').toLowerCase();
  if (cmd.includes('ecosystem-manager')) return 'Ecosystem Manager';
  if (cmd.includes('oracle-gateway')) return 'Oracle';
  if (cmd.includes('dashboard-server')) return 'Dashboard';
  if (cmd.includes('overnight_pipeline')) return 'Overnight Pipeline';
  if (cmd.includes('kai.exe') || cmd.includes('target\\release\\kai')) return 'KAI';
  const botMatch = cmd.match(/bots[\\/](leo|start-bot)\.mjs(?:\s+\"?([^\"\r\n]+)\"?)?/);
  if (botMatch?.[1] === 'leo') return 'Leo';
  if (botMatch?.[2]) return botMatch[2].trim();
  if (cmd.includes('openjarvis')) return 'OpenJarvis';
  return name || 'Project Process';
}

function normalizeProjectProcesses(projectProcesses = []) {
  return projectProcesses.map(proc => {
    const workingSetMB = Math.round(((Number(proc.WorkingSetSize) || 0) / 1024 / 1024) * 10) / 10;
    const commandLine = String(proc.CommandLine || '');
    return {
      pid: Number(proc.ProcessId) || 0,
      name: String(proc.Name || ''),
      role: roleFromCommand(commandLine, proc.Name),
      workingSetMB,
      command: commandLine.length > 220 ? commandLine.slice(0, 217) + '...' : commandLine
    };
  }).sort((a, b) => b.workingSetMB - a.workingSetMB);
}

function rememberActions(snapshot, previousSnapshot = null) {
  const denied = Object.entries(snapshot.spots || {})
    .filter(([, spot]) => !spot.allowed)
    .map(([name]) => name)
    .sort();
  const signature = [
    snapshot.profile,
    snapshot.tier,
    denied.join(','),
    snapshot.project?.pressure,
    snapshot.project?.drift
  ].join('|');

  if (signature !== lastActionSignature) {
    const tierChanged = previousSnapshot?.tier && previousSnapshot.tier !== snapshot.tier;
    actionHistory.push({
      ts: Date.now(),
      at: new Date().toISOString(),
      profile: snapshot.profile,
      tier: snapshot.tier,
      action: tierChanged ? `tier changed ${previousSnapshot.tier} -> ${snapshot.tier}` : `enforcing ${snapshot.tier}`,
      denied,
      projectPressure: snapshot.project?.pressure ?? 0,
      drift: snapshot.project?.drift ?? 0
    });
    actionHistory = actionHistory.slice(-50);
    lastActionSignature = signature;
  }
  snapshot.actionHistory = actionHistory;
  snapshot.lastAction = actionHistory[actionHistory.length - 1] || null;
}

export async function getSelfOptimizeSnapshot(force = false, injected = null) {
  const now = Date.now();
  if (!force && !injected && currentSnapshot && now - lastCheck < 20000) return currentSnapshot;
  lastCheck = now;

  // Kick off (or await once) the battery probe for accurate laptop detection on first samples.
  // This makes the governor "detect limited hardware (battery, core count, RAM)" and run tighter baselines.
  probeBatteryForLimits().catch(() => {});

  if (injected) {
    const previousSnapshot = currentSnapshot;
    currentSnapshot = evaluateSelfOptimize({
      previousVitals: currentSnapshot?.vitals,
      ...injected
    });
    rememberActions(currentSnapshot, previousSnapshot);
    persistSnapshot(currentSnapshot);
    return currentSnapshot;
  }

  // --- COORDINATOR PATTERN ---
  const isCoordinator = process.env.RESOURCE_SAVER_COORDINATOR === '1';

  if (!isCoordinator) {
    try {
      if (fs.existsSync(STATE_PATH)) {
        const stats = fs.statSync(STATE_PATH);
        // If snapshot was written in the last 30 seconds, read and trust it
        if (now - stats.mtimeMs < 30000) {
          const content = fs.readFileSync(STATE_PATH, 'utf8');
          currentSnapshot = JSON.parse(content);
          return currentSnapshot;
        }
      }
    } catch (e) {
      // Fall through to live queries on error
    }
  }

  const [cpuLoad, gpuLoad, projectProcesses, vitals] = await Promise.all([
    getCpuLoad(),
    getGpuLoad(),
    getProjectProcesses(),
    getVitals()
  ]);

  const totalMemMB = os.totalmem() / 1024 / 1024;
  const freeMemMB = os.freemem() / 1024 / 1024;
  const memLoad = clamp(((totalMemMB - freeMemMB) / totalMemMB) * 100);
  const projectMemMB = projectProcesses.reduce((sum, proc) => sum + ((Number(proc.WorkingSetSize) || 0) / 1024 / 1024), 0);
  const processRows = normalizeProjectProcesses(projectProcesses);
  const previousSnapshot = currentSnapshot;

  currentSnapshot = evaluateSelfOptimize({
    cpuLoad,
    gpuLoad,
    memLoad,
    totalMemMB,
    freeMemMB,
    projectMemMB,
    projectProcessCount: projectProcesses.length,
    processRows,
    vitals,
    previousVitals: previousSnapshot?.vitals
  });
  rememberActions(currentSnapshot, previousSnapshot);

  persistSnapshot(currentSnapshot);

  // Write central metrics to the unified metrics store for the sentinel/correlation engine
  try {
    recordMetric('performance-monitor', 'cpu_pct', cpuLoad, { mode: 'coordinator' });
    recordMetric('performance-monitor', 'gpu_pct', gpuLoad, { mode: 'coordinator' });
    recordMetric('performance-monitor', 'mem_pct', Math.round(memLoad), { mode: 'coordinator' });
    recordMetric('proof-governor', 'tier', currentSnapshot.tier, { profile: currentSnapshot.profile });
    recordMetric('proof-governor', 'project_memory_mb', currentSnapshot.project.memoryMB, { profile: currentSnapshot.profile });
    recordMetric('proof-governor', 'project_pressure', currentSnapshot.project.pressure, { profile: currentSnapshot.profile });
    recordMetric('proof-governor', 'drift', currentSnapshot.project.drift, { profile: currentSnapshot.profile });
    recordMetric('proof-governor', 'process_count', currentSnapshot.project.processCount, { profile: currentSnapshot.profile });
    if (currentSnapshot.lastAction) {
      recordMetric('proof-governor', 'action', currentSnapshot.lastAction.action, {
        profile: currentSnapshot.profile,
        tier: currentSnapshot.tier,
        denied: currentSnapshot.lastAction.denied.join(',')
      });
    }
  } catch (_) {}

  if (currentSnapshot.tier !== TIERS.NORMAL) {
    console.log(`[SelfOptimize] Tier=${currentSnapshot.tier} CPU=${cpuLoad}% GPU=${gpuLoad}% RAM=${Math.round(memLoad)}% Project=${Math.round(projectMemMB)}MB Drift=${currentSnapshot.project.drift}`);
  }

  return currentSnapshot;
}

export async function getPerformanceTier(force = false) {
  const snapshot = await getSelfOptimizeSnapshot(force);
  return {
    tier: snapshot.tier,
    cpuLoad: snapshot.cpuLoad,
    gpuLoad: snapshot.gpuLoad,
    memLoad: snapshot.memLoad,
    projectPressure: snapshot.project.pressure,
    headroom: snapshot.headroom,
    profile: snapshot.profile,
    spots: snapshot.spots
  };
}

export async function shouldRunSpot(spotName = 'Default', taskType = 'background') {
  const snapshot = await getSelfOptimizeSnapshot(false);
  const spot = snapshot.spots[spotName] || snapshot.spots.Default;
  if (!spot) return true;
  if (taskType === 'voice' && spotName === 'Leo' && spot.priority >= 75) return spot.allowed || snapshot.tier !== TIERS.PROTECT;
  if (taskType === 'reactive') return spot.allowed || (snapshot.tier !== TIERS.PROTECT && spot.priority >= 75);
  return !!spot.allowed;
}

export function isLowPowerMode() {
  return currentSnapshot?.tier && currentSnapshot.tier !== TIERS.NORMAL;
}

export function getThrottlingMultiplier(spotName = 'Default') {
  const snapshot = currentSnapshot;
  if (!snapshot) return 1.0;
  const spot = snapshot.spots[spotName] || snapshot.spots.Default || spotFor(spotName);
  let m = spot.multiplier || 1.0;
  // Extra deliberate backoff on limited hosts (Codex: insert deliberate pauses; tighter on laptop).
  if (_hostLimits && _hostLimits.isLimited && snapshot.tier !== TIERS.NORMAL) {
    m = m * 1.6; // ~60% longer effective cycle times for background when laptop + load
  }
  return m;
}

/**
 * Deliberate host-aware pause. Callers (social pulses, ingestion, tutor rounds, index work, persistence)
 * should await this instead of fixed sleep() when they want to "insert deliberate pauses".
 * Longer on REDUCED/PROTECT or limited hardware; shorter when voice priority or human present.
 * This + shouldRunSpot + interest delays = "one at a time through the doorway".
 */
export async function hostAwarePause(baseMs = 800, context = {}) {
  const snapshot = currentSnapshot;
  const tier = snapshot ? snapshot.tier : TIERS.NORMAL;
  const limited = _hostLimits && _hostLimits.isLimited;
  let ms = baseMs;
  if (tier === TIERS.PROTECT) ms = Math.max(ms, 18000);      // 18s+ min per Codex "PROTECT-tier pauses (20s+ on >70%...)"
  else if (tier === TIERS.REDUCED) ms = Math.max(ms, limited ? 6500 : 4200);
  else if (limited) ms = Math.max(ms, 2200);
  // Voice or critical context gets shorter breath (prioritize)
  if (context.priority === 'voice' || context.critical) ms = Math.min(ms, 1200);
  // Jitter to avoid thundering herd
  const jitter = Math.floor(Math.random() * 600);
  await new Promise(r => setTimeout(r, ms + jitter));
  return ms + jitter;
}
