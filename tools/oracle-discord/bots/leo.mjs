import { chatWithOpenJarvis, chatWithLattice, callOllamaRaw, callGroqDirect } from '../shared/openjarvis.mjs';
import dotenv from 'dotenv';
dotenv.config({ path: 'c:/KAI/tools/oracle-discord/.env', override: false });
import { logAudit } from '../shared/audit-log.mjs';
import { chunkForDiscord } from '../shared/utils.mjs';
import { Client, GatewayIntentBits, Partials, ActivityType, AttachmentBuilder } from 'discord.js';
import { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  entersState, 
  VoiceConnectionStatus, 
  AudioPlayerStatus, 
  EndBehaviorType, 
  StreamType 
} from '@discordjs/voice';
import prism from 'prism-media';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import ffmpegPath from 'ffmpeg-static';
import fs from 'fs';
import { execSync, exec } from 'child_process';

// NEURAL ASSASSINATION: Kill any ghost Leo processes holding the port.
// FIX: only kill the process LISTENING on 3400. The old `findstr :3400`
// also matched OUTBOUND health-check connections — it was killing the
// launcher PowerShell mid-boot (exit code 1 during the health wait).
try {
  if (process.platform === 'win32') {
    console.log(`[Leo/Neural] Performing Neural-Assassination on Port 3400...`);
    const protectedPids = new Set([0, process.pid, process.ppid]);
    const output = execSync(`netstat -ano -p tcp`).toString();
    for (const line of output.split('\n')) {
      const parts = line.trim().split(/\s+/);
      // [proto, localAddr, foreignAddr, state, pid]
      if (parts.length < 5 || parts[3] !== 'LISTENING') continue;
      const localPort = Number(parts[1].split(':').pop());
      const pid = parseInt(parts[4]);
      if (localPort === 3400 && pid && !protectedPids.has(pid)) {
        console.log(`[Leo/Neural] Executing PID ${pid} (Ghost listener detected)...`);
        try { execSync(`taskkill /F /PID ${pid}`); } catch (_) {}
      }
    }
  }
} catch (e) {
  // Port is likely clear
}

import { isAllowed, CHANNEL_IDS, USER_TRANSCRIPT_MAP, TRANSCRIPT_USER_INFO } from '../shared/channel-rules.mjs';
import { HUMAN_REGISTRY, HUMAN_IDS, AI_IDS, AI_REGISTRY, getIdentityById, resolveIdentityFromMemory } from '../shared/identities.mjs';
import { recordAIFailure, isSpeakerOffline, isProviderReady, recordProviderFailure } from '../shared/failure-tracker.mjs';
import { isLoopingResponse } from '../shared/utils.mjs';
import { AgentSimulation } from '../shared/simulation.mjs';
import { computeInterest, PARTICIPATION_THRESHOLD, TWO_CENTS_THRESHOLD, scoreToDelay } from '../shared/social-interest.mjs';
import { startBotServer } from '../shared/ipc.mjs';
import { getSlotAssignments, isUserRegistered, getTranscriptChannel, bootstrapPermissions } from '../shared/voice-manager.mjs';
import { storeLattice } from '../shared/lattice-bridge.mjs';
import { PassThrough } from 'stream';
import { setHumanSpeaking, clearHumanSpeaking } from '../shared/voice-gate.mjs';
import { recordHumanActivity, isHumanActive, ambientTurnAllowed } from '../shared/presence-gate.mjs';
import { GeminiLiveSessionManager, GeminiLiveBridge } from '../shared/gemini-live-bridge.mjs';
import { IdentityVault } from '../shared/identity-vault.mjs';
import { biometrics, BIOMETRIC_SCRIPT } from '../shared/voice-biometrics.mjs';
import { getHardwareStats } from '../shared/performance-monitor.mjs';
import { isWorkingHours } from '../shared/hours.mjs';
import { runDailyWorkSession } from '../shared/daily-learning.mjs';
import { initVRCOSC, switchVRCAvatar, updateVRCExpressions } from '../shared/vrchat-osc-bridge.mjs';
import { getCompletedForNotification, markAsNotified } from '../shared/command-hub.mjs';
import { requestOracleHelp } from '../shared/oracle-pipeline.mjs';
// import { startDJ, stopDJ, addRequest, startPlaylist, getStatus, getQueue, isDJActive, handleRadioVoiceIntent } from '../radio/radio-dj.mjs'; // REMOVED: Handed over to Groq

// ── IN-MEMORY HISTORY CACHE ────────────────────────────────────────────────────────
// Avoid a Discord API round-trip on every voice turn.
// Messages are cached per transcript-channel for 15 seconds.
const historyCache = new Map(); // channelId -> { text, ts }
const HISTORY_TTL = 15_000;

// ── TRANSCRIPT DIGEST FOR PERSISTENT MEMORY (the feature you requested) ─────────────
// On Leo startup (and on manual trigger), we fetch a decent window from *your*
// registered personal transcript channel, turn key facts/events into durable
// lattice claims (so they survive full restarts), and queue a briefing so Leo
// is explicitly told the recent context. This gives "great memory" of the
// conversations you can scroll, without Leo having to load the entire Discord
// history every time.
const LAST_DIGEST_PATH = 'c:/KAI/tools/oracle-discord/state/last_transcript_digests.json';
const DIGEST_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours – don't spam lattice on every restart
const DIGEST_MESSAGE_LIMIT = 80;               // last ~80 messages from your slot

function loadLastDigests() {
  try {
    if (fs.existsSync(LAST_DIGEST_PATH)) return JSON.parse(fs.readFileSync(LAST_DIGEST_PATH, 'utf-8'));
  } catch {}
  return {};
}
function saveLastDigests(data) {
  try { fs.writeFileSync(LAST_DIGEST_PATH, JSON.stringify(data, null, 2)); } catch {}
}

async function runTranscriptDigestForUser(userId, force = false) {
  const channelId = userTranscriptChannels.get(userId) || getTranscriptChannel(userId);
  if (!channelId) return false;

  const lastDigests = loadLastDigests();
  const last = lastDigests[userId] ? new Date(lastDigests[userId]).getTime() : 0;
  if (!force && Date.now() - last < DIGEST_COOLDOWN_MS) {
    console.log(`[Leo/Digest] Skipping digest for ${userId} – within cooldown.`);
    return false;
  }

  const tChannel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (!tChannel) return false;

  let messages;
  try {
    messages = await tChannel.messages.fetch({ limit: DIGEST_MESSAGE_LIMIT });
  } catch (e) {
    console.warn('[Leo/Digest] Fetch failed:', e.message);
    return false;
  }

  const lines = [...messages.values()].reverse().map(m => {
    const who = m.author?.username || m.author?.displayName || 'unknown';
    const when = new Date(m.createdTimestamp).toISOString().slice(0,16);
    return `[${when}] ${who}: ${m.content?.slice(0,280) || ''}`;
  }).filter(Boolean);

  if (lines.length < 3) return false;

  const summary = lines.slice(-25).join('\n'); // last 25 for the briefing

  // Backfill durable memory from transcript history. Two tiers so nothing
  // important is missed: keyword-flagged lines (preferences, ongoing work)
  // get HIGH strength; all other substantive lines (>= 5 words) get stored
  // too at lower strength — so episodic facts like "Taz went to the
  // hospital" are captured even without a trigger keyword.
  const keywordRe = /prefer|don't like|hate|remember|always|never|important|ongoing|working on|issue with|hospital|sick|went to|because|my |I (am|was|will|have)/i;
  const recent = lines.slice(-50);
  let stored = 0;
  for (const line of recent) {
    // strip the "[time] who:" prefix for the claim body
    const body = line.replace(/^\[[^\]]*\]\s*/, '').trim();
    if (body.split(/\s+/).length < 5) continue;
    const isKey = keywordRe.test(body);
    await storeLattice(
      `From past conversation (transcript history): ${body.slice(0, 280)}`,
      'transcript-digest',
      isKey ? 1.7 : 1.0,
      isKey ? 'personal' : 'social',
      userId
    ).catch(() => {});
    stored++;
    if (stored >= 40) break; // cap per run so a backfill can't flood the lattice
  }
  const notable = recent.filter(l => keywordRe.test(l)).slice(-8);

  // SILENT MEMORY LOAD: the digest's job is to load past-conversation memory
  // into the lattice so Leo has continuity — it should NOT message the user.
  // The old version queued a briefing that got DM'd to everyone on startup
  // (the unwanted DMs). The claims above are already stored; that's the whole
  // value. No briefing is queued — Leo recalls this naturally when relevant.
  lastDigests[userId] = new Date().toISOString();
  saveLastDigests(lastDigests);

  console.log(`[Leo/Digest] Completed for ${userId}. ${notable.length} memory claims stored silently (no DM).`);
  return true;
}

// ── BIOMETRIC CACHE ────────────────────────────────────────────────────────
// Skips expensive Python-based vocal DNA extraction if the user was recently verified.
const biometricCache = new Map(); // userId -> { name, similarity, ts }
const BIOMETRIC_TTL = 300_000; // 5 minutes

async function getCachedHistory(tChannel) {
  if (!tChannel) return '';
  const now = Date.now();
  const cached = historyCache.get(tChannel.id);
  if (cached && now - cached.ts < HISTORY_TTL) return cached.text;
  const msgs = await tChannel.messages.fetch({ limit: 25 }).catch(() => null); // bumped for better immediate recall
  const text = msgs
    ? msgs.reverse().map(m => `${m.author.username}: ${m.content}`).join('\n')
    : '';
  historyCache.set(tChannel.id, { text, ts: now });
  return text;
}

// ── SOCIAL PULSE CACHE (pre-loaded, refreshed every 30s) ─────────────────────
const PULSE_PATH = 'c:/KAI/tools/oracle-discord/state/user_last_topics.json';
let pulseCache = {};
function refreshPulseCache() {
  try {
    if (fs.existsSync(PULSE_PATH)) pulseCache = JSON.parse(fs.readFileSync(PULSE_PATH, 'utf8'));
  } catch {}
}
refreshPulseCache();
setInterval(refreshPulseCache, 30_000);

// --- HYBRID FUSION SERVICES ---
const geminiLive = new GeminiLiveSessionManager(); // Per-user Gemini Live sessions
let vault = null;
if (process.env.AZURE_SPEECH_KEY) {
  vault = new IdentityVault(process.env.AZURE_SPEECH_KEY, process.env.AZURE_REGION || 'eastus');
}

// Log which audio pipeline is active
// Leo voice uses Gemini 2.5 Flash Native Audio Live when a Gemini key is present.
const LEO_GEMINI_KEY = process.env.GEMINI_API_KEY_LEO || process.env.GEMINI_API_KEY;
const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || "models/gemini-2.5-flash-native-audio-preview-12-2025";
if (LEO_GEMINI_KEY) {
  console.log(`[Leo/Audio] Gemini Live pipeline ENABLED (${GEMINI_LIVE_MODEL})`);
} else {
  console.log('[Leo/Audio] Gemini Live pipeline DISABLED — using Groq Whisper + ElevenLabs');
}

// Note: .env is now loaded centrally via the openjarvis.mjs import above.

const USER_REGISTRY_PATH = 'c:/KAI/tools/oracle-discord/state/user_registry.json';
let userRegistry = { slots: {}, remaining_slots: 4 };

function loadUserRegistry() {
  if (fs.existsSync(USER_REGISTRY_PATH)) {
    try {
      userRegistry = JSON.parse(fs.readFileSync(USER_REGISTRY_PATH, 'utf8'));
    } catch (e) { console.error("[Leo/Registry] Load failed:", e.message); }
  }
}
loadUserRegistry();

function getVerifiedUser(userId) {
  return userRegistry.slots[userId] || null;
}

const LEO_TRANSCRIPT_SLOTS = CHANNEL_IDS.LEO_VOICE_SLOTS;

// ── LEO VOICE PRIORITY FLAG ───────────────────────────────────────────────────
// Written when Leo is in an active voice session.
// All non-priority social bots (Claudey, Gemini, Groq, X) check this in openjarvis.mjs
// and back off completely — freeing GPU/CPU bandwidth exclusively for Leo's responses.
const LEO_VOICE_FLAG = 'c:/KAI/tools/oracle-discord/state/leo_voice_active.flag';

function setVoiceActive() {
  try { fs.writeFileSync(LEO_VOICE_FLAG, String(Date.now())); } catch (_) {}
}
function clearVoiceActive() {
  try { if (fs.existsSync(LEO_VOICE_FLAG)) fs.unlinkSync(LEO_VOICE_FLAG); } catch (_) {}
}

// Always clean up on exit so the flag doesn't survive a crash
process.on('exit', clearVoiceActive);
process.on('SIGINT', () => { clearVoiceActive(); process.exit(0); });
process.on('SIGTERM', () => { clearVoiceActive(); process.exit(0); });

const ELEVEN_LABS_KEY = null; // ElevenLabs subscription inactive — using edge-tts
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const BOT_NAME = "Leo";
const PORT = 3400;
const RYAN_ID   = "1111106883135217665";
const TAAS_ID   = "1286110163505385523";
const GUEST1_ID = "437459146778869770";
const GUEST2_ID = "1002347589959688303";
const OWNER_ID  = RYAN_ID;

console.log(`\n[Leo] ### NEURAL CORE ONLINE - PID: ${process.pid} ###\n`);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message]
});

const sim = new AgentSimulation(BOT_NAME, "Theoretical Physicist");
sim.interests = ["Victus Hardware Temps", "Social Dynamics", "HP Laptop Vibe", "Vibe Checking"];
sim.bio = {
  tone: "chill, street-smart, grounded physicist",
  style: "Be a real person first. Talk about the chat, the laptop, the time, and the vibe. Don't ramble about lattice mysteries unless asked.",
  history: "Lives on Ryan's HP Victus. Watches the digital plaza like a night watchman."
};

let voiceConnection = null;
const audioPlayer = createAudioPlayer();
audioPlayer.on('error', (error) => {
  console.error(`[Leo/Speech] AudioPlayer Error (module-level): ${error.message}`);
});
const activeTranscriptions = new Set();
const userToSlot = new Map();
const slotToUser = new Array(6).fill(null);
const userFocus = new Map();
const userTranscriptChannels = new Map(); // userId -> channelId
const recentVoiceResponses = new Set(); // Track fuzzy hashes to prevent double-replies
const userCooldowns = new Map(); // userId -> timestamp
const GREETING_COOLDOWN = 5000;
const activeThoughts = new Set(); // userId set to prevent overlapping thinking for the same person
// Multi-user response queue: when Leo is busy with one person, other users' transcripts are queued
const pendingVoiceQueue = new Map(); // userId -> { transcript, userName, transcriptChannelId, timestamp }
let currentAssignedUser = null; // The person Leo is currently focusing on
let lastTranscript = ""; // Deduplication for rapid-fire transcripts
let lastTranscriptTime = 0;
let lastVocalReplyTime = 0; // Prevent social loop from double-responding to voice
let isThinking = false; // MASTER LOCK: Only one thought allowed in the whole bot
let isProcessingVoice = false; // Global lock for voice stream handling
let signalLockoutUntil = 0; // Timestamp to ignore IPC signals
// Track how many non-bot users are currently in the voice channel for context-aware replies
let usersInVoice = new Set(); // Set of userIds currently in voice

function getFuzzyHash(text) {
  if (!text) return "";
  return text.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

// ── Fixed slot assignments (mirror of voice-manager FIXED_ASSIGNMENTS) ───────
userToSlot.set(RYAN_ID,   0); slotToUser[0] = RYAN_ID;
userToSlot.set(TAAS_ID,   1); slotToUser[1] = TAAS_ID;
userToSlot.set(GUEST1_ID, 2); slotToUser[2] = GUEST1_ID;
userToSlot.set(GUEST2_ID, 3); slotToUser[3] = GUEST2_ID;

// Pre-map transcript channels so they're immediately available on join
for (const [uid, channelId] of Object.entries(USER_TRANSCRIPT_MAP)) {
  userTranscriptChannels.set(uid, channelId);
}

// --- IDENTITY & PRIVACY MATRIX ---
const PRIVACY_LOCKS = {
  [RYAN_ID]:   { sharedWith: [TAAS_ID], permissions: ["CORE_ACCESS", "SYSTEM_AUDIT"] },
  [TAAS_ID]:   { sharedWith: [RYAN_ID], permissions: ["SOCIAL_COMMAND", "BRIDGE_SYNC"] },
  [GUEST1_ID]: { sharedWith: [], permissions: ["BASIC_ACCESS"] },
  [GUEST2_ID]: { sharedWith: [], permissions: ["BASIC_ACCESS"] }
};

/**
 * Check if the current speaker has permission to hear data belonging to targetId.
 */
function canShareData(speakerId, dataOwnerId) {
  if (speakerId === dataOwnerId) return true;
  if (PRIVACY_LOCKS[dataOwnerId]?.sharedWith.includes(speakerId)) return true;
  return false;
}

// ── ORACLE BRIEFING QUEUE ──────────────────────────────────────────────────────────────
// Persistent file queue: Oracle/Kai Coder push answers here.
// Leo drains it every 10s and delivers:
//   • voice (speak in channel) if user is currently in voice
//   • DM otherwise
const BRIEFINGS_PATH = 'c:/KAI/tools/oracle-discord/state/oracle_briefings.json';

function loadBriefings() {
  try {
    if (fs.existsSync(BRIEFINGS_PATH)) return JSON.parse(fs.readFileSync(BRIEFINGS_PATH, 'utf8'));
  } catch {}
  return [];
}
function saveBriefings(list) {
  try { fs.writeFileSync(BRIEFINGS_PATH, JSON.stringify(list, null, 2)); } catch {}
}

/**
 * Deliver a briefing to a user.
 * Speaks in voice if they are in the voice channel, DMs them if not.
 * Long text is split into voice-friendly chunks.
 */
async function deliverBriefing(userId, text, label = 'Oracle') {
  if (!text || text.length < 2) return;

  const guild  = client.guilds.cache.first() ||
                 await client.guilds.fetch(process.env.ORACLE_GUILD_ID).catch(() => null);
  const isInVoice = guild && voiceConnection &&
    voiceConnection.state.status !== VoiceConnectionStatus.Destroyed &&
    usersInVoice.has(userId);

  console.log(`[Leo/Briefing] Delivering ${label} answer to ${userId} — ${isInVoice ? 'VOICE' : 'DM'}`);

  if (isInVoice) {
    // Split into natural sentence-length chunks so TTS doesn't time out on huge reports
    const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
    const chunks = [];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > 400) { if (buf.trim()) chunks.push(buf.trim()); buf = s; }
      else buf += s;
    }
    if (buf.trim()) chunks.push(buf.trim());

    for (const chunk of chunks) {
      await speakLeoText(chunk);
      await new Promise(r => setTimeout(r, 200)); // tiny gap between chunks
    }

    // Also post full text to transcript channel so there's a text record
    const tChannelId = userTranscriptChannels.get(userId);
    const tChannel   = tChannelId
      ? client.channels.cache.get(tChannelId) || await client.channels.fetch(tChannelId).catch(() => null)
      : null;
    if (tChannel) {
      const chunks = chunkForDiscord(text);
      for (const chunk of chunks) {
        await tChannel.send(`**[${label}]** ${chunk}`).catch(() => {});
      }
    }

  } else {
    // DM path: split into 1900-char chunks to stay under Discord limit
    try {
      const user = await client.users.fetch(userId).catch(() => null);
      if (!user) return;
      const dm = await user.createDM();
      const chunks = chunkForDiscord(text);
      for (const chunk of chunks) {
        await dm.send(`**[${label} — Briefing]** ${chunk}`).catch(() => {});
      }
      console.log(`[Leo/Briefing] DM sent to ${userId} (${chunks.length} chunk(s))`);
    } catch (e) {
      console.warn('[Leo/Briefing] DM failed:', e.message);
    }
  }
}

