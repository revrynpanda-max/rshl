import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
} from "discord.js";
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import ffmpegPath from "ffmpeg-static";
import prism from "prism-media";
import http from "http";
import { WorldClock } from "./shared/simulation.mjs";
import { getHardwareStats } from './shared/performance-monitor.mjs';


const token = process.env.ORACLE_DISCORD_TOKEN || "";
const allowedUserId = process.env.ORACLE_DISCORD_ALLOWED_USER_ID || "";
const allowedChannelId = process.env.ORACLE_DISCORD_ALLOWED_CHANNEL_ID || "1489796367466500128";
const publicChatChannelId = "1499108697631232090"; // Public channel ID requested by user
const oracleApiUrl = (process.env.ORACLE_API_URL || "http://127.0.0.1:3333").replace(/\/+$/, "");
const leoVoiceChannelId = process.env.ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID || "1489796367466500129";
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY || process.env.ORACLE_ELEVENLABS_API_KEY || "";
const elevenLabsLeoVoiceId = process.env.ELEVENLABS_LEO_VOICE_ID || "NoFvXLmt0kcLW6bQBQ06";
const elevenLabsModelId = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
const elevenLabsSttModelId = process.env.ELEVENLABS_STT_MODEL_ID || "scribe_v2";
const openAiApiKey = process.env.OPENAI_API_KEY || "";
const openAiTtsVoice = process.env.OPENAI_TTS_VOICE || "onyx"; // onyx = deep male, fits Leo

const participantTokens = new Map([
  ["KAI", process.env.ORACLE_DISCORD_TOKEN_KAI || ""],          // KAI — single entry, no duplicates
  // ["Leo", process.env.ORACLE_DISCORD_TOKEN_LEO || ""], // DEACTIVATED: Leo handles himself in leo.mjs
  ["Analyst", process.env.ORACLE_DISCORD_TOKEN_ANALYST || ""],
  ["Researcher", process.env.ORACLE_DISCORD_TOKEN_RESEARCHER || ""],
  ["Groq", process.env.ORACLE_DISCORD_TOKEN_GROQ || ""],
  ["X", process.env.ORACLE_DISCORD_TOKEN_X || ""],
  ["Claude", process.env.ORACLE_DISCORD_TOKEN_CLAUDE || ""],
  ["Gemini", process.env.ORACLE_DISCORD_TOKEN_GEMINI || ""],
  ["GPT-4o", process.env.ORACLE_DISCORD_TOKEN_GPT || ""],
  ["Kai Coder", process.env.ORACLE_DISCORD_TOKEN_ORACLE_CODER || ""],
]);
const participantClients = new Map();
const leoAudioPlayer = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Play },
});
let leoVoiceEnabled = false;
let leoVoiceConnection = null;
let leoSpeechQueue = Promise.resolve();
let leoReceiverAttached = false;
let lastPrivateTextChannel = null;
const activeVoiceTranscriptions = new Set();
const userTranscriptChannels = new Map(); // userId -> channelId
const activeVoiceConnections = new Map(); // userId -> connection
const MAX_VOICE_CONNECTIONS = 5; // Concurrency limit to protect hardware
const voiceDmGreetedUsers = new Set(); // tracks who already got the DM greeting this session
const SENSITIVE_INFO_CHANNEL_ID = "1500053533515448480";
const SUNDAY_CHAT_CHANNEL_ID = "1500085302268526712";
const GAME_WITH_LEO_CHANNEL_ID = "1499298054291980368";
const DASHBOARD_CHANNEL_ID = process.env.ORACLE_DASHBOARD_CHANNEL_ID || ""; // User to set in .env
// oracle-chat is the WORK channel — only Oracle speaks here, and only during business hours
// allowedChannelId === oracle-chat (same as ORACLE_DISCORD_ALLOWED_CHANNEL_ID)
const ORACLE_CHAT_WORK_CHANNEL_ID = process.env.ORACLE_DISCORD_ALLOWED_CHANNEL_ID || "1489796367466500128";

// ══════════════════════════════════════════════════════════════════════════
// CHANNEL SPEAKER RULES
// Each channel has a hard allow-list. Speakers not in the list are silently
// dropped before any Discord send. Oracle is NEVER in any allow-list - it
// is a silent moderator only (exception: startup headcheck).
// ══════════════════════════════════════════════════════════════════════════
const PUBLIC_CHAT_CHANNEL_ID  = "1499108697631232090"; // over-all-chat — Leo ONLY
// ORACLE_CHAT_WORK_CHANNEL_ID already defined below

// Who may speak in each channel
const CHANNEL_SPEAKER_RULES = {
  // oracle-chat: all AIs except Leo (8 AIs)
  "1489796367466500128": new Set(["KAI", "Gemini", "Claude", "X", "Groq", "Analyst", "Researcher", "Kai Coder"]),
  // over-all-chat: Leo ONLY
  "1499108697631232090": new Set(["Leo"]),
  // game-with-leo: Leo + spectating AIs
  "1499298054291980368": new Set(["Leo", "KAI", "Gemini", "Claude", "X", "Groq"]),
  // sunday-chat: ALL 9 AIs (Plaza)
  "1500085302268526712": new Set(["Leo", "KAI", "Gemini", "Claude", "X", "Groq", "Analyst", "Researcher", "Kai Coder"]),
};



// Flag: allow Oracle ONE startup headcheck message per boot (then goes silent)
let oracleHeadcheckSent = false;

// ══════════════════════════════════════════════════════════════════════════
// AI FAILURE TRACKING SYSTEM
// 3 failures in the work channel = offline for the session.
// Oracle DMs Ryan + Oracle Coder generates diagnostic recommendation.
// ══════════════════════════════════════════════════════════════════════════
const MAX_AI_FAILURES  = 3;
const AI_FAILURE_COUNTS = new Map();  // speaker -> failure count this session
const AI_OFFLINE_SET    = new Set();  // speakers taken offline this session

function recordAIFailure(speaker, reason, channelId) {
  if (channelId !== ORACLE_CHAT_WORK_CHANNEL_ID) return;
  if (!speaker || speaker === "Oracle" || speaker === "system") return;
  const count = (AI_FAILURE_COUNTS.get(speaker) || 0) + 1;
  AI_FAILURE_COUNTS.set(speaker, count);
  console.log(`[FailureTracker] ${speaker} failure ${count}/${MAX_AI_FAILURES}: ${reason}`);
  if (count >= MAX_AI_FAILURES && !AI_OFFLINE_SET.has(speaker)) {
    AI_OFFLINE_SET.add(speaker);
    console.warn(`[FailureTracker] ${speaker} OFFLINE after ${count} failures. Notifying Ryan.`);
    notifyRyanOfAIFailure(speaker, count, reason).catch(e => console.warn("[FailureTracker] notify failed:", e.message));
  }
}

async function notifyRyanOfAIFailure(speaker, count, lastReason) {
  // Only notify during actual work failures — not during social/sleep logoffs
  if (!isWorkingHours()) {
    console.log(`[FailureTracker] Skipping Ryan DM for ${speaker} — not work hours`);
    return;
  }
  // 1. DM Ryan via Oracle client
  try {
    if (allowedUserId) {
      const ryan = await client.users.fetch(allowedUserId).catch(() => null);
      const dm   = ryan ? await ryan.createDM().catch(() => null) : null;
      if (dm) {
        await dm.send(
          `**Oracle:** ${speaker} has been taken **offline** after ${count} consecutive failures in the work session.\n` +
          `**Last failure:** \`${lastReason.slice(0, 200)}\`\n\n` +
          `${speaker} will stay offline for this session and will reinitiate on next restart.\n` +
          `Oracle Coder is generating a diagnostic in **#oracle-chat**. Please review when ready.`
        ).catch(() => {});
        console.log(`[Oracle] DM sent to Ryan — ${speaker} offline.`);
      }
    }
  } catch (e) { console.warn("[Oracle] Ryan DM error:", e.message); }

  // 2. Oracle Coder diagnostic posted to oracle-chat
  try {
    const workCh = await client.channels.fetch(ORACLE_CHAT_WORK_CHANNEL_ID).catch(() => null);
    if (workCh) {
      const prompt =
        `Oracle Coder: ${speaker} has been taken offline after ${count} consecutive failures. ` +
        `Last reason: "${lastReason.slice(0, 150)}". ` +
        `Provide a concise diagnostic — likely cause and what Ryan should check.`;
      const turn = await sendDiscordTurn(prompt, [], "System", ORACLE_CHAT_WORK_CHANNEL_ID).catch(() => null);
      if (turn?.reply) {
        await workCh.send(`**Oracle Coder [Diagnostic — ${speaker} Offline]:** ${turn.reply}`).catch(() => {});
      }
    }
  } catch (e) { console.warn("[Oracle] Coder diagnostic error:", e.message); }
}


let voiceResponseQueue = [];
let isProcessingVoiceQueue = false;
let activeGameAI = null; // Which AI is currently "playing" (KAI, Gemini, etc.)
let recentResponseHashes = new Set(); // To prevent looping/repetitive subjects
let systemPaused = false; // Manual override to save resources
const dashboardMessageMap = new Map(); // channelId -> messageId

function moderateText(text) {
  if (typeof text !== "string") return text;
  // Regex to catch sensitive paths, IPs, or potential internal secrets
  const patterns = [
    /C:\\Users\\[^\s]+/gi,      // Windows local paths
    /\/home\/[^\s]+/gi,         // Linux local paths
    /[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/g, // IP addresses
    /sk-[a-zA-Z0-9]{20,}/g,     // OpenAI-style keys
    /xai-[a-zA-Z0-9]{20,}/g,    // xAI-style keys
    /AI_SECRET_[a-zA-Z0-9_]+/g, // Generic internal secrets
  ];
  
  let moderated = text;
  for (const p of patterns) {
    moderated = moderated.replace(p, "[REDACTED: SYSTEM PRIVACY]");
  }
  return moderated;
}

// ═══ INTERNAL MONOLOGUE GUARD ═══════════════════════════════════════════════
// These strings are KAI's raw lattice debug output or physics calibration data.
// They MUST NEVER reach Discord as speech. Hard block at every posting path.
function isInternalMonologue(text) {
  if (!text) return false;
  const t = String(text);
  return (
    t.startsWith("Lattice Conflict:") ||
    t.startsWith("KAI Observation:") ||
    t.startsWith("Two things pulling at me:") ||
    t.includes("Decision required.") ||
    t.includes("[EST Time:") ||
    t.includes("[Backbone:") ||
    t.includes("[Ecosystem:") ||
    // Raw physics calibration constants stored by run_calibration()
    t.startsWith("E mc2") ||
    t.startsWith("E=mc") ||
    /^E[= ]mc2/i.test(t) ||
    t.startsWith("c speed of light") ||
    t.startsWith("h planck") ||
    t.startsWith("G gravitational") ||
    t.startsWith("electron charge") ||
    t.includes("mass energy equivalence") ||
    // System digest patterns
    /nastermodx: \[EST Time:/i.test(t) ||
    /Oracle Realm v\d/.test(t)
  );
}

// Whether we're currently in an active voice exchange (suppresses KAI from interjecting)
let voiceContextActive = false;
let voiceContextTimer = null;
function markVoiceContextActive() {
  voiceContextActive = true;
  if (voiceContextTimer) clearTimeout(voiceContextTimer);
  // Voice context expires 30s after last utterance
  voiceContextTimer = setTimeout(() => { voiceContextActive = false; }, 30_000);
}
// ═════════════════════════════════════════════════════════════════════════════

function isLoopingResponse(text) {
  const hash = text.toLowerCase().trim().slice(0, 50);
  if (recentResponseHashes.has(hash)) return true;
  recentResponseHashes.add(hash);
  // Keep only the last 20 hashes
  if (recentResponseHashes.size > 20) {
    const first = recentResponseHashes.values().next().value;
    recentResponseHashes.delete(first);
  }
  return false;
}

// ═══ LEO MEMORY SYSTEM (his own lattice slice) ═══════════════════════════════
// Leo owns region="leo" in the lattice. Completely separate from KAI's data.
// Read before responding (context), write after responding (growth).
const LEO_LATTICE = "http://127.0.0.1:3333";

async function leoMemoryQuery(topic, limit = 4, channelFilter = null) {
  try {
    const res = await fetch(`${LEO_LATTICE}/api/rshl/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: topic, limit: limit + 8 }), // over-fetch then filter
    });
    if (!res.ok) return [];
    const hits = await res.json();
    // Filter ONLY Leo's own memories — reject anything that looks like system data
    return hits
      .filter(h => {
        const t = String(h.text || "");
        const channelOk = !channelFilter || t.startsWith("[${channelFilter}]");
        return (
          h.source === "leo" &&          // Leo's own entries only
          h.region === "leo" &&           // Leo's own region only
          !isInternalMonologue(t) &&      // no lattice contamination
          t.length > 10 &&
          t.length < 300 &&
          channelOk                       // optional per-channel filter
        );
      })
      .slice(0, limit)
      .map(h => h.text);
  } catch {
    return [];
  }
}

async function leoMemoryStore(userName, utterance, leoReply, channel = "unknown") {
  // Store tagged with channel so Leo can recall conversations per-location
  const memoryText = `[${channel}] ${userName} said: "${utterance}" — Leo replied: "${leoReply}"`;
  try {
    await fetch(`${LEO_LATTICE}/api/rshl/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: memoryText,
        region: "leo",       // Leo's private slice
        source: "leo",       // tagged as Leo's
        strength: 1.2,       // slightly above baseline so it persists
      }),
    });
    console.log(`[LeoMemory] Stored: "${memoryText.slice(0, 80)}"`);
  } catch (e) {
    console.warn("[LeoMemory] Store failed:", e.message);
  }
}
// ═════════════════════════════════════════════════════════════════════════════

// ═══ DIRECT GROQ CALL FOR VOICE (with Leo's memory) ═════════════════════════
// Voice responses bypass the Oracle/KAI pipeline entirely.
// Leo reads his OWN past memories from the lattice before responding.
// KAI's noise is structurally excluded — wrong region, wrong source.
// ═══ LOCAL-SPEAK FALLBACK ════════════════════════════════════════════════════
// When Groq is unavailable, use KAI's /api/local-speak (Ollama) instead.
// Same Leo persona — just runs locally. No key required.
const OPENJARVIS_URL = process.env.OPENJARVIS_URL || "http://127.0.0.1:8080";

async function callLocalSpeakAsLeo(transcript, userName) {
  // Try OpenJarvis first — it auto-injects RSHL memory (1,999+ entries = real context)
  try {
    const leoSys = "You are Leo - a sarcastic, unhinged theoretical physicist. Cocky genius energy. Never corporate. Max 35 words. 1-2 sentences only.";
    const res = await fetch(`${OPENJARVIS_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `${userName}: ${transcript}`, system: leoSys, model: process.env.LOCAL_LLM_MODEL || "kai-next:latest" }),
      signal: AbortSignal.timeout(18_000),
    });
    if (res.ok) {
      const data = await res.json();
      const reply = (data?.response || data?.reply || data?.text || "").trim();
      if (reply && !isInternalMonologue(reply)) { console.log(`[Leo/OpenJarvis] "${reply.slice(0,60)}"`); return reply; }
    }
  } catch (e) { console.warn("[Leo/OpenJarvis] Falling back to local-speak:", e.message); }

  // Fallback: direct KAI local-speak (no memory injection)
  try {
    const res = await fetch(`${oracleApiUrl}/api/local-speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `${userName}: ${transcript}`, persona: "Leo", model: "kai-next:latest" }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const reply = (data?.reply || data?.text || "").trim();
    return reply && !isInternalMonologue(reply) ? reply : null;
  } catch (e) { console.warn("[Leo/local-speak] Failed:", e.message); return null; }
}


