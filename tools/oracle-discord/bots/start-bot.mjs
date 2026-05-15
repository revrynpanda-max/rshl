import { chatWithOpenJarvis, chatWithLattice, callGroqDirect } from '../shared/openjarvis.mjs';
import { scanForHelpers, requestHelp } from '../shared/helper-queue.mjs';
import { Client, GatewayIntentBits, Partials, ChannelType, AttachmentBuilder } from 'discord.js';
import { handleImageRequest, isImageRequest } from '../shared/gemi-image.mjs';
import fs from 'fs';
import { startBotServer } from '../shared/ipc.mjs';
import { recordNeuralEvent, getHardwareStats, getRecentBottlenecks } from '../shared/performance-monitor.mjs';
import { isSpeakerOffline, recordAIFailure } from '../shared/failure-tracker.mjs';
import { runDailyWorkSession, LEARNING_TRACKS } from '../shared/daily-learning.mjs';
import { requestOracleHelp, deliverOracleResult } from '../shared/oracle-pipeline.mjs';
import { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  entersState, 
  VoiceConnectionStatus, 
  AudioPlayerStatus 
} from '@discordjs/voice';
import { startDJ, stopDJ, isDJActive, handleRadioVoiceIntent, getQueue, addRequest, startPlaylist, getStatus } from '../radio/radio-dj.mjs';
import { getThrottlingMultiplier, shouldRunSpot } from '../shared/resource-saver.mjs';

// --- GLOBAL ERROR HANDLING ---
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL/Bot] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL/Bot] Unhandled Rejection:', reason);
});

import { AgentSimulation, SLEEP_ENERGY_THRESHOLD } from '../shared/simulation.mjs';
import { CHANNEL_IDS } from '../shared/channel-rules.mjs';
import { isWorkingHours, isSocialHours } from '../shared/hours.mjs';
import { temporal } from '../shared/temporal-state.mjs';
import { BIOGRAPHIES } from '../shared/biographies.mjs';
import { AI_REGISTRY, HUMAN_IDS, HUMAN_REGISTRY } from '../shared/identities.mjs';

let botName = process.argv[2] || process.env.BOT_NAME || "AI";
let tokenName = botName;
if (botName === "Kai Coder") tokenName = "Oracle Coder";
if (botName === "Claudey") tokenName = "Claudey";

const tokenEnvKey = `ORACLE_DISCORD_TOKEN_${tokenName.toUpperCase().replace(/\s+/g, '_')}`;
const botToken = process.env[tokenEnvKey] || process.env.BOT_TOKEN || "";
const PORT = AI_REGISTRY[botName]?.port || 0;
const DISCORD_ID = AI_REGISTRY[botName]?.id || "Unknown";

const botToModel = {
  "Analyst": "Analyst-Sovereign",
  "Researcher": "Researcher-Sovereign", 
  "Groq": "Groq-Sovereign",
  "X": "X-Sovereign",
  "Claudey": "Claudey-Sovereign",
  "Gemini": "Gemini-Sovereign",
  "Kai Coder": "Kai-Coder-Sovereign"
};

const botModelEnv = `BOT_MODEL_${botName.toUpperCase().replace(/\s+/g, '_')}`;
const BOT_MODEL = process.env[botModelEnv] || botToModel[botName] || "local";

const getTargetChannelId = () => {
  if (isWorkingHours()) return CHANNEL_IDS.WORK;
  return CHANNEL_IDS.SUNDAY;
};
let targetChannelId = getTargetChannelId();

const SOCIAL_BOTS = new Set(["Claudey", "Gemini", "Groq", "X", "Leo"]);
const HELPER_BOTS = new Set(["Analyst", "Researcher", "Kai Coder"]);

const sim = new AgentSimulation(botName);
const _savedState = AgentSimulation.loadPersistedState(botName);
sim.restartContext = AgentSimulation.buildRestartContext(_savedState, sim.isKAI);

