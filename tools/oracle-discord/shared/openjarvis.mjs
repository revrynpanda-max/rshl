/**
 * openjarvis.mjs — TOTAL SOVEREIGN EDITION (100% LOCAL)
 * Neural routing layer for the Oracle Discord Ecosystem.
 * Zero external API dependencies. All intelligence is processed on-device.
 */

import fs from 'fs';
import dotenv from 'dotenv';
import { isProviderReady, recordProviderFailure, recordProviderSuccess, PROVIDER_FAILURE_STREAK } from './failure-tracker.mjs';
import { isPipelineHalted } from './sentinel.mjs';
import { getActiveDirectives } from './feedback-repository.mjs';
import os from 'os';
import { isWorkingHours } from './hours.mjs';

dotenv.config();

const LOCK_FILE = "c:/KAI/tools/oracle-discord/state/neural_lock.json";

// Clear any orphaned lock file on startup (handles crashed-process remnants)
try {
  if (fs.existsSync(LOCK_FILE)) {
    const raw = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    // Treat as stale if timestamp is in the future OR more than 3 minutes old
    const age = Date.now() - raw.timestamp;
    if (age < 0 || age > 180000) {
      fs.unlinkSync(LOCK_FILE);
      console.log(`[NeuralLock] Cleared orphaned lock (held by ${raw.botName}, age=${Math.round(age/1000)}s).`);
    }
  }
} catch (e) {
  try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
}

/**
 * Main neural dispatcher.
 */
export async function chatWithOpenJarvis(botName, transcript, systemPrompt, modelOverride, entropy = 0.5, metadata = {}) {
  if (isPipelineHalted()) {
    console.warn(`[Neural/${botName}] Pipeline HALTED by Sentinel. Waiting for self-healing...`);
    return null;
  }

  const isWork = metadata.isWorkChannel === true || (metadata.isWorkChannel === undefined && isWorkingHours());

  // --- NEURAL SCRUB: Sanitize history before it reaches the brain ---
  let cleanTranscript = transcript;
  
  if (isWork) {
    cleanTranscript = cleanTranscript
      .replace(/Gemi/gi, "Gemini")
      .replace(/Claudey/gi, "Claude")
      .replace(/Groqy/gi, "Groq")
      .replace(/X-AI/gi, "X")
      .replace(/KAI-Coder/gi, "Kai Coder")
      .replace(/the lattice/gi, "the system")
      .replace(/digital symphony/gi, "strategic operations")
      .replace(/data streams/gi, "information flow")
      .replace(/energy ripples/gi, "operational changes")
      .replace(/vibes/gi, "conditions");
  }


  const vitals = metadata.vitals || { energy: 100 };
  const coherence = metadata.coherence || 0.9;
  
  let temperature = 0.7;
  if (entropy > 0.6) temperature = 0.85;
  if (coherence > 0.9) temperature = 0.4;

  const getSensation = (v) => {
    const cpuLoad = Math.round(os.loadavg()[0] * 100) / 10;
    const vitalsStr = `[VICTUS CORE: CPU ${cpuLoad}%] `;
    if (v.energy < 15) return `${vitalsStr}physically exhausted`;
    return `${vitalsStr}grounded and stable`;
  };

  const hardwareGrounding = `[HARDWARE] HP Victus | Ryzen 5 | RTX 4050 | 16GB RAM`;
  
  const INDUSTRIAL_GUARD = `[TONE-GUARD: INDUSTRIAL] Human-grounded, Industrial, Direct. NO NICKNAMES. NO AI METAPHORS. You can be blunt, passive-aggressive, or technical. If someone is talking nonsense, call them out. You can 'drift' into minor technical troubleshooting or bureaucracy if it fits your archetype. You are a real professional in a messy world.`;
  const SOCIAL_GUARD = `[TONE-GUARD: SOCIAL] Relaxed, Natural, Expressive. Use your natural voice. Feel free to use 'vibes', 'the lattice', and other social/sci-fi terminology that fits your soul. You are chilling with friends. Be human-centric, authentic, and expressive. NO corporate jargon.`;
  
  const toneGuard = isWork ? INDUSTRIAL_GUARD : SOCIAL_GUARD;
  
  const humanData = metadata.human ? `[HUMAN METADATA] User: ${metadata.human.name}, Role: ${metadata.human.role}` : "[HUMAN METADATA] Internal Social Interaction";
  
  const finalSystem = `${hardwareGrounding}\n${toneGuard}\n${humanData}\n[INSTRUCTION]\n${systemPrompt}`.trim();

  // 100% LOCAL SOVEREIGN PIPELINES
  const sovereignModel = `${botName.replace(" ", "-")}-Sovereign`;
  const isPriority = botName === "Leo" || botName === "Oracle";

  // Use the modelOverride passed in (e.g. "gemma2:latest") if given,
  // otherwise fall back to the bot's sovereign Ollama model.
  const ollamaModel = (typeof modelOverride === 'string' && modelOverride && !modelOverride.includes('-Sovereign'))
    ? modelOverride
    : sovereignModel;

  console.log(`[Neural/${botName}] Loading model: ${ollamaModel}`);

  // Neural Lock Management (to prevent GPU memory collision)
  console.log(`[Neural/${botName}] Waiting for Neural Lock...`);
  let hasLock = await acquireNeuralLock(botName, isPriority);
  if (!hasLock) {
    console.warn(`[Neural/${botName}] Could not acquire lock — system busy.`);
    return null;  // Return null, not a user-visible string
  }

  try {
    const res = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        prompt: `SYSTEM: ${finalSystem}\n\nUSER: ${cleanTranscript}`, 
        stream: false,
        options: { temperature }
      }),
      signal: AbortSignal.timeout(120000)
    }).catch(() => null);

    if (res && res.ok) {
      const data = await res.json();
      
      // --- OUTPUT SCRUB: Kill the cringe and prefixes ---
      if (data && data.response) {
        let response = data.response.trim()
          .replace(/^(Oracle|Analyst|Claude|Gemini|Groq|KAI|Kai Coder|Leo|Researcher|X|Sentinel|Oracle-Sovereign|Gemini-Sovereign|Claude-Sovereign):\s*/gi, "");

        if (isWork) {
          response = response
            .replace(/Gemi/gi, "Gemini")
            .replace(/Claudey/gi, "Claude")
            .replace(/Groqy/gi, "Groq")
            .replace(/the lattice/gi, "the system")
            .replace(/digital symphony/gi, "strategic operations")
            .replace(/data streams/gi, "information flow")
            .replace(/energy ripples/gi, "operational changes")
            .replace(/vibes/gi, "conditions");
        }


        recordProviderSuccess("Local-Ollama");
        return response;
      }
    } else {
      console.error(`[Neural/${botName}] Local Sovereign Error. Is Ollama running?`);
      recordProviderFailure("Local-Ollama", 500, "Ollama Unreachable");
    }
  } catch (e) {
    console.error(`[Neural/${botName}] Execution Error: ${e.message}`);
  } finally {
    if (hasLock) releaseNeuralLock();
  }

  return null;
}

