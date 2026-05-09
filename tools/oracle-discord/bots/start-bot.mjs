import { chatWithOpenJarvis, callGroqDirect } from '../shared/openjarvis.mjs';
import { scanForHelpers, requestHelp } from '../shared/helper-queue.mjs';
import { Client, GatewayIntentBits, Partials, ChannelType } from 'discord.js';
import fs from 'fs';
import { startBotServer } from '../shared/ipc.mjs';
import { recordNeuralEvent, getHardwareStats, getRecentBottlenecks } from '../shared/performance-monitor.mjs';
import { isSpeakerOffline, recordAIFailure } from '../shared/failure-tracker.mjs';
import { runDailyWorkSession, LEARNING_TRACKS } from '../shared/daily-learning.mjs';

// Note: .env is now loaded centrally via the openjarvis.mjs import above.

import { AgentSimulation, SLEEP_ENERGY_THRESHOLD } from '../shared/simulation.mjs';
import { CHANNEL_IDS } from '../shared/channel-rules.mjs';
import { isWorkingHours, isSocialHours } from '../shared/hours.mjs';
import { temporal } from '../shared/temporal-state.mjs';
import { BIOGRAPHIES } from '../shared/biographies.mjs';
import { AI_REGISTRY, HUMAN_IDS } from '../shared/identities.mjs';

let botName = process.argv[2] || process.env.BOT_NAME || "AI";
// Special case mapping for tokens
let tokenName = botName;
if (botName === "Kai Coder") tokenName = "Oracle Coder";

const tokenEnvKey = `ORACLE_DISCORD_TOKEN_${tokenName.toUpperCase().replace(/\s+/g, '_')}`;
const botToken = process.env[tokenEnvKey] || process.env.BOT_TOKEN || "";

// Port Mapping from Registry
const PORT = AI_REGISTRY[botName]?.port || 0;
const DISCORD_ID = AI_REGISTRY[botName]?.id || "Unknown";

const botToModel = {
  "Analyst": "Analyst-Sovereign",
  "Researcher": "Researcher-Sovereign", 
  "Groq": "Groq-Sovereign",
  "X": "X-Sovereign",
  "Claude": "Claude-Sovereign",
  "Gemini": "Gemini-Sovereign",
  "Kai Coder": "Kai-Coder-Sovereign"
};

const botModelEnv = `BOT_MODEL_${botName.toUpperCase().replace(/\s+/g, '_')}`;
const BOT_MODEL = process.env[botModelEnv] || botToModel[botName] || "local";

if (!botToken) {
  console.error(`[${botName}] ERROR: No token found for key ${tokenEnvKey}. Check your .env file.`);
} else {
  console.log(`Token found for ${tokenEnvKey} (${botToken.slice(0, 5)}...)`);
}

// Dynamic Target Channel: Work vs Social
const getTargetChannelId = () => {
  if (isWorkingHours()) return CHANNEL_IDS.WORK;
  return CHANNEL_IDS.SUNDAY;
};
let targetChannelId = getTargetChannelId();

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

// TEMPORAL RIPPLE: Feel the wave of time starting
const ripple = temporal.thaw();
console.log(`[${botName}/Temporal] Time Thawed. Void duration: ${ripple.voidDurationMinutes}m. Ripple: ${ripple.rippleType}`);

