import { logAudit } from './audit-log.mjs';
import { CHANNEL_IDS } from './channel-rules.mjs';

const MAX_AI_FAILURES = 3;
const AI_FAILURE_COUNTS = new Map();  // speaker -> failure count this session
const AI_OFFLINE_SET = new Set();     // speakers taken offline this session
const PROVIDER_COOLDOWNS = new Map(); // providerName -> timestamp to re-enable
const PROVIDER_FAILURE_STREAK = new Map(); // providerName -> failure count

/**
 * Record a failure for an AI speaker in the work channel.
 */
export function recordAIFailure(speaker, reason, channelId, onOfflineCallback) {
  if (channelId !== CHANNEL_IDS.WORK) return;
  if (!speaker || speaker.toLowerCase() === "oracle" || speaker === "system") return;

  const count = (AI_FAILURE_COUNTS.get(speaker) || 0) + 1;
  AI_FAILURE_COUNTS.set(speaker, count);
  
  logAudit('SPEAKER_FAILURE', { speaker, count, reason });

  if (count >= MAX_AI_FAILURES && !AI_OFFLINE_SET.has(speaker)) {
    AI_OFFLINE_SET.add(speaker);
    console.warn(`[FailureTracker] ${speaker} OFFLINE after ${count} failures.`);
    if (onOfflineCallback) {
      onOfflineCallback(speaker, count, reason).catch(e => {});
    }
  }
}

/**
 * Checks if a speaker is currently offline due to failures.
 */
export function isSpeakerOffline(speaker) {
  return AI_OFFLINE_SET.has(speaker);
}

/**
 * Record a failure for a specific Neural Provider (e.g., "Groq", "OpenAI")
 */
export function recordProviderFailure(provider, errorStatus) {
  const streak = (PROVIDER_FAILURE_STREAK.get(provider) || 0) + 1;
  PROVIDER_FAILURE_STREAK.set(provider, streak);

  // SMART BACKOFF: 2m for transient 429s, exponential after streak 2
  let cooldownMs = 120000; // 2 minutes flat start
  if (streak > 2) {
    const baseCooldown = 300000; // 5 minutes
    cooldownMs = Math.min(baseCooldown * Math.pow(2, streak - 2), 3600000);
  }
  
  const cooldownUntil = Date.now() + cooldownMs;
  PROVIDER_COOLDOWNS.set(provider, cooldownUntil);
  
  logAudit('NEURAL_FAILURE', { provider, errorStatus, streak, cooldownMs });
  console.warn(`[CircuitBreaker] Provider ${provider} STREAK ${streak}. COOLDOWN for ${Math.round(cooldownMs/60000)}m due to error ${errorStatus}`);
}

/**
 * Record a success for a provider to reset its failure streak
 */
export function recordProviderSuccess(provider) {
  if (PROVIDER_FAILURE_STREAK.has(provider)) {
    PROVIDER_FAILURE_STREAK.set(provider, 0);
    PROVIDER_COOLDOWNS.delete(provider);
    logAudit('NEURAL_RECOVERY', { provider, message: "Provider verified stable. Resetting failure streak." });
  }
}

/**
 * Check if a provider is ready (not in cooldown)
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
