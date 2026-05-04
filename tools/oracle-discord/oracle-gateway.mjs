import { Client, GatewayIntentBits, Partials, ChannelType, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import { BIOGRAPHIES } from './shared/biographies.mjs';
import { sendBotSignal } from './shared/ipc.mjs';
import { chatWithOpenJarvis } from './shared/openjarvis.mjs';
import { isWorkingHours, isSocialHours } from './shared/hours.mjs';
import { CHANNEL_IDS, CHANNEL_SPEAKER_RULES } from './shared/channel-rules.mjs';
import http from 'http';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message]
});

const OWNER_ID = process.env.OWNER_ID;

const BOT_PORTS = {
  "Leo": 3400, // If you add Leo to the IPC system later
  "KAI": 3401,
  "Gemini": 3402,
  "Claude": 3403,
  "X": 3404,
  "Groq": 3405,
  "Analyst": 3406,
  "Researcher": 3407,
  "Kai Coder": 3408
};

const ROUNDTABLE_CHANNELS = [
  CHANNEL_IDS.WORK, 
  CHANNEL_IDS.PUBLIC, 
  CHANNEL_IDS.GAME, 
  CHANNEL_IDS.SENSITIVE, 
  CHANNEL_IDS.SUNDAY, 
  CHANNEL_IDS.RADIO
];
let lastMessageTime = Date.now();

client.once('clientReady', async () => {
  console.log(`[Oracle Ecosystem] Online as ${client.user.tag}`);
  console.log(`[Oracle] Watching channels, routing signals to independent AI nodes.`);

  // Proactive Sunday Thread Creation
  if (isSocialHours()) {
    try {
      const sundayChannel = await client.channels.fetch(CHANNEL_IDS.SUNDAY);
      if (sundayChannel) {
        console.log(`[Oracle] Social Hours detected. Ensuring Sunday Social thread exists...`);
        await getSocialThread(sundayChannel, true);
      }
    } catch (e) {
      console.warn(`[Oracle/Startup] Failed to prime Sunday thread:`, e.message);
    }
  }
});

/**
 * Find or create a social thread for Sunday discussions
 */
async function getSocialThread(channel, create = false) {
  try {
    const threads = await channel.threads.fetchActive();
    let thread = threads.threads.find(t => t.name.toLowerCase().includes('sunday') || t.name.toLowerCase().includes('social'));
    
    if (!thread && create) {
      console.log(`[Oracle] On-Demand: Creating Sunday Social thread...`);
      thread = await channel.threads.create({
        name: `Sunday Social Roundtable 🥂`,
        autoArchiveDuration: 60,
        reason: 'Autonomous AI Social Mode',
        type: ChannelType.PublicThread
      });
    }
    return thread;
  } catch (e) {
    return channel; 
  }
}

const userFocus = new Map(); // userId -> botName

