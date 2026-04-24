import { logForDebugging } from '../../utils/debug.js';
import { getPlasma } from '../../bootstrap/state.js';
import {
  initKAISubstrate,
  runDreamCycle,
  isSubstrateInitialized,
} from '../kaiSubstrate.js';

// The Heartbeat service runs in the background of a KAI session.
// It manages the "Geometric Pulse" of the assistant, performing
// RSHL lattice dreaming and monitoring for stuck states.

const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 1 minute
let heartbeatTimer: NodeJS.Timeout | null = null;

export function initHeartbeat(): void {
  if (heartbeatTimer) return;

  logForDebugging('[Heartbeat] Initializing Biological Maturity Heartbeat...');

  // Boot the geometric cognitive substrate and inject plasma into global state.
  // Subsequent calls to getPlasma() will return the live Plasma instance.
  initKAISubstrate();

  heartbeatTimer = setInterval(() => {
    void pulse();
  }, HEARTBEAT_INTERVAL_MS);

  // Don't keep the process alive just for the heartbeat
  heartbeatTimer.unref();
}

async function pulse(): Promise<void> {
  const plasma = getPlasma();
  if (!plasma) {
    logForDebugging('[Heartbeat] Plasma core not active. Skipping pulse.');
    return;
  }

  // Phase 1: Stuck prevention — future: detect if main loop is silent too long

  // Phase 2: Geometric dreaming — RSHL lattice consolidation when idle
  if (isIdle()) {
    await dream();
  }
}

function isIdle(): boolean {
  // Simple heuristic: background housekeeping tick, not actively streaming.
  return true;
}

async function dream(): Promise<void> {
  logForDebugging('[Heartbeat] Entering Dream State (Lattice Consolidation)...');

  if (!isSubstrateInitialized()) {
    logForDebugging('[Heartbeat] Substrate not ready — skipping dream');
    return;
  }

  const result = runDreamCycle();
  if (result) {
    logForDebugging(
      `[Heartbeat] Dream complete — insight: "${result.insight.slice(0, 60)}" ` +
        `confidence: ${result.confidence.toFixed(3)} ` +
        `phi_g: ${(result.field?.phi_g ?? 0).toFixed(3)} ` +
        `promoted: ${result.promotionReady}`,
    );
  } else {
    logForDebugging('[Heartbeat] Dream cycle returned no result (field too sparse)');
  }
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
