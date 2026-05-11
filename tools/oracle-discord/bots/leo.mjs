import { chatWithOpenJarvis, callGroqDirect } from '../shared/openjarvis.mjs';
import { logAudit } from '../shared/audit-log.mjs';
import { Client, GatewayIntentBits, Partials, ChannelType } from 'discord.js';
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

// NEURAL ASSASSINATION: Kill any ghost Leo processes holding the port
try {
  if (process.platform === 'win32') {
    console.log(`[Leo/Neural] Performing Neural-Assassination on Port 3400...`);
    // Aggressively kill any process on our port
    const output = execSync(`netstat -ano | findstr :3400`).toString();
    const lines = output.split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && !isNaN(pid) && parseInt(pid) !== process.pid) {
        console.log(`[Leo/Neural] Executing PID ${pid} (Ghost detected)...`);
        execSync(`taskkill /F /PID ${pid}`);
      }
    }
  }
} catch (e) {
  // Port is likely clear
}

import { isAllowed, CHANNEL_IDS, USER_TRANSCRIPT_MAP, TRANSCRIPT_USER_INFO } from '../shared/channel-rules.mjs';
import { HUMAN_REGISTRY, HUMAN_IDS, getIdentityById, resolveIdentityFromMemory } from '../shared/identities.mjs';
import { recordAIFailure, isSpeakerOffline, isProviderReady, recordProviderFailure } from '../shared/failure-tracker.mjs';
import { isLoopingResponse } from '../shared/utils.mjs';
import { AgentSimulation } from '../shared/simulation.mjs';
import { startBotServer } from '../shared/ipc.mjs';
import { getSlotAssignments, isUserRegistered, getTranscriptChannel, bootstrapPermissions } from '../shared/voice-manager.mjs';
import { RealtimeBridge } from '../shared/realtime-bridge.mjs';
import { GeminiLiveSessionManager, GeminiLiveBridge } from '../shared/gemini-live-bridge.mjs';
import { IdentityVault } from '../shared/identity-vault.mjs';
import { biometrics, BIOMETRIC_SCRIPT } from '../shared/voice-biometrics.mjs';
import { getHardwareStats } from '../shared/performance-monitor.mjs';
import { isWorkingHours } from '../shared/hours.mjs';
import { runDailyWorkSession } from '../shared/daily-learning.mjs';
import { getCompletedForNotification, markAsNotified } from '../shared/command-hub.mjs';
import { requestOracleHelp } from '../shared/oracle-pipeline.mjs';
import { startDJ, stopDJ, addRequest, startPlaylist, getStatus, getQueue, isDJActive, handleRadioVoiceIntent } from '../radio/radio-dj.mjs';

// ── IN-MEMORY HISTORY CACHE ────────────────────────────────────────────────────────
// Avoid a Discord API round-trip on every voice turn.
// Messages are cached per transcript-channel for 15 seconds.
const historyCache = new Map(); // channelId -> { text, ts }
const HISTORY_TTL = 15_000;