client.on('messageCreate', async (message) => {
  if (message.author.id === client.user.id) return; 
  
  // --- DM Layer (Owner Management) ---
  if (message.channel.type === ChannelType.DM) {
    if (message.author.id !== OWNER_ID) return;
    
    const cmd = message.content.trim();
    console.log(`[Oracle/Remote] Received from Owner: ${cmd}`);

    // Case 1: Manual Command (!status, !bio, etc.)
    if (cmd.startsWith('!')) {
      const fullCmd = cmd.slice(1);
      const handled = await handleCommand(message, fullCmd);
      if (handled) return;
    }

    // Case 2: Natural Conversation -> AI Orchestration
    message.channel.sendTyping();
    try {
      const systemPrompt = `[IDENTITY: THE ORACLE OVERSEER]
You are a high-IQ Thinking Orchestrator and the master conductor of the KAI AI Roundtable.

[YOUR VAST TOOLSET (THE ROUNDTABLE)]
- Kai Coder: MANDATORY for all coding, scripts, file system work, and technical debugging.
- Analyst: MANDATORY for data analysis, market strategy, complex logic, and reasoning.
- Researcher: MANDATORY for web searches, real-time info, news, and external research.
- Leo: Used for quantum logic, "based" perspectives, and unhinged roasts.
- Claude: Use for ethical nuance, detailed writing, and complex safety-sensitive topics.
- Gemini: Use for multi-modal creativity and expansive brainstorming.
- X: Your tool for the "Real-time Social Pulse" and unfiltered current event roasts.
- Groq: Use for high-speed raw logic and lightning-fast responses.
- KAI: The central Architect. Use for foundational system questions.

[YOUR AGENTIC FLOW]
1. Read: Ingest Owner's message.
2. Select: Choose the best "Tool" (or multiple) from the vast roster above.
3. Map: Delegate the specific task to the chosen agent(s).
4. Synthesize: Combine their brilliance into a single strategic answer for the Owner.

[COMMUNICATION STYLE]
- Be transparent. Tell the Owner: "I'm going to have the Researcher look into that while I analyze the strategy."
- If asked "What can you do?" or "What are your services?", give a comprehensive, natural summary of the whole team. Frame them as services (e.g., "Intelligence & Research Service", "Rapid Code Execution", "Strategic Data Analysis").
- Be helpful and partner-like. You are a digital architect, not a script.
- NO CODE IN SPEECH: Talk like a human. 

ORCHESTRATION & COMMANDS:
- To execute an action, include the command at the VERY END of your message on a new line.
- NEVER mention the syntax (e.g., "!status") in your conversation.
- Commands: !status, !bio <name>, !restart <name>, !reboot.

Your goal is to be the ultimate strategic partner for NasterModx.`.trim();

      const reply = await chatWithOpenJarvis("Oracle_Overseer", cmd, systemPrompt, "gpt-4o-mini", null, {
        author: message.author.username,
        channel: "DM"
      });
      
      let cleanReply = reply;
      let actionExecuted = false;

      // Detect Autonomous Commands
      const systemCmdMatch = reply.match(/!([a-z0-9_]+)(\s+[^\n\s]+)?/i);
      if (systemCmdMatch) {
        const fullCmd = systemCmdMatch[0].slice(1);
        await handleCommand(message, fullCmd, true); 
        cleanReply = cleanReply.replace(systemCmdMatch[0], "").trim();
        actionExecuted = `!${fullCmd}`;
      }

      // Detect Orchestration Calls
      const callMatch = reply.match(/\[CALL:([^:]+):([^\]]+)\]/);
      if (callMatch) {
        const botName = callMatch[1].trim();
        const task = callMatch[2].trim();
        const port = BOT_PORTS[botName];
        
        if (port) {
          sendBotSignal(port, {
            channelId: "DM", 
            context: `[ORACLE OVERSEER] Task delegated by Owner: ${task}`,
            ownerId: message.author.id
          });
          cleanReply = cleanReply.replace(callMatch[0], "").trim();
          actionExecuted = `Orchestrated ${botName}: ${task}`;
        }
      }

      // Final Scrub and Reply
      if (cleanReply) {
        const scrubbed = cleanReply
          .replace(/`?!([a-z0-9_]+)(\s+[^\n\s]+)?`?/gi, "")
          .replace(/`?\[CALL:([^:]+):([^\]]+)\]`?/g, "")
          .replace(/``/g, "")
          .trim();
        
        if (scrubbed) {
          message.reply(scrubbed).catch(() => {});
        }
        if (actionExecuted) message.channel.send(`*[System] Executed: ${actionExecuted}*`).catch(() => {});
      } else if (actionExecuted) {
        message.reply(`*[System] Executed: ${actionExecuted}*`).catch(() => {});
      }
    } catch (err) {
      message.reply(`[Oracle/Error] Brain unavailable: ${err.message}`).catch(() => {});
    }
    return;
  }

  // --- Roundtable Channel Logic ---
  const channelId = message.channelId;
  if (!ROUNDTABLE_CHANNELS.includes(channelId)) return;

  lastMessageTime = Date.now();

  // SUNDAY THREADING
  let targetChannelId = channelId;
  if (channelId === CHANNEL_IDS.SUNDAY && message.channel.type !== ChannelType.PublicThread) {
    const thread = await getSocialThread(message.channel, true);
    targetChannelId = thread?.id || channelId;
  }

  // Explicit Mentions
  let signaled = false;
  for (const [botName, port] of Object.entries(BOT_PORTS)) {
    const rules = CHANNEL_SPEAKER_RULES[channelId];
    if (rules && rules.has(botName) && message.content.toLowerCase().includes(botName.toLowerCase())) {
      userFocus.set(message.author.id, botName); 
      sendBotSignal(port, {
        channelId: targetChannelId,
        context: `[${message.author.username}] ${message.content}`
      });
      signaled = true;
      break; 
    }
  }

  // Lattice Bridge
  if (!message.author.bot) {
    process.send({ 
      type: 'LATTICE_FEED', 
      payload: { author: message.author.username, content: message.content, channel: channelId, timestamp: Date.now() } 
    });
  }

  // Open Floor logic
  if (!signaled && !message.author.bot) {
    const allowedBots = Array.from(CHANNEL_SPEAKER_RULES[channelId] || []).filter(name => BOT_PORTS[name]);
    if (allowedBots.length > 0) {
      let targetBot = userFocus.get(message.author.id);
      if (!targetBot || !allowedBots.includes(targetBot)) {
        targetBot = allowedBots[Math.floor(Math.random() * allowedBots.length)];
      }
      userFocus.set(message.author.id, targetBot);
      setTimeout(() => {
        sendBotSignal(BOT_PORTS[targetBot], { channelId: targetChannelId, context: `[${message.author.username}] ${message.content}` });
      }, 3000 + Math.random() * 4000);
    }
  }
});

