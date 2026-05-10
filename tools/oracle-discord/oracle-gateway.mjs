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
import { startSentinel } from './shared/sentinel.mjs';
import { processOracleQueue } from './shared/oracle-pipeline.mjs';
import { queryLattice } from './shared/lattice-bridge.mjs';
import { runCodingTask, applySandboxFile, isToolServerOnline, makeLLMCaller } from './shared/kai-coder-agent.mjs';
import { fork } from 'child_process';
import path from 'path';

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
  "Claude": "Perform high-level epistemic reasoning, architectural strategy, and complex logic verification.",
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
const ORACLE_API_URL = process.env.ORACLE_API_URL || "http://127.0.0.1:3333";
const MESSAGE_RING_MAX = 120;
const CHANNEL_RINGS = new Map();

// --- IPC SERVER ---
const server = http.createServer(async (req, res) => {
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
          console.log(`[Oracle/Bridge] Routing HELPER_REQUEST from ${payload.requester} to ${payload.targetBot}...`);
          if (payload.port) sendBotSignal(payload.port, payload);
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
  if (message.author.bot) return; // NEVER respond to bots or self
  
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
      return;
    }

    // 2c. General Oracle DM (non-coding) — route through openjarvis as Oracle
    const sysPrompt = `You are Oracle — the central intelligence of the KAI RSHL ecosystem. You are speaking privately to ${from} (${role}). Be direct, concise, and helpful. No emojis.`;
    const reply = await chatWithOpenJarvis('Oracle', text, sysPrompt, 'Oracle-Sovereign', 0.4, { isWorkChannel: false }).catch(() => null);
    if (reply) {
      await message.channel.send(`**Oracle:** ${reply}`).catch(() => {});
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
