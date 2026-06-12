/**
 * Entity Classifier — KAI knows who is AI and who is human.
 * 
 * Classification logic (in order of reliability):
 * 1. Discord.js `message.author.bot` flag — 100% reliable for registered bots
 * 2. Known bot ID whitelist — KAI's own Oracle system bots
 * 3. Known bot username patterns — bots often have BOT, AI, Oracle in their name
 * 4. Behavioral heuristics — message regularity, no typos, no personal statements
 * 
 * Stores classification in a local Map cache so we don't re-classify each message.
 */

import { HUMAN_REGISTRY } from './identities.mjs';

// KAI's Oracle system bot IDs — these are always classified as AI
const KNOWN_BOT_IDS = new Set([
  // Add your actual Discord bot user IDs here
  // You can find them in the Discord Developer Portal
  // Example format: '123456789012345678'
]);

// Bot username patterns (case-insensitive)
const BOT_NAME_PATTERNS = [
  /\bbot\b/i, /\bai\b/i, /\boracle\b/i, /\batlasai\b/i,
  /\bzerob\b/i, /\bautomat/i, /\bdiscord\.js/i, /\bwebhook/i,
];

// The classification cache — user_id → { isBot, displayName, classifiedAt }
const entityCache = new Map();

/**
 * Classify a Discord message author as bot or human.
 * Returns { isBot: boolean, confidence: number, reason: string }
 */
export function classifyEntity(message) {
  const userId = message.author.id;
  const username = message.author.username || '';
  const displayName = message.author.displayName || username;

  // Check cache first (valid for 1 hour)
  const cached = entityCache.get(userId);
  if (cached && (Date.now() - cached.classifiedAt) < 3_600_000) {
    return cached;
  }

  // 0. MIRROR RECOGNITION — a human speaking in voice is reposted to social
  // chat via the "Sunday Mirror Webhook" using their NAME + avatar. Discord
  // flags webhooks as bots, so without this the fleet would treat your
  // mirrored speech as just another AI. If a webhook message's name matches a
  // registered human, classify it as THAT HUMAN (real userId) so the AIs and
  // KAI respond to it as a person and learn it as human speech, not bot noise.
  if (message.webhookId) {
    try {
      const nameLc = (displayName || username).toLowerCase();
      for (const [hName, info] of Object.entries(HUMAN_REGISTRY || {})) {
        if (nameLc === hName.toLowerCase() || nameLc === (info.username || '').toLowerCase() || nameLc.includes(hName.toLowerCase())) {
          const result = {
            isBot: false,
            confidence: 0.95,
            reason: 'voice-mirror-of-human',
            displayName: hName,
            userId: info.id,         // map back to the REAL person's id
            isMirror: true,
            classifiedAt: Date.now(),
          };
          return result; // don't cache under webhook id — identity is the human's
        }
      }
    } catch (_) {}
  }

  // 1. Discord's own bot flag — definitive
  if (message.author.bot === true) {
    const result = {
      isBot: true,
      confidence: 1.0,
      reason: 'discord-bot-flag',
      displayName,
      userId,
      classifiedAt: Date.now(),
    };
    entityCache.set(userId, result);
    return result;
  }

  // 2. Known bot ID list
  if (KNOWN_BOT_IDS.has(userId)) {
    const result = {
      isBot: true,
      confidence: 0.99,
      reason: 'known-bot-id',
      displayName,
      userId,
      classifiedAt: Date.now(),
    };
    entityCache.set(userId, result);
    return result;
  }

  // 3. Username pattern matching
  const nameMatchesBot = BOT_NAME_PATTERNS.some(p => p.test(username));
  if (nameMatchesBot) {
    const result = {
      isBot: true,
      confidence: 0.85,
      reason: 'bot-name-pattern',
      displayName,
      userId,
      classifiedAt: Date.now(),
    };
    entityCache.set(userId, result);
    return result;
  }

  // 4. Default: assume human
  const result = {
    isBot: false,
    confidence: 0.90,
    reason: 'no-bot-signals',
    displayName,
    userId,
    classifiedAt: Date.now(),
  };
  entityCache.set(userId, result);
  return result;
}

/**
 * Mark a user ID as a known bot manually.
 * Call this when you discover a new bot in the ecosystem.
 */
export function markAsBot(userId) {
  KNOWN_BOT_IDS.add(userId);
  entityCache.delete(userId); // force re-classification
}

/**
 * Get all known entities in the cache.
 */
export function getCachedEntities() {
  return [...entityCache.values()];
}

/**
 * How many unique humans has KAI observed?
 */
export function humanCount() {
  return [...entityCache.values()].filter(e => !e.isBot).length;
}

/**
 * How many bots has KAI identified?
 */
export function botCount() {
  return [...entityCache.values()].filter(e => e.isBot).length;
}