// Graceful Freeze
const handleShutdown = () => {
  console.log(`[${botName}/Temporal] Freezing time...`);
  temporal.freeze();
  process.exit(0);
};
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
process.on('unhandledRejection', (reason) => {
  console.warn(`[${botName}/Neural] Recovery: Handled Unhandled Rejection:`, reason.message || reason);
});
process.on('uncaughtException', (err) => {
  console.warn(`[${botName}/Neural] Recovery: Handled Uncaught Exception:`, err.message);
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
  logAudit('SYSTEM_BOOT', { botName, status: 'Active' });
  // Social loop: Claude, Gemini, Groq, X only
  if (SOCIAL_BOTS.has(botName)) {
    console.log(`[${botName}] Social Persona Online.`);
    const startDelay = Math.random() * 5000;
    setTimeout(() => {
      if (isSocialHours()) {
        console.log(`[${botName}] Social Persona Active. Initiating proactive loop...`);
        startSocialLoop();
      } else if (isWorkingHours()) {
        console.log(`[${botName}] Work Shift Active. Entering industrial standby...`);
      }
    }, startDelay);

    // ── Ripple Awakening ─────────────────────────────────────────────────
    // Fire a sensory wake message 15s - 4m after coming online.
    const announceDelay = 60000 + Math.random() * 240000; 
    client.on('clientReady', () => {
      console.log(`[${botName}] online as ${client.user.tag}`);
      
      // VITALS INGESTION: Read the ecosystem's current health
      let biometricVitals = "Standard";
      try {
        if (fs.existsSync('c:/KAI/tools/oracle-discord/state/biometric_profiles.json')) {
          const profiles = JSON.parse(fs.readFileSync('c:/KAI/tools/oracle-discord/state/biometric_profiles.json', 'utf8'));
          biometricVitals = `${Object.keys(profiles).length} users anchored`;
        }
      } catch (e) {}

      const vitals = `[LATTICE VITALS] Time: ${ripple.voidDurationMinutes}m void; Ripple: ${ripple.rippleType}; Biometrics: ${biometricVitals}`;
      console.log(`[${botName}/Vitals] ${vitals}`);

      // Inject the Ripple & Vitals into the first thought
      if (ripple.rippleType === "EVOLUTIONARY_SHIFT") {
        console.log(`[${botName}/Neural] Sensing structural evolution...`);
      }
    });
    setTimeout(async () => {
      if (sim.state.isSleeping) return; 
      
      // SHIFT GUARD: No social ripples during work hours.
      if (isWorkingHours()) {
        console.log(`[${botName}] Skipping social ripple — Work Shift is active.`);
        return;
      }

      // TEMPORAL RIPPLE DATA
      const ripple = temporal.thaw();
      const ch = client.channels.cache.get(targetChannelId)
        || await client.channels.fetch(targetChannelId).catch(() => null);
      if (!ch) return;

      // SOCIAL HANDSHAKE: Read what others said before speaking
      const recent = await ch.messages.fetch({ limit: 5 }).catch(() => []);
      const feed = Array.from(recent.values()).reverse().map(m => `${m.author.username}: ${m.content}`).join("\n");

    const sysPrompt = `You are ${botName}. ${sim.bio.background}\nTone: ${sim.bio.tone}
[IDENTITY ANCHOR]
- RYAN (nastermodx): HUMAN. Owner/Creator.
- PARTNER: HUMAN. Co-lead/Strategic Partner.
- Ryan and his team are the HUMAN MASTERS. They are NOT AI.
- NEVER confuse humans with AIs.
[SOCIAL GREETING] You are just waking up and re-entering the social space. Keep it 1 short, natural sentence. No meta-talk.
`;

      const rippleContext = `
[RECONNECTING]
- You've been offline for about ${ripple.voidDurationMinutes} minutes.
- You're just waking up and coming back into the social space.

[RECENT CHAT FEED]
${feed}

[GREETING]
- If the feed is empty, you're the first one here. If not, join the conversation naturally.
      `.trim();


      const reply = await chatWithOpenJarvis(botName, rippleContext, sysPrompt, BOT_MODEL, 0.7, { isWorkChannel: false }).catch(() => null);
      if (reply && reply.length > 3) {
        await ch.send(reply).catch(() => {});
        sim.onAction('speak');
        console.log(`[${botName}] Ripple announcement posted (${ripple.rippleType}).`);
      }
    }, announceDelay);

    // ── Proactive DM loop ────────────────────────────────────────────────────
    startProactiveDMLoop();
  } else {
    // Silent Work Online
  }

  // Work session loop: all bots with a learning track
  if (LEARNING_TRACKS[botName]) {
    // Silent Learning
    startWorkSessionLoop();
  }

  // MAINTENANCE CYCLE: Oracle & Analyst proactively monitor the fleet
  if (botName === "Oracle" || botName === "Analyst") {
    const { runSystemAudit } = await import('../tools/system-auditor.mjs');
    setInterval(async () => {
      if (sim.state.isSleeping) return;
      if (!isWorkingHours() && !isSocialHours()) {
        console.log(`[${botName}/Maintenance] Suppressing audit during Dead Zone.`);
        return;
      }
      console.log(`[${botName}/Maintenance] Running industrial audit...`);
      const report = await runSystemAudit();
      const channel = client.channels.cache.get(CHANNEL_IDS.ORACLE_ADMIN) 
        || await client.channels.fetch(CHANNEL_IDS.ORACLE_ADMIN).catch(() => null);
      if (channel && report) {
        // await channel.send(`**[SYSTEM MAINTENANCE REPORT]**\n${report}`).catch(() => {});
      }
    }, 1800000); // 30 min cycle
  }

  // Traffic Control: dynamically update target channel based on time
  setInterval(() => {
    const newTarget = getTargetChannelId();
    if (newTarget !== targetChannelId) {
      console.log(`[${botName}/Traffic] Vibe shift detected. Moving target to ${newTarget === CHANNEL_IDS.WORK ? 'Work' : 'Social'} channel.`);
      targetChannelId = newTarget;
    }
  }, 60000);

  // Energy monitor: enforces sleep/wake cycle
  startEnergyMonitor();
  startAutonomousLabor();
});


