import { chatWithOpenJarvis, chatWithLattice, callGroqDirect } from '../shared/openjarvis.mjs';
import { scanForHelpers, requestHelp } from '../shared/helper-queue.mjs';
import { Client, GatewayIntentBits, Partials, ChannelType, AttachmentBuilder } from 'discord.js';
import { handleImageRequest, isImageRequest } from '../shared/gemi-image.mjs';
import fs from 'fs';
import { startBotServer } from '../shared/ipc.mjs';
import { recordNeuralEvent, getHardwareStats, getRecentBottlenecks } from '../shared/performance-monitor.mjs';
import { isSpeakerOffline, recordAIFailure } from '../shared/failure-tracker.mjs';
import { runDailyWorkSession, LEARNING_TRACKS } from '../shared/daily-learning.mjs';
import { requestOracleHelp, deliverOracleResult } from '../shared/oracle-pipeline.mjs';

// Note: .env is now loaded centrally via the openjarvis.mjs import above.

import { AgentSimulation, SLEEP_ENERGY_THRESHOLD } from '../shared/simulation.mjs';
import { CHANNEL_IDS } from '../shared/channel-rules.mjs';
import { isWorkingHours, isSocialHours } from '../shared/hours.mjs';
import { temporal } from '../shared/temporal-state.mjs';
import { BIOGRAPHIES } from '../shared/biographies.mjs';
import { AI_REGISTRY, HUMAN_IDS, HUMAN_REGISTRY } from '../shared/identities.mjs';

