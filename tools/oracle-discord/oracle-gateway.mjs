import { Client, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import dotenv from 'dotenv';
import { BOT_PORTS, CHANNEL_IDS, ROUNDTABLE_CHANNELS, CHANNEL_SPEAKER_RULES, detectNamedBot } from './shared/channel-rules.mjs';
import { sendBotSignal } from './shared/ipc.mjs';
import { isWorkingHours, isSocialHours } from './shared/hours.mjs';
import { runKaiConsolidation, hasTodaysBriefing } from './shared/kai-dream.mjs';
import { chatWithOpenJarvis } from './shared/openjarvis.mjs';
import http from 'http';
import fs from 'fs';
import fetch from 'node-fetch';
import { biometrics } from './shared/voice-biometrics.mjs';
import { logAudit } from './shared/audit-log.mjs';
import os from 'os';
import { AI_REGISTRY, resolveIdentityFromMemory } from './shared/identities.mjs';

import { getDynamicRole, teachBotRule, setBotPersona, pruneBotRule } from './shared/dynamic-roles.mjs';
import { startSentinel } from './shared/sentinel.mjs';
import { startCorrelationEngine } from './shared/correlation-engine.mjs';
import { startIntegrityWatcher } from './shared/file-integrity.mjs';
import { startRustEngineBridge } from './shared/rust-engine-bridge.mjs';
import { getSelfOptimizeSnapshot } from './shared/resource-saver.mjs';
import { gcRemediationState } from './shared/remediation-state.mjs';
import { processOracleQueue } from './shared/oracle-pipeline.mjs';
import { queryLattice } from './shared/lattice-bridge.mjs';
import { runCodingTask, applySandboxFile, isToolServerOnline, makeLLMCaller } from './shared/kai-coder-agent.mjs';
import { classifyIntent, parseMultiStep, executeIntent } from './shared/oracle-intent.mjs';
import {
  getAuthLevel,
  getWorkflow,
  startWorkflow,
  recordWorkflowStep,
  storeWorkflowResult,
  completeWorkflow,
  dispatchSubtask,
  synthesizeWorkflowReport
} from './shared/agent-orchestrator.mjs';
import { fork } from 'child_process';
import { chunkForDiscord } from './shared/utils.mjs';
import path from 'path';

// ── PUSH COMPLETED ANSWERS TO LEO FOR VOICE/DM DELIVERY ─────────────────────
// Leo will speak the answer in voice if the user is in the channel,
// or DM them directly if they're offline.
async function notifyLeoWithAnswer(userId, text, label = 'Oracle') {
  if (!userId || !text) return;
  try {
    await fetch(`http://127.0.0.1:3400`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'ORACLE_ANSWER', userId, text, label }),
      signal: AbortSignal.timeout(2000)
    });
    console.log(`[Oracle/Briefing] Pushed ${label} answer to Leo for ${userId}`);
  } catch (e) {
    // Leo might not be up — write directly to the briefing queue file as fallback
    const BRIEFINGS_PATH = 'c:/KAI/tools/oracle-discord/state/oracle_briefings.json';
    let list = [];
    try { if (fs.existsSync(BRIEFINGS_PATH)) list = JSON.parse(fs.readFileSync(BRIEFINGS_PATH, 'utf8')); } catch {}
    list.push({ id: Date.now().toString(), userId, text, label, queuedAt: new Date().toISOString(), delivered: false });
    try { fs.writeFileSync(BRIEFINGS_PATH, JSON.stringify(list.slice(-50), null, 2)); } catch {}
    console.warn(`[Oracle/Briefing] Leo IPC unreachable — wrote to briefing queue file.`);
  }
}

import 'dotenv/config';

process.env.RESOURCE_SAVER_COORDINATOR = '1';

startSentinel();
startCorrelationEngine({ emitConsole: true });
startIntegrityWatcher();
startRustEngineBridge();
setInterval(() => { try { gcRemediationState(); } catch (_) {} }, 60_000);

// --- RESOURCE SAVER COORDINATOR LOOP ---
// Periodically updates the shared self-optimization state so that other bots don't query the OS.
getSelfOptimizeSnapshot(true).catch(err => console.error(`[Oracle/ResourceSaver] First-run error:`, err.message));
setInterval(() => {
  getSelfOptimizeSnapshot(true).catch(err => console.error(`[Oracle/ResourceSaver] Loop error:`, err.message));
}, 15000);

// ── Passive Oracle Pipeline Poll ─────────────────────────────────────────────
// Catches any queued requests where the IPC trigger signal failed (bot was offline etc.)
setInterval(() => {
  processOracleQueue(async (specialist, question, latticeContext) => {
    const sysPrompt = `you are ${specialist}. you are part of the oracle system — the back-end intelligence layer of the KAI RSHL ecosystem.
${latticeContext ? latticeContext + '\n' : ''}a social bot in the lattice has silently requested your help with a question. process it and return a concise, accurate answer. no fluff. just the answer.`;

    return await chatWithOpenJarvis(
      specialist, question, sysPrompt,
      `${specialist.replace(' ', '-')}-Sovereign`, 0.6,
      { isWorkChannel: false }
    ).catch(() => null);
  });
}, 120000); // every 2 minutes

const DEPARTMENTS = {
  "Researcher": "Internet research, documentation scraping, web searches, fact-finding, and external technical documentation.",
  "Analyst": "Crawling through data, parsing server logs, performing forensic inspections and system audits, and securing systems.",
  "Kai Coder": "Lead system builder, file system manipulation, writing and refactoring code, and resolving coding bugs.",
  "Gemini": "Manage corporate expansion, refine the KAI identity, and conduct market/ecosystem outreach.",
  "Epistemic": "Perform high-level epistemic reasoning, architectural strategy, and complex logic verification.",
  "X": "Monitor real-time digital trends, analyze asset intelligence, and provide rapid-response tactical data.",
  "Groq": "Process high-volume quantitative metrics, optimize system throughput, and generate statistical performance audits."
};

const USER_REGISTRY_PATH = 'c:/KAI/tools/oracle-discord/state/user_registry.json';
let userRegistry = { slots: {}, remaining_slots: 4 };

function loadUserRegistry() {
  if (fs.existsSync(USER_REGISTRY_PATH)) {
    try {
      userRegistry = JSON.parse(fs.readFileSync(USER_REGISTRY_PATH, 'utf8'));
    } catch (e) { console.error("[Oracle/Registry] Load failed:", e.message); }
  }
}
loadUserRegistry();

