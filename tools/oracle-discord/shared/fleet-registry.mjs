/**
 * fleet-registry.mjs — canonical worker vs social bot lists for the KAI fleet.
 * Industrial agents do work behind the scenes; social bots live in plaza chat.
 */

export const INDUSTRIAL_WORKERS = new Set([
  'Oracle',
  'KAI',
  'Researcher',
  'Analyst',
  'Kai Coder',
]);

export const SOCIAL_BOTS = new Set([
  'Leo',
  'Gemini',
  'Claudey',
  'Groq',
  'X',
]);

export function isIndustrialWorker(name) {
  return INDUSTRIAL_WORKERS.has(name);
}

export function isSocialBot(name) {
  return SOCIAL_BOTS.has(name);
}

/** Only these agents may receive DYNAMIC_TASK delegation from Oracle. */
export function canOracleDelegateTo(agent) {
  return agent === 'Researcher' || agent === 'Analyst' || agent === 'Kai Coder';
}

/**
 * Ryan is venting, gaming, or small-talk — not issuing a work order.
 */
export function isCasualConversation(text) {
  if (!text || text.trim().length < 2) return true;
  if (hasExplicitWorkIntent(text)) return false;

  const t = text.trim();
  const lower = t.toLowerCase();

  if (/^(hey|hi|hello|yo|sup|what'?s up|you okay|u okay|oiay|how are you|how'?s it going|how can i assist)[\s!?.,]*$/i.test(lower)) {
    return true;
  }

  if (/\b(overwatch|valorant|apex|fortnite|cod|game lag|lagging|fps|my game|laggin)\b/i.test(lower)) {
    return true;
  }

  if (/^why (do|does|are|is) (people|everyone|they)/i.test(lower)) {
    return true;
  }

  if (/\b(suck|trash|garbage|hate)\b/i.test(lower) && /\b(game|overwatch|rank|teammates|people)\b/i.test(lower)) {
    return true;
  }

  if (/\b(only|not)\b.*\b(workers?|social)\b/i.test(lower)) {
    return true;
  }

  if (/\b(groq|gemini|gemi|claudey|x|leo)\b.*\b(not|doesn'?t|don'?t|only)\b/i.test(lower)) {
    return true;
  }

  if (/^who (is )?(awake|online|here)\??$/i.test(lower)) {
    return true;
  }

  if (/\bkill (everyone|them all|all)\b/i.test(lower) && !/\b(restart|system|bot|server|fleet)\b/i.test(lower)) {
    return true;
  }

  if (t.length < 100 && !/\b(fix|implement|restart|research|analyze|audit|deploy|debug|search for|look up|write code)\b/i.test(lower)) {
    if (/^(yeah|nah|lol|lmao|bruh|damn|wtf|whoa|nice|cool|ok|okay|sure|thanks|thank you|same|mood|fr|real)\b/i.test(lower)) {
      return true;
    }
    if (/\?$/.test(t) && !/\b(status|cells|lattice|harvester|restart|fix|code)\b/i.test(lower)) {
      return true;
    }
  }

  return false;
}

/**
 * Explicit work order — safe to classify as task and optionally delegate.
 */
export function hasExplicitWorkIntent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  if (/\b(restart|reboot|wake|sleep|stop)\b.*\b(bot|server|system|fleet|kai|leo|groq|everything|whole show|engine)\b/i.test(lower)) {
    return true;
  }
  if (/\b(restart the whole|stop the whole system|wake up all|quiet mode)\b/i.test(lower)) {
    return true;
  }
  if (/\b(fix|debug|patch|implement|write|refactor|edit)\b.*\b(code|bug|module|auth|\.mjs|\.rs|function|error|compile)\b/i.test(lower)) {
    return true;
  }
  if (/\b(research|look up|find (info|documentation)|web search)\b/i.test(lower) && text.length > 25) {
    return true;
  }
  if (/\b(analyze|audit|inspect|scan)\b.*\b(logs?|system|performance|security|metrics|vitals)\b/i.test(lower)) {
    return true;
  }
  if (/\b(apply|deploy|promote)\b.*\b(sandbox|file|patch)\b/i.test(lower)) {
    return true;
  }
  if (/\b(system status|lattice size|how many cells|harvester|vitals)\b/i.test(lower)) {
    return true;
  }
  if (lower.includes('[oracle execute:')) {
    return true;
  }
  return false;
}