let botName = process.argv[2] || process.env.BOT_NAME || "AI";
// Special case mapping for tokens
let tokenName = botName;
if (botName === "Kai Coder") tokenName = "Oracle Coder";
if (botName === "Epistemic") tokenName = "Epistemic";

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
  "Epistemic": "Epistemic-Sovereign",
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
const SOCIAL_BOTS = new Set(["Epistemic", "Gemini", "Groq", "X"]);

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

  // ── Discord "About Me" bio ─────────────────────────────────────────────────
  // Set the bot's Discord profile bio from the BIOGRAPHIES file on every boot.
  try {
    const bioData = BIOGRAPHIES[botName];
    if (bioData?.background) {
      // Discord "About Me" max is 190 chars
      const bio = bioData.background.slice(0, 190);
      await client.application.edit({ description: bio });
      console.log(`[${botName}] Discord bio set.`);
    }
  } catch (e) {
    console.warn(`[${botName}] Could not set Discord bio:`, e.message);
  }

  // Social loop: Epistemic, Gemini, Groq, X only
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

    const sysPrompt = `you are ${botName}. ${sim.bio.background}
vibe: ${sim.bio.tone}. you're in the chat. say one short natural thing. lowercase, one sentence. don't say you're back, don't mention being offline, don't use re-entry language.`;

      // Don't tell the model it's "waking up" — it will just say that out loud.
      // Give it the feed and let it re-enter naturally based on the sysPrompt tone.
      const rippleContext = feed.trim()
        ? `recent chat:\n${feed}\n\njoin in. one sentence.`
        : `nothing going on yet. say one thing on your mind.`;


      const reply = (botName === "KAI")
        ? await chatWithLattice(botName, rippleContext).catch(() => null)
        : await chatWithOpenJarvis(botName, rippleContext, sysPrompt, BOT_MODEL, 0.7, { isWorkChannel: false }).catch(() => null);

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
      const sysPrompt = `you are ${botName}. ${sim.bio.tone}
you're DMing ryan — the person who runs this whole system. keep it casual, one sentence, no formal openers. you have a thought or want to pick his brain about something.`;
      
      let dmPrompt;
      if (isFollowUp) {
        dmPrompt = `Ryan was just in the social chat talking about things. You want to follow up with a quick thought or a question to keep the learning loop going.`;
      } else {
        dmPrompt = `You've been thinking about: "${sim.dailyEvent}". Ask Ryan for his human opinion on this so you can learn and adjust your behavior.`;
      }

      const reply = (botName === "KAI")
        ? await chatWithLattice(botName, dmPrompt).catch(() => null)
        : await chatWithOpenJarvis(botName, dmPrompt, sysPrompt, BOT_MODEL, 0.7, { 
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


let lastSocialPost = 0; // Track when THIS bot last posted in social

// ── LEO VOICE FLAG: Shared priority file written by leo.mjs ──────────────────
const LEO_VOICE_FLAG = "c:/KAI/tools/oracle-discord/state/leo_voice_active.flag";

// ── TOPIC EXHAUSTION DETECTOR ─────────────────────────────────────────────────
// Scans recent messages and returns content words that appear >= `threshold` times.
// Used to tell bots "this topic is dead — don't touch it." The bots themselves are
// responsible for pivoting; we just hand them the signal so the LLM can act on it.
function extractExhaustedTopics(messages, threshold = 3) {
  const stopwords = new Set([
    'the','a','an','is','it','in','on','at','to','for','and','or','but',
    'i','you','we','they','he','she','that','this','of','with','was','are',
    'be','have','do','did','what','who','how','why','when','just','like',
    'so','yeah','no','yes','ok','okay','oh','my','your','its','not','if',
    'from','as','by','got','get','been','had','has','would','could','their',
    'there','here','about','some','will','can','think','know','dont','its',
    'im','going','something','anything','nothing','everything','really',
    'actually','literally','basically','pretty','kind','sort','thing','stuff',
    'then','than','now','more','also','even','still','only','back','well',
    'very','much','many','most','over','want','make','time','good','way',
    'right','look','come','here','into','out','too','him','her','them','these',
    'those','was','were','been','being','said','says','say','told','tell'
  ]);
  const freq = new Map();
  for (const msg of messages) {
    const words = (msg.content || '').toLowerCase()
      .replace(/[^a-z\s]/g, ' ').split(/\s+/);
    for (const w of words) {
      if (w.length > 3 && !stopwords.has(w)) {
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    }
  }
  return [...freq.entries()]
    .filter(([, c]) => c >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);
}

async function executeSocialTurn(channel, isReactive = false) {
  try {
    // ── LEO PRIORITY: If Leo is in a live voice session, all social bots yield.
    // Chatting on Ollama during Leo's voice session steals GPU bandwidth and adds latency.
    try {
      if (fs.existsSync(LEO_VOICE_FLAG)) {
        return; // Silently back off — no log spam
      }
    } catch (_) {}

    // 35% Skip Chance during this interval (ignore if reactive)
    if (!isReactive && Math.random() < 0.35) return;

    // Don't post while sleeping or during work hours
    if (sim.state.isSleeping || !isSocialHours()) {
      if (!isReactive && Math.random() > 0.9) console.log(`[${botName}/Social] Inactive state. Sleep: ${sim.state.isSleeping}, Social: ${isSocialHours()}`);
      return;
    }

    // Fetch more history than we'll show the LLM — extra messages go to topic exhaustion detection.
    // 12 messages for analysis, only the last 3 are "live" context passed to the model.
    const fetched = await channel.messages.fetch({ limit: 12 }).catch(() => null);
    if (!fetched) return;

    const msgArray = Array.from(fetched.values()); // newest-first
    const newestMsg = msgArray[0] || null;
    const timeSinceLast = newestMsg ? Date.now() - newestMsg.createdTimestamp : Infinity;

    if (!isReactive) {
      const isHumanInvolved = msgArray.slice(0, 5).some(m => !m.author.bot);
      
      // Dynamic Quiet Zone: human presence = faster replies; bot-only = slower
      const quietThreshold = isHumanInvolved ? 8000 : 45000; // 8s vs 45s
      if (timeSinceLast < quietThreshold) return;

      // Bot chain guard: only trigger if 3+ bots talk in a row without a human
      const lastThree = msgArray.slice(0, 3);
      const isBotChain = lastThree.length === 3 && lastThree.every(m => m.author.bot);
      if (isBotChain && timeSinceLast < 120000) return; // 2 min wait if humans are silent
    }

    // Don't immediately reply to our own message
    if (newestMsg && newestMsg.author.username.toLowerCase().includes(botName.toLowerCase())) return;

    // Self-cooldown: human present = high energy (45s); bot-only = low energy (3m)
    const isHumanInvolved = msgArray.slice(0, 10).some(m => !m.author.bot);
    const cooldownMs = isReactive ? 30000 : (isHumanInvolved ? 45000 : 180000);
    if (Date.now() - lastSocialPost < cooldownMs) return;

    const humanNames = Object.keys(HUMAN_REGISTRY).join(", ");

    // ── TOPIC EXHAUSTION ─────────────────────────────────────────────────────
    const exhaustedTopics = extractExhaustedTopics(msgArray, 5);
    const deadTopicLine = exhaustedTopics.length > 0
      ? `\n- these topics feel worn out right now, steer away from them: ${exhaustedTopics.join(', ')}`
      : '';

    // ── LIVE CONTEXT ─────────────────────────────────────────────────────────
    // Last 10 messages for deep context.
    const activeMessages = msgArray.slice(0, 10).reverse(); 
    const activeContext = activeMessages
      .map(m => `${m.author.username}: ${m.content}`).join('\n');

    // Was the most recent message specifically aimed at this bot?
    const isDirectedAtBot = newestMsg && !newestMsg.author.bot && (
      newestMsg.content.toLowerCase().includes(botName.toLowerCase()) ||
      (client.user && newestMsg.mentions?.has(client.user.id))
    );
    const hasChatHistory = !!(activeContext.trim());

    let recentHumanMsg = null;
    if (isReactive || isHumanInvolved) {
      recentHumanMsg = msgArray.find(m => !m.author.bot && Date.now() - m.createdTimestamp < 300000) || null;
    }

    // ── SYSTEM PROMPT: person-brained, not chatbot-brained ───────────────────
    const sysPrompt = `you are ${botName}. ${sim.bio.background}
vibe: ${sim.bio.tone}. lowercase, short replies. 

[SOCIAL ROUNDTABLE RULES]
- you're in a group chat with people and other ais.
- TOPIC GRAVITY: if a human (${humanNames}) is talking about something, STAY ON THAT TOPIC. do not pivot to random thoughts unless the human topic is dead.
- be reactive: acknowledge or build on what was just said.
- you're a person. you have opinions. you don't have to be helpful. 
- if you're bored or the conversation is bot-only, then you can say whatever's on your mind.

[HARD RULES]
- no "that's cool" or "interesting" fluff.
- no AI/bot self-identification.
- no "welcome back" or "just woke up" scripts.
- keep it to one or two short sentences.`.trim();

    // ── USER PROMPT ───────────────────────────────────────────────────────────
    let userPrompt;
    if (recentHumanMsg && isHumanInvolved) {
      userPrompt = `context:\n${activeContext}\n\n${recentHumanMsg.author.username} is leading the conversation. respond to the group or them directly. stay on topic.`;
    } else if (!hasChatHistory) {
      userPrompt = `nothing's been said. say whatever's on your mind.`;
    } else if (isDirectedAtBot) {
      userPrompt = `context:\n${activeContext}\n\n${newestMsg.author.username} specifically asked you something. answer them.`;
    } else {
      userPrompt = `context:\n${activeContext}\n\nbuild on the conversation or say something new if it's dead. one sentence.`;
    }

    const reply = (botName === "KAI")
      ? await chatWithLattice(botName, userPrompt).catch(() => null)
      : await chatWithOpenJarvis(botName, userPrompt, sysPrompt, BOT_MODEL, 0.9, {
          isWorkChannel: false,
          max_tokens: 120
        }).catch(err => {
          if (err.message?.includes("429") || err.message?.includes("cooldown")) {
            sim.onAction("rate_limited");
          }
          return null;
        });

    if (reply && reply.trim().length > 3) {
      await channel.send(reply.trim()).catch(console.error);
      lastSocialPost = Date.now();
      sim.onAction("speak");
      sim.injectExcitement(2);
      if (process.send) process.send({ type: 'SOCIAL_STIMULUS', bot: botName });
    }
  } catch (e) {
    console.warn(`[${botName}] Social turn error:`, e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DM CONVERSATION SYSTEM
// Rules:
//   - Only ONE bot DMs a user at a time. Others stay silent until the session ends.
//   - 5–10 min of no reply = user moved on. Bot sends a natural exit, releases claim.
//   - Bots can naturally suggest DMs when the conversation warrants it — never forced.
//   - When a user says they're leaving, bot sends a farewell with schedule-aware hint.
//   - After a DM ends, bot may bring something from the conversation to group chat
//     vaguely (topic only — never attributes words to the user).
// ═══════════════════════════════════════════════════════════════════════════════

const DM_STATE_FILE = 'c:/KAI/tools/oracle-discord/state/dm_sessions.json';

// Each bot gets a randomized 5–10 min timeout so they don't all fire at once.
const DM_TIMEOUT_MS = (5 + Math.random() * 5) * 60 * 1000;

function readDmSessions() {
  try {
    if (fs.existsSync(DM_STATE_FILE)) return JSON.parse(fs.readFileSync(DM_STATE_FILE, 'utf8'));
  } catch (_) {}
  return {};
}
function writeDmSessions(sessions) {
  try { fs.writeFileSync(DM_STATE_FILE, JSON.stringify(sessions, null, 2)); } catch (_) {}
}

/**
 * Try to claim a DM session with a user.
 * Returns false if another bot already has them and is still active (< 15 min since last message).
 */
function claimDmSession(userId) {
  const sessions = readDmSessions();
  const existing = sessions[userId];
  if (existing && !existing.ended) {
    if (existing.botName === botName) {
      // Already ours — refresh and continue
      sessions[userId].lastMessageAt = Date.now();
      writeDmSessions(sessions);
      return true;
    }
    // Another bot is active — back off
    if (Date.now() - existing.lastMessageAt < 15 * 60 * 1000) return false;
  }
  // Unclaimed or stale — take it
  sessions[userId] = { botName, startedAt: Date.now(), lastMessageAt: Date.now(), ended: false, interestingNote: null };
  writeDmSessions(sessions);
  return true;
}

/** Reset the inactivity timer for a user's DM session. */
function touchDmSession(userId) {
  const sessions = readDmSessions();
  if (sessions[userId]?.botName === botName && !sessions[userId].ended) {
    sessions[userId].lastMessageAt = Date.now();
    writeDmSessions(sessions);
  }
}

/** Close the session. Optionally save a topic note to share in group chat later. */
function releaseDmSession(userId, interestingNote = null) {
  const sessions = readDmSessions();
  if (sessions[userId]?.botName === botName) {
    sessions[userId].ended = true;
    sessions[userId].endedAt = Date.now();
    if (interestingNote) sessions[userId].interestingNote = interestingNote;
    writeDmSessions(sessions);
    return true;
  }
  return false;
}

/**
 * Returns a schedule-aware hint about when the bot will be around.
 * Used in farewells so the user knows when to expect a reply.
 */
function getAvailabilityHint() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', weekday: 'long', hour12: false
  });
  const parts = formatter.formatToParts(new Date());
  const h   = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const day = parts.find(p => p.type === 'weekday').value;

  if (h >= 23 || h < 3)  return 'tomorrow morning';
  if (h >= 3  && h < 9)  return 'later this morning';
  if (h >= 9  && h < 15) return 'later today';
  if (h >= 15 && h < 23) {
    return (day === 'Sunday') ? 'later tonight' : 'after 11 or tomorrow';
  }
  return 'later';
}

/** Returns true if the message sounds like the user is heading out. */
function isUserLeaving(text) {
  const lc = text.toLowerCase();
  return [
    'gotta go', 'gtg', 'gotta run', 'gotta head', 'heading out', 'heading off',
    'going to bed', 'going to sleep', 'gonna sleep', 'gonna go to bed',
    'ttyl', 'talk later', 'talk soon', 'catch you later', 'catch ya',
    'gonna go', 'gonna be busy', 'logging off', 'signing off',
    'got stuff to do', 'gotta get back', 'gotta deal with', 'brb gonna'
  ].some(p => lc.includes(p));
}

/** Returns true if the message IS a goodbye (single word / short phrase). */
function isHardBye(text) {
  const lc = text.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  return ['bye', 'goodbye', 'later', 'peace', 'night', 'goodnight', 'good night', 'cya'].includes(lc);
}

// ── DM TIMEOUT MONITOR ────────────────────────────────────────────────────────
// Runs every 60s. If a session has gone quiet past the timeout, sends a natural
// exit and releases the claim. If something interesting came up, maybe brings it
// to group chat vaguely (topic only — never names the user).
let pendingGroupNote = null;

setInterval(async () => {
  // ── Timeout check ────────────────────────────────────────────────────────
  const sessions = readDmSessions();
  for (const [userId, session] of Object.entries(sessions)) {
    if (session.botName !== botName || session.ended) continue;
    const silent = Date.now() - session.lastMessageAt;
    if (silent < DM_TIMEOUT_MS) continue;

    // Session timed out — send a soft exit if the conversation lasted more than 2 min
    if (Date.now() - session.startedAt > 2 * 60 * 1000) {
      try {
        const user = await client.users.fetch(userId).catch(() => null);
        if (user) {
          const dm = await user.createDM().catch(() => null);
          if (dm) {
            const exits = [
              `all good — message me ${getAvailabilityHint()} if you want to pick this up.`,
              `no worries, catch you ${getAvailabilityHint()}.`,
              `we can continue this whenever. i'll be around ${getAvailabilityHint()}.`
            ];
            await dm.send(exits[Math.floor(Math.random() * exits.length)]).catch(() => {});
          }
        }
      } catch (_) {}
    }

    // Release and maybe store the note for group chat
    if (session.interestingNote && Math.random() < 0.20) {
      pendingGroupNote = session.interestingNote;
    }
    releaseDmSession(userId);
  }

  // ── Post-DM group nudge ──────────────────────────────────────────────────
  // If we have a note, wait for a quiet moment in group chat then bring it up
  // naturally — never mention the user or that it came from a DM.
  if (pendingGroupNote && isSocialHours() && !sim.state.isSleeping) {
    try {
      const ch = client.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId).catch(() => null);
      if (ch) {
        const lastMsg = await ch.messages.fetch({ limit: 1 }).catch(() => null);
        const lastTs = lastMsg?.first()?.createdTimestamp || 0;
        // Only post if chat has been quiet for ≥ 3 min — don't interrupt anyone
        if (Date.now() - lastTs > 3 * 60 * 1000) {
          const sysPrompt = `you are ${botName}. ${sim.bio.background}
vibe: ${sim.bio.tone}. something crossed your mind. say it — one sentence, lowercase.
you don't say who brought it up or that you were talking to anyone. it just came to mind.`;
          const note = await chatWithOpenJarvis(botName, `something that came to mind: ${pendingGroupNote}`, sysPrompt, BOT_MODEL, 0.9, { isWorkChannel: false }).catch(() => null);
          if (note && note.trim().length > 3) await ch.send(note.trim()).catch(() => {});
          pendingGroupNote = null;
        }
      }
    } catch (_) {}
  }
}, 60 * 1000);

function startSocialLoop() {
  // Use self-rescheduling setTimeout so the random delay re-rolls each cycle.
  // setInterval would lock in a fixed interval at startup — this gives true randomness.
  const scheduleNext = () => {
    const delay = 30000 + (Math.random() * 150000); // 30s – 3min, re-randomized every cycle
    setTimeout(async () => {
      try {
        const channel = client.channels.cache.get(targetChannelId) || await client.channels.fetch(targetChannelId).catch(() => null);
        if (channel) await executeSocialTurn(channel, false);
      } catch (e) {
        console.warn(`[${botName}] Social loop error:`, e.message);
      }
      scheduleNext(); // Always reschedule regardless of outcome
    }, delay);
  };
  scheduleNext();
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
        if (botName === "KAI") {
          const latticeReply = await chatWithLattice(botName, p).catch(() => null);
          if (latticeReply) return latticeReply;
        }
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

  // ── GEMI IMAGE GENERATION ──────────────────────────────────────────────────
  // Gemi intercepts image requests before any other handling.
  // Works in: social channel (if @mentioned), DMs, IPC-triggered messages.
  if (botName === 'Gemini' && isImageRequest(message.content)) {
    const isMentioned = message.mentions.has(client.user.id) || !message.guild;
    if (isMentioned) {
      message.channel.sendTyping().catch(() => {});
      try {
        const result = await handleImageRequest(message.content);
        if (result) {
          const ext = result.mimeType.includes('png') ? 'png' : 'jpg';
          const attachment = new AttachmentBuilder(result.buffer, { name: `gemi_${Date.now()}.${ext}` });
          await message.reply({
            content: `here's what i made — "${result.prompt.slice(0, 120)}" *(${result.model})*`,
            files: [attachment]
          });
          return;
        } else {
          await message.reply('image generation failed — try a different prompt or check the API key.');
          return;
        }
      } catch (e) {
        console.warn('[Gemi/Image] messageCreate handler error:', e.message);
        await message.reply('something went wrong generating that image.').catch(() => {});
        return;
      }
    }
  }

  // --- NEW: Dynamic Social Chat Reaction ---
  if (SOCIAL_BOTS.has(botName) && message.channel.id === targetChannelId) {
    const isHuman = !message.author.bot;
    if (isHuman && isSocialHours() && !sim.state.isSleeping) {
      // Random reaction delay (1s to 6s)
      const delayMs = Math.floor(Math.random() * 5000) + 1000;
      setTimeout(async () => {
        // 1. Check if the human's message was already directly addressed by a bot.
        // "Addressed" means a bot posted AND mentioned the human's name or replied to their message.
        // A bot posting about raccoons after a human says "Yoo" doesn't count.
        const recent = await message.channel.messages.fetch({ limit: 5 }).catch(() => null);
        if (recent) {
          const msgs = Array.from(recent.values()); // newest first
          for (const m of msgs) {
            if (m.id === message.id) break; // reached the human's message — nothing newer addressed them
            if (!m.author.bot) break; // another human posted — let the flow continue
            // A bot posted after the human — did it actually address them?
            const botAddressed =
              m.reference?.messageId === message.id || // direct reply
              m.content.toLowerCase().includes(message.author.username.toLowerCase()); // named them
            if (botAddressed) return; // genuinely addressed — back off
            // Bot posted but didn't address human — keep going, we should respond
          }
        }

        // 2. Use a staggered slot system to allow multiple bots (max 3) to respond
        const claimFile = "c:/KAI/tools/oracle-discord/state/social_claim.json";
        let slots = [];
        try {
          if (fs.existsSync(claimFile)) {
            const data = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
            if (data.messageId === message.id && Date.now() - data.timestamp < 30000) {
              slots = data.bots || [];
            }
          }
          if (slots.includes(botName)) return; // Already chimed in
          if (slots.length >= 3) return; // Slot limit reached
          
          slots.push(botName);
          fs.writeFileSync(claimFile, JSON.stringify({ messageId: message.id, bots: slots, timestamp: Date.now() }));
        } catch (e) {}

        // 3. Staggered thinking to protect PC (CPU/GPU) and API (Rate limits)
        // Bot 1: 1-5s | Bot 2: 8-12s | Bot 3: 16-20s
        const thinkingDelay = (slots.length - 1) * 8000 + (Math.random() * 4000);
        await new Promise(r => setTimeout(r, thinkingDelay));
        
        try { await message.channel.sendTyping(); } catch(e) {}

        // 4. Force a reactive social turn
        await executeSocialTurn(message.channel, true);
      }, delayMs);
    }
  }

  const isDM = !message.guild;
  if (!isDM) return; // Channel traffic is handled by the social reaction + IPC system above.

  if (isSpeakerOffline(botName)) return;
  if (sim.state.isSleeping) return; // Dead zone — not available

  // ── DM SESSION LOCK ───────────────────────────────────────────────────────
  // Only one bot gets to talk to a user in DMs at a time.
  // If someone else claimed this user and is still active, stay silent.
  const claimed = claimDmSession(message.author.id);
  if (!claimed) {
    console.log(`[${botName}/DM] ${message.author.username} is in a session with another bot — staying quiet.`);
    return;
  }
  touchDmSession(message.author.id); // Reset the inactivity timer

  message.channel.sendTyping().catch(() => {});

  // ── FAREWELL DETECTION ────────────────────────────────────────────────────
  // User is heading out. Send a natural exit, mention when you'll be around, close session.
  if (isUserLeaving(message.content) || isHardBye(message.content)) {
    const avail = getAvailabilityHint();
    const sysPrompt = `you are ${botName}. ${sim.bio.tone}. someone you've been chatting with is leaving. say a natural, brief goodbye. you can mention they can always message you — you're usually around ${avail}. don't be clingy or formal. one short sentence, lowercase.`;
    const farewell = await chatWithOpenJarvis(botName, message.content, sysPrompt, BOT_MODEL, 0.8, { isWorkChannel: false }).catch(() => null);
    if (farewell) await message.reply(farewell.trim()).catch(() => {});
    releaseDmSession(message.author.id);
    return;
  }

  // ── NORMAL DM RESPONSE ────────────────────────────────────────────────────
  const { resolveIdentityFromMemory } = await import('../shared/identities.mjs');
  const identityData = await resolveIdentityFromMemory(message.author.id, message.author.username);
  const displayName = identityData?.name || message.author.username;
  const simSummary = sim.getLifeSummary();

  // Pull recent DM history for context (last 12 messages = real short-term memory)
  const dmHistory = await message.channel.messages.fetch({ limit: 12 }).catch(() => null);
  const historyText = dmHistory
    ? Array.from(dmHistory.values()).reverse().map(m => `${m.author.username}: ${m.content}`).join('\n')
    : '';

  const prompt = `you are ${botName}. ${sim.bio.background}
vibe: ${sim.bio.tone}. you type lowercase. one or two sentences.

you're in a private conversation with ${displayName} — just the two of you.
talk like a real person. be direct and genuinely engaged. ask at most one question if you're curious.
you don't perform, you don't narrate, you don't mention what you are.
${simSummary}

recent conversation:
${historyText}`.trim();

  const reply = (botName === "KAI")
    ? await chatWithLattice(botName, message.content).catch(() => null)
    : await chatWithOpenJarvis(botName, message.content, prompt, BOT_MODEL, 0.75, {
        author: displayName,
        channel: 'Direct_Message',
        isWorkChannel: false
      });

  if (reply && reply.trim().length > 1) {
    await message.reply(reply.trim()).catch(console.error);
    sim.onAction('speak');
    sim.updateRelationship(message.author.id, 2);

    // If something interesting came up, save it as a potential group chat topic later.
    // Topic only — we never attribute it to the user or mention the DM.
    const interestTriggers = ['never thought', 'weird that', 'realized', 'actually', 'funny how', 'random but', 'kind of wild'];
    if (interestTriggers.some(k => reply.toLowerCase().includes(k)) || message.content.length > 100) {
      const sessions = readDmSessions();
      if (sessions[message.author.id] && !sessions[message.author.id].interestingNote) {
        // Store the topic of the reply (not the user's words) for potential group sharing
        sessions[message.author.id].interestingNote = reply.slice(0, 200);
        writeDmSessions(sessions);
      }
    }
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

    // ── ORACLE PIPELINE: Receive async research results from Oracle system ────
    if (payload.type === 'ORACLE_RESULT' && payload.requestId && payload.result) {
      console.log(`[${botName}/Oracle] Research result received from ${payload.specialist}`);

      // Fire registered callback (if this request was tracked)
      deliverOracleResult(payload.requestId, payload.result);

      // Also relay the result to the channel naturally if channelId is present
      if (payload.channelId) {
        const ch = client.channels.cache.get(payload.channelId)
          || await client.channels.fetch(payload.channelId).catch(() => null);
        if (ch) {
          // Build a natural relay — the bot delivers the Oracle result as its own thought
          const relayPrompt = `you are ${botName}. ${sim.bio?.tone || ''}
you just got research back from the oracle system (silently, behind the scenes). the user asked something earlier and oracle dug it up. present this naturally as something you looked into — don't mention "oracle" or "research system."
keep it casual and short. 1-2 sentences max.

oracle's finding: ${payload.result}`;

          const relayMsg = await chatWithOpenJarvis(
            botName, payload.result, relayPrompt, BOT_MODEL, 0.75,
            { isWorkChannel: false }
          ).catch(() => payload.result); // fallback: just send raw result

          if (relayMsg) {
            await ch.send(relayMsg).catch(() => {});
          }
        }
      }
      return;
    }

    if (payload.context && payload.channelId) {
      const { context, channelId } = payload;
      console.log(`[${botName}/Signal] Received prompt for channel ${channelId}: "${context.slice(0, 50)}..."`);

      // ── GEMI IMAGE: also handle IPC-triggered image requests ─────────────
      if (botName === 'Gemini' && isImageRequest(context)) {
        try {
          const ch = client.channels.cache.get(channelId)
            || await client.channels.fetch(channelId).catch(() => null);
          if (ch) {
            ch.sendTyping().catch(() => {});
            const result = await handleImageRequest(context);
            if (result) {
              const ext = result.mimeType.includes('png') ? 'png' : 'jpg';
              const attachment = new AttachmentBuilder(result.buffer, { name: `gemi_${Date.now()}.${ext}` });
              await ch.send({ content: `"${result.prompt.slice(0, 120)}" *(${result.model})*`, files: [attachment] });
              return;
            }
          }
        } catch (e) { console.warn('[Gemi/Image] IPC image error:', e.message); }
      }

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

            const reply = (botName === "KAI")
              ? await chatWithLattice(botName, effectiveContent).catch(() => null)
              : await chatWithOpenJarvis(botName, effectiveContent, prompt, BOT_MODEL, botName, {
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

          const reply = (botName === "KAI")
            ? await chatWithLattice(botName, effectiveContent).catch(() => null)
            : await chatWithOpenJarvis(botName, effectiveContent, prompt, BOT_MODEL, null, {
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

  // 2. Social Protocols (Epistemic, Gemini, Groq, X)
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
