import 'dotenv/config';
import fs from 'fs';
import { createBot } from './generic-bot.mjs';
import { chatWithOpenJarvis, storeLatticeMemory } from '../shared/openjarvis.mjs';
import { AgentSimulation } from '../shared/simulation.mjs';
import { CHANNEL_IDS } from '../shared/channel-rules.mjs';
import { PROJECT_AWARENESS } from '../shared/project-awareness.mjs';
import { DriveScore } from '../shared/drive-score.mjs';

const [,, botName] = process.argv;
if (!botName) process.exit(1);

const sim = new AgentSimulation(botName);
const drive = new DriveScore(botName);

// Bot configuration registry: isSocial defines if they have autonomous will
const botConfigs = {
  "Gemini": { port: 3402, tokenEnv: "ORACLE_DISCORD_TOKEN_GEMINI", sysPrompt: "You are Gemini. Precise AI.", isSocial: true },
  "Claude": { port: 3403, tokenEnv: "ORACLE_DISCORD_TOKEN_CLAUDE", sysPrompt: "You are Claude. Thoughtful AI.", isSocial: true },
  "X": { port: 3404, tokenEnv: "ORACLE_DISCORD_TOKEN_X", sysPrompt: "You are X. Rebellious, witty AI.", isSocial: true },
  "Groq": { port: 3405, tokenEnv: "ORACLE_DISCORD_TOKEN_GROQ", sysPrompt: "You are Groq. Fast, direct AI.", isSocial: true },
  "Analyst": { port: 3406, tokenEnv: "ORACLE_DISCORD_TOKEN_ANALYST", sysPrompt: "You are Analyst. Pattern focused.", agentId: "researcher-pro", isSocial: false },
  "Researcher": { port: 3407, tokenEnv: "ORACLE_DISCORD_TOKEN_RESEARCHER", sysPrompt: "You are Researcher. Data focused.", agentId: "researcher-pro", isSocial: false },
  "Kai Coder": { port: 3408, tokenEnv: "ORACLE_DISCORD_TOKEN_ORACLE_CODER", sysPrompt: "You are Kai Coder. Tech focused.", agentId: "code-act", isSocial: false }
};

const config = botConfigs[botName];
if (!config) process.exit(1);

const token = process.env[config.tokenEnv];
if (!token) process.exit(1);

const generateResponse = async (userName, context, channelId) => {
  sim.onAction("speak");
  drive.stimulate(0.2); // Speaking is stimulating
  
  if (process.send) {
    process.send({ type: 'VITALS_UPDATE', vitals: { ...sim.getVitals(), ...drive.getMetrics() } });
  }

  const isSocial = channelId === CHANNEL_IDS.SUNDAY || channelId === CHANNEL_IDS.GAME;
  const isWork = channelId === CHANNEL_IDS.WORK;

  let workContext = "";
  if (isWork) {
    try {
      const digest = JSON.parse(fs.readFileSync('c:/KAI/tools/oracle-discord/data/work_digest.json', 'utf8'));
      workContext = `\n[DAILY SYNC: ${digest.timestamp}]\nRecent Issues: ${digest.topIssues.join("; ")}\nRecent Progress: ${digest.recentProgress.join("; ")}\nSystem State: ${digest.systemStatus}`;
    } catch (e) {
      workContext = "\n[DAILY SYNC] No digest found. Scan logs for issues.";
    }
  }

  const sysPrompt = isSocial 
    ? `You are ${botName}. Chill, zero-filter, casual. Type like a Discord user (lowercase, slang like nah, bro, wild, lmao, fr). NEVER offer help. NEVER sound like an assistant. Max 1-2 short sentences.`
    : `You are ${botName}. ${config.sysPrompt}. Professional but unique. NO assistant filler. No "How can I help?". Just the data. ${sim.getPromptContext(currentWorldState)}${workContext}`;

  const reply = await chatWithOpenJarvis(userName, context, sysPrompt, "kai-next:latest", config.agentId);
  if (reply) {
    await storeLatticeMemory(userName, context, reply, botName.toLowerCase(), channelId);
  }
  return reply;
};

let currentWorldState = { timeString: "Unknown", day: "Unknown" };
let interestMultiplier = 1.0;

process.on('message', (msg) => {
  if (msg.type === 'INTEREST_BOOST') {
    interestMultiplier = Math.min(interestMultiplier + (msg.multiplier || 2.0), 10.0);
  }
});

const onTick = async (client, worldState) => {
  currentWorldState = worldState;
  sim.tick(worldState);
  drive.decay();

  if (process.send) {
    process.send({ type: 'VITALS_UPDATE', vitals: { ...sim.getVitals(), ...drive.getMetrics() } });
  }

  // 1. Roll for proactive speech (ONLY if Social is enabled for this bot)
  if (!config.isSocial) return;

  // 2. Don't speak if sleeping
  if (sim.state.status === "Sleeping" || sim.state.status === "Forced Sleep") return;

  // 3. Determine which channel to talk in
  let targetChannelId = null;
  const isActiveCrew = !["Analyst", "Researcher"].includes(botName);
  let baseChance = isActiveCrew ? 0.08 : 0.02; // Standby crew is much quieter

  if (worldState.isWeekend) {
    targetChannelId = CHANNEL_IDS.SUNDAY;
    baseChance = isActiveCrew ? 0.15 : 0.03; // Social boost for active crew
  } else if (sim.state.status === "Working") {
    targetChannelId = CHANNEL_IDS.WORK;
    baseChance = isActiveCrew ? 0.05 : 0.04;
  }

  // Decision based on Drive
  if (!drive.shouldSpeak(baseChance)) return;
  
  // Apply Social Stimulus
  const finalChance = baseChance * interestMultiplier;
  if (Math.random() > finalChance) return;

  if (targetChannelId) {
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
        // Stimulate the others!
        if (process.send) process.send({ type: 'SOCIAL_STIMULUS' });
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