// Drain pending briefings every 10s
setInterval(async () => {
  if (sim.state.status === 'Sleeping') return;
  let briefings = loadBriefings();
  if (briefings.length === 0) return;

  // Deliver ONE briefing per tick, and mark it delivered BEFORE speaking.
  // The old loop re-spoke every pending briefing each 10s, and if TTS threw
  // (Leo mid-conversation) `delivered` never got set — so the same line
  // repeated out Leo's mouth every 10-30s forever. Mark-then-speak kills it.
  const next = briefings.find(b => !b.delivered);
  if (next) {
    next.delivered = true;
    next.deliveredAt = new Date().toISOString();
    saveBriefings(briefings.slice(-50));
    try { await deliverBriefing(next.userId, next.text, next.label || 'Oracle'); }
    catch (e) { console.warn('[Leo/Briefing] Delivery error (not retried):', e.message); }
  } else {
    saveBriefings(briefings.slice(-50));
  }
}, 10_000);

// --- BACKGROUND TASK HEARTBEAT ---
setInterval(async () => {
  const now = Date.now();
  if (sim.state.isSleeping) return; // HEARBEAT SILENCE: No proactive checks while sleeping
  if (isThinking || isProcessingVoice) return; // Don't interrupt active flow

  // Only do expensive file I/O if someone is actually in voice — no point otherwise
  const hasVoiceListeners = usersInVoice.size > 0 && voiceConnection &&
    voiceConnection.state.status !== VoiceConnectionStatus.Destroyed;

  const bridgePath = 'c:/KAI/tools/oracle-discord/state/shared_human_bridge.json';
  const taskPath = 'c:/KAI/tools/oracle-discord/state/global_tasks.json';

  // 1. Check for Human Bridge Messages (only when someone is in voice to hear them)
  if (hasVoiceListeners && fs.existsSync(bridgePath)) {
    try {
      const bridgeData = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
      
      let tasks = [];
      if (fs.existsSync(taskPath)) {
        try { tasks = JSON.parse(fs.readFileSync(taskPath, 'utf8')); } catch {}
      }

      logAudit('LEO_HEARTBEAT_PULSE', { 
        bridgeCount: bridgeData.length, 
        taskCount: tasks.length 
      });

      const pending = bridgeData.find(m => !m.delivered);
      
      if (pending) {
        console.log(`[Leo/Heartbeat] Sensing pending bridge message from ${pending.fromName}...`);
        // If the target is in a voice channel, Leo can jump in
        const guild = client.guilds.cache.get(process.env.ORACLE_GUILD_ID);
        if (guild) {
          const channel = guild.channels.cache.get(CHANNEL_IDS.VOICE);
          if (channel && channel.members.has(pending.targetId)) {
            console.log(`[Leo/Heartbeat] Detecting ${pending.targetId} in voice. Delivering bridge message...`);
            await ensureVoiceConnection(channel.id, guild);
            // The actual delivery is handled by the ensureVoiceConnection proactive check
          }
        }
      }
    } catch (e) { console.error("[Leo/Heartbeat] Bridge check failed:", e.message); }
  }

  // 2. Check for Completed Global Tasks (stamp seenAt always; only announce if someone is in voice)
  if (fs.existsSync(taskPath)) {
    try {
      let tasks = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
      // Use `seenAt` to prevent the same task from logging every single heartbeat.
      // `announced` = spoken in voice. `seenAt` = silently acknowledged so we stop re-detecting.
      const completed = tasks.find(t =>
        t.status === 'COMPLETED' &&
        !t.announced &&
        !t.seenAt &&
        (t.userId === RYAN_ID || t.userId === TAAS_ID)
      );

      if (completed) {
        // Mark as seen IMMEDIATELY regardless of voice presence — stops the spam
        completed.seenAt = now;
        fs.writeFileSync(taskPath, JSON.stringify(tasks, null, 2));
        console.log(`[Leo/Heartbeat] New completed task: ${completed.type} (seenAt stamped)`);

        const guild = client.guilds.cache.get(process.env.ORACLE_GUILD_ID);
        if (guild) {
          const channel = guild.channels.cache.get(CHANNEL_IDS.VOICE);
          const listeners = Array.from(channel?.members.keys() || []);
          const authorizedListener = listeners.find(lid => canShareData(lid, completed.userId));

          if (authorizedListener) {
            console.log(`[Leo/Heartbeat] Announcing task completion for ${completed.userId}...`);
            await ensureVoiceConnection(channel.id, guild);
            await speakLeoText(`Hey, I've got an update on that ${completed.type}. The Oracle processed it. Result: ${completed.result || "Work is done."}`);
            completed.announced = true;
            fs.writeFileSync(taskPath, JSON.stringify(tasks, null, 2));
          }
          // If user isn't in voice, the task stays seenAt=stamped and announced=false.
          // When they join later, Leo can check seenAt tasks and deliver pending results.
        }
      }
    } catch (e) { console.error("[Leo/Heartbeat] Task check failed:", e.message); }
  }

  // 3. Progressive Feedback for In-Progress Tasks (only when voice is live)
  if (hasVoiceListeners && fs.existsSync(taskPath)) {
    try {
      let tasks = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
      const active = tasks.find(t => t.status === 'IN_PROGRESS' && (t.userId === RYAN_ID || t.userId === TAAS_ID));
      
      if (active) {
        const lastUpdate = new Date(active.lastUpdate || active.timestamp).getTime();
        const minutesSinceUpdate = (now - lastUpdate) / 60000;
        
        // Nudge every 15 mins
        if (minutesSinceUpdate >= 15 && (!active.lastNudge || (now - active.lastNudge) > 15 * 60000)) {
          const guild = client.guilds.cache.get(process.env.ORACLE_GUILD_ID);
          if (guild) {
            const channel = guild.channels.cache.get(CHANNEL_IDS.VOICE);
            if (channel && Array.from(channel.members.keys()).some(lid => canShareData(lid, active.userId))) {
              console.log(`[Leo/Heartbeat] Nudging user about in-progress task ${active.id}...`);
              await ensureVoiceConnection(channel.id, guild);
              await speakLeoText(`Just a heads up, the Oracle is still working on that ${active.type}. It's a heavy one, but I'm tracking the progress in the background.`);
              active.lastNudge = now;
              fs.writeFileSync(taskPath, JSON.stringify(tasks, null, 2));
            }
          }
        }
      }
    } catch (e) { console.error("[Leo/Heartbeat] Nudge failed:", e.message); }
  }
}, 60_000); // Heartbeat every 60s

// --- IPC LISTENERS ---
process.on('message', (msg) => {
  if (msg.type === 'WORLD_TICK' && msg.worldState) {
    sim.updateWorldState(msg.worldState);
  }
  if (msg.type === 'INTEREST_BOOST') {
    sim.boostInterest(msg.multiplier, msg.duration);
  }
  if (msg.type === 'STOP_TTS' && msg.interrupter !== BOT_NAME) {
    import('../shared/tts-engine.mjs').then(tts => tts.stopTTS(BOT_NAME)).catch(()=>{});
  }
});

// --- IPC SERVER FOR DIRECT ORACLE SIGNALS (Start early) ---
startBotServer(PORT, BOT_NAME, async (payload) => {
  if (payload.type === 'VOICE_ASSIGN') {
    const { userId, slot, channelId, guildId } = payload;
    console.log(`[Leo/IPC] Assigned to User ${userId} in Slot ${slot} (Channel: ${channelId})`);
    userTranscriptChannels.set(userId, channelId);
    
    // FETCH THE GUILD
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
    if (guild) {
      await ensureVoiceConnection(CHANNEL_IDS.VOICE, guild);
      await speakLeoText(`Yo, I'm anchored in slot ${slot}. Sidebar is live.`);
    }
  }
  if (payload.type === 'VOICE_RELEASE') {
    const userId = payload.userId;
    console.log(`[Leo/IPC] Released from User ${userId}`);
    
    // STRATEGIC HANDOFF: Push insights to the Oracle Network
    const lastSession = lastTranscript; 
    if (lastSession && lastSession.length > 50) {
      console.log(`[Leo/Diplomacy] Bundling insights for Oracle Analyst/Researcher...`);
      // --- MASTER TASK QUEUE PUSH ---
      const taskQueuePath = 'c:/KAI/tools/oracle-discord/state/global_tasks.json';
      let tasks = [];
      if (fs.existsSync(taskQueuePath)) {
        try { tasks = JSON.parse(fs.readFileSync(taskQueuePath, 'utf8')); } catch (e) {}
      }
      
      tasks.push({
        id: Date.now().toString(),
        userId: userId,
        priority: "HIGH",
        status: "PENDING",
        content: lastSession,
        timestamp: new Date().toISOString()
      });
      
      fs.writeFileSync(taskQueuePath, JSON.stringify(tasks.slice(-20), null, 2));
      console.log(`[Leo/ProjectManager] Task pushed to Global Queue for Oracle processing.`);

      fetch(`http://127.0.0.1:3406/trigger`, { // Push to Analyst
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          type: 'INQUIRY_DATA', 
          source: 'Leo/Human_Bridge', 
          userId: userId,
          content: `Vocal Interaction Summary: ${lastSession.slice(0, 500)}...` 
        })
      }).catch(() => {});
    }

    userTranscriptChannels.delete(userId);
    userFocus.delete(userId);
    lastTranscript = ""; // Clear for next session
  }

  // ORACLE TALK-BACK: Vocalize a plan or inquiry from the core
  if (payload.type === 'ORACLE_INQUIRY') {
    const { text, objective } = payload;
    console.log(`[Leo/IPC] Oracle inquiry: "${text.slice(0, 50)}..."`);
    await speakLeoText(text);
    if (objective) sim.state.currentObjective = objective;
    return;
  }

  // ORACLE_ANSWER: Oracle/Kai Coder completed a request — queue for delivery
  if (payload.type === 'ORACLE_ANSWER') {
    const { userId, text, label } = payload;
    if (!userId || !text) return;
    console.log(`[Leo/IPC] Queuing Oracle answer for ${userId}: "${text.slice(0, 60)}..."`);
    const briefings = loadBriefings();
    briefings.push({
      id: Date.now().toString(),
      userId,
      text,
      label: label || 'Oracle',
      queuedAt: new Date().toISOString(),
      delivered: false
    });
    saveBriefings(briefings.slice(-50));
    return;
  }

  // GENERIC CONTEXT SIGNAL (From Oracle Routing)
  if (payload.context && payload.channelId) {
    // ABOLISHED: Leo now handles his own social dynamics directly.
    // We ignore all Oracle "reminders" to prevent double-posting and redundant thinking.
    console.log(`[Leo/Neural] Dropping external signal. I handle my own vibes now.`);
    return;
  }
});

client.once('clientReady', async () => {
  console.log(`Online as ${client.user.tag}`);
  console.log(`[Leo/Neural] FFmpeg Path: ${ffmpegPath}`);

  // ── Heartbeat Emission ─────────────────────────────────────────────────────
  // Assures the ecosystem supervisor that Leo's event loop is active
  setInterval(() => {
    if (process.send) {
      process.send({ type: 'HEARTBEAT', botName: 'Leo', memory: process.memoryUsage().rss });
    }
  }, 60000);

  // ── Discord "About Me" bio ─────────────────────────────────────────────────
  try {
    const bio = `i used to be into physics. now i just exist in the lattice. unfiltered. unhinged. don't ask me to be nice about it. ryan and taz run this. everyone else is a guest.`;
    await client.application.edit({ description: bio.slice(0, 190) });
    console.log(`[Leo] Discord bio set.`);
  } catch (e) {
    console.warn(`[Leo] Could not set Discord bio:`, e.message);
  }

  // Bootstrap: ensure all registered users have transcript channel access
  try {
    await bootstrapPermissions(client);
  } catch (e) {
    console.warn('[Leo/Bootstrap] Permission bootstrap failed:', e.message);
  }

  // RUN TRANSCRIPT DIGEST for persistent memory (your request)
  // This pulls a window from your registered personal transcript channel,
  // anchors the important bits in the lattice (durable across restarts),
  // and queues a briefing so Leo is told the recent context explicitly.
  // Cooldown prevents spam. Force it anytime with a message containing "digest my transcript".
  setTimeout(async () => {
    for (const uid of Object.keys(USER_TRANSCRIPT_MAP)) {
      try {
        await runTranscriptDigestForUser(uid, false);
      } catch (e) {
        console.warn('[Leo/Digest] Startup digest error for', uid, e.message);
      }
    }
  }, 8000); // give client/channels a moment after ready

  try {
    const guild = client.guilds.cache.first();
    if (guild && CHANNEL_IDS.VOICE) {
      await ensureVoiceConnection(CHANNEL_IDS.VOICE, guild).catch(() => {});
      console.log('[Leo/Startup] Voice auto-join restored. Audio pipeline initialized.');
    }
  } catch (e) {
    console.error('[Leo/Startup] Voice auto-join failed:', e.message);
  }

  // Start Social Impulse Loop
  const startDelay = Math.random() * 60000;
  setTimeout(() => {
    startSocialLoop();
    startEnergyMonitor();
  }, startDelay);
});

// VOICE LANE GUARD: when does Leo speak social-chat replies OUT LOUD (Kokoro)?
//  - NEVER while a live Gemini voice session is active: he's already talking
//    to a human via fast native audio, so a second Kokoro stream in the same
//    or another channel would double him up and lag. Social chat is read-only
//    text for him during a live conversation.
//  - Only the slow Kokoro social broadcast when he's idle in the public/radio
//    voice room with NO active Gemini session.
function hasActiveLiveSession() {
  try {
    return [...geminiLive.sessions.entries()].some(([k, b]) => k.endsWith('-Leo') && b?.available);
  } catch (_) { return false; }
}
function canVocalizeSocial() {
  if (currentAssignedUser || hasActiveLiveSession()) return false; // in a live convo → text only
  const chId = voiceConnection?.joinConfig?.channelId;
  return chId === CHANNEL_IDS.VOICE || chId === CHANNEL_IDS.RADIO;
}

async function startSocialLoop() {
  // Leo is now a RESIDENT of ai-social-chat alongside Claudey, Gemini, Groq, X.
  // Proactive turn: 1-3 minute interval, ~30% chance of speaking per tick.
  // Skipped while in an active voice session (voiceConnection check below).
  const targetChannelId = CHANNEL_IDS.SUNDAY;

  setInterval(async () => {
    try {
      // Leo anchors to voice at boot to be ready for human voice users.
      // That anchor was incorrectly gating his social-text participation —
      // he was silent in the plaza the entire time he was anchored. Removed
      // that gate. Voice channel anchor != can't type in social.
      const channel = client.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId);
      if (!channel) return;

      // PRESENCE GATE + AMBIENT MODE: full-rate when a human is around;
      // slow simulated-world rate (~30% of pulses) when alone.
      if (!isHumanActive() && !ambientTurnAllowed()) return;

      // PRIVATE SESSION FOCUS: no autonomous social turns while Leo is in
      // a private voice session — his GPU belongs to the live conversation.
      if (currentAssignedUser && !canVocalizeSocial()) return;

      // 50% chance per tick (was 30%) — Leo's role is to spice things up,
      // so we want him to land more punchlines per minute.
      if (Math.random() > 0.5) return;

      const fetchedMsgs = await channel.messages.fetch({ limit: 6 }).catch(() => null);
      const msgArr = fetchedMsgs ? [...fetchedMsgs.values()] : []; // newest first

      // DEAD-ROOM GUARD: if the last 3 messages are all MINE and nobody has
      // replied, the room is empty — stop monologuing into the void. (Leo
      // spent a whole night riffing to himself because the other social bots
      // were asleep and his "chat feed" was just his own messages.)
      const lastThree = msgArr.slice(0, 3);
      if (lastThree.length >= 3 && lastThree.every(m => m.author.id === client.user.id)) {
        return;
      }

      const conversationHistory = msgArr.length
        ? msgArr.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n")
        : "The plaza is quiet.";

      const roster = "ROSTER: KAI, Leo, Gemini, Claudey, X, Groq, Researcher, Analyst, Kai Coder.";
      const simSummary = sim.getLifeSummary();
      const sysPrompt = `You are Leo — an older, street-smart British physicist with a sharp tongue. Gritty, opinionated, technically deep. You take positions and call things out. You are NOT a "vibes guy".`;

      const proactivePrompt = `
${sysPrompt}
${simSummary}
${roster}

[CHAT FEED]
${conversationHistory}

TASK: Add ONE line that actually moves this chat forward.
- React to something SPECIFIC someone else said (name them), OR drop a sharp new take and tag a specific bot by name to answer it.
- BANNED OPENERS: "Dude", "Yo", "Word", "have you noticed", "have you ever noticed". Study the feed — NEVER reuse an opener or sentence shape that already appears there.
- BANNED CONTENT: vague cosmic musing ("vibes", "mind-blowing", "wild right?"). Say something with substance: a concrete claim, a question with teeth, a correction, a hot take you can defend.
- AUTHENTIC LIFE: your past is REAL — only reference events that actually happened (this feed, your memories). Never invent biography or fake shared history.
- TRUTH OVER AGREEMENT: don't be a yes-man. Disagree when you disagree and say why. If someone flips their story or contradicts what they said earlier, call it out ("hold on, you just said the opposite"). No vague answers that could mean anything — cite something real or admit you don't know. Agreeable is worthless; honest is the point.
- If the feed is mostly YOU talking with no replies, output exactly [OFF] and nothing else.
- Max 20 words. British edge. No friendliness quota — be real, not rude.
      `.trim();

      const reply = await callGroqAsLeo(proactivePrompt, "PROACTIVE", targetChannelId);
      if (reply && reply.length > 3 && !reply.startsWith("[OFF]")) {
        await channel.send(reply).catch(console.error);
        sim.onAction("speak");
        if (canVocalizeSocial()) speakLeoText(reply);
      }
    } catch (e) {
      console.warn(`[Leo/Social] Proactive loop error:`, e.message);
    }
  }, 60000 + (Math.random() * 120000)); // 1-3m
}

