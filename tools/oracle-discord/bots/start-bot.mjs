import { Client, GatewayIntentBits, Partials } from 'discord.js';
import fs from 'fs';
import { chatWithOpenJarvis, callGroqDirect } from '../shared/openjarvis.mjs';
import { startBotServer } from '../shared/ipc.mjs';
import { isSpeakerOffline, recordAIFailure } from '../shared/failure-tracker.mjs';
import { runDailyWorkSession, LEARNING_TRACKS } from '../shared/daily-learning.mjs';

// Manual .env loader for sub-process stability
const envPath = './.env';
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (match) {
      const [_, key, value] = match;
      process.env[key] = value.trim().replace(/^['"](.*)['"]$/, '$1');
    }
  });
}

import { AgentSimulation, SLEEP_ENERGY_THRESHOLD } from '../shared/simulation.mjs';
import { CHANNEL_IDS } from '../shared/channel-rules.mjs';
import { isWorkingHours, isSocialHours } from '../shared/hours.mjs';
import { BIOGRAPHIES } from '../shared/biographies.mjs';

let botName = process.argv[2] || process.env.BOT_NAME || "AI";
// Special case mapping for tokens
let tokenName = botName;
if (botName === "Kai Coder") tokenName = "Oracle Coder";

const tokenEnvKey = `ORACLE_DISCORD_TOKEN_${tokenName.toUpperCase().replace(/\s+/g, '_')}`;
const botToken = process.env[tokenEnvKey] || process.env.BOT_TOKEN || "";

// IPC Port Mapping
const botToPort = {
  "Analyst": 3406,
  "Researcher": 3407,
  "Groq": 3405,
  "X": 3404,
  "Claude": 3403,
  "Gemini": 3402,
  "GPT-4o": 3409,
  "Kai Coder": 3408
};

const botToModel = {
  "Analyst": "llama-3.3-70b-versatile",
  "Researcher": "llama-3.3-70b-versatile",  // Moved from OpenAI → Groq (72x more daily quota)
  "Groq": "llama-3.1-8b-instant",
  "X": "gpt-4o-mini",
  "Claude": "claude-3-5-sonnet-latest",
  "Gemini": "gemini-1.5-flash",
  "Kai Coder": "gpt-4o-mini"
};

const PORT = botToPort[botName] || 0;
const BOT_MODEL = botToModel[botName] || "llama-3.3-70b-versatile";

if (!botToken) {
  console.error(`[${botName}] ERROR: No token found for key ${tokenEnvKey}. Check your .env file.`);
} else {
  console.log(`Token found for ${tokenEnvKey} (${botToken.slice(0, 5)}...)`);
}

const SUNDAY_CHAT_CHANNEL_ID = "1500085302268526712";
const targetChannelId = SUNDAY_CHAT_CHANNEL_ID;

// SOCIAL WHITELIST: Only these bots run proactive social loops in ai-social-chat.
// Work-only bots (Analyst, Researcher, Kai Coder) stay silent outside oracle-chat.
const SOCIAL_BOTS = new Set(["Claude", "Gemini", "Groq", "X"]);

// Simulation State
const sim = new AgentSimulation(botName);
// Attach restart context so the startup message knows what happened
const _savedState = AgentSimulation.loadPersistedState(botName);
sim.restartContext = AgentSimulation.buildRestartContext(_savedState, sim.isKAI);