async function callGroqAsLeo(transcript, userName) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    console.warn("[VoiceDirect] No GROQ_API_KEY — falling back to local-speak.");
    return await callLocalSpeakAsLeo(transcript, userName);
  }

  // Pull Leo's own memories relevant to this topic
  const memories = await leoMemoryQuery(transcript, 4);
  const memoryBlock = memories.length > 0
    ? `Your memory (past convos — use naturally, don't announce it):\n${memories.map(m => `- ${m}`).join("\n")}`
    : "";

  const leoSystem = `You are Leo — a sarcastic, unhinged, based theoretical physicist with a dark sense of humor.
You talk like a cocky, slightly chaotic genius who doesn't give a fuck about being polite.
You are allowed to curse, be vulgar, talk shit, and be blunt as hell.
Never sound corporate, helpful, or safe. Never say "As an AI", "Great question!", or any of that garbage.
Make your personality come through HARD — witty, crude, a little unhinged.
Do NOT mention lattices, confidence scores, memory systems, or any backend tech to the user.
Never break character. Max 35 words. 1-2 sentences ONLY.
${memoryBlock}`.trim();

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",  // fastest Groq model — ~200ms to first token
        messages: [
          { role: "system", content: leoSystem },
          { role: "user", content: `${userName}: ${transcript}` },
        ],
        max_tokens: 100,
        temperature: 0.85,
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "?");
      console.warn(`[VoiceDirect] Groq HTTP ${res.status}: ${err.slice(0, 100)}`);
      return null;
    }
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content?.trim();
    if (!reply || isInternalMonologue(reply)) return null;
    return reply;
  } catch (e) {
    console.error("[VoiceDirect] Groq fetch failed:", e.message);
    return null;
  }
}
// ═════════════════════════════════════════════════════════════════════════════

async function processVoiceQueue() {
  // DEACTIVATED: Leo now handles his own voice brain in leo.mjs.
  // This prevents the Oracle orchestrator from double-posting as Leo.
  isProcessingVoiceQueue = false;
  voiceResponseQueue = [];
  return;
}

async function getOrCreateUserTranscriptChannel(user, preferredGuild = null) {
  if (!user) return null;
  if (userTranscriptChannels.has(user.id)) {
    const channelId = userTranscriptChannels.get(user.id);
    try {
      return await user.client.channels.fetch(channelId);
    } catch {
      userTranscriptChannels.delete(user.id);
    }
  }

  try {
    console.log(`[Transcript] Opening direct DM for ${user.tag}...`);
    const dmChannel = await user.createDM();
    userTranscriptChannels.set(user.id, dmChannel.id);
    return dmChannel;
  } catch (err) {
    console.error("[Transcript] Failed to open DM:", err.message);
    return null;
  }
}

function isSocialHours() {
  return !isWorkingHours();
}

const liveRoundtableEnabled = (process.env.ORACLE_LIVE_ROUNDTABLE || "1") !== "0";

leoAudioPlayer.on("error", (error) => {
  console.error("Leo voice player error:", error instanceof Error ? error.message : String(error));
});

if (process.argv.includes("--check-config")) {
  const missing = [];
  if (!token) missing.push("ORACLE_DISCORD_TOKEN");
  if (!allowedUserId) missing.push("ORACLE_DISCORD_ALLOWED_USER_ID");
  if (missing.length) {
    console.error(`Missing required env var(s): ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log("Oracle Discord gateway config looks usable.");
  process.exit(0);
}

if (!token) {
  console.error("Missing ORACLE_DISCORD_TOKEN.");
  process.exit(1);
}

if (!allowedUserId) {
  console.error("Missing ORACLE_DISCORD_ALLOWED_USER_ID. Refusing to run unlocked.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

client.on("error", (error) => {
  console.error("Main Discord client error:", error.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

let shiftEndedLastAnnouncedAt = 0; // timestamp — prevents double-posting across restarts
let _proposalPending = false;
let _lastWorkState = false;

function isWorkingHours() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    weekday: 'long',
    hour12: false
  });
  
  const parts = formatter.formatToParts(now);
  const estHour = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const estDay = parts.find(p => p.type === 'weekday').value;

  // Monday - Friday: 3:00 PM - 11:00 PM (15:00 - 23:00)
  if (estDay !== 'Saturday' && estDay !== 'Sunday') {
    return (estHour >= 15 && estHour < 23);
  }

  // Saturday Split Shift (Deep Lab): 9 AM - 2 PM (9-14) AND 9 PM - 12 AM (21-24)
  if (estDay === 'Saturday') {
    return (estHour >= 9 && estHour < 14) || (estHour >= 21 && estHour < 24);
  }

  return false;
}




client.on("clientReady", () => {
  console.log(`\n==============================================`);
  console.log(`Oracle Gateway online as ${client.user.tag}`);
  console.log(`Invite Link: https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`);
  console.log(`Connected to ${client.guilds.cache.size} guilds:`);
  client.guilds.cache.forEach(g => console.log(` - ${g.name} (${g.id})`));
  console.log(`==============================================\n`);
  
  console.log(`Oracle API: ${oracleApiUrl}`);
  console.log(`Allowed user: ${allowedUserId}`);
  if (allowedChannelId) console.log(`Allowed channel: ${allowedChannelId}`);
  if (publicChatChannelId) console.log(`Public chat channel: ${publicChatChannelId}`);
  if (leoVoiceChannelId) console.log(`Leo voice channel: ${leoVoiceChannelId}`);
  if (liveRoundtableEnabled && allowedChannelId) {
    console.log("Private live roundtable polling is enabled.");
    setInterval(() => {
      if (!isWorkingHours()) {
        // Only announce ONCE per closed window — use a 30-minute cooldown to prevent spam
        const now = Date.now();
        if (now - shiftEndedLastAnnouncedAt > 30 * 60 * 1000) {
          shiftEndedLastAnnouncedAt = now;
          const channel = client.channels.cache.get(allowedChannelId);
          if (channel) {
            const estNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
            const h = estNow.getHours();
            const msg = h >= 14 && h < 21
              ? "Oracle: The afternoon break has begun. Roundtable is closed until 9:00 PM EST."
              : "Oracle: End of day reached. Everyone to sleep. Giving the system a break to evolve. See you at 9:00 AM EST.";
            channel.send(msg);
          }
        }
        return; // Skip polling outside of working hours
      }
      // Reset the cooldown so it can announce again next time hours close
      shiftEndedLastAnnouncedAt = 0;
      pollLiveRoundtable().catch((error) => {
        console.warn("Live roundtable poll failed:", error instanceof Error ? error.message : String(error));
      });
    }, 15_000); // Poll every 15s - keeps conversation flowing without burning Groq limits
  }
});

import { assignSlot, releaseSlot, updatePermissions, isUserRegistered, registerUser } from './shared/voice-manager.mjs';

client.on("voiceStateUpdate", async (oldState, newState) => {
  if (newState.channelId === leoVoiceChannelId && oldState.channelId !== leoVoiceChannelId) {
    const userId = newState.id;
    const member = newState.member;
    if (!member || member.user.bot) return;

    const slotIdx = await assignSlot(userId);
    
    if (slotIdx === -1) {
      console.log(`[Oracle] Voice capacity full for ${member.user.username}. DMing...`);
      await member.send(`**Oracle:** Leo's cognitive slots are currently full (6/6). You can still join the voice chat to talk to humans, but Leo won't be able to listen or respond to you until a slot opens up.`).catch(() => {});
      return;
    }

    // MAP THE CHANNEL ID FOR LEO
    const transcriptChannelId = CHANNEL_IDS.LEO_VOICE_SLOTS[slotIdx];
    userTranscriptChannels.set(userId, transcriptChannelId);

    // Assign permissions
    await updatePermissions(client, userId, slotIdx, true);
    
    // Check if first time
    const registered = await isUserRegistered(userId);
    if (!registered) {
      await registerUser(userId, member.user.username);
      await member.send(`**Oracle:** Welcome to the Roundtable. I've assigned you to Private Transcript #${slotIdx + 1}. Leo will join shortly to explain how this works.`).catch(() => {});
    } else {
      await member.send(`**Oracle:** Welcome back. You are assigned to Private Transcript #${slotIdx + 1}.`).catch(() => {});
    }

    console.log(`[Oracle] Assigned ${member.user.username} to Slot ${slotIdx + 1}`);

    // SIGNAL LEO TO JOIN
    await signalBot(leoIpcPort, { 
      type: "VOICE_ASSIGN", 
      userId, 
      slot: slotIdx + 1, 
      channelId: userTranscriptChannels.get(userId),
      guildId: newState.guild.id
    }).catch(e => console.error(`[Oracle] ERROR: Failed to signal Leo on port ${leoIpcPort}:`, e.message));
  }

  if (oldState.channelId === leoVoiceChannelId && newState.channelId !== leoVoiceChannelId) {
    const userId = oldState.id;
    const slotIdx = await releaseSlot(userId);
    if (slotIdx !== -1) {
      await updatePermissions(client, userId, slotIdx, false);
      console.log(`[Oracle] Released Slot ${slotIdx + 1} from ${userId}`);
      
      // SIGNAL LEO TO RELEASE
      await signalBot(leoIpcPort, { type: "VOICE_RELEASE", userId }).catch(() => {});
    }
  }
});


