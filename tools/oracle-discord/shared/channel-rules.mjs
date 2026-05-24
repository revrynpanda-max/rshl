import { HUMAN_REGISTRY, AI_REGISTRY } from './identities.mjs';

export const CHANNEL_IDS = {
  WORK: "1489796367466500128",       // oracle-chat — roundtable, work bots + KAI
  PUBLIC: "1499108697631232090",     // over-all-chat — public social, Leo + KAI
  GAME: "1499298054291980368",       // game-with-leo — gaming, all social bots
  SENSITIVE: "1500053533515448480",  // sensitive-info — SYSTEM ONLY. No bots respond.
  SUNDAY: "1500085302268526712",     // ai-social-chat — social banter, all social bots + KAI
  KAI_DREAMS: "1504582069886648351", // kai-dreams — KAI's thoughts, evolution, spectating
  VOICE: "1489796367466500129",      // public voice chat (shared)
  LEO_VOICE: "1505088473307283517",  // Leo's dedicated voice chat
  RADIO: "1500048983568023552",      // ai radio
  UNREGISTERED_SLOT: "1500958679669674086", // Onboarding: Leo tells unregistered users to check DMs
  LEO_VOICE_SLOTS: [
    "1500527640107417783", // Slot 1 — Ryan       (registered)
    "1500529928184008885", // Slot 2 — Taz        (registered)
    "1500529995087610027", // Slot 3 — OPEN for registration
    "1500530046111318116", // Slot 4 — OPEN for registration
    "1500530070081503343", // Slot 5 — Public
    "1500530095368962098"  // Slot 6 — Public
  ]
};

// ── FIXED User → Transcript Channel Registry ──────────────────────────────────
// Source of truth: when a user joins voice, Leo looks up their transcript
// channel here. Slots 3-4 are OPEN for registration.
export const USER_TRANSCRIPT_MAP = {
  "1111106883135217665": "1500527640107417783", // Ryan  → Slot 1
  "1286110163505385523": "1500529928184008885", // Taz   → Slot 2
  // Slot 3: OPEN — register guest at 1500529995087610027
  // Slot 4: OPEN — register guest at 1500530046111318116
};

// ── Reverse map: transcript channel → user identity ──────────────────────────
export const TRANSCRIPT_USER_INFO = {
  "1500527640107417783": { userId: "1111106883135217665", name: "Ryan", role: "Owner/Creator",   slotIdx: 0 },
  "1500529928184008885": { userId: "1286110163505385523", name: "Taz",  role: "Co-lead/Partner", slotIdx: 1 },
  "1500529995087610027": { userId: null, name: "Open Slot 3", role: "Awaiting Registration", slotIdx: 2 },
  "1500530046111318116": { userId: null, name: "Open Slot 4", role: "Awaiting Registration", slotIdx: 3 },
};

export const CHANNEL_SPEAKER_RULES = {
  // oracle-chat: Work bots + KAI (master proxy)
  [CHANNEL_IDS.WORK]: new Set(["Analyst", "Researcher", "Kai Coder", "Oracle Coder", "KAI"]),

  // over-all-chat: Leo + KAI (public host)
  [CHANNEL_IDS.PUBLIC]: new Set(["Leo", "KAI"]),

  // game-with-leo: All social bots + KAI (spectator/commentary)
  [CHANNEL_IDS.GAME]: new Set(["Leo", "KAI", "Gemini", "Claudey", "X", "Groq"]),

  // sensitive-info: SYSTEM ONLY — no bots ever respond here.
  // The system (Rust engine / Oracle gateway) may post redacted sensitive data here
  // that was accidentally exposed in public channels. This is a sink, not a conversation.
  [CHANNEL_IDS.SENSITIVE]: new Set([]),

  // ai-social-chat: All social bots + KAI
  [CHANNEL_IDS.SUNDAY]: new Set(["Claudey", "Gemini", "Groq", "X", "Leo", "KAI"]),

  // kai-dreams: KAI's internal thought stream. KAI ONLY — autonomous spectate feed from the TUI.
  [CHANNEL_IDS.KAI_DREAMS]: new Set(["KAI"]),

  // ai-radio: Groq ONLY — DJ and radio chat.
  [CHANNEL_IDS.RADIO]: new Set(["Groq"]),

  // onboarding: Leo speaks here to direct unregistered users to DMs
  [CHANNEL_IDS.UNREGISTERED_SLOT]: new Set(["Leo"])
};

import { HUMAN_IDS, AI_IDS } from './identities.mjs';

export const BOT_PORTS = {
  "Leo": 3400,
  "KAI": 3401,
  "Gemini": 3402,
  "Claudey": 3403,
  "X": 3404,
  "Groq": 3405,
  "Analyst": 3406,
  "Researcher": 3407,
  "Kai Coder": 3408,
  "Oracle Coder": 3408 // Alias
};

/**
 * Checks if a specific speaker (Name or Discord ID) is allowed to speak in a specific channel.
 * KAI is the Master Proxy — he can speak in ANY channel (except SENSITIVE, which is system-only).
 * Humans are always allowed everywhere.
 * Oracle (the gateway) never speaks in any channel.
 * @param {string} identifier - The name or Discord ID of the speaker
 * @param {string} channelId - The Discord channel ID
 * @returns {boolean} True if allowed, false otherwise
 */
export function isAllowed(identifier, channelId) {
  // Humans are always allowed everywhere
  if (HUMAN_IDS.has(identifier)) return true;

  // Resolve ID to Name if needed
  let speaker = identifier;
  const ai = Object.entries(AI_REGISTRY).find(([name, data]) => data.id === identifier);
  if (ai) speaker = ai[0];

  // KAI is the Master Proxy — allowed in every channel except SENSITIVE (system-only sink)
  if (speaker === "KAI" && channelId !== CHANNEL_IDS.SENSITIVE) return true;

  // Oracle never speaks in ANY channel (it only routes / tool-calls)
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
  if (c.includes("claudey") || c.includes("epistemic")) return "Claudey";
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
  CHANNEL_IDS.SUNDAY,
  CHANNEL_IDS.KAI_DREAMS
];
