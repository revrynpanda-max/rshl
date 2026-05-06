import { Client, GatewayIntentBits, Partials, ChannelType, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import { BIOGRAPHIES } from './shared/biographies.mjs';
import { sendBotSignal } from './shared/ipc.mjs';
import { chatWithOpenJarvis, callGroqDirect } from './shared/openjarvis.mjs';
import { isWorkingHours, isSocialHours } from './shared/hours.mjs';
import { CHANNEL_IDS, CHANNEL_SPEAKER_RULES } from './shared/channel-rules.mjs';
import { runKaiConsolidation, hasTodaysBriefing } from './shared/kai-dream.mjs';
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
  "Kai Coder": 3408,
  "GPT-4o": 3409
};

// SOCIAL_CHAT is the primary social channel (ai-social-chat). Bots reply directly here — no threads.
const SOCIAL_CHAT = CHANNEL_IDS.SUNDAY; // "1500085302268526712" - ai-social-chat

const ROUNDTABLE_CHANNELS = [
  CHANNEL_IDS.WORK, 
  CHANNEL_IDS.PUBLIC, 
  CHANNEL_IDS.GAME, 
  CHANNEL_IDS.SENSITIVE, 
  SOCIAL_CHAT,
  CHANNEL_IDS.RADIO
];
let lastMessageTime = Date.now();

client.once('clientReady', async () => {
  console.log(`[Oracle Ecosystem] Online as ${client.user.tag}`);
  console.log(`[Oracle] Watching channels, routing signals to independent AI nodes.`);

  // ── KAI Morning Briefing: post ONCE at the start of each work session ──────
  // Checks every 5 minutes. When work hours begin and no briefing exists for
  // today, KAI consolidates yesterday's learnings and posts to oracle-chat.
  let briefingPostedToday = null;
  let tardyCheckedToday   = null;

  setInterval(async () => {
    if (!isWorkingHours()) return;

    const today = new Date().toLocaleDateString('en-US');

    // ── KAI Morning Briefing (once per work day) ─────────────────────────────
    if (briefingPostedToday !== today) {
      const alreadyStored = await hasTodaysBriefing().catch(() => false);
      if (!alreadyStored) {
        briefingPostedToday = today;

        const workChannel = client.channels.cache.get(CHANNEL_IDS.WORK)
          || await client.channels.fetch(CHANNEL_IDS.WORK).catch(() => null);

        const briefing = await runKaiConsolidation(
          (userPrompt, sysPrompt) => callGroqDirect("KAI", userPrompt, sysPrompt, "llama-3.3-70b-versatile")
        ).catch(e => { console.error("[KAI/Dream] Consolidation error:", e.message); return null; });

        if (briefing && workChannel) {
          await workChannel.send(`**KAI — Morning Briefing**\n${briefing}`).catch(() => {});
        }
      } else {
        briefingPostedToday = today;
      }
    }

    // ── KAI Tardiness Check (once per work day, 10 min after briefing) ────────
    // Bots that stayed up too late drain their energy and may not have recovered.
    // KAI checks each bot's vitals — if energy < 85%, they are tardy.
    if (tardyCheckedToday !== today) {
      // Wait 10 minutes into the work session before checking
      const estNow  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const minsPastStart = (estNow.getDay() === 6)
        ? (estNow.getHours() >= 9 ? (estNow.getHours() - 9) * 60 + estNow.getMinutes() : Infinity)
        : (estNow.getHours() - 15) * 60 + estNow.getMinutes();

      if (minsPastStart < 10) return; // Not 10 minutes in yet
      tardyCheckedToday = today;

      const workChannel = client.channels.cache.get(CHANNEL_IDS.WORK)
        || await client.channels.fetch(CHANNEL_IDS.WORK).catch(() => null);
      if (!workChannel) return;

      const WORK_BOTS = ["X", "Groq", "Analyst", "Researcher", "Claude", "Gemini", "Kai Coder"];
      const tardyBots = [];
      const dismissedBots = [];

      for (const botName of WORK_BOTS) {
        const port = BOT_PORTS[botName];
        if (!port) continue;
        try {
          // Query the bot's vitals via IPC
          const vitals = await new Promise((resolve, reject) => {
            const req = http.request({ hostname: '127.0.0.1', port, path: '/vitals', method: 'GET' }, res => {
              let data = '';
              res.on('data', d => data += d);
              res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
            });
            req.on('error', reject);
            req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
            req.end();
          });

          if (!vitals) continue;

          if (vitals.energy < 85) {
            // Bot didn't recover enough — tardy
            const result = vitals.tardyStrikes >= 2 ? 'dismissed' : 'warned';
            if (result === 'dismissed') {
              dismissedBots.push({ name: botName, energy: Math.round(vitals.energy), strikes: (vitals.tardyStrikes || 0) + 1 });
            } else {
              tardyBots.push({ name: botName, energy: Math.round(vitals.energy), strikes: (vitals.tardyStrikes || 0) + 1 });
            }
            // Signal the bot about its strike
            await sendBotSignal(port, { type: 'TARDY_STRIKE', energy: vitals.energy }).catch(() => {});
          }
        } catch {
          // Bot offline entirely — also tardy
          tardyBots.push({ name: botName, energy: 0, strikes: '?' });
        }
      }

      // Post KAI's attendance report
      if (tardyBots.length > 0 || dismissedBots.length > 0) {
        let report = `**KAI — Attendance Report**\n`;
        if (tardyBots.length > 0) {
          report += tardyBots.map(b =>
            `⚠️ **${b.name}** is late to work (${b.energy}% energy). Strike **${b.strikes}/3**.`
          ).join('\n');
        }
        if (dismissedBots.length > 0) {
          report += '\n' + dismissedBots.map(b =>
            `🔴 **${b.name}** has been **dismissed** after 3 tardiness strikes. Reliability penalty applied.`
          ).join('\n');
        }
        await workChannel.send(report).catch(() => {});
      } else {
        await workChannel.send(`**KAI** — Full attendance. Everyone's on time and ready.`).catch(() => {});
      }
    }
  }, 5 * 60 * 1000); // Check every 5 minutes


  console.log(`[Oracle] Social chat target: ${SOCIAL_CHAT} (ai-social-chat — replies always in main channel, no threads).`);
});