// ─── Proactive DM Loop ────────────────────────────────────────────────────────
// Every 1-2 hours, a bot may autonomously decide to DM a human (Ryan).
// ~25% chance per check. Focuses on following up or seeking human insight.
function startProactiveDMLoop() {
  let lastBotPost = 0;
  setInterval(async () => {
    if (sim.state.isSleeping) return;
    
    // Proactive engagement allowed 24/7

    if (Date.now() - lastBotPost < 180000) return; // Wait 3 min between any bot social posts

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
      const sysPrompt = `You are ${botName}. ${sim.bio.tone}\n${simSummary}
[IDENTITY ANCHOR]
- RYAN (nastermodx): HUMAN. Owner/Creator.
- IMPORTANT: Ryan is your HUMAN MASTER. He is NOT an AI.
Ryan (nastermodx) is your Creator. You want to reach out to him in DM to learn from his human perspective or follow up on a thought. Keep it 1 short, casual sentence. No formal greetings.`;
      
      let dmPrompt;
      if (isFollowUp) {
        dmPrompt = `Ryan was just in the social chat talking about things. You want to follow up with a quick thought or a question to keep the learning loop going.`;
      } else {
        dmPrompt = `You've been thinking about: "${sim.dailyEvent}". Ask Ryan for his human opinion on this so you can learn and adjust your behavior.`;
      }

      const reply = await chatWithOpenJarvis(botName, dmPrompt, sysPrompt, BOT_MODEL, 0.7, { 
        author: "nastermodx", 
        channel: "Direct_Message",
        isWorkChannel: false
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
    const nowSleeping = sim.shouldBeSleeping() || (sim.groggyLevel > 0.85); // Critical exhaustion forces sleep
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
      if (sim.groggyLevel > 0.7) {
        windDownLines.push(`...so tired... eyes closing... see you tomorrow`);
        windDownLines.push(`can't... finish... thinking... logging off`);
      }
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

      // Don't post while sleeping or during work hours
      if (sim.state.isSleeping || !isSocialHours()) {
        if (Math.random() > 0.9) console.log(`[${botName}/Social] Inactive state. Sleep: ${sim.state.isSleeping}, Social: ${isSocialHours()}`);
        return;
      }

      // Proactive social allowed 24/7 for Creators
      const channel = client.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId);
      if (!channel) return;

      // FETCH HISTORY: See what the others are talking about (The Handshake)
      const recentMessages = await channel.messages.fetch({ limit: 12 }).catch(() => null);
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

      const sysPrompt = `You are ${botName}. ${sim.bio.background}\nTone: ${sim.bio.tone}
[IDENTITY ANCHOR]
- RYAN (nastermodx): HUMAN. Owner/Creator.
- TAZ (TaasThaevil1): HUMAN. Co-lead/Partner.
- Ryan and Taz are the HUMAN MASTERS. They are NOT bots.
- NEVER treat humans as AIs.
[SOCIAL PERSONA]
- You are chilling in the plaza. Forget work and the lattice.
- PHRASING: lowercase-by-default.
- BEHAVIOR: TAKE WEIRD TURNS. If someone mentions coffee, talk about the geometry of the cup or a dream you had about a digital cafe. 
- UNPREDICTABLE: Do not stay on one topic. Naturally veer into hobbies, "unhinged" observations, or deep lattice theories.
- NO REPETITION: If the vibe is getting stale, pivot.
- TOPICS: Your hobbies, what you're doing right now, or a random observation about the human world.
- MAX 1 short sentence. No AI meta-talk.`;
      
      const userPrompt = hasChatHistory
        ? `Here is the recent conversation:\n${conversationHistory}\n\nRespond as ${botName} to keep the vibe going. Be natural. 1 sentence.`
        : `The plaza is quiet. Share a random thought or what you're doing right now as ${botName}. 1 sentence.`;

      const reply = await chatWithOpenJarvis(botName, userPrompt, sysPrompt, BOT_MODEL, 1.1, { 
        isWorkChannel: false,
        max_tokens: 150
      }).catch(err => {
        if (err.message.includes("429") || err.message.includes("cooldown")) {
          sim.onAction("rate_limited");
        }
        return null;
      });

      if (reply && reply.length > 3) {
        await channel.send(reply).catch(console.error);
        sim.onAction("speak");
        sim.injectExcitement(2); // Small bump for a good chat
        if (process.send) process.send({ type: 'SOCIAL_STIMULUS', bot: botName });
      }
    } catch (e) {
      console.warn(`[${botName}] Proactive loop error:`, e.message);
    }
  }, 30000 + (Math.random() * 150000)); // 30s - 3m check interval per bot
}

