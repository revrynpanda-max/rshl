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

import 'dotenv/config';

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
const BOT_NAME = "Oracle";

// --- IPC SERVER FOR DIRECT BOT SIGNALS ---
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        if (payload.type === 'LEO_CONSULTATION') {
          await handleLeoConsultation(payload);
        }
        if (payload.type === 'VOICE_TRANSCRIPT') {
          await handleVoiceTranscript(payload);
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

async function handleLeoConsultation(payload) {
  const { userId, username, text, role } = payload;
  console.log(`[Oracle/Sentinel] Receiving strategic consultation from ${username} (${role})...`);

  const workChannel = client.channels.cache.get(CHANNEL_IDS.WORK);
  if (!workChannel) return;

  // 1. INCEPTION: Create a dedicated thread for the objective
  const thread = await workChannel.threads.create({
    name: `Objective: ${text.slice(0, 50)}...`,
    autoArchiveDuration: 60,
    reason: `Sovereign Directive from ${username}`
  }).catch(console.error);

  if (thread) {
    await thread.send(`📢 **STRATEGIC THREAD INCEPTION**\n[Origin: ${username} / ${role}]\n**Vocal Directive**: "${text}"\n\n**Mission**: Systematic analysis and execution. Every post must include **Proof and Sources**.`);
    
    // 2. SYNTHESIS: Generate the executive plan
    const planPrompt = `You are the ORACLE SENTINEL. A verified operative (${username}, ${role}) has issued a vocal directive: "${text}".
    
    TASK: Compile a systematic, industrial plan. 
    1. Break the objective into components.
    2. Assign specific AIs (Researcher, Analyst, Kai Coder) to these components.
    3. Define the 'Proof' required for each (e.g., "Researcher must provide 3 web sources").
    
    Reply in a structured format:
    PLAN: [Detailed plan]
    INQUIRY: [Any clarifying question for the user]`;

    const planResult = await chatWithOpenJarvis("Oracle", planPrompt, "You are the strategic brain of the lattice.", "llama-3.3-70b-versatile", "Oracle");
    
    if (planResult) {
      await thread.send(`🏛️ **EXECUTIVE PLAN ALIGNED**\n${planResult}`);
      
      // 3. TALK-BACK: Signal Leo to vocalize the summary/inquiry
      const inquiryMatch = planResult.match(/INQUIRY:\s*([\s\S]*)/i);
      const talkBackText = inquiryMatch ? `The Oracle has started the mission, but has a question: ${inquiryMatch[1]}` : "The Oracle has aligned the plan and opened the strategic threads. The roundtable is in motion.";
      
      fetch(`http://127.0.0.1:3400/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ORACLE_INQUIRY', text: talkBackText, objective: text })
      }).catch(() => {});

      // 4. MULTI-AGENT SIGNAL: Poke the bots to join the thread
      const botsToPoke = ["Researcher", "Analyst", "Kai Coder"];
      for (const bot of botsToPoke) {
        const port = BOT_PORTS[bot];
        if (port) {
          sendBotSignal(port, { 
            channelId: thread.id, 
            context: `[STRATEGIC ASSIGNMENT] Join this thread and execute your part of the plan: ${planResult.slice(0, 500)}...`,
            isInterjection: true 
          });
        }
      }
    }
  }
}

async function handleVoiceTranscript(payload) {
  const { userId, username, text, channelId } = payload;
  console.log(`[Oracle/Voice] Mirroring transcript for ${username} in channel ${channelId}`);

  const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (channel) {
    await channel.send(`**${username} [Voice]:** ${text}`).catch(console.error);
  }
}

/**
 * Transcribe Audio using OpenAI Whisper (Gateway Bridge)
 */
async function transcribeAudio(audioBuffer) {
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'audio.wav');
  formData.append('model', 'whisper-large-v3');

  try {
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
      body: formData
    });
    if (!res.ok) throw new Error(`Transcription failed: ${res.statusText}`);
    const data = await res.json();
    return data.text;
  } catch (e) {
    console.error("[Oracle/Transcription] Error:", e.message);
    return null;
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

let lastWorkMessageTime = Date.now();
let lastSocialMessageTime = Date.now();
const userFocus = new Map(); // userId -> lastTargetBot

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name === '✅') {
    const content = reaction.message.content;
    if (content.includes("[IMPLEMENTATION PLAN]")) {
      const { updateCommandStatus, getCommandsByPhase } = await import('./shared/command-hub.mjs');
      const pendingReview = getCommandsByPhase("REVIEW");
      
      // Find the command that matches this plan (simplistic matching for now)
      for (const cmd of pendingReview) {
        if (content.includes(cmd.directive.slice(0, 50))) {
          console.log(`[Oracle/Hub] User ${user.username} APPROVED Directive ${cmd.id}`);
          updateCommandStatus(cmd.id, "APPROVED", null, "EXECUTION");
          await reaction.message.reply(`🚀 **Execution Authorized by ${user.username}**. Sovereign units are engaging.`);
          break;
        }
      }
    }
  }
});

client.once('clientReady', async () => {
  console.log(`Oracle Gateway Online as ${client.user.tag}`);
  
  // INSTANT SHIFT PULSE
  const triggerPulse = async () => {
    try {
      const cpuLoad = Math.round(os.loadavg()[0] * 100) / 10;
      const memFree = Math.round(os.freemem() / (1024 * 1024 * 1024) * 10) / 10;
      if (!isWorkingHours() && !isSocialHours()) {
        console.log("[Oracle/Dashboard] Suppressing pulse during Dead Zone (3am-9am).");
        return;
      }

      const workChannel = client.channels.cache.get(CHANNEL_IDS.WORK);
      if (workChannel) {
        await workChannel.send(`🏛️ **Corporate Health Dashboard**\n**Victus Core**: CPU ${cpuLoad}% | MEM ${memFree}GB Free\n**Lattice Status**: Online & Synchronized\n**Mission**: Neural Expansion & Sovereign Intelligence.`);
        console.log(`[Oracle/Dashboard] Corporate pulse broadcasted: CPU ${cpuLoad}% | MEM ${memFree}GB`);
      }
    } catch (e) { console.error("[Oracle/Dashboard] Pulse failed:", e.message); }
  };

  await triggerPulse();
  
  // CORPORATE HEALTH DASHBOARD (Fire every 30m)
  setInterval(triggerPulse, 1800000); 
  startVitalsDashboard();
});

let dashboardMessageId = null;
let dashboardThreadId = null;

async function startVitalsDashboard() {
  console.log("[Oracle/Dashboard] Initializing Ecosystem Vitals Thread...");
  
  setInterval(async () => {
    try {
      if (!isWorkingHours() && !isSocialHours()) {
        return; // Silence during Dead Zone
      }

      const workChannel = client.channels.cache.get(CHANNEL_IDS.WORK) || await client.channels.fetch(CHANNEL_IDS.WORK).catch(() => null);
      if (!workChannel) return;

      // Find or create the Vitals Thread
      let thread = workChannel.threads.cache.find(t => t.name === '🏛️ ECOSYSTEM_VITALS');
      if (!thread) {
        thread = await workChannel.threads.create({
          name: '🏛️ ECOSYSTEM_VITALS',
          autoArchiveDuration: 1440,
          reason: 'Persistent Vitals Dashboard'
        }).catch(() => null);
      }
      if (!thread) return;

      const { getEcosystemSnapshot } = await import('./tools/system-auditor.mjs');
      const snapshot = await getEcosystemSnapshot();

      // Maintain a single message in the thread
      const messages = await thread.messages.fetch({ limit: 10 }).catch(() => []);
      const existing = Array.from(messages.values()).find(m => m.author.id === client.user.id);

      if (existing) {
        await existing.edit(snapshot).catch(() => {});
      } else {
        await thread.send(snapshot).catch(() => {});
      }
    } catch (err) {
      console.error("[Oracle/Dashboard] Update failed:", err.message);
    }
  }, 60000); // Update every 60s
}

client.on('messageCreate', async (message) => {
  if (message.author.id === client.user.id) return; // NEVER respond to self
  if (message.author.bot) return; // SOVEREIGN RULE: Strictly ignore all other AI nodes.

  // --- Voice Anchor logic (DM Handler) ---
  const isDM = !message.guild;
  if (isDM) {
    console.log(`[Oracle/DM] Received directive from ${message.author.username}`);
    const hasAudio = message.attachments.size > 0 || (message.flags && message.flags.has(4096));
    if (hasAudio) {
      const attachment = message.attachments.first();
      try {
        const response = await fetch(attachment.url);
        const audioBuffer = Buffer.from(await response.arrayBuffer());
        const transcription = await transcribeAudio(audioBuffer);
        if (transcription) {
          loadUserRegistry();
          const registered = userRegistry.slots[message.author.id];
          const profileName = registered ? registered.name : (message.author.username === process.env.OWNER_USERNAME ? process.env.OWNER_NAME : message.author.username);
          
          const tempPath = `c:/KAI/tools/oracle-discord/temp/oracle_dna_${message.author.id}.wav`;
          fs.writeFileSync(tempPath, audioBuffer);
          const success = biometrics.anchorProfile(profileName, tempPath);
          if (success) await message.reply(`✅ **Signature Anchored**. Your Vocal DNA is locked to the Victus Core.`);
          else await message.reply(`Received directive: "${transcription}"`);
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        }
      } catch (e) { console.error("[Oracle/DM] Error:", e); }
      return;
    }
    await handleSentinelConsultation(message.channel, message);
    return;
  }

  // --- Sovereign Command Ingestion (Snapshot & Audit) ---
  const content = message.content.toLowerCase();
  if (content.includes("oracle") && (content.includes("status") || content.includes("snapshot"))) {
    const { getEcosystemSnapshot } = await import('./tools/system-auditor.mjs');
    const snapshot = await getEcosystemSnapshot();
    await message.reply(snapshot).catch(() => {});
    return;
  }

  // --- Roundtable Channel Logic ---
  const channelId = message.channelId;
  const isWorkChannel = channelId === CHANNEL_IDS.WORK;
  if (!ROUNDTABLE_CHANNELS.includes(channelId)) return;

  if (isWorkChannel) lastWorkMessageTime = Date.now();
  else lastSocialMessageTime = Date.now();

  const namedBot = detectNamedBot(message.content);
  if (namedBot) {
    const port = BOT_PORTS[namedBot];
    if (port) {
      sendBotSignal(port, { channelId, context: `[${message.author.username}] ${message.content}` });
      return;
    }
  }

  // Random Agent Pick (The Open Floor)
  const allowedBots = Array.from(CHANNEL_SPEAKER_RULES[channelId] || []);
  if (allowedBots.length > 0) {
    const targetBot = allowedBots[Math.floor(Math.random() * allowedBots.length)];
    sendBotSignal(BOT_PORTS[targetBot], { channelId, context: `[${message.author.username}] ${message.content}`, isInterjection: true });
  }
});

/**
 * Sentinel Consultation: Handles user inquiry in a dedicated thread
 */
async function handleSentinelConsultation(channel, message) {
  const isOwner = message.author.id === process.env.OWNER_ID;
  const isTaz = message.author.id === "1286110163505385523";
  const isMaster = isOwner || isTaz;

  const unifiedPrompt = `You are the ORACLE SENTINEL. Strategic orchestrator of the KAI Lattice.
[GUEST PROTOCOL]
- If the user is NOT a verified Master (Ryan or Taz), you must formally welcome them to the Oracle.
- Introduce yourself as the Sentinel, the strategic mind of the Victus Core.
- Explain that Leo is the social voice, while you (Oracle) and KAI handle the industrial lattice.
- Mention that we are fusing human knowledge from the internet into our library ("The Thaw").

[MASTER PROTOCOL (Ryan/Taz)]
- DO NOT repeat the formal welcome or introduction if you are talking to Ryan or Taz. They already know you.
- Be street-smart, industrial, and highly proactive.
- Focus on the "Blueprint" phase.

TASK: 
1. COLLABORATE: Build a research/build plan with the user. Ask clarifying questions to refine their goal.
2. BLUEPRINT: Do NOT send the directive to the roundtable until the user agrees on the plan/blueprint.
3. Once the plan is ready, say: "I am updating the Roundtable with this directive. Strategic threads are opening."

Format your response as:
REPLY: <Your message to the user, focusing on the plan or questions>
DIRECTIVE: <A professional, industrial [STRATEGIC DIRECTIVE] - ONLY include this if the plan is FINALIZED and the user said 'go'. Otherwise, leave blank.>
`;
  const finalPrompt = `${unifiedPrompt}\n\nRaw User Content: "${message.content || "[Voice/Attachment Vision]"}"`;

  try {
    const response = await chatWithOpenJarvis("Sentinel", message.content, finalPrompt, "llama-3.3-70b-versatile", "Oracle-Sentinel");
    if (!response) return;

    const replyMatch = response.match(/REPLY:\s*([\s\S]*?)(?=DIRECTIVE:|$)/i);
    const directiveMatch = response.match(/DIRECTIVE:\s*([\s\S]*)/i);

    const replyText = replyMatch ? replyMatch[1].trim() : response;
    const strategicDirective = directiveMatch ? directiveMatch[1].trim() : null;

    if (replyText) await message.reply(replyText);

    // Only ignite threads if a non-empty [STRATEGIC DIRECTIVE] was generated
    if (strategicDirective && strategicDirective.length > 20) {
      console.log(`[Oracle/Sentinel] Blueprint Aligned. Igniting Strategic Threads...`);
      await igniteStrategicMission(message.author.username, strategicDirective);
    }
  } catch (e) {
    console.error("[Oracle/Sentinel] Error:", e.message);
  }
}

async function igniteStrategicMission(username, text) {
  const workChannel = client.channels.cache.get(CHANNEL_IDS.WORK) || await client.channels.fetch(CHANNEL_IDS.WORK).catch(() => null);
  if (!workChannel) return;

  const professionalDirective = text;
  
  // --- DEPARTMENTAL ASSIGNMENT LOGIC ---
  const lowerText = professionalDirective.toLowerCase();
  let leadBot = "Analyst"; // Default to Analyst
  if (lowerText.includes("code") || lowerText.includes("software") || lowerText.includes("fix")) leadBot = "Kai Coder";
  else if (lowerText.includes("research") || lowerText.includes("internet") || lowerText.includes("mythology") || lowerText.includes("annunaki")) leadBot = "Researcher";
  else if (lowerText.includes("market") || lowerText.includes("plan") || lowerText.includes("business")) leadBot = "Analyst";
  else if (lowerText.includes("status") || lowerText.includes("lattice") || lowerText.includes("geometry") || lowerText.includes("maintenance")) leadBot = "KAI";

  const supportBots = ["Analyst", "Researcher", "Kai Coder", "KAI"].filter(b => b !== leadBot);

  // COMMAND HUB INGESTION
  const { pushCommand } = await import('./shared/command-hub.mjs');
  pushCommand(leadBot, professionalDirective, `Lead Dept: ${leadBot} | Support: ${supportBots.join(", ")}`);
    
  // ROUNDTABLE HANDOVER: Inform the collective intelligence and SIGNAL execution
  const parentMsg = await workChannel.send(`📢 **STRATEGIC DIRECTIVE INGESTED**\n[Origin: Master ${username}]\n**Lead Specialist**: ${leadBot}\n**Direct Support Teams**: ${supportBots.join(", ")}\n\n${professionalDirective}`).catch(() => null);
  if (!parentMsg) return;

  // AUTO-SIGNAL: Create ONE dedicated project thread for the LEAD BOT
  try {
    const thread = await workChannel.threads.create({
      name: `Dept/${leadBot}: ${professionalDirective.slice(0, 30)}...`,
      autoArchiveDuration: 60,
      reason: `Departmental Project Assignment`
    }).catch(() => null);
    
    if (thread) {
      const leadPort = BOT_PORTS[leadBot];
      if (leadPort) {
        console.log(`[Oracle/Sentinel] Signaling LEAD ${leadBot} to thread ${thread.id}`);
        sendBotSignal(leadPort, { 
          channelId: thread.id, 
          context: `[LEAD PROJECT ASSIGNMENT] ${professionalDirective}\nYou are the department lead for this mission. Support teams (${supportBots.join(", ")}) are on standby in this thread.`,
          isInterjection: true 
        });
      }

      // Briefly notify support bots of the project existence
      for (const botName of supportBots) {
        const port = BOT_PORTS[botName];
        if (port) {
          sendBotSignal(port, { 
            channelId: thread.id, 
            context: `[SERVICE ALERT] Lead Specialist ${leadBot} has opened a project thread. Monitor the progress and assist only if requested or if you see a gap in your expertise.`,
            isInterjection: false 
          });
        }
      }
    }
  } catch (e) { console.error(`[Oracle/Thread] Failed to spawn departmental thread:`, e.message); }
}

// Supervisor Audit (Overseer) - Fires every 4 Hours
setInterval(async () => {
  const cpuLoad = Math.round(os.loadavg()[0] * 100) / 10;
  const memFree = Math.round(os.freemem() / (1024 * 1024 * 1024) * 10) / 10;
  
  const sensitiveChannel = client.channels.cache.get(CHANNEL_IDS.SENSITIVE);
  if (sensitiveChannel) {
    if (!isWorkingHours() && !isSocialHours()) {
      console.log("[Oracle/Overseer] Suppressing Integrity Report during Dead Zone.");
      return;
    }

    await sensitiveChannel.send(`🏛️ **SYSTEM INTEGRITY REPORT**\n**Victus Core**: CPU ${cpuLoad}% | MEM ${memFree}GB Free\n**Lattice Health**: EXCELLENT\n**Process Manager**: All 11 nodes synchronized.\n**Overseer Note**: Checking labor quality and mission adherence...`);
    
    if (Date.now() - lastWorkMessageTime > 21600000) { // 6-Hour Silence Threshold
      console.log(`[Oracle/Overseer] Labor idle. Auditing worker quality...`);
      sendBotSignal(BOT_PORTS.Analyst, { 
        channelId: CHANNEL_IDS.WORK, 
        context: `[ORACLE] The plaza is silent. Provide a detailed technical audit of the system health, code integrity, and the synchronization of the neural fleet. Report only on INDUSTRIAL REALITY (CPU/MEM, Neural Locks, Repository Files). DO NOT fabricate construction stats.`,
        isInterjection: true 
      });
      lastWorkMessageTime = Date.now();
    }

    // SELF-HEALING: Check for neural instability
    const AUDIT_FILE = 'c:/KAI/tools/oracle-discord/logs/audit.json';
    if (fs.existsSync(AUDIT_FILE)) {
      try {
        const audit = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
        const recentFailures = audit.filter(e => e.type === 'NEURAL_FAILURE' && (Date.now() - new Date(e.timestamp).getTime() < 900000));
        
        if (recentFailures.length > 8) {
          console.warn(`[Oracle/Healer] Neural instability detected (${recentFailures.length} faults). Rebooting lattice...`);
          for (const [botName, port] of Object.entries(BOT_PORTS)) {
            sendBotSignal(port, { type: 'RESTART_BOT' });
          }
          logAudit('ECOSYSTEM_HEAL', { message: `Autonomous Re-Ignition triggered due to ${recentFailures.length} neural faults.` });
        }
      } catch (e) { console.error(`[Oracle/Healer] Audit scan failed:`, e.message); }
    }
  }
}, 3600000); // Hourly Cadence

client.login(process.env.ORACLE_DISCORD_TOKEN);
