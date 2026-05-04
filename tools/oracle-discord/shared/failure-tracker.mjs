import { CHANNEL_IDS } from './channel-rules.mjs';

const MAX_AI_FAILURES = 3;
const AI_FAILURE_COUNTS = new Map();  // speaker -> failure count this session
const AI_OFFLINE_SET = new Set();     // speakers taken offline this session
const PROVIDER_COOLDOWNS = new Map(); // providerName -> timestamp to re-enable

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
 * Record a failure for a specific Neural Provider (e.g., "Groq", "OpenAI")
 */
export function recordProviderFailure(provider, errorStatus) {
  if (errorStatus === 429 || errorStatus === 401 || errorStatus === 404) {
    const cooldownUntil = Date.now() + (errorStatus === 404 ? 300000 : 30000); // 5m for 404, 30s for others
    PROVIDER_COOLDOWNS.set(provider, cooldownUntil);
    console.warn(`[CircuitBreaker] Provider ${provider} in COOLDOWN for ${errorStatus === 404 ? '5m' : '30s'} due to error ${errorStatus}`);
  }
}

/**
 * Checks if a provider is currently in cooldown
 */
export function isProviderReady(provider) {
  const cooldownUntil = PROVIDER_COOLDOWNS.get(provider);
  if (!cooldownUntil) return true;
  if (Date.now() > cooldownUntil) {
    PROVIDER_COOLDOWNS.delete(provider);
    return true;
  }
  return false;
}

/**
 * Resets all failure tracking (e.g., on manual restart)
 */
export function resetFailures() {
  AI_FAILURE_COUNTS.clear();
  AI_OFFLINE_SET.clear();
  PROVIDER_COOLDOWNS.clear();
}
