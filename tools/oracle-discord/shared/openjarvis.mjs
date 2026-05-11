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
      .replace(/claudey/gi, "Epistemic")
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

  // ── Prompt wrapping ────────────────────────────────────────────────────────
  // Work channel: add a light industrial tone anchor + human metadata + RSHL grounding.
  let finalSystem;
  if (isWork) {
    const INDUSTRIAL_GUARD = `[SHIFT: WORK] Direct, professional, no corporate filler. No AI metaphors.
[PROJECT: KAI RSHL] v7.9.7 Sonic-Parallel. 16K Sparse Ternary Lattice.
[WHITEPAPER] Ingested. Use technical anchors (Fibonacci Torsion, Boids, SynapticLayer).`;
    
    const humanData = metadata.human
      ? `[USER] ${metadata.human.name} (${metadata.human.role})`
      : '';
    finalSystem = [INDUSTRIAL_GUARD, humanData, systemPrompt].filter(Boolean).join('\n').trim();
  } else {
    // Social: just pass the prompt as-is. The Modelfile already baked the right person.
    finalSystem = systemPrompt;
  }


  // 100% LOCAL SOVEREIGN PIPELINES
  const sovereignModel = `${botName.replace(" ", "-")}-Sovereign`;
  const isPriority = botName === "Leo" || botName === "Oracle";

  // Use the modelOverride passed in (e.g. "gemma2:latest") if given,
  // otherwise fall back to the bot's sovereign Ollama model.
  const ollamaModel = (typeof modelOverride === 'string' && modelOverride && !modelOverride.includes('-Sovereign'))
    ? modelOverride
    : sovereignModel;

  console.log(`[Neural/${botName}] Loading model: ${ollamaModel}`);

  // ── LEO VOICE PRIORITY: If Leo is actively in voice, all non-priority bots yield ─
  // Leo uses callGroqDirect (lock-free) so he never contends for the GPU.
  // But social bots hammering Ollama during a voice session hurts overall latency.
  // Check the flag file Leo writes when he connects to voice.
  if (!isPriority) {
    const LEO_VOICE_FLAG = "c:/KAI/tools/oracle-discord/state/leo_voice_active.flag";
    try {
      if (fs.existsSync(LEO_VOICE_FLAG)) {
        console.log(`[Neural/${botName}] Leo is in voice — backing off to preserve GPU bandwidth.`);
        return null;
      }
    } catch (_) {}
  }

  // ── CIRCUIT BREAKER: Bail before touching the lock if Ollama is in cooldown ─
  // This prevents all bots from piling into the lock queue when Ollama is down.
  if (!isProviderReady("Local-Ollama")) {
    console.warn(`[Neural/${botName}] Local-Ollama in cooldown — skipping lock entirely.`);
    return null;
  }

  // ── OLLAMA HEALTH PING: Quick check before committing to a long lock wait ───
  // A 2s HEAD-style request confirms Ollama is actually up before we block.
  try {
    const ping = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(2000)
    });
    if (!ping.ok) throw new Error(`Ollama ping ${ping.status}`);
  } catch (pingErr) {
    console.warn(`[Neural/${botName}] Ollama unreachable (${pingErr.message}) — skipping.`);
    recordProviderFailure("Local-Ollama", 503, pingErr.message);
    return null;
  }

  // ── JITTER: Stagger lock attempts so bots don't all pile in at once ─────────
  // Random 0-1500ms delay spreads bot timings and eliminates the thundering herd.
  if (!isPriority) {
    await new Promise(r => setTimeout(r, Math.random() * 1500));
  }

  // Neural Lock Management (to prevent GPU memory collision)
  console.log(`[Neural/${botName}] Waiting for Neural Lock...`);
  let hasLock = await acquireNeuralLock(botName, isPriority);
  if (!hasLock) {
    console.warn(`[Neural/${botName}] Could not acquire lock — system busy.`);
    return null;  // Return null, not a user-visible string
  }

  try {
    const res = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        messages: [
          { role: "system", content: finalSystem },
          { role: "user", content: cleanTranscript }
        ],
        stream: false,
        options: { temperature }
      }),
      signal: AbortSignal.timeout(120000)
    }).catch(() => null);

    if (res && res.ok) {
      const data = await res.json();
      
      // --- OUTPUT SCRUB: Kill the cringe and prefixes ---
      if (data && data.message && data.message.content) {
        let response = data.message.content.trim()
          .replace(/^(Oracle|Analyst|Epistemic|Gemini|Groq|KAI|Kai Coder|Leo|Researcher|X|Sentinel|Oracle-Sovereign|Gemini-Sovereign|Epistemic-Sovereign):\s*/gi, "");

        if (isWork) {
          response = response
            .replace(/Gemi/gi, "Gemini")
            .replace(/claudey/gi, "Epistemic")
            .replace(/Groqy/gi, "Groq")
            .replace(/the lattice/gi, "the system")
            .replace(/digital symphony/gi, "strategic operations")
            .replace(/data streams/gi, "information flow")
            .replace(/energy ripples/gi, "operational changes")
            .replace(/vibes/gi, "conditions");
        }

        // --- GLOBAL EMOJI STRIPPER ---
        response = response.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');

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

/**
 * chatWithLattice — NATIVE RSHL REASONING (The "Gut Swap")
 * Calls the Rust backend's Synaptic Layer directly. No LLMs involved.
 */
export async function chatWithLattice(botName, transcript) {
  try {
    const res = await fetch("http://127.0.0.1:3333/api/rshl/reason", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: transcript }),
      signal: AbortSignal.timeout(10000) // RSHL is fast
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.reply) {
        console.log(`[Neural/${botName}] RSHL Lattice Reason successful.`);
        return data.reply;
      }
    }
  } catch (e) {
    console.error(`[Neural/${botName}] Lattice Reason Error: ${e.message}`);
  }
  return null;
}

