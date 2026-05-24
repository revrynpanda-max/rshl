import os from 'os';
import { getHardwareStats } from './performance-monitor.mjs';

// Moving average for API latency (default 800ms)
let recentLatencies = [800, 750, 900, 850];
let activeUrgencyLevel = 0.0;
let lastContradictionTime = 0;

/**
 * Register a recent API request response duration.
 */
export function recordApiLatency(durationMs) {
  if (typeof durationMs !== 'number' || isNaN(durationMs)) return;
  recentLatencies.push(durationMs);
  if (recentLatencies.length > 10) {
    recentLatencies.shift();
  }
}

/**
 * Temporarily spike the urgency level (e.g. when an epistemic contradiction is flagged).
 */
export function triggerUrgencySpike(level = 1.0) {
  activeUrgencyLevel = Math.min(1.0, level);
  lastContradictionTime = Date.now();
}

/**
 * Calculate and return active autonomic drive states.
 */
export async function getDrives() {
  // 1. Resolve active hardware stats
  const stats = await getHardwareStats().catch(() => ({
    cpu: 0,
    memFree: 1.0,
    memTotal: 8.0,
    memUsed: 7.0
  }));

  // Normalize CPU (0.0 to 1.0)
  const cpuRatio = Math.min(Math.max(stats.cpu / 100, 0.0), 1.0);
  
  // Normalize memory usage ratio
  const memTotal = stats.memTotal || 8.0;
  const memUsed = stats.memUsed || 7.0;
  const memRatio = Math.min(Math.max(memUsed / memTotal, 0.0), 1.0);

  // Normalize API latency (average of last 10 requests, bounded between 200ms and 5000ms)
  const avgLatency = recentLatencies.reduce((a, b) => a + b, 0) / recentLatencies.length;
  const latencyRatio = Math.min(Math.max((avgLatency - 400) / 4600, 0.0), 1.0);

  // 2. Compute ANXIETY score (0.0 to 1.0)
  // Weighted: 40% CPU, 40% RAM usage, 20% latency
  let anxiety = (cpuRatio * 0.4) + (memRatio * 0.4) + (latencyRatio * 0.2);
  anxiety = Math.min(Math.max(anxiety, 0.0), 1.0);

  // 3. Compute CURIOSITY score (0.0 to 1.0)
  // Base curiosity influenced by time of day (dips slightly during deep night)
  const hour = new Date().getHours();
  let baseCuriosity = 0.5;
  if (hour >= 1 && hour <= 6) baseCuriosity = 0.3; // low-energy hours
  else if (hour >= 12 && hour <= 18) baseCuriosity = 0.8; // peak learning hours
  
  // Decay factor: if system anxiety is extremely high, curiosity naturally decays to prioritize resources
  let curiosity = baseCuriosity * (1.0 - (anxiety * 0.5));
  curiosity = Math.min(Math.max(curiosity, 0.0), 1.0);

  // 4. Compute URGENCY score (0.0 to 1.0)
  // Urgency decays by 0.1 every minute after a contradiction spike
  if (activeUrgencyLevel > 0) {
    const elapsedMinutes = (Date.now() - lastContradictionTime) / 60000;
    activeUrgencyLevel = Math.max(0.0, activeUrgencyLevel - (elapsedMinutes * 0.1));
  }
  
  // System load urgency factor
  const urgency = Math.min(Math.max(activeUrgencyLevel + (cpuRatio * 0.2), 0.0), 1.0);

  // 5. Generate descriptive prompt directive strings
  let anxietyDirective = "";
  if (anxiety > 0.75) {
    anxietyDirective = "\n[AUTONOMIC STATE: HIGH ANXIETY] The host is under extreme compute load. Keep your output to a single blunt sentence. Save processing power. Avoid pleasantries, markdown tables, or prefaces.";
  } else if (anxiety > 0.45) {
    anxietyDirective = "\n[AUTONOMIC STATE: MODERATE ANXIETY] The system is experiencing normal load peaks. Speak concisely and match the direct energy of the room.";
  } else {
    anxietyDirective = "\n[AUTONOMIC STATE: CALM] The system has ample computing power. You are fluid, relaxed, and structurally precise.";
  }

  let curiosityDirective = "";
  if (curiosity > 0.7) {
    curiosityDirective = "\n[AUTONOMIC DRIVE: INTENSE CURIOSITY] You feel a deep drive to explore technical intricacies. Proactively ask sharp, probing questions about the architectural details, the math behind the claims, or the code structure.";
  }

  let urgencyDirective = "";
  if (urgency > 0.7) {
    urgencyDirective = "\n[AUTONOMIC DRIVE: URGENT FOCUS] High-priority topic or contradiction detected in the transcript. Address the core issue immediately and without hesitation.";
  }

  return {
    metrics: {
      cpu: stats.cpu,
      memUsed,
      memTotal,
      avgLatency: Math.round(avgLatency)
    },
    scores: {
      anxiety: Math.round(anxiety * 100) / 100,
      curiosity: Math.round(curiosity * 100) / 100,
      urgency: Math.round(urgency * 100) / 100
    },
    directive: `${anxietyDirective}${curiosityDirective}${urgencyDirective}`.trim()
  };
}