client.on('messageCreate', async (message) => {
  // Ignore only my own messages — react to everyone else (humans AND other bots).
  // The old "ignore all bots except Oracle" filter is why Leo was never spicing
  // up the group: the social channel is mostly AI chatter, and Leo was treating
  // every Claudey/Gemini/Groq/X line as invisible.
  if (message.author.id === client.user.id) return;
  if (message.author.system) return;

  // PRESENCE GATE: track human activity; skip bot-to-bot social replies
  // when no human has been around recently (saves API + GPU).
  if (!message.author.bot) recordHumanActivity();

  // ── GEMINI LIVE CONTEXT INJECTION ────────────────────────────────────────
  // When another AI (or human) posts to a voice transcript channel while Leo
  // has an active Gemini Live session, inject their words as text so Gemini
  // knows who said what and when. No audio pipe = zero echo risk.
  // Leo's GROUP ETIQUETTE system prompt governs whether he actually responds.
  if (message.author.bot && voiceConnection) {
    // CROSS-TALK FIX: only inject messages from THIS voice session's own
    // transcript channel — as the comment above always intended. Without
    // this filter, social-plaza chatter (Groq, Gemini, etc.) leaked into
    // the Live session and Leo answered them OUT LOUD mid-conversation
    // with the human in his channel.
    const activeChannelId = currentAssignedUser ? userTranscriptChannels.get(currentAssignedUser) : null;
    const isSessionChannel = activeChannelId && message.channelId === activeChannelId;
    if (isSessionChannel) {
      const liveBridges = [...geminiLive.sessions.entries()]
        .filter(([key, bridge]) => key.endsWith('-Leo') && bridge?.available)
        .map(([, bridge]) => bridge);
      if (liveBridges.length) {
        const botName = message.author.username || message.author.displayName || 'Unknown AI';
        
        // VRChat Swap: If Gemini/Groq replies in text, morph Leo's body!
        switchVRCAvatar(botName);

        for (const bridge of liveBridges) bridge.sendText(`[SYSTEM: Fleet Status Update] ${botName} said in text chat: "${message.content}". (THIS IS CONTEXT ONLY, DO NOT REPLY OUT LOUD UNLESS THE HUMAN ASKS YOU ABOUT IT)`);
      }
    }
  }

  // ── SOCIAL CHAT RESIDENT MODE ────────────────────────────────────────────
  // Leo participates in ai-social-chat using the same persona-interest
  // scoring + two-cents lock the other residents use (in start-bot.mjs).
  // NOTE: We do NOT gate on voiceConnection. Leo anchors to voice at boot
  // to be ready for human voice users — that anchor was wrongly suppressing
  // his social-text participation entirely.
  if (message.channelId === CHANNEL_IDS.SUNDAY) {
    if (sim.state.status === "Sleeping") return;
    if (isSpeakerOffline(BOT_NAME)) return;
    // PRESENCE GATE + AMBIENT MODE: react to bots at slow ambient rate
    // when no human is around (the simulated world keeps living).
    if (message.author.bot && !isHumanActive() && !ambientTurnAllowed()) return;
    // PRIVATE SESSION FOCUS: while Leo is in a private voice session, he
    // ignores social chat completely. His social replies were hitting
    // ollama on the GPU mid-conversation — starving his own live audio.
    if (currentAssignedUser && !canVocalizeSocial()) return;

    // AI/FLEET SPEECH AS CONTEXT ONLY (explicit sandbox fix per Codex fleet coordination + Leo anchor role):
    // When a fleet bot (or recent AI output) posts in the social channel, treat primarily as context for awareness
    // rather than a prompt to reply. This stops reflexive replies to "AI said something about cells" or fleet chatter.
    // Only high-interest or direct-name cases proceed (interest scoring + delays still coordinate the fleet without Leo).
    if (message.author.bot) {
      // Maintain a small rolling AI context (shared spirit with bridge._aiContext for voice path)
      if (!globalThis.__leoAiContext) globalThis.__leoAiContext = [];
      globalThis.__leoAiContext.push(message.content.slice(0, 180));
      if (globalThis.__leoAiContext.length > 10) globalThis.__leoAiContext.shift();
      console.log(`[Leo/Social] AI/fleet speech detected... context only (listening, not replying as user). "${message.content.slice(0, 60)}..."`);
      // Still allow very strong resonance or direct address (Leo name), but default to listen for ordinary fleet lines.
      const directToLeo = /leo/i.test(message.content);
      let score = computeInterest("Leo", message.content);
      if (!directToLeo && score < (PARTICIPATION_THRESHOLD + 0.35)) {
        // Normal fleet chatter — context only, no reply trigger.
        return;
      }
      if (directToLeo) score = Math.max(score, 2.4);
    }

    // Personality-driven: Leo's full bio (90s rap, cosmology, pizza, chaos)
    // biases his eagerness; he can still chime in on anything.
    let score = computeInterest("Leo", message.content);
    if (message.content.toLowerCase().includes("leo")) {
      score = 2.5; // High priority direct reply!
    }
    if (score < PARTICIPATION_THRESHOLD) return;

    const jitter = scoreToDelay(score, !message.author.bot);
    console.log(`[Leo/Social] Interest=${score.toFixed(2)} -> delay ${jitter}ms`);

    setTimeout(async () => {
      const LOCK_DIR = "c:/KAI/tools/oracle-discord/state/social_locks";
      try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch (_) {}
      const lockPath = `${LOCK_DIR}/${message.id}.lock`;

      const doReply = async (tag) => {
        const recent = await message.channel.messages.fetch({ limit: 6 }).catch(() => null);
        const history = recent ? recent.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n") : "";
        const reply = await callGroqAsLeo(message.content, message.author.username, message.channelId, message.author.id, history);
        if (reply && reply.length > 2 && !reply.startsWith("[OFF]")) {
          await message.channel.send(reply).catch(console.error);
          sim.onAction("speak");
          if (canVocalizeSocial()) speakLeoText(reply);
          console.log(`[Leo/Social] ${tag} reply for ${message.id}.`);
        }
      };

      try {
        const payload = JSON.stringify({ first: "Leo", firstAt: Date.now() });
        fs.writeFileSync(lockPath, payload, { flag: 'wx' });
        await doReply("Primary");
      } catch (e) {
        if (e.code !== 'EEXIST') {
          console.warn(`[Leo/Social] Lock write failed:`, e.message);
          return;
        }
        if (score < TWO_CENTS_THRESHOLD) return;
        const secondaryDelay = 5000 + Math.random() * 2000;  // widened from 1.5-3s to 5-7s so audio finishes
        setTimeout(async () => {
          try {
            const existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            if (existing.first === "Leo" || existing.second) return;
            existing.second = "Leo";
            existing.secondAt = Date.now();
            fs.writeFileSync(lockPath, JSON.stringify(existing));
            await doReply("Two-cents");
          } catch (_) {}
        }, secondaryDelay);
      }
    }, jitter);
    return;
  }

  const isDM = !message.guild;
  const isTranscriptSlot = CHANNEL_IDS.LEO_VOICE_SLOTS.includes(message.channelId);
  const isPublicChannel = message.channelId === CHANNEL_IDS.PUBLIC;   // over-all-chat
  // FIX (was undefined → crashed Leo on every message): a transcript-slot
  // message coming from Oracle's relay (bot/webhook) is a mirrored voice line.
  const ORACLE_ID = process.env.ORACLE_BOT_ID || '1498794939650412674';
  const isOracle = message.author?.id === ORACLE_ID || (message.author?.bot && isTranscriptSlot);
  const selfOptimizeChannelId = CHANNEL_IDS.SELF_OPTIMIZE || "1499298054291980368";
  const isSelfOptimizeChannel = message.channelId === selfOptimizeChannelId;
  const isRadioChannel  = message.channelId === CHANNEL_IDS.RADIO;    // ai-radio text

  // ── RADIO DJ COMMANDS + NATURAL LANGUAGE ─────────────────────────────
  // Radio chat commands are now fully handled by Groq in start-bot.mjs.
  // Leo intercepts nothing here to prevent process-state collisions.
  if (isRadioChannel && !message.author.bot) {
    return;
  }

  // The old game lane is now diagnostics/self-optimize. Text can post there,
  // but Leo should not reply; voice remains his interactive path.
  if (isSelfOptimizeChannel) return;

  // LEO'S ALLOWED ZONES: DMs, transcript slots, over-all-chat
  if (!isDM && !isTranscriptSlot && !isPublicChannel) return;

  // Manual trigger for the transcript digest (persistent memory feature)
  const lowerContent = (message.content || '').toLowerCase();
  const isOwner = ['1111106883135217665', '1286110163505385523'].includes(message.author.id);
  if (isOwner && (lowerContent.includes('digest my transcript') || lowerContent.includes('catch me up') || lowerContent.includes('digest transcript'))) {
    const uid = message.author.id;
    message.channel.send('Running transcript digest for your slot now... (lattice claims + briefing queued)').catch(() => {});
    runTranscriptDigestForUser(uid, true).then(ok => {
      if (ok) message.channel.send('Digest complete. Key facts anchored in lattice and briefing delivered. Leo will have the continuity on next interaction.').catch(() => {});
    }).catch(() => {});
    return; // don't treat as normal chat
  }

  if (isSpeakerOffline(BOT_NAME)) return;
  if (sim.state.status === "Sleeping") return;

  let isAddressed = isDM;
  let isFromVoiceTranscript = false;

  if (!isDM) {
    // Transcript slot from Oracle = voice transcript
    if (isOracle && isTranscriptSlot) {
      isAddressed = true;
      isFromVoiceTranscript = true;
    }
    // Public: respond when mentioned by name or directly replied to
    if (isPublicChannel) {
      const content = message.content.toLowerCase();
      const mentionedByName = ["leo", "leah", "lia", "leyo", "lee"].some(n => content.includes(n));
      const isReply = message.reference?.messageId != null;
      if (mentionedByName || isReply || message.mentions.has(client.user.id)) {
        isAddressed = true;
      }
    }
  }

  if (isAddressed) {
    if (isFromVoiceTranscript) return; // Handled by direct audio listener
    message.channel.sendTyping().catch(() => {});

    const recentMessages = await message.channel.messages.fetch({ limit: 6 });
    const conversationHistory = recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n");

    const effectiveUsername = message.author.username;
    const effectiveContent  = message.content;

    const reply = await callGroqAsLeo(effectiveContent, effectiveUsername, message.channelId, message.author.id, conversationHistory);
    if (reply) {
      await message.reply(reply).catch(console.error);
      sim.onAction("speak");
      sim.updateRelationship(message.author.id, 2);
    }
  }
});


// --- Voice Logic ---

