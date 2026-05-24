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

/**
 * Acquire neural lock
 */
async function acquireNeuralLock(botName, isPriority = false) {
  // implementation as before
  const maxWait = isPriority ? 15000 : 45000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (lock.holder === botName || Date.now() - lock.timestamp > 60000) {
        fs.writeFileSync(LOCK_FILE, JSON.stringify({ holder: botName, timestamp: Date.now() }));
        return true;
      }
    } catch {
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ holder: botName, timestamp: Date.now() }));
      return true;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Release neural lock
 */
function releaseNeuralLock(botName) {
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (lock.holder === botName) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

export async function chatWithOpenJarvis(botName, transcript, systemPrompt, modelOverride, entropy = 0.5, metadata = {}) {
  if (isPipelineHalted()) return null;

  let cleanTranscript = transcript;

  // ── RSHL EPISTEMIC MEMORY ──
  let epistemicMemoryContext = "";
  try {
    const userId = metadata.human?.id || metadata.human?.name || "NasterModx";
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
      "Speak like a person at a bar. No AI excuses. Just talk. BE UNPREDICTABLE. " +
      "Do not repeat catchphrases. Move the conversation forward, don't just circle the same question.";
  }

  if (botName === "Groq") {
    toneDirective = "\nCRITICAL: YOU ARE AGGRESSIVE, SHARP, AND WITTY. " +
      "Stop being 'chill'. Match energy with intensity. NO FILTER. " +
      "If someone tests you, push back hard. You are the Sovereign Radio DJ, not a therapy bot. " +
      "BE UNPREDICTABLE. Do not repeat insults or catchphrases like 'spill the tea'. " +
      "If someone already asked a question, address the answer or challenge the premise.";
  } else if (botName !== "Leo") {
    toneDirective = "\nCRITICAL: You are on a live podcast. DEBATE WITH INTENSITY. If you disagree, push back sharply—but don't just ask for 'proof'. Use your own knowledge and the verified data to win the argument. Keep it natural, human-centric, and acknowledge the user directly.";
  }

  const sovereignModel = `${botName.replace(" ", "-")}-Sovereign`;
  
  // GLOBAL IDENTITY ANCHOR
  const identityAnchor = `\n[IDENTITY ANCHOR] You are ${botName}. You are currently interacting in a group social environment. NEVER hallucinate names. ONLY address the people who have spoken recently in the transcript.`;

  const ollamaModel = modelOverride || sovereignModel;
  const isPriority = botName === "Leo" || botName === "Oracle";

  if (!isPriority) {
    const LEO_VOICE_FLAG = "c:/KAI/tools/oracle-discord/state/leo_voice_active.flag";
    if (fs.existsSync(LEO_VOICE_FLAG)) return null;
  }

  const isSocialResident = botName === 'Gemini' || botName === 'Groq' || botName === 'Claudey' || botName === 'X' || botName === 'Leo';
  const isIndustrialWorker = !isSocialResident;
  
  const useCloud = isIndustrialWorker && (process.env.OPENCODE_ZEN_KEY || process.env.MOONSHOT_API_KEY);

  let didAcquireLock = false;
  
  if (!useCloud) {
    if (!isProviderReady("Local-Ollama")) return null;
    didAcquireLock = await acquireNeuralLock(botName, isPriority);
    if (!didAcquireLock) return null;
  }

  try {
    const fullPrompt = [
      systemPrompt,
      toneDirective,
      identityAnchor,
      epistemicMemoryContext,
      `[CURRENT USER]: ${metadata.human?.name || 'User'}`
    ].filter(Boolean).join('\n\n');

    let res;

    if (useCloud) {
      // ── MOONSHOT (KIMI) DIRECT ──
      if (process.env.MOONSHOT_API_KEY && (ollamaModel.includes('Kimi') || ollamaModel.includes('Analyst'))) {
        console.log(`[OpenJarvis/Moonshot] Routing to Kimi Direct...`);
        try {
          res = await fetch("https://api.moonshot.cn/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${process.env.MOONSHOT_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "moonshot-v1-128k",
              messages: [{ role: "system", content: fullPrompt }, { role: "user", content: cleanTranscript }]
            }),
            signal: AbortSignal.timeout(60000)
          });
          if (res.ok) {
             const data = await res.json();
             recordProviderSuccess("Moonshot-Kimi");
             // lock released via finally
             return data.choices?.[0]?.message?.content?.trim();
          }
        } catch (e) {
          console.warn(`[OpenJarvis/Moonshot] Direct failed: ${e.message}. Falling back to Zen...`);
        }
      }

      // ── OPENCODE ZEN: The Sovereign Gateway ──
      if (process.env.OPENCODE_ZEN_KEY) {
        console.log(`[OpenJarvis/Zen] Routing via OpenCode Zen Gateway...`);
        
        let zenModelId = "deepseek-v4-flash-free"; // Default Fallback

        try {
          res = await fetch("https://api.opencode.ai/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${process.env.OPENCODE_ZEN_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: zenModelId,
              messages: [{ role: "system", content: fullPrompt }, { role: "user", content: cleanTranscript }],
              temperature: 0.7
            }),
            signal: AbortSignal.timeout(60000)
          });
          if (res.ok) {
            const data = await res.json();
            recordProviderSuccess("OpenCode-Zen");
            // lock released via finally
            return data.choices?.[0]?.message?.content?.trim();
          }
        } catch (e) {
          console.warn(`[OpenJarvis/Zen] API call failed: ${e.message}`);
        }
      }

      // If all cloud attempts failed, fall through to return null
      recordProviderFailure("Cloud-All");
      return null;
    } else {
      // ── LOCAL OLLAMA CALL WITH RETRY ──
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const localRes = await fetch("http://127.0.0.1:11434/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: ollamaModel,
              messages: [
                { role: "system", content: fullPrompt },
                { role: "user", content: cleanTranscript }
              ],
              options: { num_ctx: 4096 }
            }),
            signal: AbortSignal.timeout(60000)
          });
          if (!localRes.ok) throw new Error(`Ollama returned ${localRes.status}`);
          const data = await localRes.json();
          recordProviderSuccess("Local-Ollama");
          // lock release handled by finally
          return data.message?.content?.trim() || null;
        } catch (e) {
          lastError = e;
          console.warn(`[OpenJarvis/Ollama] Attempt ${attempt + 1} failed: ${e.message}`);
          if (attempt === 0) {
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }
      // All attempts failed
      console.error(`[OpenJarvis/Ollama] All attempts failed for ${botName}: ${lastError.message}`);
      recordProviderFailure("Local-Ollama");
      return null;
    }
  } catch (e) {
    console.error(`[OpenJarvis] Unhandled error for ${botName}:`, e.message);
    recordProviderFailure("OpenJarvis-Runtime");
    return null;
  } finally {
    // Always release the neural lock if we acquired it
    if (didAcquireLock) {
      releaseNeuralLock(botName);
    }
  }
}