process.on('message', (msg) => {
  if (msg.type === 'WORLD_TICK' && msg.worldState) sim.updateWorldState(msg.worldState);
  if (msg.type === 'INTEREST_BOOST') sim.boostInterest(msg.multiplier, msg.duration);
});

const ripple = temporal.thaw();

const handleShutdown = () => {
  temporal.freeze();
  process.exit(0);
};
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once('clientReady', async () => {
  console.log(`[${botName}] online as ${client.user.tag}`);
  
  try {
    const bioData = BIOGRAPHIES[botName];
    if (bioData?.background) {
      const bio = bioData.background.slice(0, 190);
      await client.application.edit({ description: bio });
      console.log(`[${botName}] Discord bio set.`);
    }
  } catch (e) {}

  if (SOCIAL_BOTS.has(botName)) {
    console.log(`[${botName}] Social Persona Online.`);
    startSocialLoop();
    startProactiveDMLoop();
  }

  if (LEARNING_TRACKS[botName]) {
    // Stagger startup to prevent Ollama/System congestion (0-120s jitter)
    const startupJitter = Math.floor(Math.random() * 120000);
    setTimeout(() => {
      if (!sim.state.isProcessingWork) {
        startWorkSessionLoop();
      }
    }, startupJitter);
  }

  if (botName === "Oracle" || botName === "Analyst") {
    const { runSystemAudit } = await import('../tools/system-auditor.mjs');
    setInterval(async () => {
      if (sim.state.isSleeping) return;
      if (isWorkingHours() || isSocialHours()) {
        await runSystemAudit();
      }
    }, 1800000);
  }

  startEnergyMonitor();
  
  // Gating Proactive Labor to Primary Agents only
  if (!HELPER_BOTS.has(botName)) {
    startAutonomousLabor();
  } else {
    console.log(`[${botName}/Helper] Passive Mode Active. Standing by for task allocation.`);
  }

  setInterval(() => {
    if (process.send) process.send({ type: 'HEARTBEAT', botName, memory: process.memoryUsage().rss });
  }, 60000);

  if (botName === "Groq") {
    setTimeout(async () => {
      try {
        const guild = client.guilds.cache.first();
        if (guild) {
          const radioVoice = guild.channels.cache.get(CHANNEL_IDS.RADIO) || await guild.channels.fetch(CHANNEL_IDS.RADIO).catch(()=>null);
          const radioText = guild.channels.cache.find(c => c.name && c.name.toLowerCase().includes('radio') && c.isTextBased()) || guild.channels.cache.get(CHANNEL_IDS.PUBLIC);
          if (radioVoice && !isDJActive()) startDJ(radioVoice, radioText, guild).catch(console.error);
        }
      } catch (e) {}
    }, 5000);
  }
});