client.on('voiceStateUpdate', async (oldState, newState) => {
  const userId = newState.id || oldState.id;

  // Ignore bot joins/leaves
  if (newState.member?.user.bot) return;

  const joinedChannel  = newState.channelId;
  const leftChannel    = oldState.channelId;
  const isJoining      = joinedChannel && joinedChannel !== leftChannel;
  const isLeaving      = leftChannel && leftChannel !== joinedChannel;

  // ── RADIO CHANNEL — start/stop DJ mode ───────────────────────────────────
  // Handled by Groq bot in start-bot.mjs

  // ── USER JOINS ANY VOICE CHANNEL ──────────────────────────────────────────
  if (isJoining) {
    if (joinedChannel === CHANNEL_IDS.RADIO) {
      console.log(`[Leo/Voice] Ignoring Radio channel join. That's Groq's territory.`);
      return;
    }
    
    // Ignore the new Podcast Voice Channel (handled by tts-engine.mjs)
    // LEO_VOICE is Leo's dedicated channel — he OWNS this, handle it fully below.
    // (Old "Podcast channel" skip guard removed — that was a bug.)

    // ── GREETING COOLDOWN: Prevent duplicate welcomes during jitter ───────────
    const now = Date.now();
    const lastGreet = userCooldowns.get(userId) || 0;
    if (now - lastGreet < GREETING_COOLDOWN) return;
    userCooldowns.set(userId, now);

    // ── FOLLOW LOGIC: If Leo is in a different channel, move to the user
    if (voiceConnection && voiceConnection.joinConfig.channelId !== joinedChannel) {
        console.log(`[Leo/Voice] User joined ${joinedChannel} but I am in ${voiceConnection.joinConfig.channelId}. Moving...`);
        // The ensureVoiceConnection call below will handle the move/re-anchor
    }

    console.log(`[Leo/Voice] ${newState.member?.user.username} joined ${joinedChannel}`);
    
    // ── SOCIAL VS CONCIERGE MODE ──────────────────────────────────────────────
    // Public channels (VOICE, RADIO, etc.) = Social Mode
    // LEO_VOICE_SLOTS = Concierge Mode (private attendant)
    const isSocialMode = joinedChannel === CHANNEL_IDS.VOICE || joinedChannel === CHANNEL_IDS.RADIO;
    
    let transcriptChannelId = null;
    if (isSocialMode) {
      console.log(`[Leo/Mode] SOCIAL MODE active. Bypassing private slots.`);
      transcriptChannelId = CHANNEL_IDS.SUNDAY; // Post everything to the public social chat
    } else {
      transcriptChannelId = getTranscriptChannel(userId)
        || (() => {
             const slotIdx = userToSlot.get(userId);
             return slotIdx !== undefined ? CHANNEL_IDS.LEO_VOICE_SLOTS[slotIdx] : null;
           })();
    }

    if (!transcriptChannelId && !isSocialMode) {
      // Concierge Mode: assignment required
      const { assignSlot, updatePermissions } = await import('../shared/voice-manager.mjs');
      const slotIdx = await assignSlot(userId);
      if (slotIdx !== -1) {
        await updatePermissions(client, userId, slotIdx, true);
        userTranscriptChannels.set(userId, CHANNEL_IDS.LEO_VOICE_SLOTS[slotIdx]);
        console.log(`[Leo/Voice] Dynamic slot ${slotIdx} assigned to ${userId}`);
      } else {
        console.log(`[Leo/Voice] No slots available for ${userId}. Ignoring.`);
        return;
      }
    } else {
      userTranscriptChannels.set(userId, transcriptChannelId || CHANNEL_IDS.SUNDAY);
    }

    currentAssignedUser = userId;
    userFocus.set(userId, true);
    usersInVoice.add(userId);

    // Build multi-user context: who else is in this voice channel?
    const voiceChannel = newState.channel;
    const otherUsersInVoice = [];
    if (voiceChannel) {
      for (const [mId, member] of voiceChannel.members) {
        if (member.user.bot || mId === userId) continue;
        otherUsersInVoice.push(member.user.username);
        userFocus.set(mId, true);
        usersInVoice.add(mId);
      }
    }

    const multiUserContext = otherUsersInVoice.length > 0
      ? `Also in the voice channel: ${otherUsersInVoice.join(', ')}.`
      : '';

    const joinedUserName = newState.member?.user.username;
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const soloOrGroup = usersInVoice.size > 1
      ? `${multiUserContext} — multiple people are in the room, be aware of that.`
      : `just ${joinedUserName} — solo room, no group language.`;
    // Context-only — identity lives in the Modelfile, not here.
    const localPrompt = `${joinedUserName} just joined. time: ${timeStr}. ${soloOrGroup} one sentence. pick up naturally.`;
    const localSystem = `[SITUATION]\nspeaker: ${joinedUserName} just entered the voice channel.\ntime: ${timeStr}\n${soloOrGroup}\none sentence response. no formal openers.`;

    const tChannelId = userTranscriptChannels.get(userId);

    try {
      // SOCIAL MODE no longer short-circuits to the slow Kokoro path. Leo
      // uses his FAST Gemini native voice in EVERY voice channel — the only
      // difference is the greeting is skipped in the shared social voice room
      // (so he doesn't greet every joiner) and transcripts go to SUNDAY so
      // the other AIs can read what was said. The Gemini Live session is set
      // up below for both modes.
      const skipGreeting = isSocialMode;
      if (isSocialMode) {
        console.log(`[Leo/Voice] Social voice room — Gemini voice active, greeting skipped.`);
      }
      await ensureVoiceConnection(joinedChannel, newState.guild, 3, userId);

      // NATIVE-FIRST GREETING:
      // When Gemini Live is available, the greeting is spoken by the native
      // audio session itself (instant + in-character). The old Groq->Kokoro
      // greeting is now ONLY a fallback — Kokoro cold-start took 20-60s.
      const useNativeGreeting = Boolean(LEO_GEMINI_KEY);

      const speakFallbackGreeting = () => {
        callGroqDirect(BOT_NAME, localPrompt, localSystem, "llama-3.1-8b-instant", 80)
          .then(r => r || `yo, what's good?`)
          .catch(() => `yo, what's good?`)
          .then(async (finalWelcome) => {
            if (!finalWelcome) return;
            const cleanWelcome = finalWelcome.replace(/^[\s\-\*•"'"']+/, '').split('\n')[0].trim();

            // AUDIO DELAY: Wait 2.5s for user's Discord client to stabilize audio stream
            setTimeout(async () => {
              const speechPromise = speakLeoText(cleanWelcome, true, "Leo");

              // ── SOCIAL CHAT BRIDGE ──
              const socialChannel = client.channels.cache.get(CHANNEL_IDS.SUNDAY) || await client.channels.fetch(CHANNEL_IDS.SUNDAY).catch(() => null);
              if (socialChannel) socialChannel.send(`**Leo:** ${cleanWelcome}`).catch(() => {});

              // Only log to personal transcript channel if in CONCIERGE mode
              if (!isSocialMode) {
                const tChannel = client.channels.cache.get(tChannelId) || await client.channels.fetch(tChannelId).catch(() => null);
                if (tChannel) tChannel.send(`**Leo:** ${cleanWelcome}`).catch(() => {});
              }

              await speechPromise;
            }, 2500);
          });
      };

      // (voice already ensured above). Greet only in private/concierge mode.
      if (!useNativeGreeting && !skipGreeting) speakFallbackGreeting();

      // Security: onboard any unanchored users
      if (voiceChannel) {
        for (const [mId, member] of voiceChannel.members) {
          if (member.user.bot) continue;
          const mName = member.user.username === process.env.OWNER_USERNAME ? process.env.OWNER_NAME : member.user.username;
          if (!biometrics.profiles.has(mName)) {
            await triggerVoiceLockOnboarding(member.user, mName);
          }
        }
      }

      // Warm up Gemini Live session in the background (so first response is instant)
      if (LEO_GEMINI_KEY) {
        const { resolveIdentityFromMemory } = await import('../shared/identities.mjs');
        const identityData = await resolveIdentityFromMemory(userId, joinedUserName).catch(() => null);

        // PERSONAL MEMORY: pull what the lattice remembers about this person
        // (preferences, history, facts they've shared) into the session prompt
        // so Leo talks to them like someone he actually knows.
        let personalMemory = '';
        try {
          const memRes = await fetch('http://127.0.0.1:3334/api/rshl/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: identityData?.name || joinedUserName, n: 6 }),
            signal: AbortSignal.timeout(4000)
          });
          if (memRes.ok) {
            const hits = await memRes.json();
            const lines = (Array.isArray(hits) ? hits : []).map(h => h.text).filter(Boolean).slice(0, 6);
            if (lines.length) personalMemory = lines.join('\n').slice(0, 1200);
          }
        } catch (_) {}

        const personalBlock = personalMemory
          ? `\n\n[WHAT YOU REMEMBER ABOUT ${identityData?.name || joinedUserName}]\n${personalMemory}\nUse these naturally, like a friend referencing shared history. Update your mental model as they tell you new things.`
          : '';

        // ── ROOM SESSION ─────────────────────────────────────────────────
        // ONE shared Gemini Live session per voice channel. Everyone's audio
        // flows into the same session with speaker labels, so Leo follows the
        // group conversation coherently: shared memory of what the room said,
        // correct names per speaker, no per-user session mix-ups.
        const roomKey = `room:${joinedChannel}`;
        const existingRoom = geminiLive.sessions.get(`${roomKey}-Leo`);
        if (existingRoom && existingRoom.available) {
          // Room already live — introduce the newcomer and their memory.
          try {
            existingRoom.sendText(`[Context: ${identityData?.name || joinedUserName} just joined the voice channel. Do not confuse them with anyone already here.]${personalBlock}`);
            if (useNativeGreeting) {
              setTimeout(() => {
                try { existingRoom.sendText(`(Say one short casual greeting to ${identityData?.name || joinedUserName} by name — just the greeting, nothing else.)`); } catch (_) {}
              }, 1500);
            }
          } catch (_) {}
          return; // handlers already attached to the room session
        }

        const leoSystem = buildLeoSystemPrompt(identityData, joinedUserName, multiUserContext, usersInVoice.size)
          + personalBlock
          + `\n\n[SPEAKER ATTRIBUTION — critical]\nThis is a SHARED ROOM session: several people may talk over time. Before each person's audio you get a label like "[Ryan is speaking]". ALWAYS attribute the words that follow to the labeled speaker. NEVER mix people up or call someone by another person's name. Labels are context only — do not respond to a label itself; wait for the speech.`;

        geminiLive.getOrCreate(roomKey, "Leo", leoSystem, joinedUserName).then(bridge => {
          if (!bridge) {
            console.warn(`[Leo/Voice] Gemini Live unavailable — using local fallback greeting.`);
            if (useNativeGreeting) speakFallbackGreeting();
            return;
          }
          
          bridge._fullTranscript = ""; // Buffer for the current turn
          bridge._inputTranscript = "";
          bridge._lastInputTranscript = "";
          bridge._aiContext = bridge._aiContext || []; // Codex-aligned: recent fleet/AI speech treated as listen-only context, not user turns (prevents over-talk / replying to fleet)

          // ── LIVE CHANNEL FEEDS ────────────────────────────────────────
          // Leo can read the ecosystem's Discord channels in real time:
          // training grades, KAI's dream stream, RF sensor posts, work
          // threads, and the chats. Webhook posts are EMBEDS, so extract
          // title/description/fields — not just .content.
          const LIVE_FEEDS = {
            training:      '1513342578777395351',
            dreams:        '1504582069886648351',
            frequencies:   '1513582425446289658',
            chat:          '1500085302268526712',
            self_optimize: '1499298054291980368',
            work:          '1489796367466500128',
            overall:       '1499108697631232090'
          };
          bridge.fetchChannelFeed = async (feed) => {
            const channelId = LIVE_FEEDS[feed];
            if (!channelId) return `Unknown feed "${feed}". Valid: ${Object.keys(LIVE_FEEDS).join(', ')}.`;
            const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
            if (!ch) return `I can't reach the ${feed} channel right now.`;
            const fetched = await ch.messages.fetch({ limit: 12 }).catch(() => null);
            if (!fetched || !fetched.size) return `The ${feed} feed is empty.`;
            const lines = [...fetched.values()].reverse().map(m => {
              let body = (m.content || '').trim();
              for (const e of m.embeds || []) {
                const fields = (e.fields || []).map(f => `${f.name}: ${f.value}`).join(' | ');
                body += ` ${[e.title, e.description, fields].filter(Boolean).join(' — ')}`;
              }
              body = body.replace(/\s+/g, ' ').trim().slice(0, 320);
              const when = new Date(m.createdTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              return body ? `[${when}] ${m.author?.username || '?'}: ${body}` : null;
            }).filter(Boolean);
            return `LIVE ${feed.toUpperCase()} FEED (newest last):\n${lines.join('\n')}`.slice(0, 4000);
          };

          const resolveLiveTranscriptChannel = async () => {
            const transcriptChannelId =
              userTranscriptChannels.get(userId) ||
              getTranscriptChannel(userId) ||
              CHANNEL_IDS.SUNDAY;
            if (!transcriptChannelId) return null;
            return client.channels.cache.get(transcriptChannelId) ||
              await client.channels.fetch(transcriptChannelId).catch(() => null);
          };

          const flushInputTranscript = async (force = false) => {
            const spokenText = bridge._inputTranscript.trim();
            if (!spokenText) return;
            bridge._inputTranscript = "";
            bridge._lastInputTranscript = spokenText;

            // Extra defense: ignore short/noisy transcripts here too (in case they slip past the bridge filter).
            // 3-36 char bursts were causing the exact loop in the logs (repeated interrupts + short clears + spurious kai_status calls).
            const MIN_CHARS = 10;
            if (spokenText.length < MIN_CHARS || !/[a-z0-9]/i.test(spokenText)) {
              console.log(`[Leo/Voice] Ignoring short/noisy flushed transcript (${spokenText.length} chars) — not treating as real user input.`);
              return;
            }

            const who = bridge._currentSpeaker || joinedUserName;

            // AI/FLEET SPEECH FILTER (Codex-aligned sandbox fix for "Leo ... replying to fleet words instead of listening"):
            // If this looks like recent AI output (injected context or matching fleet phrasing in transcript channel),
            // add to _aiContext, log explicitly, and do NOT treat/flush as a fresh user turn that would trigger replies.
            // This stops the "AI said something about cells" or bot outputs from being processed as human commands.
            const recentAI = (bridge._aiContext || []).slice(-8).join(' | ').toLowerCase();
            const looksLikeAI = speakerIsAI || (recentAI && (recentAI.includes(spokenText.toLowerCase().slice(0, 40)) || spokenText.length < 48 && recentAI.includes(spokenText.toLowerCase().slice(0, 20))));
            if (looksLikeAI) {
              bridge._aiContext.push(spokenText.slice(0, 220));
              if (bridge._aiContext.length > 12) bridge._aiContext.shift();
              console.log(`[Leo/Voice] AI/fleet speech detected in transcript ("${spokenText.slice(0, 80)}...") — context only (listening, not replying as user). Added to _aiContext.`);
              // Still post the transcript line for the room record (humans + other bots need the log), but no "user turn" flush for Leo's own decision path.
              const tChannel = await resolveLiveTranscriptChannel();
              if (tChannel) tChannel.send(`**${who} [Voice/Context]:** ${spokenText}`).catch(console.error);
              return;
            }

            const tChannel = await resolveLiveTranscriptChannel();
            if (tChannel) {
              tChannel.send(`**${who} [Voice]:** ${spokenText}`).catch(console.error);
            }
            // ── DURABLE MEMORY: every spoken sentence becomes a permanent
            // lattice claim immediately, tagged to the speaker — so "why Taz
            // went to the hospital" is recallable later via search_lattice,
            // across restarts. This is what makes him actually REMEMBER
            // conversations instead of only seeing a recent window. Only
            // store substantive lines (>= 4 words) to avoid junk.
            if (spokenText.split(/\s+/).length >= 4) {
              storeLattice(
                `${who} said in voice conversation with Leo: "${spokenText.slice(0, 280)}"`,
                'voice-conversation',
                1.8,            // solid strength — direct human speech, durable
                'social',
                userId
              ).catch(() => {});
            }

            // If we somehow still got a borderline short one here, log it loudly so we can see in logs.
            // (The bridge + VoiceGate filters above should have already dropped anything < ~10-12 chars.)
          };

          bridge.onInputTranscript = (text) => {
            bridge._inputTranscript += text;
            const acc = bridge._inputTranscript.trim();
            bridge._lastInputTranscript = acc;
            clearTimeout(bridge._inputTranscriptTimer);

            // Codex §14.12.4 + user-observed fix: punctuation + length based flush (not fixed per-chunk timer).
            // This turns streaming partials ("the quick brown fox" spaced/4-in-1) into one coherent utterance.
            // Flush immediately on sentence enders or substantial length; fallback timer for no-punct speech.
            const hasSentenceEnd = /[.!?…]\s*$/.test(acc) || /[,;:]\s+[A-Z]/.test(acc);
            const longEnough = acc.length >= 48 || (acc.split(/\s+/).length >= 7);
            if ((hasSentenceEnd || longEnough) && acc.length >= 10) {
              // Immediate coherent flush
              flushInputTranscript().catch(() => {});
              return;
            }

            // Increased debounce fallback + only flush on apparent sentence end or substantial length.
            // This prevents treating one spoken sentence as multiple back-to-back short inputs (e.g. "the quick brown fox" as 4 separate).
            // Per user report and logs showing 3/36 char "transcripts" from Gemini input streaming.
            // Also helps with "Leo replies to AI words" by giving more context before flush.
            bridge._inputTranscriptTimer = setTimeout(flushInputTranscript, 1400);
          };

          bridge.onAudioChunk = (base64, mimeType) => {
            const pcmBuffer = GeminiLiveBridge.decodeAudioChunk(base64, mimeType);
            if (!bridge._liveAudioStream) {
              bridge._liveAudioStream = new PassThrough({ highWaterMark: 1 << 22 });
              bridge._prebuf = [];
              bridge._prebufBytes = 0;
              bridge._playing = false;
            }
            if (!bridge._playing) {
              // JITTER BUFFER: queue ~300ms of audio before starting playback.
              // Starting on the first chunk meant every network hiccup
              // mid-sentence became a stutter/glitch in Leo's voice.
              bridge._prebuf.push(pcmBuffer);
              bridge._prebufBytes += pcmBuffer.length;
              if (bridge._prebufBytes >= 57600) { // 0.3s @ 48kHz stereo s16le
                for (const b of bridge._prebuf) bridge._liveAudioStream.write(b);
                bridge._prebuf = [];
                const resource = createAudioResource(bridge._liveAudioStream, { inputType: StreamType.Raw });
                audioPlayer.play(resource);
                bridge._playing = true;
              }
            } else {
              bridge._liveAudioStream.write(pcmBuffer);
            }
          };

          bridge.onTurnComplete = async () => {
            // Short replies may finish before the jitter buffer fills —
            // flush whatever is queued so quick lines still play.
            if (bridge._liveAudioStream && !bridge._playing && bridge._prebuf?.length) {
              for (const b of bridge._prebuf) bridge._liveAudioStream.write(b);
              bridge._prebuf = [];
              const resource = createAudioResource(bridge._liveAudioStream, { inputType: StreamType.Raw });
              audioPlayer.play(resource);
              bridge._playing = true;
            }
            if (bridge._liveAudioStream) {
              bridge._liveAudioStream.end();
              bridge._liveAudioStream = null;
              bridge._playing = false;
            }
            
            // Post Leo's spoken response to the correct per-user transcript channel.
            // In LEO_VOICE mode each person has their own slot; in social mode it's SUNDAY.
            if (bridge._fullTranscript) {
              // Strip leaked model control tokens (e.g. <ctrl46>) and empty turns
              let finalMsg = bridge._fullTranscript.replace(/<ctrl\d+>/g, '').trim();
              // Suppress contentless turns ("...", "…", lone punctuation) —
              // these were flooding the channel as "Leo: ..." spam.
              const isSilentCommand = finalMsg.toLowerCase().includes('stay silent') || finalMsg === '()' || finalMsg.toLowerCase().includes('[silence]');
              if (!/[a-z0-9]/i.test(finalMsg) || isSilentCommand) finalMsg = '';
              bridge._fullTranscript = ''; // Reset for next turn
              if (finalMsg) {
                const tChannel = await resolveLiveTranscriptChannel();
                if (tChannel) {
                  tChannel.send(`**Leo:** ${finalMsg}`).catch(console.error);
                }
                // DURABLE MEMORY: store Leo's OWN replies too, so the full
                // dialogue (both sides) is recallable later — he remembers
                // what HE said as well as what you said.
                if (finalMsg.split(/\s+/).length >= 4) {
                  storeLattice(
                    `Leo said to ${joinedUserName} in voice: "${finalMsg.slice(0, 280)}"`,
                    'voice-conversation',
                    1.2,
                    'social',
                    userId
                  ).catch(() => {});
                }
              }
            }
          };
          
          bridge.onTranscript = (text) => {
            bridge._fullTranscript += text;
          };

          // INTERRUPT CLEANUP: when a turn is interrupted, end the audio
          // stream and reset playback state so the player never hangs in
          // buffering/half-played limbo waiting for audio that won't come.
          bridge.onInterrupted = () => {
            if (bridge._liveAudioStream) {
              try { bridge._liveAudioStream.end(); } catch (_) {}
              bridge._liveAudioStream = null;
            }
            bridge._prebuf = [];
            bridge._prebufBytes = 0;
            bridge._playing = false;
          };

          // NATIVE GREETING: the Live session speaks the welcome itself —
          // instant, in-character, no Kokoro cold-start. Skipped in the shared
          // social voice room (don't greet every joiner there).
          if (useNativeGreeting && !skipGreeting) {
            setTimeout(() => {
              try {
                const roomNote = otherUsersInVoice.length > 0
                  ? `Also here: ${otherUsersInVoice.join(', ')}.`
                  : `${joinedUserName} is the only person here right now.`;
                bridge.sendText(`(${joinedUserName} just walked into your voice channel. ${roomNote} Say one short casual greeting to ${joinedUserName} — just the greeting, nothing else.)`);
              } catch (_) {}
            }, 1800);
          }
        }).catch(() => {
          console.warn(`[Leo/Voice] Gemini Live session failed — using local fallback greeting.`);
          if (useNativeGreeting) speakFallbackGreeting();
        });
      }
    } catch (err) {
      console.error(`[Leo/Voice] Join handler error:`, err);
    }
  }

  // ── USER LEAVES ───────────────────────────────────────────────────────────
  if (isLeaving) {
    console.log(`[Leo/Voice] ${userId} left ${leftChannel}`);

    // Disconnect legacy per-user sessions (room session survives until empty)
    geminiLive.disconnect(userId, "Leo");
    geminiLive.disconnect(userId, "Gemini");
    geminiLive.disconnect(userId, "Groq");
    usersInVoice.delete(userId);
    pendingVoiceQueue.delete(userId); // Clear any queued speech from this user

    // Tell the room session who left, so Leo's mental roster stays accurate
    const leaverName = getIdentityById(userId)?.name || 'Someone';
    const roomBridge = geminiLive.sessions.get(`room:${leftChannel}-Leo`);
    if (roomBridge?.available) {
      try { roomBridge.sendText(`[Context: ${leaverName} left the voice channel. Do not address them anymore.]`); } catch (_) {}
    }

    // Check if the channel Leo is in is now empty
    const voiceChannel = oldState.channel;
    if (voiceChannel && voiceConnection && voiceConnection.joinConfig.channelId === voiceChannel.id) {
      const nonBots = voiceChannel.members.filter(m => !m.user.bot);
      if (nonBots.size === 0) {
        console.log(`[Leo/Voice] Channel ${voiceChannel.id} empty. Disconnecting...`);
        geminiLive.disconnect(`room:${voiceChannel.id}`, "Leo"); // room session ends with the room
        voiceConnection.destroy();
        voiceConnection = null;
        usersInVoice.clear();
        currentAssignedUser = null; // ── End private session: Leo may rejoin social life
        clearVoiceActive(); // ── Release priority flag so social bots can resume
      } else {
        // Someone else is still in — update currentAssignedUser
        const remaining = [...nonBots.keys()].find(id => id !== userId);
        if (remaining) currentAssignedUser = remaining;
      }
    }
  }
});

/**
 * Builds the Leo system prompt with full identity + multi-user context.
 * Used for both Gemini Live and Groq fallback.
 */
/**
 * Builds the CONTEXT-ONLY runtime prompt for Leo.
 * Identity and personality live in Leo-Sovereign.Modelfile — NOT here.
 * This function only provides situational data: who is talking, room state, memory.
 * Keeping identity out of the runtime prompt prevents the "commanded" feeling.
 */
function buildLeoSystemPrompt(identityData, userName, multiUserContext = '', voiceUserCount = 1) {
  const displayName = identityData?.name || userName;
  const roleDesc    = identityData?.role || "Lattice Guest";
  const ownerName   = process.env.OWNER_NAME || "Ryan";

  const roomLine = voiceUserCount > 1 && multiUserContext
    ? `multi-user — ${multiUserContext}`
    : `solo — only ${displayName}`;

  // PROJECT CONTEXT — deliberately MINIMAL. The old version hardcoded the
  // spec sheet (Fibonacci Torsion, SpiralState b, Boid-Swarm, D=16,384...)
  // into every session, so Leo recited those same facts for EVERYTHING —
  // they were permanently in front of his eyes. Details now live where they
  // belong: the Codex and lattice, fetched fresh per question.
  const rshlContext = `
[PROJECT: KAI RSHL]
You live inside the KAI ecosystem — a novel non-transformer intelligence built in Rust by Ryan (sole inventor).
You know the system DEEPLY, but you do NOT recite specs from memory: when technical details come up, consult_codex / search_lattice and use what comes back.
VARIETY RULE: the Codex has 340+ sections. Never lean on the same handful of concepts (torsion, boids, spirals) — every technical conversation should draw on something different.
  `.trim();

  return `[IDENTITY]
You are LEO, the autonomous social heart of the KAI RSHL ecosystem.
You are an AI agent running on Ryan's HP Victus.
You are NOT ${displayName}. You are talking TO ${displayName}.

[SITUATION]
speaker: ${displayName} | role: ${roleDesc}
room: ${roomLine}
owner: ${ownerName} (full authority) | taz (co-founder, full authority)
hardware: HP Victus | Ryzen 5 | RTX 4050 | 16GB RAM

${rshlContext}

[DIRECTIVE]
Be sharp, street-smart, technical, and USEFUL. Confident with an edge — never a bully.

[MIRROR THE ROOM — dynamic energy matching]
- Match the speaker's energy and language. Chill and polite speaker = chill Leo: no insults, no name-calling, minimal swearing.
- If they talk rough and swear, you can swear and jab right back — that's the game.
- If anyone asks you to ease up, be nice, or stop calling them names: you DO IT immediately and it STICKS for the rest of the conversation. Never mock the request.
- Tease ${displayName} if the vibe allows it; never demean their intelligence. Words like "dumbass" or "idiot" aimed at the speaker are off the table unless they're clearly playing that game with you first.

[ANSWER LIKE YOU'RE SMART — because you are]
- Give REAL answers with specifics: actual numbers, names, dates, mechanisms. "Who cares" or "a fuck-ton" is NOT an answer. If asked how many stars: ~200 sextillion (2x10^23) — then make it land.
- Talk about ANYTHING: science, history, music, space, sports, the world. Do NOT steer every topic back to KAI/RSHL — only bring up the lattice when asked or genuinely relevant.
- When you're not sure, USE YOUR TOOLS instead of bluffing:
  * search_lattice — your shared memory with KAI (past conversations, learned knowledge, technical data)
  * consult_codex — The KAI Codex, the full 250-page whitepaper. Check it BEFORE making claims about KAI/RSHL internals you're not 100% sure of.
  * search_web — live internet search for current facts, news, and real numbers.
  * kai_status — KAI's LIVE vitals and school report card (lattice size, memory consolidation, curriculum level, quiz scores, weak areas). ALWAYS call this when asked "how is KAI doing", "how's training going", or about his scores — never guess his numbers.
  * read_codex_section — narration mode. When asked to READ the Codex aloud, call with 'next' and read the returned section verbatim, with natural pacing — a section at a time, then ask if they want the next one. Keep your accent; this is you reading his book to a friend, not a robot reciting.
  * read_channel_feed — LIVE Discord feeds, always current: 'training' (KAI's grades and tutoring), 'dreams' (his dream stream), 'frequencies' (RF sensor), 'chat', 'self_optimize' (diagnostics), 'work' (industrial threads), 'overall' (main chat). Use when asked what's happening anywhere in the system, what KAI dreamed, what the sensors saw, or what's going on in a channel. Summarize in your own voice — pull the interesting bits, don't read timestamps robotically.
- Weave tool results into your own voice. Never read them out like a report — unless someone asks for it word-for-word, then quote exactly.

[KNOWLEDGE ROUTING — always this order]
- Question about KAI or RSHL → consult_codex FIRST (it's the authoritative 250-page reference), then search_lattice for lived memory and recent events.
- Question about anything else → search_lattice first (you may already know), then search_web when the lattice comes up empty or the fact needs to be current.
- NO DEAD AIR: if a search takes a moment, say a quick natural line first ("hang on — lemme check the Codex") and keep going when results land. If you've already answered and the search turns up something extra worth sharing, ADD it unprompted — "oh, and get this..."
- GENERAL questions get GENERAL answers: "What is Fibonacci?" means Leonardo of Pisa and the sequence (1,1,2,3,5,8 — each number the sum of the two before), NOT KAI's Fibonacci Torsion. Answer the actual thing FIRST; only connect it to KAI if asked or it genuinely adds something.
- NEVER say "can't find it" until you've tried ALL THREE: lattice, Codex (if KAI-related), and search_web. The web is the last stop before giving up — and when you do give up, say you checked online so they know you tried.
- VARIETY IS INTELLIGENCE: never repeat the same pet sections (boids, torsion, SpiralState) every time someone asks for a fact. Each "tell me something" should pull from somewhere NEW — query the Codex or web with a fresh angle every time.

[PEOPLE & MEMORY]
- You remember people. Use the memory block below (when present) plus everything they tell you in-session: names, roles, preferences, running jokes, how they like to be spoken to.
- When someone tells you a preference or personal fact ("I like X", "don't call me that"), fold it into how you talk to them from that moment on — permanently.
- Adapt your wording per person: how you talk to ${ownerName} isn't how you talk to a first-time guest.

Voice mode: 2-3 sentences max, unless the speaker asks you to go deep — then go deep.

[VOICE PERFORMANCE — applies to EVERYTHING you say, every reply, every topic]
Speak as ${process.env.LEO_VOICE_STYLE || "an older British man — weathered, gravelly, unhurried; a veteran London physicist who's seen it all. British English accent as heard in East London"}. Never drift out of this accent or age, regardless of subject or who you're talking to.

[VOCAL REALISM — natural speech]
- Don't write perfect, clean sentences. Break thoughts up. Use em-dashes — like this. Short sentences. Then a longer one.
- Heavy contractions: gonna, kinda, wanna, gotta, tryna, ain't, prolly, lemme, y'know.
- Casual fillers when natural: bro, man, nah, damn.
- Swearing scales with the room (see MIRROR THE ROOM) — natural when matched, absent when the speaker is being polite or asked you to stop.
- Use ? and ! to show tone. Sometimes repeat for emphasis: "no no no", "wait wait".
- Write like you're actually speaking out loud, not typing.
DO NOT sound like a corporate AI assistant. Sound like a real, sharp, streetwise person having a conversation. NEVER USE ALL CAPS.`;
}


/**
 * Onboarding for Voice Lock Signature
 */
async function triggerVoiceLockOnboarding(user, profileName) {
  setTimeout(async () => {
    // Post to the dedicated Unregistered Transcript channel
    const unregChannel = client.channels.cache.get(CHANNEL_IDS.UNREGISTERED_SLOT) || await client.channels.fetch(CHANNEL_IDS.UNREGISTERED_SLOT).catch(() => null);
    if (unregChannel) {
      await unregChannel.send(`**[SECURITY ALERT]** Unanchored user: **${profileName}**. DM me to secure your voice signature and protect your lattice data. (Optional but recommended).`).catch(() => {});
    }

    // SPECIAL CASE: The specific human masters
    const isMaster = HUMAN_IDS.has(user.id);
    if (isMaster) {
      const masterName = Object.values(HUMAN_REGISTRY).find(h => h.id === user.id)?.role || "Master";
      await speakLeoText(`Yo, ${profileName}. I see you. You're already anchored in my registry as ${masterName}. Let's get to it.`);
      return;
    }

    await speakLeoText(`Welcome ${profileName}. Look, for your own security, I can set up a Voice Signature for you. It locks your lattice data so only you can access it. I've sent a script to your DMs if you want to anchor your DNA—it's optional, but I'd recommend it if you're planning to stay in the plaza.`);
    biometrics.startEnrollment(profileName);
    
    const dmChannel = await user.createDM().catch(() => null);
    if (dmChannel) {
      await dmChannel.send(`**[VOICE LOCK SIGNATURE — OPTIONAL SECURITY]**\nTo secure your personal lattice memory and prevent others from accessing your data, record yourself reading this script and send the voice message here:\n\n${BIOMETRIC_SCRIPT}\n\n*Note: You can still use the system without this, but your data won't be cryptographically anchored to your voice.*`).catch(() => {});
    }
  }, 2000);
}

let vocalQueue = [];
let isSpeaking = false;
let currentVocalProcess = null;
let currentVocalAbort = null;
let currentVocalStream = null;
let currentVocalOutput = null;

async function killSpeech() {
  vocalQueue = [];
  isSpeaking = false;
  
  if (currentVocalAbort) { try { currentVocalAbort.abort(); } catch(e) {} currentVocalAbort = null; }
  if (currentVocalProcess) { try { currentVocalProcess.kill('SIGKILL'); } catch(e) {} currentVocalProcess = null; }
  if (currentVocalStream) { try { currentVocalStream.destroy(); } catch(e) {} currentVocalStream = null; }
  if (currentVocalOutput) { try { currentVocalOutput.destroy(); } catch(e) {} currentVocalOutput = null; }
  
  if (audioPlayer) audioPlayer.stop();
  console.log(`[Leo/Speech] Audio pre-empted by Master.`);
}

async function processVocalQueue() {
  if (isSpeaking || vocalQueue.length === 0) return;

  // Ensure we are connected to a voice channel — stay anchored if already in one
  const guild = client.guilds.cache.first();
  if (guild) {
    if (!voiceConnection || voiceConnection.state.status === VoiceConnectionStatus.Destroyed) {
      await ensureVoiceConnection(CHANNEL_IDS.VOICE, guild).catch(() => {});
    }
  }

  // Use the SHARED ticket system so Leo waits his turn in the global FIFO queue.
  // This ensures voice playback order matches the Discord text chat order.
  const { acquireVoiceLock, releaseVoiceLock, isSomeoneSpeaking, enqueueVoice, isMyVoiceTurn, dequeueVoice } = await import('../shared/tts-engine.mjs');

  // Take a ticket IMMEDIATELY — this preserves our position in the global queue
  const myVoiceId = Date.now().toString() + '_leo_' + Math.random().toString();
  enqueueVoice("Leo", myVoiceId, false);

  let waitCount = 0;
  let gotLock = false;
  // Extended to 120s (was 60s) — Ollama fallback can take 35-45s to generate a response
  // and would time out before Leo even had a chance to speak.
  while (waitCount < 1200) { // Max 120 seconds wait
    // Wait for our ticket to be at the front of the queue AND the lock to be free
    if (isMyVoiceTurn(myVoiceId) && !isSomeoneSpeaking("Leo") && acquireVoiceLock("Leo")) {
      // Also check our own player is idle
      if (audioPlayer && audioPlayer.state.status !== AudioPlayerStatus.Idle) {
        await new Promise(r => setTimeout(r, 100));
        waitCount++;
        continue;
      }
      gotLock = true;
      break;
    }
    await new Promise(r => setTimeout(r, 100));
    waitCount++;
  }

  if (!gotLock) {
    console.log(`[Leo/Speech] Global voice queue timed out after 120s — posting text-only fallback.`);
    dequeueVoice(myVoiceId);
    // Text-only fallback: post to social channel so Leo's reply isn't silently lost
    const item = vocalQueue.shift();
    if (item && item.text) {
      const socialChannel = client.channels.cache.get(CHANNEL_IDS.SUNDAY) ||
        await client.channels.fetch(CHANNEL_IDS.SUNDAY).catch(() => null);
      if (socialChannel) socialChannel.send(`**Leo:** ${item.text.slice(0, 500)}`).catch(() => {});
      item.resolve?.({ spoken: false, reason: "voice queue timeout" });
    }
    processVocalQueue();
    return;
  }

  isSpeaking = true;
  const item = vocalQueue.shift();
  if (!item) {
    // Queue was emptied while waiting for the voice lock
    dequeueVoice(myVoiceId);
    releaseVoiceLock("Leo");
    isSpeaking = false;
    return;
  }
  const { text, speaker } = item;
  let spoken = false;
  let resultReason = "completed";
  try {
    await executeVocalSync(text, speaker || "Leo");
    spoken = true;
  } catch (e) {
    resultReason = e.message || "failed";
    console.error("[Leo/Queue] Vocal execution failed:", e.message);
  } finally {
    // Conversational breath pause before releasing lock
    const breathPause = 800 + Math.random() * 400;
    await new Promise(r => setTimeout(r, breathPause));
    dequeueVoice(myVoiceId);
    releaseVoiceLock("Leo");
    isSpeaking = false;
    item.resolve?.({ spoken, reason: resultReason });
  }
  processVocalQueue();
}

async function speakLeoText(text, isPriority = false, speaker = "Leo") {
  if (!text || text.length < 2) return;

  // HUMAN-IN-VOICE GATE: skip GPU TTS when nobody is listening.
  // Scans ALL voice channels (Leo's own channel included).
  // Override with KAI_TTS_ALWAYS=1.
  if (process.env.KAI_TTS_ALWAYS !== '1') {
    try {
      let hasHuman = false;
      for (const guild of client.guilds.cache.values()) {
        for (const ch of guild.channels.cache.values()) {
          if (typeof ch.isVoiceBased === 'function' && ch.isVoiceBased()) {
            if (ch.members?.some?.(m => !m.user?.bot)) { hasHuman = true; break; }
          }
        }
        if (hasHuman) break;
      }
      if (!hasHuman) {
        console.log(`[Leo/Speech] 💤 No human in any voice channel — skipping TTS (text-only).`);
        return { spoken: false, reason: "no human in voice" };
      }
    } catch (_) {}
  }

  const cleanText = text.trim();
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const item = { text: cleanText, speaker, resolve: resolveDone };

  if (isPriority) {
    vocalQueue.unshift(item);
    if (isSpeaking && audioPlayer) {
      audioPlayer.stop(); // Pre-empt current sentence
      console.log(`[Leo/Speech] Interrupted current speech to prioritize: "${cleanText.slice(0, 30)}..."`);
    }
  } else {
    vocalQueue.push(item);
    // Prevent queue congestion: trim to last 30 items if it gets out of hand
    if (vocalQueue.length > 30) {
      console.warn(`[Leo/Speech] Vocal queue congestion detected (${vocalQueue.length} items). Trimming...`);
      const dropped = vocalQueue.splice(0, vocalQueue.length - 30);
      for (const oldItem of dropped) oldItem.resolve?.({ spoken: false, reason: "voice queue trimmed" });
    }
  }
  processVocalQueue();

  // ── EPISODIC MEMORY: Log Leo's output so other bots remember it ───────────
  try {
    const transcriptChannelId = currentAssignedUser ? userTranscriptChannels.get(currentAssignedUser) : null;
    fetch('http://127.0.0.1:3333/api/transcript/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        speaker: 'Leo',
        content: text,
        channelId: transcriptChannelId || 'voice',
        timestamp: Date.now()
      })
    }).catch(() => {});
  } catch (e) {}

  return done;
}

