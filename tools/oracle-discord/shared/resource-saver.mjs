import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { recordMetric } from './metrics-store.mjs';

const execAsync = promisify(exec);

export const TIERS = {
  NORMAL: 'NORMAL',
  REDUCED: 'REDUCED',
  PROTECT: 'PROTECT'
};

export const RESOURCE_SPOTS = {
  Sentinel:   { priority: 100, reserveCpu: 2,  reserveRamMB: 64,  critical: true,  lane: 'watchdog' },
  Oracle:     { priority: 95,  reserveCpu: 6,  reserveRamMB: 256, critical: true,  lane: 'orchestration' },
  KAI:        { priority: 95,  reserveCpu: 8,  reserveRamMB: 512, critical: true,  lane: 'lattice' },
  Leo:        { priority: 80,  reserveCpu: 8,  reserveRamMB: 384, critical: false, lane: 'voice' },
  Radio:      { priority: 65,  reserveCpu: 5,  reserveRamMB: 256, critical: false, lane: 'audio' },
  Dashboard:  { priority: 60,  reserveCpu: 2,  reserveRamMB: 128, critical: false, lane: 'visibility' },
  'Kai Coder':{ priority: 55,  reserveCpu: 8,  reserveRamMB: 512, critical: false, lane: 'build' },
  Analyst:    { priority: 50,  reserveCpu: 5,  reserveRamMB: 256, critical: false, lane: 'audit' },
  Researcher: { priority: 45,  reserveCpu: 5,  reserveRamMB: 256, critical: false, lane: 'research' },
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

function driftScore(vitals = {}, previousVitals = null) {
  const phi = Number(vitals.phi_g ?? vitals.phi ?? 1);
  const chi = Number(vitals.chi ?? 0);
  const coherence = Number(vitals.coherence ?? (Number.isFinite(chi) ? 1 - chi : 1));
  const phiDelta = previousVitals?.phi_g ? Math.abs(phi - previousVitals.phi_g) : 0;

  let score = 0;
  if (phi < 0.85) score += (0.85 - phi) * 100;
  if (coherence < 0.82) score += (0.82 - coherence) * 120;
  if (chi > 0.08) score += (chi - 0.08) * 500;
  if (phiDelta > 0.03) score += phiDelta * 200;
  return clamp(score);
}

function decideTier({ cpuLoad, gpuLoad, memLoad, projectPressure, drift }) {
  const peak = Math.max(cpuLoad, gpuLoad, memLoad);
  // RELAXED THRESHOLDS: Windows machines often run at 80%+ RAM normally.
  if (peak >= 96 || projectPressure >= 88 || drift >= 40) return TIERS.PROTECT;
  if (peak >= 90 || projectPressure >= 75 || drift >= 25) return TIERS.REDUCED;
  return TIERS.NORMAL;
}

function buildSpotPlan(tier, headroom, projectPressure) {
  const plan = {};
  const activeUser = isUserInteracting();

  for (const [name, spot] of Object.entries(RESOURCE_SPOTS)) {
    const guaranteed = spot.critical;
    const hasReserve = headroom.cpu >= spot.reserveCpu && headroom.ramMB >= spot.reserveRamMB;

    let allowed = true;
    let multiplier = 1.0;
    let reason = 'within reserved spot';

    if (tier === TIERS.REDUCED) {
      // Social bots (priority < 50) are normally deferred in REDUCED tier, 
      // but if the user is interacting, we ALLOW them.
      allowed = guaranteed || spot.priority >= 50 || (activeUser && spot.lane === 'social');
      multiplier = guaranteed ? 1.25 : 2.0;
      reason = allowed ? (activeUser ? 'interaction override' : 'reduced lane active') : 'deferred to protect core lanes';
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

  const tier = decideTier({ cpuLoad, gpuLoad, memLoad, projectPressure, drift });
  const headroom = {
    cpu: Math.max(0, 100 - cpuLoad),
    gpu: Math.max(0, 100 - gpuLoad),
    ram: Math.max(0, 100 - memLoad),
    ramMB: freeMemMB
  };

  return {
    timestamp: new Date().toISOString(),
    tier,
    cpuLoad,
    gpuLoad,
    memLoad,
    headroom,
    project: {
      processCount: projectProcessCount,
      memoryMB: Math.round(projectMemMB),
      pressure: Math.round(projectPressure),
      featurePressure: Math.round(featurePressure),
      drift: Math.round(drift)
    },
    vitals: input.vitals || {},
    spots: buildSpotPlan(tier, headroom, projectPressure)
  };
}

async function getGpuLoad() {
  try {
    const nvidia = await execAsync('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits', { timeout: 4000 }).catch(() => null);
    if (nvidia?.stdout) {
      const loads = nvidia.stdout.trim().split('\n').map(l => parseInt(l.trim(), 10) || 0);
      return Math.max(...loads, 0);
    }

    const { stdout } = await execAsync('powershell "Get-Counter \'\\GPU Engine(*)\\Utilization Percentage\' | Select-Object -ExpandProperty CounterSamples | Measure-Object -Property CookedValue -Max | Select-Object -ExpandProperty Maximum"', { timeout: 5000 }).catch(() => ({ stdout: '0' }));
    return Math.round(parseFloat(stdout.trim()) || 0);
  } catch {
    return 0;
  }
}

async function getCpuLoad() {
  try {
    const { stdout } = await execAsync('powershell "(Get-CimInstance Win32_Processor).LoadPercentage"', { timeout: 5000 }).catch(() => ({ stdout: '0' }));
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    const cpus = os.cpus().length || 1;
    return clamp(Math.round(((os.loadavg()[0] || 0) / cpus) * 100));
  }
}

async function getProjectProcesses() {
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
    const { stdout } = await execAsync(powershellEncoded(query), { maxBuffer: 1024 * 1024, timeout: 8000 });
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

export async function getSelfOptimizeSnapshot(force = false, injected = null) {
  const now = Date.now();
  if (!force && !injected && currentSnapshot && now - lastCheck < 10000) return currentSnapshot;
  lastCheck = now;

  if (injected) {
    currentSnapshot = evaluateSelfOptimize({
      previousVitals: currentSnapshot?.vitals,
      ...injected
    });
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

  currentSnapshot = evaluateSelfOptimize({
    cpuLoad,
    gpuLoad,
    memLoad,
    totalMemMB,
    freeMemMB,
    projectMemMB,
    projectProcessCount: projectProcesses.length,
    vitals,
    previousVitals: currentSnapshot?.vitals
  });

  persistSnapshot(currentSnapshot);

  // Write central metrics to the unified metrics store for the sentinel/correlation engine
  try {
    recordMetric('performance-monitor', 'cpu_pct', cpuLoad, { mode: 'coordinator' });
    recordMetric('performance-monitor', 'gpu_pct', gpuLoad, { mode: 'coordinator' });
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
    spots: snapshot.spots
  };
}

export async function shouldRunSpot(spotName = 'Default', taskType = 'background') {
  const snapshot = await getSelfOptimizeSnapshot(false);
  const spot = snapshot.spots[spotName] || snapshot.spots.Default;
  if (!spot) return true;
  if (taskType === 'reactive' && spot.priority >= 50) return true;
  if (taskType === 'voice' && spotName === 'Leo' && spot.priority >= 75) return spot.allowed || snapshot.tier !== TIERS.PROTECT;
  // Social chat is the user-facing product — only block it under truly
  // critical pressure (PROTECT tier). Moderate load shouldn't gag the bots.
  if (taskType === 'social') {
    if (snapshot.tier === TIERS.PROTECT) return false;
    return true;
  }
  return !!spot.allowed;
}

export function isLowPowerMode() {
  return currentSnapshot?.tier && currentSnapshot.tier !== TIERS.NORMAL;
}

export function getThrottlingMultiplier(spotName = 'Default') {
  const snapshot = currentSnapshot;
  if (!snapshot) return 1.0;
  const spot = snapshot.spots[spotName] || snapshot.spots.Default || spotFor(spotName);
  return spot.multiplier || 1.0;
}