/**
 * callGroqDirect — LOCK-FREE Groq API call for real-time voice responses.
 * Bypasses the Neural Lock entirely — safe for voice pipeline where latency
 * is critical and we cannot afford to wait for GPU model slots.
 *
 * @param {string} botName  - Bot identifier for logging
 * @param {string} transcript - User input / prompt
 * @param {string} systemPrompt - System instruction
 * @param {string} model - Groq model (e.g. "llama-3.1-8b-instant")
 * @param {number} maxTokens - Max output tokens (default 150 for voice)
 * @returns {Promise<string|null>}
 */
export async function callGroqDirect(botName, transcript, systemPrompt, model = "llama-3.1-8b-instant", maxTokens = 150) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    console.warn(`[Groq/${botName}] No GROQ_API_KEY — skipping direct call.`);
    return null;
  }

  try {
    console.log(`[Groq/${botName}] Direct call (lock-free): ${model}`);
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: transcript }
        ],
        max_tokens: maxTokens,
        temperature: 0.75
      }),
      signal: AbortSignal.timeout(15000) // 15s hard cap — voice must be fast
    });

    if (res.ok) {
      const data = await res.json();
      const reply = data?.choices?.[0]?.message?.content?.trim();
      if (reply) {
        // Strip emoji and bot-name prefixes
        return reply
          .replace(/[\u{1F600}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
          .replace(/^(Leo|Oracle|KAI|Analyst|Gemini|Epistemic|Groq):\s*/gi, '')
          .trim();
      }
    } else {
      const errText = await res.text().catch(() => res.status);
      console.error(`[Groq/${botName}] API error ${res.status}: ${errText}`);
    }
  } catch (e) {
    console.error(`[Groq/${botName}] Direct call failed: ${e.message}`);
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
        const age = Math.round((Date.now() - lock.timestamp) / 1000);
        console.warn(`[NeuralLock] Clearing stale lock (held by ${lock.botName}, age=${age}s)`);
        try { fs.unlinkSync(LOCK_FILE); } catch (_) {}
        continue; // retry the acquire
      }
    } catch (_) {
      // File disappeared between existsSync and readFileSync — retry
    }

    // Lock is held and not stale — wait 500ms then retry
    await new Promise(r => setTimeout(r, 500));
  }

  console.warn(`[NeuralLock] Timeout waiting for lock (botName=${botName})`);
  return false;
}

function releaseNeuralLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch (e) {
    console.warn(`[NeuralLock] Release failed: ${e.message}`);
  }
}