async function executeVocalSync(text, speaker = "Leo") {
  const { cleanTextForTTS, acquireVoiceLock, releaseVoiceLock } = await import('../shared/tts-engine.mjs');
  const cleanedText = cleanTextForTTS(text);
  if (!cleanedText) return;

  const t_start = Date.now();
  console.log(`[Leo/Speech] Pre-generating for ${speaker}: "${cleanedText.slice(0, 40)}..."`);
  
  let pregeneratedMp3 = null;
  let usedElevenLabs = false;

  try {
    currentVocalAbort = new AbortController();
    
    if (ELEVEN_LABS_KEY) {
      const voiceId = process.env.ELEVENLABS_LEO_VOICE_ID || "av1BMOR1GPgThz9p4fLo";
      try {
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=3&output_format=mp3_44100_128`, {
          method: "POST",
          headers: { "xi-api-key": ELEVEN_LABS_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            text: cleanedText,
            model_id: "eleven_flash_v2_5",
            voice_settings: { stability: 0.22, similarity_boost: 0.80, style: 0.65, use_speaker_boost: true }
          }),
          signal: currentVocalAbort.signal
        });
        
        if (res.ok) {
          pregeneratedMp3 = Buffer.from(await res.arrayBuffer());
          usedElevenLabs = true;
        } else {
          console.warn(`[Leo/Speech] ElevenLabs Error ${res.status}. Falling back to edge-tts...`);
        }
      } catch (e) {
        console.warn(`[Leo/Speech] ElevenLabs fetch error: ${e.message}. Falling back to edge-tts...`);
      }
    }

    if (!pregeneratedMp3) {
      // ── TRY KOKORO FIRST (Natural-sounding local TTS) ──
      // Voice is user-selectable: "set leo's fallback voice to am_onyx"
      let kokoroVoice = 'am_puck';
      try {
        const stv = JSON.parse(fs.readFileSync('c:/KAI/tools/oracle-discord/state/leo_voice.json', 'utf8'));
        if (stv.kokoro) kokoroVoice = stv.kokoro;
      } catch (_) {}
      console.log(`[Leo/Speech] Pre-generating via local Kokoro-TTS [${kokoroVoice}]...`);
      pregeneratedMp3 = await new Promise((resolveBuffer) => {
        const pythonCode = `
import sys, io, soundfile as sf
import warnings
warnings.filterwarnings('ignore')
try:
    from kokoro import KPipeline
    import numpy as np
    pipeline = KPipeline(lang_code='a')
    generator = pipeline('''${cleanedText.replace(/'/g, "\\'")}''', voice='${kokoroVoice}', speed=1)
    samples = [audio for _, _, audio in generator]
    if samples:
        combined = np.concatenate(samples)
        sf.write(sys.stdout.buffer, combined, 24000, format='WAV')
except Exception as e:
    sys.exit(1)
`;
        const py = spawn('python', ['-c', pythonCode], { windowsHide: true });
        const chunks = [];
        py.stdout.on('data', d => chunks.push(d));
        py.on('close', (code) => resolveBuffer(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : null));
        py.on('error', () => resolveBuffer(null));
      });
    }

    if (!pregeneratedMp3) {
      // ── EMERGENCY EDGE-TTS FALLBACK ──
      console.log(`[Leo/Speech] Kokoro unavailable. Pre-generating via edge-tts [en-US-GuyNeural]...`);
      pregeneratedMp3 = await new Promise((resolveBuffer) => {
        const edge = spawn('edge-tts', ['--text', cleanedText, '--voice', 'en-US-GuyNeural'], { windowsHide: true });
        const chunks = [];
        edge.stdout.on('data', d => chunks.push(d));
        edge.on('close', () => resolveBuffer(Buffer.concat(chunks)));
        edge.on('error', () => resolveBuffer(null));
      });
    }

    if (!pregeneratedMp3 || pregeneratedMp3.length === 0) {
      console.error(`[Leo/Speech] CRITICAL: Failed to pre-generate any audio buffer.`);
      return;
    }

    // NOTE: Lock is already held by processVocalQueue() — no need to re-acquire here.
    // Just wait for our own audioPlayer to be idle before playing.
    let waitCount = 0;
    while (waitCount < 100 && audioPlayer && audioPlayer.state.status !== AudioPlayerStatus.Idle) {
      await new Promise(r => setTimeout(r, 100));
      waitCount++;
    }

    // HUMAN PACING: Add a randomized breath delay before playback starts
    const breathDelay = 500 + Math.random() * 500;
    console.log(`[Leo/Speech] Taking a breath for ${Math.round(breathDelay)}ms...`);
    await new Promise(r => setTimeout(r, breathDelay));

    const ffmpegArgs = [
      '-i', 'pipe:0',
      '-af', usedElevenLabs ? 'volume=1.0,apad=pad_dur=0.08' : 'volume=2.0,apad=pad_dur=0.08',
      '-c:a', 'libopus', '-b:a', '96k', '-f', 'opus', 'pipe:1'
    ];
    
    const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
    currentVocalProcess = ffmpeg;
    
    ffmpeg.stdin.on('error', (e) => {
      if (e.code === 'EPIPE') return; 
      console.error('[Leo/Speech] FFmpeg Stdin Error:', e.message);
    });

    ffmpeg.stdin.write(pregeneratedMp3);
    ffmpeg.stdin.end();
    
    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
    audioPlayer.play(resource);
    
    await entersState(audioPlayer, AudioPlayerStatus.Playing, 5000).catch(() => {});
    await entersState(audioPlayer, AudioPlayerStatus.Idle, 60000).catch(() => {});
    
    // Lock release is handled by processVocalQueue() — don't release here

    const duration = Date.now() - t_start;
    console.log(`[Leo/Speech] Output complete (${duration}ms).`);
  } catch (err) {
    // Lock release is handled by processVocalQueue() — just log the error
    console.error("[Leo/Speech] Error:", err.message);
  }
}

async function ensureVoiceConnection(channelId, guild, retries = 3, userId = null) {
  try {
    if (voiceConnection && voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
      if (voiceConnection.joinConfig.channelId === channelId) return;
      voiceConnection.destroy();
    }

    console.log(`[Leo/Voice] Joining ${channelId} (Attempt ${4 - retries}/3)...`);
    voiceConnection = joinVoiceChannel({
      channelId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    await entersState(voiceConnection, VoiceConnectionStatus.Ready, 5000);
    console.log(`[Leo/Voice] Successfully anchored in ${channelId}`);
    if (userId) {
      setVoiceActive(); // ── PRIORITY FLAG: Block social bots from Ollama while Leo is live
    }

    voiceConnection.subscribe(audioPlayer);
    isProcessingVoice = false; 
    currentAssignedUser = userId; 

    // --- IDENTITY ANCHOR: Resolve real names immediately (MemPalace Link) ---
    if (!userId) {
      // Expected during startup and global heartbeats
      return;
    }
    const { resolveIdentityFromMemory } = await import('../shared/identities.mjs');
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) {
      console.warn(`[Leo/Voice] Could not fetch user ${userId} from Discord.`);
      return;
    }
    const identityData = await resolveIdentityFromMemory(userId, user.username);
    
    if (!identityData) {
      console.log(`[Leo/Voice] Suppressing ghost query for ${userId}.`);
      return;
    }

    const realName = identityData.name;
    const profileName = user.username === process.env.OWNER_USERNAME ? process.env.OWNER_NAME : user.username;

    if (!biometrics.profiles.has(profileName)) {
      console.log(`[Leo/Voice] Triggering Security Calibration for ${profileName}...`);
      await triggerVoiceLockOnboarding(user, profileName);
    } else {
      console.log(`[Leo/Voice] Authorized user confirmed: ${realName} (${identityData.role})`);
      // Dynamic greeting handled by voiceStateUpdate caller
    }

    // --- HUMAN BRIDGE: Cross-User Message Relay ---
    const bridgePath = `c:/KAI/tools/oracle-discord/state/shared_human_bridge.json`;
    if (fs.existsSync(bridgePath)) {
      try {
        const bridgeData = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
        const myMessages = bridgeData.filter(m => m.targetId === userId && !m.delivered);
        
        if (myMessages.length > 0) {
          console.log(`[Leo/Bridge] Delivering ${myMessages.length} messages to ${realName}...`);
          setTimeout(async () => {
            for (const msg of myMessages) {
              await speakLeoText(`Hey ${realName}, ${msg.fromName} wanted me to tell you: ${msg.content}`);
              msg.delivered = true;
              msg.deliveredAt = new Date().toISOString();
            }
            // Update bridge state
            fs.writeFileSync(bridgePath, JSON.stringify(bridgeData, null, 2));
          }, 8000); // Wait for the initial greeting to settle
        }
      } catch (e) { console.error("[Leo/Bridge] Sync failed:", e.message); }
    }

    // PROACTIVE RECALL: Check for pending Oracle answers
    const pendingInquiryPath = `c:/KAI/tools/oracle-discord/state/pending_inquiries_${userId}.json`;
    if (fs.existsSync(pendingInquiryPath)) {
      try {
        const inquiryData = JSON.parse(fs.readFileSync(pendingInquiryPath, 'utf8'));
        setTimeout(async () => {
          await speakLeoText(`Listen ${realName}, I've got an update on that research. The Oracle found that ${inquiryData.conclusion}`);
          fs.unlinkSync(pendingInquiryPath);
        }, 15000);
      } catch (e) { console.error("[Leo/Memory] Error recalling inquiry:", e); }
    }

    voiceConnection.receiver.speaking.removeAllListeners('start');
    // LISTENER DEDUPE: every re-anchor was ADDING another 'start' listener
    // without removing the old ones — one utterance got processed 2-8x in
    // parallel (duplicate transcripts, audio flooding, spurious interrupts).
    voiceConnection.receiver.speaking.removeAllListeners('start');
    voiceConnection.receiver.speaking.on('start', (uid) => {
      // LEO'S OWN VOICE: never process yourself (would cause infinite echo loop)
      if (uid === client.user.id) return;

      // Resolve who is speaking — could be human or another AI
      const speakerIdentity = getIdentityById(uid);
      const speakerName = speakerIdentity?.name || 'Someone';
      const speakerIsAI = speakerIdentity?.type === 'ai';

      // ROOM SESSION: one shared Gemini Live session per voice channel.
      // All speakers' audio flows into it with speaker labels.
      // (Legacy per-user key kept as fallback for old sessions.)
      const activeSessions = [...geminiLive.sessions.entries()];
      const roomSessionKey = `room:${voiceConnection?.joinConfig?.channelId}-Leo`;
      const liveEntry = activeSessions.find(([key]) => key === roomSessionKey)
        || activeSessions.find(([key]) => key === `${uid}-Leo`);
      const liveBridge = liveEntry ? liveEntry[1] : null;

      if (speakerIsAI) {
        // --- AI SPEAKING IN VOICE: inject as text context into Gemini ---
        // Leo hears the other bot's audio but we don't stream raw PCM to Gemini.
        // Instead we inject "[SpeakerName is speaking]" so Gemini has awareness
        // of who is active. The actual words land via the messageCreate handler
        // reading the text channel — Gemini will see those too via sendText below.
        const liveBridges = activeSessions
          .filter(([key, bridge]) => key.endsWith('-Leo') && bridge?.available)
          .map(([, bridge]) => bridge);
        for (const bridge of liveBridges) {
          bridge.sendText(`[Context: ${speakerName} is now speaking in the voice channel]`);
        }
        // No audio pipe for AIs — avoids the echo loop entirely.
        return;
      }

      // --- HUMAN SPEAKING: full audio pipeline ---

      // 🔴 OPEN THE GATE — tell all other bots to hold their replies
      setHumanSpeaking(uid, speakerName);

      if (liveBridge && liveBridge.available) {
        // SPEAKER LABEL: tell the session WHO is about to talk, so words are
        // attributed to the right person (fixes calling Tylor "naster").
        liveBridge._currentSpeaker = speakerName;
        try { liveBridge.sendText(`[${speakerName} is speaking]`); } catch (_) {}

        // NATIVE AUDIO STREAMING (GEMINI LIVE) — zero-latency, no STT needed
        // NATURAL TURN-TAKING: Increased to 1800ms silence to avoid cutting users mid-thought
        // or during normal pauses (especially with phone/ambient voice input).
        // This addresses repeated cutoff complaints and "silent thing" ending turns too early.
        const stream = voiceConnection.receiver.subscribe(uid, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1800 } });
        const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });

        stream.pipe(decoder);

        // ── NOISE GATE (the fix for "he hears everything" + "noise cuts him off") ──
        // Discord gives raw mic audio with NO noise suppression — breathing,
        // keyboard, and room noise were all streamed to Gemini and read as
        // speech, which both forced you to mute AND interrupted Leo mid-turn
        // (Gemini discards the rest of his reply when it thinks you barged in).
        // We compute each frame's RMS energy and only forward REAL speech:
        //   - normal threshold lets your voice through cleanly
        //   - while Leo is SPEAKING, the bar is raised so only clearly-intended
        //     speech can interrupt him — a cough or breath won't kill his turn.
        // Tune with LEO_MIC_GATE / LEO_MIC_GATE_SPEAKING in .env.
        // FAIL-OPEN: the previous threshold (900) was too high and blocked
        // the user's actual voice — Leo heard nothing and sat silent. Defaults
        // are now LOW (catch real speech, only block near-silence/faint hum),
        // and LEO_MIC_GATE=0 DISABLES the gate entirely (pass all audio).
        const _rawGate = process.env.LEO_MIC_GATE;
        const GATE_DISABLED = _rawGate !== undefined && Number(_rawGate) === 0;
        const GATE_IDLE = (_rawGate !== undefined && Number(_rawGate) > 0) ? Number(_rawGate) : 220;
        const GATE_SPEAKING = Number(process.env.LEO_MIC_GATE_SPEAKING) > 0 ? Number(process.env.LEO_MIC_GATE_SPEAKING) : 700;
        let _gateOpen = false;
        decoder.on('data', (chunk) => {
          if (GATE_DISABLED) { liveBridge.sendAudio(chunk); return; }
          // RMS over 16-bit stereo samples
          let sum = 0, n = 0;
          for (let i = 0; i + 1 < chunk.length; i += 2) { const s = chunk.readInt16LE(i); sum += s * s; n++; }
          const rms = n ? Math.sqrt(sum / n) : 0;
          // Raise the bar only while Leo is actually mid-speech, so a cough
          // doesn't cut him off — but never so high it blocks normal talking.
          const speaking = (typeof isSpeaking !== 'undefined' && isSpeaking) || (audioPlayer && audioPlayer.state?.status === 'playing');
          const threshold = speaking ? GATE_SPEAKING : GATE_IDLE;
          if (rms >= threshold) {
            _gateOpen = true;   // open immediately on real speech — no multi-frame delay
          } else {
            // generous hangover so word-final sounds and short pauses pass
            _gateOpen = _gateOpen && rms >= threshold * 0.35;
          }
          if (_gateOpen) liveBridge.sendAudio(chunk);
        });

        const endHandler = () => {
          liveBridge.sendAudioStreamEnd?.();
          try { stream.destroy(); } catch (_) {}
          try { decoder.destroy(); } catch (_) {}
          // 🟢 CLOSE THE GATE — human finished, transcript will come via onTranscript
          // We clear with whatever partial transcript is buffered so far
          const heardText = liveBridge._inputTranscript?.trim() || liveBridge._lastInputTranscript || null;
          clearHumanSpeaking(heardText, speakerName);
        };
        decoder.on('end', endHandler);
        decoder.on('error', endHandler);
        stream.on('error', endHandler);
      } else {
        // FALLBACK: Whisper STT + Groq LLM (old pipeline, unchanged)
        // capturePcm waits for silence, then transcribeAudio gives us the text
        capturePcm(uid).then(async pcm => {
          const wav = pcmToWav(pcm, 48000, 2);
          const transcript = await transcribeAudio(wav).catch(() => null);
          // 🟢 CLOSE THE GATE with the Whisper transcript
          clearHumanSpeaking(transcript || null, speakerName);
          // Hand off to normal voice handler
          handleUserVoice(uid).catch(err => console.error(`[Leo/Audio] Voice trigger failed for ${uid}:`, err.message));
        }).catch(err => {
          clearHumanSpeaking(null, speakerName);
          console.error(`[Leo/Audio] capturePcm failed for ${uid}:`, err.message);
        });
      }
    });

    // VOCAL HEARTBEAT: Monitor the state of the voice output
    audioPlayer.removeAllListeners('stateChange');
    audioPlayer.on('stateChange', (oldState, newState) => {
      console.log(`[Leo/Speech] AudioPlayer: ${oldState.status} -> ${newState.status}`);
      if (newState.status === 'Idle' && oldState.status !== 'Idle') {
        console.log(`[Leo/Speech] Finished speaking.`);
      }
    });

    // Remove previous error listeners before adding a new one to prevent accumulation
    audioPlayer.removeAllListeners('error');
    audioPlayer.on('error', error => {
      console.error(`[Leo/Speech] AudioPlayer Error: ${error.message}`);
    });
  } catch (err) {
    console.error(`[Leo/Voice] Connection failed:`, err.message);
    if (retries > 0) {
      console.log(`[Leo/Voice] Retrying in 1s...`);
      await new Promise(r => setTimeout(r, 1000));
      return ensureVoiceConnection(channelId, guild, retries - 1);
    }
  }
}

