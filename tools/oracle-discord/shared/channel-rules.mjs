export const CHANNEL_IDS = {
  WORK: "1489796367466500128",       // oracle-chat
  PUBLIC: "1499108697631232090",     // over-all-chat
  GAME: "1499298054291980368",       // game-with-leo
  SENSITIVE: "1500053533515448480",  // sensitive-info
  SUNDAY: "1500085302268526712",     // sunday-chat
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
  // sunday-chat: full social panel
  [CHANNEL_IDS.SUNDAY]: new Set(["KAI", "Gemini", "Claude", "X", "Groq", "Analyst", "Researcher", "Oracle Coder", "KAI Coder"])
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
  if (!allowed) return false; // Default deny if channel not explicitly mapped
  return allowed.has(speaker);
}