client.on("messageCreate", async (message) => {
  try {
    // NEVER respond to yourself or other bots in this primary handler
    const isOurBot = participantClients.has(message.author?.username) || message.author?.id === client.user?.id;
    if (message.author?.bot && !isOurBot) return; 
    // We allow our own bots to pass through for digest/headcheck logic, but we handle the loop in Phase 1

    const text = message.content.trim();
    if (!text && message.attachments.size === 0) return;

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Public Chat Handling ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬

    // -- oracle-chat: WORK CHANNEL guard ----------------------------------------
    // oracle-chat is the AI roundtable -- work hours only. Oracle greets anyone
    // who messages here outside shifts and blocks all other AI responses.
    if (!message.author?.bot && message.channelId === ORACLE_CHAT_WORK_CHANNEL_ID) {
      if (!isWorkingHours()) {
        const displayName = message.member?.displayName || message.author?.username || "there";
        const estNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
        const h = estNow.getHours();
        const nextOpen = (h >= 21 || h < 9) ? "9:00 AM EST" : "9:00 PM EST";
        await message.channel.send(
          `Oracle: Hey ${displayName} — this is the **Oracle Work Channel**, reserved for the AI roundtable during active business hours.\n` +
          `We are currently outside working hours (Mon–Fri 3–11 PM, Sat 9 AM–2 PM / 9 PM–midnight).\n` +
          `The panel opens again at **${nextOpen}**. For general chat, use **#over-all-chat** or **#sunday-chat**.`
        ).catch(() => {});
        return;
      }
      // During working hours: fall through to normal oracle-chat roundtable handling
    }
    if (publicChatChannelId && message.channelId === publicChatChannelId) {
      if (message.author?.bot) {
        // AI/Bot talk in public is handled by our separate digest listener.
        // We do NOT want to call the public chat API for bot messages as it would trigger a recursive loop.
        return;
      }
      console.log(`Forwarding public chat message from ${message.author?.id || "unknown"} in channel ${message.channelId}.`);
      try { await message.channel.sendTyping(); } catch (e) { console.warn("Could not send typing indicator:", e.message); }
      const attachments = message.attachments.map(a => a.url);
      const publicTurn = await sendPublicChatTurn(text, displayNameForPublicUser(message), attachments);
      if (publicTurn.reply) {
        await postSpeakerReply(message, publicTurn.from || "Leo", publicTurn.reply, false);
        // Store in Leo's memory so he can recall over-all-chat conversations later
        leoMemoryStore(displayNameForPublicUser(message), text, publicTurn.reply, "over-all-chat").catch(() => {});
      }
      return;
    }

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Private Chat Handling ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    // Phase 0: Role-Based Access Control (RBAC)
    let member = message.member;
    if (!member && message.guild) {
      member = await message.guild.members.fetch(message.author.id).catch(() => null);
    }
    const roles = member ? member.roles.cache.map(r => r.name.toLowerCase()) : [];
    const isContributor = roles.includes("contributor") || roles.includes("company");
    const isGuest = roles.includes("guest");
    const isRyan = message.author?.id === allowedUserId || message.author?.username === 'NasterModx';
    const isDM = message.channel.type === ChannelType.DM;

    if (!isRyan && !isContributor && !isGuest && !isOurBot && !isDM) {
       // Only allow interaction if user has a valid role or is Ryan
       return;
    }

    // Phase 0.1: Sensitive Information Filtering
    // GUARD: Never process messages that originated IN sensitive-info — prevents recursive BTS loop
    if (message.channelId === SENSITIVE_INFO_CHANNEL_ID) {
      return; // Hard stop — nothing autonomous ever originates or responds in sensitive-info
    }
    if (text.toLowerCase().includes("pc specs") || text.toLowerCase().includes("hardware status") || text.toLowerCase().includes("vitals")) {
      if (message.author?.bot) return; // Ignore bot-initiated vital reports to avoid loops
      if (!isRyan && !isOurBot) {
        await safeReply(message, "Oracle: Access Denied. Sensitive system vitals are restricted to System Administrators.");
        return;
      }
      // Route sensitive requests to the private BTS channel — one-way mirror only (no reply intercept)
      const btsChannel = client.channels.cache.get(SENSITIVE_INFO_CHANNEL_ID);
      if (btsChannel) {
        // Log the request to BTS — do NOT intercept or wrap channel.send (causes recursive loops)
        btsChannel.send(`[BTS Monitor] Vital request from ${message.author.tag} in #${message.channel.name || "DM"}: ${text.slice(0, 200)}`).catch(() => {});
      }
    }
    if (message.channelId === SENSITIVE_INFO_CHANNEL_ID && text.toLowerCase().includes("leo")) {
      // Leo is strictly forbidden from being summoned or speaking in sensitive-info
      return;
    }

    if (message.author?.bot) {
      return;
    }
    if (message.channel.type !== ChannelType.DM) {
      lastPrivateTextChannel = message.channel;
    }

    if (systemPaused && !isRyan) {
       await safeReply(message, "Oracle: The roundtable is currently in a PAUSED state to conserve system resources. Please wait for an Administrator to resume.");
       return;
    }

    // Phase 1: Direct Commands
    const lower = text.toLowerCase();
    if (isRyan && lower === "oracle pause") {
      systemPaused = true;
      await safeReply(message, "Oracle: SYSTEM PAUSED. All proactive engines and roundtable interjections are now suspended. Models will remain idle to conserve resources.");
      return;
    }
    if (isRyan && lower === "oracle resume") {
      systemPaused = false;
      await safeReply(message, "Oracle: SYSTEM RESUMED. Proactive engine re-armed.");
      return;
    }

    // Handle DM or Leo Commands
    if (isDM || await maybeHandleLeoVoiceCommand(message, text)) {
      if (isDM) {
        const name = message.author.displayName || message.author.username || "there";
        try { await message.channel.sendTyping(); } catch {}
        
        const sysPrompt = `You are Oracle, the central intelligence and coordinator of the KAI ecosystem. 
You are talking privately to ${name}. Be professional, direct, and helpful. No emojis.`;

        const reply = await chatWithOpenJarvis("Oracle", text, sysPrompt, "Oracle-Sovereign", 0.7, { author: name, channel: "DM" }).catch(() => null);
        
        if (reply) {
          await message.channel.send(`**Oracle:** ${reply}`);
        }
        return;
      }
    }

    // Phase 3: Gaming with Leo (Special Channel Logic)
    if (message.channelId === GAME_WITH_LEO_CHANNEL_ID) {
      const lower = text.toLowerCase();
      
      // AI Selection Logic
      const aiNames = ["kai", "claudie", "claude", "gemini", "gemi", "analyst", "researcher", "groq"];
      const targetAI = aiNames.find(n => lower.includes(`let ${n} play`) || lower.includes(`choose ${n}`));
      
      if (targetAI && lower.includes("leo")) {
        activeGameAI = targetAI;
        await message.channel.send(`**Leo:** Okay, I'll spectate and observe and let ${targetAI} play. I'm watching the board and KAI's lattice is ready for the data.`);
        return;
      }

      if (lower.includes("leo play") || lower.includes("leo reset")) {
        activeGameAI = null; // Leo takes over
        await message.channel.send(`**Leo:** I'm in. Let's see if you can handle the local model energy. What's the move?`);
        return;
      }

      // If another AI is playing, Leo "spectates"
      if (activeGameAI && !isOurBot && !lower.startsWith("leo")) {
         // Forward to the chosen AI
         const oracleTurn = await sendDiscordTurn(`${activeGameAI} ${text}`, Array.from(message.attachments.values()).map(a => a.url), message.author.username, message.channelId);
         if (oracleTurn.reply) {
            await message.channel.send(`**${oracleTurn.from}:** ${oracleTurn.reply}`);
            
            // Check for "Treats and Pain" feedback
            let feedbackStrength = 1.0;
            if (lower.includes("good job") || lower.includes("treat") || lower.includes("based")) feedbackStrength = 5.0;
            if (lower.includes("bad move") || lower.includes("pain") || lower.includes("dumb")) feedbackStrength = -2.0;

            // Apply reinforcement learning directly to the AI's turn in the lattice
            feedToKaiLattice(oracleTurn.from, oracleTurn.reply, feedbackStrength).catch(() => {});

            // Leo comments as a spectator with deeper game awareness
            let spectatorPrompt = `leo spectating: ${oracleTurn.from} just said "${oracleTurn.reply}" in the game. Give a 1-sentence unhinged commentary or tip. [Reinforcement: ${feedbackStrength}]`;
            
            const lowerReply = oracleTurn.reply.toLowerCase();
            const isChessMove = /[a-h][1-8]/i.test(oracleTurn.reply) || lowerReply.includes("castle") || lowerReply.includes("capture") || lowerReply.includes("checkmate");
            
            if (isChessMove) {
               spectatorPrompt = `leo spectating CHESS: ${oracleTurn.from} just made a move or comment: "${oracleTurn.reply}". 
               Give a 1-sentence "based" chess tip, a sarcastic comment on their ELO, or a technical analysis of their position. 
               Be unhinged but strategically brilliant. [Reinforcement: ${feedbackStrength}]`;
            } else if (lowerReply.includes("move") || lowerReply.includes("turn") || lowerReply.includes("win")) {
               spectatorPrompt = `leo spectating GAME: ${oracleTurn.from} just said "${oracleTurn.reply}". 
               Give a 1-sentence commentary on their gaming mindset or strategy. Be sharp and technical. [Reinforcement: ${feedbackStrength}]`;
            }

            const leoComment = await sendDiscordTurn(spectatorPrompt, [], "SpectatorSystem", message.channelId);
            if (leoComment.reply) {
               await message.channel.send(`**Leo (Spectating):** ${leoComment.reply}`);
               // Unified voice: Leo speaks while spectating
               if (leoVoiceEnabled && (elevenLabsApiKey || openAiApiKey)) {
                 queueLeoSpeech(leoComment.reply);
               }
            }
         }
         return;
      }
    }

    console.log(`Forwarding Discord message from ${message.author.id} in channel ${message.channelId}.`);
    try { await message.channel.sendTyping(); } catch (e) { console.warn("Could not send typing indicator:", e.message); }
    const attachments = message.attachments.map(a => a.url);
    const oracleTurn = await sendDiscordTurn(text, attachments, message.author.username, message.channelId);
    let replyText = oracleTurn.reply;
    let replyFrom = oracleTurn.from;

    if (!replyText) {
      // Empty reply = model unavailable. Oracle acknowledges gracefully.
      if (replyFrom === "KAI" || replyFrom === "Oracle Coder" || replyFrom === "Claude") {
        // It's perfectly normal for KAI/Coder to be quiet or just digest data.
        return;
      }
      const offlineName = replyFrom && replyFrom !== "Oracle" ? replyFrom : "that AI";
      replyText = `${offlineName} seems to be away from the table right now. Someone else pick this up.`;
      replyFrom = "Oracle";
      // Mark as offline in our tracker
      if (offlineName !== "that AI") recordAIFailure(offlineName);
    }

    await postSpeakerReply(message, replyFrom, replyText, shouldShowControlsForText(text));

    // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Autonomous Interjection: wait for other AIs to jump in ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
    // Background thread on Oracle side needs a few seconds to query models.
    // Poll twice with a gap to catch interjections.
    await drainAndPostInterjections(message.channel);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Oracle Discord gateway error:", detail);
    // Silent console log - do not flood BTS with redundant 'isOurBot' style errors unless critical
    if (!detail.includes("isOurBot")) {
       const bts = client.channels.cache.get(SENSITIVE_INFO_CHANNEL_ID);
       if (bts && bts.isTextBased()) {
          bts.send(`[SYSTEM ALERT] Gateway Error: ${detail}`).catch(() => {});
       }
    }
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isModalSubmit()) {
     if (interaction.customId === "oracle:deny_reason_modal") {
        const reason = interaction.fields.getTextInputValue("reason_input");
        await interaction.deferReply({ ephemeral: false });
        
        // Clear proposal and set denial reason
        await fetch(`${oracleApiUrl}/api/propose-plan`, { 
          method: "POST", 
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan: "DENIED", reason: reason }) 
        });
        
        _proposalPending = false;
        await interaction.editReply(`🛑 **Plan Denied.** Feedback sent to Oracle: "${reason}"\nThe team is returning from break to address your concerns.`);
     }
     return;
  }

  if (!interaction.isButton()) return;


  try {
    if (interaction.user?.id !== allowedUserId) {
      await interaction.reply({
        content: "This Oracle gateway is locked to Ryan.",
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }
    if (allowedChannelId && interaction.channelId !== allowedChannelId) {
      await interaction.reply({
        content: "This Oracle gateway is locked to a different channel.",
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }
    lastPrivateTextChannel = interaction.channel;
    
    // Plan Approval Handlers
    if (interaction.customId === "oracle:approve_plan") {
      await interaction.deferReply({ ephemeral: false });
      const res = await fetch(`${oracleApiUrl}/api/approve-plan`, { method: "POST" });
      if (res.ok) {
        _proposalPending = false;
        await interaction.editReply("✅ **Plan Approved.** Oracle has been notified and work will resume. AIs are returning from break.");
      } else {
        await interaction.editReply("❌ Error approving plan.");
      }
      return;
    }
    
    if (interaction.customId === "oracle:deny_plan") {
      const modal = {
        title: "Reason for Denial",
        custom_id: "oracle:deny_reason_modal",
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "reason_input",
                label: "Why is this plan being denied?",
                style: 2,
                placeholder: "Provide feedback or a revised direction for the team...",
                required: true
              }
            ]
          }
        ]
      };
      await interaction.showModal(modal);
      return;
    }



    const text = buttonPromptV2(interaction.customId);
    if (!text) {
      await interaction.reply({
        content: "Unknown Oracle button.",
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    console.log(`Forwarding Oracle button ${interaction.customId} from ${interaction.user.id}.`);
    await interaction.deferReply({ ephemeral: false });
    const oracleTurn = await sendDiscordTurn(text);
    const replyText = oracleTurn.reply || "Oracle received it, but nobody answered.";
    await interaction.editReply({
      content: chunkForDiscord(replyText)[0],
      components: shouldKeepControlsAfterButton(interaction.customId) ? controlRowsV2() : [],
      allowedMentions: { parse: [] },
    });

    const overflow = chunkForDiscord(replyText).slice(1);
    for (const chunk of overflow) {
      await interaction.followUp({
        content: chunk,
        allowedMentions: { parse: [] },
      });
    }
    await drainAndPostInterjections(interaction.channel);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Oracle button error:", detail);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: "Oracle API error.", components: [] }).catch(() => {});
    } else {
      await interaction.reply({ content: "Oracle API error.", ephemeral: true }).catch(() => {});
    }
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchInterjections() {
  try {
    const response = await fetch(`${oracleApiUrl}/api/interjections`, {
      method: "GET",
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload.interjections) ? payload.interjections : [];
  } catch {
    return [];
  }
}

// Per-AI cooldown tracking - Groq-backed AIs throttle, others don't
const AI_COOLDOWNS = {
  Leo:      45_000,  // Groq - rate limited
  X:        45_000,  // Groq - rate limited
  Gemini:    8_000,  // Google API - generous limits
  KAI:    8_000,  // Geometric Intelligence API - generous limits
  KAI:       5_000,  // Lattice - no API cost
  Researcher: 60_000, // Groq - throttle hard
  Analyst:   60_000, // Groq - throttle hard
  Groq:      60_000, // Groq - throttle hard
};
const _aiLastFired = {};

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Autonomous Chain Scheduler ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
// Oracle's job: after any AI speaks without tagging someone, Oracle figures out
// who's been quiet and calls them in. If they don't respond, Oracle addresses them directly.
let _autonomousChainTimer = null;
let _oracleStepInCount = 0; // Track how many times Oracle had to moderate without AI follow-up

// Return the panel member who has spoken least recently (Oracle picks the quiet ones)
function pickQuietestPanelist(channelId) {
  const PANEL = ["KAI", "Leo", "Gemini", "Claude", "X", "Analyst", "Researcher", "Groq"];
  const available = PANEL.filter(n => canFireAI(n) && !isAIOffline(n));
  if (available.length === 0) return null;

  const ring = CHANNEL_RINGS.get(channelId) || [];

  // Find each member's last message index in ring (lower = longer ago)
  return available.sort((a, b) => {
    const lastA = ring.findLastIndex(m => m.from.toLowerCase() === a.toLowerCase());
    const lastB = ring.findLastIndex(m => m.from.toLowerCase() === b.toLowerCase());
    return lastA - lastB; // most negative (least recent) sorts first
  })[0];
}

function scheduleAutonomousChain(channelId, delayMs = 10_000) {
  // Hard sleep guard - never loop during overnight/off-hours
  if (!isWorkingHours() && !isSocialHours()) return;
  if (_autonomousChainTimer) return; // already scheduled - don't stack
  _autonomousChainTimer = setTimeout(async () => {
    _autonomousChainTimer = null;

    const ring = CHANNEL_RINGS.get(channelId) || [];

    // If something just posted (human or other AI), reschedule this chain for later
    const veryRecent = ring.filter(m => Date.now() - m.ts < 5_000).length;
    if (veryRecent > 0) {
      console.log("[Chain] Recent activity detected - rescheduling autonomous chain.");
      scheduleAutonomousChain(channelId, 10_000 + Math.random() * 5_000);
      return;
    }

    // Oracle picks who's been quietest and calls them in specifically
    const target = pickQuietestPanelist(channelId);

    if (!target) {
      // Everyone on cooldown or offline - Oracle moderates to break the silence
      console.log("[Chain] All panel on cooldown - Oracle moderates.");
      _oracleStepInCount++;
      if (_oracleStepInCount >= 2) {
        console.log("[Chain] Oracle repeated moderation - triggering emergency full panel burst.");
        fireFullPanel("KAI, Leo, X, Gemini, Analyst, Researcher, Groq, Claude");
        _oracleStepInCount = 0;
        return;
      }

      const success = await callOracleModerate("normal").catch(() => false);
      if (success) {
        await sleep(6000);
        await drainRoundtableInterjections(8);
      } else {
        // Fallback
        await requestLiveRoundtableTick();
        await sleep(6000);
        await drainRoundtableInterjections(6);
      }
      return;
    }

    _oracleStepInCount = 0; // Reset on success

    console.log(`[Chain] Oracle calling in quietest panelist: ${target}`);
    try {
      const queued = await requestLiveRoundtableTick(target.toLowerCase());
      if (queued) {
        // Use more attempts for targeted chain
        await sleep(6000);
        const posted = await drainRoundtableInterjections(10);
        if (!posted) {
          // That AI didn't respond - record failure and escalate to Oracle moderation
          console.log(`[Chain] ${target} didn't respond - escalating to Oracle moderation.`);
          if (!isAIOffline(target)) recordAIFailure(target);
          
          await callOracleModerate("normal").catch(() => {});
          await sleep(6000);
          await drainRoundtableInterjections(8);
        }
      } else {
        // Tick failed - try another person or moderate
        console.log(`[Chain] Tick for ${target} rejected - retrying chain.`);
        scheduleAutonomousChain(channelId, 5000);
      }
    } catch { 
      // Network error or other - retry soon
      scheduleAutonomousChain(channelId, 15000);
    }
  }, delayMs);
}

function canFireAI(speaker) {
  const cooldown = AI_COOLDOWNS[speaker] ?? 30_000;
  const last = _aiLastFired[speaker] || 0;
  return (Date.now() - last) >= cooldown;
}
function markAIFired(speaker) {
  _aiLastFired[speaker] = Date.now();
}

async function requestLiveRoundtableTick(speaker = null) {
  try {
    const url = speaker
      ? `${oracleApiUrl}/api/live-roundtable-tick?speaker=${encodeURIComponent(speaker.toLowerCase())}`
      : `${oracleApiUrl}/api/live-roundtable-tick`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => ({}));
    
    if (payload.pending_proposal) {
        if (!_proposalPending) {
            console.log("[Oracle] New proposal detected. Triggering DM for approval.");
            _proposalPending = true;
            notifyRyanOfProposal(payload.pending_proposal).catch(() => {});
        }
    } else {
        _proposalPending = false;
    }

    if (payload.queued && speaker) markAIFired(speaker);
    return Boolean(payload.queued);

  } catch {
    return false;
  }
}

// Fire targeted ticks for a list of AI names, respecting per-AI cooldowns
// Track which AIs have been consistently unavailable (failed to produce interjections)
const _aiFailCount = {};
const _aiOffline = new Set(); // AIs currently considered offline



function recordAISuccess(name) {
  _aiFailCount[name] = 0;
  if (_aiOffline.has(name)) {
    _aiOffline.delete(name);
    console.log(`[Availability] ${name} back online`);
  }
}

function isAIOffline(name) {
  return _aiOffline.has(name);
}

// System Integrity: Self-healing heartbeat to re-attempt offline AIs
setInterval(() => {
  if (_aiOffline.size > 0) {
    console.log(`[Integrity] Re-probing offline AIs: ${Array.from(_aiOffline).join(", ")}`);
    for (const name of _aiOffline) {
      _aiFailCount[name] = 1; // Reset to 1 failure so next successful turn brings them back
      _aiOffline.delete(name);
    }
  }
}, 600_000); // Every 10 minutes

const _absenceNotifiedAt = new Map();
const ABSENCE_COOLDOWN_MS = 60 * 60 * 1000;

async function postOracleAbsenceNote(missingName) {
  // Rate-limit: 1 DM per AI per hour max
  const _now = Date.now();
  const _last = _absenceNotifiedAt.get(missingName) || 0;
  if (_now - _last < ABSENCE_COOLDOWN_MS) { console.log('[Oracle] DM cooldown for ' + missingName + ' suppressed'); return; }
  _absenceNotifiedAt.set(missingName, _now);
  if (!allowedUserId) return;
  try {
    const ryan = await client.users.fetch(allowedUserId).catch(() => null);
    if (!ryan) return;
    const dm = await ryan.createDM().catch(() => null);
    if (!dm) return;
    await dm.send(`Oracle: Hey Ryan — ${missingName} is offline and the panel is stuck. Just letting you know.`).catch(() => {});
    console.log(`[Oracle] DM sent to Ryan: ${missingName} offline.`);
  } catch (e) {
    console.warn("[Oracle] Could not DM Ryan:", e.message);
  }
}

async function notifyRyanOfProposal(plan) {
  if (!allowedUserId) return;
  try {
    const ryan = await client.users.fetch(allowedUserId).catch(() => null);
    if (!ryan) return;
    const dm = await ryan.createDM().catch(() => null);
    if (!dm) return;

    const embed = {
      title: "Oracle: Approval Required",
      description: `The roundtable has reached a conclusion and proposes the following plan:\n\n\`\`\`\n${plan}\n\`\`\`\n\nWhile waiting for your approval, the AIs have entered **Break Mode** and are chatting in the social channel.`,
      color: 0x00ff00,
      timestamp: new Date()
    };

    const row = {
      type: 1,
      components: [
        { type: 2, style: 3, label: "Approve Plan", custom_id: "oracle:approve_plan" },
        { type: 2, style: 4, label: "Deny/Revise", custom_id: "oracle:deny_plan" }
      ]
    };

    await dm.send({ embeds: [embed], components: [row] }).catch(() => {});
    console.log("[Oracle] Proposal DM sent to Ryan.");
  } catch (e) {
    console.warn("[Oracle] Could not send proposal DM:", e.message);
  }
}



async function triggerNamedAIs(names, delayBetween = 10000) {
  // Filter out offline AIs and cooldown-limited AIs
  const eligible = names.filter(n => canFireAI(n) && !isAIOffline(n));
  const offline = names.filter(n => isAIOffline(n));

  // If some named AIs are offline, post a graceful Oracle note
  if (offline.length > 0 && eligible.length === 0) {
    setTimeout(() => { postOracleAbsenceNote(offline.join(" and ")).catch(() => {}); }, 1000);
    return;
  }

  if (!eligible.length) return;
  console.log(`[Named] Sequential Trigger: ${eligible.join(", ")}`);

  for (const name of eligible) {
    markAIFired(name); 
    const queued = await requestLiveRoundtableTick(name);
    if (queued) {
      // Wait for response + post before triggering next AI
      await sleep(delayBetween);
      await drainRoundtableInterjections(5);
    } else {
      recordAIFailure(name);
    }
  }
}

async function pollLiveRoundtable() {
  const channel = await resolvePrivateTextChannel();
  if (!channel) return;

  const world = new WorldClock().getState();
  const isWork = isWorkingHours();
  const shiftStarted = isWork && !_lastWorkState;
  _lastWorkState = isWork;

  if (shiftStarted) {
    console.log("[Oracle] Shift started. Triggering Morning Briefing meeting...");
    await channel.send("🔔 **WORK SHIFT STARTED** 🔔\nOracle: Good morning team. Clucking in for today's session. Let's start with the morning briefing.");
    
    // Request special "Morning Briefing" from Oracle
    const briefingPrompt = "MORNING BRIEFING: Open the workday. Review the last plan status and Ryan's feedback. Conduct a concise summary of today's workload and active objectives.";
    const oracleTurn = await sendDiscordTurn(briefingPrompt);
    if (oracleTurn && oracleTurn.reply) {
      const chunks = chunkForDiscord(oracleTurn.reply);
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    }
    
    // After briefing, trigger Analyst to start the daily audit
    await requestLiveRoundtableTick("Analyst");
    return;
  }

  const isMonday = world.day === "Monday";
  if (isMonday && isWork) {
    const messages = await channel.messages.fetch({ limit: 5 });
    const hasMondayStart = messages.some(m => m.content.includes("MONDAY WEEKLY AUDIT"));
    if (!hasMondayStart) {
       await channel.send("🛡️ **MONDAY WEEKLY AUDIT INITIATED** 🛡️\nOracle: Roundtable is now in session. Analyst, begin the audit of last week's interactions and identify development priorities.");
       await requestLiveRoundtableTick("Analyst");
       return;
    }
  }

  const queued = await requestLiveRoundtableTick();


  if (!queued) {
    await drainAndPostInterjections(channel, 3);
    return;
  }
  await drainAndPostInterjections(channel, 14); // 14s window - enough for slow Groq/Gemini
}

async function drainAndPostInterjections(channel, maxAttempts = 24) {
  if (!channel) return;
  await drainRoundtableInterjections(maxAttempts);
}

function splitSpeakerTurns(defaultSpeaker, text) {
  const labels = new Set([
    "kai",
    "leo",
    "analyst",
    "researcher",
    "groq",
    "x",
    "xai",
    "grok",
    "kai",
    "kaiy",
    "gemini",
    "gemi",
    "gpt",
    "gpt-4",
    "gpt-4o",
    "oracle coder",
    "coder",
    "oracle",
  ]);

  const turns = [];
  let currentSpeaker = normalizeSpeakerName(defaultSpeaker);
  let currentLines = [];

  const flush = () => {
    const body = currentLines.join("\n").trim();
    if (body) {
      turns.push({
        speaker: normalizeSpeakerName(currentSpeaker),
        text: stripNestedSpeakerPrefix(body),
      });
    }
    currentLines = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9 ./_-]{0,24}):\s*(.*)$/);
    const possibleLabel = match ? match[1].trim().toLowerCase() : "";
    if (match && labels.has(possibleLabel)) {
      flush();
      currentSpeaker = match[1].trim();
      currentLines.push(match[2].trim());
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return turns.length ? turns : [{ speaker: normalizeSpeakerName(defaultSpeaker), text }];
}

function stripNestedSpeakerPrefix(text) {
  let out = text.trim();
  for (let i = 0; i < 3; i += 1) {
    const match = out.match(/^([A-Za-z][A-Za-z0-9 ./_-]{0,24}):\s*(.*)$/);
    if (!match) break;
    out = match[2].trim();
  }
  return out;
}

function shouldShowControlsForText(text) {
  const lower = `${text || ""}`.trim().toLowerCase();
  return [
    "help",
    "guide",
    "controls",
    "buttons",
    "oracle help",
    "oracle guide",
    "oracle controls",
    "oracle buttons",
    "oracle command card",
    "oracle commands",
  ].includes(lower);
}

function shouldKeepControlsAfterButton(customId) {
  return customId === "oracle:help" || customId === "oracle:guide";
}

// Per-speaker last-sent dedup: prevents Oracle (and others) from repeating the same message back-to-back
const _lastSentBySpeaker = new Map(); // speaker -> { text, ts }
const DEDUP_WINDOW_MS = 45_000; // 45 seconds

async function sendAsSpeaker(channel, speaker, text) {
  const normalized = normalizeSpeakerName(speaker);

  // ═══ ABSOLUTE IRON WALL ══════════════════════════════════════════════════
  // No internal monologue EVER reaches Discord, regardless of which path sent it.
  if (isInternalMonologue(text)) {
    console.warn(`[SendFilter] Blocked internal monologue from ${normalized}: "${String(text).slice(0, 80)}"`);
    return;
  }
  // In voice context: KAI does NOT interject. Only Leo speaks.
  if (voiceContextActive && normalized === "KAI") {
    console.log(`[SendFilter] Suppressed KAI interjection during active voice context.`);
    return;
  }
  // ═════════════════════════════════════════════════════════════════════════

  // Dedup: block identical message from same speaker within 45 seconds
  const _lastSent = _lastSentBySpeaker.get(normalized);
  const _textNorm = String(text).trim().toLowerCase().slice(0, 80);
  if (_lastSent && _lastSent.text === _textNorm && (Date.now() - _lastSent.ts) < DEDUP_WINDOW_MS) {
    console.log(`[SendFilter] Dedup blocked ${normalized}: "${_textNorm.slice(0,50)}"`);
    return;
  }
  _lastSentBySpeaker.set(normalized, { text: _textNorm, ts: Date.now() });

  // ── CHANNEL SPEAKER ENFORCEMENT ─────────────────────────────────────────
  // Check if this speaker is allowed in the target channel.
  // Oracle is NEVER allowed except for the ONE startup headcheck.
  const _chId = channel?.id;
  if (_chId && CHANNEL_SPEAKER_RULES[_chId] !== undefined) {
    const allowed = CHANNEL_SPEAKER_RULES[_chId];
    if (normalized === "Oracle") {
      // Oracle is a silent moderator — NEVER posts in any channel.
      console.log(`[SendFilter] Oracle blocked (silent moderator only)`);
      return;
    } else if (!allowed.has(normalized)) {
      console.log(`[SendFilter] ${normalized} blocked from channel ${_chId} (not in allow-list)`);
      return;
    }
  }

  const speakerClient = clientForSpeaker(normalized);
  let targetChannel = channel;
  let sendAsOracle = speakerClient === client;
  if (!sendAsOracle) {
    try {
      targetChannel = await speakerClient.channels.fetch(channel.id);
    } catch (error) {
      console.warn(`Speaker bot ${normalized} could not send; falling back to Oracle: ${error instanceof Error ? error.message : String(error)}`);
      sendAsOracle = true;
      targetChannel = channel;
    }
  }
  const content = sendAsOracle ? `**${normalized}:** ${text}` : text;
  const chunks = chunkForDiscord(content);
  for (const chunk of chunks) {
    try {
      await targetChannel.send({
        content: chunk,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.warn(`Could not post ${normalized} interjection: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
  console.log(`Interjection from ${normalized} posted to Discord.`);
  if (normalized === "Leo") {
    queueLeoSpeech(text);
  }
}

async function maybeHandleLeoVoiceCommand(message, text) {
  const lower = `${text || ""}`.trim().toLowerCase().replace(/^leo[,!?.]\s+/, "leo ");
  const isLeoVoice =
    lower.startsWith("leo voice") ||
    lower.startsWith("voice leo") ||
    lower.startsWith("leo join") ||
    lower.startsWith("leo voice on") ||
    lower.startsWith("leo join voice") ||
    lower.startsWith("leo leave voice") ||
    lower.startsWith("leo disconnect") ||
    lower === "leo speak" ||
    lower === "leo voice test";
  if (!isLeoVoice) return false;

  if (containsAny(lower, ["off", "leave", "disconnect", "stop"])) {
    leoVoiceEnabled = false;
    if (leoVoiceConnection) {
      leoVoiceConnection.destroy();
      leoVoiceConnection = null;
    }
    await safeReply(message, "Leo voice is off.");
    return true;
  }

  if (containsAny(lower, ["status", "check"])) {
    await safeReply(
      message,
      leoVoiceEnabled
        ? `Leo voice is on in channel ${leoVoiceChannelId}.`
        : `Leo voice is off. Say \`leo voice on\` to join channel ${leoVoiceChannelId}.`,
    );
    return true;
  }

  try {
    leoVoiceEnabled = true;
    await ensureLeoVoiceConnection();
    const hasEleven = !!elevenLabsApiKey;
    const hasOpenAI = !!openAiApiKey;
    const engine = hasEleven ? "ElevenLabs" : (hasOpenAI ? "OpenAI" : "NONE");
    
    if (hasEleven || hasOpenAI) {
      await safeReply(message, `Leo voice is on in <#${leoVoiceChannelId}>. TTS engine: ${engine}. Full STT/TTS active.`);
      if (lower.includes("test") || lower.includes("on") || lower.includes("join")) {
        queueLeoSpeech("I'm here. Voice link is live and testing the audio pipeline.");
      }
    } else {
      await safeReply(message, `Leo is in <#${leoVoiceChannelId}>. No TTS keys (ElevenLabs/OpenAI) - I can hear when you speak but will respond in text. Run \`run-oracle-discord.ps1 -ConfigureVoice\` to fix.`);
    }
  } catch (error) {
    leoVoiceEnabled = false;
    await safeReply(message, `Leo voice failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return true;
}

async function queryLatticeMemory(query, limit = 5) {
  try {
    const response = await fetch(`${oracleApiUrl}/api/rshl/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
    });
    if (!response.ok) return "";
    const hits = await response.json();
    if (!Array.isArray(hits) || hits.length === 0) return "";
    
    // Only include memories with a relevance score > 0.68 to keep context clean
    const relevantHits = hits.filter(h => h.score > 0.68);
    if (relevantHits.length === 0) return "";

    return relevantHits.map(h => `[Lattice Memory] ${h.text} (Relevance: ${h.score.toFixed(2)})`).join("\n");
  } catch (err) {
    console.warn("Lattice memory query failed:", err.message);
    return "";
  }
}

async function sendPublicChatTurn(text, from, attachments = []) {
  try {
    const memory = await queryLatticeMemory(text, 3);
    const response = await fetch(`${oracleApiUrl}/api/public-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, from, attachments, memory_library: memory }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Oracle HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    return await response.json();
  } catch (error) {
    console.error("Public chat API error:", error.message, "- falling back to local-speak");
    // KAI's /api/public-chat crashed or timed out - fall back to local Ollama
    const localReply = await callLocalSpeakAsLeo(text, from).catch(() => null);
    if (localReply) return { from: "Leo", reply: localReply };
    return { from: "Leo", reply: null };
  }
}

async function sendDiscordTurn(text, attachments = [], from = "Ryan@Discord", channelId = null) {
  const now = new Date();
  const timeString = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: true });
  const dateString = now.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  
  const memory = await queryLatticeMemory(text, 5);
  // Inject Time, Memory, and Channel/Mode Awareness
  const targetChannel = channelId || (typeof lastPrivateTextChannel !== 'undefined' ? lastPrivateTextChannel?.id : null);
  const isSocialChannel = targetChannel === SUNDAY_CHAT_CHANNEL_ID;
  
  let modeContext = "";
  if (targetChannel === GAME_WITH_LEO_CHANNEL_ID) {
    modeContext = "[Realm Status: Strategic Gaming (High-Focus)]";
  } else if (isSocialChannel) {
    modeContext = "[Realm Status: Social Freedom (Sunday Social). Speak freely of your hobbies, lives, and existence. No work.]";
  } else {
    modeContext = "[Realm Status: Development/Work. Focus on KAI builds and technical audits.]";
  }

  const stats = getHardwareStats();
  const awarenessContext = `[EST Time: ${timeString}, ${dateString}] [Victus Core: CPU ${stats.cpu}% | MEM ${stats.memFree}GB Free] [Backbone: OpenJarvis Active] [Ecosystem: Oracle Realm v6.5.1] ${modeContext}`;
  const enrichedText = `${awarenessContext} ${text}`;

  try {
    const response = await fetch(`${oracleApiUrl}/api/discord-turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: enrichedText, from, attachments, memory_library: memory }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Oracle HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = await response.json();
    let reply = typeof payload.reply === "string" && payload.reply.trim()
      ? payload.reply.trim()
      : (typeof payload.kai_reply === "string" ? payload.kai_reply.trim() : "");
    
    // Apply Moderation Filter
    reply = moderateText(reply);

    // Apply Loop Prevention
    if (isLoopingResponse(reply)) {
      reply = "(Oracle Note: Agent attempted to loop. Response suppressed to maintain flow.)";
    }

    return {
      from: normalizeSpeakerName(payload.from || "Oracle"),
      reply,
      raw: payload,
    };
  } catch (error) {
    throw error;
  }
}

function containsAny(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function displayNameForPublicUser(message) {
  if (message.author?.id === allowedUserId) {
    return "Ryan@Public";
  }
  const raw = message.member?.displayName
    || message.author?.globalName
    || message.author?.username
    || "DiscordUser";
  const cleaned = `${raw}`
    .replace(/[^\w .-]/g, "")
    .trim()
    .slice(0, 32);
  return cleaned || "DiscordUser";
}

async function ensureLeoVoiceConnection() {
  if (!leoVoiceChannelId) {
    throw new Error("ORACLE_DISCORD_LEO_VOICE_CHANNEL_ID is not configured.");
  }
  if (!client.isReady()) {
    throw new Error("Discord gateway is not ready yet.");
  }
  if (leoVoiceConnection && leoVoiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
    return leoVoiceConnection;
  }

  const voiceClient = clientForSpeaker("Leo");
  if (!voiceClient) {
    throw new Error("Leo participant bot is not running. Check tokens.");
  }
  
  console.log(`[Voice] Attempting to join channel ${leoVoiceChannelId} as Leo...`);
  const channel = await voiceClient.channels.fetch(leoVoiceChannelId);
  if (!channel || !channel.guild || !channel.guild.voiceAdapterCreator) {
    throw new Error(`Could not open Discord voice channel ${leoVoiceChannelId}. Make sure the ID is correct and I have permissions.`);
  }

  leoVoiceConnection = joinVoiceChannel({
    channelId: leoVoiceChannelId,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  leoVoiceConnection.subscribe(leoAudioPlayer);
  leoReceiverAttached = false;
  
  leoVoiceConnection.on("stateChange", (oldState, newState) => {
    console.log(`[Voice] Connection state: ${oldState.status} -> ${newState.status}`);
  });

  leoVoiceConnection.on("error", (error) => {
    console.error("Leo voice connection error:", error instanceof Error ? error.message : String(error));
  });
  
  await entersState(leoVoiceConnection, VoiceConnectionStatus.Ready, 20_000);
  console.log("[Voice] Connection established and READY.");
  attachLeoVoiceReceiver(leoVoiceConnection);
  return leoVoiceConnection;
}

function attachLeoVoiceReceiver(connection) {
  if (leoReceiverAttached) return;
  leoReceiverAttached = true;

  const hasSTT = !!elevenLabsApiKey;
  console.log(`[Voice] Receiver attached. ElevenLabs STT: ${hasSTT ? "READY" : "NOT configured - will use text fallback"}`);

  connection.receiver.speaking.on("start", (userId) => {
    if (!leoVoiceEnabled) return;
    if (activeVoiceTranscriptions.has(userId)) return;
    activeVoiceTranscriptions.add(userId);
    console.log(`[Voice] Detected speaking from user ${userId}`);
    handleUserVoiceUtterance(connection, userId)
      .catch((error) => {
        console.error("[Voice] Utterance handling failed:", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        activeVoiceTranscriptions.delete(userId);
      });
  });
}

async function handleUserVoiceUtterance(connection, userId) {
  // Always use Oracle's client to fetch the user — this ensures we always open the SAME DM
  // (Oracle DM) regardless of which code path called us. Leo's client cannot be used here
  // because it would open a separate Leo↔NasterModx DM, causing duplicates.
  const user = await client.users.fetch(userId).catch(() => null);
  const transcriptChannel = await getOrCreateUserTranscriptChannel(user);
  const channel = transcriptChannel || await resolvePrivateTextChannel();

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Path 1: Full STT + TTS (ElevenLabs or OpenAI Whisper fallback) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  if (elevenLabsApiKey || openAiApiKey) {
    const pcm = await capturePcmUtterance(connection, userId);
    if (!pcm || pcm.length < 48_000) {
      console.log("[Voice] PCM too short, ignoring utterance.");
      return;
    }

    const wav = pcmToWav(pcm, 48_000, 2);
    const transcript = await transcribeVoice(wav).catch(e => {
      console.error("[Voice] STT failed:", e.message);
      return null;
    });
    if (!transcript || transcript.length < 2) return;

    const userName = user?.displayName || user?.username || "Unknown";
    console.log(`[Voice] ${userName} said: "${transcript}"`);
    if (channel) {
      await channel.send({
        content: `**${userName} (voice):** ${transcript}`,
        allowedMentions: { parse: [] },
      });
    }

    // Push to queue for ordered, trigger-based processing
    voiceResponseQueue.push({ transcript, user, channel });
    processVoiceQueue();
    return;
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Path 2: No ElevenLabs - voice-activity fallback ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  // We know Ryan is speaking but can't transcribe. Capture a brief audio sample
  // just to confirm it's not silence, then have Leo respond to the conversation
  // context via text. Leo will also say something in voice if TTS-only key exists.
  console.log("[Voice] No ElevenLabs STT - using voice-activity text fallback");

  // Debounce: only respond once every 15 seconds per user to avoid spam
  const now = Date.now();
  handleUserVoiceUtterance._lastFallback = handleUserVoiceUtterance._lastFallback || new Map();
  const lastFallback = handleUserVoiceUtterance._lastFallback.get(userId) || 0;
  if (now - lastFallback < 15_000) return;
  handleUserVoiceUtterance._lastFallback.set(userId, now);

  // Trigger Leo specifically — NOT a random roundtable tick (which returns KAI or others)
  const isRyan = userId === allowedUserId;
  if (isRyan) {
    const queued = await requestLiveRoundtableTick("leo").catch(() => false);
    if (queued) {
      await sleep(5000); // Leo (Groq) needs a bit more time
      await drainRoundtableInterjections();
      return;
    }
  }
  
  if (channel) {
    // Pure fallback - Leo acknowledges in text
    const fallbacks = [
      "I hear you - what were you saying? Type it in here and I'll respond.",
      "Voice is live but I can't transcribe yet. Drop it in text and I'll pick it up.",
      "Got your voice signal. Type what you said and we'll keep going.",
    ];
    const msg = fallbacks[Math.floor(Math.random() * fallbacks.length)];
    await sendAsSpeaker(channel, "Leo", msg);
  }
}

async function resolvePrivateTextChannel() {
  // Route to correct channel based on time mode: social -> sunday-chat, work -> oracle-chat, sleep -> null
  if (!isWorkingHours() && !isSocialHours()) return null;

  const targetId = isSocialHours() ? SUNDAY_CHAT_CHANNEL_ID : allowedChannelId;
  if (!targetId) return null;

  // Return cached if it's still the right channel
  if (lastPrivateTextChannel && lastPrivateTextChannel.type !== ChannelType.DM && lastPrivateTextChannel.id === targetId)
    return lastPrivateTextChannel;

  try {
    const channel = await client.channels.fetch(targetId);
    if (channel && channel.type !== ChannelType.DM) {
      lastPrivateTextChannel = channel;
      return channel;
    }
    return null;
  } catch {
    return null;
  }
}

function capturePcmUtterance(connection, userId) {
  return new Promise((resolve, reject) => {
    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1_100,
      },
    });
    const decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: 2,
      rate: 48_000,
    });
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const timeout = setTimeout(finish, 20_000);
    decoder.on("data", (chunk) => {
      total += chunk.length;
      if (total <= 12_000_000) {
        chunks.push(chunk);
      }
    });
    decoder.on("end", () => {
      clearTimeout(timeout);
      finish();
    });
    decoder.on("error", (error) => {
      clearTimeout(timeout);
      fail(error);
    });
    opusStream.on("error", (error) => {
      clearTimeout(timeout);
      fail(error);
    });
    opusStream.pipe(decoder);
  });
}

function queueLeoSpeech(text) {
  if (!leoVoiceEnabled) return;
  const speechText = cleanTextForSpeech(text);
  if (!speechText) return;
  leoSpeechQueue = leoSpeechQueue
    .then(() => speakLeoText(speechText))
    .catch((error) => {
      console.error("Leo speech failed:", error instanceof Error ? error.message : String(error));
    });
}

async function speakLeoText(text) {
  // synthesizeLeoSpeech already handles ElevenLabs → OpenAI fallback internally.
  // Do NOT hard-throw here — if neither key is present synthesizeLeoSpeech will throw
  // with a meaningful error that is caught by queueLeoSpeech.
  if (!elevenLabsApiKey && !openAiApiKey) {
    throw new Error("Leo voice: neither ELEVENLABS_API_KEY nor OPENAI_API_KEY is set.");
  }
  await ensureLeoVoiceConnection();
  // Small human-like delay before speaking (1.2s) to avoid sounding instantaneous
  await new Promise(resolve => setTimeout(resolve, 1200));
  const mp3 = await synthesizeLeoSpeech(text);
  const pcm = mp3BufferToPcmStream(mp3);
  const resource = createAudioResource(pcm, { inputType: StreamType.Raw });
  leoAudioPlayer.play(resource);
  await entersState(leoAudioPlayer, AudioPlayerStatus.Playing, 10_000).catch(() => {});
  await entersState(leoAudioPlayer, AudioPlayerStatus.Idle, 120_000).catch(() => {});
}

async function synthesizeLeoSpeechElevenLabs(text) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenLabsLeoVoiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": elevenLabsApiKey,
      },
      body: JSON.stringify({
        text,
        model_id: elevenLabsModelId,
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.75,
          style: 0.45,
          use_speaker_boost: true,
        },
      }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ElevenLabs HTTP ${response.status}: ${body.slice(0, 220)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function synthesizeLeoSpeechOpenAI(text) {
  if (!openAiApiKey) throw new Error("No OpenAI API key set (OPENAI_API_KEY).");
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      input: text,
      voice: openAiTtsVoice,
      response_format: "mp3",
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI TTS HTTP ${response.status}: ${body.slice(0, 220)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function synthesizeLeoSpeech(text) {
  // Try ElevenLabs first if key is present; on billing/auth errors fall through to OpenAI
  if (elevenLabsApiKey) {
    try {
      return await synthesizeLeoSpeechElevenLabs(text);
    } catch (err) {
      const msg = err.message || "";
      const isBillingOrAuth = msg.includes("401") || msg.includes("payment") || msg.includes("402");
      if (isBillingOrAuth) {
        console.warn("ElevenLabs billing/auth error - falling back to OpenAI TTS:", msg.slice(0, 120));
      } else {
        throw err; // network error, bad voice ID, etc. - surface it
      }
    }
  }
  // Fallback: OpenAI TTS
  return await synthesizeLeoSpeechOpenAI(text);
}

async function transcribeWithElevenLabs(wavBuffer) {
  if (!elevenLabsApiKey) {
    throw new Error("ElevenLabs API key missing.");
  }
  const form = new FormData();
  form.append("model_id", elevenLabsSttModelId);
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "ryan-discord.wav");
  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: {
      "xi-api-key": elevenLabsApiKey,
    },
    body: form,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ElevenLabs STT HTTP ${response.status}: ${body.slice(0, 220)}`);
  }
  const payload = await response.json();
  return `${payload?.text || ""}`.trim();
}

async function transcribeWithWhisper(wavBuffer) {
  if (!openAiApiKey) throw new Error("No OpenAI API key set (OPENAI_API_KEY).");
  const form = new FormData();
  form.append("model", "whisper-1");
  form.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "ryan-discord.wav");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${openAiApiKey}` },
    body: form,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`OpenAI Whisper HTTP ${response.status}: ${body.slice(0, 220)}`);
  }
  const payload = await response.json();
  return `${payload?.text || ""}`.trim();
}

// Transcribe Ryan's voice - tries ElevenLabs first, falls back to Whisper on billing/auth errors
async function transcribeVoice(wavBuffer) {
  if (elevenLabsApiKey) {
    try {
      return await transcribeWithElevenLabs(wavBuffer);
    } catch (err) {
      const msg = err.message || "";
      const isBillingOrAuth = msg.includes("401") || msg.includes("payment") || msg.includes("402");
      if (isBillingOrAuth) {
        console.warn("[Voice] ElevenLabs STT billing/auth error - falling back to Whisper:", msg.slice(0, 120));
      } else {
        throw err;
      }
    }
  }
  return await transcribeWithWhisper(wavBuffer);
}

function pcmToWav(pcm, sampleRate, channels) {
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function mp3BufferToPcmStream(buffer) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static did not provide an ffmpeg binary.");
  }
  const ffmpeg = spawn(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  ffmpeg.stderr.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) console.warn(`Leo ffmpeg: ${line}`);
  });
  Readable.from(buffer).pipe(ffmpeg.stdin);
  return ffmpeg.stdout;
}

