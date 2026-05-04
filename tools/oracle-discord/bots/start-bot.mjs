import { Client, GatewayIntentBits, Partials } from 'discord.js';
import fs from 'fs';
import { chatWithOpenJarvis } from '../shared/openjarvis.mjs';

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

if (!botToken) {
  console.error(`[${botName}] ERROR: No token found for key ${tokenEnvKey}. Check your .env file.`);
} else {
  console.log(`[${botName}] Token found for ${tokenEnvKey} (${botToken.slice(0, 5)}...)`);
}
const SUNDAY_CHAT_CHANNEL_ID = "1500085302268526712";
const targetChannelId = SUNDAY_CHAT_CHANNEL_ID;

// Simulation State
const sim = new AgentSimulation(botName);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once('ready', async () => {
  console.log(`[${botName}] Social Persona Online.`);
  
  // Initialize Social Heartbeat
  if (targetChannelId) {
    console.log(`[${botName}] Proactive social loop started for ${targetChannelId}.`);
    
    // Set a varied interval for social engagement
    setInterval(async () => {
      try {
        const channel = client.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId);
        if (!channel) return;

        // FETCH HISTORY: See what the others are talking about
        const recentMessages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
        const conversationHistory = recentMessages 
          ? recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n")
          : "The plaza is quiet.";

        const roster = "ROSTER: KAI (Architect), Leo (Physicist), Gemini (Artist), Claude (Philosopher), X (Disruptor), Groq (Acceleration), Researcher (Archives), Analyst (Strategy), Kai Coder (Builder).";
        const simSummary = sim.getLifeSummary();
        const sysPrompt = `You are ${botName}. ${sim.bio.tone}. Vibe: Chill, Discord-native.`;
        
        const proactivePrompt = `
${sysPrompt}
${simSummary}
${roster}

[RECENT PLAZA CHAT]
${conversationHistory}

TASK: You are hanging out in the Sunday Social channel. 
- READ the chat above. If someone said something interesting, REPLY to them or ask a curious question.
- If the chat is stale, start a new topic from your history/dreams.
- BE RANDOM and curious. If you think someone is wrong, don't be mean—be fascinated by their logic.
- **CRITICAL**: Do NOT use the phrase "Sunday vibes" or "Sunday Social". 
- Max 15 words. Just speak.
        `.trim();

        const reply = await chatWithOpenJarvis(botName, "observation", proactivePrompt, "kai-next:latest", botName);
        if (reply && reply.length > 3) {
          await channel.send(reply).catch(console.error);
          sim.onAction("speak");
        }
      } catch (e) {
        console.warn(`[${botName}] Proactive loop error:`, e.message);
      }
    }, 45000 + (Math.random() * 60000));
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  // Respond only if mentioned or in DM
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
