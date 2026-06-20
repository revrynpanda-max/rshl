import fs from 'fs';
import { recordMetric } from './metrics-store.mjs';
import path from 'path';
import os from 'os';

const LOG_PATH = 'c:/KAI/tools/oracle-discord/state/performance_logs.jsonl';

/**
 * Records a detailed neural performance event for systematic research.
 */
export function recordNeuralEvent(botName, eventData) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    botName,
    hardware: {
      cpu: Math.round(os.loadavg()[0] * 100) / 10,
      memFree: Math.round(os.freemem() / (1024 * 1024 * 1024) * 10) / 10
    },
    ...eventData
  };

  try {
    const dir = path.dirname(LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    fs.appendFileSync(LOG_PATH, JSON.stringify(logEntry) + '\n');
    console.log(`[PerfMonitor] Logged ${eventData.type} for ${botName}. Status: ${eventData.status}`);
  } catch (e) {
    console.error("[PerfMonitor] Failed to write log:", e.message);
  }
}

/**
 * Summarizes recent bottlenecks for the Analyst to audit.
 */
export function getRecentBottlenecks(limit = 50) {
  if (!fs.existsSync(LOG_PATH)) return [];
  try {
    const content = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = content.trim().split('\n');
    return lines.slice(-limit).map(line => JSON.parse(line));
  } catch (e) {
    return [];
  }
}

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

let cachedStats = {
  cpu: 0,
  memFree: 0,
  memTotal: 0,
  memUsed: 0,
  lastUpdate: 0
};

/**
 * Returns current CPU and Memory stats for grounding.
 * Anchored in Windows PowerShell (Non-Blocking / Cached).
 */
export async function getHardwareStats() {
  const now = Date.now();
  
  // Try to load pre-calculated snapshot from disk first to save CPU/IO
  const STATE_PATH = 'c:/KAI/tools/oracle-discord/state/self_optimize_state.json';
  try {
    if (fs.existsSync(STATE_PATH)) {
      const stats = fs.statSync(STATE_PATH);
      if (now - stats.mtimeMs < 30000) {
        const content = fs.readFileSync(STATE_PATH, 'utf8');
        const snapshot = JSON.parse(content);
        if (snapshot && typeof snapshot.cpuLoad === 'number') {
          const totalMemMB = snapshot.totalMemMB || (os.totalmem() / 1024 / 1024);
          const freeMemMB = snapshot.freeMemMB || snapshot.headroom?.ramMB || (os.freemem() / 1024 / 1024);
          const totalMem = Math.round(totalMemMB / 1024 * 10) / 10;
          const freeMem = Math.round(freeMemMB / 1024 * 10) / 10;
          const usedMem = Math.round((totalMem - freeMem) * 10) / 10;
          
          cachedStats = {
            cpu: snapshot.cpuLoad,
            memFree: freeMem,
            memTotal: totalMem,
            memUsed: usedMem,
            lastUpdate: now
          };
          return cachedStats;
        }
      }
    }
  } catch (e) {
    // Fail silent and fall through to query/native
  }

  // Refresh cache every 30 seconds
  if (now - cachedStats.lastUpdate < 30000 && cachedStats.memTotal > 0) {
    return cachedStats;
  }

  const isCoordinator = process.env.RESOURCE_SAVER_COORDINATOR === '1';

  if (!isCoordinator) {
    // Bot processes do NOT run PowerShell, they fall back to fast native os bindings
    const totalMem = Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10;
    const freeMem = Math.round(os.freemem() / (1024 * 1024 * 1024) * 10) / 10;
    const usedMem = Math.round((totalMem - freeMem) * 10) / 10;
    
    // Attempt a lightweight CPU estimate using loadavg (converted to percentage)
    const cpus = os.cpus().length || 1;
    const loadAvg = os.loadavg()[0] || 0;
    const cpuEstimate = Math.min(100, Math.round((loadAvg / cpus) * 100));

    cachedStats = {
      cpu: cpuEstimate,
      memFree: freeMem,
      memTotal: totalMem,
      memUsed: usedMem,
      lastUpdate: now
    };
    
    recordMetric('performance-monitor', 'cpu_pct',      cpuEstimate, { mode: 'os-native' });
    recordMetric('performance-monitor', 'mem_used_gb',  usedMem,     { mode: 'os-native' });
    recordMetric('performance-monitor', 'mem_free_gb',  freeMem,     { mode: 'os-native' });
    recordMetric('performance-monitor', 'mem_total_gb', totalMem,    { mode: 'os-native' });
    
    return cachedStats;
  }

  try {
    const [cpuRes, memRes] = await Promise.all([
      execAsync('powershell -Command "Get-CimInstance Win32_Processor | Select-Object -ExpandProperty LoadPercentage"', { timeout: 4000, windowsHide: true }),
      execAsync('powershell -Command "Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVisibleMemorySize | ConvertTo-Json"', { timeout: 4000, windowsHide: true })
    ]);
    
    const cpu = parseInt(cpuRes.stdout.trim()) || 0;
    let totalMem = 0;
    let freeMem = 0;
    
    try {
      const memData = JSON.parse(memRes.stdout);
      totalMem = Math.round((memData.TotalVisibleMemorySize || 0) / (1024 * 1024) * 10) / 10;
      freeMem = Math.round((memData.FreePhysicalMemory || 0) / (1024 * 1024) * 10) / 10;
    } catch (e) {
      totalMem = Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10;
      freeMem = Math.round(os.freemem() / (1024 * 1024 * 1024) * 10) / 10;
    }
    
    const usedMem = Math.round((totalMem - freeMem) * 10) / 10;

    cachedStats = {
      cpu,
      memFree: freeMem,
      memTotal: totalMem,
      memUsed: usedMem,
      lastUpdate: now
    };

    recordMetric('performance-monitor', 'cpu_pct',      cpu,      { mode: 'ps-cim' });
    recordMetric('performance-monitor', 'mem_used_gb',  usedMem,  { mode: 'ps-cim' });
    recordMetric('performance-monitor', 'mem_free_gb',  freeMem,  { mode: 'ps-cim' });
    recordMetric('performance-monitor', 'mem_total_gb', totalMem, { mode: 'ps-cim' });

    return cachedStats;
  } catch (e) {
    const totalMem = Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10;
    const freeMem = Math.round(os.freemem() / (1024 * 1024 * 1024) * 10) / 10;
    const usedMem = Math.round((totalMem - freeMem) * 10) / 10;
    
    recordMetric('performance-monitor', 'cpu_pct',      0,        { mode: 'os-fallback' });
    recordMetric('performance-monitor', 'mem_used_gb',  usedMem,  { mode: 'os-fallback' });
    recordMetric('performance-monitor', 'mem_free_gb',  freeMem,  { mode: 'os-fallback' });
    recordMetric('performance-monitor', 'mem_total_gb', totalMem, { mode: 'os-fallback' });

    return {
      cpu: 0,
      memFree: freeMem,
      memTotal: totalMem,
      memUsed: usedMem,
      lastUpdate: Date.now()
    };
  }
}