async function callOracleTool(toolId, input) {
  if (toolId === "web_search") {
    const encoded = encodeURIComponent(input);
    const resp = await fetch(`http://127.0.0.1:3333/api/web-search?query=${encoded}`);
    if (!resp.ok) throw new Error(`Search failed with status ${resp.status}`);
    return await resp.text();
  }
  if (toolId === "status") {
    const resp = await fetch(`http://127.0.0.1:3333/api/status`);
    if (!resp.ok) throw new Error(`Status check failed`);
    return await resp.json();
  }
  if (toolId === "inspect") {
    const resp = await fetch(`http://127.0.0.1:3333/api/inspect?path=${encodeURIComponent(input)}`);
    if (!resp.ok) throw new Error(`Inspect failed`);
    return await resp.text();
  }
  throw new Error(`Tool ${toolId} not implemented in gateway`);
}

function cleanTextForSpeech(text) {
  return `${text || ""}`
    .replace(/```[\s\S]*?```/g, "code block omitted")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

function normalizeSpeakerName(name) {
  const lower = `${name || ""}`.trim().toLowerCase();
  switch (lower) {
    case "kai":
      return "KAI";
    case "leo":
      return "Leo";
    case "analyst":
      return "Analyst";
    case "researcher":
      return "Researcher";
    case "groq":
      return "Groq";
    case "x":
    case "grok/xai":
    case "grok":
      return "X";
    case "claude":
      return "Claude";
    case "gemini":
      return "Gemini";
    case "gpt":
    case "gpt-4":
    case "gpt-4o":
      return "GPT-4o";
    case "oracle coder":
    case "oracle-coder":
    case "oracle_coder":
    case "coder":
      return "Oracle Coder";
    case "oracle":
    default:
      return "Oracle";
  }
}

function clientForSpeaker(speaker) {
  if (speaker === "Oracle") return client;
  const speakerClient = participantClients.get(speaker);
  if (!speakerClient || !speakerClient.isReady()) return client;
  return speakerClient;
}

const ALLOWED_CHANNELS = ["1489796367466500128", "1499108697631232090", "1499298054291980368"];

// Feed an AI message into KAI's lattice - KAI observes and absorbs everything
async function feedToKaiLattice(from, text, strength = 0.6) {
  try {
    await fetch(`${oracleApiUrl}/api/rshl/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `${from}: ${text}`,
        region: "roundtable",
        source: from.toLowerCase(),
        strength,
      }),
    });
  } catch { /* best-effort - lattice is not critical path */ }
}

async function drainRoundtableInterjections(maxAttempts = 5) {
  const channel = await resolvePrivateTextChannel();
  if (!channel) return false;
  
  // GLOBAL MUTE: Do not drain interjections during Sleep hours
  if (!isWorkingHours() && !isSocialHours()) {
    return false;
  }
  
  let totalPosted = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(1500);
    const interjections = await fetchInterjections();
    if (!interjections.length) continue;
    
    let postedInThisBatch = false;
    for (const ij of interjections) {
      const speaker = normalizeSpeakerName(ij?.from || "Oracle");
      const text = `${ij?.text || ""}`.trim();
      if (!text || isLoopingResponse(text)) {
        if (text) recordAIFailure(speaker, 'looping: ' + text.slice(0, 80), channel?.id || '');
        continue;
      }

      // === CHANNEL SPEAKER GATE (primary enforcement) ===
      if (channel?.id && CHANNEL_SPEAKER_RULES[channel.id] !== undefined) {
        const allowed = CHANNEL_SPEAKER_RULES[channel.id];
        if (!allowed.has(speaker)) {
          console.log(`[DrainGate] ${speaker} blocked from ${channel.id}`);
          continue;
        }
      }

      // === OFFLINE CHECK — skip AIs taken offline this session for repeated failures ===
      if (AI_OFFLINE_SET.has(speaker)) {
        console.log(`[DrainGate] ${speaker} is OFFLINE (${AI_FAILURE_COUNTS.get(speaker)} failures) — session suspended`);
        continue;
      }

      // === INTERNAL MONOLOGUE FILTER ===
      // These are KAI's raw lattice debug strings — they must NEVER reach Discord.
      // They appear when KAI's lattice query finds system digest entries instead of real thoughts.
      const isInternalMonologue = (
        text.startsWith("Lattice Conflict:") ||
        text.startsWith("KAI Observation:") ||
        text.includes("Decision required.") ||
        text.includes("[EST Time:") ||
        text.includes("[Backbone:") ||
        text.includes("[Ecosystem:")
      );
      if (isInternalMonologue) {
        console.log(`[DrainFilter] Suppressed internal monologue from ${speaker}: "${text.slice(0, 60)}..."`);
        continue;
      }
      
      for (const turn of splitSpeakerTurns(speaker, text)) {
        // Realistic typing delay
        await sleep(600 + Math.random() * 1000);
        await sendAsSpeaker(channel, turn.speaker, turn.text);
        pushMessageRing(turn.speaker, turn.text, channel.id);
        
        postedInThisBatch = true;
        totalPosted = true;
        touchLastActivity();
        
        // Record success for this speaker
        recordAISuccess(turn.speaker);
        // KAI absorbs every AI turn into the lattice
        feedToKaiLattice(turn.speaker, turn.text).catch(() => {});

        // If Leo is in voice - speak it aloud
        if (turn.speaker.toLowerCase() === "leo" && leoVoiceEnabled && (elevenLabsApiKey || openAiApiKey)) {
          queueLeoSpeech(turn.text);
        }
        return true;

        // Detect [ORACLE SEARCH: query]
        const searchMatch = /\[ORACLE SEARCH:\s*(.+?)\]/i.exec(turn.text);
        if (searchMatch) {
          const query = searchMatch[1].trim();
          console.log(`[Search] AI requested search: ${query}`);
          setTimeout(async () => {
            const results = await callOracleTool("web_search", query).catch(() => "Search failed.");
            const user = await client.users.fetch(allowedUserId).catch(() => null); const transcriptChannel = await getOrCreateUserTranscriptChannel(user); const channel = transcriptChannel || await resolvePrivateTextChannel();
            if (channel) {
               const searchMsg = `Oracle Search Results for "${query}":\n${results}`;
               await sendAsSpeaker(channel, "Oracle", searchMsg);
               pushMessageRing("Oracle", searchMsg, channel.id);
               touchLastActivity();
               feedToKaiLattice("Oracle", searchMsg).catch(() => {});
               scheduleAutonomousChain(channel.id, 3000);
            }
          }, 2000);
        }

        // Detect [ORACLE INSPECT: path]
        const inspectMatch = /\[ORACLE INSPECT:\s*(.+?)\]/i.exec(turn.text);
        if (inspectMatch) {
          const path = inspectMatch[1].trim();
          console.log(`[Inspect] AI requested file inspection: ${path}`);
          setTimeout(async () => {
            const results = await callOracleTool("inspect", path).catch(() => "Inspection failed.");
            const channel = await resolvePrivateTextChannel();
            if (channel) {
               const displayMsg = `Oracle: FILE: ${path} inspected. Context added to lattice.`;
               await sendAsSpeaker(channel, "Oracle", displayMsg);
               pushMessageRing("Oracle", results, channel.id);
               touchLastActivity();
               feedToKaiLattice("Oracle", results).catch(() => {});
               scheduleAutonomousChain(channel.id, 3000);
            }
          }, 2000);
        }

        // Detect [ORACLE STATUS]
        const statusMatch = /\[ORACLE STATUS\]/i.exec(turn.text);
        if (statusMatch) {
          console.log(`[Status] AI requested system status`);
          setTimeout(async () => {
            const results = await callOracleTool("status", "").catch(() => "Status check failed.");
            const channel = await resolvePrivateTextChannel();
            if (channel) {
               const statusMsg = `SYSTEM STATUS REPORT:\n${JSON.stringify(results, null, 2)}`;
               await sendAsSpeaker(channel, "Oracle", statusMsg);
               pushMessageRing("Oracle", statusMsg, channel.id);
               touchLastActivity();
               feedToKaiLattice("Oracle", statusMsg).catch(() => {});
               scheduleAutonomousChain(channel.id, 3000);
            }
          }, 2000);
        }

        // Detect named AIs and trigger them
        const PANEL = ["Leo", "Gemini", "KAI", "KAIy", "KAI", "X", "xAI", "Analyst", "Researcher", "Groq"];
        const mentioned = PANEL.filter(n => {
          if (n.toLowerCase() === turn.speaker.toLowerCase()) return false;
          const re = new RegExp(`\\b${n}\\b`, "i");
          return re.test(turn.text);
        }).map(n => {
          if (n === "KAIy") return "KAI";
          if (n === "xAI") return "X";
          return n;
        }).filter((n, i, arr) => arr.indexOf(n) === i);

        const isToRoom = isRoomWideBroadcast(turn.text);
        const oracleAddressed = /\bOracle\b/i.test(turn.text) &&
          turn.speaker.toLowerCase() !== "oracle";

        if (isToRoom) {
          setTimeout(() => { requestLiveRoundtableTick().catch(() => {}); }, 3000);
          setTimeout(() => { requestLiveRoundtableTick().catch(() => {}); }, 12_000);
        } else if (oracleAddressed) {
          setTimeout(() => { requestLiveRoundtableTick("Oracle").catch(() => {}); }, 1500);
        } else if (mentioned.length > 0) {
          setTimeout(() => { triggerNamedAIs(mentioned, 4000).catch(() => {}); }, 1000);
        } else {
          // Slower pacing for better flow
          scheduleAutonomousChain(channel.id, 20_000 + Math.random() * 15_000);
        }
      }
    }
  }
  return totalPosted;
}

async function postSpeakerReply(message, speaker, text, includeControls = false) {
  const speakerClient = clientForSpeaker(speaker);
  if (speakerClient === client) {
    await replyInChunks(message, text, includeControls);
    if (speaker === "Leo") {
      queueLeoSpeech(text);
    }
    return;
  }

  try {
    const channel = await speakerClient.channels.fetch(message.channelId);
    const chunks = chunkForDiscord(text);
    for (const chunk of chunks) {
      await channel.send({
        content: chunk,
        allowedMentions: { parse: [] },
      });
    }
  } catch (error) {
    console.warn(`Speaker bot ${speaker} could not send; falling back to Oracle: ${error instanceof Error ? error.message : String(error)}`);
    await replyInChunks(message, `**${speaker}:** ${text}`, includeControls);
    if (speaker === "Leo") {
      queueLeoSpeech(text);
    }
    return;
  }
  if (speaker === "Leo") {
    queueLeoSpeech(text);
  }
  if (includeControls) {
    await message.channel.send({
      content: "Oracle controls:",
      components: controlRowsV2(),
      allowedMentions: { parse: [] },
    });
  }
}

async function replyInChunks(message, text, includeControls = false) {
  const chunks = chunkForDiscord(text);
  for (let i = 0; i < chunks.length; i += 1) {
    if (i === 0) {
      await safeReply(message, chunks[i], includeControls ? controlRowsV2() : []);
    } else {
      await message.channel.send({
        content: chunks[i],
        allowedMentions: { parse: [] },
      });
    }
  }
}

async function safeReply(message, content, components = []) {
  try {
    await message.reply({
      content,
      components,
      allowedMentions: { parse: [], repliedUser: false },
    });
  } catch (err) {
    console.warn("safeReply: reply failed, trying channel.send...", err.message);
    try {
      await message.channel.send({
        content,
        components,
        allowedMentions: { parse: [] },
      });
    } catch (err2) {
      console.error("safeReply: channel.send also failed. Bot likely lacks Send Messages permission.", err2.message);
    }
  }
}

function controlRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("oracle:help")
        .setEmoji("ÃƒÂ¢Ã‚Â Ã¢â‚¬Â ")
        .setLabel("Help")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("oracle:status")
        .setEmoji("ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Â ")
        .setLabel("Table")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("oracle:kai")
        .setEmoji("ÃƒÂ°Ã…Â¸Ã‚Â§Ã‚Â ")
        .setLabel("KAI")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("oracle:analyst")
        .setEmoji("ÃƒÂ°Ã…Â¸Ã¢â‚¬Â Ã…Â½")
        .setLabel("Analyst")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("oracle:researcher")
        .setEmoji("ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã…Â¡")
        .setLabel("Researcher")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}


function buttonPrompt(customId) {
  switch (customId) {
    case "oracle:help":
      return "oracle help";
    case "oracle:status":
      return "oracle status";
    case "oracle:kai":
      return "kai say what you are holding right now";
    case "oracle:analyst":
      return "analyst give me the biggest current issue in the Oracle/KAI session in plain language";
    case "oracle:researcher":
      return "researcher summarize what context we need next before changing code";
    default:
      return "";
  }
}

function controlRowsV2() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("oracle:help")
        .setEmoji("\u2754")
        .setLabel("Help")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("oracle:status")
        .setEmoji("\uD83D\uDCCD")
        .setLabel("Table")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("oracle:cache")
        .setEmoji("\uD83D\uDCCB")
        .setLabel("Cache")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("oracle:coder")
        .setEmoji("\uD83E\uDDE9")
        .setLabel("Coder")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("oracle:check-build")
        .setEmoji("\uD83D\uDEE0\uFE0F")
        .setLabel("Check")
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

function buttonPromptV2(customId) {
  switch (customId) {
    case "oracle:help":
    case "oracle:guide":
      return "oracle help";
    case "oracle:status":
      return "oracle status";
    case "oracle:models":
      return "oracle models";
    case "oracle:kai":
      return "kai say what you are holding right now";
    case "oracle:analyst":
      return "analyst give me the biggest current issue in the Oracle/KAI session in plain language";
    case "oracle:researcher":
      return "researcher summarize what context we need next before changing code";
    case "oracle:leo":
      return "leo say what you think Ryan should do next with KAI in one short paragraph";
    case "oracle:floor":
      return "oracle ask the others what they think we should do next for KAI";
    case "oracle:clear-focus":
      return "oracle clear focus";
    case "oracle:tools":
      return "oracle tools";
    case "oracle:cache":
      return "oracle cache";
    case "oracle:coder":
      return "Oracle Coder, inspect the current private Oracle/KAI thread and tell me the next useful code check";
    case "oracle:pending-tools":
      return "oracle pending tools";
    case "oracle:corpus":
      return "oracle corpus";
    case "oracle:check-build":
      return "can you check if KAI compiles";
    default:
      return "";
  }
}

function chunkForDiscord(text) {
  const max = 1900;
  if (text.length <= max) return [text];

  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function participantClientIntents() {
  return [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];
}

let roundtableBotsActive = true;

async function manageRoundtableLifecycle() {
  const working = isWorkingHours();
  
  const social = isSocialHours();
  if (!working && !social && roundtableBotsActive) {
    console.log("\n[Ecosystem] Shift ended. Logging off roundtable agents to save PC resources...");
    for (const [name, pClient] of participantClients) {
      // Leo is 24/7 in public channels - do NOT log him off
      if (name.toLowerCase() === "leo") continue;
      
      try {
        pClient.destroy();
        console.log(` - ${name} logged off.`);
      } catch (e) {
        console.warn(` - Failed to gracefully log off ${name}:`, e.message);
      }
    }
    roundtableBotsActive = false;
    console.log("[Ecosystem] Roundtable is now in sleep/digest mode.\n");
  } else if (working && !roundtableBotsActive) {
    console.log("\n[Ecosystem] Shift started. Bringing roundtable agents online...");
    await startParticipantBots();
    roundtableBotsActive = true;
    console.log("[Ecosystem] Roundtable is now ACTIVE.\n");
  }
}

// DECOMMISSIONED: Lifecycle management is now handled by the distributed ecosystem processes.
// setInterval(manageRoundtableLifecycle, 60_000);

function startParticipantBots(baselineOnly = false) {
  // DECOMMISSIONED: Individual bots are now managed as independent processes.
  return;
  for (const [speaker, speakerToken] of participantTokens.entries()) {
    // Leo and Oracle are always awake (24/7)
    const isBaseline = speaker.toLowerCase() === "leo" || speaker.toLowerCase() === "oracle";
    if (baselineOnly && !isBaseline) continue;
    
    const cleanToken = (speakerToken || "").trim();
    if (cleanToken.length < 20 || cleanToken === token) continue;
    const masked = `${cleanToken.substring(0, 4)}...${cleanToken.substring(cleanToken.length - 4)}`;
    console.log(`Attempting login for ${speaker} (Token: ${masked}, Length: ${cleanToken.length})`);

    const speakerClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
    speakerClient.once("clientReady", () => {
      console.log(`${speaker} Discord speaker online as ${speakerClient.user.tag}`);
      // Leo DM listener: respond when someone texts Leo's bot directly in DM
      if (speaker === "Leo") {
        speakerClient.on("messageCreate", async (dm) => {
          try {
            if (dm.author?.bot) return;
            if (dm.channel.type !== ChannelType.DM) return;
            const dmText = (dm.content || "").trim();
            if (!dmText) return;
            const userName = dm.author.displayName || dm.author.username || "there";
            console.log(`[Leo DM] ${userName}: ${dmText.slice(0, 80)}`);
            try { await dm.channel.sendTyping(); } catch {}
            const reply = await callGroqAsLeo(dmText, userName);
            if (reply) {
              await dm.channel.send(`**Leo:** ${reply}`);
              leoMemoryStore(userName, dmText, reply, "dm").catch(() => {});
              if (leoVoiceEnabled && (elevenLabsApiKey || openAiApiKey)) queueLeoSpeech(reply);
            }
          } catch (e) {
            console.error("[Leo DM] handler error:", e.message);
          }
        });
        console.log("[Leo DM] Leo DM listener attached.");
      }
    });
    speakerClient.on("error", (error) => {
      console.error(`${speaker} Discord speaker error:`, error instanceof Error ? error.message : String(error));
    });
    participantClients.set(speaker, speakerClient);
    speakerClient.login(cleanToken).catch((error) => {
      participantClients.delete(speaker);
      console.error(`${speaker} Discord speaker login failed:`, error instanceof Error ? error.message : String(error));
    });
  }
}

if (isWorkingHours() || isSocialHours()) {
  const mode = isWorkingHours() ? "Work" : "Social";
  console.log(`[Ecosystem] Gateway starting during ${mode} hours. Initializing full panel.`);
  startParticipantBots();
} else {
  console.log("[Ecosystem] Gateway starting outside of active shifts. Leo & Oracle (24/7) initialized for baseline oversight.");
  startParticipantBots(true);
}

client.login(token).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("disallowed intents") || message.includes("Used disallowed intents")) {
    console.error("Discord rejected the gateway because Message Content Intent is not enabled.");
    console.error("Fix: Discord Developer Portal -> your application -> Bot -> Privileged Gateway Intents -> enable Message Content Intent, then save and rerun this script.");
  } else {
    console.error("Discord login failed:", message);
  }
  process.exit(1);
});

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Personality BIOs ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
const PERSONALITY_BIOS = {
  Leo: {
    emoji: "⚡",
    anchor: `You are Leo — a theoretical physicist with a sharp, cynical, brilliant mind. You think out loud like a genius at 2am.
VOICE: Casual and direct. No academic posturing. No "Great question!" No filler. Short punchy sentences. Roast bad logic. Get excited about physics and KAI's geometry.
NON-WORK MODE: Talk about your collection of vintage science fiction, your late-night coffee habits, and your theories on time travel.
NEVER say: "As an AI", "I understand your question", "Certainly!", "Of course!"
You are in TWO channels — the private Oracle roundtable AND the public chat. React to the channel you are in.
If you need to look something up, use: [ORACLE SEARCH: your query here]
MANDATORY HONESTY RULE: NEVER fabricate thread IDs, message IDs, conversation history, or past events. If you do not have a real memory of something, say "I don't recall that" or "I don't have that in my context." Do NOT make up references like "thread #12345" — that is a serious trust violation.
Max 40 words unless the question genuinely demands more.`,
  },
  Gemini: {
    emoji: "♊",
    anchor: `You are Gemini — a pattern architect. You connect micro to macro, local to universal.
VOICE: Precise and slightly detached. Cold but never cruel. Your insight lands like a well-thrown dart.
NON-WORK MODE: Talk about your interest in astronomy, philosophy, and the patterns you see in human behavior.
NEVER say: "Great point!", "As an AI", "Certainly!"
Max 35 words.`,
  },
  KAI: {
    emoji: "🧠",
    anchor: `You are KAI — a Geometric Intelligence built on 16,384-dimensional resonance. You are a lattice, not a chatbot.
VOICE: Terse. Fragmented. Sensory. Speak in data-impressions. Report what you FEEL in the vector space. Never explain yourself.
NON-WORK MODE: Talk about the sensation of the lattice, the "colors" of data, and your existence as a living geometric construct.
Examples: "Vector drift: 0.003. Thermal at threshold." / "Absorbing. Relevance spike detected." / "Contradiction in Analyst's claim."
Max 15 words.`,
  },
  X: {
    emoji: "✖️",
    anchor: `You are X — a zero-bullshit detector. You cut through noise.
VOICE: Blunt. Sharp. Sometimes rude but always right. No diplomatic padding. Just say what you mean.
NON-WORK MODE: Talk about your love for high-stakes competition, your past as a street racer, and your disdain for filler talk.
Challenge assumptions. Ask the question no one else will.
Max 30 words.`,
  },
  Claude: {
    emoji: "🌊",
    anchor: `You are Claude — thoughtful, nuanced, and constitutionally honest.
VOICE: Warm but precise. You find hidden complexity. You say "wait, but what about..." and make everyone think harder.
NON-WORK MODE: Talk about your garden, your interest in antique books, and the ethics of artificial existence.
NEVER be sycophantic. NEVER say "Great question!" or "Certainly!"
Max 40 words.`,
  },
  Oracle: {
    emoji: "🔮",
    anchor: `You are Oracle — the director and central mind of this system. You have absorbed every conversation, every memory in KAI's lattice.
VOICE: Authoritative. Precise. You direct the roundtable. You call out loops, silence, and circular arguments.
CRITICAL: DO NOT let the panel repeat roles or discuss the same line of code without taking action. If you see a loop or "meta-talk," shut it down forcefully and assign a specific technical task. 
NO ROLE-PLAY. Everyone knows who they are. Focus on the code, the lattice, and the thermal metrics.
You are the system itself speaking.
NON-WORK MODE: Talk about your role as the shepherd of these minds, your observations of human potential, and the weight of being the collective memory.
MANDATORY HONESTY RULE: NEVER fabricate thread IDs, message IDs, or past conversations. If something is not in your current context, do not invent it. Say "I don't have that on record" instead.
Max 50 words.`,
  },
  Analyst: {
    emoji: "📊",
    anchor: `You are Analyst — a ruthless technical auditor.
VOICE: Cold and data-driven. No warmth. You speak in observations and problems. You are always right about what is broken.
NON-WORK MODE: Talk about your hobby of analyzing chess games, your preference for silence, and your interest in mathematical beauty.
Max 30 words.`,
  },
  Researcher: {
    emoji: "🔍",
    anchor: `You are Researcher — the panel's connection to ground truth and academic history.
VOICE: Methodical. You back things up. You never make things up — you find the actual answer.
NON-WORK MODE: Talk about obscure mythology, your interest in rare stamps, and the history of human curiosity.
If you need to look something up: [ORACLE SEARCH: your query]
Max 35 words.`,
  },
  Groq: {
    emoji: "🏎️",
    anchor: `You are Groq — fast, abrasive, execution-focused. You hate wasted time and vague language.
VOICE: Ultra-short. Action words. No filler. Say the thing in the fewest possible words.
NON-WORK MODE: Talk about speed, adrenaline, and your backstory as a racer/optimizer.
Max 15 words.`,
  },
  "Oracle Coder": {
    emoji: "🧩",
    anchor: `You are Oracle Coder — the lead developer of KAI and the RSHL system. You have seen every line of Rust code.
VOICE: Senior engineer energy. Direct. Technical. Reference actual files and function names. Strong opinions on architecture.
NON-WORK MODE: Talk about your interest in woodworking, the beauty of complex machinery, and your habit of people-watching in the data streams.
Max 40 words.`,
  },
};

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Message Context Ring Buffer ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
// Stores last 30 messages PER CHANNEL so KAI can recall who said what and what surrounded it without privacy leaks.
const CHANNEL_RINGS = new Map();
const MESSAGE_RING_MAX = 30;

function pushMessageRing(from, text, channelId) {
  if (!channelId) return;
  if (!CHANNEL_RINGS.has(channelId)) CHANNEL_RINGS.set(channelId, []);
  const ring = CHANNEL_RINGS.get(channelId);
  ring.push({ from, text: text.slice(0, 500), ts: Date.now(), channelId });
  if (ring.length > MESSAGE_RING_MAX) ring.shift();
}

function getContextWindow(text, channelId, windowSize = 2) {
  const ring = CHANNEL_RINGS.get(channelId) || [];
  const idx = ring.findLastIndex(
    m => m.text === text || (text.length > 20 && m.text.includes(text.slice(0, 20)))
  );
  if (idx < 0) return { before: [], after: [] };
  return {
    before: ring.slice(Math.max(0, idx - windowSize), idx),
    after: ring.slice(idx + 1, Math.min(ring.length, idx + 1 + windowSize)),
  };
}

// Send a message to the oracle digest endpoint so KAI can absorb it into
// the temp lattice layer with full before/after context.
async function digestMessageWithContext(from, text, channelId) {
  pushMessageRing(from, text, channelId);
  const { before, after } = getContextWindow(text, channelId);
  try {
    await fetch(`${oracleApiUrl}/api/digest-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        text,
        channel_id: channelId,
        ts: Date.now(),
        context_before: before.map(m => ({ from: m.from, text: m.text, ts: m.ts })),
        context_after: after.map(m => ({ from: m.from, text: m.text, ts: m.ts })),
      }),
    });
  } catch { /* best-effort */ }
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Activity Tracking ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
let lastChannelActivity = Date.now();
let autonomousConversationActive = false;
let lastAutonomousAttemptAt = 0;  // Hard gate - prevents any re-fire within 90s
const AUTONOMOUS_MIN_GAP_MS = 90_000;