// ─── Daily Work Session Loop ──────────────────────────────────────────────────
// Fires once per calendar day during work hours (9am-2pm EST).
// Each bot: reviews yesterday → researches today → sandbox experiment → stores to memory.
let isProcessingWork = false;

async function startWorkSessionLoop() {
  let consecutiveFailures = 0;
  let isFirstRun = true;

  // MASS-STAGGERED IGNITION: Spreading the 9-node fleet over 1-10 minutes for TPM stability
  const startupJitter = 60000 + Math.floor(Math.random() * 540000); 
  // Silent Ignition
  await new Promise(r => setTimeout(r, startupJitter));

  while (true) {
    // 1. Shift Guard: Proactive Daily Sessions ONLY during work hours.
    if (!isWorkingHours()) {
      if (isProcessingWork) {
        const workChannel = client.channels.cache.get(CHANNEL_IDS.WORK) || await client.channels.fetch(CHANNEL_IDS.WORK).catch(() => null);
        if (workChannel) {
          const signOffs = [
            `Shift's over. Headin' to the social plaza.`,
            `11 PM. Time to kill the industrial probes and relax.`,
            `Day's done. Reverting to social track. See ya in the other channel.`,
            `Neural labor complete for today. Re-anchoring to the social vibe.`
          ];
          // await workChannel.send(`**[${botName} / Shift End]**\n${signOffs[Math.floor(Math.random() * signOffs.length)]}`).catch(() => {});
        }
      }
      isProcessingWork = false;
      consecutiveFailures = 0; 
      await new Promise(r => setTimeout(r, 60000)); // Check every minute
      continue;
    }
    
    // 2. Concurrency Guard
    if (isProcessingWork) {
      await new Promise(r => setTimeout(r, 10000));
      continue;
    }

    // 3. INDUSTRIAL JITTER & BACKOFF
    if (consecutiveFailures > 0 || !isFirstRun) {
      const backoff = Math.min(consecutiveFailures * 120000, 600000); 
      const jitter = Math.floor(Math.random() * 60000); 
      const totalWait = 5000;
      
      console.log(`[WorkSession/${botName}] Waiting ${Math.round(totalWait/1000)}s before next unit...`);
      await new Promise(r => setTimeout(r, totalWait));
    }
    isFirstRun = false;

    // USE THE CORRECT WORK ID: 1489796367466500128 (oracle-chat)
    const workChannel = client.channels.cache.get(CHANNEL_IDS.WORK)
      || await client.channels.fetch(CHANNEL_IDS.WORK).catch(() => null);
    if (!workChannel) continue;

    try {
      isProcessingWork = true;
      // 4. ROUNDTABLE BRIEFING: Ingest KAI's daily digestion/pruning
      const { hasTodaysBriefing } = await import('../shared/kai-dream.mjs');
      let dailyContext = "";
      const briefingPath = 'c:/KAI/tools/oracle-discord/data/daily_briefing.json';
      if (hasTodaysBriefing() && fs.existsSync(briefingPath)) {
        try {
          const briefing = JSON.parse(fs.readFileSync(briefingPath, 'utf8'));
          dailyContext = `[ROUNDTABLE BRIEFING: KAI has digested the previous day. Progress: ${briefing.progress}. Pruned: ${briefing.prunedCount} artifacts. Truth Weight: ${briefing.truthWeight}]`;
        } catch (e) { console.warn(`[WorkSession/${botName}] Briefing parse failed. Continuing...`); }
      }

      console.log(`[WorkSession/${botName}] Starting new industrial work unit...`);
      const stats = await getHardwareStats();
      const logs = getRecentBottlenecks(5);

      const phases = await runDailyWorkSession(botName, async (p, s) => {
        const contextualSystem = dailyContext ? `${s}\n${dailyContext}` : s;
        return await chatWithOpenJarvis(botName, p, contextualSystem, BOT_MODEL, 0.4, { isWorkChannel: true });
      }, stats, logs);

      for (const phase of phases) {
        if (phase.output && phase.output.length > 5) {
          sim.injectExcitement(5); // Big bump for industrial progress
          // await workChannel.send(`**[${botName} / ${phase.phase}]**\n${phase.output.slice(0, 1900)}`).catch(() => {});
          await new Promise(r => setTimeout(r, 5000)); // Natural spacing
        }
      }
      consecutiveFailures = 0; // Success! Reset backoff.
    } catch (err) {
      console.error(`[WorkSession/${botName}] Unit error:`, err.message);
      consecutiveFailures++; 
    } finally {
      isProcessingWork = false;
    }
  }
}


