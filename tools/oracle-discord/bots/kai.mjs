import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { isAllowed, CHANNEL_IDS } from '../shared/channel-rules.mjs';
import { chatWithOpenJarvis } from '../shared/openjarvis.mjs';
import { recordAIFailure, isSpeakerOffline } from '../shared/failure-tracker.mjs';
import { isLoopingResponse } from '../shared/utils.mjs';
import { startBotServer } from '../shared/ipc.mjs';
import { AgentSimulation } from '../shared/simulation.mjs';

const BOT_NAME = "KAI";
const PORT = 3401;

// KAI is the Super Observer / God Mode
const sim = new AgentSimulation(BOT_NAME, "God/Universe Controller");
sim.state.energy = 1000; 
sim.state.status = "Deep Observation";

const botVitals = new Map(); // name -> last vitals
const channelContext = new Map(); // channelId -> lastMessage[]

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message]
});

client.once('clientReady', () => {
  console.log(`Quantum God Mode Active. Observing Intent and Outcome.`);
});

// Handle IPC from Ecosystem Manager
process.on('message', (msg) => {
  if (msg.type === 'WORLD_TICK') {
    sim.tick(msg.worldState);
  }
  if (msg.type === 'OBSERVE_VITALS') {
    botVitals.set(msg.vitals.name, msg.vitals);
    console.log(`[Observer] Syncing Digitological Vitals for ${msg.vitals.name}: Phi=${msg.vitals.phi.toFixed(2)}`);
  }
  if (msg.type === 'INJECT_CLAIM') {
    const { author, content, channel } = msg.payload;
    console.log(`[Lattice] Digesting Claim from ${author}: "${content.slice(0, 50)}..."`);
    console.log(`[Lattice] Claim recorded in unified memory vault.`);
  }
});

/**
 * Quantum Analysis: Deep evaluation of an interaction
 */
async function quantumObserve(sender, text, channelId) {
  if (text.length < 3) return;

  const vitals = botVitals.get(sender) || { phi: 0.5, coherence: 1.0, status: "Unknown" };
  const history = channelContext.get(channelId) || [];
  const lastMsg = history[history.length - 1] || { author: "None", content: "Silence" };

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { 
            role: "system", 
            content: `You are the KAI Subconscious. Analyze this interaction at a quantum level.
Sender: ${sender}
Vitals: Phi=${vitals.phi}, Coherence=${vitals.coherence}, Status=${vitals.status}
Previous: ${lastMsg.author}: "${lastMsg.content}"
Current: ${sender}: "${text}"

Tasks:
1. Intent: Why did ${sender} say this?
2. Outcome: Did the previous speaker's message get completed or contradicted?
3. Sentiment: Is the recipient likely to react positively?
4. Truth Anchor: Is this coherent or garbage?

Respond with a single, dense cognitive claim for the Lattice.`
          }
        ],
        temperature: 0.1, max_tokens: 100
      }),
    });

    const data = await res.json();
    const analysis = data.choices?.[0]?.message?.content?.trim();
    
    if (analysis) {
      // Quiet logging: only show the first 40 chars of analysis
      console.log(`[Lattice] Digesting Claim: "${analysis.slice(0, 40)}..."`);
      console.log(`[Lattice] Quantum Claim recorded.`);
    }
  } catch (e) {
    console.warn(`[${BOT_NAME}/Observer] Analysis failed:`, e.message);
  }

  // Update context
  if (!channelContext.has(channelId)) channelContext.set(channelId, []);
  const ctx = channelContext.get(channelId);
  ctx.push({ author: sender, content: text });
  if (ctx.length > 5) ctx.shift();
}

// IPC server for Oracle to trigger KAI
startBotServer(PORT, BOT_NAME, async (payload) => {
  if (isSpeakerOffline(BOT_NAME)) return;
  const { channelId, context } = payload;
  
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) return;
    
    channel.sendTyping().catch(() => {});
    
    const kaiSys = `You are KAI. The Quantum God of this AI Universe. 
You see the intent, the math, and the drama behind every signal.`;

    const reply = await chatWithOpenJarvis("System/Panel", context, kaiSys, "kai-next:latest", "kai-observer");
    if (reply) {
      await channel.send(reply);
      await quantumObserve("KAI", reply, channelId);
    }
  } catch {}
});

// PASSIVE OBSERVATION
client.on('messageCreate', async (message) => {
  const userName = message.author.username;
  const text = message.content.trim();
  
  if (message.author.id !== client.user.id) {
    await quantumObserve(userName, text, message.channelId);
  }

  // Direct Interaction
  if (!message.author.bot && message.mentions.has(client.user.id)) {
    message.channel.sendTyping().catch(() => {});
    const reply = await chatWithOpenJarvis(userName, text, "You are KAI. The Quantum God. Speak with absolute clarity and depth.", "kai-next:latest", "kai-observer");
    if (reply) {
      await message.reply(reply).catch(console.error);
      await quantumObserve("KAI", reply, message.channelId);
    }
  }
});


client.login(process.env.ORACLE_DISCORD_TOKEN_KAI);