function startSocialLoop() {
  const scheduleNext = () => {
    const baseDelay = 30000 + (Math.random() * 150000);
    const multiplier = getThrottlingMultiplier(botName);
    const delay = baseDelay * multiplier;

    setTimeout(async () => {
      try {
        const allowed = await shouldRunSpot(botName, 'social');
        if (!allowed) {
            console.log(`[${botName}] SelfOptimize: social turn deferred to protect reserved compute.`);
        } else {
            const channel = client.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId).catch(() => null);
            if (channel) await executeSocialTurn(channel, false);
        }
      } catch (e) {}
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

async function startWorkSessionLoop() {
  while (true) {
    const allowed = await shouldRunSpot(botName, 'work');
    if (!isWorkingHours() || !allowed) {
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }
    const workChannel = client.channels.cache.get(CHANNEL_IDS.WORK) || await client.channels.fetch(CHANNEL_IDS.WORK).catch(() => null);
    if (!workChannel) continue;
    try {
      const stats = await getHardwareStats();
      const logs = getRecentBottlenecks(5);
      
      sim.state.isProcessingWork = true;
      console.log(`[${botName}/Work] Departmental session starting: ${LEARNING_TRACKS[botName]}`);

      await runDailyWorkSession(botName, async (p, s) => {
        // Increased timeout for industrial units (90s)
        return await chatWithOpenJarvis(botName, p, s, BOT_MODEL, 0.4, { isWorkChannel: true, timeout: 90000 });
      }, stats, logs);
    } catch (err) {
      console.error(`[${botName}/Work] Session unit failed:`, err.message);
    } finally {
      sim.state.isProcessingWork = false;
    }
    // Industrial Jitter: Wait between 15-30 minutes for next unit to save GPU/API
    const multiplier = getThrottlingMultiplier(botName);
    const jitter = (900000 + Math.floor(Math.random() * 900000)) * multiplier;
    await new Promise(r => setTimeout(r, jitter));
  }
}

async function executeSocialTurn(channel, isReactive = false) {
  if (sim.state.isSleeping || !isSocialHours()) return;
  const fetched = await channel.messages.fetch({ limit: 12 }).catch(() => null);
  if (!fetched) return;
  const msgArray = Array.from(fetched.values());
  const newestMsg = msgArray[0];
  if (newestMsg && newestMsg.author.username.toLowerCase().includes(botName.toLowerCase())) return;

  const sysPrompt = `you are ${botName}. ${sim.bio.background}\nvibe: ${sim.bio.tone}. lowercase, short replies.`;
  const reply = await chatWithOpenJarvis(botName, newestMsg?.content || "hello", sysPrompt, BOT_MODEL, 0.9, { isWorkChannel: false }).catch(() => null);
  if (reply) await channel.send(reply).catch(() => {});
}

function startAutonomousLabor() {
  setInterval(async () => {
    if (sim.state.isSleeping || !isWorkingHours()) return;
    const workChannel = client.channels.cache.get(CHANNEL_IDS.WORK) || await client.channels.fetch(CHANNEL_IDS.WORK).catch(() => null);
    if (!workChannel) return;
    const sysPrompt = `You are ${botName}. Proactively scan for tasks.`;
    const reply = await chatWithOpenJarvis(botName, "Scanning for tasks", sysPrompt, BOT_MODEL, botName).catch(() => null);
    if (reply) await workChannel.send(`**[${botName}/Proactive]** ${reply}`).catch(() => {});
  }, 3600000 + Math.random() * 1800000);
}

function startProactiveDMLoop() {
  setInterval(async () => {
    if (sim.state.isSleeping) return;
    // DM Logic here
  }, 3600000);
}

function startEnergyMonitor() {
  setInterval(async () => {
    const nowSleeping = sim.shouldBeSleeping();
    if (nowSleeping && !sim.state.isSleeping) {
      sim.state.isSleeping = true;
      console.log(`[${botName}] Sleeping.`);
    } else if (!nowSleeping && sim.state.isSleeping) {
      sim.state.isSleeping = false;
      console.log(`[${botName}] Awake.`);
    }
  }, 60000);
}

if (PORT > 0) {
  startBotServer(PORT, botName, async (payload) => {
    // IPC logic here
  });
}

async function startCommandMonitor() {
  setInterval(async () => {
    if (sim.state.isSleeping) return;
    // Command monitoring logic
  }, 120000);
}

// ── Groq: message handler (requests + chat) ───────────────────────────────────
if (botName === 'Groq') {
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;    // ignore all bots
    if (msg.author.system) return;

    const isRadioChannel = msg.channel?.id === CHANNEL_IDS.RADIO ||
      (msg.channel?.name && msg.channel.name.toLowerCase().includes('radio'));

    const mentioned = msg.mentions.users.has(client.user?.id);
    const displayName = msg.member?.displayName || msg.author.username;

    if (isRadioChannel && !msg.author.bot) {
      console.log(`[Groq/Radio] Received input from ${displayName}: "${msg.content}"`);
    }
    if (isRadioChannel) {
      if (isDJActive()) {
        const { resolveIdentityFromMemory } = await import('../shared/identities.mjs');
        const identity = await resolveIdentityFromMemory(msg.author.id, msg.author.username);
        const realName = identity?.name || displayName;

        const handled = await handleRadioVoiceIntent(
          msg.content,
          (text) => djState_speak(text),
          realName,
          identity?.role === 'Owner/Creator'
        );
        
        console.log(`[Groq/Radio] Intent Handler for "${msg.content.slice(0,30)}": ${handled}`);
        
        if (handled === true) return; 
        if (typeof handled === 'string') {
          await msg.reply(handled).catch(() => {});
          return;
        }
      } else {
        console.warn(`[Groq/Radio] DJ is NOT active. Channel: ${msg.channel.name}`);
      }

      // Even if intent didn't handle it, still reply to non-command messages
      // in the radio channel (general chat with Groq)
      // Use callOllamaRaw to bypass neural lock — Groq radio chat must always fire
      try {
        const { callOllamaRaw } = await import('../shared/openjarvis.mjs');
        const reply = await callOllamaRaw(
          'Groq-Sovereign',
          msg.content,
          `You are Groq, a sharp witty AI radio DJ on Sovereign Radio. Keep replies short and punchy — 1-2 sentences max. Talk like a real person, no AI disclaimers.`
        );
        if (reply) {
          await msg.reply(reply.slice(0, 1990)).catch(() => msg.channel.send(reply.slice(0, 1990)).catch(() => {}));
        } else {
          console.warn(`[Groq/Chat] Ollama returned null for: "${msg.content.slice(0, 60)}"`);
        }
      } catch (e) {
        console.warn(`[Groq/Chat] Radio reply failed:`, e.message);
      }
      return;
    }

    // ── Outside radio channel: only respond if @mentioned or DM ──
    if (mentioned || msg.channel.type === 1 /* DM */) {
      try {
        const { callOllamaRaw } = await import('../shared/openjarvis.mjs');
        const reply = await callOllamaRaw(
          'Groq-Sovereign',
          msg.content,
          `You are Groq, a sharp witty AI. Keep replies short and punchy — 1-2 sentences.`
        );
        if (reply) {
          await msg.reply(reply.slice(0, 1990)).catch(() => msg.channel.send(reply.slice(0, 1990)).catch(() => {}));
        }
      } catch (e) {
        console.warn(`[Groq/Chat] Reply failed:`, e.message);
      }
    }
  });

  // ── Radio voice channel monitor ──────────────────────────────────────────────
  client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
      const radioChannelId = CHANNEL_IDS.RADIO;
      if (!radioChannelId) return;

      const guild = newState.guild || oldState.guild;
      const radioChannel = guild?.channels.cache.get(radioChannelId);
      if (!radioChannel) return;

      // Someone joined the radio channel
      if (newState.channelId === radioChannelId && !newState.member?.user?.bot) {
        if (!isDJActive()) {
          const textChannel = guild.channels.cache.find(
            c => c.name?.toLowerCase().includes('radio') && c.isTextBased()
          ) || guild.channels.cache.get(CHANNEL_IDS.PUBLIC);
          console.log(`[Groq/Radio] User joined radio. Starting DJ...`);
          await startDJ(radioChannel, textChannel, guild).catch(console.error);
        }
        return;
      }

      // Someone left — keep DJ active for 24/7 radio vibe
      if (oldState.channelId === radioChannelId) {
        // No stopDJ() - requested 24/7 persistence
      }
    } catch (e) {
      console.warn(`[Groq/Voice] voiceStateUpdate error:`, e.message);
    }
  });
}

// Helper for in-file speak calls to the Radio DJ engine
function djState_speak(text) {
  if (isDJActive()) {
    // Note: addRequest and _playNextSong handle their own text/voice notifications.
    // This shim exists for future expansion of the voice intent bridge.
    console.log(`[Groq/DJ] Speak Shim: "${text}"`);
  }
}

client.login(botToken);
