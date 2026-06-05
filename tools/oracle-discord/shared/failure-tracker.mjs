import fs from 'fs';
import { logAudit } from './audit-log.mjs';
import { CHANNEL_IDS } from './channel-rules.mjs';

const MAX_AI_FAILURES = 3;
import { recordMetric } from './metrics-store.mjs';

// Persisted cooldown state — survives process restarts
const COOLDOWN_STATE_FILE = 'c:/KAI/tools/oracle-discord/state/provider_cooldowns.json';

const AI_FAILURE_COUNTS = new Map();  // speaker -> failure count this session
const AI_OFFLINE_SET = new Set();     // speakers taken offline this session
export const PROVIDER_COOLDOWNS = new Map(); // providerName -> timestamp to re-enable
export const PROVIDER_FAILURE_STREAK = new Map(); // providerName -> failure count

// ── Disk persistence helpers ──────────────────────────────────────────────────

function loadPersistedCooldowns() {
  try {
    if (!fs.existsSync(COOLDOWN_STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(COOLDOWN_STATE_FILE, 'utf8'));
    const now = Date.now();
    let restored = 0;
    for (const [provider, cooldownUntil] of Object.entries(raw)) {
      if (cooldownUntil > now) {
        PROVIDER_COOLDOWNS.set(provider, cooldownUntil);
        const remainMin = Math.round((cooldownUntil - now) / 60000);
        console.log(`[CircuitBreaker] Restored persisted cooldown for ${provider}: ${remainMin}m remaining until ${new Date(cooldownUntil).toISOString()}`);
        restored++;
      }
    }
    if (restored > 0) {
      console.log(`[CircuitBreaker] Restored ${restored} active provider cooldown(s) from disk.`);
    }
  } catch (e) {
    console.warn('[CircuitBreaker] Could not load persisted cooldowns:', e.message);
  }
}

function persistCooldowns() {
  try {
    const now = Date.now();
    const toSave = {};
    for (const [provider, cooldownUntil] of PROVIDER_COOLDOWNS.entries()) {
      // Only persist long-duration cooldowns (> 10 minutes) — daily limits, billing, etc.
      if (cooldownUntil - now > 600000) {
        toSave[provider] = cooldownUntil;
      }
    }
    fs.writeFileSync(COOLDOWN_STATE_FILE, JSON.stringify(toSave, null, 2));
  } catch (e) {
    console.warn('[CircuitBreaker] Could not persist cooldowns:', e.message);
  }
}

function clearPersistedCooldown(provider) {
  try {
    if (!fs.existsSync(COOLDOWN_STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(COOLDOWN_STATE_FILE, 'utf8'));
    delete raw[provider];
    fs.writeFileSync(COOLDOWN_STATE_FILE, JSON.stringify(raw, null, 2));
  } catch (e) {}
}

// Load persisted cooldowns immediately on module import
loadPersistedCooldowns();

// ── Speaker failure tracking ──────────────────────────────────────────────────

/**
 * Record a failure for an AI speaker in the work channel.
 */
export function recordAIFailure(speaker, reason, channelId, onOfflineCallback) {
  recordMetric('failure-tracker', 'speaker_failure', 1, { speaker, reason: String(reason).slice(0, 60) });
  if (channelId !== CHANNEL_IDS.WORK) return;
  if (!speaker || speaker.toLowerCase() === "oracle" || speaker === "system") return;

  const count = (AI_FAILURE_COUNTS.get(speaker) || 0) + 1;
  AI_FAILURE_COUNTS.set(speaker, count);
  
  logAudit('SPEAKER_FAILURE', { speaker, count, reason });

  if (count >= MAX_AI_FAILURES && !AI_OFFLINE_SET.has(speaker)) {
    AI_OFFLINE_SET.add(speaker);
    console.warn(`[FailureTracker] ${speaker} OFFLINE after ${count} failures.`);
    recordMetric('failure-tracker', 'speaker_offline_state', 'offline', { speaker, count });
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

// ── Provider circuit breaker ──────────────────────────────────────────────────

/**
 * Record a failure for a specific Neural Provider (e.g., "Groq", "OpenAI")
 */
export function recordProviderFailure(provider, errorStatus, errorMessage = "") {
  recordMetric('failure-tracker', 'provider_failure', errorStatus || 0, { provider, msg: String(errorMessage).slice(0, 60) });
  const streak = (PROVIDER_FAILURE_STREAK.get(provider) || 0) + 1;
  PROVIDER_FAILURE_STREAK.set(provider, streak);

  const errorText = String(errorMessage || "").toUpperCase();

  // Billing / auth failures — treat as permanent (24h cooldown)
  const isPermanent = errorText.includes("BALANCE_EXHAUSTED") || 
                     errorText.includes("EXPIRED") || 
                     errorText.includes("RENEW THE API KEY") ||
                     errorText.includes("CREDIT_LIMIT_REACHED") ||
                     errorText.includes("AUTHENTICATION_ERROR") ||
                     errorText.includes("INVALID X-API-KEY") ||
                     errorText.includes("ALL AVAILABLE CREDITS") ||
                     errorText.includes("MONTHLY SPENDING LIMIT") ||
                     errorText.includes("CREDITERROR") ||        // OpenCode Zen CreditsError
                     errorText.includes("INSUFFICIENT BALANCE") ||
                     errorText.includes("INSUFFICIENT_BALANCE") ||
                     // Zen 401 billing: catch by status + provider since errorText may be truncated
                     (errorStatus === 401 && provider === "zen");

  // TPD = daily token quota exhausted. Groq resets at midnight UTC.
  const isTPD = errorText.includes("TOKENS PER DAY") || errorText.includes("TPD") ||
                (errorText.includes("RATE LIMIT") && errorText.includes("PER DAY")) ||
                (errorStatus === 429 && provider === "groq");

  const isTimeout = errorText.includes("TIMEOUT") || errorText.includes("ABORTED");

  let cooldownMs = 120000; // 2 minutes flat start
  if (isPermanent) {
    cooldownMs = 86400000; // 24 hours
    console.error(`[CircuitBreaker] Provider ${provider} PERMANENT BILLING FAILURE. Deactivating for 24h. (${errorMessage.slice(0, 80)})`);
  } else if (isTPD) {
    // Sleep until next daily reset (midnight UTC + 5min buffer)
    const now = new Date();
    const nextMidnightUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5, 0));
    cooldownMs = nextMidnightUTC.getTime() - Date.now();
    console.warn(`[CircuitBreaker] Provider ${provider} TPD LIMIT HIT. Going quiet until daily reset at ${nextMidnightUTC.toISOString()} (~${Math.round(cooldownMs/3600000)}h ${Math.round((cooldownMs%3600000)/60000)}m from now).`);
  } else if (isTimeout && provider.startsWith("Local")) {
    cooldownMs = 5000; // 5 second breather for local congestion
    console.log(`[CircuitBreaker] Provider ${provider} TIMEOUT detected. Short 5s breather...`);
  } else if (streak > 2) {
    const baseCooldown = 300000; // 5 minutes
    cooldownMs = Math.min(baseCooldown * Math.pow(2, streak - 2), 3600000);
  }
  
  const cooldownUntil = Date.now() + cooldownMs;
  PROVIDER_COOLDOWNS.set(provider, cooldownUntil);

  // Persist long cooldowns to disk so they survive restarts
  if (cooldownMs > 600000) {
    persistCooldowns();
  }
  
  logAudit('NEURAL_FAILURE', { provider, errorStatus, streak, cooldownMs, isPermanent });
  if (!isPermanent && !isTPD) {
    console.warn(`[CircuitBreaker] Provider ${provider} STREAK ${streak}. COOLDOWN for ${Math.round(cooldownMs/60000)}m due to error ${errorStatus}`);
  }
}

/**
 * Record a success for a provider to reset its failure streak
 */
export function recordProviderSuccess(provider) {
  recordMetric('failure-tracker', 'provider_recovery', 1, { provider });
  if (PROVIDER_FAILURE_STREAK.has(provider)) {
    PROVIDER_FAILURE_STREAK.set(provider, 0);
    PROVIDER_COOLDOWNS.delete(provider);
    clearPersistedCooldown(provider);
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
    clearPersistedCooldown(provider);
    return true;
  }
  return false;
}

/**
 * Hard reset for all failure states. Used by Sentinel for self-healing.
 * Note: preserves long-duration cooldowns (TPD, billing) from disk.
 */
export function resetAllFailureStates() {
  AI_FAILURE_COUNTS.clear();
  AI_OFFLINE_SET.clear();
  PROVIDER_COOLDOWNS.clear();
  PROVIDER_FAILURE_STREAK.clear();
  // Re-load persisted long cooldowns so daily limits survive a sentinel reset
  loadPersistedCooldowns();
  logAudit('SYSTEM_RESET', { reason: "Sentinel triggered full neural reset." });
}

/**
 * Soft reset — clears speaker/bot states but preserves long-duration provider cooldowns.
 * Called on every ecosystem restart to avoid re-tripping daily limits immediately.
 */
export function resetFailureTracker() {
  AI_FAILURE_COUNTS.clear();
  AI_OFFLINE_SET.clear();
  // Clear only short-lived cooldowns — keep long ones (TPD, billing) alive across restarts
  for (const [provider, cooldownUntil] of PROVIDER_COOLDOWNS.entries()) {
    const remainMs = cooldownUntil - Date.now();
    if (remainMs <= 600000) {
      // Short cooldown (< 10 min) — clear on restart
      PROVIDER_COOLDOWNS.delete(provider);
      PROVIDER_FAILURE_STREAK.delete(provider);
    }
  }
  // Restore any persisted long cooldowns in case memory was cleared
  loadPersistedCooldowns();
  console.log("[FailureTracker] Soft reset complete. Long-duration provider cooldowns preserved.");
}
