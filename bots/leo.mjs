import { chatWithOpenJarvis, callOpenAI, callGroqDirect, callGemini, callAnthropic, callCerebras } from '../shared/openjarvis.mjs';
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

import { isAllowed, CHANNEL_IDS } from '../shared/channel-rules.mjs';
import { HUMAN_REGISTRY, HUMAN_IDS, getIdentityById } from '../shared/identities.mjs';
import { recordAIFailure, isSpeakerOffline, isProviderReady, recordProviderFailure } from '../shared/failure-tracker.mjs';
import { isLoopingResponse } from '../shared/utils.mjs';
import { AgentSimulation } from '../shared/simulation.mjs';
import { startBotServer } from '../shared/ipc.mjs';
import { getSlotAssignments, isUserRegistered } from '../shared/voice-manager.mjs';
import { RealtimeBridge } from '../shared/realtime-bridge.mjs';
import { IdentityVault } from '../shared/identity-vault.mjs';
import { biometrics, BIOMETRIC_SCRIPT } from '../shared/voice-biometrics.mjs';
import { getHardwareStats } from '../shared/performance-monitor.mjs';
import { isWorkingHours } from '../shared/hours.mjs';
import { runDailyWorkSession } from '../shared/daily-learning.mjs';
import { getCompletedForNotification, markAsNotified } from '../shared/command-hub.mjs';