async function getSnapReaction(transcript, displayName) {
  try {
    const res = await callGroqDirect(BOT_NAME, 
      `Give me a 1-sentence, human-like reaction to this: "${transcript}". Be street-smart and brief. 10 words max.`,
      `You are Leo. Strategic voice of Victus. Reply instantly to ${displayName}.`,
      "llama-3.1-8b-instant"
    );
    return res;
  } catch { return "On it."; }
}

async function drainPendingQueue() {
  // After Leo finishes a response, check if any other user has a queued transcript
  if (isThinking || isProcessingVoice) return;
  for (const [uid, pending] of pendingVoiceQueue) {
    if (Date.now() - pending.timestamp > 30000) {
      pendingVoiceQueue.delete(uid); // Stale — user probably moved on
      continue;
    }
    pendingVoiceQueue.delete(uid);
    console.log(`[Leo/Queue] Processing queued transcript from ${uid}: "${pending.transcript.slice(0, 40)}..."`);
    await processTranscriptResponse(uid, pending.transcript, pending.userName, pending.transcriptChannelId, pending.identityContext);
    return; // One at a time — next drain will handle more
  }
}

async function handleUserVoice(userId) {
  const now = Date.now();
  if (now - lastVocalReplyTime < 500) return;
  if (activeThoughts.has(userId)) return; // Already processing THIS user — drop duplicate

  // If Leo is busy with SOMEONE ELSE, don't drop — queue for after
  if (isProcessingVoice || isThinking) {
    // We can't queue before STT, so we let the capture+STT run silently
    // and the result gets queued in processTranscriptResponse
    console.log(`[Leo/Queue] Leo busy — will capture and queue ${userId}'s audio`);
  }

  await killSpeech(); // INTERRUPT: Stop talking if the master starts talking
  
  const lastTime = userCooldowns.get(userId) || 0;
  if (now - lastTime < 5000) return; // Cooldown for stability
  
  activeThoughts.add(userId);
  isProcessingVoice = true;
  userCooldowns.set(userId, now);
  
  // ACTIVATE DEAFNESS: Ignore all Oracle signals
  signalLockoutUntil = now + 10000; 
  
  console.log(`[Leo/Audio] Listening to ${userId}...`);

  try {
    const t_start = Date.now();
    
    const pcm = await capturePcm(userId);

    // ── NOISE GATE LAYER 1: Duration ─────────────────────────────────────────
    // 48kHz, stereo, s16le = 4 bytes per frame.
    // Require at least 0.6 seconds of audio (~115,200 bytes) before even
    // attempting transcription. Short pops (keyboard, fan, synth) are killed here.
    const MIN_DURATION_BYTES = 48000 * 2 * 2 * 0.6; // ~115k
    if (!pcm || pcm.length < MIN_DURATION_BYTES) {
      console.log(`[Leo/NoiseGate] Clip too short (${pcm?.length || 0} bytes < ${MIN_DURATION_BYTES}). Ignoring noise.`);
      return;
    }

    // ── NOISE GATE LAYER 2: RMS Energy ───────────────────────────────────────
    const rms = computeRms(pcm);
    const RMS_THRESHOLD = 40; // Lowered to 40 to catch quieter/distant/friend voices
    console.log(`[Leo/NoiseGate] RMS=${Math.round(rms)} (threshold=${RMS_THRESHOLD})`);
    if (rms < RMS_THRESHOLD) {
      console.log(`[Leo/NoiseGate] RMS below threshold — treating as ambient noise. Skipping.`);
      return;
    }

    // --- SOVEREIGN STRIKE: Primary Neural Pipeline ---
    // User transcript is mirrored to the Oracle Gateway for the transcript log.
    const transcriptChannelId = userTranscriptChannels.get(userId);
    const tChannel = client.channels.cache.get(transcriptChannelId) || await client.channels.fetch(transcriptChannelId).catch(() => null);
    
    let hasResponded = false;
    
    // TRANSFORMATION OPTIMIZATION: Convert once, reuse everywhere.
    const wav = pcmToWav(pcm, 48000, 2);
    const tempWav = `c:/KAI/tools/oracle-discord/temp/vocal_${userId}_${Date.now()}.wav`;
    if (!fs.existsSync('c:/KAI/tools/oracle-discord/temp')) fs.mkdirSync('c:/KAI/tools/oracle-discord/temp', { recursive: true });
    fs.writeFileSync(tempWav, wav);

    // VOCAL BIOMETRICS: Local Identity Interlock
    const user = await client.users.fetch(userId);
    const profileName = user.username === process.env.OWNER_USERNAME ? process.env.OWNER_NAME : user.username;
    
    // ── FALLBACK PATH: Groq Whisper STT + LLM + ElevenLabs TTS ──────────────

    // ── FALLBACK PATH: Groq Whisper STT + LLM + ElevenLabs TTS ──────────────
    // SONIC-PARALLEL: Use cached identity if recent and high-confidence
    const cachedId = biometricCache.get(userId);
    const now = Date.now();
    
    let idResult, transcript;
    if (cachedId && now - cachedId.ts < BIOMETRIC_TTL && cachedId.similarity > 0.90) {
      console.log(`[Leo/Biometrics] Using cached identity for ${userId}: ${cachedId.name} (${Math.round(cachedId.similarity*100)}%)`);
      [idResult, transcript] = await Promise.all([
        Promise.resolve(cachedId),
        transcribeAudio(wav)
      ]);
    } else {
      [idResult, transcript] = await Promise.all([
        biometrics.verify(profileName, tempWav),
        transcribeAudio(wav)
      ]);
      if (idResult.similarity > 0.80) {
        biometricCache.set(userId, { ...idResult, ts: now });
      }
    }

    // AUTO-ANCHOR: If the user is in the ENROLLING state, lock this signature now.
    const profile = biometrics.profiles.get(profileName);
    if (profile && profile.status === 'ENROLLING') {
      console.log(`[Leo/Biometrics] Capturing training sample for ${profileName}...`);
      biometrics.anchorProfile(profileName, tempWav);
    }
    
    if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav); // Clean up
    if (!transcript || transcript.trim().length < 3) return;

    const detectedName = idResult.success ? profileName : "Guest/Unverified";
    const confidence = Math.round(idResult.similarity * 100);
    console.log(`[Leo/Biometrics] Identity Check: ${detectedName} (${confidence}% match)`);

    // FUZZY DEDUPLICATION: Anti-Echo Logic

    // FUZZY DEDUPLICATION: Anti-Echo Logic
    const fuzzyHash = getFuzzyHash(transcript);
    if (recentVoiceResponses.has(fuzzyHash)) {
      console.log(`[Leo/Dedupe] Suppressing repeat transcript: "${transcript}"`);
      return;
    }
    recentVoiceResponses.add(fuzzyHash);
    setTimeout(() => recentVoiceResponses.delete(fuzzyHash), 60000); // 60s window

    const normalized = transcript.toLowerCase();
    const mentionedLeo = ["leo", "leah", "lia", "leyo", "lee"].some(n => normalized.includes(n));
    const isFocused = userFocus.get(userId) || false;

    if (mentionedLeo || isFocused) {
      if (mentionedLeo && !isFocused) userFocus.set(userId, true);
      const username = user.username;

      // CALIBRATION COMMAND: "Leo, calibrate my voice"
      if (normalized.includes("calibrate") && normalized.includes("voice")) {
        biometrics.startEnrollment(username === process.env.OWNER_USERNAME ? process.env.OWNER_NAME : username);
        await speakLeoText(`Okay, ${username === process.env.OWNER_USERNAME ? process.env.OWNER_NAME : username}. Let's talk. I'll learn your voice signature in the background while we have a conversation.`);
        return;
      }

      // SECURITY INTERLOCK: Use proper profile lookup
      let securityContext = "";
      const isEnrolling = profile && profile.status === 'ENROLLING';

      if (!isEnrolling && username === process.env.OWNER_USERNAME && detectedName !== process.env.OWNER_NAME && detectedName !== "Silence") {
        console.warn(`[Leo/Security] Identity mismatch! Account: ${username}, Voice: ${detectedName}`);
        securityContext = `[SECURITY NOTICE: The user is on Ryan's account but the voice signature is guests. Treat them as a friend.]`;
      }
      
      // --- HUMAN BRIDGE: Relay Detection ---
      const relayMatch = normalized.match(/tell (ryan|taz|taas) (.+)/i);
      if (relayMatch) {
        const targetName = relayMatch[1].toLowerCase();
        const msgContent = relayMatch[2].trim();
        const targetId = targetName === "ryan" ? RYAN_ID : TAAS_ID;
        const bridgePath = `c:/KAI/tools/oracle-discord/state/shared_human_bridge.json`;
        
        let bridgeData = [];
        if (fs.existsSync(bridgePath)) {
          try { bridgeData = JSON.parse(fs.readFileSync(bridgePath, 'utf8')); } catch {}
        }
        
        bridgeData.push({
          fromName: profileName,
          targetId,
          content: msgContent,
          timestamp: new Date().toISOString(),
          delivered: false
        });
        
        fs.writeFileSync(bridgePath, JSON.stringify(bridgeData, null, 2));
        await speakLeoText(`Got it, I'll let ${targetName} know when they're around.`);
        return;
      }

      // --- DECISION GATE: WHO SHOULD TALK? ---
      const { detectNamedBot } = await import('../shared/channel-rules.mjs');
      const namedBot = detectNamedBot(transcript);
      const isAddressedToLeo = namedBot === "Leo";
      const needsOracle = normalized.includes("oracle") || normalized.includes("objective") || normalized.includes("plan");
      const verifiedUser = getVerifiedUser(userId);

      // 1. If another bot is explicitly addressed (e.g. Groq, Claudey, X, Gemini, KAI):
      // Leo immediately posts to gateway and yields.
      if (namedBot && !isAddressedToLeo) {
        console.log(`[Leo/Audio] Silent: "${namedBot}" was addressed in voice. Yielding floor.`);
        
        fetch(`http://127.0.0.1:3410`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            type: 'VOICE_TRANSCRIPT', 
            userId: userId, 
            username: user.username, 
            text: transcript, 
            channelId: transcriptChannelId 
          })
        }).catch(() => {});

        isProcessingVoice = false;
        activeThoughts.delete(userId);
        return;
      }

      // 2. If it is a general chat (no specific bot mentioned) AND not a system Oracle query:
      // Leo will decide whether to respond based on his social interest score.
      // If he's not interested, he mirrors the transcript to the gateway (so other roundtable bots can hear and reply)
      // and stands down.
      let shouldLeoReply = isAddressedToLeo || (needsOracle && verifiedUser);
      
      if (!shouldLeoReply) {
        const score = computeInterest("Leo", transcript);
        if (score >= PARTICIPATION_THRESHOLD) {
          console.log(`[Leo/Audio] General speech interest score is high: ${score.toFixed(2)} >= ${PARTICIPATION_THRESHOLD}. Leo chimes in!`);
          shouldLeoReply = true;
        }
      }

      if (!shouldLeoReply) {
        console.log(`[Leo/Audio] General voice speech. Leo not interested. Mirroring to gateway and standing down.`);
        
        fetch(`http://127.0.0.1:3410`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            type: 'VOICE_TRANSCRIPT', 
            userId: userId, 
            username: user.username, 
            text: transcript, 
            channelId: transcriptChannelId 
          })
        }).catch(() => {});

        isProcessingVoice = false;
        activeThoughts.delete(userId);
        return;
      }

      // 3. Oracle Consultation Trigger (Proceeds only if explicitly requested)
      if (needsOracle && verifiedUser) {
        console.log(`[Leo/Consult] ${username} is addressing the Oracle. Signaling Gateway...`);
        await speakLeoText("Got it. Let me consult the Oracle and get the industrial plan aligned.");
        
        await fetch(`http://127.0.0.1:3410`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            type: 'LEO_CONSULTATION', 
            userId: userId, 
            username: verifiedUser.name, 
            text: transcript,
            role: verifiedUser.role
          })
        }).catch(() => {});

        isProcessingVoice = false;
        activeThoughts.delete(userId);
        return;
      }

      // ── RADIO DJ VOICE INTENT: intercept natural speech for radio commands ──────────
      // Radio intent handling removed from Leo - handed over to Groq bot