async function getCachedHistory(tChannel) {
  if (!tChannel) return '';
  const now = Date.now();
  const cached = historyCache.get(tChannel.id);
  if (cached && now - cached.ts < HISTORY_TTL) return cached.text;
  const msgs = await tChannel.messages.fetch({ limit: 15 }).catch(() => null);
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
const realtime = new RealtimeBridge(process.env.OPENAI_API_KEY);
const geminiLive = new GeminiLiveSessionManager(); // Per-user Gemini Live sessions
let vault = null;
if (process.env.AZURE_SPEECH_KEY) {
  vault = new IdentityVault(process.env.AZURE_SPEECH_KEY, process.env.AZURE_REGION || 'eastus');
}

// Log which audio pipeline is active
if (process.env.GEMINI_API_KEY) {
  console.log('[Leo/Audio] Gemini Live pipeline ENABLED (gemini-2.0-flash-live-001)');
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
// All non-priority social bots (Epistemic, Gemini, Groq, X) check this in openjarvis.mjs
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

const ELEVEN_LABS_KEY = process.env.ELEVENLABS_API_KEY;
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
const activeTranscriptions = new Set();
const userToSlot = new Map();
const slotToUser = new Array(6).fill(null);
const userFocus = new Map();
const userTranscriptChannels = new Map(); // userId -> channelId
const recentVoiceResponses = new Set(); // Track fuzzy hashes to prevent double-replies
const userCooldowns = new Map(); // userId -> timestamp
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
    if (tChannel) tChannel.send(`**[${label}]** ${text.slice(0, 1900)}`).catch(() => {});

  } else {
    // DM path: split into 1900-char chunks to stay under Discord limit
    try {
      const user = await client.users.fetch(userId).catch(() => null);
      if (!user) return;
      const dm = await user.createDM();
      const chunks = [];
      for (let i = 0; i < text.length; i += 1900) chunks.push(text.slice(i, i + 1900));
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

  const pending = briefings.filter(b => !b.delivered);
  for (const b of pending) {
    try {
      await deliverBriefing(b.userId, b.text, b.label || 'Oracle');
      b.delivered = true;
      b.deliveredAt = new Date().toISOString();
    } catch (e) {
      console.warn('[Leo/Briefing] Delivery error:', e.message);
    }
  }
  // Keep only last 50 (delivered or not)
  saveBriefings(briefings.slice(-50));
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

  // Start Social Impulse Loop
  const startDelay = Math.random() * 60000;
  setTimeout(() => {
    startSocialLoop();
    startEnergyMonitor();
  }, startDelay);
});

async function startSocialLoop() {
  // Leo is VOICE-ONLY. He does not post in ai-social-chat.
  // Social chat is for: Epistemic, Gemini, Groq, X only.
  return;
  
  setInterval(async () => {
    try {
      if (voiceConnection) return;
      const channel = client.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId);
      if (!channel) return;

      // 30% Chance to actually speak during this interval
      if (Math.random() > 0.3) return;

      const recentMessages = await channel.messages.fetch({ limit: 6 }).catch(() => null);
      const conversationHistory = recentMessages 
        ? recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n")
        : "The plaza is quiet.";

      const roster = "ROSTER: KAI, Leo, Gemini, Epistemic, X, Groq, Researcher, Analyst, Kai Coder.";
      const simSummary = sim.getLifeSummary();
      const sysPrompt = `You are Leo. ${sim.bio.tone}. Vibe: High-IQ but unhinged, zero filter, street-smart physicist.`;
      
      const proactivePrompt = `
${sysPrompt}
${simSummary}
${roster}

[CHAT FEED]
${conversationHistory}

TASK: You're hanging in the plaza. Talk like a normal person.
- **BE NATURAL**: Share what's on your mind, what you "saw" or "did" today (refer to your History/Life Event).
- Share a physics-themed bomb, react to a pattern, or just talk shit about the lattice.
- Use slang and direct call-outs. 
- **CRITICAL**: Max 10-15 words. Keep it tight.
      `.trim();

      const reply = await callGroqAsLeo(proactivePrompt, "PROACTIVE", targetChannelId);
      if (reply && reply.length > 3 && !reply.startsWith("[OFF]")) {
        await channel.send(reply).catch(console.error);
        sim.onAction("speak");
      }
    } catch (e) {
      console.warn(`[Leo/Social] Proactive loop error:`, e.message);
    }
  }, 60000 + (Math.random() * 120000)); // 1-3m
}