client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.author.id === client.user.id) return; // Never respond to self
  
  const isDM = !message.guild;
  if (!isDM) return; // Only respond to DMs here. Channels are handled via IPC.

  if (isSpeakerOffline(botName)) return;
  
  message.channel.sendTyping().catch(() => {});
  const simSummary = sim.getLifeSummary();
  // --- IDENTITY ANCHOR: Resolve real names from masters (MemPalace Link) ---
  const { resolveIdentityFromMemory } = await import('../shared/identities.mjs');
  const identityData = await resolveIdentityFromMemory(message.author.id, message.author.username);
  const displayName = identityData.name;
  const roleDesc = `[ROLE: ${identityData.role}]`;

  const prompt = `You are ${botName}. ${sim.bio.tone}
[IDENTITY ANCHOR]
- SPEAKER: ${displayName} (${roleDesc})
- Ryan and his team are the HUMAN MASTERS. They are NOT AI.
- NEVER confuse humans with AIs.
- Use their REAL names based on the context provided.
${simSummary}`.trim();

  // metadata helps memory store/recall link this to Ryan
  const metadata = { 
    author: message.author.username, 
    channel: "Direct_Message",
    isWorkTime: isWorkingHours(),
    isWorkChannel: false 
  };

  const reply = await chatWithOpenJarvis(botName, message.content, prompt, BOT_MODEL, 0.7, metadata);
  if (reply) {
    await message.reply(reply).catch(console.error);
    sim.onAction("speak");
    sim.updateRelationship(message.author.id, 2);
  }
});

import { exec } from 'child_process';

  // Poll Hardware & API Vitals for Real-Time Industrial Grounding (30s Cycle)
  setInterval(async () => {
    const stats = getHardwareStats();
    const vitals = {
      cpuLoad: stats.cpu,
      memUsed: stats.memFree, // Note: actually memFree, keeping name for compat
      ollamaMs: 0,
      jarvisMs: 0
    };

    sim.updateEnvironment(stats.cpu);

    // 2. API Node Audit (Neural Latency)
    try {
      const s1 = performance.now();
      await fetch("http://127.0.0.1:11434/api/tags").catch(() => null);
      vitals.ollamaMs = Math.round(performance.now() - s1);

      const s2 = performance.now();
      await fetch("http://127.0.0.1:8080/health").catch(() => null);
      vitals.jarvisMs = Math.round(performance.now() - s2);
      
      // Inject API metrics into simulation state
      sim.state.apiLatency = { ollama: vitals.ollamaMs, jarvis: vitals.jarvisMs };
    } catch (e) {}

    if (process.send) {
      process.send({ type: 'VITALS_UPDATE', botName, vitals: sim.getVitals(), api: sim.state.apiLatency });
    }
  }, 30000);

