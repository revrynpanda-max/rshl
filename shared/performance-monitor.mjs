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

/**
 * Returns current CPU and Memory stats for grounding.
 */
export function getHardwareStats() {
  return {
    cpu: Math.round(os.loadavg()[0] * 100) / 10,
    memFree: Math.round(os.freemem() / (1024 * 1024 * 1024) * 10) / 10
  };
}
