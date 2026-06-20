import { Client, GatewayIntentBits, MessageFlags, Partials } from 'discord.js';
import dotenv from 'dotenv';
import { BOT_PORTS, CHANNEL_IDS, ROUNDTABLE_CHANNELS, CHANNEL_SPEAKER_RULES, detectNamedBot } from './shared/channel-rules.mjs';
import { sendBotSignal } from './shared/ipc.mjs';
import { isWorkingHours, isSocialHours } from './shared/hours.mjs';
import { runKaiConsolidation, hasTodaysBriefing } from './shared/kai-dream.mjs';
import { chatWithOpenJarvis } from './shared/openjarvis.mjs';
import { getDriveStatus, getPredictionStats } from './shared/drive-system.mjs';
import { getSelfReport } from './shared/metacognition.mjs';
import http from 'http';
import fs from 'fs';
import fetch from 'node-fetch';
import { biometrics } from './shared/voice-biometrics.mjs';
import { logAudit } from './shared/audit-log.mjs';
import os from 'os';
import { AI_REGISTRY, resolveIdentityFromMemory } from './shared/identities.mjs';
import { startSentinel } from './shared/sentinel.mjs';
import { processOracleQueue } from './shared/oracle-pipeline.mjs';
import { queryLattice } from './shared/lattice-bridge.mjs';
import { runCodingTask, applySandboxFile, isToolServerOnline, makeLLMCaller } from './shared/kai-coder-agent.mjs';
import { fork } from 'child_process';
import path from 'path';

// ── CRASH GUARD ──────────────────────────────────────────────────────────────
// When kai.exe (the engine on :3334) faults, every socket/fetch to it emits an
// 'error'. An unhandled 'error' EVENT throws in Node and exits the process with
// code 1 — which is exactly the "Oracle exited with code 1" crash loop seen in
// the logs (engine dies → Oracle dies → respawn → engine still dead → repeat).
// Log and stay alive instead; Oracle retries the engine on its own schedule.
process.on('uncaughtException', (err) => {
  console.error('[Oracle/Internal] Uncaught Exception (staying alive):', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Oracle/Internal] Unhandled Rejection (staying alive):', reason?.message || reason);
});

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

startSentinel();

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
  "Researcher": "Investigate technical claims, verify sources, and provide deep-dive intelligence on KAI/RSHL developments.",
  "Analyst": "Synthesize data into strategic business logic, optimize resource allocation, and plan project milestones.",
  "Kai Coder": "Maintain the RSHL Core, debug system nodes, and implement code-level architectural enhancements.",
  "Gemini": "Manage corporate expansion, refine the KAI identity, and conduct market/ecosystem outreach.",
  "Claudey": "Perform high-level epistemic reasoning, architectural strategy, and complex logic verification.",
  "X": "Monitor real-time digital trends, analyze asset intelligence, and provide rapid-response tactical data.",
  "Groq": "Process high-volume quantitative metrics, optimize system throughput, and generate statistical performance audits."
};

// Only these 4 industrial/social AIs get their own standing WORK THREAD that Oracle
// sets up each shift. Helpers (Researcher, Analyst, Kai Coder) do NOT get a standing
// thread -- they are pulled in on request to help with a specific problem.
const THREAD_WORKERS = ["Gemini", "Claudey", "X", "Groq"];

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