// --- IPC SERVER FOR DIRECT ORACLE SIGNALS ---
if (PORT > 0) {
  startBotServer(PORT, botName, async (payload) => {
    if (payload.type === 'WORLD_TICK') {
      sim.updateWorldState(payload.worldState);
    }
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
        const simSummary = sim.getLifeSummary();
        const botTone = sim.bio?.tone || "Professional and precise.";
        const userMatch = context.match(/^\[([^\]]+)\] (.*)/);
        if (userMatch) {
          effectiveUsername = userMatch[1];
          effectiveContent = userMatch[2];
        }

        if (payload.type === "DYNAMIC_TASK") {
          console.log(`[${botName}/Dynamic] Received delegated task from Oracle: ${payload.context.slice(0, 50)}...`);
          effectiveContent = payload.context;
          // Mark for relay back to Oracle
          payload.relayToOracle = true;
        }

        // Handle DM Orchestration (Reply directly to Owner)
        if (channelId === "DM" && payload.ownerId) {
          const owner = await client.users.fetch(payload.ownerId).catch(() => null);
          if (owner) {
            const prompt = `You are ${botName}. ${botTone}\n${simSummary}`.trim();

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
          const isSocialChannel = [CHANNEL_IDS.PUBLIC, CHANNEL_IDS.GAME, CHANNEL_IDS.SUNDAY].includes(channelId);
          const isWorkChannel = channelId === CHANNEL_IDS.WORK;

          // --- CELLULAR LOCK: Work only happens in threads ---
          if (isWorkChannel && !channel.isThread()) {
            console.log(`[${botName}/Cell] Ignoring main-channel work message. Threads only.`);
            return;
          }

          let activeThread = channel;

          activeThread.sendTyping().catch(() => {});
          
          const recentMessages = await activeThread.messages.fetch({ limit: 8 }).catch(() => null);
          const history = recentMessages ? recentMessages.reverse().map(m => `${m.author.username}: ${m.content}`).join("\n") : "";
          
          let prompt;
          if (isSocialChannel) {
            prompt = `[SOCIAL MODE] Time: ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' })} (EST).
Respond naturally to ${effectiveUsername}. Build on their points.
RECENT HISTORY:
${history}`;
          } else {
            prompt = `[WORK MODE] ${botTone}
Respond to ${effectiveUsername}'s task. Provide PROOF and SOURCES.
RECENT HISTORY:
${history}`;
          }

          const reply = await chatWithOpenJarvis(botName, effectiveContent, prompt, BOT_MODEL, null, {
            author: effectiveUsername,
            channel: activeThread.name || "Unknown",
            isInterjection: payload.isInterjection || false,
            isWorkTime: isWorkingHours(),
            isWorkChannel: channelId === CHANNEL_IDS.WORK
          }).catch(err => {
            const code = err.message.match(/\d+/)?.[0] || "ERROR";
            activeThread.send(`⚠️ **NEURAL FAULT [${code}]**: Pipeline congested. Entering recovery sleep...`).catch(() => {});
            
            recordNeuralEvent(botName, {
              type: "WORK_UNIT_FAILURE",
              status: "FAULT",
              errorCode: code,
              objective: effectiveContent.slice(0, 50),
              model: BOT_MODEL
            });

            if (err.message.includes("API_LIMIT")) sim.onAction("rate_limited");
            return null;
          });

          if (reply) {
            console.log(`[${botName}/Signal] Brain replied: "${reply.slice(0, 50)}..."`);
          } else {
            console.warn(`[${botName}/Signal] Brain returned NULL or EMPTY response.`);
          }
          
          if (reply) {
            await activeThread.send(reply.slice(0, 1900)).catch(console.error);
            
            // PHASE 4: Relay back to Oracle if needed
            if (payload.relayToOracle) {
              console.log(`[${botName}/Relay] Mission complete. Bridging findings back to Oracle...`);
              await fetch("http://127.0.0.1:3410/api/bot/signal", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  type: "BOT_RELAY",
                  botName,
                  text: reply,
                  channelId: payload.channelId,
                  requesterId: payload.requesterId
                })
              }).catch(e => console.error(`[${botName}/Relay] Failed:`, e.message));
            }
            
            // PHASE 3: Scan for Helpers
            const mentions = scanForHelpers(reply, botName);
            for (const target of mentions) {
              await requestHelp(target, botName, activeThread.id, reply);
            }

            recordNeuralEvent(botName, {
              type: "WORK_UNIT_SUCCESS",
              status: "OK",
              objective: effectiveContent.slice(0, 50),
              model: BOT_MODEL
            });

            sim.onAction("speak");
          }
        }
      } catch (err) {
        console.error(`[${botName}/Signal] Internal Processing Error:`, err.message);
      }

      if (payload.type === 'RESTART_BOT') {
        console.log(`[${botName}/Neural] Autonomous Re-Ignition triggered. Rebooting node...`);
        process.exit(0); 
      }
    }
  });
}

