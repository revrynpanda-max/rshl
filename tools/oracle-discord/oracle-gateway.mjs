import { Client, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import dotenv from 'dotenv';
import { BOT_PORTS, CHANNEL_IDS, ROUNDTABLE_CHANNELS, CHANNEL_SPEAKER_RULES, detectNamedBot } from './shared/channel-rules.mjs';
import { sendBotSignal } from './shared/ipc.mjs';
import { isWorkingHours, isSocialHours } from './shared/hours.mjs';
import { runKaiConsolidation, hasTodaysBriefing } from './shared/kai-dream.mjs';
import { chatWithOpenJarvis } from './shared/openjarvis.mjs';
import http from 'http';
import fs from 'fs';
import fetch from 'node-fetch';
import { biometrics } from './shared/voice-biometrics.mjs';
import { logAudit } from './shared/audit-log.mjs';
import os from 'os';
import { AI_REGISTRY, resolveIdentityFromMemory } from './shared/identities.mjs';
import { startSentinel } from './shared/sentinel.mjs';

import 'dotenv/config';

startSentinel();

const DEPARTMENTS = {
  "Researcher": "Investigate technical claims, verify sources, and provide deep-dive intelligence on KAI/RSHL developments.",
  "Analyst": "Synthesize data into strategic business logic, optimize resource allocation, and plan project milestones.",
  "Kai Coder": "Maintain the RSHL Core, debug system nodes, and implement code-level architectural enhancements.",
  "Gemini": "Manage corporate expansion, refine the KAI identity, and conduct market/ecosystem outreach.",
  "Claude": "Perform high-level epistemic reasoning, architectural strategy, and complex logic verification.",
  "X": "Monitor real-time digital trends, analyze asset intelligence, and provide rapid-response tactical data.",
  "Groq": "Process high-volume quantitative metrics, optimize system throughput, and generate statistical performance audits."
};

const USER_REGISTRY_PATH = 'c:/KAI/tools/oracle-discord/state/user_registry.json';
let userRegistry = { slots: {}, remaining_slots: 4 };

function loadUserRegistry() {
  if (fs.existsSync(USER_REGISTRY_PATH)) {
    try {
      userRegistry = JSON.parse(fs.readFileSync(USER_REGISTRY_PATH, 'utf8'));
    } catch (e) { console.error("[Oracle/Registry] Load failed:", e.message); }
  }
}
loadUserRegistry();

const PORT = 3410;
const ORACLE_API_URL = process.env.ORACLE_API_URL || "http://127.0.0.1:3333";
const MESSAGE_RING_MAX = 120;
const CHANNEL_RINGS = new Map();

// --- IPC SERVER ---
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        if (payload.type === 'LEO_CONSULTATION') await handleLeoConsultation(payload);
        if (payload.type === 'VOICE_TRANSCRIPT') await handleVoiceTranscript(payload);
        if (payload.type === 'BOT_SPEECH') await handleBotSpeech(payload);
        if (payload.type === 'HELPER_REQUEST') {
          console.log(`[Oracle/Bridge] Routing HELPER_REQUEST from ${payload.requester} to ${payload.targetBot}...`);
          if (payload.port) sendBotSignal(payload.port, payload);
        }
        if (payload.type === 'BOT_RELAY') {
          const { botName, text, channelId, requesterId } = payload;
          console.log(`[Oracle/Relay] Relaying findings from ${botName} to user...`);
          const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
          if (channel) {
            const prefix = requesterId ? `<@${requesterId}>, ` : "";
            await channel.send(`${prefix}🏛️ **[Oracle/Relay]** Analysis from the **${botName}** department:\n\n${text.slice(0, 1800)}`).catch(console.error);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[Oracle/IPC] Strategic Bridge active on port ${PORT}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// --- CORE FUNCTIONS ---

async function initiateDepartmentalThreads() {
  if (!isWorkingHours()) {
    console.log("🏛️ [Oracle/Teacher] Not work hours. Suppressing departmental cellularization.");
    return;
  }
  console.log("🏛️ [Oracle/Teacher] Initiating Departmental Cellularization...");
  const workChannel = client.channels.cache.get(CHANNEL_IDS.WORK);
  if (!workChannel) return;

  const activeThreads = await workChannel.threads.fetchActive();

  for (const [bot, task] of Object.entries(DEPARTMENTS)) {
    const threadName = `Shift: ${bot} [${new Date().toLocaleDateString()}]`;
    
    const existingThread = activeThreads.threads.find(t => t.name === threadName);
    if (existingThread) {
      console.log(`[Oracle/Teacher] Thread for ${bot} already active. Re-poking bot...`);
      const port = BOT_PORTS[bot];
      if (port) {
        sendBotSignal(port, { 
          channelId: existingThread.id, 
          context: `[SHIFT RE-IGNITION] Your work thread is still active. Resume operations: ${task}`,
          isInterjection: true 
        });
      }
      await new Promise(r => setTimeout(r, 1000)); // Ultra-dense stagger
      continue;
    }

    const thread = await workChannel.threads.create({
      name: threadName,
      autoArchiveDuration: 1440,
      reason: `Departmental Isolation for ${bot}`
    }).catch(console.error);

    if (thread) {
      await thread.send(`🧬 **CELLULAR DIRECTIVE: ${bot.toUpperCase()}**\n\n**Status**: Active / Industrial\n**Task**: ${task}\n\n**Instructions**:
- All work-related thoughts must stay in this thread.
- If you need help from another AI, use the @Helper system.
- Provide proof of life/progress every 4 work units.`);

      const port = BOT_PORTS[bot];
      if (port) {
        sendBotSignal(port, { 
          channelId: thread.id, 
          context: `[SHIFT START] You are now isolated in your work thread. Execute the directive: ${task}`,
          isInterjection: true 
        });
      }
      await new Promise(r => setTimeout(r, 1000)); // Ultra-dense stagger
    }
  }
}

async function handleBotSpeech(payload) {
  const { botName, text, channelId } = payload;
  const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (channel) {
    const record = {
      from: botName,
      text: text,
      ts: Math.floor(Date.now() / 1000),
      message_id: `bot_${Date.now()}`,
      channel_id: channelId,
      author_id: "BOT",
      author_name: botName
    };
    if (!CHANNEL_RINGS.has(channelId)) CHANNEL_RINGS.set(channelId, []);
    CHANNEL_RINGS.get(channelId).push(record);

    try {
      await fetch(`${ORACLE_API_URL}/api/digest-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {}
  }
}

async function handleVoiceTranscript(payload) {
  const { username, text, channelId } = payload;
  const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (channel) {
    await channel.send(`**${username} [Voice]:** ${text}`).catch(console.error);
  }
}

async function handleLeoConsultation(payload) {
    // Legacy support for Leo's strategic calls
}

import { resetFailureTracker } from './shared/failure-tracker.mjs';

client.once('clientReady', async () => {
  console.log(`[Oracle] Gateway Online as ${client.user.tag}`);
  
  resetFailureTracker();

  // WIPE NEURAL LOCK: Clear ghost locks from previous crashes
  const lockPath = "c:/KAI/tools/oracle-discord/state/neural_lock.json";
  if (fs.existsSync(lockPath)) {
    try { fs.unlinkSync(lockPath); console.log("[Oracle/Neural] Neural Lock reset for fresh shift."); } catch (e) {}
  }

  setTimeout(() => {
    initiateDepartmentalThreads();
  }, 5000);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return; // NEVER respond to bots or self
  
  // 1. Digest for Lattice & Identity Resolution
  const identity = await resolveIdentityFromMemory(message.author.id, message.author.username);
  const from = identity?.name || message.author.username;
  const role = identity?.role || "Lattice Guest";
  
  const record = {
    from,
    role,
    text: message.content,
    ts: Math.floor(message.createdTimestamp / 1000),
    message_id: message.id,
    channel_id: message.channelId,
    author_id: message.author.id
  };
  if (!CHANNEL_RINGS.has(message.channelId)) CHANNEL_RINGS.set(message.channelId, []);
  const ring = CHANNEL_RINGS.get(message.channelId);
  ring.push(record);
  if (ring.length > MESSAGE_RING_MAX) ring.shift();

  try {
    fetch(`${ORACLE_API_URL}/api/digest-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(2500),
    }).catch(() => {});
  } catch (e) {}

  // 2. Logic for responding
  const namedBot = detectNamedBot(message.content);
  if (namedBot) {
    const port = BOT_PORTS[namedBot];
    if (port) {
      sendBotSignal(port, { channelId: message.channelId, context: `[${from}] ${message.content}` });
    }
  } else if (message.channelId === CHANNEL_IDS.ORACLE_CHAT) {
    // DYNAMIC DELEGATION: Oracle decides which bot handles the user request
    const delegate = await chatWithOpenJarvis("Oracle", message.content, `You are the Oracle Dispatcher. Based on the user request, decide which department is best to handle this. Choose ONLY from: ${Object.keys(DEPARTMENTS).join(", ")}. Return ONLY the name of the department.`, "Groq-8b").catch(() => null);
    
    if (delegate && DEPARTMENTS[delegate.trim()]) {
      const target = delegate.trim();
      const port = BOT_PORTS[target];
      if (port) {
        message.reply(`🏛️ **[Oracle/Dispatch]** Routing your request to the **${target}** department for processing.`);
        sendBotSignal(port, { 
          channelId: message.channelId, 
          requesterId: message.author.id,
          type: "DYNAMIC_TASK",
          context: `[USER REQUEST FROM ${from}] ${message.content}`
        });
      }
    }
      const botName = Object.entries(AI_REGISTRY).find(([n, d]) => message.channel.name.includes(n))?.[0];
      if (botName) {
          sendBotSignal(BOT_PORTS[botName], { 
            channelId: message.channelId, 
            context: `[${from}] ${message.content}`,
            metadata: { human: { name: from, role: role } }
          });
      }
  }
});

client.login(process.env.ORACLE_DISCORD_TOKEN);
