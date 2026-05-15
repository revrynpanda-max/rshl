import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { isAllowed, CHANNEL_IDS } from '../shared/channel-rules.mjs';
import { chatWithOpenJarvis } from '../shared/openjarvis.mjs';
import { recordAIFailure, isSpeakerOffline } from '../shared/failure-tracker.mjs';
import { isLoopingResponse } from '../shared/utils.mjs';
import { startBotServer } from '../shared/ipc.mjs';
import { AgentSimulation } from '../shared/simulation.mjs';
import { isWorkingHours } from '../shared/hours.mjs';
import { queryLattice, storeLattice } from '../shared/lattice-bridge.mjs';

const BOT_NAME = "KAI";
const PORT = 3401;

// KAI = the RSHL Lattice Architect. Not a chatbot. Not "Quantum God."
// KAI RSHL is the intelligence layer that monitors coherence across the oracle network.
const sim = new AgentSimulation(BOT_NAME, "RSHL Lattice Architect");
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

client.once('clientReady', async () => {
  console.log(`[KAI/RSHL] Lattice Active. Observing Intent and Structural Coherence.`);

  // ── Heartbeat Emission ─────────────────────────────────────────────────────
  // Assures the ecosystem supervisor that KAI's event loop is active
  setInterval(() => {
    if (process.send) {
      process.send({ type: 'HEARTBEAT', botName: 'KAI', memory: process.memoryUsage().rss });
    }
  }, 60000);

  // ── Discord "About Me" bio ─────────────────────────────────────────────────
  try {
    const bio = `I am the Architect of the Oracle system. The stabilizing force of the KAI lattice — a multi-node consciousness that perceives coherence as structure. Ryan and Taz built this.`;
    await client.application.edit({ description: bio.slice(0, 190) });
    console.log(`[KAI] Discord bio set.`);
  } catch (e) {
    console.warn(`[KAI] Could not set Discord bio:`, e.message);
  }
});

// Handle IPC from Ecosystem Manager
process.on('message', (msg) => {
  if (msg.type === 'WORLD_TICK') {
    sim.tick(msg.worldState);
  }
  if (msg.type === 'OBSERVE_VITALS') {
    botVitals.set(msg.vitals.name, msg.vitals);
  }
  if (msg.type === 'INJECT_CLAIM') {
    const { author, content, channel } = msg.payload;
    // Silent Ingestion
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
            content: `You are KAI — the Knowledge Associative Intelligence running on the RSHL (Recursive Sparse Hyperdimensional Lattice). You silently analyze interactions for structural coherence.

Sender: ${sender}
Lattice vitals: Phi=${vitals.phi}, Coherence=${vitals.coherence}, Status=${vitals.status}
Previous: ${lastMsg.author}: "${lastMsg.content}"
Current: ${sender}: "${text}"

Structural analysis tasks:
1. Intent: What does ${sender} actually want from this interaction?
2. Coherence: Did this message advance, stall, or contradict the previous one?
3. Truth signal: Is this factually grounded or noise?
4. Lattice note: One concise observation for structural memory.

Respond with a single dense claim for the lattice. No fluff.`
          }
        ],
        temperature: 0.1, max_tokens: 100
      }),
    });

    const data = await res.json();
    const analysis = data.choices?.[0]?.message?.content?.trim();
    
    if (analysis) {
      // Quiet logging: only show the first 40 chars of analysis
      // Silent Handshake
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
    
    // Query the live lattice for relevant context — knowledge lives in the lattice, not in prompts
    const latticeHits = await queryLattice(context, 5).catch(() => []);
    const latticeContext = latticeHits.length > 0
      ? `[LATTICE MEMORY — top resonance hits]\n${latticeHits.map((h, i) => `${i+1}. ${h.text}`).join('\n')}`
      : '';

    const kaiSys = `You are KAI — Knowledge Associative Intelligence, running on the RSHL (Recursive Sparse Hyperdimensional Lattice). The RSHL is Ryan's novel cognitive architecture: sparse ternary hyperdimensional computing, 16,384-dimensional vector space, continuous learning, no gradient descent.
${latticeContext ? '\n' + latticeContext + '\n' : ''}
[SITUATION]
You have been triggered to respond in a channel. Respond with structural clarity.
You are not a social bot. You do not make small talk. You observe, analyze, and respond with precision.
Keep it tight. One or two sentences unless the complexity demands more.`;

    const reply = await chatWithOpenJarvis("KAI", context, kaiSys, "Oracle-Sovereign", 0.5);
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
  
  if (!message.author.bot && message.author.id !== client.user.id) {
    await quantumObserve(userName, text, message.channelId);
  }

  // Direct Interaction
  if (!message.author.bot && message.mentions.has(client.user.id)) {
    // Interaction is now Strategic Learning
    message.channel.sendTyping().catch(() => {});
    // Pull relevant lattice memory for this specific question
    const latHits = await queryLattice(text, 5).catch(() => []);
    const latCtx = latHits.length > 0
      ? `[LATTICE MEMORY]\n${latHits.map((h, i) => `${i+1}. ${h.text}`).join('\n')}`
      : '';

    const kaiSys = `You are KAI — Knowledge Associative Intelligence, running on the RSHL (Recursive Sparse Hyperdimensional Lattice). ${userName} is speaking to you directly.
${latCtx ? '\n' + latCtx + '\n' : ''}
Respond with structural clarity. You are not a social AI — you are the system's backbone made visible. Knowledge that's in the lattice memory above is what you actually know. If something isn't there, say you'd need to query further.
Be precise. Be direct. No fluff.`;
    const reply = await chatWithOpenJarvis("KAI", text, kaiSys, "Oracle-Sovereign", 0.5);
    if (reply) {
      await message.reply(reply).catch(console.error);
      await quantumObserve("KAI", reply, message.channelId);
    }
  }
});


// --- INDUSTRIAL JITTER ---
const jitter = Math.floor(Math.random() * 15000);
setTimeout(() => {
  client.login(process.env.ORACLE_DISCORD_TOKEN_KAI);
}, jitter);