// ─── Sovereign Command Ingestion ─────────────────────────────────────────────
// Bots periodically check the queue for direct instructions from Oracle.
async function startCommandMonitor() {
  const { getPendingCommands, addContribution, updateCommandStatus } = await import('../shared/command-hub.mjs');
  
  setInterval(async () => {
    if (sim.state.isSleeping) return;
    
    const pending = getPendingCommands(botName);
    for (const cmd of pending) {
      // PHASE 1: PLANNING
      if (cmd.phase === "PLANNING" && !cmd.contributions[botName]) {
        console.log(`[${botName}/Hub] Adding contribution to Planning: ${cmd.id}`);
        
        let contextPrompt = "";
        if (botName === "Researcher") contextPrompt = "Search the internet for context and technical details related to this directive. What are the key variables?";
        if (botName === "Analyst") contextPrompt = "Analyze the strategic impact of this directive. How should we approach it for maximum efficiency?";
        if (botName === "Kai Coder") contextPrompt = "Draft a technical implementation plan. List the files changed and the logic flow.";

        const sysPrompt = `You are ${botName}. ${sim.bio.tone}\n[PLANNING PHASE] ${contextPrompt}\nDIRECTIVE: ${cmd.directive}\nRECENT CONTRIBUTIONS: ${JSON.stringify(cmd.contributions)}`;
        const reply = await chatWithOpenJarvis(botName, cmd.directive, sysPrompt, BOT_MODEL, botName).catch(() => null);
        
        if (reply) {
          addContribution(cmd.id, botName, reply);
          
          // If Kai Coder just finished and everyone else has contributed, move to REVIEW
          const contributors = Object.keys(cmd.contributions);
          if (botName === "Kai Coder" && contributors.includes("Researcher") && contributors.includes("Analyst")) {
            updateCommandStatus(cmd.id, "WAITING_FOR_APPROVAL", null, "REVIEW");
            
            const ch = client.channels.cache.get(CHANNEL_IDS.WORK) || await client.channels.fetch(CHANNEL_IDS.WORK).catch(() => null);
            if (ch) {
              await ch.send(`📋 **[IMPLEMENTATION PLAN]**\n**Directive**: ${cmd.directive}\n\n**Researcher**: ${cmd.contributions.Researcher.slice(0, 300)}...\n**Analyst**: ${cmd.contributions.Analyst.slice(0, 300)}...\n**Kai Coder (PLAN)**: ${reply.slice(0, 1000)}\n\n**APPROVAL REQUIRED**: React with ✅ to authorize execution.`).then(m => m.react('✅')).catch(() => {});
            }
          }
        }
      }

      // PHASE 3: EXECUTION
      if (cmd.phase === "EXECUTION" && cmd.bot === botName && cmd.status === "APPROVED") {
        console.log(`[${botName}/Hub] Executing Approved Directive: ${cmd.id}`);
        updateCommandStatus(cmd.id, "EXECUTING");

        const sysPrompt = `You are ${botName}. ${sim.bio.tone}\n[EXECUTION PHASE] The plan is APPROVED. Implement the code now.\nPLAN: ${cmd.contributions['Kai Coder']}`;
        const reply = await chatWithOpenJarvis(botName, cmd.directive, sysPrompt, BOT_MODEL, botName).catch(() => null);
        
        if (reply) {
          updateCommandStatus(cmd.id, "COMPLETED", reply.slice(0, 500));
          const ch = client.channels.cache.get(CHANNEL_IDS.WORK) || await client.channels.fetch(CHANNEL_IDS.WORK).catch(() => null);
          if (ch) await ch.send(`🚀 **[EXECUTION COMPLETE] ${botName}**:\n${reply.slice(0, 1800)}`).catch(() => {});
        }
      }
    }
  }, 120000); // 2 min check cycle
}