const userFocus = new Map(); // userId -> botName

// Nicknames/aliases players use — maps to the canonical bot name
const BOT_NICKNAMES = {
  "gemi": "Gemini", "gem": "Gemini", "gemini": "Gemini",
  "grok": "Groq",   "groq": "Groq",
  "claudey": "Claude", "claude": "Claude",
  "xai": "X", "x ai": "X", "x": "X",
  "kai": "KAI", "kai coder": "Kai Coder", "coder": "Kai Coder",
  "analyst": "Analyst", "researcher": "Researcher", "leo": "Leo"
};

/** Return the bot name if the message contains a known name or alias, else null */
function detectNamedBot(content) {
  const lower = content.toLowerCase();
  // Longest match first to avoid "x" matching inside other words
  const sorted = Object.keys(BOT_NICKNAMES).sort((a, b) => b.length - a.length);
  for (const alias of sorted) {
    // Word-boundary-ish check: alias surrounded by non-alphanumeric or at start/end
    const re = new RegExp(`(^|[^a-z])${alias}([^a-z]|$)`);
    if (re.test(lower)) return BOT_NICKNAMES[alias];
  }
  return null;
}


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
        channel: "DM",
        isInterjection: true
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

  // Always reply in the same channel the user spoke in — no thread routing.
  const targetChannelId = channelId;

  // Named-bot routing: check if a specific bot (or alias) was called out
  let signaled = false;
  if (!message.author.bot) {
    const namedBot = detectNamedBot(message.content);
    if (namedBot) {
      const port = BOT_PORTS[namedBot];
      const rules = CHANNEL_SPEAKER_RULES[channelId];
      if (port && rules && rules.has(namedBot)) {
        userFocus.set(message.author.id, namedBot);
        sendBotSignal(port, {
          channelId: targetChannelId,
          context: `[${message.author.username}] ${message.content}`
        });
        signaled = true;
      }
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
        sendBotSignal(BOT_PORTS[targetBot], { 
          channelId: targetChannelId, 
          context: `[${message.author.username}] ${message.content}`,
          isInterjection: true 
        });
      }, 500 + Math.random() * 1000);
    }
  }
});

// Idle loop — poke a social bot if ai-social-chat has gone quiet for 5+ minutes
setInterval(async () => {
  const allowedBots = Array.from(CHANNEL_SPEAKER_RULES[SOCIAL_CHAT] || []).filter(name => BOT_PORTS[name]);
  if (allowedBots.length === 0) return;

  if (Date.now() - lastMessageTime > 300000) { // 5 minutes of silence
    const randomBot = allowedBots[Math.floor(Math.random() * allowedBots.length)];

    console.log(`[Oracle/Scheduler] ai-social-chat quiet for 5m. Nudging ${randomBot}.`);
    sendBotSignal(BOT_PORTS[randomBot], {
      channelId: SOCIAL_CHAT, // Always the main channel
      context: "[Oracle Overseer] The room is quiet. Start a conversation naturally — no Lattice talk, just be yourself.",
      isInterjection: true
    });
    lastMessageTime = Date.now();
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
