/**
 * Groq bot = radio DJ. Must never use Gemini text (shares Leo quota / 429 storms).
 */
export function isGroqBot(botName) {
  return String(botName || '').trim() === 'Groq';
}

export function essentialsLimitedMode() {
  return process.env.KAI_FORCE_LIMITED === '1';
}

/** Work bots in essentials mode skip Gemini cloud (503/quota storms); groq → ollama only. */
export function shouldSkipGeminiFailover(botName) {
  const name = String(botName || '').trim();
  if (isGroqBot(name)) return true;
  if (essentialsLimitedMode() && !['Leo', 'Oracle', 'KAI', 'Gemini', 'Claudey', 'X'].includes(name)) {
    return true;
  }
  return false;
}

/** Cloud provider failover order for 429 hops. Groq: groq only, then caller adds ollama. */
export function cloudFailoverOrder(botName) {
  if (isGroqBot(botName)) return ['groq'];
  if (shouldSkipGeminiFailover(botName)) return ['groq'];
  return ['groq', 'gemini'];
}

/** Force primary lane for Groq regardless of BOT_PROVIDER_* env override. */
export function enforceGroqPrimaryRoute(botName, resolved) {
  if (!isGroqBot(botName) || !resolved) return resolved;
  if (resolved.provider === 'groq') return resolved;
  return { ...resolved, provider: 'groq' };
}