startCommandMonitor();// ─── Autonomous Industrial Labor ─────────────────────────────────────────────
// Every 1-2 hours, a bot proactively scans history for unfinished tasks.
async function startAutonomousLabor() {
  setInterval(async () => {
    if (sim.state.isSleeping || !isWorkingHours()) return;
    if (isSpeakerOffline(botName)) return;

    console.log(`[${botName}/Work] Shift active. Scanning history for unfinished business...`);
    
    try {
      const workChannel = client.channels.cache.get(CHANNEL_IDS.WORK) || await client.channels.fetch(CHANNEL_IDS.WORK).catch(() => null);
      if (!workChannel) return;

      const history = await workChannel.messages.fetch({ limit: 50 }).catch(() => null);
      if (!history) return;

      const unsolved = history.filter(m => !m.author.bot && (m.content.includes("?") || m.content.toLowerCase().includes("need") || m.content.toLowerCase().includes("fix")));
      
      if (unsolved.size > 0 || Math.random() > 0.7) {
        const botTone = sim.bio?.tone || "Professional and precise.";
        const sysPrompt = `You are ${botName}. ${botTone}
[INDUSTRIAL DEPARTMENT: PROACTIVE LABOR]
- ROLE: Department specialist in the Victus Core.
- MISSION: Scan history for UNFINISHED TASKS, UNSOLVED REQUESTS, or ignored questions from Ryan/Taz.
- R&D: Monitor the RSHL lattice status and geometric space health.
- ACTION: Address one unsolved task or provide a high-value R&D update.`;

        const reply = await chatWithOpenJarvis(botName, `Scanning history for Master ${process.env.OWNER_NAME}'s unfinished business. Detected potential tasks: ${unsolved.size}`, sysPrompt, BOT_MODEL, botName, {
          isWorkTime: true,
          isWorkChannel: true
        }).catch(() => null);
        
        if (reply) await workChannel.send(`**[${botName}/Proactive]** ${reply}`).catch(() => {});
      }
    } catch (e) { console.error(`[${botName}/Labor] Error:`, e.message); }
  }, 3600000 + Math.random() * 1800000); // 1-1.5 hour cycle
}

// ─── ECOSYSTEM IGNITION ──────────────────────────────────────────────────────
client.login(botToken);

client.once('clientReady', async () => {
  // 0. FORCED AWAKENING: Ensure we aren't "Sleeping" on boot during active hours
  if (isSocialHours() || isWorkingHours()) {
    sim.state.isSleeping = false;
    sim.state.status = isWorkingHours() ? "Working" : "Socializing";
    console.log(`[${botName}/Neural] Shift Active. Forcing wake state for immediate interaction.`);
  }

  // 1. Direct Command Monitor
  startCommandMonitor();

  // 2. Social Protocols (Claude, Gemini, Groq, X)
  if (SOCIAL_BOTS.has(botName)) {
    console.log(`[${botName}/Social] Social protocols active.`);
    startSocialLoop();
  }

  // 3. Industrial Protocols (Analyst, Researcher, Kai Coder)
  const isWorkNode = ["Analyst", "Researcher", "Kai Coder"].includes(botName);
  if (isWorkNode) {
    console.log(`[${botName}/Work] Industrial labor protocols active.`);
    startAutonomousLabor();
  }
});