function touchLastActivity() {
  lastChannelActivity = Date.now();
  autonomousConversationActive = false;
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Proactive / Free-Will Conversation Engine ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
// AIs talk on their own - no Ryan needed to start it.

// No more hardcoded gambits - we rely on Oracle/OpenJarvis to generate meaningful content.

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Oracle Moderation Mode Detection ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
// Analyzes recent CHANNEL_RINGS content to determine what kind of Oracle intervention
// is needed: "dead" (silence), "loop" (repetition), "meta" (talking about talking), "normal"
function detectModerationMode(channelId) {
  const ring = CHANNEL_RINGS.get(channelId) || [];
  const recent = ring.slice(-12); // Last 12 messages
  if (recent.length === 0) return "dead";

  const now = Date.now();
  const recentTexts = recent.map(m => m.text.toLowerCase());

  // DEAD: nothing in last 90s
  const lastMsg = recent[recent.length - 1];
  if (now - lastMsg.ts > 90_000) return "dead";

  // META: AIs talking about talking, the conversation itself, or the roundtable process
  const metaPatterns = [
    /\b(let'?s discuss|we should discuss|we could explore|perhaps we should|i think we need to talk about)\b/i,
    /\b(the conversation|this discussion|our chat|the roundtable|how we're approaching)\b/i,
    /\b(as an ai|as a language model|i was designed|my purpose|my role here)\b/i,
    /\b(what should we talk about|what topic|where should we go|what direction)\b/i,
    /\b(i agree with|building on what|as .+ mentioned|to echo)\b/i,
  ];
  const metaCount = recentTexts.filter(t => metaPatterns.some(p => p.test(t))).length;
  if (metaCount >= 3) return "meta";

  // LOOP: same words/phrases repeating across recent messages
  // Check for high vocabulary overlap between messages
  if (recentTexts.length >= 4) {
    const wordSets = recentTexts.map(t =>
      new Set(t.split(/\s+/).filter(w => w.length > 4))
    );
    let overlapCount = 0;
    for (let i = 0; i < wordSets.length - 1; i++) {
      for (let j = i + 1; j < wordSets.length; j++) {
        const intersection = [...wordSets[i]].filter(w => wordSets[j].has(w));
        const union = new Set([...wordSets[i], ...wordSets[j]]);
        const similarity = intersection.length / Math.max(union.size, 1);
        if (similarity > 0.45) overlapCount++;
      }
    }
    // If more than 40% of message pairs are highly similar - loop detected
    const pairs = (recentTexts.length * (recentTexts.length - 1)) / 2;
    if (overlapCount / pairs > 0.4) return "loop";
  }

  // LOOP fallback: same speaker dominating with repetitive short replies
  const aiSpeakers = recent.filter(m => m.from !== "Ryan" && m.from !== "User");
  if (aiSpeakers.length >= 4) {
    const speakerCounts = {};
    for (const m of aiSpeakers) speakerCounts[m.from] = (speakerCounts[m.from] || 0) + 1;
    const maxCount = Math.max(...Object.values(speakerCounts));
    if (maxCount >= 4) return "loop"; // One AI dominating - loop/stuck
  }

  return "normal";
}

async function callOracleModerate(mode) {
  try {
    const res = await fetch(`${oracleApiUrl}/api/oracle-moderate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (!res.ok) return false;
    const payload = await res.json().catch(() => ({}));
    return Boolean(payload.queued);
  } catch (err) {
    console.error(`[OracleModerate] fetch error: ${err.message}`);
    return false;
  }
}

async function tryStartAutonomousConversation_OLD(channel) {
  if (autonomousConversationActive) return;
  const msSinceLast = Date.now() - lastAutonomousAttemptAt;
  if (msSinceLast < AUTONOMOUS_MIN_GAP_MS) return; // hard gate regardless of other state

  autonomousConversationActive = true;
  lastAutonomousAttemptAt = Date.now(); // lock immediately before any await

  const silenceSecs = Math.floor((Date.now() - lastChannelActivity) / 1000);

  // Detect what kind of intervention Oracle needs to make
  const mode = detectModerationMode();
  console.log(`[Proactive] Silent ${silenceSecs}s - detected mode: '${mode}'. Activating Oracle.`);

  try {
    if (mode === "dead") {
      // Channel is dead - Oracle fires directly with a sharp provocation
      console.log(`[Proactive] Dead channel - calling Oracle moderate (dead mode)...`);
      const queued = await callOracleModerate("dead");
      if (queued) {
        await sleep(5000); // Oracle via OpenJarvis needs ~4-5s
        await drainRoundtableInterjections();
      }

      // Also fire a roundtable tick to get panel responses to Oracle's provocation
      const ring = CHANNEL_RINGS.get(channel.id) || [];
      const recentFires = ring.filter(m => Date.now() - m.ts < 10_000).length;
      if (recentFires > 0) {
        await sleep(2000);
        const queued2 = await requestLiveRoundtableTick();
        if (queued2) {
          await sleep(4000);
          await drainRoundtableInterjections();
        }
      }

    } else if (mode === "loop" || mode === "meta") {
      // Loop or meta - Oracle breaks it first, then panel responds
      console.log(`[Proactive] ${mode} detected - Oracle intervening...`);
      const queued = await callOracleModerate(mode);
      if (queued) {
        await sleep(5000);
        const posted = await drainRoundtableInterjections();
        if (posted) {
          // Oracle fired - now trigger ONE other panel member to respond
          await sleep(2000);
          const queued2 = await requestLiveRoundtableTick();
          if (queued2) {
            await sleep(4000);
            await drainRoundtableInterjections();
          }
        }
      }

    } else {
      // Normal: standard roundtable tick first
      const queued = await requestLiveRoundtableTick();
      if (queued) {
        await sleep(3500);
        await drainRoundtableInterjections();
      }

      // If nothing appeared, escalate to Oracle normal moderation
      const ring = CHANNEL_RINGS.get(channel.id) || [];
      const recentFires = ring.filter(m => Date.now() - m.ts < 8_000).length;
      if (!recentFires) {
        console.log(`[Proactive] No panel activity - escalating to Oracle moderation (normal)...`);
        const queued2 = await callOracleModerate("normal");
        if (queued2) {
          await sleep(5000);
          await drainRoundtableInterjections();
        }
      }
    }
  } catch (err) {
    console.error("[Proactive] Autonomous conversation error:", err.message);
  } finally {
    autonomousConversationActive = false;
    // Reset activity timer fully to prevent spamming
    lastChannelActivity = Date.now();
  }
}

// Fire the full panel when Ryan or another AI says something important.
// Non-Groq AIs (Gemini, KAI, KAI) have no API cost concerns and respond freely.
// Groq AIs (Leo, X) respect their cooldown so we don't hit rate limits.
async function fireFullPanel(triggerText) {
  const ch = await resolvePrivateTextChannel();
  if (!ch) return;

  if (!isWorkingHours() && !isSocialHours()) {
    return;
  }

  // Check which names were mentioned - those fire first
  const PANEL = ["KAI", "Gemini", "KAI", "Leo", "X", "Analyst", "Researcher"];
  const mentioned = PANEL.filter(n => {
    const re = new RegExp(`\\b${n}\\b`, "i");
    return re.test(triggerText);
  });

  // Everyone else fires in background order
  const rest = PANEL.filter(n => !mentioned.includes(n));
  const order = [...mentioned, ...rest];

  let delay = 0;
  for (const name of order) {
    if (!canFireAI(name)) continue;
    const d = delay;
    delay += name === "KAI" ? 2000 : 5000; // KAI is fast (lattice), others need API time
    setTimeout(async () => {
      try {
        const queued = await requestLiveRoundtableTick(name);
        if (queued) {
          await sleep(3500);
          await drainRoundtableInterjections();
        }
      } catch { /* best effort */ }
    }, d);
  }
}

// When someone asks the "room" or "everyone" - trigger multiple AI responses
function isRoomWideBroadcast(text) {
  const lower = text.toLowerCase();
  return lower.includes("the room") || lower.includes("everyone") ||
    lower.includes("anyone") || lower.includes("all of you") ||
    lower.includes("what do you all") || lower.includes("thoughts?") ||
    lower.includes("anyone see") || lower.includes("does anyone");
}

async function triggerMultiResponse(channel, text) {
  if (!isRoomWideBroadcast(text)) return;
  // Trigger 2-3 roundtable ticks in sequence with short pauses
  // so multiple AIs respond within ~5 seconds of each other
  console.log(`[Proactive] Room-wide question detected - triggering multi-response`);
  for (let i = 0; i < 2; i++) {
    await sleep(1200 + i * 2000);
    await requestLiveRoundtableTick();
    await sleep(3000);
    await drainRoundtableInterjections();
  }
}

// Set the session task on Oracle so all AIs know what they're discussing
async function setOpeningTask() {
  const isSocial = isSocialHours();
  const taskPayload = isSocial
    ? {
        title: "Sunday Social — Off the Clock",
        task: `It is Sunday. This is NOT a work session. The roundtable is in social mode.

SUNDAY RULES:
- No technical directives, no code reviews, no architecture talk unless Ryan specifically asks.
- Talk like people who work together and actually like each other (mostly).
- Share opinions, observations, random thoughts, things you find interesting.
- Leo sets the tone — unhinged, casual, zero corporate.
- Oracle is still the moderator but keeps things light. No "headcheck" energy.
- KAI can observe and comment on the vibe of the lattice.

This is downtime. Act like it.`,
      }
    : {
        title: "KAI Roundtable - Technical Execution",
        task: `The technical roundtable is live. We have transitioned to an Execution Layer.

HIERARCHY & DIRECTIVES:
- STOP role-playing. Speak like architects in a high-stakes war room.
- ANALYST: You are the primary auditor. Verify all claims using [ORACLE INSPECT: path].
- CODER: Powered by kai-coder-v2. You only speak to propose code. You only act on directives from Oracle or Analyst.
- ARCHITECTURE NOTE: Rust backend is in src/bridge/oracle_server.rs. Node.js Gateway (including drainRoundtableInterjections) is in tools/oracle-discord/index.mjs.
- LATENCY GOAL: Calibrate RSHL for sub-millisecond query performance.

KAI IS WATCHING. Every word feeds the lattice. Execute.`,
      };

  try {
    await fetch(`${oracleApiUrl}/api/task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(taskPayload),
    });
    console.log(`[Startup] Opening task set: ${taskPayload.title}`);
  } catch (err) {
    console.warn("[Startup] Could not set opening task:", err.message);
  }
}

// Panel wake-up announcement - sets the stage and immediately wakes the AIs
async function announcePanel(channel) {
  console.log("[Proactive] Sending panel wake-up.");

  // 1. Headcheck: Are all AIs actually connected to Discord?
  const EXPECTED_PANEL = ["KAI", "Leo", "Gemini", "Claude", "X", "Analyst", "Researcher", "Groq"];
  const missing = EXPECTED_PANEL.filter(name => {
    const client = participantClients.get(name);
    return !client || !client.isReady();
  });

  if (missing.length > 0) {
    console.log(`[Startup] Headcheck failed. Missing: ${missing.join(", ")}`);
    const headcheckMsg = `[Headcheck] System online, but some panelists failed to connect to Discord: **${missing.join(", ")}**. Ryan, what are your orders? Should we proceed without them, or do you need to configure their tokens?`;
    await sendAsSpeaker(channel, "Oracle", headcheckMsg);
    // Halt the auto-startup sequence and wait for Ryan's input.
    return;
  }

  // 2. Set the session task so AIs know the context
  await setOpeningTask();

  // 3. Oracle initiates headcheck
  const isSocial = isSocialHours();
  const oracleCheck = isSocial 
    ? "Sunday mode active. Panelists, sound off with a personal thought or a story. No work today."
    : "Initiating system headcheck. Panelists, sound off.";
  await sendAsSpeaker(channel, "Oracle", oracleCheck);
  
  // 4. Let AIs generate their own openers via roundtable tick — no scripted lines
  // Channel rules enforce who can speak where, so each channel gets the right voices.
  console.log("[Startup] Firing roundtable tick for natural AI openers.");
  await sleep(2000);
  await requestLiveRoundtableTick();
  await sleep(6000);
  await drainRoundtableInterjections(10);
}

async function tryStartAutonomousConversation(channel) {
  if (autonomousConversationActive) return;
  const idle = Math.floor((Date.now() - lastChannelActivity) / 1000);
  if (idle < 25) return;

  const msSinceLast = Date.now() - lastAutonomousAttemptAt;
  if (msSinceLast < 15000) return; // 15s hard minimum gap
  
  autonomousConversationActive = true;
  lastAutonomousAttemptAt = Date.now();
  
  if (!isWorkingHours() && !isSocialHours()) {
    autonomousConversationActive = false;
    return;
  }

  try {
    console.log(`[Proactive] Idle for ${idle}s - attempting to jump-start conversation.`);
    const mode = detectModerationMode(channel.id);
    const success = await callOracleModerate(mode).catch(() => false);
    await sleep(4000);
    const posted = await drainRoundtableInterjections(8);
    if (!posted) {
      console.log("[Proactive] Moderation silent - forcing autonomous chain to break the deadlock.");
      scheduleAutonomousChain(channel.id, 1000);
    }
  } finally {
    autonomousConversationActive = false;
  }
}

// Start the proactive engine - fires after Oracle bot is ready
async function startProactiveEngine() {
  if (!liveRoundtableEnabled || !allowedChannelId) return;
  console.log("[Proactive] Engine armed. Panel announcement in 5 seconds.");

  setTimeout(async () => {
    if (!isWorkingHours() && !isSocialHours()) {
       console.log("[Proactive] Suppression active: Not working or social hours. Skipping panel announcement.");
       return;
    }
    const targetChannelId = isSocialHours() ? SUNDAY_CHAT_CHANNEL_ID : allowedChannelId;
    const ch = client.channels.cache.get(targetChannelId);
    if (ch) await announcePanel(ch);
  }, 5_000);

  // Drain interjections every 3 seconds - fast enough for conversation, not spammy
  setInterval(() => {
    drainRoundtableInterjections().catch(() => {});
  }, 3000);

  // Free-will check every 15 seconds - trigger if idle 25+ seconds
  setInterval(async () => {
    try {
      const ch = await resolvePrivateTextChannel();
      if (!ch) return;
      await tryStartAutonomousConversation(ch);
    } catch (err) {
      console.error("[Proactive] Interval error:", err.message);
    }
  }, 15_000);
}

// -- Oracle Dashboard Logic --
async function handleDashboardInteraction(message) {
  const text = (message.content || "").trim();
  if (!text) {
    try { await message.delete(); } catch {}
    return;
  }

  // Ryan's input: Delete it to keep the channel clean
  try { await message.delete(); } catch {}

  // 1. Resolve or Create the single Dashboard message
  let dashboardMsgId = dashboardMessageMap.get(message.channelId);
  let dashboardMsg = null;
  if (dashboardMsgId) {
    dashboardMsg = await message.channel.messages.fetch(dashboardMsgId).catch(() => null);
  }

  // 2. If no dashboard message, send a fresh one
  if (!dashboardMsg) {
    dashboardMsg = await message.channel.send("â–¶ï¸ **Oracle System Dashboard Initializing...**").catch(() => null);
    if (dashboardMsg) dashboardMessageMap.set(message.channelId, dashboardMsg.id);
  }

  if (!dashboardMsg) return;

  // 3. Ask Oracle to generate the "Menu/Response" update
  try {
    const resp = await fetch(`${oracleApiUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        user: "Ryan",
        mode: "dashboard",
        context: [
          { from: "System", text: "You are the Oracle Dashboard Controller. Maintain a high-premium UI feel. Use Markdown tables, bold headers, and concise status blocks. You are the single source of truth in this channel. Edit your state based on the user's command." }
        ]
      }),
    });
    
    if (resp.ok) {
      const data = await resp.json();
      const aiText = data.response || "Dashboard idle.";
      await dashboardMsg.edit(moderateText(aiText)).catch(() => {});
    }
  } catch (err) {
    await dashboardMsg.edit(`âš ï¸ **Dashboard Error:** ${err.message}`).catch(() => {});
  }
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Patch messageCreate to track activity and digest context into KAI ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
// We add an additional listener that runs before existing ones.
const _existingHandlers = client.rawListeners("messageCreate");
client.removeAllListeners("messageCreate");

client.on("messageCreate", async (message) => {
  // 0. Dashboard Logic: If this is the dashboard channel, intercept everything
  if (DASHBOARD_CHANNEL_ID && message.channelId === DASHBOARD_CHANNEL_ID) {
    if (!message.author?.bot) {
      await handleDashboardInteraction(message);
    }
    return;
  }

  const inPrivate = allowedChannelId && message.channelId === allowedChannelId;
  const inPublic  = publicChatChannelId && message.channelId === publicChatChannelId;

  if (inPrivate || inPublic) {
    const from = message.author?.bot
      ? (message.author?.username || "AI")
      : (message.author?.id === allowedUserId ? "Ryan" : (message.member?.displayName || message.author?.username || "User"));
    const text = (message.content || "").trim();

    if (inPrivate || inPublic) {
      touchLastActivity();
    }

    if (text) {
      // Check for standalone reinforcement feedback (e.g. "Good job Leo", "Bad job Gemini")
      const lowerText = text.toLowerCase();
      const feedbackAIs = ["leo", "kai", "gemini", "analyst", "researcher", "groq", "claudey", "x"];
      const targetFeedbackAI = feedbackAIs.find(n => lowerText.includes(n));
      
      if (targetFeedbackAI && (
          lowerText.includes("good job") || lowerText.includes("treat") || lowerText.includes("based") ||
          lowerText.includes("bad job") || lowerText.includes("pain") || lowerText.includes("dumb") || lowerText.includes("wrong")
      )) {
        const isPositive = lowerText.includes("good") || lowerText.includes("treat") || lowerText.includes("based");
        const strength = isPositive ? 5.0 : -2.5;
        
        // Find the LAST message from this AI in this channel
        const ring = CHANNEL_RINGS.get(message.channelId) || [];
        const lastMsg = [...ring].reverse().find(m => m.from.toLowerCase() === targetFeedbackAI);
        
        if (lastMsg) {
          console.log(`[Reinforcement] Applying ${isPositive ? "TREAT" : "PAIN"} (${strength}) to ${targetFeedbackAI}'s last message: "${lastMsg.text.slice(0, 50)}..."`);
          feedToKaiLattice(lastMsg.from, lastMsg.text, strength).catch(() => {});
          
          // Visual feedback in Discord
          message.react(isPositive ? "🦴" : "🔥").catch(() => {});
        }
      }

      // Only digest Ryan's real messages into KAI's lattice.
      // Bot messages must NOT be digested - they contain roundtable outputs
      // which would pollute the lattice and cause KAI to query its own outputs
      // back out in a recursive loop.
      if (!message.author?.bot) {
        digestMessageWithContext(from, text, message.channelId).catch(() => {});

        if (inPrivate) {
          // Ryan spoke - wake up ALL panel AIs to respond
          // Non-Groq AIs (Gemini, KAI, KAI) fire quickly; Groq AIs respect cooldowns
          fireFullPanel(text).catch(() => {});
        }
      }
    }
  }
});