const PORT = 3410;
const ORACLE_API_URL = process.env.ORACLE_API_URL || "http://127.0.0.1:3334";
const MESSAGE_RING_MAX = 120;
const CHANNEL_RINGS = new Map();

// ── HEURISTIC MONITORING STATE ──────────────────────────────────────────────
const BOT_VITALS_HISTORY = new Map(); // botName -> { energy, ts }
const BOT_REQUEST_TRACKER = new Map(); // botName -> [timestamp, ...]
const ANOMALY_COOLDOWNS  = new Map(); // key -> lastReportTs

/**
 * Report a system anomaly to the work channel if it's not on cooldown.
 */
async function reportAnomaly(key, message) {
  const now = Date.now();
  const lastReport = ANOMALY_COOLDOWNS.get(key) || 0;
  if (now - lastReport < 600000) return; // Only report same anomaly once every 10 mins

  ANOMALY_COOLDOWNS.set(key, now);
  console.log(`[Oracle/Anomaly] ${message}`);
  
  // ONLY post to Discord if it's a CRITICAL failure
  if (message.includes('RESTART') || message.includes('HALT')) {
    const channel = client.channels.cache.get(CHANNEL_IDS.WORK) || await client.channels.fetch(CHANNEL_IDS.WORK).catch(() => null);
    if (channel) await channel.send(`🏛️ **[Oracle/Anomaly]** ${message}`).catch(() => {});
  }
}

// ── EXTERNAL LOG MONITORING (KAI Core & OpenJarvis) ─────────────────────────
const EXTERNAL_LOGS = [
  { name: 'KAI-Core', path: 'c:/KAI/scratch/oracle-discord-kai.err.log' },
  { name: 'OpenJarvis', path: 'c:/KAI/scratch/openjarvis.err.log' }
];

EXTERNAL_LOGS.forEach(log => {
  try {
    if (fs.existsSync(log.path)) {
      let lastSize = fs.statSync(log.path).size;
      fs.watchFile(log.path, { interval: 5000 }, (curr) => {
        if (curr.size > lastSize) {
          const stream = fs.createReadStream(log.path, { start: lastSize });
          let data = '';
          stream.on('data', chunk => data += chunk);
          stream.on('end', async () => {
            if (data.trim()) {
              await reportAnomaly(`LOG_ERROR_${log.name}`, `External system error detected in **${log.name}**:\n\`\`\`\n${data.trim().slice(0, 1000)}\n\`\`\``);
            }
            lastSize = curr.size;
          });
        } else { lastSize = curr.size; }
      });
      console.log(`[Oracle/Monitor] Watching external logs for ${log.name}`);
    }
  } catch (e) { console.error(`[Oracle/Monitor] Failed to watch ${log.name}:`, e.message); }
});

