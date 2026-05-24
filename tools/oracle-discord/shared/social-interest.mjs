// shared/social-interest.mjs
// Personality-driven social-chat scoring.
//
// Each bot's biography (background + hobbies + interests + secret + tone)
// becomes a "personality bag" of weighted words. When a message arrives,
// every bag-word that appears in the message bumps the bot's interest score.
//
// Personality BIASES eagerness; it does not GATE participation. Any bot can
// chime in on any topic — their bio just makes them more or less likely to.
// The "two cents" lock (handled in the caller) keeps the chorus down.

import { BIOGRAPHIES } from './biographies.mjs';

const STOPWORDS = new Set(
  ("the and for with that this from have just into about over under your "
 + "they them then than what when where which been being onto upon some "
 + "more most very much many also like would could should there here "
 + "i'm i've it's that's there's here's lol lmao not but yes you we us "
 + "are was were has had does did doing get got make made take taken").split(/\s+/)
);

function tokens(text) {
  return (text || "").toLowerCase().match(/[a-z][a-z']{2,}/g) || [];
}

// Build a per-bot weight map once at module load.
const BAGS = (function buildBags() {
  const bags = {};
  for (const [botName, bio] of Object.entries(BIOGRAPHIES)) {
    const corpus = [
      bio.background || "",
      bio.hobbies || "",
      (bio.interests || []).join(" "),
      bio.secret || "",
      bio.tone || ""
    ].join(" ");
    const counts = {};
    for (const w of tokens(corpus)) {
      if (STOPWORDS.has(w)) continue;
      counts[w] = (counts[w] || 0) + 1;
    }
    bags[botName] = counts;
  }
  return bags;
})();

/**
 * Score a bot's interest in a message.
 * Approximate ranges:
 *   ~0.7 - 1.0   baseline engagement (everyone gets here for most messages)
 *   ~1.0 - 1.5   moderately resonant with the bot's bio
 *   ~1.5+        strongly resonant — eligible for the "two cents" slot
 */
export function computeInterest(botName, messageText) {
  const bag = BAGS[botName] || {};
  const words = tokens(messageText);
  let resonance = 0;
  for (const w of words) {
    const weight = bag[w];
    if (weight) resonance += Math.min(weight, 3) * 0.18;
  }
  const base = 0.70;             // generous base — personality biases, not gates
  const spice = Math.random() * 0.35;
  return base + resonance + spice;
}

// Minimum participation threshold. Below this, the bot doesn't reply to
// THIS message — keeps the chorus down without locking anyone out of any
// topic the way a fixed keyword whitelist would.
export const PARTICIPATION_THRESHOLD = 0.65;

// Score required to claim the "two cents" secondary slot when another bot
// has already taken the primary.
export const TWO_CENTS_THRESHOLD = 1.4;

// Convert a score into a response delay (ms). Higher score = shorter delay.
// Bot replies feel snappier when something resonates with them.
// Convert a score into a response delay (ms). Higher score = shorter delay.
// Calibration: Make response times feel organic, human, and premium (not robotic speed).
export function scoreToDelay(score, isHumanMessage = false) {
  // If highly interested (e.g., mentioned), start immediately to offset generation time
  if (score >= 2.0) {
    return Math.round(Math.random() * 150);
  }

  // If it's a message from a human, snap respond (generation itself takes 2-3s anyway)
  if (isHumanMessage) {
    const base = Math.max(100, 600 - score * 200);
    const jitter = Math.random() * 200; 
    return Math.round(base + jitter);
  } else {
    // Bot-to-bot cushion
    const base = Math.max(200, 800 - score * 300);
    const jitter = Math.random() * 300; 
    return Math.round(base + jitter);
  }
}