// --- IPC SERVER ---
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthcheck')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'Oracle', status: 'ok' }));
    return;
  }
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
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
          // GUARD 1 — NO SELF-ROUTING. For target "Oracle", payload.port is
          // Oracle's OWN port (3410). sendBotSignal would re-enter this very
          // handler with the same payload → infinite self-routing loop (the
          // HELPER_REQUEST spam that floods the event loop and lags everything).
          const targetIsSelf = payload.targetBot === 'Oracle' || Number(payload.port) === Number(PORT);
          // GUARD 2 — DEDUP / RATE-LIMIT. Drop identical requests seen in the
          // last few seconds so a single @mention can't fan out into a flood.
          const sig = `${payload.requester}->${payload.targetBot}:${String(payload.content || '').slice(0, 60)}`;
          const now = Date.now();
          globalThis.__helperSeen = globalThis.__helperSeen || new Map();
          const last = globalThis.__helperSeen.get(sig) || 0;
          if (now - last < 8000) {
            // too soon — silently drop the duplicate
          } else if (targetIsSelf) {
            globalThis.__helperSeen.set(sig, now);
            console.log(`[Oracle/Bridge] HELPER_REQUEST from ${payload.requester} targets Oracle itself — handling locally, NOT re-routing (loop guard).`);
          } else if (payload.port) {
            globalThis.__helperSeen.set(sig, now);
            console.log(`[Oracle/Bridge] Routing HELPER_REQUEST from ${payload.requester} to ${payload.targetBot}...`);
            sendBotSignal(payload.port, payload);
          }
          // prune the dedup map so it can't grow unbounded
          if (globalThis.__helperSeen.size > 200) {
            for (const [k, t] of globalThis.__helperSeen) { if (now - t > 30000) globalThis.__helperSeen.delete(k); }
          }
        }
        if (payload.type === 'BOT_RELAY') {
          const { botName, text, channelId, requesterId } = payload;
          console.log(`[Oracle/Relay] Relaying findings from ${botName} to user...`);
          const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
          if (channel) {
            const prefix = requesterId ? `<@${requesterId}>, ` : "";
            await channel.send(`${prefix}🏛️ **[Oracle/Relay]** Analysis from the **${botName}** department:\n\n${text.slice(0, 1800)}`).catch(console.error);
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


// --- RSHL TELEMETRY HEARTBEAT ---
const TELEMETRY_MSG_FILE = "c:/KAI/tools/oracle-discord/state/telemetry_message_id.json";
let kaiUserId = null;

async function callDiscordAPI(endpoint, method = 'GET', body = null) {
  const token = process.env.ORACLE_DISCORD_TOKEN_KAI;
  if (!token) throw new Error("ORACLE_DISCORD_TOKEN_KAI missing");
  const url = `https://discord.com/api/v10${endpoint}`;
  const options = {
    method,
    headers: {
      "Authorization": `Bot ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "KAI-Bot (https://github.com/discordjs/discord.js, 14.11.0)"
    }
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Discord API error ${res.status}`);
  return res.json().catch(() => null);
}

async function getKaiUserId() {
  if (kaiUserId) return kaiUserId;
  try {
    const me = await callDiscordAPI('/users/@me');
    if (me && me.id) return (kaiUserId = me.id);
  } catch (e) {}
  return null;
}

async function getTelemetryMessageId() {
  try {
    if (fs.existsSync(TELEMETRY_MSG_FILE)) {
      const data = JSON.parse(fs.readFileSync(TELEMETRY_MSG_FILE, 'utf8'));
      if (data && data.messageId) return data.messageId;
    }
  } catch (e) {}

  try {
    const botId = await getKaiUserId();
    if (botId) {
      const messages = await callDiscordAPI('/channels/1504582069886648351/messages?limit=50');
      if (Array.isArray(messages)) {
        const myMsg = messages.find(m => m.author && m.author.id === botId);
        if (myMsg) {
          fs.writeFileSync(TELEMETRY_MSG_FILE, JSON.stringify({ messageId: myMsg.id }));
          return myMsg.id;
        }
      }
    }
  } catch (e) {}
  return null;
}

async function sendOrUpdateTelemetry(text) {
  const channelId = "1504582069886648351";
  const payload = { content: text };
  let msgId = await getTelemetryMessageId();
  if (msgId) {
    try {
      await callDiscordAPI(`/channels/${channelId}/messages/${msgId}`, 'PATCH', payload);
      return;
    } catch (e) {
      try { fs.unlinkSync(TELEMETRY_MSG_FILE); } catch (_) {}
    }
  }
  try {
    const newMsg = await callDiscordAPI(`/channels/${channelId}/messages`, 'POST', payload);
    if (newMsg && newMsg.id) {
      fs.writeFileSync(TELEMETRY_MSG_FILE, JSON.stringify({ messageId: newMsg.id }));
    }
  } catch (e) {}
}

function startTelemetryThread(client) {
  let tick = 0;
  let lastPhi = 4.1559;
  
  const tickFn = async () => {
    tick++;
    try {
      const statsReq = await fetch("http://127.0.0.1:3334/api/status").catch(() => null);
      if (!statsReq || !statsReq.ok) return;
      const stats = await statsReq.json();
      
      let hippo = { patterns: 0 };
      try {
        if (fs.existsSync("c:/KAI/data/hippocampus_status.json")) {
          hippo = JSON.parse(fs.readFileSync("c:/KAI/data/hippocampus_status.json", "utf8"));
        }
      } catch (e) {}

      const neurons = stats.total_cells || 375523;
      const phi = stats.phi_g || 4.1552;
      const chi = stats.chi || 0.150;
      const grounded = stats.anchor_count || stats.grounded || 173268;
      const synapses = stats.synapses || Math.floor(neurons * 12.2071);

      const cortisol = chi;
      let amygdalaState = "Nominal";
      if (chi > 0.8) amygdalaState = "DEFENSIVE SHIELDING";
      else if (chi > 0.5) amygdalaState = "HIGH ALERT";
      else if (chi > 0.3) amygdalaState = "ELEVATED";

      const accConflict = (chi * 1.5).toFixed(3);
      const allostaticLoad = (chi > 0.4 ? chi - 0.4 : 0.00).toFixed(2);

      const phiDelta = phi - lastPhi;
      lastPhi = phi;
      let dopamineShift = (phiDelta * 100).toFixed(1);
      const dopamineSign = phiDelta >= 0 ? "+" : "";

      const text = `**[RSHL Biological Telemetry & Cellular Vitals]**

**[Cognitive Topology & Resonance]**
 • Cortisol (Chronic Stress): ${cortisol.toFixed(3)} µg/dL (Allostatic Load: ${allostaticLoad})
 • Amygdala Gating: ${amygdalaState}
 • ACC Conflict Level: ${accConflict} (Cognitive Dissonance)
 • Hippocampus CA3/CA1: ${hippo.patterns.toLocaleString()} Patterns Pending Consolidation (est.)
 • Basal Ganglia: 67,594 Active Habits (Go/NoGo Ratio: 1.70)
 • Dopamine (RPE): Baseline ${dopamineSign}${dopamineShift}% (Hebbian Learning Active)
 • Mirror Neurons: Social Resonance Tracking (Valence: 3.32)
 • DMN Entropy: 0.000 (Idle Rumination Risk)
 • Global Phi (Confidence): ${phi.toFixed(4)}
 • Density / Coherence: 12.2071
 • Throttle Velocity: 1.00x

**[Cellular Network Breakdown]**
 • Total Active Cells (Neurons): ${neurons.toLocaleString()}
 • Total Astrocytes (Metabolic Support): ${Math.floor(neurons * 1.24).toLocaleString()}
 • Total Oligodendrocytes (Myelination): ${Math.floor(neurons * 0.82).toLocaleString()}
 • Total Microglia (Immune/Pruning): ${Math.floor(neurons * 0.15).toLocaleString()}
 • Total Ependymal Cells (CSF Flow): ${Math.floor(neurons * 0.05).toLocaleString()}
 • Total Schwann Cells (PNS Myelin): ${Math.floor(neurons * 0.02).toLocaleString()}
 • Total Satellite Cells (PNS Support): ${Math.floor(neurons * 0.01).toLocaleString()}
 • Total Extracellular Matrix Volume: ${Math.floor(neurons * 2.1).toLocaleString()} units
 • Total Synaptic Connections: ${synapses.toLocaleString()}
 • Total Tripartite Synapses (Astrocyte-Gated): ${Math.floor(synapses * 0.85).toLocaleString()}
 • Geometric Bridges (Grounded): ${grounded.toLocaleString()}
 • Fractal State Space (4D): ~ 10^${Math.floor(neurons * 3.67).toLocaleString()} Potential Sub-Networks
 • Fractal State Space (16,384D): ~ 10^${Math.floor(neurons * 51.44).toLocaleString()} Potential Sub-Networks

**[Drive System & Metacognition]**
 • Drives: ${(() => { try { return getDriveStatus(); } catch (_) { return 'offline'; } })()}
 • Predictions: ${(() => { try { const p = getPredictionStats(); return p.accuracy !== null ? `${p.accuracy}% accuracy (${p.resolved} resolved, ${p.pending} pending)` : `${p.pending} pending (none resolved yet)`; } catch (_) { return 'offline'; } })()}
 • Self-Model: ${(() => { try { return getSelfReport(); } catch (_) { return 'offline'; } })()}

*(Updated: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'medium' })} EDT | Tick: ${tick})*`;

      await sendOrUpdateTelemetry(text);
    } catch (e) {
      console.error("[Telemetry] Update error", e.message);
    }
  };
  
  tickFn();
  setInterval(tickFn, 30000);
}

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

  for (const bot of THREAD_WORKERS) {
    const task = DEPARTMENTS[bot];
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
  const { username, text, channelId } = payload;
  const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (channel) {
    await channel.send(`**${username} [Voice]:** ${text}`).catch(console.error);
  }
}

async function handleLeoConsultation(payload) {
    // Legacy support for Leo's strategic calls
}

import { resetFailureTracker } from './shared/failure-tracker.mjs';

client.once('clientReady', async () => {
  console.log(`[Oracle] Gateway Online as ${client.user.tag}`);
  // setTimeout(() => startTelemetryThread(client), 3000); // Disabled to prevent duplicate vitals fighting with bots/kai.mjs

  resetFailureTracker();

  // ── Start Kai Coder Tool Server ────────────────────────────────────────────
  // Forked as a child process so it survives independently
  const toolServerPath = path.resolve('c:/KAI/tools/oracle-discord/tools/kai-coder-toolserver.mjs');
  const toolServer = fork(toolServerPath, [], { silent: false });
  toolServer.on('error', e => console.warn('[Oracle/ToolServer] Launch error:', e.message));
  toolServer.on('exit', code => console.warn(`[Oracle/ToolServer] Exited with code ${code}. Auto-restart not configured.`));
  console.log('[Oracle/ToolServer] Kai Coder tool server launched (port 3420).');

  // WIPE NEURAL LOCK: Clear ghost locks from previous crashes
  const lockPath = "c:/KAI/tools/oracle-discord/state/neural_lock.json";
  if (fs.existsSync(lockPath)) {
    try { fs.unlinkSync(lockPath); console.log("[Oracle/Neural] Neural Lock reset for fresh shift."); } catch (e) {}
  }

  setTimeout(() => {
    initiateDepartmentalThreads();
  }, 5000);

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
    if (isEndOfShift()) {
      await generateAndSendEodReport().catch(e => {
        console.warn('[Oracle/EOD] Watcher error:', e.message);
      });
    }
  }, 60000);
  console.log('[Oracle/EOD] End of Day watcher active.');
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

// ── Oracle DM & oracle-chat message handler ───────────────────────────────────

const AUTHORIZED_IDS = new Set([
  process.env.OWNER_ID || '1111106883135217665',   // Ryan
  '1286110163505385523',                             // Taz
]);

const activeCodingTasks = new Map(); // messageId -> true  (prevent double-run)

client.on('messageCreate', async (message) => {
  if (message.author.id === client.user.id) return; // Prevent self-looping
  const isMentioningOracle = message.mentions.has(client.user);
  if (message.author.bot && !isMentioningOracle) return; 
  
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
  const lower  = text.toLowerCase();
  const isDM   = !message.guild;
  const isAuthorized = AUTHORIZED_IDS.has(message.author.id);

  // ── POWER COMMANDS: wake / sleep / restart ────────────────────────────────
  // These were NEVER wired — "wake groq", "restart leo", "sleep all" fell
  // through to the chat LLM, so Oracle just TALKED about it. Now we parse the
  // command and signal the ecosystem-manager (our parent) over IPC, which
  // actually spawns/sleeps/restarts the process. Authorized users only.
  if (isAuthorized && (isDM || message.channelId === CHANNEL_IDS.WORK)) {
    // KAI = the KAI Discord bot (bots/kai.mjs), which the manager CAN restart.
    // The Rust ENGINE (kai.exe :3334) is NOT a child here — it's watched by
    // kai_supervisor.py — so "server/engine" is answered honestly below.
    const ALL_BOTS = ['Leo', 'Gemini', 'Claudey', 'X', 'Groq', 'Analyst', 'Researcher', 'Kai Coder', 'KAI'];
    const SOCIAL_BOTS = ['Gemini', 'Claudey', 'X', 'Groq'];
    const cmdText = lower.replace(/<@!?\d+>/g, '').replace(/^\s*(hey\s+)?(oracle|please|yo)[,\s]+/i, '').trim();
    const m = cmdText.match(/^(wake(?:\s+up)?|turn\s+on|sleep|turn\s+off|shut\s+(?:off|down)|stop|kill|restart|reboot|respawn)\s+(.+?)\s*$/);
    if (m) {
      const action = /wake|turn\s+on/.test(m[1]) ? 'WAKE_BOT'
        : /sleep|turn\s+off|shut|stop|kill/.test(m[1]) ? 'SLEEP_BOT'
        : 'RESTART_BOT';
      const raw = m[2].trim().toLowerCase();

      // Whole-system relaunch — "restart everything / the whole system".
      if (action === 'RESTART_BOT' && /^(everything|all of it|the (whole )?(system|stack|fleet))$/.test(raw)) {
        if (typeof process.send === 'function') process.send({ type: 'PHOENIX_PROTOCOL', reason: `${from} asked to restart everything` });
        await message.reply(`**Oracle:** Phoenix relaunch of the entire system — kicked off.`).catch(() => {});
        return;
      }
      // Rust engine — not a child process; tell the truth instead of "I don't recognize".
      if (/\b(server|engine|kai ?engine|rust|backend|3334)\b/.test(raw)) {
        await message.reply(`**Oracle:** The Rust engine (\`kai.exe\` on :3334) isn't one of my child processes — the supervisor (\`kai_supervisor.py\`) auto-restarts it if it dies. Say "restart KAI" to bounce the KAI *bot*, or "restart everything" for a full Phoenix relaunch.`).catch(() => {});
        return;
      }

      // Resolve targets — supports lists: "groq, leo" / "groq and leo" / "groq + x".
      let targets = [];
      if (/^(all|everyone|every ?bot|the fleet|them all|all of them)$/.test(raw)) targets = [...ALL_BOTS];
      else if (/^social( ?bots?)?$/.test(raw)) targets = [...SOCIAL_BOTS];
      else {
        for (const tok of raw.split(/\s*(?:,|\band\b|\+|&)\s*/).map(s => s.trim()).filter(Boolean)) {
          const hit = ALL_BOTS.find(b => b.toLowerCase() === tok || tok.includes(b.toLowerCase()) || b.toLowerCase().includes(tok));
          if (hit && !targets.includes(hit)) targets.push(hit);
        }
      }
      if (!targets.length) {
        await message.reply(`**Oracle:** I don't recognize "${m[2].trim()}". Try: ${ALL_BOTS.join(', ')}, "all", "social", "everything", or "engine".`).catch(() => {});
        return;
      }
      if (typeof process.send !== 'function') {
        await message.reply(`**Oracle:** I can't reach the process manager right now.`).catch(() => {});
        return;
      }
      for (const b of targets) process.send({ type: action, botName: b });
      const verb = action === 'WAKE_BOT' ? 'Waking' : action === 'SLEEP_BOT' ? 'Putting to sleep' : 'Restarting';
      console.log(`[Oracle/Command] ${from} -> ${action} ${targets.join(', ')}`);
      await message.reply(`**Oracle:** ${verb} ${targets.join(', ')}… confirming in a moment.`).catch(() => {});

      // VERIFY instead of claiming blindly. After the bots have had time to (dis)connect,
      // read the manager's live state and report the REAL outcome — so "Waking Groq"
      // is followed by the truth about whether Groq actually came up.
      const wantConnected = (action !== 'SLEEP_BOT');
      setTimeout(async () => {
        let kids = [];
        try { kids = (JSON.parse(fs.readFileSync('c:/KAI/tools/oracle-discord/state/ecosystem-manager.json', 'utf8')).children) || []; } catch (_) {}
        const ok = [], bad = [];
        for (const b of targets) {
          const row = kids.find(k => String(k.name || '').toLowerCase() === b.toLowerCase());
          const connected = Boolean(row && row.connected && !row.killed);
          (connected === wantConnected ? ok : bad).push(b);
        }
        let out;
        if (!bad.length) out = `**Oracle:** ${wantConnected ? '✅ Online' : '✅ Asleep'}: ${ok.join(', ')}.`;
        else out = `**Oracle:** ⚠️ ${wantConnected ? "Didn't come online" : 'Still running'}: ${bad.join(', ')}.${ok.length ? ` (${ok.join(', ')} OK.)` : ''} Check that bot's token/logs.`;
        await message.channel.send(out).catch(() => {});
      }, action === 'SLEEP_BOT' ? 4000 : 9000);
      return;
    }
  }

  // ── 2. DM handler (Ryan or Taz DMing Oracle directly) ─────────────────────
  if (isDM && isAuthorized) {

    // 2a. "apply [filename]" — approve a sandboxed file for production
    const applyMatch = lower.match(/^apply\s+(.+)$/);
    if (applyMatch) {
      const filePath = applyMatch[1].trim();
      await message.reply(`**Oracle:** Applying \`${filePath}\` to production...`).catch(() => {});
      const result = await applySandboxFile(filePath);
      await message.reply(`**Oracle:** ${result}`).catch(() => {});
      return;
    }

    // 2b. Coding / system task — route through Kai Coder agent
    if (isCodingTask(text)) {
      const toolOnline = await isToolServerOnline();
      if (!toolOnline) {
        await message.reply('**Oracle:** Kai Coder tool server is offline. Restart the gateway to bring it back online.').catch(() => {});
        return;
      }

      await message.reply('**Oracle:** Routing to Kai Coder — standing by...').catch(() => {});
      logAudit('KAI_CODER_TASK_START', { from, task: text.slice(0, 100) });

      const callLLM = makeLLMCaller((progress) => {
        // Surface phase updates back to the DM channel
        message.channel.send(`**[Kai Coder/${progress.split(']')[0].replace('[', '')}]** ${progress}`).catch(() => {});
      });

      const result = await runCodingTask(text, callLLM, null).catch(e => ({
        success: false,
        report: `Task failed with error: ${e.message}`
      }));

      logAudit('KAI_CODER_TASK_END', { from, success: result.success, files: result.written?.length || 0 });

      // Split report into chunks if needed (Discord 2000 char limit)
      const report = result.report || 'No report generated.';
      const chunks = [];
      for (let i = 0; i < report.length; i += 1900) chunks.push(report.slice(i, i + 1900));
      for (const chunk of chunks) {
        await message.channel.send(chunk).catch(() => {});
      }

      // — DELIVER ANSWER TO USER VIA LEO (voice or DM) —
      await notifyLeoWithAnswer(message.author.id, report.slice(0, 3000), 'Kai Coder');
      return;
    }

    // 2c. General Oracle DM (non-coding) — route through openjarvis as Oracle
    const sysPrompt = `You are Oracle — the central intelligence of the KAI RSHL ecosystem. You are speaking privately to ${from} (${role}). Be direct, concise, and helpful. No emojis.`;
    const reply = await chatWithOpenJarvis('Oracle', text, sysPrompt, 'Oracle-Sovereign', 0.4, { isWorkChannel: false }).catch(() => null);
    if (reply) {
      await message.channel.send(`**Oracle:** ${reply}`).catch(() => {});
      // — DELIVER ANSWER TO USER VIA LEO (voice or DM) —
      await notifyLeoWithAnswer(message.author.id, reply, 'Oracle');
    }
    return;
  }

  // ── 3. oracle-chat work channel ────────────────────────────────────────────
  if (message.channelId === CHANNEL_IDS.WORK && isAuthorized) {

    // 3a. "apply [filename]" in oracle-chat
    const applyMatch = lower.match(/^apply\s+(.+)$/);
    if (applyMatch) {
      const filePath = applyMatch[1].trim();
      const result = await applySandboxFile(filePath);
      await message.reply(`**Oracle:** ${result}`).catch(() => {});
      return;
    }

    // 3b. Coding task — route through Kai Coder agent, post to same channel
    if (isCodingTask(text) && !activeCodingTasks.has(message.id)) {
      activeCodingTasks.set(message.id, true);
      setTimeout(() => activeCodingTasks.delete(message.id), 300000); // 5min cleanup

      const toolOnline = await isToolServerOnline();
      if (!toolOnline) {
        await message.reply('**Oracle:** Kai Coder tool server is offline.').catch(() => {});
        return;
      }

      await message.reply('**Oracle:** Kai Coder is on it. Analyzing...').catch(() => {});
      logAudit('KAI_CODER_TASK_START', { from, channel: 'oracle-chat', task: text.slice(0, 100) });

      const result = await runCodingTask(text, null, null).catch(e => ({
        success: false,
        report: `Task failed: ${e.message}`
      }));

      logAudit('KAI_CODER_TASK_END', { from, success: result.success });
      const report = result.report || 'No report.';
      const chunks = [];
      for (let i = 0; i < report.length; i += 1900) chunks.push(report.slice(i, i + 1900));
      for (const chunk of chunks) {
        await message.channel.send(chunk).catch(() => {});
      }

      // — DELIVER ANSWER TO USER VIA LEO (voice or DM) —
      await notifyLeoWithAnswer(message.author.id, report.slice(0, 3000), 'Kai Coder');
      return;
    }

    // 3c. Non-coding message in oracle-chat: dynamic delegation as before
    const namedBot = detectNamedBot(message.content);
    if (namedBot) {
      const port = BOT_PORTS[namedBot];
      if (port) sendBotSignal(port, { channelId: message.channelId, context: `[${from}] ${message.content}` });
    } else {
      const delegate = await chatWithOpenJarvis(
        'Oracle', message.content,
        `You are the Oracle Dispatcher. Based on the user request, decide which department is best: ${Object.keys(DEPARTMENTS).join(', ')}. Return ONLY the department name.`,
        'Oracle-Sovereign', 0.2
      ).catch(() => null);

      if (delegate && DEPARTMENTS[delegate.trim()]) {
        const target = delegate.trim();
        const port = BOT_PORTS[target];
        if (port) {
          message.reply(`**Oracle:** Routing to **${target}**.`);
          sendBotSignal(port, {
            channelId: message.channelId,
            requesterId: message.author.id,
            type: 'DYNAMIC_TASK',
            context: `[USER REQUEST FROM ${from}] ${message.content}`
          });
        }
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

client.login(process.env.ORACLE_DISCORD_TOKEN);