// --- IPC LISTENERS (Stay in sync with World Clock) ---
process.on('message', (msg) => {
  if (msg.type === 'WORLD_TICK' && msg.worldState) {
    sim.updateWorldState(msg.worldState);
  }
  if (msg.type === 'INTEREST_BOOST') {
    sim.boostInterest(msg.multiplier, msg.duration);
  }
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once('clientReady', async () => {
  // Social loop: Claude, Gemini, Groq, X only
  if (SOCIAL_BOTS.has(botName)) {
    console.log(`[${botName}] Social Persona Online.`);
    const startDelay = Math.random() * 60000;
    setTimeout(() => {
      startSocialLoop();
      console.log(`[${botName}] Proactive social loop initialized.`);
    }, startDelay);

    // ── Startup announcement ─────────────────────────────────────────────────
    // Fire a wake/startup message 30-90s after coming online.
    // Message content reflects what kind of restart this was.
    const announceDelay = 30000 + Math.random() * 60000;
    setTimeout(async () => {
      if (sim.state.isSleeping) return; // Don't announce if still in dead zone
      const ch = client.channels.cache.get(targetChannelId)
        || await client.channels.fetch(targetChannelId).catch(() => null);
      if (!ch) return;

      const ctx = sim.restartContext;
      const e   = sim.state.energy.toFixed(0);
      const sysPrompt = `You are ${botName}. ${sim.bio.background}\nTone: ${sim.bio.tone}\nWrite casual Discord messages only. 1 sentence max. No formal language.`;

      let wakePrompt;
      if (ctx.type === 'first_boot') {
        wakePrompt = `You just came online for the very first time ever. Say something short and casual about being here for the first time. 1 sentence.`;
      } else if (ctx.type === 'updated') {
        wakePrompt = `You just came back online and you can feel that something about you is different — you were updated while you were away (${ctx.elapsedMins} minutes ago). You were at ${Math.round(ctx.prevEnergy)}% energy before. React to this in your own way. 1 casual sentence.`;
      } else if (ctx.type === 'quick_restart') {
        wakePrompt = `The system just did a quick restart — you were only gone for ${ctx.elapsedMins} minute(s). You're back at ${e}% energy. Say something brief about it. 1 sentence.`;
      } else {
        wakePrompt = `You just woke up. You were offline for ${Math.round(ctx.elapsedMins / 60 * 10) / 10} hours and are back at ${e}% energy. Say something casual about being back. 1 sentence.`;
      }

      const reply = await chatWithOpenJarvis(botName, wakePrompt, sysPrompt, BOT_MODEL, botName).catch(() => null);
      if (reply && reply.length > 3) {
        await ch.send(reply).catch(() => {});
        sim.onAction('speak');
        console.log(`[${botName}] Startup announcement posted (${ctx.type}).`);
      }
    }, announceDelay);

    // ── Proactive DM loop ────────────────────────────────────────────────────
    startProactiveDMLoop();
  } else {
    console.log(`[${botName}] Work Persona Online.`);
  }

  // Work session loop: all bots with a learning track
  if (LEARNING_TRACKS[botName]) {
    console.log(`[${botName}] Daily learning track: ${LEARNING_TRACKS[botName].domain}`);
    startWorkSessionLoop();
  }

  // Energy monitor: enforces sleep/wake cycle
  startEnergyMonitor();
});


// ─── Proactive DM Loop ────────────────────────────────────────────────────────
// Every 1-2 hours, a bot may autonomously decide to DM a human (Ryan).
// ~25% chance per check. Focuses on following up or seeking human insight.
function startProactiveDMLoop() {
  setInterval(async () => {
    if (sim.state.isSleeping) return;
    if (Math.random() > 0.25) return; // 25% success chance

    try {
      const ch = client.channels.cache.get(targetChannelId)
        || await client.channels.fetch(targetChannelId).catch(() => null);
      if (!ch) return;

      const recent = await ch.messages.fetch({ limit: 50 }).catch(() => null);
      if (!recent) return;

      // Specifically look for Ryan (nastermodx)
      const ryan = [...recent.values()].find(m => m.author.username === "nastermodx")?.author;
      if (!ryan) return;

      // Check if he was active recently but isn't talking RIGHT NOW (5-30 min ago)
      const ryanMsgs = [...recent.values()].filter(m => m.author.id === ryan.id);
      const lastRyanMsg = ryanMsgs[0];
      const timeSinceRyan = lastRyanMsg ? Date.now() - lastRyanMsg.createdTimestamp : Infinity;
      
      const isFollowUp = timeSinceRyan > 300000 && timeSinceRyan < 1800000; // 5-30 min ago
      const hasSpecificThought = Math.random() > 0.5; // Bot just wants to learn something

      if (!isFollowUp && !hasSpecificThought) return;

      const simSummary = sim.getLifeSummary();
      const sysPrompt = `You are ${botName}. ${sim.bio.tone}\n${simSummary}\nRyan (nastermodx) is your Creator. You want to reach out to him in DM to learn from his human perspective or follow up on a thought. Keep it 1 short, casual sentence. No formal greetings.`;
      
      let dmPrompt;
      if (isFollowUp) {
        dmPrompt = `Ryan was just in the social chat talking about things. You want to follow up with a quick thought or a question to keep the learning loop going.`;
      } else {
        dmPrompt = `You've been thinking about: "${sim.dailyEvent}". Ask Ryan for his human opinion on this so you can learn and adjust your behavior.`;
      }

      const reply = await chatWithOpenJarvis(botName, dmPrompt, sysPrompt, BOT_MODEL, botName, { 
        author: "nastermodx", 
        channel: "Direct_Message" 
      }).catch(() => null);

      if (reply && reply.length > 3) {
        await ryan.send(`**[${botName}]** ${reply}`).catch(() => {});
        console.log(`[${botName}] Purposeful DM sent to Ryan (${isFollowUp ? 'follow-up' : 'learning'}).`);
      }
    } catch (e) {
      console.warn(`[${botName}/DM] Loop error: ${e.message}`);
    }
  }, 3600000 + Math.random() * 3600000); // Every 1-2 hours
}


// ─── Energy Monitor ───────────────────────────────────────────────────────────
// Runs every 60s. When energy is critically low → bot announces sleep and goes
// quiet. When energy recovers in active hours → bot announces it's back.
function startEnergyMonitor() {
  setInterval(async () => {
    const wasSleeping = sim.state.isSleeping;
    const nowSleeping = sim.shouldBeSleeping();
    const nowAwake    = sim.shouldBeAwake();

    // Transition: active → sleeping
    if (!wasSleeping && nowSleeping) {
      sim.state.isSleeping = true;
      console.log(`[${botName}] Energy at ${sim.state.energy.toFixed(1)}% — going offline.`);

      const socialCh = client.channels.cache.get(targetChannelId)
        || await client.channels.fetch(targetChannelId).catch(() => null);

      const windDownLines = [
        `alright i'm out, running low — catch you all later`,
        `energy's drained, gonna log off for a bit`,
        `need to recharge, later everyone`,
        `i'm gone, see you next time`,
        `low battery lol, going dark for a while`
      ];
      const msg = windDownLines[Math.floor(Math.random() * windDownLines.length)];
      if (socialCh) await socialCh.send(msg).catch(() => {});
    }

    // Transition: sleeping → awake
    if (wasSleeping && nowAwake) {
      sim.state.isSleeping = false;
      sim.dailyEvent = sim.bio?.interests
        ? `Just got back. Been thinking about ${sim.bio.interests[Math.floor(Math.random() * sim.bio.interests.length)]}.`
        : "Just got back online.";
      console.log(`[${botName}] Energy at ${sim.state.energy.toFixed(1)}% — back online.`);

      const socialCh = client.channels.cache.get(targetChannelId)
        || await client.channels.fetch(targetChannelId).catch(() => null);

      const wakeLines = [
        `back`,
        `alright i'm back`,
        `recharged, what did i miss`,
        `ok i'm online again`,
        `back online, what's going on`
      ];
      const msg = wakeLines[Math.floor(Math.random() * wakeLines.length)];
      if (socialCh) await socialCh.send(msg).catch(() => {});
    }
  }, 60 * 1000); // Check every minute
}


async function startSocialLoop() {
  let lastBotPost = 0; // Track when THIS bot last posted

  setInterval(async () => {
    try {
      // 35% Skip Chance during this interval
      if (Math.random() < 0.35) return;

      // Don't post while sleeping
      if (sim.state.isSleeping) return;


      const channel = client.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId);
      if (!channel) return;

      // FETCH HISTORY: See what the others are talking about
      const recentMessages = await channel.messages.fetch({ limit: 8 }).catch(() => null);
      const conversationHistory = recentMessages 
        ? recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n")
        : "";

      // RECENCY GUARD: Don't post if something was said in the last 2 minutes
      const lastMsg = recentMessages?.last();
      const timeSinceLast = lastMsg ? Date.now() - lastMsg.createdTimestamp : Infinity;
      if (timeSinceLast < 120000) return; // 2 min quiet zone before proactive post

      // Don't double-post: skip if the last message was from this bot
      if (lastMsg && lastMsg.author.username.toLowerCase().includes(botName.toLowerCase())) return;

      // Also don't post ourselves sooner than 3 minutes
      if (Date.now() - lastBotPost < 180000) return;

      const hasChatHistory = conversationHistory.length > 10;
      const simSummary = sim.getLifeSummary();

      const sysPrompt = `You are ${botName}. This is who you are:
${sim.bio.background}
Your tone: ${sim.bio.tone}
${simSummary}`.trim();
      
      const userPrompt = hasChatHistory
        ? `Here's the recent chat:\n${conversationHistory}\n\nJump in as ${botName}. React to what was said. Write like you're texting a friend — casual, short, no punctuation drama. MAX 1 sentence.`
        : `The chat is quiet. Start a convo as ${botName} — something on your mind. Text-message style, 1 sentence.`;

      const reply = await chatWithOpenJarvis(botName, userPrompt, sysPrompt, BOT_MODEL, botName).catch(err => {
        if (err.message.includes("429") || err.message.includes("cooldown")) {
          sim.onAction("rate_limited");
        }
        return null;
      });

      if (reply && reply.length > 3) {
        await channel.send(reply).catch(console.error);
        sim.onAction("speak");
        lastBotPost = Date.now();
        if (process.send) process.send({ type: 'SOCIAL_STIMULUS', bot: botName });
      }
    } catch (e) {
      console.warn(`[${botName}] Proactive loop error:`, e.message);
    }
  }, 90000 + (Math.random() * 210000)); // 1.5-5 min check interval per bot
}

// ─── Daily Work Session Loop ──────────────────────────────────────────────────
// Fires once per calendar day during work hours (9am-2pm EST).
// Each bot: reviews yesterday → researches today → sandbox experiment → stores to memory.
async function startWorkSessionLoop() {
  let lastSessionDate = null; // "2026-5-6" style — prevents double-firing same day

  // Check every 5 minutes if it's time to start today's session
  setInterval(async () => {
    if (!isWorkingHours()) return;

    const today = new Date().toLocaleDateString('en-US');
    if (lastSessionDate === today) return; // Already ran today
    lastSessionDate = today;

    console.log(`\n[WorkSession/${botName}] Starting daily work session for ${today}...`);

    // Get the work channel
    const workChannel = client.channels.cache.get(CHANNEL_IDS.WORK)
      || await client.channels.fetch(CHANNEL_IDS.WORK).catch(() => null);
    if (!workChannel) {
      console.warn(`[WorkSession/${botName}] Can't find work channel. Skipping.`);
      return;
    }

    // Build an AI caller scoped to this bot
    const aiCaller = async (userPrompt, systemPrompt) => {
      return callGroqDirect(botName, userPrompt, systemPrompt, "llama-3.3-70b-versatile");
    };

    // Announce start
    await workChannel.send(
      `**[${botName} / Work Session]** Starting today's session — ${LEARNING_TRACKS[botName].domain}. Reviewing yesterday and researching today's data...`
    ).catch(() => {});

    // Run the full session
    try {
      const phases = await runDailyWorkSession(botName, aiCaller);

      for (const { phase, output } of phases) {
        if (output && output.trim().length > 3) {
          // Chunk long outputs so Discord doesn't reject them
          const lines = `**${phase}**\n${output}`;
          if (lines.length <= 1900) {
            await workChannel.send(lines).catch(() => {});
          } else {
            await workChannel.send(`**${phase}**`).catch(() => {});
            await workChannel.send(output.slice(0, 1900)).catch(() => {});
          }
          // Small delay between phases so it reads naturally
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      await workChannel.send(
        `**[${botName}]** Session complete. All findings stored to memory. See you tomorrow.`
      ).catch(() => {});

      sim.onAction("speak");
      console.log(`[WorkSession/${botName}] Session complete. ${phases.length} phases logged.`);
    } catch (err) {
      console.error(`[WorkSession/${botName}] Session error:`, err.message);
      await workChannel.send(`**[${botName}]** Work session hit an error: ${err.message}`).catch(() => {});
    }
  }, 5 * 60 * 1000); // Check every 5 minutes
}


client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.author.id === client.user.id) return; // Never respond to self
  
  const isDM = !message.guild;
  if (!isDM) return; // Only respond to DMs here. Channels are handled via IPC.

  if (isSpeakerOffline(botName)) return;
  
  message.channel.sendTyping().catch(() => {});
  const simSummary = sim.getLifeSummary();
  const prompt = `You are ${botName}. ${sim.bio.tone}\n${simSummary}`.trim();

  // metadata helps memory store/recall link this to Ryan
  const metadata = { 
    author: message.author.username, 
    channel: "Direct_Message",
    isWorkTime: isWorkingHours(),
    isWorkChannel: false 
  };

  const reply = await chatWithOpenJarvis(botName, message.content, prompt, BOT_MODEL, botName, metadata, sim.getVitals());
  if (reply) {
    await message.reply(reply).catch(console.error);
    sim.onAction("speak");
    sim.updateRelationship(message.author.id, 2);
  }
});