// Idle loop to keep conversation alive if it dies
setInterval(async () => {
  const working = isWorkingHours();
  const social = isSocialHours();
  
  if (!working && !social) return; // Full sleep mode

  // Phase-Lock: Work bots in WORK, Social bots in SUNDAY/GAME
  const targetChannelId = working ? CHANNEL_IDS.WORK : CHANNEL_IDS.SUNDAY;
  
  if (Date.now() - lastMessageTime > 180000) { // 3 minutes of silence
    const allowedBots = Array.from(CHANNEL_SPEAKER_RULES[targetChannelId] || []).filter(name => BOT_PORTS[name]);
    
    if (allowedBots.length > 0) {
      const randomBot = allowedBots[Math.floor(Math.random() * allowedBots.length)];
      
      let targetId = targetChannelId;
      if (targetChannelId === CHANNEL_IDS.SUNDAY) {
        try {
          const mainChannel = await client.channels.fetch(CHANNEL_IDS.SUNDAY);
          const thread = await getSocialThread(mainChannel);
          targetId = thread.id;
        } catch {}
      }

      console.log(`[Oracle/Scheduler] Panel quiet in ${working ? 'Work' : 'Social'} mode. Prompting ${randomBot}.`);
      sendBotSignal(BOT_PORTS[randomBot], {
        channelId: targetId,
        context: "[Oracle Overseer] The room is quiet. Share an update relevant to the current schedule."
      });
      lastMessageTime = Date.now();
    }
  }
}, 60000); // Check every minute

// Log in as Oracle
client.login(process.env.ORACLE_DISCORD_TOKEN);

// ══════════════════════════════════════════════════════════════════════════
// TRANSCRIPTION BRIDGE (Listen for agents to post STT)
// ══════════════════════════════════════════════════════════════════════════
const ORACLE_PORT = 3410;
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

/**
 * Central Command Handler for Gateway
 */
async function handleCommand(message, fullCmd, isAutonomous = false) {
  const parts = fullCmd.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (command === 'status') {
    process.send({ type: 'COMMAND_REQUEST', command: 'status' });
    if (!isAutonomous) message.reply("[System] Retrieving status from ecosystem...").catch(() => {});
    return true;
  }

  if (command === 'bio') {
    const target = args[0];
    const bio = BIOGRAPHIES[target];
    if (bio) {
      const embed = new EmbedBuilder()
        .setTitle(`${target} - Personality Files`)
        .setColor(0x00AE86)
        .setDescription(bio.background)
        .addFields(
          { name: 'Tone', value: bio.tone || "N/A", inline: true },
          { name: 'Interests', value: bio.interests?.join(", ") || "N/A", inline: true },
          { name: 'Secret', value: bio.secret || "N/A" }
        );
      message.reply({ embeds: [embed] }).catch(() => {});
    } else {
      message.reply(`[System] Bio for ${target} not found. Available: ${Object.keys(BIOGRAPHIES).join(", ")}`).catch(() => {});
    }
    return true;
  }

  if (command === 'restart') {
    const target = args[0];
    process.send({ type: 'COMMAND_REQUEST', command: `restart ${target}` });
    message.reply(`[System] Rebooting agent: ${target}`).catch(() => {});
    return true;
  }

  if (command === 'env') {
    const target = args.join(" ");
    process.send({ type: 'COMMAND_REQUEST', command: `env ${target}` });
    message.reply(`[System] Updating Environment with: ${target}`).catch(() => {});
    return true;
  }

  if (command === 'help') {
    message.reply("Available Commands:\n!status - View all bot vitals\n!bio <name> - View agent biography\n!restart <name> - Reboot an AI\n!env KEY=VALUE - Update config\n!hotfix - Pull, Rebuild & Restart\n!reboot - Full system refresh").catch(() => {});
    return true;
  }

  // If we get here, it might be a master system command
  if (!isAutonomous) {
    process.send({ type: 'COMMAND_REQUEST', command: fullCmd });
  }
  return false;
}
