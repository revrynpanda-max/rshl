import { CHANNEL_IDS } from './channel-rules.mjs';

const MAX_AI_FAILURES = 3;
const AI_FAILURE_COUNTS = new Map();  // speaker -> failure count this session
const AI_OFFLINE_SET = new Set();     // speakers taken offline this session

/**
 * Record a failure for an AI speaker in the work channel.
 * @param {string} speaker 
 * @param {string} reason 
 * @param {string} channelId 
 * @param {function} onOfflineCallback - Callback triggered when AI goes offline
 */
export function recordAIFailure(speaker, reason, channelId, onOfflineCallback) {
  // Only track failures in the work channel
  if (channelId !== CHANNEL_IDS.WORK) return;
  
  // Never penalize Oracle itself, system messages, or KAI (KAI is the core engine)
  if (!speaker || speaker.toLowerCase() === "oracle" || speaker === "system") return;

  const count = (AI_FAILURE_COUNTS.get(speaker) || 0) + 1;
  AI_FAILURE_COUNTS.set(speaker, count);
  console.log(`[FailureTracker] ${speaker} failure ${count}/${MAX_AI_FAILURES}: ${reason}`);

  if (count >= MAX_AI_FAILURES && !AI_OFFLINE_SET.has(speaker)) {
    AI_OFFLINE_SET.add(speaker);
    console.warn(`[FailureTracker] ${speaker} OFFLINE after ${count} failures.`);
    if (onOfflineCallback) {
      onOfflineCallback(speaker, count, reason).catch(e => console.warn("[FailureTracker] notify failed:", e.message));
    }
  }
}

/**
 * Checks if a speaker is currently offline due to failures.
 * @param {string} speaker 
 * @returns {boolean}
 */
export function isSpeakerOffline(speaker) {
  return AI_OFFLINE_SET.has(speaker);
}

/**
 * Resets all failure tracking (e.g., on manual restart)
 */
export function resetFailures() {
  AI_FAILURE_COUNTS.clear();
  AI_OFFLINE_SET.clear();
}