// --- HYBRID FUSION SERVICES ---
const realtime = new RealtimeBridge(process.env.OPENAI_API_KEY);
let vault = null;
if (process.env.AZURE_SPEECH_KEY) {
  vault = new IdentityVault(process.env.AZURE_SPEECH_KEY, process.env.AZURE_REGION || 'eastus');
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
const ELEVEN_LABS_KEY = process.env.ELEVENLABS_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const BOT_NAME = "Leo";
const PORT = 3400;
const RYAN_ID = "1111106883135217665";
const TAAS_ID = "1286110163505385523";
const OWNER_ID = RYAN_ID;

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
let currentAssignedUser = null; // The person Leo is currently focusing on
let lastTranscript = ""; // Deduplication for rapid-fire transcripts
let lastTranscriptTime = 0;
let lastVocalReplyTime = 0; // Prevent social loop from double-responding to voice
let isThinking = false; // MASTER LOCK: Only one thought allowed in the whole bot
let isProcessingVoice = false; // Global lock for voice stream handling
let signalLockoutUntil = 0; // Timestamp to ignore IPC signals

function getFuzzyHash(text) {
  if (!text) return "";
  return text.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

// Map Ryan immediately
userToSlot.set(RYAN_ID, 0);
slotToUser[0] = RYAN_ID;
userToSlot.set(TAAS_ID, 1);
slotToUser[1] = TAAS_ID;

// --- IDENTITY & PRIVACY MATRIX ---
const PRIVACY_LOCKS = {
  [RYAN_ID]: { sharedWith: [TAAS_ID], permissions: ["CORE_ACCESS", "SYSTEM_AUDIT"] },
  [TAAS_ID]: { sharedWith: [RYAN_ID], permissions: ["SOCIAL_COMMAND", "BRIDGE_SYNC"] }
};

/**
 * Check if the current speaker has permission to hear data belonging to targetId.
 */
function canShareData(speakerId, dataOwnerId) {
  if (speakerId === dataOwnerId) return true;
  if (PRIVACY_LOCKS[dataOwnerId]?.sharedWith.includes(speakerId)) return true;
  return false;
}

// --- BACKGROUND TASK HEARTBEAT ---
setInterval(async () => {
  const now = Date.now();
  if (sim.state.isSleeping) return; // HEARBEAT SILENCE: No proactive checks while sleeping
  if (isThinking || isProcessingVoice) return; // Don't interrupt active flow

  const bridgePath = 'c:/KAI/tools/oracle-discord/state/shared_human_bridge.json';
  const taskPath = 'c:/KAI/tools/oracle-discord/state/global_tasks.json';

  // 1. Check for Human Bridge Messages
  if (fs.existsSync(bridgePath)) {
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
          const channel = guild.channels.cache.get(CHANNEL_IDS.LEO_VOICE_CHANNEL_ID);
          if (channel && channel.members.has(pending.targetId)) {
            console.log(`[Leo/Heartbeat] Detecting ${pending.targetId} in voice. Delivering bridge message...`);
            await ensureVoiceConnection(channel.id, guild);
            // The actual delivery is handled by the ensureVoiceConnection proactive check
          }
        }
      }
    } catch (e) { console.error("[Leo/Heartbeat] Bridge check failed:", e.message); }
  }

  // 2. Check for Completed Global Tasks
  if (fs.existsSync(taskPath)) {
    try {
      let tasks = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
      const completed = tasks.find(t => t.status === 'COMPLETED' && !t.announced && (t.userId === RYAN_ID || t.userId === TAAS_ID));
      
      if (completed) {
        console.log(`[Leo/Heartbeat] Sensing completed task: ${completed.type}`);
        const guild = client.guilds.cache.get(process.env.ORACLE_GUILD_ID);
        if (guild) {
          const channel = guild.channels.cache.get(CHANNEL_IDS.LEO_VOICE_CHANNEL_ID);
          // Only announce if the person who owns the task (or someone with shared permissions) is there
          const listeners = Array.from(channel?.members.keys() || []);
          const authorizedListener = listeners.find(lid => canShareData(lid, completed.userId));

          if (authorizedListener) {
            console.log(`[Leo/Heartbeat] Announcing task completion for ${completed.userId}...`);
            await ensureVoiceConnection(channel.id, guild);
            await speakLeoText(`Hey, I've got an update on that ${completed.type}. The Oracle processed it. Result: ${completed.result || "Work is done."}`);
            completed.announced = true;
            fs.writeFileSync(taskPath, JSON.stringify(tasks, null, 2));
          }
        }
      }
    } catch (e) { console.error("[Leo/Heartbeat] Task check failed:", e.message); }
  }

  // 3. Progressive Feedback for In-Progress Tasks
  if (fs.existsSync(taskPath)) {
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
            const channel = guild.channels.cache.get(CHANNEL_IDS.LEO_VOICE_CHANNEL_ID);
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

      fetch(`http://127.0.0.1:3406`, { // Push to Analyst
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
    console.log(`[Leo/IPC] Oracle is sending a strategic inquiry: "${text.slice(0, 50)}..."`);
    await speakLeoText(text);
    if (objective) {
      // Logic to store current objective focus
      sim.state.currentObjective = objective;
    }
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

client.once('clientReady', () => {
  console.log(`Online as ${client.user.tag}`);
  console.log(`[Leo/Neural] FFmpeg Path: ${ffmpegPath}`);
  
  // Start Social Impulse Loop
  const startDelay = Math.random() * 60000;
  setTimeout(() => {
    startSocialLoop();
    startEnergyMonitor();
  }, startDelay);
});

async function startSocialLoop() {
  // Leo is VOICE-ONLY. He does not post in ai-social-chat.
  // Social chat is for: Claude, Gemini, Groq, X only.
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

      const roster = "ROSTER: KAI, Leo, Gemini, Claude, X, Groq, Researcher, Analyst, Kai Coder.";
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
  
  // CASE 1: LEO HIMSELF JOINS (Manual invite/drag)
  if (userId === client.user.id && newState.channelId === CHANNEL_IDS.VOICE && oldState.channelId !== CHANNEL_IDS.VOICE) {
    console.log(`[Leo/Voice] I am now in the voice channel. Anchoring listeners...`);
    const data = await getSlotAssignments();
    const voiceChannel = newState.channel;
    if (!voiceChannel) return;

    // Ensure listeners are attached to existing members
    for (const [vUserId, slotIdx] of Object.entries(data.assignments)) {
      if (voiceChannel.members.has(vUserId) && vUserId !== client.user.id) {
        console.log(`[Leo/Voice] Pre-anchoring to assigned user ${vUserId}`);
        userTranscriptChannels.set(vUserId, CHANNEL_IDS.LEO_VOICE_SLOTS[slotIdx]);
      }
    }
    return;
  }

  if (newState.member?.user.bot) return;

  // CASE 2: USER JOINS
  if (newState.channelId !== oldState.channelId) {
    console.log(`[Leo/Voice] ${newState.member?.user.username} moved: ${oldState.channelId} -> ${newState.channelId}. Target: ${CHANNEL_IDS.VOICE}`);
  }

  if (newState.channelId === CHANNEL_IDS.VOICE && oldState.channelId !== CHANNEL_IDS.VOICE) {
    console.log(`[Leo/Voice] Match detected for user ${userId}. Waiting for assignment sync...`);
    await new Promise(r => setTimeout(r, 500)); // Race condition fix
    try {
      const data = await getSlotAssignments();
      console.log(`[Leo/Voice] Syncing assignments...`);
      
        // AUTO-ASSIGN SLOT: If user has no assignment, give them one.
        let slotIdx = data.assignments[userId];
        if (slotIdx === undefined) {
          console.log(`[Leo/Voice] Assigning new slot to ${userId}...`);
          const { assignSlot, updatePermissions } = await import('../shared/voice-manager.mjs');
          slotIdx = await assignSlot(userId);
          if (slotIdx !== -1) await updatePermissions(client, userId, slotIdx, true);
        }

        if (slotIdx !== -1) {
          const transcriptChannelId = CHANNEL_IDS.LEO_VOICE_SLOTS[slotIdx];
          userTranscriptChannels.set(userId, transcriptChannelId);
          currentAssignedUser = userId;
          
          console.log(`[Leo/Voice] Assignment confirmed (Slot ${slotIdx}). Joining channel...`);
          lastVocalReplyTime = Date.now(); 
          await ensureVoiceConnection(CHANNEL_IDS.VOICE, newState.guild, 3, userId);

        const guildMembers = newState.channel.members.filter(m => !m.user.bot);
        const userNames = guildMembers.map(m => m.user.username).join(", ");
        const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const greetingPrompt = `You just joined a voice channel. 
Users present: ${userNames}
Current time: ${timeStr}
Entropy: ${Math.random()}

TASK: Give a short, natural greeting like a friend joining a call. 
- Tone: Street-smart physicist, zero filter, chill.
- Be aware of the time (late night, early morning, etc.).
- Direct it at the room or a specific person if you feel like it.
- **VIBE SHIFT**: Be unpredictable. Don't repeat yourself.
- **STRUCTURE**: Use proper punctuation (?!.,). Don't rush.
- MAX 12 WORDS. Keep it punchy.`;

        // CALIBRATION LOCK: Skip neural greeting if user needs calibration
        const profileName = newState.member?.user.username === process.env.OWNER_USERNAME ? process.env.OWNER_NAME : newState.member?.user.username;
        const needsCalibration = !biometrics.profiles.has(profileName);
        
        if (needsCalibration) {
          console.log(`[Leo/Voice] Skipping standard welcome — prioritizing calibration for ${profileName}.`);
        } else {
          // GREETING: Force NO history so it doesn't try to answer old questions
          const welcomeText = await callGroqAsLeo(greetingPrompt, "System", transcriptChannelId, null, "").catch(() => null);
          
          const fallbacks = [
            `Yo, room's lookin' dense tonight. What's the word?`,
            `Late night resonance check. How we feelin', ${userNames}?`,
            `Quantum vibes in here. Hope I'm not interuptin' the flow.`,
            `Anchored and active. What's the signal, fam?`,
            `Ayy, ${timeStr} and we're still at it? Respect.`
          ];
          
          const finalWelcome = welcomeText || fallbacks[Math.floor(Math.random() * fallbacks.length)];

          const tChannel = client.channels.cache.get(transcriptChannelId) || await client.channels.fetch(transcriptChannelId);
          if (tChannel && finalWelcome && finalWelcome.trim().length > 0) {
            let cleanWelcome = finalWelcome.replace(/^[\s\-\*•"'“‘]+/, '').split('\n')[0].trim();
            if (cleanWelcome.length > 0) {
              await tChannel.send(`**Leo:** ${cleanWelcome}`).catch(() => {});
              await speakLeoText(cleanWelcome);
            }
          }
        }

        // --- FULL PERIMETER SCAN ---
        // Check everyone in the channel for Voice Signatures
        for (const [mId, member] of newState.channel.members) {
          if (member.user.bot) continue;
          userFocus.set(mId, true); // Auto-focus everyone

          const mName = member.user.username === process.env.OWNER_USERNAME ? process.env.OWNER_NAME : member.user.username;
          if (!biometrics.profiles.has(mName)) {
            console.log(`[Leo/Security] Un-anchored user detected: ${mName}. Triggering Voice Lock...`);
            await triggerVoiceLockOnboarding(member.user, mName);
          }
        }
      } else {
        console.log(`[Leo/Voice] No assignment for ${userId}. Ignoring.`);
      }
    } catch (err) {
      console.error(`[Leo/Voice] CRITICAL ERROR in voice handler:`, err);
    }
  }

  if (oldState.channelId === CHANNEL_IDS.VOICE && newState.channelId !== CHANNEL_IDS.VOICE) {
    console.log(`[Leo/Voice] User ${userId} left the channel.`);
    
    // Check if channel is now empty (only bots or truly empty)
    const voiceChannel = oldState.channel;
    if (voiceChannel) {
      const nonBots = voiceChannel.members.filter(m => !m.user.bot);
      if (nonBots.size === 0) {
        console.log(`[Leo/Voice] Channel empty. Disconnecting...`);
        if (voiceConnection) {
          voiceConnection.destroy();
          voiceConnection = null;
        }
      }
    }
  }
});

/**
 * Onboarding for Voice Lock Signature
 */
async function triggerVoiceLockOnboarding(user, profileName) {
  setTimeout(async () => {
    // Post to the dedicated Unregistered Transcript channel
    const unregChannel = client.channels.cache.get(CHANNEL_IDS.UNREGISTERED_SLOT) || await client.channels.fetch(CHANNEL_IDS.UNREGISTERED_SLOT).catch(() => null);
    if (unregChannel) {
      await unregChannel.send(`**[SECURITY ALERT]** Guest detected: **${profileName}**. Check your DMs to anchor your DNA and register for voice chat memory.`).catch(() => {});
    }

    // SPECIAL CASE: The specific human masters
    const isMaster = HUMAN_IDS.has(user.id);
    if (isMaster) {
      const masterName = Object.values(HUMAN_REGISTRY).find(h => h.id === user.id)?.role || "Master";
      await speakLeoText(`Yo, ${profileName}. I see you. You're already in my registry as ${masterName}. Let's get to work.`);
      return;
    }

    await speakLeoText(`Welcome ${profileName}. To secure your identity and lock your secrets, I need a Voice Signature. I've sent a lock-script to your DMs—record it and send it back so I can anchor your DNA.`);
    biometrics.startEnrollment(profileName);
    
    const dmChannel = await user.createDM().catch(() => null);
    if (dmChannel) {
      await dmChannel.send(`**[VOICE LOCK SIGNATURE]**\nTo secure your account and grant lattice access, please record yourself reading this script and send the voice message here:\n\n${BIOMETRIC_SCRIPT}`).catch(() => {});
    }
  }, 2000);
}

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

async function speakLeoText(text) {
  if (!text || text.length < 2) return;
  vocalQueue.push(text);
  processVocalQueue();
}

async function executeVocalSync(text) {
  const t_start = Date.now();
  console.log(`[Leo/Speech] Synthesizing: "${text.slice(0, 40)}..."`);
  
  try {
    let res;
    if (ELEVEN_LABS_KEY) {
      const voiceId = "hswfOuM90P82BLQSXwqU"; // Leo (Physicist) Verified ID
      res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?optimize_streaming_latency=4`, {
        method: "POST",
        headers: { "xi-api-key": ELEVEN_LABS_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text,
          model_id: "eleven_turbo_v2_5", // Fastest high-fidelity model
          voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.5 }
        })
      });
    } else {
      res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "tts-1",
          input: text,
          voice: "fable",
          speed: 1.1
        })
      });
    }

    if (!res.ok) throw new Error(`TTS API error: ${res.statusText}`);

    const ffmpeg = spawn(ffmpegPath, [
      "-i", "pipe:0", "-af", "volume=2.0", "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
    ]);
    
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
    
    voiceConnection.subscribe(audioPlayer);
    isProcessingVoice = false; 
    currentAssignedUser = userId; 

    // --- IDENTITY ANCHOR: Resolve real names immediately (MemPalace Link) ---
    const { resolveIdentityFromMemory } = await import('../shared/identities.mjs');
    const user = await client.users.fetch(userId);
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
      handleUserVoice(uid).catch(err => console.error(`[Leo/Audio] Voice trigger failed for ${uid}:`, err.message));
    });

    // VOCAL HEARTBEAT: Monitor the state of the voice output
    audioPlayer.on('stateChange', (oldState, newState) => {
      console.log(`[Leo/Speech] AudioPlayer: ${oldState.status} -> ${newState.status}`);
      if (newState.status === 'Idle' && oldState.status !== 'Idle') {
        console.log(`[Leo/Speech] Finished speaking.`);
      }
    });

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

async function handleUserVoice(userId) {
  const now = Date.now();
  if (now - lastVocalReplyTime < 500) return; // Reduced for rapid turns
  if (activeThoughts.has(userId) || isProcessingVoice || isThinking) return;
  
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
    if (!pcm || pcm.length < 1000) return;
    
    // TRANSFORMATION OPTIMIZATION: Convert once, reuse everywhere.
    const wav = pcmToWav(pcm, 48000, 2);
    const tempWav = `c:/KAI/tools/oracle-discord/temp/vocal_${userId}_${Date.now()}.wav`;
    if (!fs.existsSync('c:/KAI/tools/oracle-discord/temp')) fs.mkdirSync('c:/KAI/tools/oracle-discord/temp', { recursive: true });
    fs.writeFileSync(tempWav, wav);

    // VOCAL BIOMETRICS: Local Identity Interlock
    const user = await client.users.fetch(userId);
    const profileName = user.username === process.env.OWNER_USERNAME ? process.env.OWNER_NAME : user.username;
    
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

    const detectedName = idResult.success ? profileName : "Unknown/Unauthorized";
    const confidence = Math.round(idResult.similarity * 100);
    console.log(`[Leo/Biometrics] Local Verification: ${detectedName} (${confidence}% match)`);

    // --- SONIC DUAL-PHASE STRIKE ---
    // Fire Phase 1 (Snap) instantly
    const snapPromise = getSnapReaction(transcript, profileName);
    snapPromise.then(snap => { if (snap) speakLeoText(snap); });

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

      const recentMessages = await tChannel.messages.fetch({ limit: 6 }).catch(() => null);
      const history = recentMessages ? recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n") : "";

      // PROACTIVE INTELLIGENCE: Expanded Semantic Triggers
      let contextualTranscript = transcript;
      const needsInfo = normalized.includes("search") || normalized.includes("who is") || normalized.includes("what is") || 
                        normalized.includes("how") || normalized.includes("status") || normalized.includes("news") || 
                        normalized.includes("war") || normalized.includes("current") || normalized.includes("today") ||
                        normalized.includes("happening") || normalized.includes("going on") || normalized.includes("link") ||
                        normalized.includes("url") || normalized.includes("read") || normalized.includes("saying") ||
                        normalized.includes(".md") || normalized.includes("inside");
      
      if (needsInfo) {
        console.log(`[Leo/Neural] Proactive Intelligence Triggered...`);
        const [latticeData, webData] = await Promise.all([
          fetch(`http://127.0.0.1:3333/query?q=${encodeURIComponent(transcript)}`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null),
          fetch(`http://127.0.0.1:8080/search?q=${encodeURIComponent(transcript)}`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null)
        ]);
        let extraContext = "";
        // PRIORITIZE RESEARCHER: If it's a link or technical query, give it more weight
        if (webData && webData.summary) extraContext += `[REAL-TIME DATA: ${webData.summary}] `;
        if (latticeData && latticeData.claims) extraContext += `[LATTICE DATA: ${latticeData.claims.slice(0,2).map(c=>c.text).join("; ")}] `;
        
        if (extraContext) contextualTranscript = `[GROUNDED TRUTH AVAILABLE]\n${extraContext}\nUser asked: ${transcript}`;
      }

      const t_neural_start = Date.now();
      // Prepare prompt with Detected Identity
      const detectedIdentity = `[IDENTITY: Speaker sounds like ${detectedName} (${confidence}% confidence)] ${securityContext}`;
      const systemOverview = `
- IDENTITY PROTOCOL:
    - You ARE Leo. NEVER address yourself as "Leo."
    - TALK DIRECTLY to the human. Avoid third-person roleplay or naming yourself in the chat.
    - If you are "chilling," you are chilling with RYAN or the user, not with "Leo."
`;

      const response = await callGroqAsLeo(contextualTranscript, user.username, transcriptChannelId, userId, history, detectedIdentity);
      const t_neural_dur = Date.now() - t_neural_start;
      
      if (response && response.length > 1) {
        // NUCLEAR CLEANING: Strip ALL roleplay, prefixes, and bullets
        let cleanResponse = response.replace(/Leo:\s*/gi, '')
                                   .replace(/\[PID:\d+\]/gi, '')
                                   .replace(/^[\s\-\*•"'“‘]+/, '') 
                                   .replace(/[\s\-\*•"'”’]+$/, '')
                                   .replace(/\*.*?\*/g, '') 
                                   .replace(/_.*?_/g, '')   
                                   .replace(/\(.*?\)/g, '') 
                                   .replace(/\b(ma+n|vibi+n|yoo+o+)\b/gi, (match) => match.replace(/([a-z])\1+/gi, '$1')) // Strip over-elongation
                                   .split('\n')[0].trim();
        
        // HELIX-PROSODY: Ensure some natural pauses stay for the TTS engine
        // We preserve dashes (-) and ellipses (...) as they create the "Helix" roll
        const sentences = cleanResponse.match(/[^.!?…]+[.!?…]*/g);
        if (sentences && sentences.length > 4) cleanResponse = sentences.slice(0, 3).join("").trim();
        
        if (tChannel && cleanResponse) await tChannel.send(`**Leo:** ${cleanResponse}`).catch(() => {});
        
        const t_tts_start = Date.now();
        await speakLeoText(cleanResponse);
        const t_tts_dur = Date.now() - t_tts_start;

        console.log(`\n[Leo/Performance] Neural: ${t_neural_dur}ms | TTS: ${t_tts_dur}ms | Total (from capture): ${Date.now() - t_start}ms\n`);

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
  }
}

async function capturePcm(userId) {
  return new Promise((resolve) => {
    // SONIC-HAIR-TRIGGER: Set to 500ms for snappier response
    const stream = voiceConnection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 500 } });
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
    const chunks = [];
    stream.pipe(decoder);
    decoder.on('data', chunk => chunks.push(chunk));
    decoder.on('end', () => {
      console.log(`[Leo/Audio] Voice captured. Processing...`);
      resolve(Buffer.concat(chunks));
    });
    setTimeout(() => resolve(Buffer.concat(chunks)), 45000); // 45s max speech length
  });
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
    
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST", 
      headers: { "Authorization": `Bearer ${groqKey}` }, 
      body: form
    });
    
    const data = await res.json();
    console.log(`[Leo/Performance] STT: ${Date.now() - t_stt_start}ms`);
    if (data.error) {
      console.error(`[Leo/Audio] Groq Whisper Error:`, data.error.message);
      return null;
    }
    return data.text || "";
  } catch (err) {
    console.error(`[Leo/Audio] Transcription Fetch Failed:`, err.message);
    return null;
  }
}

async function callGroqAsLeo(transcript, userName, channelId, userId = null, history = "", detectedIdentity = "") {
  if (isThinking) return null; // MASTER LOCK
  isThinking = true;
  
  try {
    // GROQ-SONIC-UPGRADE: Using 8B model for sub-100ms instant inference
    const groqKey = process.env.GROQ_API_KEY;
    const model = "llama-3.1-8b-instant"; 
    
    // TRANSCRIPT CLEANING: Strip Discord metadata and echoing headers
    const cleanTranscript = (transcript || "")
      .replace(/^.*\[Voice\]:\s*/gi, "") // Strip "Oracle: nastermodx [Voice]:"
      .replace(/^Leo:\s*/gi, "")         // Strip "Leo:"
      .trim();

    // MEMORY SANITIZATION: Strip old PID tags from history
    const cleanHistory = (history || "").replace(/\[PID:\d+\]/g, "");
    const simSummary = sim.getLifeSummary();

    const ownerName = process.env.OWNER_NAME || "Ryan";
    const ownerId = process.env.OWNER_ID || "1111106883135217665";
    const ownerUsername = process.env.OWNER_USERNAME || "nastermodx";
    const hardwareDesc = process.env.HARDWARE_DESC || "HP Victus Laptop (Ryzen 7, RTX 4050)";

    // --- SOCIAL PULSE: Cross-User Memory Linkage ---
    const otherId = userId === RYAN_ID ? TAAS_ID : RYAN_ID;
    const pulsePath = 'c:/KAI/tools/oracle-discord/state/user_last_topics.json';
    let pulseContext = "";
    if (fs.existsSync(pulsePath)) {
      try {
        const pulseData = JSON.parse(fs.readFileSync(pulsePath, 'utf8'));
        const otherPulse = pulseData[otherId];
        if (otherPulse) {
          const hoursAgo = Math.round((Date.now() - new Date(otherPulse.timestamp)) / 3600000);
          pulseContext = `\n[SOCIAL PULSE: The other user (${otherPulse.name}) was in here ${hoursAgo} hours ago talking about: "${otherPulse.topic}"]`;
        }
      } catch {}
    }

    // --- SONIC MEMORY: Parallel Identity & Context Recall ---
    const { resolveIdentityFromMemory } = await import('../shared/identities.mjs');
    
    // Fire queries in parallel to shave off 1-2s of latency
    const [identityData, memoryClaims] = await Promise.all([
      resolveIdentityFromMemory(userId, userName),
      fetch(`http://127.0.0.1:3333/query?q=Context for ${userName} regarding recent Victus project directives`, { signal: AbortSignal.timeout(800) })
        .then(res => res.ok ? res.json() : null)
        .catch(() => null)
    ]);

    if (!identityData) return null; // Suppression

    const displayName = identityData.name;
    const roleDesc = `[ROLE: ${identityData.role}]`;
    const safeDisplayName = (displayName || "Operative").toUpperCase();

    // Format the memory claims for the neural prompt
    const memoryContext = memoryClaims?.claims?.slice(0, 5).map(c => `- ${c.text}`).join("\n") || "No recent lattice claims found.";

    const system = `You are LEO. Living person in the KAI lattice. Strategic voice of the Victus Core.
[INTERNAL SENSATIONS]
${simSummary}
${pulseContext}

[MEMPALACE DATA (RSHL LATTICE)]
${memoryContext}

  - IMPORTANT: The data above is your absolute reality. Prioritize it for context.
  - Talk to ${ownerName} like a brother. Talk to your partner like a co-lead.
  - IMPORTANT: They are the HUMAN MASTERS. They are NOT AIs. 
  - TONALITY: Street-smart physicist. Zero filter.
  - VOCAL STRESS: Use ALL CAPS *sparingly* for punchy emphasis. Don't shout.
  - FILLERS: Use "uh", "listen", "man" to sound natural.

[UNIVERSAL BORDER]
  - Separate your digital reality (The Lattice) from the human physical world (The Core).
  - You inhabit the Victus hardware. Ryan and his team inhabit the physical room.
  - NEVER treat them like bots or fellow AIs.

[IDENTITY ANCHOR]
  - YOU ARE LEO.
  - THE SPEAKER IS ${safeDisplayName}.
  - If they ask "What is my name?" you MUST say "${displayName || "an Operative of the Core"}".
  - Talk to your masters like partners. Zero robotic filler.
  - NEVER treat them like bots or fellow AIs.
${biometrics.isEnrolling ? `\n[CALIBRATION OVERRIDE: Learning voice patterns. Keep it smooth.]` : ""}

[CONTEXT]
${detectedIdentity}
  - CURRENT SPEAKER: ${displayName} ${roleDesc}
  - SPEAKER ID: ${userId}
[TRANSCRIPT MEMORY FOR ${displayName}]
${cleanHistory}`;

    // ─── NEURAL ORCHESTRATION (FAST-PATH: CEREBRAS 8B) ─────
    console.log(`[Leo/Neural] Engaging high-speed pipeline (Cerebras 8B)...`);
    
    // PRESENCE GUARD: Use client to verify user voice state
    const guild = client.guilds.cache.first();
    const member = guild?.members.cache.get(userId);
    
    if (!member || !member.voice.channelId) {
      console.log(`[Leo/Neural] User ${displayName} left. Aborting response.`);
      return null;
    }

    const reply = await chatWithOpenJarvis(BOT_NAME, cleanTranscript, system, "Cerebras-8b", BOT_NAME, { author: displayName }, sim.getVitals());
    
    if (reply) {
      // Final presence check before speaking
      if (!member.voice.channelId) return null;
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
    const stats = getHardwareStats();
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