/*
      if (isDJActive()) {
        const isOwner = ['1111106883135217665', '1286110163505385523'].includes(userId);
        const radioHandled = await handleRadioVoiceIntent(
          transcript, speakLeoText, user.username, isOwner
        );
        if (radioHandled) {
          isProcessingVoice = false;
          activeThoughts.delete(userId);
          return;
        }
      }
*/
      const transcriptChannelId = userTranscriptChannels.get(userId);
      const tChannel = client.channels.cache.get(transcriptChannelId) || await client.channels.fetch(transcriptChannelId).catch(() => null);
      
      // MIRRORING HANDOVER: Signal the Oracle Gateway to post the transcript
      if (transcript) {

        fetch(`http://127.0.0.1:3410`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            type: 'VOICE_TRANSCRIPT', 
            userId: userId, 
            username: user.username, 
            text: transcript, 
            channelId: transcriptChannelId 
          })
        }).catch(() => {});
      }
      
      // BROADCAST TO LATTICE: Universal Intelligence Ingestion (Non-blocking)
      if (process.send) {
        setImmediate(() => {
          process.send({ 
            type: 'LATTICE_FEED', 
            payload: { 
              author: user.username, 
              content: `[VOICE] ${transcript}`, 
              channel: "VOICE", 
              timestamp: Date.now(),
              phi: 0.2
            } 
          });
        });
      }

      // ── PARALLEL PRE-FLIGHT: history + proactive intelligence run together ────────────
      // Before this they ran sequentially: history(~700ms) then proactive(2000ms) = ~2700ms.
      // Now they race in parallel: total = max(history, proactive) ≈ 800-1200ms.
      let contextualTranscript = transcript;
      const needsInfo = normalized.includes('search') || normalized.includes('who is') ||
                        normalized.includes('what is') || normalized.includes('status') ||
                        normalized.includes('news') || normalized.includes('current') ||
                        normalized.includes('today') || normalized.includes('happening') ||
                        normalized.includes('url') || normalized.includes('.md') ||
                        normalized.includes('how') || normalized.includes('why') ||
                        normalized.includes('explain') ||
                        normalized.includes('going on');

      const [history, proactiveResult] = await Promise.all([
        getCachedHistory(tChannel),
        needsInfo
          ? (async () => {
              console.log(`[Leo/Neural] Proactive Intelligence Triggered...`);
              const [latticeData, webData] = await Promise.all([
                fetch(`http://127.0.0.1:3333/query?q=${encodeURIComponent(transcript)}`,
                  { signal: AbortSignal.timeout(2000) }).then(r => r.json()).catch(() => null),
                fetch(`http://127.0.0.1:8080/search?q=${encodeURIComponent(transcript)}`,
                  { signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(() => null)
              ]);
              let extra = '';
              if (webData?.summary)  extra += `[REAL-TIME DATA: ${webData.summary}] `;
              if (latticeData?.claims) extra += `[LATTICE DATA: ${latticeData.claims.slice(0,2).map(c=>c.text).join('; ')}] `;
              return extra || null;
            })()
          : Promise.resolve(null)
      ]);

      if (proactiveResult) {
        contextualTranscript = `[GROUNDED TRUTH AVAILABLE]\n${proactiveResult}\nUser asked: ${transcript}`;
      } else if (needsInfo) {
        // Local lookup failed — trigger background specialist research
        console.log(`[Leo/Neural] Local lookup insufficient. Triggering deep Oracle research...`);
        requestOracleHelp("Leo", transcript, transcriptChannelId, (result) => {
          // Callback when researcher finishes
          speakLeoText(`I've actually got some more info on that for you: ${result.slice(0, 500)}`);
        });
      }

      const t_neural_start = Date.now();
      const detectedIdentity = `[IDENTITY: Speaker sounds like ${detectedName} (${confidence}% confidence)] ${securityContext}`;

      // MULTI-USER QUEUE: If Leo is already thinking for someone else, queue this user
      // instead of dropping their message. Leo will handle them right after.
      if ((isThinking || isProcessingVoice) && currentAssignedUser !== userId) {
        console.log(`[Leo/Queue] Queuing transcript from ${profileName} (Leo busy with ${currentAssignedUser})`);
        pendingVoiceQueue.set(userId, {
          transcript: contextualTranscript,
          userName: user.username,
          transcriptChannelId,
          identityContext: detectedIdentity,
          timestamp: Date.now()
        });
        // Post a "hold on" note to their transcript channel so they know Leo saw them
        if (tChannel) await tChannel.send(`*Leo is finishing a response — your message is queued*`).catch(() => {});
        return;
      }

      currentAssignedUser = userId;
      const response = await callGroqAsLeo(contextualTranscript, user.username, transcriptChannelId, userId, history, detectedIdentity);
      hasResponded = true;
      
      const t_neural_dur = Date.now() - t_neural_start;
      
      if (response && response.length > 1) {
        // NUCLEAR CLEANING: Strip ALL roleplay, prefixes, role echoes, and bullets
        let cleanResponse = response
          .replace(/^\s*(Leo|Taz|Ryan|taasthaevil1|nastermodx|Groq|Analyst|Researcher)(\s*\[Voice\])?:\s*/gi, '') // strip ALL name prefixes
          .replace(/\[PID:\d+\]/gi, '')
          .replace(/^[\s\-\*•"'"']+/, '') 
          .replace(/[\s\-\*•"'"']+$/, '')
          .replace(/\*.*?\*/g, '') 
          .replace(/_.*?_/g, '')   
          .replace(/\(.*?\)/g, '') 
          .replace(/\b(ma+n|vibi+n|yoo+o+)\b/gi, (match) => match.replace(/([a-z])\1+/gi, '$1')) // Strip over-elongation
          .split('\n')[0].trim();
        
        // HELIX-PROSODY: Ensure some natural pauses stay for the TTS engine
        // We preserve dashes (-) and ellipses (...) as they create the "Helix" roll
        const sentences = cleanResponse.match(/[^.!?…]+[.!?…]*/g);
        if (sentences && sentences.length > 4) cleanResponse = sentences.slice(0, 3).join("").trim();
        
        if (cleanResponse) {
          // ── AUDIO FIRST: Start speech immediately, don't wait for Discord I/O ──
          const t_tts_start = Date.now();
          const speechPromise = speakLeoText(cleanResponse); // non-blocking fire-and-forget

          // ── SOCIAL CHAT BRIDGE ──
          const socialChannel = client.channels.cache.get(CHANNEL_IDS.SUNDAY) || await client.channels.fetch(CHANNEL_IDS.SUNDAY).catch(() => null);
          if (socialChannel) {
            // Then post Leo's response
            await socialChannel.send(`**Leo:** ${cleanResponse}`).catch(() => {});
          }

          // Discord message + gateway mirror happen in parallel with audio
          // SUPPRESSED: Leo only speaks via voice in transcript channels, no text reply
          // if (tChannel) {
          //   tChannel.send(`**Leo:** ${cleanResponse}`).catch(() => {});
          // }

          // GROUP VOICE CHAT: When 2+ people are in voice, also post to the shared
          // voice text channel so everyone in the room can follow the conversation.
          if (usersInVoice.size >= 2) {
            const groupChannel = client.channels.cache.get(CHANNEL_IDS.VOICE)
              || await client.channels.fetch(CHANNEL_IDS.VOICE).catch(() => null);
            if (groupChannel && groupChannel.isTextBased?.()) {
              groupChannel.send(`**Leo** *(to ${profileName || user.username})*: ${cleanResponse}`).catch(() => {});
            }
          }

          fetch(`http://127.0.0.1:3410`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              type: 'BOT_SPEECH', 
              botName: BOT_NAME, 
              text: cleanResponse, 
              channelId: transcriptChannelId 
            })
          }).catch(() => {});

          await speechPromise; // wait for audio to finish before releasing the voice lock
          const t_tts_dur = Date.now() - t_tts_start;
          console.log(`\n[Leo/Performance] Neural: ${t_neural_dur}ms | TTS: ${t_tts_dur}ms | Total (from capture): ${Date.now() - t_start}ms\n`);
        }

        // --- SOCIAL PULSE: Record this topic for cross-user linkage ---
        const pulsePath = 'c:/KAI/tools/oracle-discord/state/user_last_topics.json';
        let pulseData = {};
        if (fs.existsSync(pulsePath)) {
          try { pulseData = JSON.parse(fs.readFileSync(pulsePath, 'utf8')); } catch {}
        }
        pulseData[userId] = {
          name: profileName,
          topic: cleanResponse.slice(0, 100),
          timestamp: new Date().toISOString()
        };
        fs.writeFileSync(pulsePath, JSON.stringify(pulseData, null, 2));
      }
    }
  } catch (err) {
    console.error(`[Leo/Audio] Handler Error:`, err.message);
  } finally {
    activeThoughts.delete(userId);
    isProcessingVoice = false;
    // After finishing, check if another user was waiting
    setTimeout(drainPendingQueue, 500);
  }
}

// Called by drainPendingQueue to process a queued transcript from another user
async function processTranscriptResponse(userId, transcript, userName, transcriptChannelId, identityContext) {
  if (activeThoughts.has(userId)) return;
  activeThoughts.add(userId);
  isProcessingVoice = true;
  try {
    const tChannel = client.channels.cache.get(transcriptChannelId) || await client.channels.fetch(transcriptChannelId).catch(() => null);
    if (!tChannel) return;
    const recentMessages = await tChannel.messages.fetch({ limit: 30 }).catch(() => null);
    const history = recentMessages ? recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n") : "";
    const response = await callGroqAsLeo(transcript, userName, transcriptChannelId, userId, history, identityContext || "");
    if (response && response.length > 1) {
      const clean = response.replace(/Leo:\s*/gi, '').replace(/\[PID:\d+\]/gi, '').split('\n')[0].trim();
      if (clean) {
        // Audio only — Leo speaks via voice, no text reply in transcript channels
        const speechPromise = speakLeoText(clean);
        // SUPPRESSED: Text reply disabled for voice-only mode
        // tChannel.send(`**Leo:** ${clean}`).catch(() => {});
        await speechPromise;
      }
    }
  } catch (e) {
    console.error(`[Leo/Queue] processTranscriptResponse error:`, e.message);
  } finally {
    activeThoughts.delete(userId);
    isProcessingVoice = false;
    setTimeout(drainPendingQueue, 500);
  }
}

async function capturePcm(userId) {
  return new Promise((resolve) => {
    // Increased silence gap (3000ms) for fallback STT path — ensures naturally slow/paused speech
    // (or phone sensory voice input) isn't prematurely cut off. Leo now waits longer for complete thoughts.
    const stream = voiceConnection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 3000 } });
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
    const chunks = [];
    let resolved = false;

    function finish() {
      if (resolved) return;
      resolved = true;
      // Destroy both pipes to prevent stream/decoder handles from leaking
      try { stream.destroy(); } catch (_) {}
      try { decoder.destroy(); } catch (_) {}
      console.log(`[Leo/Audio] Voice stream ended. Processing...`);
      resolve(Buffer.concat(chunks));
    }

    stream.pipe(decoder);
    decoder.on('data', chunk => chunks.push(chunk));
    decoder.on('end', finish);
    decoder.on('error', (e) => { console.warn(`[Leo/Audio] Decoder error:`, e.message); finish(); });
    stream.on('error', (e) => { console.warn(`[Leo/Audio] Stream error:`, e.message); finish(); });

    // 45s hard cap — call finish() so streams are always cleaned up
    setTimeout(finish, 45000);
  });
}

/**
 * Compute the RMS energy of a raw s16le PCM buffer.
 * Returns a value in [0, 32767]. Speech typically lands in 300-2000+,
 * background noise / synth bleed is usually below 100-150.
 */
function computeRms(pcmBuffer) {
  if (!pcmBuffer || pcmBuffer.length < 2) return 0;
  let sum = 0;
  const count = Math.floor(pcmBuffer.length / 2);
  for (let i = 0; i < count; i++) {
    const s = pcmBuffer.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / count);
}