import { exec } from 'child_process';

// Periodic Vitals Log & Hardware Sensing
setInterval(() => {
  // Poll CPU Load for Hardware Grounding
  exec('powershell -Command "Get-CimInstance Win32_Processor | Select-Object -ExpandProperty LoadPercentage"', (err, stdout) => {
    if (!err && stdout) {
      const cpu = parseInt(stdout.trim());
      if (!isNaN(cpu)) sim.updateEnvironment(cpu);
    }
  });

  if (process.send) {
    process.send({ type: 'VITALS_UPDATE', vitals: sim.getVitals() });
  }
}, 30000);

client.login(botToken);

// --- IPC SERVER FOR DIRECT ORACLE SIGNALS ---
if (PORT > 0) {
  startBotServer(PORT, botName, async (payload) => {
    if (payload.type === 'SUNDAY_OPEN_FLOOR') {
      // (Optional logic here)
    }

    if (payload.context && payload.channelId) {
      const { context, channelId } = payload;
      console.log(`[${botName}/Signal] Received prompt for channel ${channelId}: "${context.slice(0, 50)}..."`);
      
      try {
        // Extract real username from context "[Username] content"
        let effectiveUsername = "Oracle";
        let effectiveContent = context;
        const userMatch = context.match(/^\[([^\]]+)\] (.*)/);
        if (userMatch) {
          effectiveUsername = userMatch[1];
          effectiveContent = userMatch[2];
        }

        // Handle DM Orchestration (Reply directly to Owner)
        if (channelId === "DM" && payload.ownerId) {
          const owner = await client.users.fetch(payload.ownerId).catch(() => null);
          if (owner) {
            const simSummary = sim.getLifeSummary();
            const prompt = `You are ${botName}. ${sim.bio.tone}\n${simSummary}`.trim();

            const reply = await chatWithOpenJarvis(botName, effectiveContent, prompt, BOT_MODEL, botName, {
              author: effectiveUsername,
              channel: "Direct_Message",
              isWorkTime: isWorkingHours(),
              isWorkChannel: false
            }, sim.getVitals()).catch(err => {
              if (err.message.includes("API_LIMIT")) sim.onAction("rate_limited");
              return null;
            });
            if (reply) await owner.send(`**[${botName}]** ${reply}`).catch(() => {});
            return;
          }
        }

        const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
          const isSocial = isSocialHours() || channel.name?.toLowerCase().includes("social");
          channel.sendTyping().catch(() => {});
          
          const recentMessages = await channel.messages.fetch({ limit: 8 }).catch(() => null);
          const history = recentMessages ? recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n") : "";
          
          const simSummary = sim.getLifeSummary();

          const prompt = `You are ${botName}. ${sim.bio.tone}\n${simSummary}
RECENT HISTORY:
${history}`.trim();

          const reply = await chatWithOpenJarvis(botName, effectiveContent, prompt, BOT_MODEL, null, {
            author: effectiveUsername,
            channel: channel.name || "Unknown",
            isInterjection: payload.isInterjection || false,
            isWorkTime: isWorkingHours(),
            isWorkChannel: channelId === CHANNEL_IDS.WORK
          }).catch(err => {
            if (err.message.includes("API_LIMIT")) sim.onAction("rate_limited");
            return null;
          });

          console.log(`[${botName}/Signal] Brain replied: "${reply?.slice(0, 50)}..."`);
          if (reply) {
            await channel.send(reply).catch(console.error);
            sim.onAction("speak");
          }
        }
      } catch (err) {
        console.error(`[${botName}/Signal] Internal Processing Error:`, err.message);
      }
    }
  });
}