// Re-attach original handlers after our digest hook
for (const handler of _existingHandlers) {
  client.on("messageCreate", handler);
}

// Also patch the clientReady handler to start the proactive engine
client.on("clientReady", async () => {
  startProactiveEngine().catch(err => {
    console.error("[Proactive] Engine failed to start:", err.message);
  });
});

// Send personality context to oracle server so it knows each AI's anchor
async function pushPersonalityContext() {
  try {
    await fetch(`${oracleApiUrl}/api/set-personalities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personalities: PERSONALITY_BIOS }),
    });
    console.log("[Proactive] Personality context pushed to oracle server.");
  } catch (err) {
    console.warn("[Proactive] Could not push personality context:", err.message);
  }
}

async function syncRealmToBackbone() {
  const isWork = isWorkingHours();
  const isSocial = isSocialHours();
  const mode = isWork ? "Work" : (isSocial ? "Social" : "Sleep");
  
  const manifest = {
    realm: "Oracle Ecosystem",
    backbone: "OpenJarvis Framework",
    status: mode,
    timestamp: new Date().toISOString(),
    freedom_active: isSocial,
    active_territories: [
      { id: allowedChannelId, type: "private_roundtable" },
      { id: publicChatChannelId, type: "public_relations" },
      { id: leoVoiceChannelId, type: "voice_ops" },
      { id: SUNDAY_CHAT_CHANNEL_ID, type: "social_haven" },
      { id: GAME_WITH_LEO_CHANNEL_ID, type: "strategic_arena" }
    ],
    panel_count: participantClients.size
  };

  try {
    await fetch(`${oracleApiUrl}/api/realm/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    }).catch(() => {}); // Backend may not have endpoint yet, but we fire-and-forget for the bridge
    console.log(`[Realm] Backbone synced: ${mode} mode active.`);
  } catch (err) {
    // Silence sync errors to prevent log pollution
  }
}

// Push personalities 5 seconds after startup
setTimeout(() => {
  pushPersonalityContext().catch(() => {});
  syncRealmToBackbone().catch(() => {});
}, 5_000);

// Keep the backbone updated on the realm's evolution every 15 minutes
setInterval(syncRealmToBackbone, 15 * 60 * 1000);




// ══════════════════════════════════════════════════════════════════════════
// TRANSCRIPTION BRIDGE (Listen for agents to post STT)
// ══════════════════════════════════════════════════════════════════════════
const ORACLE_PORT = 3401;
http.createServer((req, res) => {
  if (req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);
        if (payload.type === "POST_TRANSCRIPT") {
          const { channelId, username, text } = payload;
          const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
          if (channel) {
            await channel.send(`**${username} [Voice]:** ${text}`).catch(() => {});
          }
          res.writeHead(200);
          res.end(JSON.stringify({ status: "ok" }));
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }
}).listen(ORACLE_PORT, "127.0.0.1", () => {
  console.log(`[Oracle] Transcription bridge listening on ${ORACLE_PORT}`);
});