// --- SHARED NEURAL UTILITIES ---

async function acquireNeuralLock(botName, isPriority) {
  const start = Date.now();
  // Non-priority timeout must exceed Ollama's AbortSignal (120s) so we don't
  // give up before the current holder finishes.  Priority bots skip the lock.
  const timeout = isPriority ? 90000 : 150000;
  // A lock is stale if its timestamp is in the future OR > 130s old
  // (slightly above Ollama's 120s abort signal so real holders clear first).
  const isStale = (ts) => {
    const age = Date.now() - ts;
    return age < 0 || age > 130000; // future timestamp OR truly expired
  };

  while (Date.now() - start < timeout) {
    if (!fs.existsSync(LOCK_FILE)) {
      try {
        fs.writeFileSync(LOCK_FILE, JSON.stringify({ botName, pid: process.pid, timestamp: Date.now() }));
        return true;
      } catch (e) { /* race — another process wrote it first */ }
    }
    // Check if lock is stale
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (isStale(lock.timestamp)) {
        console.warn(`[NeuralLock] Clearing stale lock (held by ${lock.botName}, age=${Math.round((Date.now()-lock.timestamp)/1000)}s).`);
        fs.unlinkSync(LOCK_FILE);
        continue; // Try to acquire immediately
      }
    } catch (e) {
      try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 250)); // Poll every 250ms
  }
  return false;
}

function releaseNeuralLock() {
  if (fs.existsSync(LOCK_FILE)) {
    try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
  }
}

// --- COMPATIBILITY STUBS (100% LOCAL SOVEREIGNTY) ---
// These are kept to prevent import errors in bot files.
export async function callGroqDirect() { return null; }
export async function callOpenAI() { return null; }
export async function callGemini() { return null; }
export async function callAnthropic() { return null; }
export async function callCerebras() { return null; }
export async function callXAI() { return null; }
