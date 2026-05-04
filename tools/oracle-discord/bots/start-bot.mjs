import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { chatWithOpenJarvis } from '../shared/openjarvis.mjs';
import { AgentSimulation } from '../shared/simulation.mjs';
import { CHANNEL_IDS } from '../shared/channel-rules.mjs';

const botName = process.env.BOT_NAME || "AI";
const botToken = process.env.BOT_TOKEN || "";
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
