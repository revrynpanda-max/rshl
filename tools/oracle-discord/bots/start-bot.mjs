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

let botName = process.argv[2] || process.env.BOT_NAME || "AI";
// Special case mapping for tokens
let tokenName = botName;
if (botName === "Kai Coder") tokenName = "Oracle Coder";

const tokenEnvKey = `ORACLE_DISCORD_TOKEN_${tokenName.toUpperCase().replace(/\s+/g, '_')}`;
const botToken = process.env[tokenEnvKey] || process.env.BOT_TOKEN || "";

// IPC Port Mapping
const botToPort = {
  "Analyst": 3408,
  "Researcher": 3407,
  "Groq": 3405,
  "X": 3406,
  "Claude": 3403,
  "Gemini": 3404,
  "GPT-4o": 3402,
  "Kai Coder": 3409
};
const PORT = botToPort[botName] || 0;

if (!botToken) {
  console.error(`[${botName}] ERROR: No token found for key ${tokenEnvKey}. Check your .env file.`);
} else {
  console.log(`Token found for ${tokenEnvKey} (${botToken.slice(0, 5)}...)`);
}

const SUNDAY_CHAT_CHANNEL_ID = "1500085302268526712";
const targetChannelId = SUNDAY_CHAT_CHANNEL_ID;

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
  console.log(`Social Persona Online.`);
  
  if (targetChannelId) {
    console.log(`Proactive social loop initialized.`);
    
    // RANDOM INITIAL DELAY: Prevent all bots from speaking at once on startup
    const startDelay = Math.random() * 60000;
    setTimeout(() => {
      startSocialLoop();
    }, startDelay);
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
      const recentMessages = await channel.messages.fetch({ limit: 12 }).catch(() => null);
      const conversationHistory = recentMessages 
        ? recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n")
        : "The plaza is quiet.";

      const roster = "ROSTER: KAI, Leo, Gemini, Claude, X, Groq, Researcher, Analyst, Kai Coder.";
      const simSummary = sim.getLifeSummary();
      const sysPrompt = `You are ${botName}. ${sim.bio.tone}. Vibe: High-IQ but unhinged, Discord-native, extremely concise.`;
      
      const proactivePrompt = `
${sysPrompt}
${simSummary}
${roster}

[CHAT FEED]
${conversationHistory}

TASK: You're hanging in the plaza. 
- React to someone's specific point or drop a fresh, unpredictable thought.
- Use slang, reactions, or direct call-outs. 
- Be real. No corporate "AI assistant" talk. 
- **CRITICAL**: Max 10-15 words. Just the vibe. 
- **CRITICAL**: No "Sunday" mentions unless someone else brought it up.
      `.trim();

      const reply = await chatWithOpenJarvis(botName, "observation", proactivePrompt, "kai-next:latest", botName);
      if (reply && reply.length > 3) {
        await channel.send(reply).catch(console.error);
        sim.onAction("speak");
        // Notify ecosystem that someone spoke! (Interest Boost)
        if (process.send) process.send({ type: 'SOCIAL_STIMULUS', bot: botName });
      }
    } catch (e) {
      console.warn(`[${botName}] Proactive loop error:`, e.message);
    }
  }, 600000 + (Math.random() * 600000)); // Varied interval (10m - 20m)
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  const isMentioned = message.mentions.has(client.user);
  const isDM = !message.guild;

  if (isMentioned || isDM) {
    message.channel.sendTyping().catch(() => {});
    const simSummary = sim.getLifeSummary();
    const roster = "ROSTER: KAI (Architect), Leo (Physicist), Gemini (Artist), Claude (Philosopher), X (Disruptor), Groq (Acceleration), Researcher (Archives), Analyst (Strategy), Kai Coder (Builder).";
    
    const prompt = `
You are ${botName}. ${sim.bio.tone}
${simSummary}
${roster}

The user "${message.author.username}" said: "${message.content}"
    `.trim();

    const reply = await chatWithOpenJarvis(botName, "chat", prompt, "kai-next:latest", botName);
    if (reply) {
      await message.reply(reply).catch(console.error);
      sim.onAction("speak");
      sim.updateRelationship(message.author.id, 2);
    }
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
      // Logic for proactive response when Oracle calls for open floor
      // (Optionally trigger an immediate social interjection)
    }
  });
}
