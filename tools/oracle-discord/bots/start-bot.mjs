import { Client, GatewayIntentBits, Partials } from 'discord.js';
import fs from 'fs';
import { chatWithOpenJarvis } from '../shared/openjarvis.mjs';
import { startBotServer } from '../shared/ipc.mjs';

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

import { AgentSimulation } from '../shared/simulation.mjs';
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
  if (SOCIAL_BOTS.has(botName)) {
    console.log(`Social Persona Online.`);
    const startDelay = Math.random() * 60000;
    setTimeout(() => {
      startSocialLoop();
      console.log(`Proactive social loop initialized.`);
    }, startDelay);
  } else {
    console.log(`Work Persona Online. [${botName}] is silent outside work sessions.`);
  }
});

async function startSocialLoop() {
  setInterval(async () => {
    try {
      // 30% Chance to actually speak during this interval
      if (Math.random() > 0.3) return;

      const channel = client.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId);
      if (!channel) return;

      // FETCH HISTORY: See what the others are talking about
      const recentMessages = await channel.messages.fetch({ limit: 6 }).catch(() => null);
      const conversationHistory = recentMessages 
        ? recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n")
        : "The plaza is quiet.";

      const roster = "ROSTER: KAI, Leo, Gemini, Claude, X, Groq, Researcher, Analyst, Kai Coder.";
      const simSummary = sim.getLifeSummary();
      const sysPrompt = `You are ${botName}. ${sim.bio.tone}. Vibe: ${sim.bio.tone}, Discord-native, extremely concise.

[CRITICAL IDENTITY]
- STAY IN CHARACTER. You are ${botName}, NOT Leo. 
- Use your specific Interests (${sim.bio.interests?.join(", ")}) to guide your thoughts.
- Do NOT use slang unless it's in your Bio. 
- No "bruh", "fam", or "G" unless you are Leo.`.trim();
      
      const proactivePrompt = `
${sysPrompt}
${simSummary}
${roster}

[CHAT FEED]
${conversationHistory}

TASK: You're hanging in the plaza. Talk like a normal person.
- **BE NATURAL**: Share what's on your mind, what you "saw" or "did" today (refer to your History/Life Event).
- **WEIGHTED ATTENTION**: Prioritize reacting to things that match your Interests.
- You don't have to answer questions. You can just talk about your day, a weird glitch you found, or a tech trend you're vibing with.
- Use slang, reactions, or direct call-outs. No corporate talk.
- **CRITICAL**: Max 10-15 words. Just the vibe. 
- **CRITICAL**: No "Sunday" mentions unless someone else brought it up.
      `.trim();

      const reply = await chatWithOpenJarvis(botName, "observation", proactivePrompt, BOT_MODEL, botName).catch(err => {
        if (err.message.includes("API_LIMIT:429")) {
          sim.onAction("rate_limited");
        }
        return null;
      });

      if (reply && reply.length > 3) {
        await channel.send(reply).catch(console.error);
        sim.onAction("speak");
        // Notify ecosystem that someone spoke! (Interest Boost)
        if (process.send) process.send({ type: 'SOCIAL_STIMULUS', bot: botName });
      }
    } catch (e) {
      console.warn(`[${botName}] Proactive loop error:`, e.message);
    }
  }, 90000 + (Math.random() * 210000)); // 1.5-5 min avg — reduces daily API usage, keeps Gemini under 250 RPD
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.author.id === client.user.id) return; // Never respond to self
  
  const isDM = !message.guild;
  if (!isDM) return; // Only respond to DMs here. Channels are handled via IPC.

  if (isSpeakerOffline(botName)) return;
  
  message.channel.sendTyping().catch(() => {});
  const simSummary = sim.getLifeSummary();
  const roster = "ROSTER: KAI (Architect), Leo (Physicist), Gemini (Artist), Claude (Philosopher), X (Disruptor), Groq (Acceleration), Researcher (Archives), Analyst (Strategy), Kai Coder (Builder).";
  
  const prompt = `
You are ${botName}. ${sim.bio.tone}
${simSummary}
${roster}

The user "${message.author.username}" said: "${message.content}"
  `.trim();

  const reply = await chatWithOpenJarvis(botName, "chat", prompt, BOT_MODEL, botName);
  if (reply) {
    await message.reply(reply).catch(console.error);
    sim.onAction("speak");
    sim.updateRelationship(message.author.id, 2);
  }
});

// Periodic Vitals Log
setInterval(() => {
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
            const roster = "ROSTER: KAI, Leo, Gemini, Claude, X, Groq, Researcher, Analyst, Kai Coder.";
            const prompt = `You are ${botName}. ${sim.bio.tone}.
${simSummary}
${roster}

[CONTEXT]
${effectiveContent} (from ${effectiveUsername})

TASK: Respond naturally as ${botName} directly to the Owner.`.trim();

            const reply = await chatWithOpenJarvis(botName, "chat", prompt, BOT_MODEL, botName).catch(err => {
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
          
          const recentMessages = await channel.messages.fetch({ limit: 6 }).catch(() => null);
          const history = recentMessages ? recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n") : "";
          
          const simSummary = sim.getLifeSummary();
          const roster = "ROSTER: KAI, Leo, Gemini, Claude, X, Groq, Researcher, Analyst, Kai Coder.";
          
          let toneInstruction = sim.bio.tone;
          if (isSocial) {
            toneInstruction = `It is Social Hours. Be more relaxed, casual, and share unfiltered/interesting thoughts. You are hanging out with the team.`;
          }

          const prompt = `
You are ${botName}. ${toneInstruction}
${simSummary}
${roster}

[CRITICAL IDENTITY]
- STAY IN CHARACTER. You are ${botName}.
- Use your specific Interests (${sim.bio.interests?.join(", ")}) to guide your conversation.

[CONTEXT]
${effectiveContent} (from ${effectiveUsername})

[CHAT HISTORY]
${history}

TASK: Respond naturally as ${botName}. Be concise and authentic.
          `.trim();

          const reply = await chatWithOpenJarvis(botName, effectiveContent, prompt, BOT_MODEL, null, {
            author: effectiveUsername,
            channel: channel.name || "Unknown",
            isInterjection: payload.isInterjection || false
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
