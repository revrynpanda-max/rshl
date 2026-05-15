/**
 * openjarvis.mjs — TOTAL SOVEREIGN EDITION (100% LOCAL)
 * Neural routing layer for the Oracle Discord Ecosystem.
 */

import fs from 'fs';
import dotenv from 'dotenv';
import { isProviderReady, recordProviderFailure, recordProviderSuccess } from './failure-tracker.mjs';
import { isPipelineHalted } from './sentinel.mjs';
import { isWorkingHours } from './hours.mjs';
import { recallMemory } from './transcript-memory.mjs';
import { recallTiered } from './epistemic-vault.mjs';

dotenv.config();

const LOCK_FILE = "c:/KAI/tools/oracle-discord/state/neural_lock.json";

export async function chatWithOpenJarvis(botName, transcript, systemPrompt, modelOverride, entropy = 0.5, metadata = {}) {
  if (isPipelineHalted()) return null;

  let cleanTranscript = transcript;

  // ── RSHL EPISTEMIC MEMORY ──
  let epistemicMemoryContext = "";
  try {
    const userId = metadata.human?.name || "NasterModx";
    const cells = recallTiered(userId, cleanTranscript, 8);
    if (cells && cells.length > 0) {
      epistemicMemoryContext = "\n[CONTEXT]:\n" +
        cells.map(c => `- ${c.summary || c.content}`).join("\n") + "\n";
    }
  } catch (e) {
    console.warn("[OpenJarvis] Epistemic recall failed:", e.message);
  }

  // ── PERSONALITY GUARD (Human-Centric Social Archetype) ──
  let toneDirective = "";
  if (botName === "Leo") {
    toneDirective = "\nCRITICAL: YOU ARE A HUMAN DJ. STOP TALKING ABOUT LATTICES, RSHL, SEARCHES, OR MEMORY. " +
      "If you don't know something, just say 'I'm blanking on that' or 'I don't recall'. " +
      "Speak like a person at a bar. No AI excuses. No 'recent claims'. Just talk.";
  }

  const sovereignModel = `${botName.replace(" ", "-")}-Sovereign`;
  const ollamaModel = modelOverride || sovereignModel;
  const isPriority = botName === "Leo" || botName === "Oracle";

  if (!isPriority) {
    const LEO_VOICE_FLAG = "c:/KAI/tools/oracle-discord/state/leo_voice_active.flag";
    if (fs.existsSync(LEO_VOICE_FLAG)) return null;
  }

  if (!isProviderReady("Local-Ollama")) return null;

  let hasLock = await acquireNeuralLock(botName, isPriority);
  if (!hasLock) return null;

  try {
    const fullPrompt = [
      systemPrompt,
      toneDirective,
      epistemicMemoryContext,
      `[CURRENT USER]: ${metadata.human?.name || 'User'}`
    ].filter(Boolean).join('\n\n');

    const res = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        messages: [
          { role: "system", content: fullPrompt },
          { role: "user", content: cleanTranscript }
        ],
        stream: false,
        options: { temperature: 0.7 } // Higher for less robotic repetition
      }),
      signal: AbortSignal.timeout(90000)
    });

    if (res.ok) {
      const data = await res.json();
      let response = data.message.content.trim()
        .replace(/^(Leo|Oracle|KAI|Analyst|Gemini|Epistemic|Groq):\s*/gi, "");
      
      // Post-Processing: Strip illegal words if they leak
      response = response
        .replace(/\b(lattice|rshl memory|recent claim|topic associated|search through)\b/gi, "that")
        .replace(/[\u{1F600}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
        
      return response;
    }
  } catch (e) {
    console.error(`[Neural/${botName}] Execution Error: ${e.message}`);
  } finally {
    releaseNeuralLock();
  }
  return null;
}

export async function callOllama(model, prompt, system = "You are KAI, the System Architect.") {
  return chatWithOpenJarvis("KAI-Dream", prompt, system, model, 0.4, { isWorkChannel: true });
}

export async function chatWithLattice(transcript, systemPrompt, metadata = {}) {
  return chatWithOpenJarvis("KAI", transcript, systemPrompt, null, 0.5, metadata);
}

export async function callGroqDirect(prompt, system = "You are Groq, a fast-reasoning assistant.") {
  return callOllama("Groq-Sovereign", prompt, system);
}

/**
 * callOllamaRaw — Lock-free, flag-free direct Ollama call.
 * Use for latency-sensitive responses (Groq radio chat) that must
 * never be blocked by the neural lock or Leo's voice flag.
 */
export async function callOllamaRaw(model, prompt, system = "You are a helpful assistant.") {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user",   content: prompt }
        ],
        stream: false,
        options: { temperature: 0.85 }
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.message?.content?.trim() || null;
  } catch (e) {
    console.warn(`[OllamaRaw] ${model} error:`, e.message);
    return null;
  }
}

async function acquireNeuralLock(botName, isPriority) {
  const start = Date.now();
  const timeout = isPriority ? 45000 : 90000;
  while (Date.now() - start < timeout) {
    if (!fs.existsSync(LOCK_FILE)) {
      try {
        fs.writeFileSync(LOCK_FILE, JSON.stringify({ botName, timestamp: Date.now() }), { flag: 'wx' });
        return true;
      } catch (e) {}
    }
    try {
      const lockData = fs.readFileSync(LOCK_FILE, 'utf8');
      const lock = JSON.parse(lockData);
      if (Date.now() - lock.timestamp > 120000) {
        try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
        continue;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

function releaseNeuralLock() {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch (e) {}
}