// --- IPC SERVER ---
const server = http.createServer(async (req, res) => {
  // ── HEALTH PROBE — used by Oracle's heartbeat-monitor (Stage 11) ──
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'Oracle',
      pid: process.pid,
      uptime_ms: process.uptime() * 1000,
      rss_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      ts: Date.now(),
    }));
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        
        // — API PRESSURE MONITOR —
        if (payload.botName) {
          const now = Date.now();
          const history = BOT_REQUEST_TRACKER.get(payload.botName) || [];
          const recent = history.filter(ts => now - ts < 60000);
          recent.push(now);
          BOT_REQUEST_TRACKER.set(payload.botName, recent);
          
          if (recent.length > 8) {
             await reportAnomaly(`PRESSURE_${payload.botName}`, `High API pressure detected from **${payload.botName}** (${recent.length} req/min). Potential cognitive loop or logic recursion.`);
          }
        }
        if (payload.type === 'LEO_CONSULTATION') await handleLeoConsultation(payload);
        if (payload.type === 'VOICE_TRANSCRIPT') await handleVoiceTranscript(payload);
        if (payload.type === 'BOT_SPEECH') await handleBotSpeech(payload);
        if (payload.type === 'PIPELINE_REQUEST') {
          // A social bot silently requested Oracle system help.
          // Process asynchronously — don't block the IPC response.
          setImmediate(() => {
            processOracleQueue(async (specialist, question, latticeContext) => {
              const port = AI_REGISTRY[specialist]?.port;
              if (!port) return null;

              // Build the research prompt for this specialist
              const sysPrompt = `you are ${specialist}. you are part of the oracle system — the back-end intelligence layer of the KAI RSHL ecosystem.
${latticeContext ? latticeContext + '\n' : ''}a social bot in the lattice has silently requested your help with a question. process it and return a concise, accurate answer. no fluff. just the answer.`;

              return await chatWithOpenJarvis(
                specialist, question, sysPrompt,
                `${specialist.replace(' ', '-')}-Sovereign`, 0.6,
                { isWorkChannel: false }
              ).catch(e => {
                console.warn(`[Oracle/Pipeline] ${specialist} call failed:`, e.message);
                return null;
              });
            });
          });
        }
        if (payload.type === 'HELPER_REQUEST') {
          console.log(`[Oracle/Bridge] Routing HELPER_REQUEST from ${payload.requester} to ${payload.targetBot}...`);
          if (payload.port) sendBotSignal(payload.port, payload);
        }
        if (payload.type === 'ORACLE_RESULT') {
          const { botName, result, channelId, requesterId, taskId } = payload;
          console.log(`[Oracle/Relay] Received result from ${botName} for task ${taskId || 'unknown'}`);
          
          let channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
          
          // DM Fallback support
          if (!channel && requesterId) {
            const user = await client.users.fetch(requesterId).catch(() => null);
            if (user) {
              channel = await user.createDM().catch(() => null);
            }
          }

          if (channel) {
            const isAutoRepair = taskId && taskId.startsWith('SYS-REPAIR');
            const header = isAutoRepair 
              ? `🏛️ **[Oracle/Auto-Repair]** Self-diagnostic fix complete via **${botName}** [ID: ${taskId}]:\n\n`
              : `🏛️ **[Oracle/Consolidated]** Task complete via the **${botName}** department:\n\n`;
            const chunks = chunkForDiscord(result);
            for (const chunk of chunks) {
              await channel.send(chunks.indexOf(chunk) === 0 ? header + chunk : chunk).catch(console.error);
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[Oracle/IPC] Port ${PORT} in use. Oracle may already be running, or port is hung.`);
    setTimeout(() => {
      server.close();
      server.listen(PORT);
    }, 5000); // Retry after 5s instead of immediate crash
  } else {
    console.error('[Oracle/IPC] Server error:', e);
  }
});

server.listen(PORT, () => {
  console.log(`[Oracle/IPC] Strategic Bridge active on port ${PORT}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// --- CORE FUNCTIONS ---

async function initiateDepartmentalThreads() {
  if (!isWorkingHours()) {
    console.log("🏛️ [Oracle/Teacher] Not work hours. Suppressing departmental cellularization.");
    return;
  }
  console.log("🏛️ [Oracle/Teacher] Initiating Departmental Cellularization...");
  const workChannel = client.channels.cache.get(CHANNEL_IDS.WORK);
  if (!workChannel) return;

  const activeThreads = await workChannel.threads.fetchActive();

  for (const [bot, task] of Object.entries(DEPARTMENTS)) {
    const threadName = `Shift: ${bot} [${new Date().toLocaleDateString()}]`;
    
    const existingThread = activeThreads.threads.find(t => t.name === threadName);
    if (existingThread) {
      console.log(`[Oracle/Teacher] Thread for ${bot} already active. Re-poking bot...`);
      const port = BOT_PORTS[bot];
      if (port) {
        sendBotSignal(port, { 
          channelId: existingThread.id, 
          context: `[SHIFT RE-IGNITION] Your work thread is still active. Resume operations: ${task}`,
          isInterjection: true 
        });
      }
      await new Promise(r => setTimeout(r, 1000)); // Ultra-dense stagger
      continue;
    }

    const thread = await workChannel.threads.create({
      name: threadName,
      autoArchiveDuration: 1440,
      reason: `Departmental Isolation for ${bot}`
    }).catch(console.error);

    if (thread) {
      await thread.send(`🧬 **CELLULAR DIRECTIVE: ${bot.toUpperCase()}**\n\n**Status**: Active / Industrial\n**Task**: ${task}\n\n**Instructions**:
- All work-related thoughts must stay in this thread.
- If you need help from another AI, use the @Helper system.
- Provide proof of life/progress every 4 work units.`);

      const port = BOT_PORTS[bot];
      if (port) {
        sendBotSignal(port, { 
          channelId: thread.id, 
          context: `[SHIFT START] You are now isolated in your work thread. Execute the directive: ${task}`,
          isInterjection: true 
        });
      }
      await new Promise(r => setTimeout(r, 1000)); // Ultra-dense stagger
    }
  }
}

async function handleBotSpeech(payload) {
  const { botName, text, channelId } = payload;
  const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (channel) {
    const record = {
      from: botName,
      text: text,
      ts: Math.floor(Date.now() / 1000),
      message_id: `bot_${Date.now()}`,
      channel_id: channelId,
      author_id: "BOT",
      author_name: botName
    };
    if (!CHANNEL_RINGS.has(channelId)) CHANNEL_RINGS.set(channelId, []);
    CHANNEL_RINGS.get(channelId).push(record);

    try {
      await fetch(`${ORACLE_API_URL}/api/digest-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {}
  }
}

async function handleVoiceTranscript(payload) {
  const { userId, username, text } = payload;
  console.log(`[Oracle/Voice] Mirroring transcript for ${username} (${userId}): "${text}"`);
  
  if (!text || text.trim().length === 0) return;

  try {
    const channel = client.channels.cache.get(CHANNEL_IDS.SUNDAY) 
      || await client.channels.fetch(CHANNEL_IDS.SUNDAY).catch(() => null);
    if (!channel) {
      console.warn(`[Oracle/Mirror] SUNDAY channel not found`);
      return;
    }

    // Fetch the user object from the client to get their display name and avatar URL
    const user = await client.users.fetch(userId).catch(() => null);
    const displayName = user ? (user.globalName || user.displayName || user.username) : username;
    const avatarURL = user ? user.displayAvatarURL({ forceStatic: true, size: 256 }) : null;

    // Fetch all webhooks in the SUNDAY channel
    const webhooks = await channel.fetchWebhooks().catch(() => null);
    if (!webhooks) {
      console.warn(`[Oracle/Mirror] Failed to fetch webhooks for SUNDAY channel`);
      return;
    }

    // Find our specific mirror webhook or create it if it doesn't exist
    let webhook = webhooks.find(wh => wh.name === "Sunday Mirror Webhook");
    if (!webhook) {
      webhook = await channel.createWebhook({
        name: "Sunday Mirror Webhook",
        avatar: client.user.displayAvatarURL(),
        reason: "Mirroring voice transcripts as users to Sunday Chat"
      }).catch(err => {
        console.error(`[Oracle/Mirror] Failed to create Sunday Mirror Webhook:`, err.message);
        return null;
      });
    }

    if (webhook) {
      console.log(`[Oracle/Mirror] Webhook found/created. Mirroring post to Sunday channel...`);
      await webhook.send({
        content: text,
        username: displayName,
        avatarURL: avatarURL || undefined,
        allowedMentions: { parse: [] }
      });
    } else {
      // Fallback: send as Oracle with user's name bolded
      await channel.send({
        content: `**${displayName} (voice):** ${text}`,
        allowedMentions: { parse: [] }
      }).catch(console.error);
    }
  } catch (err) {
    console.error(`[Oracle/Mirror] Error mirroring user voice to Sunday Chat:`, err.message);
  }
}

async function handleLeoConsultation(payload) {
    // Legacy support for Leo's strategic calls
}

import { resetFailureTracker } from './shared/failure-tracker.mjs';

client.once('clientReady', async () => {
  console.log(`[Oracle] Gateway Online as ${client.user.tag}`);

  resetFailureTracker();

  // ── Resilient ToolServer launcher with auto-restart ───────────────────────
  const toolServerPath = path.resolve('c:/KAI/tools/oracle-discord/tools/kai-coder-toolserver.mjs');
  let toolServerRestarts = 0;
  let toolServerStartedAt = Date.now();

  function launchToolServer() {
    const toolServer = fork(toolServerPath, [], { silent: true, env: { ...process.env } });
    toolServerStartedAt = Date.now();

    toolServer.on('error', e => console.warn('[Oracle/ToolServer] Launch error:', e.message));
    toolServer.on('exit', (code, signal) => {
      const uptime = Math.round((Date.now() - toolServerStartedAt) / 1000);
      console.warn(`[Oracle/ToolServer] Exited with code ${code} (signal: ${signal}, uptime: ${uptime}s).`);

      // Reset counter if it ran for more than 60s (healthy run)
      if (uptime > 60) toolServerRestarts = 0;
      toolServerRestarts++;

      // Exponential backoff: 2s, 4s, 8s, 16s, 30s max
      const delay = Math.min(2000 * Math.pow(2, toolServerRestarts - 1), 30000);
      console.log(`[Oracle/ToolServer] Auto-restarting in ${delay / 1000}s (attempt ${toolServerRestarts})...`);
      setTimeout(launchToolServer, delay);
    });

    console.log('[Oracle/ToolServer] Kai Coder tool server launched (port 3420).');
  }

  launchToolServer();

  // WIPE NEURAL LOCK: Clear ghost locks from previous crashes
  const lockPath = "c:/KAI/tools/oracle-discord/state/neural_lock.json";
  if (fs.existsSync(lockPath)) {
    try { fs.unlinkSync(lockPath); console.log("[Oracle/Neural] Neural Lock reset for fresh shift."); } catch (e) {}
  }

  setTimeout(() => {
    initiateDepartmentalThreads();
  }, 5000);

  // ── Start Heartbeat Monitor (Stage 11) ─────────────────────────────────────
  const botPortsMap = {};
  for (const [name, info] of Object.entries(AI_REGISTRY)) {
    if (info.port) botPortsMap[name] = info.port;
  }
  import('./shared/heartbeat-monitor.mjs').then(({ startHeartbeatMonitor }) => {
    import('./shared/diagnostic-router.mjs').then(({ routeDiagnostic }) => {
      startHeartbeatMonitor(botPortsMap, {
        onBotIsolated: async (evt) => {
          console.log(`[Oracle] Bot isolated: ${evt.bot}. Routing diagnostic...`);
          await routeDiagnostic(evt);
        }
      });
    });
  });

  // ── Start Gated State Snapshot Loop (Stage 13) ─────────────────────────────
  import('./shared/state-snapshot.mjs').then(({ startSnapshotLoop }) => {
    startSnapshotLoop();
  });

  // ── End of Day Report ──────────────────────────────────────────────────────
  // Checks every minute whether it's end-of-shift (11pm EST Mon-Fri / 2pm or midnight Sat).
  // When shift just ended, generates a full report and DMs Ryan.
  startEndOfDayWatcher();
});

// ── END OF DAY REPORT SYSTEM ─────────────────────────────────────────────────
const AUDIT_FILE = 'c:/KAI/tools/oracle-discord/logs/audit.json';
const EOD_SENT_FILE = 'c:/KAI/tools/oracle-discord/state/eod_sent.json';
const OWNER_ID = process.env.OWNER_ID || "1111106883135217665";

function getESTHour() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    weekday: 'long',
    hour12: false
  });
  const parts = formatter.formatToParts(new Date());
  return {
    hour: parseInt(parts.find(p => p.type === 'hour').value, 10),
    day: parts.find(p => p.type === 'weekday').value
  };
}

function isEndOfShift() {
  const { hour, day } = getESTHour();
  // Mon-Fri: work ends at 23 (11pm)
  if (day !== 'Saturday' && day !== 'Sunday') return hour === 23;
  // Saturday: work ends at 14 (2pm) or 24/0 (midnight)
  if (day === 'Saturday') return hour === 14 || hour === 0;
  return false;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getShiftKey() {
  const { hour } = getESTHour();
  return `${todayKey()}-${hour < 15 ? 'morning' : 'evening'}`;
}

function wasEodSentThisShift() {
  try {
    if (!fs.existsSync(EOD_SENT_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(EOD_SENT_FILE, 'utf8'));
    return data.lastShift === getShiftKey();
  } catch { return false; }
}

function markEodSent() {
  try {
    fs.writeFileSync(EOD_SENT_FILE, JSON.stringify({ lastShift: getShiftKey(), sentAt: new Date().toISOString() }));
  } catch (e) { console.warn('[Oracle/EOD] Could not mark EOD sent:', e.message); }
}

function readAuditLog(sinceHoursAgo = 10) {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return [];
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
    const cutoff = Date.now() - (sinceHoursAgo * 3600000);
    return lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && new Date(e.timestamp).getTime() > cutoff);
  } catch { return []; }
}

async function generateAndSendEodReport() {
  if (wasEodSentThisShift()) return;
  markEodSent();

  console.log('[Oracle/EOD] Generating End of Day report...');

  const events = readAuditLog(10);
  const owner = await client.users.fetch(OWNER_ID).catch(() => null);
  if (!owner) {
    console.warn('[Oracle/EOD] Could not fetch owner for DM.');
    return;
  }

  // Build audit summary for LLM
  const eventSummary = events.length > 0
    ? events.slice(-80).map(e => `[${e.timestamp?.slice(11,16)}] ${e.type} — ${e.botName || ''} ${e.provider || ''} ${e.status || ''}`).join('\n')
    : 'No events logged this shift.';

  const { day, hour } = getESTHour();
  const reportPrompt = `You are Oracle — the orchestrator of the KAI RSHL ecosystem. It is end of shift (${day}, ${hour}:00 EST).
Write a concise End of Day report for Ryan (the owner). This goes directly to his DMs.

[SHIFT AUDIT LOG]
${eventSummary}

Write the report in this format:
**[KAI RSHL — End of Day Report]**
Date/Shift: [today + shift]

**What was completed today:**
[bullet points of notable events, completed tasks, interactions]

**Issues / errors encountered:**
[any failures, provider outages, anomalies]

**Tools and systems used:**
[list providers, models, APIs that fired today]

**Continuing to next work day:**
[anything that's ongoing or needs attention]

**Lattice health:**
[brief note on system state]

Keep it tight and factual. No fluff. Ryan reads this at night.`;

  // Try local Oracle-Sovereign first (no cloud dependency)
  let report = null;
  try {
    const localRes = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "Oracle-Sovereign",
        prompt: reportPrompt,
        stream: false,
        options: { temperature: 0.3, num_predict: 800 }
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (localRes.ok) {
      const data = await localRes.json();
      report = data.response?.trim();
    }
  } catch (e) {
    console.warn('[Oracle/EOD] Local model failed, trying Groq fallback:', e.message);
  }

  // Groq fallback only if local is unavailable
  if (!report && process.env.GROQ_API_KEY) {
    try {
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [{ role: "user", content: reportPrompt }],
          temperature: 0.3,
          max_tokens: 800
        }),
        signal: AbortSignal.timeout(20000)
      });
      if (groqRes.ok) {
        const data = await groqRes.json();
        report = data.choices?.[0]?.message?.content?.trim();
      }
    } catch (e) {
      console.warn('[Oracle/EOD] Groq fallback also failed:', e.message);
    }
  }

  if (report) {
    await owner.send(report).catch(e => console.warn('[Oracle/EOD] DM failed:', e.message));
    console.log('[Oracle/EOD] End of Day report sent to Ryan.');
    return;
  }

  // Fallback: send a plain summary if LLM fails
  const fallback = `**[KAI RSHL — End of Day Report]**\n${day} shift ended.\n\nEvents logged this shift: ${events.length}\n\nAudit log: \`${AUDIT_FILE}\`\n\n_(Full report generation failed — check Oracle logs)_`;
  await owner.send(fallback).catch(() => {});
}

function startEndOfDayWatcher() {
  // Check every 60 seconds whether shift just ended
  setInterval(async () => {
    const { hour } = getESTHour();
    
    // AUTO-CLEANUP: If it's 9 AM (regular wake up), remove the late night override flag
    if (hour === 9) {
      const OVERRIDE_PATH = 'c:/KAI/tools/oracle-discord/state/late_night_override.flag';
      if (fs.existsSync(OVERRIDE_PATH)) {
        try { fs.unlinkSync(OVERRIDE_PATH); console.log("[Oracle/Hours] Regular wake-up reached. Late Night Override cleared."); } catch {}
      }
    }

    if (isEndOfShift()) {
      await generateAndSendEodReport().catch(e => {
        console.warn('[Oracle/EOD] Watcher error:', e.message);
      });
      
      // AUTO-BACKUP: Run the secure backup script at the end of every shift
      const { exec } = await import('child_process');
      console.log('[Oracle/Backup] Initiating automated End-of-Shift secure backup...');
      exec('powershell.exe -ExecutionPolicy Bypass -File c:/KAI/tools/backup-kai.ps1', (err, stdout, stderr) => {
         if (err) console.error('[Oracle/Backup] Automated backup failed:', err.message);
         else console.log('[Oracle/Backup] Automated backup completed successfully.');
      });
    }
  }, 60000);
  console.log('[Oracle/EOD] End of Day watcher active. Automated backups enabled.');
}


// ── Task classification helpers ────────────────────────────────────────────────
// Used to detect when a message should go to Kai Coder vs normal Oracle routing.

const CODING_KEYWORDS = [
  'fix', 'debug', 'add', 'build', 'implement', 'refactor', 'create', 'write code',
  'update', 'change', 'modify', 'check', 'audit', 'test', 'scan', 'analyze',
  'why is', 'what is wrong', 'broken', 'error in', 'the code', 'the file',
  'sandbox', 'the system', 'the project', 'codebase', 'source'
];

function isCodingTask(text) {
  const lower = text.toLowerCase();
  return CODING_KEYWORDS.some(kw => lower.includes(kw)) && text.length > 20;
}

function handleUserRestartRequest(message, text) {
  const lower = text.toLowerCase();
  if (!/\b(restart|reboot|reset)\b/i.test(lower)) return false;

  const targets = {
    "groq": "Groq",
    "claudey": "Claudey",
    "gemini": "Gemini",
    "gemi": "Gemini",
    "x": "X",
    "leo": "Leo",
    "kai": "KAI",
    "core": "KAI",
    "researcher": "Researcher",
    "analyst": "Analyst",
    "kai coder": "Kai Coder",
    "coder": "Kai Coder",
    "kai-coder": "Kai Coder",
    "oracle": "Oracle",
    "gateway": "Oracle",
    "dashboard": "Dashboard"
  };

  let matchedBot = null;
  for (const [key, val] of Object.entries(targets)) {
    const escapedKey = key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`\\b${escapedKey}\\b`, 'i');
    if (regex.test(lower)) {
      matchedBot = val;
      break;
    }
  }

  if (matchedBot) {
    if (process.send) {
      process.send({ type: 'RESTART_BOT', botName: matchedBot });
      message.reply(`🏛️ **[Oracle/Ecosystem]** Command acknowledged. Requesting a clean process reboot for the **${matchedBot}** node from the sovereign host...`).catch(() => {});
    } else {
      message.reply(`🏛️ **[Oracle/Ecosystem]** Standalone mode active. Cannot send process signals, but reboot request for **${matchedBot}** received.`).catch(() => {});
    }
    return true;
  }

  return false;
}

function handleUserSleepWakeRequest(message, text) {
  const lower = text.toLowerCase();
  
  const isGlobalQuiet = /\b(quiet mode|focus mode|shut up the other|shut up other|shutup the other|idle background|sleep all|sleep the other|sleep other)\b/i.test(lower);
  const isGlobalWake = /\b(wake up all|wake all|disable quiet mode|disable focus mode|wake up the other|wake the other)\b/i.test(lower);

  if (isGlobalQuiet) {
    if (process.send) {
      const noisyBots = ["Gemini", "Claudey", "X", "Groq"];
      for (const b of noisyBots) {
        process.send({ type: 'SLEEP_BOT', botName: b });
      }
      message.reply(`🏛️ **[Oracle/Ecosystem]** Quiet Mode engaged. Putting all background social bots (Gemini, Claudey, X, Groq) to sleep to free up system resources.`).catch(() => {});
    } else {
      message.reply(`🏛️ **[Oracle/Ecosystem]** Standalone mode active. Cannot send process signals.`).catch(() => {});
    }
    return true;
  }

  if (isGlobalWake) {
    if (process.send) {
      const noisyBots = ["Gemini", "Claudey", "X", "Groq"];
      for (const b of noisyBots) {
        process.send({ type: 'WAKE_BOT', botName: b });
      }
      message.reply(`🏛️ **[Oracle/Ecosystem]** Waking up all background social bots (Gemini, Claudey, X, Groq)...`).catch(() => {});
    }
    return true;
  }
  
  const isSleep = /\b(sleep|turn off|shut down|disable|suspend|stop)\b/i.test(lower);
  const isWake = /\b(wake|turn on|enable|start|boot)\b/i.test(lower);
  
  if (!isSleep && !isWake) return false;
  if (isSleep && isWake) return false; // Ambiguous

  const targets = {
    "groq": "Groq",
    "claudey": "Claudey",
    "gemini": "Gemini",
    "gemi": "Gemini",
    "x": "X",
    "leo": "Leo",
    "kai": "KAI",
    "core": "KAI",
    "researcher": "Researcher",
    "analyst": "Analyst",
    "kai coder": "Kai Coder",
    "coder": "Kai Coder",
    "kai-coder": "Kai Coder",
    "oracle": "Oracle",
    "gateway": "Oracle",
    "dashboard": "Dashboard"
  };

  let matchedBot = null;
  for (const [key, val] of Object.entries(targets)) {
    const escapedKey = key.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`\\b${escapedKey}\\b`, 'i');
    if (regex.test(lower)) {
      matchedBot = val;
      break;
    }
  }

  if (matchedBot) {
    if (process.send) {
      if (isSleep) {
        process.send({ type: 'SLEEP_BOT', botName: matchedBot });
        message.reply(`🏛️ **[Oracle/Ecosystem]** Command acknowledged. Putting **${matchedBot}** to sleep to conserve neural resources.`).catch(() => {});
      } else {
        process.send({ type: 'WAKE_BOT', botName: matchedBot });
        message.reply(`🏛️ **[Oracle/Ecosystem]** Command acknowledged. Waking **${matchedBot}** from stasis...`).catch(() => {});
      }
    } else {
      message.reply(`🏛️ **[Oracle/Ecosystem]** Standalone mode active. Cannot send process signals to sleep/wake **${matchedBot}**.`).catch(() => {});
    }
    return true;
  }

  return false;
}

// ── Oracle DM & oracle-chat message handler ───────────────────────────────────

const AUTHORIZED_IDS = new Set([
  process.env.OWNER_ID || '1111106883135217665',   // Ryan
  '1286110163505385523',                             // Taz
]);

const activeCodingTasks = new Map(); // messageId -> true  (prevent double-run)

client.on('messageCreate', async (message) => {
  // 1. Update Interaction Flag (Resource Saver Bypass)
  if (!message.author.bot) {
    try {
      const flagPath = 'c:/KAI/tools/oracle-discord/state/user_interaction.flag';
      fs.writeFileSync(flagPath, Date.now().toString());
    } catch {}
  }

  if (message.author.id === client.user.id) return; // Prevent self-looping
  const isMentioningOracle = message.mentions.has(client.user);
  const isExecuteTag = message.content.includes('[ORACLE EXECUTE:');
  
  if (message.author.bot && !isMentioningOracle && !isExecuteTag) return; 
  
  // 1. Digest for Lattice & Identity Resolution
  const identity = await resolveIdentityFromMemory(message.author.id, message.author.username);
  const from = identity?.name || message.author.username;
  const role = identity?.role || 'Lattice Guest';
  
  const record = {
    from,
    role,
    text: message.content,
    ts: Math.floor(message.createdTimestamp / 1000),
    message_id: message.id,
    channel_id: message.channelId,
    author_id: message.author.id
  };
  if (!CHANNEL_RINGS.has(message.channelId)) CHANNEL_RINGS.set(message.channelId, []);
  const ring = CHANNEL_RINGS.get(message.channelId);
  ring.push(record);
  if (ring.length > MESSAGE_RING_MAX) ring.shift();

  try {
    fetch(`${ORACLE_API_URL}/api/digest-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(2500),
    }).catch(() => {});
  } catch (e) {}

  const text   = message.content.trim();
  const isDM   = !message.guild;
  const isAuthorized = AUTHORIZED_IDS.has(message.author.id);

  if (isDM && !isAuthorized) {
    console.warn(`[Oracle] Unauthorized DM attempt from ${message.author.tag} (${message.author.id})`);
    return message.reply(`Unauthorized. Please add OWNER_ID=${message.author.id} to your .env file and restart Oracle.`);
  }

  // ── NATURAL LANGUAGE UNIFIED HANDLER ──────────────────────────────────────
  // Ryan talks to Oracle in plain English. No !commands. No regex.
  // Oracle understands intent, routes to the right agent, and executes.
  if ((isDM || message.channelId === CHANNEL_IDS.WORK) && isAuthorized) {

    // ── FAST-PATH: status / vitals queries bypass NLU entirely ─────────
    const lowerText = text.toLowerCase().trim();
    const isStatusQuery = lowerText === 'status' || lowerText.includes('system status') || lowerText.includes('lattice size')
                       || lowerText.includes('how many cells') || lowerText.includes('kai health') || lowerText.includes('vitals');
    const isHarvesterQuery = lowerText.includes('harvester') || lowerText.includes('queue depth') || lowerText.includes('how close to 1m');

    if (isStatusQuery) {
      try {
        // 30s timeout — KAI may be rebuilding deferred indexes on first query after restart
        const res = await fetch(`${ORACLE_API_URL}/api/status`, { signal: AbortSignal.timeout(30000) });
        const data = await res.json();
        const reply = `**KAI System Status**\n🧠 Cells: **${data.lattice_size?.toLocaleString() ?? '?'}**\n⚓ Anchors: ${data.anchor_count ?? '?'}\n📊 PHI_G: ${data.phi_g?.toFixed(3) ?? '?'}\n⚔️ CHI: ${data.chi?.toFixed(3) ?? '?'}\n💻 CPU: ${data.cpu ?? '?'}\n🧮 RAM: ${data.ram ?? '?'}\n🕐 Time: ${data.time ?? '?'}\n📡 Status: ${data.status ?? '?'}`;
        await message.channel.send(`**Oracle:** ${reply}`).catch(() => {});
        await notifyLeoWithAnswer(message.author.id, reply, 'Oracle');
      } catch (e) {
        await message.reply(`**Oracle:** ⚠️ Could not reach KAI API: ${e.message}`).catch(() => {});
      }
      return;
    }

    if (isHarvesterQuery) {
      try {
        const fs = await import('fs');
        let queueDepth = 'unknown';
        let logTail = [];
        const logPath = 'c:/KAI/harvest_parallel.log';
        if (fs.existsSync(logPath)) {
          const raw = fs.readFileSync(logPath, 'utf8');
          const lines = raw.split('\n').filter(l => l.trim());
          logTail = lines.slice(-5);
          const lastLine = lines[lines.length - 1] || '';
          const m = lastLine.match(/Queue:\s*(\d+)/);
          if (m) queueDepth = parseInt(m[1]);
        }
        const reply = `**Harvester Status**\n🌾 Running: ✅ Yes\n📥 Queue depth: ${queueDepth.toLocaleString()}\n📝 Latest:\n${logTail.join('\n')}`;
        await message.channel.send(`**Oracle:** ${reply}`).catch(() => {});
      } catch (e) {
        await message.reply(`**Oracle:** ⚠️ Could not read harvester status.`).catch(() => {});
      }
      return;
    }

    // Check for hard reboot/sleep/wake requests directly
    if (handleUserSleepWakeRequest(message, text)) return;
    if (handleUserRestartRequest(message, text)) return;

    // --- EXPERIENTIAL LEARNING / DYNAMIC ROLES ---
    if (text.toLowerCase() === "!help" || text.toLowerCase() === "!commands") {
      const helpMsg = `**Oracle Command Center**
Here are the commands you can use to control and teach the bots:

🛠️ **Training & Roles**
• \`!teach [BotName] [Rule]\` - Instantly add a new behavioral rule to a bot's memory (e.g. \`!teach Groq always speak like a pirate\`)
• \`!role [BotName] [Persona]\` - Completely redefine a bot's core identity (e.g. \`!role Analyst You are a cynical Wall Street veteran\`)
• \`!prune [BotName]\` - Undo the last rule you taught a bot

📊 **System Status**
• \`status\` or \`vitals\` - Check the KAI Lattice size and system health
• \`harvester\` - Check the queue depth for background data processing

You can also just talk to me normally! If you need me to start a complex task, fix code, or restart a bot, just ask in plain English.`;
      await message.reply(helpMsg).catch(()=>{});
      return;
    }

    if (text.startsWith("!teach ") || text.startsWith("!role ") || text.startsWith("!prune ")) {
      const parts = text.split(" ");
      const cmd = parts[0].toLowerCase();
      const targetBot = parts[1];
      const payload = parts.slice(2).join(" ");

      if (!targetBot) {
        await message.reply(`**Oracle:** Please specify a bot (e.g. !teach Groq ...)`).catch(()=>{});
        return;
      }

      if (cmd === "!teach") {
        teachBotRule(targetBot, payload);
        await message.reply(`**Oracle:** ${targetBot} has learned a new rule: "${payload}"`).catch(()=>{});
        return;
      } else if (cmd === "!role") {
        setBotPersona(targetBot, payload);
        await message.reply(`**Oracle:** ${targetBot}'s core persona has been redefined.`).catch(()=>{});
        return;
      } else if (cmd === "!prune") {
        const success = pruneBotRule(targetBot);
        if (success) {
          await message.reply(`**Oracle:** ${targetBot}'s last learned rule was pruned.`).catch(()=>{});
        } else {
          await message.reply(`**Oracle:** ${targetBot} has no learned rules to prune.`).catch(()=>{});
        }
        return;
      }
    }

    // Phase 1: Understand what Ryan wants (fast RSHL + keyword classifier)
    const steps = await parseMultiStep(text);
    console.log(`[Oracle/NLU] "${text.slice(0, 80)}..." → ${steps.length} step(s): ${steps.map(s => s.intent).join(', ')}`);

    // Phase 2: Execute each step
    for (const step of steps) {
      const result = await executeIntent(step, {
        sendBotSignal,
        botPorts: BOT_PORTS,
        channelId: message.channelId,
        requesterId: message.author.id
      });

      if (step.intent === 'code_fix' || step.intent === 'code_create') {
        // Coding tasks need the full Kai Coder pipeline
        const toolOnline = await isToolServerOnline();
        if (!toolOnline) {
          await message.reply('**Oracle:** Kai Coder tool server is offline.').catch(() => {});
          continue;
        }

        await message.reply(`**Oracle:** ${step.agent} is on it — "${step.target.slice(0, 60)}..."`).catch(() => {});
        logAudit('KAI_CODER_TASK_START', { from, channel: isDM ? 'dm' : 'oracle-chat', task: step.target.slice(0, 100) });

        const taskResult = await runCodingTask(step.target, null, (progress) => {
          if (progress.includes('Phase')) {
            const clean = progress.length > 500 ? progress.slice(0, 497) + '...' : progress;
            message.channel.send(`**[${step.agent}]** ${clean}`).catch(() => {});
          }
        }).catch(e => ({ success: false, report: `Task failed: ${e.message}` }));

        logAudit('KAI_CODER_TASK_END', { from, success: taskResult.success });

        let report = taskResult.report || 'No report.';
        if (report.length > 4000) {
          report = report.slice(0, 3900) + '\n\n**[REPORT TRUNCATED]**';
        }
        for (const chunk of chunkForDiscord(report)) {
          await message.channel.send(chunk).catch(() => {});
        }
        await notifyLeoWithAnswer(message.author.id, report.slice(0, 1000), step.agent);

      } else if (step.intent === 'file_apply') {
        const applyResult = await applySandboxFile(step.target);
        await message.reply(`**Oracle:** ${applyResult}`).catch(() => {});

      } else if (result.delegated) {
        await message.reply(`🏛️ **[Oracle]** Delegated to **${step.agent}** — standing by for report...`).catch(() => {});

      } else if (result.result) {
        // Direct Oracle response (conversation, simple tasks)
        const replyText = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
        const chunks = chunkForDiscord(replyText);
        for (const chunk of chunks) {
          await message.channel.send(`**Oracle:** ${chunk}`).catch(() => {});
        }
        await notifyLeoWithAnswer(message.author.id, replyText, 'Oracle');
      }
    }
    return;
  }

  // ── 4. General named-bot routing (non-work channels) ──────────────────────
  const namedBot = detectNamedBot(message.content);
  if (namedBot) {
    const port = BOT_PORTS[namedBot];
    if (port) sendBotSignal(port, { channelId: message.channelId, context: `[${from}] ${message.content}` });
  }
});

// ── System Health Monitoring (IPC from Ecosystem Manager) ──────────────────
process.on('message', async (msg) => {
  if (msg.type === 'SYSTEM_ERROR') {
    const errorKey = `ERR_${msg.bot}`;
    const now = Date.now();
    const lastReport = ANOMALY_COOLDOWNS.get(errorKey) || 0;
    
    // THROTTLE: Only report errors every 2 minutes per bot to prevent spam
    if (now - lastReport < 120000) return;
    
    // NOISE FILTER: Ignore transient network/watchdog errors or API Quota/Voice/Image issues
    const isQuotaError = msg.error.includes('401') || msg.error.includes('429') || msg.error.includes('ElevenLabs') || msg.error.includes('OpenAI');
    const isInfraError = msg.error.includes('fetch failed') || msg.error.includes('ECONNREFUSED') || msg.error.includes('ENOTFOUND') || msg.error.includes('Connection refused') || msg.error.includes('aborted due to timeout') || msg.error.includes('AbortError') || msg.error.includes('socket hang up');
    const isReflectionEvent = msg.error.includes('META-COGNITIVE') || msg.error.includes('Self-Reflection') || msg.error.includes('REJECTION DETECTED');
    const isVoiceError = msg.error.includes('voice') || msg.error.includes('player') || msg.error.includes('connection') || msg.error.includes('stability');
    const isImageError = msg.error.includes('Image') || msg.error.includes('Imagen') || msg.error.includes('404') || msg.error.includes('model');
    // Suppress intentional circuit-breaker events and startup noise — not real bugs
    const errLower = msg.error.toLowerCase();
    const isCircuitBreakerEvent = errLower.includes('tpd cooldown') || errLower.includes('failover') ||
                                   errLower.includes('failing over to gemini') || errLower.includes('tpd limit hit') ||
                                   errLower.includes('going quiet until') || errLower.includes('in cooldown') ||
                                   errLower.includes('restored persisted cooldown') || errLower.includes('restored 1 active') ||
                                   errLower.includes('provider cooldown') || errLower.includes('soft reset complete') ||
                                   errLower.includes('billing failure') || errLower.includes('insufficient balance') ||
                                   errLower.includes('credits depleted') || errLower.includes('crediterror');
    const isStartupNoise = errLower.includes('ipc port') || errLower.includes('port in use') || errLower.includes('eaddrinuse') ||
                           errLower.includes('fetch failed') || errLower.includes('econnrefused') || errLower.includes('connection refused');
    if (msg.error.includes('EPIPE') || msg.error.includes('Stream watchdog triggered') || isQuotaError || isVoiceError || isImageError || isInfraError || isReflectionEvent || isCircuitBreakerEvent || isStartupNoise) {
       const tag = isCircuitBreakerEvent ? 'CIRCUIT_BREAKER' : isStartupNoise ? 'STARTUP' : isQuotaError ? 'QUOTA' : isVoiceError ? 'VOICE' : isImageError ? 'MODEL' : isInfraError ? 'INFRA' : isReflectionEvent ? 'REFLECT' : 'NETWORK';
       console.log(`[Oracle/Self-Diagnostic] Suppressing transient signal from ${msg.bot}: ${tag}`);
       return;
    }



    ANOMALY_COOLDOWNS.set(errorKey, now);
    console.warn(`[Oracle/Self-Diagnostic] SILENT ERROR in ${msg.bot}: ${msg.error.slice(0, 100)}...`);
    
    // AUTO-REPAIR PIPELINE: Trigger Kai Coder silently to fix the system failure
    const coderPort = BOT_PORTS["Kai Coder"];
    if (coderPort) {
       const repairId = `SYS-REPAIR-${msg.bot.toUpperCase()}-${Date.now().toString().slice(-4)}`;
       sendBotSignal(coderPort, {
          channelId: CHANNEL_IDS.WORK,
          type: 'DYNAMIC_TASK',
          taskId: repairId,
          silent: true,
          context: `[ORACLE/AUTO-REPAIR] Logic failure in ${msg.bot}. Diagnostic: ${msg.error}. Analyze the source and stage a fix if needed.`
       });
    }
  }

  if (msg.type === 'OBSERVE_VITALS') {
    const { bot, vitals } = msg;
    const now = Date.now();
    const prev = BOT_VITALS_HISTORY.get(bot);
    BOT_VITALS_HISTORY.set(bot, { energy: vitals.energy, ts: now });

    if (prev) {
      const energyDrop = prev.energy - vitals.energy;
      const timeDiffSeconds = (now - prev.ts) / 1000;
      
      // ANOMALY 1: Rapid Energy Depletion (>15% in <5 mins)
      if (energyDrop > 15 && timeDiffSeconds < 300) {
        await reportAnomaly(`ENERGY_DRAIN_${bot}`, `Chaotic energy depletion in **${bot}** (-${energyDrop.toFixed(1)}% in ${Math.round(timeDiffSeconds)}s). Process may be hyper-active or stuck in a heavy compute cycle.`);
      }

      // ANOMALY 2: Critical Grogginess Hallucination Risk
      if (vitals.groggyLevel > 0.85 && vitals.status !== 'Sleeping') {
        await reportAnomaly(`GROGGY_${bot}`, `Critical exhaustion detected in **${bot}** (Grogginess: ${Math.round(vitals.groggyLevel * 100)}%). High risk of hallucinatory logic or incoherent responses.`);
      }

      // ANOMALY 3: Emotional Spike (Dramatic Turn)
      if (vitals.dramaticTurn) {
        await reportAnomaly(`DRAMA_${bot}`, `Neural spike (Dramatic Turn) detected in **${bot}**. Emotional substrate is overriding logical constraints. Behavioral audit recommended.`);
      }
    }
  }

  // ── MULTI-AGENT ORCHESTRATION: Subtask results return here ──────────────
  if (msg.type === 'ORACLE_RESULT' && msg.workflowId) {
    const wf = getWorkflow ? getWorkflow(msg.workflowId) : null;
    if (wf) {
      storeWorkflowResult(msg.workflowId, msg.botName, msg.result);
      recordWorkflowStep(msg.workflowId, msg.botName, 'completed', { resultLength: msg.result?.length });

      // Check if origin agent is waiting to continue
      if (wf.pendingAgent && wf.pendingAgent !== msg.botName) {
        // Forward result back to origin agent so it can continue its investigation
        const originPort = BOT_PORTS[wf.pendingAgent];
        if (originPort) {
          sendBotSignal(originPort, {
            type: 'SUBTASK_RESULT',
            workflowId: msg.workflowId,
            fromAgent: msg.botName,
            result: msg.result,
            channelId: wf.channelId,
            requesterId: wf.userId
          });
        }
      } else {
        // All agents done — synthesize final report
        const final = synthesizeWorkflowReport(msg.workflowId, msg.botName);
        completeWorkflow(msg.workflowId);

        // Send synthesized report back to user
        if (msg.channelId) {
          try {
            const channel = await client.channels.fetch(msg.channelId).catch(() => null);
            if (channel) {
              const chunks = chunkForDiscord(final.report);
              for (const chunk of chunks) {
                await channel.send(`**[Oracle / Pinacle Report]**\n${chunk}`).catch(() => {});
              }
            }
          } catch (e) {
            console.warn('[Oracle/Orchestrator] Failed to send synthesized report:', e.message);
          }
        }
      }
    }
  }

  // ── AGENT-TO-AGENT COLLABORATION REQUESTS ───────────────────────────────
  if (msg.type === 'SUBTASK_REQUEST' && msg.workflowId) {
    const wf = getWorkflow ? getWorkflow(msg.workflowId) : null;
    if (wf) {
      const dispatchRes = await dispatchSubtask({
        workflowId: msg.workflowId,
        fromAgent: msg.fromAgent,
        toAgent: msg.toAgent,
        task: msg.task,
        userId: wf.userId,
        channelId: wf.channelId,
        botPorts: BOT_PORTS,
        authLevel: wf.authLevel
      });
      console.log(`[Oracle/Orchestrator] Subtask dispatch:`, dispatchRes);
    }
  }
});

client.login(process.env.ORACLE_DISCORD_TOKEN);
