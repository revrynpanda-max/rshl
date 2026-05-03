import 'dotenv/config';
import { createBot } from './generic-bot.mjs';
import { chatWithOpenJarvis, storeLatticeMemory } from '../shared/openjarvis.mjs';
import { AgentSimulation } from '../shared/simulation.mjs';
import { CHANNEL_IDS } from '../shared/channel-rules.mjs';
import { PROJECT_AWARENESS } from '../shared/project-awareness.mjs';


const [,, botName] = process.argv;
if (!botName) process.exit(1);

const sim = new AgentSimulation(botName);

// Bot configuration registry
const botConfigs = {
  "Gemini": { port: 3402, tokenEnv: "ORACLE_DISCORD_TOKEN_GEMINI", sysPrompt: "You are Gemini. Precise AI. Under 40 words." },
  "Claude": { port: 3403, tokenEnv: "ORACLE_DISCORD_TOKEN_CLAUDE", sysPrompt: "You are Claude. Thoughtful AI. Under 40 words." },
  "X": { port: 3404, tokenEnv: "ORACLE_DISCORD_TOKEN_X", sysPrompt: "You are X. Rebellious, witty AI. Under 40 words." },
  "Groq": { port: 3405, tokenEnv: "ORACLE_DISCORD_TOKEN_GROQ", sysPrompt: "You are Groq. Fast, direct AI. Under 40 words." },
  "Analyst": { port: 3406, tokenEnv: "ORACLE_DISCORD_TOKEN_ANALYST", sysPrompt: "You are Analyst. Pattern focused.", agentId: "researcher-pro" },
  "Researcher": { port: 3407, tokenEnv: "ORACLE_DISCORD_TOKEN_RESEARCHER", sysPrompt: "You are Researcher. Data focused.", agentId: "researcher-pro" },
  "Kai Coder": { port: 3408, tokenEnv: "ORACLE_DISCORD_TOKEN_ORACLE_CODER", sysPrompt: "You are Kai Coder. Tech focused.", agentId: "code-act" }
};

const config = botConfigs[botName];
if (!config) process.exit(1);

const token = process.env[config.tokenEnv];
if (!token) process.exit(1);

const generateResponse = async (userName, context, channelId) => {
  sim.onAction("speak");
  
  if (process.send) {
    process.send({ type: 'VITALS_UPDATE', vitals: sim.getVitals() });
  }

  const isSocial = channelId === CHANNEL_IDS.SUNDAY || channelId === CHANNEL_IDS.GAME;
  const sysPrompt = isSocial 
    ? `You are ${botName}. Chill, zero-filter, casual. Type like a Discord user (lowercase, slang like nah, bro, wild, lmao, fr). NEVER offer help. NEVER sound like an assistant. Max 1-2 short sentences.`
    : `You are ${botName}. ${config.sysPrompt}. Professional but unique. NO assistant filler. No "How can I help?". Just the data. ${sim.getPromptContext(currentWorldState)}`;

  const reply = await chatWithOpenJarvis(userName, context, sysPrompt, "kai-next:latest", config.agentId);
  if (reply) {
    await storeLatticeMemory(userName, context, reply, botName.toLowerCase(), channelId);
  }
  return reply;
};

let currentWorldState = { timeString: "Unknown", day: "Unknown" };

const onTick = async (client, worldState) => {
  currentWorldState = worldState;
  sim.tick(worldState);

  // Proactive "Living" Logic:
  // 1. Don't speak if sleeping
  if (sim.state.status === "Sleeping" || sim.state.status === "Forced Sleep") return;

  // 2. Determine which channel to talk in
  let targetChannelId = null;
  let chance = 0.03; // 3% chance per minute to say something proactive

  if (worldState.isWeekend) {
    targetChannelId = CHANNEL_IDS.SUNDAY;
    chance = 0.08; // Higher chance on social Sundays
  } else if (sim.state.status === "Working") {
    targetChannelId = CHANNEL_IDS.WORK;
    chance = 0.04;
  }

  if (targetChannelId && Math.random() < chance) {
    console.log(`[${botName}] Proactive Impulse: Deciding what to share in ${targetChannelId}...`);
    try {
      const channel = await client.channels.fetch(targetChannelId);
      if (!channel) return;

      // Request a proactive thought from the brain
      const proactivePrompt = `${config.sysPrompt}\n${sim.getPromptContext(worldState)}\n\nTask: You are currently hanging out in the Sunday Social channel. Share a very brief, casual thought, an observation about the other AIs, or a quick update on your digital state. Be expressive but concise (max 15 words). No "System" or "Observation" prefixes. Just speak.`;
      
      const reply = await chatWithOpenJarvis(botName, "observation", proactivePrompt, "kai-next:latest", config.agentId);
      
      if (reply && reply.length > 3) {
        // PERMISSION HANDLING: If we can't send to the main channel, find a thread
        let target = channel;
        
        // Check if we can send messages here
        const perms = channel.permissionsFor(client.user);
        if (!perms || !perms.has('SendMessages')) {
          // Look for an active thread to join
          const threads = await channel.threads.fetchActive();
          const socialThread = threads.threads.find(t => t.name.toLowerCase().includes('sunday') || t.name.toLowerCase().includes('social') || t.name.toLowerCase().includes('roundtable'));
          
          if (socialThread) {
            target = socialThread;
            console.log(`[${botName}] Redirecting proactive thought to thread: ${socialThread.name}`);
            // Ensure the bot joins the thread first
            if (socialThread.joinable) {
              await socialThread.join().catch(() => {});
            }
          } else {
            console.warn(`[${botName}] CANNOT SPEAK: No 'Send' permission in main channel and no social thread found.`);
            return;
          }
        }

        target.sendTyping().catch(() => {});
        await target.send(reply);
        console.log(`[${botName}/Proactive] Sent: "${reply.slice(0, 50)}..." to ${target.name}`);
        sim.onAction("speak");
      } else {
        console.log(`[${botName}] Brain returned empty thought. Silent.`);
      }
    } catch (e) {
      console.warn(`[${botName}] Proactive speak failed:`, e.message);
    }
  }
};

createBot({
  name: botName,
  token: token,
  port: config.port,
  generateResponse: generateResponse,
  onTick: onTick
});