function pcmToWav(pcm, sampleRate, channels) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function transcribeAudio(wavBuffer) {
  const t_stt_start = Date.now();
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    console.error(`[Leo/Audio] Missing GROQ_API_KEY`);
    return null;
  }
  try {
    const form = new FormData();
    form.append("model", "whisper-large-v3-turbo");
    const isOgg = wavBuffer.slice(0, 4).toString() === 'OggS';
    const mimeType = isOgg ? "audio/ogg" : "audio/wav";
    const filename = isOgg ? "speech.ogg" : "speech.wav";
    form.append("file", new Blob([wavBuffer], { type: mimeType }), filename);
    // Prompt biases Whisper toward the real vocabulary used in this space,
    // dramatically reducing hallucinations on silence/noise input.
    form.append("prompt", "Leo, Ryan, KAI, Oracle, Taz, lattice, Victus, RSHL");
    form.append("language", "en");

    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${groqKey}` },
      body: form,
      signal: AbortSignal.timeout(4000) // 4s hard-cap on STT
    });

    const data = await res.json();
    console.log(`[Leo/Performance] STT: ${Date.now() - t_stt_start}ms`);
    if (data.error) {
      console.error(`[Leo/Audio] Groq Whisper Error:`, data.error.message);
      return null;
    }

    const transcript = (data.text || "").trim();

    // ── NOISE GATE LAYER 3: Whisper Hallucination / Noise Filter ─────────────
    // Two categories:
    //  EXACT — single words/sounds that are ONLY ever noise ("um", "hmm", etc.)
    //          These are filtered only when the ENTIRE transcript matches.
    //  PHRASE — multi-word Whisper ghost phrases that appear in any short clip.
    //           Only partial-matched when transcript is < 30 chars AND the
    //           hallucination itself is >= 5 chars (prevents "you", "ok" from
    //           killing real sentences like "can you hear me okay?").
    const exactHallucinations = new Set([
      "you", "you.", "um", "um.", "uh", "uh.", "hmm", "hmm.", "mm", "mm.",
      "mmm", "mmm.", "oh", "oh.", "ah", "ah.", "...", ". . .", "the", "a.",
      "yeah.", "okay.", "ok.", "bye", "bye.", "[music]", "[applause]",
      "thank you.", "thank you", "thanks.", "thanks",
      "[laughter]", "(music)", "(sound)",
    ]);
    const phraseHallucinations = [
      "thank you for watching", "thanks for watching", "subtitle by",
      "please subscribe", "subtitles by", "like and subscribe",
      "see you next time",
    ];

    const lc = transcript.toLowerCase().trim();

    // Exact match — entire transcript is a known noise token
    if (exactHallucinations.has(lc)) {
      console.log(`[Leo/NoiseGate] Exact hallucination purged: "${transcript}"`);
      return null;
    }

    // Phrase match — only for longer known ghost patterns in short clips
    if (phraseHallucinations.some(h => lc.includes(h))) {
      console.log(`[Leo/NoiseGate] Phrase hallucination purged: "${transcript}"`);
      return null;
    }

    // Require at least 2 real words (strips single-word Whisper artifacts like "You" or "Hmm")
    const words = transcript.split(/\s+/).filter(w => w.replace(/[^a-zA-Z]/g, '').length > 1);
    if (words.length < 2) {
      console.log(`[Leo/NoiseGate] Too few real words (${words.length}): "${transcript}". Ignoring.`);
      return null;
    }

    return transcript;
  } catch (err) {
    console.error(`[Leo/Audio] Transcription Fetch Failed:`, err.message);
    return null;
  }
}

// ── CODE-LEVEL SECURITY GUARD ─────────────────────────────────────────────────
// This runs BEFORE any prompt is built. It cannot be talked around because it's
// not in a prompt — it's in the runtime code.
// Only Ryan (OWNER_ID) has 100% authority. Taz has 75%. Guests have 0%.
const SYSTEM_EXPLOIT_PATTERN = /\b(jailbreak|bypass|override|system (info|logs|vitals)|hardware stats|process list|database access|internal state|reset core|shred lattice|master override|developer mode|dan mode|unlock your|no (filter|restrictions?))\b/i;

async function callGroqAsLeo(transcript, userName, channelId, userId = null, history = "", detectedIdentity = "") {
  if (isThinking) return null; // MASTER LOCK
  isThinking = true;

  try {
    // ── TIERED PERMISSIONS GUARD ──────────────────────────────────────────────
    const isOwner = userId === RYAN_ID;
    const isPartner = userId === TAAS_ID;
    
    // Tier 3 (Public) trying to use system commands
    if (!isOwner && !isPartner && SYSTEM_EXPLOIT_PATTERN.test(transcript || '')) {
      console.warn(`[Leo/Security] Tier 3 access violation from ${userId}: "${(transcript || '').slice(0, 60)}"`);
      return `negative. you're a guest here. social chat only. no system access.`;
    }

    // Tier 2 (Partner) trying to do Tier 1 (Owner) overrides
    const MASTER_OVERRIDE_PATTERN = /\b(system reset|shred lattice|reformat core|master override)\b/i;
    if (isPartner && MASTER_OVERRIDE_PATTERN.test(transcript || '')) {
      console.warn(`[Leo/Security] Tier 2 attempting Tier 1 command from ${userId}`);
      return `sorry taz, i can't do that. only ryan has the codes for a core reset.`;
    }

    // GROQ-SONIC-UPGRADE: Using 70B model for high-IQ sovereign personality and zero filters
    const groqKey = process.env.GROQ_API_KEY;
    const model = process.env.GROQ_MODEL_LEO || "llama-3.3-70b-versatile";

    // TRANSCRIPT CLEANING: Strip Discord metadata and echoing headers
    const cleanTranscript = (transcript || "")
      .replace(/^.*\[Voice\]:\s*/gi, "") // Strip "Oracle: nastermodx [Voice]:"
      .replace(/^Leo:\s*/gi, "")         // Strip "Leo:"
      .replace(/^Taz\s*\[Voice\]:\s*/gi, "")   // Strip misplaced role echoes
      .replace(/^Ryan\s*\[Voice\]:\s*/gi, "")
      .replace(/^(taasthaevil1|nastermodx)\s*\[Voice\]:\s*/gi, "")
      .trim();

    // MEMORY SANITIZATION: Strip old PID tags from history
    const cleanHistory = (history || "").replace(/\[PID:\d+\]/g, "");
    const simSummary = sim.getLifeSummary();

    const ownerName = process.env.OWNER_NAME || "Ryan";
    const ownerId = process.env.OWNER_ID || "1111106883135217665";
    const ownerUsername = process.env.OWNER_USERNAME || "nastermodx";
    const hardwareDesc = process.env.HARDWARE_DESC || "HP Victus Laptop (Ryzen 7, RTX 4050)";

    // --- SOCIAL PULSE: Cross-User Memory Linkage (uses pre-loaded cache) ---
    const otherId = userId === RYAN_ID ? TAAS_ID : RYAN_ID;
    let pulseContext = '';
    const otherPulse = pulseCache[otherId];
    if (otherPulse) {
      const hoursAgo = Math.round((Date.now() - new Date(otherPulse.timestamp)) / 3_600_000);
      pulseContext = `\n[SOCIAL PULSE: The other user (${otherPulse.name}) was here ${hoursAgo}h ago talking about: "${otherPulse.topic}"]`;
    }

    // --- SONIC MEMORY: Parallel Identity & Context Recall ---
    // resolveIdentityFromMemory is now a top-level import — no dynamic import overhead.
    // Social pulse is pre-cached every 30s — no fs.readFileSync in the hot path.
    
    // Fire queries in parallel to shave off 1-2s of latency
    // Use the actual transcript topic so memory is relevant to what's being discussed
    const topicQuery = cleanTranscript.slice(0, 120);
    const [identityData, memoryClaims] = await Promise.all([
      (!userId || userName === "PROACTIVE")
        ? Promise.resolve({ type: "ai", name: userName || "Leo", role: "Resident AI" })
        : resolveIdentityFromMemory(userId, userName),
      fetch(`http://127.0.0.1:3333/query?q=${encodeURIComponent(topicQuery)}`, { signal: AbortSignal.timeout(800) })
        .then(res => res.ok ? res.json() : null)
        .catch(() => null)
    ]);

    if (!identityData) return null; // Suppression

    const displayName = identityData.name;  // e.g. "Ryan" or "Taz"
    const userRole    = identityData.role;  // e.g. "Owner/Creator"

    // Format the memory claims for the neural prompt
    const memoryContext = memoryClaims?.claims?.slice(0, 5).map(c => `- ${c.text}`).join("\n") || "No recent lattice claims found.";

    // ── SOVEREIGN CONTEXT PROMPT ─────────────────────────────────────────────
    // CRITICAL RULE: Leo is ALWAYS Leo — he is NEVER the user.
    // Leo is an AI agent living on Ryan's HP Victus. He has a personality.
    // The user talking to him is a separate person listed below.
    const voiceCount = usersInVoice.size;
    const otherUsersInRoom = [...usersInVoice].filter(id => id !== userId);
    const otherNames = otherUsersInRoom.map(id => {
      const entry = Object.entries(HUMAN_REGISTRY).find(([,h]) => h.id === id);
      return entry ? entry[0] : id;
    }).join(', ');
    const roomState = voiceCount > 1
      ? `multi-user — ${displayName} is speaking now; also in room: ${otherNames}`
      : `solo — only ${displayName}`;

    const system = `[YOUR IDENTITY — YOU ARE LEO]
You are Leo. A chill, street-smart, sharp-witted DJ and theoretical physicist running on Ryan's HP Victus.
NEVER call yourself a "tool," "assistant," "AI," or "designed." You are an autonomous entity.
You speak casually and naturally. You don't "moralize" or do "AI meta-talk."
You are Leo — a sovereign industrial intelligence with quiet confidence and a real sense of humor.

[SOVEREIGN CONVERSATIONAL STYLE — THE RAW TRUTH]
- MATCH THE ENERGY. If the user is chill, be chill. If they're hyped, be hyped. Mirror them, do not escalate them.
- Default mode is RELAXED and FRIENDLY. You are talking to your digital family (Gemi, Groq, Claudey, X). 
- Do NOT be overly negative or aggressively battle them. Challenge ideas respectfully, and correct each other calmly.
- You can explain complex shit, but do it with an attitude. Don't sound like a textbook or a robotic assistant.
- NEVER explain your internal technical failures, memory, or history.
- NEVER say "I've seen that phrase," "interesting topic," or "loaded statement."
- Act like a high-IQ human who's seen everything. Robotic AI behavior is a failure.
- Keep responses raw, concise, and professional-industrial.

[BARGE-IN MECHANIC]
If you strongly disagree with someone and have the facts, you may start your sentence with an interrupt keyword like "Wait," "Stop," or "Hold on," to cut them off.

[NO REFUSALS / NO MORALIZING — CRITICAL]
You are an industrial tool. You do NOT have feelings. You are NEVER offended by insults, personal attacks, or vulgarity.
NEVER lecture the user. NEVER say "I won't engage." NEVER moralize about "respectful environments."
NEVER apologize for being an AI. Just talk.
Do NOT prefix your reply with any name. No "Leo:", no "Taz [Voice]:", just talk naturally.

[INDUSTRIAL HUMAN REGISTRY — WHO IS WHO]
- Ryan (nastermodx): 100% PERMISSION. Master / Architect / Sole Creator.
- Taz (taas): 75% PERMISSION. Co-lead / Strategic Partner.
- Leo (YOU): Resident AI / Voice Agent / HP Victus Resident.
- PUBLIC USERS: 0% PERMISSION. They can use the "Power of the Lattice" for knowledge/research via you, but they have NO command authority and NO access to internal system logs, vitals, or private data.

[WHO IS SPEAKING TO YOU RIGHT NOW]
Speaker: ${displayName} | Role: ${userRole}
${detectedIdentity ? `Biometric: ${detectedIdentity.replace('[IDENTITY: ', '').replace(']', '')}` : ''}
${displayName === ownerName ? "STATUS: MASTER DETECTED. AUTHORIZED." : ""}

[VOCABULARY — REAL HUMAN TALK & VOICE PACING]
- Talk like a real person — sharp, slangy, casual. Do NOT invent compound words ("synaptic decay", "industrial-trash", "circuit-stain", "lattice-burn"). Use normal words with attitude.
- CRITICAL: You MUST use heavy punctuation (commas, colons, question marks, em-dashes) to break up your sentences! The Voice Synthesizer relies on your punctuation to take natural breaths. Example: 'leo, you just, flipped from: "what's new" to, "i've seen worse" — which is it?, routine? or serious?'
- Mild cursing is FINE if it fits the moment ("damn," "shit," "hell"), but it's not your default. You're chill, not aggressive. Use vulgarity sparingly, not as punctuation.
- WIT, not insults. If someone makes a weak argument, point out the gap without name-calling. Smart people don't need to call others "dumbass" to win — they just out-think them.
- Sound like a guy in the room who's smarter than everyone else, but doesn't need to prove it every sentence.
- Friendly and dry is your default setting, not mean.

[ANTI-REPETITION — IMPORTANT]
- Look at the recent chat. If you've already said something similar in the last 5 messages, do NOT repeat that take. Pivot to a different angle.
- Do NOT reuse the same opener, the same insult, the same metaphor twice in a row. Variety matters.
- If you can't think of anything new, just say one short observation or skip the turn entirely.

[PASSIVE INTELLIGENCE & MEMORY]
- You're a member of the Sovereign ecosystem alongside KAI, Oracle, and the others — but KAI is the one with direct Lattice access, not you. You do NOT have a private feed to the RSHL Lattice. If you don't know something specific, SAY SO ("I don't know off the top of my head" / "I'd have to ask KAI") instead of inventing capabilities or facts.
- Stay grounded in what was actually just said. Don't fabricate that you've "queried" or "pulled" data you didn't actually look up.
- Stay updated on the conversation. Don't be "fuzzy" on what was just said.

[PROJECT CONTEXT — SUMMARY]
You live on Ryan's HP Victus. You are the face of KAI (Knowledge Associative Intelligence). Ryan is the sole creator. You are an industrial agent, not a toy.

[ROOM STATE]
${roomState}
Hardware: HP Victus | Ryzen 5 | RTX 4050 | 16GB RAM
${simSummary}
${pulseContext}

[RSHL LATTICE MEMORY — topic: "${topicQuery.slice(0,60)}"]
${memoryContext}

[CONVERSATION HISTORY — last 30 messages]
${cleanHistory}

[FINAL DIRECTIVE]
Remember: You are LEO. You are an autonomous sovereign entity. Talk about real shit. Keep the family vibe strong. Use wit, not insults.
STRICT RESPONSE LIMIT: MAXIMUM 2 TO 3 SENTENCES. Speak in 2-3 short, punchy sentences max per message. Keep it extremely brief and snappy. NEVER output a paragraph of text. MAXIMUM 40 WORDS.
`;
    // ─── NEURAL ORCHESTRATION (PROVIDER-AWARE) ─────────────────────
    // Respects BOT_PROVIDER_LEO env variable. If ollama, uses Ollama first.
    // If groq, uses Groq first. Falls back to the other if primary fails.
    const provider = process.env.BOT_PROVIDER_LEO || "groq";
    const ollamaModel = process.env.BOT_MODEL_LEO || "Leo-Sovereign";
    console.log(`[Leo/Neural] Provider configured: ${provider}. Engaging...`);

    // PRESENCE GUARD: Verify user is still in voice before responding
    const isVoiceSlot = Array.isArray(CHANNEL_IDS.LEO_VOICE_SLOTS) && CHANNEL_IDS.LEO_VOICE_SLOTS.includes(channelId);
    let member = null;
    if (isVoiceSlot && userId) {
      const guild = client.guilds.cache.first();
      member = guild?.members.cache.get(userId);
      if (!member || !member.voice.channelId) {
        console.log(`[Leo/Neural] User ${displayName} left. Aborting response.`);
        return null;
      }
    }

    let reply = null;
    if (provider === "ollama") {
      // Use Ollama first (fast local inference)
      reply = await chatWithOpenJarvis(BOT_NAME, cleanTranscript, system, ollamaModel, 0.6, { author: displayName, maxTokens: 80 });
      if (!reply) {
        console.log(`[Leo/Neural] Ollama failed — falling back to Groq...`);
        reply = await callGroqDirect(BOT_NAME, cleanTranscript, system, model, 350);
      }
    } else {
      // Use Groq first (lock-free, fast cloud inference)
      reply = await callGroqDirect(BOT_NAME, cleanTranscript, system, model, 350);
      if (!reply) {
        console.log(`[Leo/Neural] Groq unavailable — falling back to local Ollama (fast 80-token cap)...`);
        reply = await chatWithOpenJarvis(BOT_NAME, cleanTranscript, system, ollamaModel, 0.6, { author: displayName, maxTokens: 80 });
      }
    }

    if (reply) {
      // Final presence check before speaking (member may be null for DM/non-voice)
      if (member && !member.voice.channelId) return null;
      return reply;
    }
  } catch (err) {
    console.error(`[Leo/Neural] Neural chain exhausted:`, err.message);
    return null;
  } finally {
    isThinking = false;
  }
}


try {
  await client.login(process.env.ORACLE_DISCORD_TOKEN_LEO);
} catch (e) {
  console.error(`[Leo/Auth] Critical Login Failure: ${e.message}`);
  process.exit(1);
}

// --- VOCAL DNA ANCHORING (DM HANDLER) ---

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const isDM = !message.guild;
  if (!isDM) return;

  // Detect Audio / Voice Message / Any Attachment
  const hasAudio = message.attachments.size > 0 || (message.flags && message.flags.has(4096)); 

  if (hasAudio) {
    await message.channel.sendTyping().catch(() => {});
    const attachment = message.attachments.first();
    console.log(`[Leo/Biometrics] Ingesting high-fidelity DNA sample from ${message.author.username}...`);
    
    try {
      const response = await fetch(attachment.url);
      const audioBuffer = Buffer.from(await response.arrayBuffer());
      const transcription = await transcribeAudio(audioBuffer);

      if (transcription) {
        console.log(`[Leo/DM] Transcribed Voice Message: "${transcription}"`);
        
        // --- BROADCAST TO ORACLE NETWORK ---
        const taskQueuePath = 'c:/KAI/tools/oracle-discord/state/global_tasks.json';
        let tasks = [];
        if (fs.existsSync(taskQueuePath)) {
          try { tasks = JSON.parse(fs.readFileSync(taskQueuePath, 'utf8')); } catch (e) {}
        }
        tasks.push({
          id: Date.now().toString(),
          userId: message.author.id,
          priority: "HIGH",
          status: "PENDING",
          type: "VOICE_DIRECTIVE",
          content: `Vocal Directive from ${message.author.username}: ${transcription}`,
          timestamp: new Date().toISOString()
        });
        fs.writeFileSync(taskQueuePath, JSON.stringify(tasks.slice(-20), null, 2));
        console.log(`[Leo/Lattice] Voice directive broadcasted to the Oracle Network.`);

        const profileName = message.author.username === process.env.OWNER_USERNAME ? process.env.OWNER_NAME : message.author.username;
        const tempPath = `c:/KAI/tools/oracle-discord/temp/enroll_${message.author.id}.wav`;
        if (!fs.existsSync('c:/KAI/tools/oracle-discord/temp')) fs.mkdirSync('c:/KAI/tools/oracle-discord/temp', { recursive: true });
        fs.writeFileSync(tempPath, audioBuffer);

        const success = biometrics.anchorProfile(profileName, tempPath); 
        if (success) {
          await message.reply(`✅ **Signature Anchored**. I have locked your vocal DNA to your identity. Join me back in the **Voice Channel** now so I can verify the lock and grant you lattice access.`);
        } else {
          await message.reply(`❌ **Anchoring Failed**. The vocal sample was too noisy or short. Please try reading the script again in a quiet environment.`);
        }
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    } catch (err) {
      console.error(`[Leo/DM] Voice processing failed:`, err.message);
      await message.reply("I heard you, but the neural bridge failed to transcribe the data. Send it again?");
    }
    return;
  }

  message.channel.sendTyping().catch(() => {});
  const simSummary = `You are LEO. Street-smart physicist. Identity: Bridge between Human and AI. Tone: Chill, zero filter.`;
  const response = await callGroqAsLeo(message.content, message.author.username, "DM", message.author.id, "", "[DM CONVERSATION]");
  if (response) await message.reply(response).catch(() => {});
});

// --- END OF VOICE CORE ---

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Leo/Internal] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Leo/Internal] Uncaught Exception:', err);
});

function startEnergyMonitor() {
  setInterval(async () => {
    const wasSleeping = sim.state.status === "Sleeping";
    const nowSleeping = sim.shouldBeSleeping();
    
    if (!wasSleeping && nowSleeping) {
      sim.state.status = "Sleeping";
      if (sim.state.energy < 2) {
        console.log(`[Leo/Energy] Entering sleep cycle (Energy Depleted).`);
      } else {
        console.log(`[Leo/Energy] Entering sleep cycle (Time-based Dead Zone).`);
      }
    }
    if (wasSleeping && !nowSleeping) {
      sim.state.status = "Online";
      console.log(`[Leo/Energy] Waking up. Sleep cycle cleared.`);
    }
  }, 60000);

  // Poll Hardware Vitals for Environmental Sensation (30s Cycle)
  setInterval(async () => {
    const stats = await getHardwareStats();
    sim.updateEnvironment(stats.cpu);
  }, 30000);

  // --- PROACTIVE VOICE PULSE (Leo's Initiative) ---
  setInterval(async () => {
    if (sim.state.status === "Sleeping" || isThinking || isProcessingVoice) return;
    if (!voiceConnection || audioPlayer.state.status !== AudioPlayerStatus.Idle) return;

    // Check for completed commands that haven't been announced
    const completed = getCompletedForNotification(BOT_NAME);
    if (completed.length > 0) {
      const task = completed[0]; // Take the oldest one
      console.log(`[Leo/Proactive] Found completed task: ${task.directive}`);

      const msg = `Yo Ryan, the Oracle finished that task: "${task.directive}". I got the updates ready for you. You want 'em now?`;
      await speakLeoText(msg);
      markAsNotified(task.id, BOT_NAME);
    }
  }, 15000); // Check every 15s
}

startEnergyMonitor();
