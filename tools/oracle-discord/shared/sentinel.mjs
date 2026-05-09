/**
 * sentinel.mjs — Oracle Security System (Self-Healing).
 * Monitors logs and failure states to trigger real-time repairs.
 */

import fs from 'fs';
import { resetAllFailureStates } from './failure-tracker.mjs';

const LOG_FILE = "c:/KAI/tools/oracle-discord/logs/audit.json";
const LOCK_FILE = "c:/KAI/tools/oracle-discord/state/neural_lock.json";

let isHalted = false;

/**
 * Monitors the neural lanes for recurring errors.
 */
export function startSentinel() {
  console.log("🏛️ [Sentinel] Security System Online. Monitoring Neural Lanes...");
  
  if (fs.existsSync(LOG_FILE)) {
    fs.watchFile(LOG_FILE, (curr, prev) => {
      if (curr.mtime > prev.mtime) {
        checkHealth();
      }
    });
  }
}

async function checkHealth() {
  if (isHalted) return;
  
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-50);
    const logs = lines.map(l => { try { return JSON.parse(l); } catch(e) { return {}; } });
    
    const localFaults = logs.filter(l => l.type === "NEURAL_FAILURE").length;
    
    if (localFaults > 20) { // Increased threshold for 11-bot boot surge
      await triggerEmergencyFix(`Local Neural Congestion Detected (${localFaults} failures in last 50 events).`);
    }
  } catch (e) {
    console.error("[Sentinel] Health Check Error:", e.message);
  }
}

export function isQuarantined(botName) {
  return false; // Quarantine is obsolete in Total Sovereign mode
}

export async function triggerEmergencyFix(reason) {
  console.warn(`⚠️ [Sentinel] EMERGENCY TRIGGER: ${reason}. Halting Pipelines...`);
  isHalted = true;
  
  try {
    // 1. CLEAR NEURAL LOCK
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
      console.log(`[Sentinel] Neural Lock purged.`);
    }
    
    // 2. RESET FAILURE TRACKER
    resetAllFailureStates();
    console.log(`[Sentinel] API Failure States reset.`);
    
    // 3. WAIT FOR SYSTEM CALM
    await new Promise(r => setTimeout(r, 5000));
    
  } catch (err) {
    console.error(`[Sentinel] Repair Failed:`, err.message);
  } finally {
    console.log(`[Sentinel] Self-healing complete. Resuming traffic...`);
    isHalted = false;
  }
}

export function isPipelineHalted() {
  return isHalted;
}