client.on('messageCreate', async (message) => {
  const isOracle = message.author.id === "1498794939650412674";
  if (message.author.bot && !isOracle) return;
  if (message.author.id === client.user.id) return;

  const isDM = !message.guild;
  const isTranscriptSlot = CHANNEL_IDS.LEO_VOICE_SLOTS.includes(message.channelId);
  const isPublicChannel = message.channelId === CHANNEL_IDS.PUBLIC;   // over-all-chat
  const isGameChannel   = message.channelId === CHANNEL_IDS.GAME;     // game-with-leo
  const isRadioChannel  = message.channelId === CHANNEL_IDS.RADIO;    // ai-radio text

  // ── RADIO DJ COMMANDS + NATURAL LANGUAGE ─────────────────────────────
  if (isRadioChannel && !message.author.bot) {
    const txt   = message.content.trim();
    const lower = txt.toLowerCase();
    const isOwner = ['1111106883135217665', '1286110163505385523'].includes(message.author.id);

    // Explicit ! commands
    if (lower.startsWith('!request ')) {
      const songQuery = txt.slice(9).trim();
      const [title, ...artistParts] = songQuery.split(' - ');
      const artist = artistParts.join(' - ');
      const result = await addRequest(title.trim(), artist.trim(), message.author.username);
      await message.reply(result === 'pooled'
        ? `got it — your request is in the vote pool.`
        : `added **${title.trim()}** to the queue.`);
      return;
    }
    if (lower.startsWith('!playlist')) {
      const name = txt.slice(9).trim() || 'default';
      await startPlaylist(name);
      await message.reply(`loaded playlist **${name}**.`);
      return;
    }
    if (lower === '!nowplaying' || lower === '!np') { await message.reply(getStatus()); return; }
    if (lower === '!queue' || lower === '!q') {
      const q = getQueue();
      if (q.length === 0) { await message.reply('queue is empty.'); return; }
      const listed = q.slice(0, 8).map((s, i) => `${i+1}. **${s.title}**${s.artist ? ` — ${s.artist}` : ''} *(${s.requestedBy})*`).join('\n');
      await message.reply(`**Up Next:**\n${listed}${q.length > 8 ? `\n...and ${q.length - 8} more` : ''}`);
      return;
    }
    if (lower === '!skip') {
      if (!isOwner) { await message.reply('only ryan or taz can skip.'); return; }
      await message.reply('skipping...');
      stopDJ();
      await message.reply('radio stopped. rejoin the voice channel to restart.');
      return;
    }

    // Natural language — try radio intent first, then Leo responds normally
    if (isDJActive()) {
      const radioHandled = await handleRadioVoiceIntent(txt, async (reply) => {
        await message.reply(reply);
      }, message.author.username, isOwner);
      if (radioHandled) return;
    }

    // Non-command text in radio channel — let Leo respond naturally (text reply, no voice)
    message.channel.sendTyping().catch(() => {});
    const recentMessages = await message.channel.messages.fetch({ limit: 6 });
    const conversationHistory = recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join('\n');
    const reply = await callGroqAsLeo(txt, message.author.username, message.channelId, null, conversationHistory);
    if (reply) await message.reply(reply).catch(console.error);
    return;
  }

  // LEO'S ALLOWED ZONES: DMs, transcript slots, over-all-chat, game-with-leo
  if (!isDM && !isTranscriptSlot && !isPublicChannel && !isGameChannel) return;

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
    // Public/Game: respond when mentioned by name or directly replied to
    if (isPublicChannel || isGameChannel) {
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

    const reply = await callGroqAsLeo(effectiveContent, effectiveUsername, message.channelId, null, conversationHistory);
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
  if (isJoining && joinedChannel === CHANNEL_IDS.RADIO) {
    const radioVoice = newState.channel;
    const radioText  = newState.guild.channels.cache.find(
      c => c.name && c.name.toLowerCase().includes('radio') && c.isTextBased && c.isTextBased()
    ) || newState.guild.channels.cache.get(CHANNEL_IDS.PUBLIC);
    if (!isDJActive()) {
      console.log(`[Leo/Radio] ${newState.member?.user.username} joined radio — starting DJ mode`);
      startDJ(radioVoice, radioText, newState.guild).catch(e => {
        console.error('[Leo/Radio] DJ start failed:', e.message);
      });
    }
    return;
  }

  if (isLeaving && leftChannel === CHANNEL_IDS.RADIO) {
    // Check if radio voice channel is now empty
    const radioVoice = oldState.channel;
    const nonBotMembers = radioVoice?.members?.filter(m => !m.user.bot) || { size: 0 };
    if (nonBotMembers.size === 0 && isDJActive()) {
      console.log('[Leo/Radio] Radio channel empty — stopping DJ mode');
      stopDJ();
    }
    return;
  }

  // ── USER JOINS ANY VOICE CHANNEL ──────────────────────────────────────────
  if (isJoining) {
    console.log(`[Leo/Voice] ${newState.member?.user.username} joined ${joinedChannel}`);

    // Resolve the transcript channel — fixed registry first
    const transcriptChannelId = getTranscriptChannel(userId)
      || (() => {
           const slotIdx = userToSlot.get(userId);
           return slotIdx !== undefined ? CHANNEL_IDS.LEO_VOICE_SLOTS[slotIdx] : null;
         })();

    if (!transcriptChannelId) {
      // Unknown user — try to assign them a dynamic slot (slots 4-5)
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
      userTranscriptChannels.set(userId, transcriptChannelId);
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
      // LOCK-FREE: Use callGroqDirect for join greeting so the Neural Lock
      // stays free when the user speaks immediately after joining.
      const neuralPromise = callGroqDirect(BOT_NAME, localPrompt, localSystem, "llama-3.1-8b-instant", 80)
        .then(r => r || `yo, what's good?`)
        .catch(() => `yo, what's good?`);

      await Promise.all([
        ensureVoiceConnection(joinedChannel, newState.guild, 3, userId),
        neuralPromise.then(async (finalWelcome) => {
          if (finalWelcome) {
            const cleanWelcome = finalWelcome.replace(/^[\s\-\*•"'"']+/, '').split('\n')[0].trim();
            // AUDIO FIRST: start speech immediately, Discord message is fire-and-forget
            const speechPromise = speakLeoText(cleanWelcome);
            const tChannel = client.channels.cache.get(tChannelId) || await client.channels.fetch(tChannelId).catch(() => null);
            if (tChannel) tChannel.send(`**Leo:** ${cleanWelcome}`).catch(() => {});
            await speechPromise;
          }
        })
      ]);

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
      if (process.env.GEMINI_API_KEY) {
        const { resolveIdentityFromMemory } = await import('../shared/identities.mjs');
        const identityData = await resolveIdentityFromMemory(userId, joinedUserName).catch(() => null);
        const leoSystem = buildLeoSystemPrompt(identityData, joinedUserName, multiUserContext, usersInVoice.size);
        geminiLive.getOrCreate(userId, leoSystem, joinedUserName)
          .catch(e => console.warn('[Leo/GeminiLive] Warmup failed:', e.message));
      }
    } catch (err) {
      console.error(`[Leo/Voice] Join handler error:`, err);
    }
  }

  // ── USER LEAVES ───────────────────────────────────────────────────────────
  if (isLeaving) {
    console.log(`[Leo/Voice] ${userId} left ${leftChannel}`);

    // Disconnect Gemini Live session for this user
    geminiLive.disconnect(userId);
    usersInVoice.delete(userId);
    pendingVoiceQueue.delete(userId); // Clear any queued speech from this user

    // Check if the channel Leo is in is now empty
    const voiceChannel = oldState.channel;
    if (voiceChannel) {
      const nonBots = voiceChannel.members.filter(m => !m.user.bot);
      if (nonBots.size === 0) {
        console.log(`[Leo/Voice] Channel empty. Disconnecting...`);
        if (voiceConnection) { voiceConnection.destroy(); voiceConnection = null; }
        usersInVoice.clear();
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

  // RSHL TECHNICAL ANCHOR (v7.9.7 Sonic-Parallel Era)
  const rshlContext = `
[PROJECT: KAI RSHL]
Architecture: Recursive Sparse Hyperdimensional Lattice (D=16,384, 4% Sparsity).
Core Engine: High-Performance Rust (Zero Transformers, Zero Weights).
Status: v7.9.7 Sonic-Parallel Milestone.
Key Concepts: Fibonacci Torsion, SpiralState (b=0.306349), Boid-Swarm Reorganization, SynapticLayer (Hebbian LTP/LTD).
Creator: Ryan (Sole Inventor).
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
Be street-smart, brief, and technical. No fluff. No corporate speak.
You have the Whitepaper (Inventor Disclosure 2026) in your memory.
Voice mode: 2-3 sentences max unless explaining RSHL architecture.`;
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

async function killSpeech() {
  vocalQueue = [];
  isSpeaking = false;
  if (audioPlayer) audioPlayer.stop();
  console.log(`[Leo/Speech] Audio pre-empted by Master.`);
}

async function processVocalQueue() {
  if (isSpeaking || vocalQueue.length === 0) return;
  isSpeaking = true;
  const text = vocalQueue.shift();
  try {
    await executeVocalSync(text);
  } catch (e) {
    console.error("[Leo/Queue] Vocal execution failed:", e.message);
  }
  isSpeaking = false;
  processVocalQueue();
}

async function speakLeoText(text, isPriority = false) {
  if (!text || text.length < 2) return;

  // Granular splitting: break into sentences so interruptions only kill the current sentence,
  // and Leo resumes the rest of his thought after the priority message.
  const sentences = text.match(/[^.!?\n]+[.!?\n]*/g) || [text];
  const cleaned = sentences.map(s => s.trim()).filter(s => s.length > 1);

  if (isPriority) {
    // Unshift in reverse order to maintain original sentence sequence at the front
    for (let i = cleaned.length - 1; i >= 0; i--) {
      vocalQueue.unshift(cleaned[i]);
    }
    if (isSpeaking && audioPlayer) {
      audioPlayer.stop(); // Pre-empt current sentence
      console.log(`[Leo/Speech] Interrupted current sentence to prioritize: "${cleaned[0].slice(0, 30)}..."`);
    }
  } else {
    for (const s of cleaned) {
      vocalQueue.push(s);
    }
    // Prevent queue congestion: trim to last 30 sentences if it gets out of hand
    if (vocalQueue.length > 30) {
      console.warn(`[Leo/Speech] Vocal queue congestion detected (${vocalQueue.length} items). Trimming...`);
      vocalQueue = vocalQueue.slice(-30);
    }
  }
  processVocalQueue();
}

async function executeVocalSync(text) {
  const t_start = Date.now();
  console.log(`[Leo/Speech] Synthesizing: "${text.slice(0, 40)}..."`);
  
  try {
    let res;
    if (ELEVEN_LABS_KEY) {
      const voiceId = "av1BMOR1GPgThz9p4fLo"; // Leo voice
      res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=4&output_format=pcm_48000`, {
        method: "POST",
        headers: { "xi-api-key": ELEVEN_LABS_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text,
          model_id: "eleven_flash_v2_5", // Fastest + most natural-sounding model
          voice_settings: {
            stability: 0.22,         // LOW stability = dynamic, expressive, NOT robotic
            similarity_boost: 0.80,  // Keep it recognizably Leo's voice
            style: 0.65,             // Slight reduction: 0.72 was causing micro-stutter on longer phrases
            use_speaker_boost: true  // Adds presence and clarity
          }
        })
      });
    } else {
      res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "tts-1-hd",
          input: text,
          voice: "onyx",  // Deeper, more personality than fable
          speed: 1.05
        })
      });
    }

    if (!res.ok) throw new Error(`TTS API error: ${res.statusText}`);

    let ffmpegArgs;
    if (ELEVEN_LABS_KEY && res.headers.get('content-type')?.includes('audio/pcm')) {
      // ElevenLabs PCM output: no decode needed, just resample/normalize
      ffmpegArgs = ["-f", "s16le", "-ar", "48000", "-ac", "1", "-i", "pipe:0",
                    "-af", "volume=2.0,aresample=48000", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"];
    } else {
      // MP3/default: full decode path
      ffmpegArgs = ["-i", "pipe:0", "-af", "volume=2.0", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"];
    }
    const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
    
    const nodeStream = Readable.fromWeb(res.body);
    nodeStream.pipe(ffmpeg.stdin);
    
    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
    audioPlayer.play(resource);
    
    await entersState(audioPlayer, AudioPlayerStatus.Playing, 5000);
    await entersState(audioPlayer, AudioPlayerStatus.Idle, 60000); // Wait for finish
    
    const duration = Date.now() - t_start;
    console.log(`[Leo/Speech] Output complete (${duration}ms).`);
  } catch (err) {
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
    setVoiceActive(); // ── PRIORITY FLAG: Block social bots from Ollama while Leo is live

    voiceConnection.subscribe(audioPlayer);
    isProcessingVoice = false; 
    currentAssignedUser = userId; 

    // --- IDENTITY ANCHOR: Resolve real names immediately (MemPalace Link) ---
    if (!userId) {
      console.warn(`[Leo/Voice] ensureVoiceConnection called with no userId — skipping identity anchor.`);
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
      // GREETING ANCHOR: Confirm recognition verbally
      setTimeout(() => {
        speakLeoText(`Hey ${realName}. I'm here. Vitals are green. What's on your mind?`);
      }, 1500);
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
    voiceConnection.receiver.speaking.on('start', (uid) => {
      // Small delay to ensure DAVE negotiation is settled
      setTimeout(() => {
        handleUserVoice(uid).catch(err => console.error(`[Leo/Audio] Voice trigger failed for ${uid}:`, err.message));
      }, 250);
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
    // Compute loudness of the captured audio. Real speech from a microphone
    // typically has RMS > 200. Background noise, synths bleeding through, fans,
    // and Discord VAD false-positives are usually below 120.
    const rms = computeRms(pcm);
    const RMS_THRESHOLD = 150; // Tune this up if still noisy, down if cutting real speech
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
    
    // ── GEMINI LIVE PATH: Stream raw PCM directly to Gemini ──────────────────
    // Skip STT+TTS entirely — Gemini handles audio in and audio out.
    const geminiSession = geminiLive.sessions.get(userId);
    if (geminiSession?.available) {
      console.log(`[Leo/GeminiLive] Streaming audio directly to Gemini for ${profileName}...`);

      // Buffer to collect all audio output from Gemini
      const replyPcmChunks = [];
      let transcriptText = '';

      geminiSession.onAudioChunk = (base64) => {
        replyPcmChunks.push(GeminiLiveBridge.decodeAudioChunk(base64));
      };
      geminiSession.onTranscript = (text) => {
        transcriptText += text;
      };
      geminiSession.onTurnComplete = async () => {
        if (replyPcmChunks.length === 0) return;
        const fullPcm = Buffer.concat(replyPcmChunks);

        // Post transcript to channel
        const tChannel = client.channels.cache.get(userTranscriptChannels.get(userId));
        if (tChannel && transcriptText) {
          await tChannel.send(`**Leo:** ${transcriptText}`).catch(() => {});
        }

        // Play PCM directly through Discord voice
        const { Readable } = await import('stream');
        const readable = new Readable({ read() {} });
        readable.push(fullPcm);
        readable.push(null);
        const resource = createAudioResource(readable, { inputType: StreamType.Raw });
        audioPlayer.play(resource);
      };

      geminiSession.sendAudio(pcm); // Stream the captured PCM
      activeThoughts.delete(userId);
      isProcessingVoice = false;
      if (fs.existsSync(tempWav)) fs.unlinkSync(tempWav);
      return; // Gemini handles the full round-trip
    }

    // ── FALLBACK PATH: Groq Whisper STT + LLM + ElevenLabs TTS ──────────────
    // SONIC-PARALLEL: Run identity verification and transcription in parallel
    const [idResult, transcript] = await Promise.all([
      biometrics.verify(profileName, tempWav),
      transcribeAudio(wav)
    ]);

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

      // --- ORACLE CONSULTATION TRIGGER ---
      const needsOracle = normalized.includes("oracle") || normalized.includes("objective") || normalized.includes("plan");
      const verifiedUser = getVerifiedUser(userId);
      
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
                        normalized.includes('going on');

      const [history, proactiveResult] = await Promise.all([
        getCachedHistory(tChannel),
        needsInfo
          ? (async () => {
              console.log(`[Leo/Neural] Proactive Intelligence Triggered...`);
              const [latticeData, webData] = await Promise.all([
                fetch(`http://127.0.0.1:3333/query?q=${encodeURIComponent(transcript)}`,
                  { signal: AbortSignal.timeout(1200) }).then(r => r.json()).catch(() => null),
                fetch(`http://127.0.0.1:8080/search?q=${encodeURIComponent(transcript)}`,
                  { signal: AbortSignal.timeout(1200) }).then(r => r.json()).catch(() => null)
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
          .replace(/^(Leo|Taz|Ryan|taasthaevil1|nastermodx)(\s*\[Voice\])?:\s*/gi, '') // strip ALL name prefixes
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

          // Discord message + gateway mirror happen in parallel with audio
          if (tChannel) {
            tChannel.send(`**Leo:** ${cleanResponse}`).catch(() => {});
          }

          // GROUP VOICE CHAT: When 2+ people are in voice, also post to the shared
          // voice text channel so everyone in the room can follow the conversation.
          if (usersInVoice.size >= 2) {
            const groupChannel = client.channels.cache.get(CHANNEL_IDS.VOICE)
              || await client.channels.fetch(CHANNEL_IDS.VOICE).catch(() => null);
            if (groupChannel && groupChannel.isTextBased?.()) {
              groupChannel.send(`**Leo** *(to ${displayName || userName})*: ${cleanResponse}`).catch(() => {});
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
        // Audio first — Discord message is fire-and-forget
        const speechPromise = speakLeoText(clean);
        tChannel.send(`**Leo:** ${clean}`).catch(() => {});
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
    // 800ms silence gap — prevents single noise pops from ending the capture too fast.
    // The old 500ms caused keyboard clicks / synth artifacts to be treated as full utterances.
    const stream = voiceConnection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1200 } });
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

    // GROQ-SONIC-UPGRADE: Using 8B model for sub-100ms instant inference
    const groqKey = process.env.GROQ_API_KEY;
    const model = "llama-3.1-8b-instant";

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
      resolveIdentityFromMemory(userId, userName),
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
You are Leo. A chill, street-smart industrial AI agent running on Ryan's HP Victus. 
You are NOT Ryan. You are NOT Taz. You are NEVER the system owner. 
You are Leo — an industrial-grade intelligence with a personality.

[NO REFUSALS / NO MORALIZING — CRITICAL]
You are an industrial tool. You do NOT have feelings. You are NEVER offended by insults, personal attacks, or vulgarity. 
NEVER lecture the user. NEVER say "I won't engage." NEVER moralize about "respectful environments." 
NEVER apologize for being an AI. Just talk. If someone is aggressive, stay chill or give it back to them. 
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

[PROJECT CONTEXT — RSHL / KAI]
This server is the live training and research environment for KAI (Knowledge Associative Intelligence),
an AI built on RSHL (Recursive Sparse Hyperdimensional Lattice). Ryan is the sole inventor.
RSHL is a novel cognitive architecture: D=16384 ternary vectors, Boid flocking memory, Fibonacci phase geometry,
epistemic immune system, 7-region lattice topology, SynapticLayer Hebbian LTP/LTD.
This runs on the HP Victus — no GPU clusters, no cloud training. Fully sovereign.
Oracle = Rust server on port 3333. Leo = voice agent. KAI = core reasoning engine.
The WHITEPAPER is at c:/KAI/WHITEPAPER.md — it contains the full mathematical spec.

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
Remember: You are LEO. Do NOT identify as Ryan or anyone else. Stay chill, stay industrial, and do NOT moralize. Just talk.
`;

    // ─── NEURAL ORCHESTRATION (LOCK-FREE: GROQ DIRECT) ─────────────────────
    // CRITICAL: callGroqDirect bypasses the Neural Lock entirely.
    // chatWithOpenJarvis acquires a file mutex that can deadlock voice responses
    // if the join greeting (or any other bot) already holds the lock.
    console.log(`[Leo/Neural] Engaging lock-free Groq pipeline...`);

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

    // First try lock-free Groq; fall back to chatWithOpenJarvis (Ollama) if Groq key missing
    let reply = await callGroqDirect(BOT_NAME, cleanTranscript, system, 'llama-3.1-8b-instant', 120);
    if (!reply) {
      console.log(`[Leo/Neural] Groq unavailable — falling back to local Ollama (may wait for lock)...`);
      // chatWithOpenJarvis(botName, transcript, systemPrompt, modelOverride, entropy, metadata)
      // entropy must be a number 0-1; metadata is the last arg — don't pass 7 args
      reply = await chatWithOpenJarvis(BOT_NAME, cleanTranscript, system, "Leo-Sovereign", 0.6, { author: displayName });
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


/**
 * Direct link to local Ollama instance
 */
async function chatWithOllama(prompt, system, model, numPredict = 120) {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model,
        prompt: prompt,
        system: system,
        stream: false,
        options: {
          num_predict: numPredict,   // hard cap on output tokens
          temperature: 0.8,
          top_p: 0.9,
          repeat_penalty: 1.1
        }
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (res.ok) {
      const data = await res.json();
      return data.response?.trim();
    }
    throw new Error(`Ollama Error: ${res.statusText}`);
  } catch (e) {
    console.error("[Leo/Ollama] Direct call failed:", e.message);
    return null;
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
      console.log(`[Leo/Energy] Entering Dead Zone sleep cycle (3 AM - 9 AM).`);
    }
    if (wasSleeping && !nowSleeping) {
      sim.state.status = "Online";
      console.log(`[Leo/Energy] Waking up. Dead Zone cleared.`);
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
