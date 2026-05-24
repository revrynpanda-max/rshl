import { logAudit } from './audit-log.mjs';
import { CHANNEL_IDS } from './channel-rules.mjs';

const MAX_AI_FAILURES = 3;
const AI_FAILURE_COUNTS = new Map();  // speaker -> failure count this session
const AI_OFFLINE_SET = new Set();     // speakers taken offline this session
export const PROVIDER_COOLDOWNS = new Map(); // providerName -> timestamp to re-enable
export const PROVIDER_FAILURE_STREAK = new Map(); // providerName -> failure count

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
export function recordProviderFailure(provider, errorStatus, errorMessage = "") {
  const streak = (PROVIDER_FAILURE_STREAK.get(provider) || 0) + 1;
  PROVIDER_FAILURE_STREAK.set(provider, streak);

  const errorText = String(errorMessage || "").toUpperCase();
  const isPermanent = errorText.includes("BALANCE_EXHAUSTED") || 
                     errorText.includes("EXPIRED") || 
                     errorText.includes("RENEW THE API KEY") ||
                     errorText.includes("INVALID_ARGUMENT") ||
                     errorText.includes("CREDIT_LIMIT_REACHED") ||
                     errorText.includes("AUTHENTICATION_ERROR") ||
                     errorText.includes("INVALID X-API-KEY") ||
                     errorText.includes("ALL AVAILABLE CREDITS") ||
                     errorText.includes("MONTHLY SPENDING LIMIT");

  const isTimeout = errorText.includes("TIMEOUT") || errorText.includes("ABORTED");

  let cooldownMs = 120000; // 2 minutes flat start
  if (isPermanent) {
    cooldownMs = 86400000; // 24 hours
    console.error(`[CircuitBreaker] Provider ${provider} PERMANENT FAILURE detected: ${errorMessage}. Deactivating for 24h.`);
  } else if (isTimeout && provider.startsWith("Local")) {
    cooldownMs = 5000; // 5 second breather for local congestion
    console.log(`[CircuitBreaker] Provider ${provider} TIMEOUT detected. Short 5s breather...`);
  } else if (streak > 2) {
    const baseCooldown = 300000; // 5 minutes
    cooldownMs = Math.min(baseCooldown * Math.pow(2, streak - 2), 3600000);
  }
  
  const cooldownUntil = Date.now() + cooldownMs;
  PROVIDER_COOLDOWNS.set(provider, cooldownUntil);
  
  logAudit('NEURAL_FAILURE', { provider, errorStatus, streak, cooldownMs, isPermanent });
  if (!isPermanent) {
    console.warn(`[CircuitBreaker] Provider ${provider} STREAK ${streak}. COOLDOWN for ${Math.round(cooldownMs/60000)}m due to error ${errorStatus}`);
  }
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

/**
 * Hard reset for all failure states. Used by Sentinel for self-healing.
 */
export function resetAllFailureStates() {
  AI_FAILURE_COUNTS.clear();
  AI_OFFLINE_SET.clear();
  PROVIDER_COOLDOWNS.clear();
  PROVIDER_FAILURE_STREAK.clear();
  logAudit('SYSTEM_RESET', { reason: "Sentinel triggered full neural reset." });
}

export function resetFailureTracker() {
  AI_FAILURE_COUNTS.clear();
  AI_OFFLINE_SET.clear();
  PROVIDER_COOLDOWNS.clear();
  PROVIDER_FAILURE_STREAK.clear();
  console.log("[FailureTracker] All neural and speaker failure states have been reset to baseline.");
}
