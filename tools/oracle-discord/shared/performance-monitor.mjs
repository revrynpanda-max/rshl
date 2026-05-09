import fs from 'fs';
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
  
  // Refresh cache every 30 seconds
  if (now - cachedStats.lastUpdate < 30000 && cachedStats.memTotal > 0) {
    return cachedStats;
  }

  try {
    const [cpuRes, memRes] = await Promise.all([
      execAsync('powershell -Command "Get-CimInstance Win32_Processor | Select-Object -ExpandProperty LoadPercentage"'),
      execAsync('powershell -Command "Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVisibleMemorySize | ConvertTo-Json"')
    ]);
    
    const cpu = parseInt(cpuRes.stdout.trim()) || 0;
    let totalMem = 0;
    let freeMem = 0;
    
    try {
      const memData = JSON.parse(memRes.stdout);
      totalMem = Math.round((memData.TotalVisibleMemorySize || 0) / (1024 * 1024) * 10) / 10;
      freeMem = Math.round((memData.FreePhysicalMemory || 0) / (1024 * 1024) * 10) / 10;
    } catch (e) {
      // Fallback to native OS stats if PowerShell JSON is invalid
      totalMem = Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10;
      freeMem = Math.round(os.freemem() / (1024 * 1024 * 1024) * 10) / 10;
    }
    
    const usedMem = Math.round((totalMem - freeMem) * 10) / 10;

    cachedStats = {
      cpu,
      memFree,
      memTotal: totalMem,
      memUsed: usedMem,
      lastUpdate: now
    };
    
    return cachedStats;
  } catch (e) {
    // Ultimate fallback if PowerShell or parsing fails completely
    const totalMem = Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10;
    const freeMem = Math.round(os.freemem() / (1024 * 1024 * 1024) * 10) / 10;
    const usedMem = Math.round((totalMem - freeMem) * 10) / 10;
    
    return {
      cpu: 0, // CPU fallback is harder without PS, but RAM is priority
      memFree: freeMem,
      memTotal: totalMem,
      memUsed: usedMem,
      lastUpdate: Date.now()
    };
  }
}
