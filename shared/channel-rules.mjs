export const CHANNEL_IDS = {
  WORK: "1489796367466500128",       // oracle-chat
  PUBLIC: "1499108697631232090",     // over-all-chat
  GAME: "1499298054291980368",       // game-with-leo
  SENSITIVE: "1500053533515448480",  // sensitive-info
  SUNDAY: "1500085302268526712",     // ai-social-chat (formerly sunday-chat)
  VOICE: "1489796367466500129",      // public voice chat
  RADIO: "1500048983568023552",      // ai radio
  LEO_VOICE_SLOTS: [
    "1500527640107417783", // Ryan (Slot 1)
    "1500529928184008885", // Public 2
    "1500529995087610027", // Public 3
    "1500530046111318116", // Public 4
    "1500530070081503343", // Public 5
    "1500530095368962098"  // Public 6
  ]
};

export const CHANNEL_SPEAKER_RULES = {
  // oracle-chat: full work panel, NO Leo, Oracle is silent moderator
  [CHANNEL_IDS.WORK]: new Set(["KAI", "Gemini", "Claude", "X", "Groq", "Analyst", "Researcher", "Oracle Coder", "KAI Coder"]),
  // over-all-chat: Leo ONLY
  [CHANNEL_IDS.PUBLIC]: new Set(["Leo"]),
  // game-with-leo: Leo + spectating AIs (soft commentary only)
  [CHANNEL_IDS.GAME]: new Set(["Leo", "KAI", "Gemini", "Claude", "X", "Groq"]),
  // sensitive-info: NOBODY responds here
  [CHANNEL_IDS.SENSITIVE]: new Set([]),
  // ai-social-chat: Claude, Gemini, Groq, X only — social banter, no work bots, no Leo
  [CHANNEL_IDS.SUNDAY]: new Set(["Claude", "Gemini", "Groq", "X"])
};

export const BOT_PORTS = {
  "Leo": 3400,
  "KAI": 3401,
  "Gemini": 3402,
  "Claude": 3403,
  "X": 3404,
  "Groq": 3405,
  "Analyst": 3406,
  "Researcher": 3407,
  "Kai Coder": 3408,
  "Oracle Coder": 3408 // Alias
};

/**
 * Checks if a specific AI speaker is allowed to speak in a specific channel.
 * @param {string} speaker - The name of the AI (e.g., "KAI", "Leo")
 * @param {string} channelId - The Discord channel ID
 * @returns {boolean} True if allowed, false otherwise
 */
export function isAllowed(speaker, channelId) {
  // Oracle never speaks in ANY channel
  if (speaker.toLowerCase() === "oracle") return false;

  const allowed = CHANNEL_SPEAKER_RULES[channelId];
  
  // SPECIAL CASE: Leo is always allowed in his transcript slots
  if (speaker === "Leo" && CHANNEL_IDS.LEO_VOICE_SLOTS.includes(channelId)) return true;

  if (!allowed) return false; // Default deny if channel not explicitly mapped
  return allowed.has(speaker);
}

/**
 * Detects if a bot is named in the content
 */
export function detectNamedBot(content) {
  const c = content.toLowerCase();
  if (/\b(leo|leah|lia|leyo|lee)\b/.test(c)) return "Leo";
  if (/\b(kai)\b/.test(c) && !c.includes("coder")) return "KAI";
  if (c.includes("gemini")) return "Gemini";
  if (c.includes("claude")) return "Claude";
  if (c.includes("groq")) return "Groq";
  if (c.includes("analyst")) return "Analyst";
  if (c.includes("researcher")) return "Researcher";
  if (c.includes("kai coder") || c.includes("kai_coder") || c.includes("coder")) return "Kai Coder";
  if (/\b(x|xai|x ai)\b/.test(c)) return "X";
  return null;
}

export const ROUNDTABLE_CHANNELS = [
  CHANNEL_IDS.WORK,
  CHANNEL_IDS.PUBLIC,
  CHANNEL_IDS.GAME,
  CHANNEL_IDS.SUNDAY
];
