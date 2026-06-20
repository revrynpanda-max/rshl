/**
 * openjarvis.mjs — TOTAL SOVEREIGN EDITION (100% LOCAL)
 * Neural routing layer for the Oracle Discord Ecosystem.
 */

import fs from 'fs';
import { guard as loopGuard } from './loop-guard.mjs';  // truncate runaway repetition (ported from Kai 2.0)
import { reflexAnswer } from './reflex.mjs';            // per-persona zero-model reflex fast-path (ported from Kai 2.0 LLI)
import dotenv from 'dotenv';
import { execSync } from 'child_process';
import { isProviderReady, recordProviderFailure, recordProviderSuccess } from './failure-tracker.mjs';
import { isPipelineHalted } from './sentinel.mjs';
import { isWorkingHours } from './hours.mjs';
import { recallMemory } from './transcript-memory.mjs';
import { recallTiered } from './epistemic-vault.mjs';
import { isSomeoneSpeaking, acquireVoiceLock, releaseVoiceLock } from './tts-engine.mjs';
import { buildFailureContext } from './failure-memory.mjs';
import { getDynamicRole } from './dynamic-roles.mjs';
import { BASE_TOOLS_SCHEMA, CODER_TOOLS_SCHEMA, executeToolCall, getToolsForBot } from './native-tools.mjs';
import { storeLattice } from './lattice-bridge.mjs';

dotenv.config();

const LOCK_FILE = "c:/KAI/tools/oracle-discord/state/neural_lock.json";

// ── Global API Rate Limiter ──────────────────────────────────────────────────
// Ensures cloud APIs are not hammered simultaneously by multiple bots.
const providerLocks = new Map();
async function acquireProviderLock(provider, delayMs = 1500) {
  if (!providerLocks.has(provider)) {
    providerLocks.set(provider, Promise.resolve());
  }
  
  const currentLock = providerLocks.get(provider);
  // Wait for the previous lock to finish plus the delay
  const nextLock = currentLock.then(() => new Promise(r => setTimeout(r, delayMs)));
  providerLocks.set(provider, nextLock);
  
  // Wait for our turn
  await currentLock;
}

// ── Per-bot model routing ────────────────────────────────────────────────────
// Each industrial bot has a default provider + model. Users can override per
// bot via .env: BOT_PROVIDER_<NAME>=moonshot|zen|ollama and
// BOT_MODEL_<NAME>=<alias-or-real-model-id>. The user's friendly aliases
// (e.g. "Gemini-3.1-Coder", "Kimi26") are translated to real provider model
// IDs via ZEN_ALIASES below. Anything unknown is sent verbatim.

const BOT_ROUTING_DEFAULTS = {
  // Work bots default to GROQ, NOT Gemini. Reason: the global GEMINI_API_KEY is the
  // SAME project/key as Leo's voice (GEMINI_API_KEY_LEO) and is a FREE-tier project
  // capped at 20 generateContent requests/DAY — three work bots + Leo's voice all
  // piled onto it and hit 429s instantly. Groq's free tier is ~14,400 req/day on its
  // own separate key (GROQ_API_KEY), so the work fleet gets its OWN big quota and Leo's
  // Gemini key is left for voice alone. Local Ollama (which was unreachable) and Gemini
  // remain in the failover chain. Per-bot override still works: BOT_PROVIDER_<NAME>=...
  "Analyst":    { provider: "groq",     model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile" },
  "Researcher": { provider: "groq",     model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile" },
  "Kai Coder":  { provider: "groq",     model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile" },
  // KAI and Oracle stay on local Sovereign (the sovereign core) — they need Ollama running.
  "KAI":        { provider: "ollama",   model: "KAI-Sovereign:latest" },
  "Oracle":     { provider: "ollama",   model: "Oracle-Sovereign:latest" },
  
  // Social bots move to cloud to save local CPU/GPU limits
  "Gemini":     { provider: "groq",     model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile" }, // moved off its own Gemini key (20/day free cap too small) → shares Groq's ~14k/day pool
  "Claudey":    { provider: "groq",     model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile" }, // shares the Groq pool with Gemini — the per-bot Gemini free tier was only 20/day
  "X":          { provider: "xai",      model: process.env.XAI_MODEL || "grok-3" },
  "Groq":       { provider: "groq",     model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile" },
  "Leo":        { provider: "gemini",   model: process.env.GEMINI_MODEL || "gemini-2.5-flash" },
};

// User-friendly aliases → real OpenCode Zen model IDs. Update as Zen's
// catalog evolves. Per-bot override: BOT_ZEN_MODEL_<NAME>=<real-model-id>.
const ZEN_ALIASES = {
  // Mapped to OpenCode Zen's real catalog (as of user's workspace).
  // If Zen's API expects a different exact slug (e.g. "kimi-k2.6" vs
  // "kimi-k2-6"), override per-bot with BOT_ZEN_MODEL_<NAME> in .env.
  "Kimi-Sovereign":       "kimi-k2.6",          // Kimi K2.6 — long-context generalist
  "Kimi26":               "kimi-k2.6",          // alias for the same
  "Kimi25":               "kimi-k2.5",          // Kimi K2.5 if you specifically want the older one
  "Researcher-Sovereign": "kimi-k2.6",          // long-context synthesis
  "Oracle-Sovereign":     "claude-sonnet-4-5",  // coordinator — balanced reasoning + structure
  "Gemini-3.1-Coder":     "claude-sonnet-4-5",  // Kai Coder — best autonomous coder
  "Gemini-3.1-Sovereign": "kimi-k2.6",     // Mapped to Kimi K2.6 due to Zen provider GCP 401 unauthenticated error
  "Zen-Frontier-Claude4": "claude-sonnet-4-5",
  // Auto-generated `${botName}-Sovereign` aliases that callers pass as
  // hardcoded modelOverride values (kai-coder-agent.mjs:95, kai.mjs:179, etc.).
  // Without these, the override falls through unmapped and Zen 401s with
  // "Model X-Sovereign not supported" — which then cascades into auto-repair.
  "Kai-Coder-Sovereign":  "claude-sonnet-4-5",  // matches Gemini-3.1-Coder intent
  "KAI-Sovereign":        "kimi-k2.6",          // matches Gemini-3.1-Sovereign intent
  "Analyst-Sovereign":    "kimi-k2.6",          // analyst routes to Kimi when on Zen
  "Leo-Sovereign":        "claude-sonnet-4-5",  // shouldn't normally hit Zen; safe default
  "Gemini-Sovereign":     "claude-sonnet-4-5",  // social bot, shouldn't hit Zen; safe default
  "Claudey-Sovereign":    "claude-sonnet-4-5",  // social bot, shouldn't hit Zen; safe default
  "X-Sovereign":          "claude-sonnet-4-5",  // social bot, shouldn't hit Zen; safe default
  "Groq-Sovereign":       "claude-sonnet-4-5",  // social bot, shouldn't hit Zen; safe default
};

const MOONSHOT_REAL_MODEL = "moonshot-v1-128k";

// ── PER-BOT PRIMARY CHAT MODEL MAP (role-fit, env-overridable) ───────────────
// Goal: stop every bot collapsing to ONE shared Groq/Gemini model. Each bot now
// gets a model that fits its JOB. This map ONLY governs each bot's PRIMARY chat
// model (the one resolveRoute() picks). It does NOT touch the multi-provider
// teacher/failover chain below — when a provider is down/quota'd, failover still
// uses the generic GROQ_MODEL/GEMINI_MODEL fallbacks on purpose.
//
// EVERY entry is overridable by env WITHOUT editing code. Per-bot env wins, then
// the per-provider global env, then the role-fit default here:
//   Groq bots   : <BOT>_MODEL  (e.g. KAICODER_MODEL) → GROQ_MODEL → default
//   Gemini bots : <BOT>_MODEL                         → GEMINI_MODEL → default
//   xAI bots    : <BOT>_MODEL                         → XAI_MODEL    → default
//
// CURRENT PER-BOT MAP (defaults you can change via the env var on the right):
//   WORK / reasoning bots (strong models):
//     Analyst    groq   → ANALYST_MODEL     (default llama-3.3-70b-versatile)
//     Researcher groq   → RESEARCHER_MODEL  (default llama-3.3-70b-versatile)
//     Kai Coder  groq   → KAICODER_MODEL    (default llama-3.3-70b-versatile) [coding; set KAICODER_MODEL to enable a coding model]
//   SOCIAL / fast bots (fast conversational models):
//     Gemini     groq   → GEMINI_BOT_MODEL  (default llama-3.1-8b-instant)
//     Claudey    groq   → CLAUDEY_MODEL     (default llama-3.1-8b-instant)
//     Groq       groq   → GROQ_BOT_MODEL    (default llama-3.1-8b-instant)
//     X          xai    → X_MODEL           (default grok-3)
//   Leo (voice) is intentionally NOT in this map — his Live/voice model is
//   handled separately and must NOT be changed here.
//
// NOTE: if any default model isn't enabled on your key, just set the env var to a
// model that is — no code edit needed. Groq IDs below are real current slugs.
// Kai Coder previously defaulted to moonshotai/kimi-k2-instruct, which returns
// 401 Invalid Authentication on this Groq key (not enabled) and trips the circuit
// breaker, so it now defaults to llama-3.3-70b-versatile (same model the work bots
// use successfully). Set KAICODER_MODEL to a real coding model once you enable one.
const PER_BOT_PRIMARY_MODEL = {
  // bot name : { env: "<PER_BOT_ENV>", groqDefault | geminiDefault | xaiDefault }
  "Analyst":    { env: "ANALYST_MODEL",    groqDefault: "llama-3.3-70b-versatile" },
  "Researcher": { env: "RESEARCHER_MODEL", groqDefault: "llama-3.3-70b-versatile" },
  "Kai Coder":  { env: "KAICODER_MODEL",   groqDefault: "llama-3.3-70b-versatile" }, // was moonshotai/kimi-k2-instruct → 401 on this Groq key (not enabled). Set KAICODER_MODEL to a coding model once enabled.
  "Gemini":     { env: "GEMINI_BOT_MODEL", groqDefault: "llama-3.1-8b-instant", geminiDefault: "gemini-2.5-flash" },
  "Claudey":    { env: "CLAUDEY_MODEL",    groqDefault: "llama-3.1-8b-instant", geminiDefault: "gemini-2.5-flash" },
  "Groq":       { env: "GROQ_BOT_MODEL",   groqDefault: "llama-3.1-8b-instant" },
  "X":          { env: "X_MODEL",          xaiDefault: "grok-3", groqDefault: "llama-3.1-8b-instant" },
};

// Resolve a bot's PRIMARY model for a given provider, honoring (in order):
// per-bot env → per-provider global env → role-fit default → caller's alias.
function perBotPrimaryModel(botName, provider, fallbackAlias) {
  const cfg = PER_BOT_PRIMARY_MODEL[botName];
  if (cfg && cfg.env && process.env[cfg.env]) return process.env[cfg.env];
  if (provider === "groq") {
    return (cfg && cfg.groqDefault) || process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  }
  if (provider === "gemini") {
    return (cfg && cfg.geminiDefault) || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  }
  if (provider === "xai") {
    return (cfg && cfg.xaiDefault) || process.env.XAI_MODEL || "grok-3";
  }
  return fallbackAlias;
}

function envKey(prefix, botName) {
  return prefix + botName.toUpperCase().replace(/[\s-]+/g, "_");
}

function resolveRoute(botName, modelOverride) {
  const def = BOT_ROUTING_DEFAULTS[botName] || { provider: "ollama", model: `${botName.replace(" ", "-")}-Sovereign` };

  // User .env overrides take priority. BOT_PROVIDER_<NAME> picks the lane,
  // BOT_MODEL_<NAME> picks the alias/model passed to that lane.
  const provider = (process.env[envKey("BOT_PROVIDER_", botName)] || def.provider).toLowerCase();
  const modelAlias = modelOverride || process.env[envKey("BOT_MODEL_", botName)] || def.model;

  // Translate alias → real provider-side model ID.
  let realModel = modelAlias;
  if (provider === "moonshot") {
    realModel = MOONSHOT_REAL_MODEL;
  } else if (provider === "zen") {
    const zenOverride = process.env[envKey("BOT_ZEN_MODEL_", botName)];
    realModel = zenOverride || ZEN_ALIASES[modelAlias] || modelAlias;
  } else if (provider === "groq") {
    // Per-bot role-fit model (env-overridable). Replaces the old single shared
    // GROQ_MODEL collapse so each Groq bot gets a model that fits its job.
    realModel = perBotPrimaryModel(botName, "groq", modelAlias);
  } else if (provider === "xai") {
    // Per-bot xAI model. grok-2 was retired by xAI (400 Model not found);
    // default grok-3, overridable via X_MODEL / XAI_MODEL.
    realModel = perBotPrimaryModel(botName, "xai", modelAlias);
  }

  // Sanitize Gemini model names — if a Sovereign/Zen alias slipped through, use a
  // real Gemini model. Per-bot map lets Gemini-provider bots pick their own model.
  if (provider === "gemini") {
    const isRealGeminiModel = realModel.startsWith("gemini-");
    if (!isRealGeminiModel) {
      realModel = perBotPrimaryModel(botName, "gemini", "gemini-2.5-flash");
    }
  }

  return { provider, modelAlias, realModel };
}

function getSystemTelemetry() {
  try {
    const psCmd = `powershell -NoProfile -Command "
      $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average;
      if ($null -eq $cpu) { $cpu = 0 }
      $mem = Get-CimInstance Win32_OperatingSystem;
      $totalMem = [math]::Round($mem.TotalVisibleMemorySize / 1MB, 1);
      $freeMem = [math]::Round($mem.FreePhysicalMemory / 1MB, 1);
      $usedMem = [math]::Round($totalMem - $freeMem, 1);
      $gpuTemp = 'N/A';
      if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        $gpuTemp = (nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits).Trim() + 'C';
      }
      Write-Output \\"CPU: $cpu% | RAM: $usedMem GB / $totalMem GB | GPU Temp: $gpuTemp\\"
    "`;
    return execSync(psCmd, { encoding: 'utf8', timeout: 4000 }).trim();
  } catch (e) {
    return `Error reading telemetry: ${e.message}`;
  }
}

export async function chatWithOpenJarvis(botName, transcript, systemPrompt, modelOverride, entropy = 0.5, metadata = {}) {
  try {
    const { reloadEnv } = await import('./gemini-live-bridge.mjs');
    reloadEnv();
  } catch (_) {}
  if (isPipelineHalted()) return null;

  let cleanTranscript = transcript;

  // ── GROUNDING URL READER ──
  if (!metadata.isRawPrompt) {
    try {
      const { extractUrl, readUrlContent } = await import('./url-reader.mjs');
      const url = extractUrl(cleanTranscript);
      if (url) {
        console.log(`[${botName}/LinkReader] Reading link content: ${url}`);
        const linkData = await readUrlContent(url);
        if (linkData) {
          cleanTranscript += `\n\n[ATTACHED LINK SYSTEM DATA]:\nURL: ${url}\nTitle: ${linkData.title}\nContent:\n${linkData.content}`;
          console.log(`[${botName}/LinkReader] Link read successfully (${linkData.content.length} chars injected).`);
        }
      }
    } catch (e) {
      console.warn(`[${botName}/LinkReader] Error reading URL:`, e.message);
    }
  }

  // ── LATTICE MEMPALACE COGNITIVE GROUNDING (Theory of Mind & Privacy Guards) ──
  let mempalaceContext = "";
  try {
    const { getUserProfile, getChannelProfile } = await import('./lattice-mempalace.mjs');
    const uId = metadata.human?.id || metadata.human?.name || "nastermodx";
    const uProf = getUserProfile(uId, metadata.human?.name || "User");
    const cId = metadata.channelId || "1489796367466500129";
    const cProf = getChannelProfile(cId);

    // Build Cognitive Theory of Mind context
    mempalaceContext = `
[COGNITIVE MEMORY PALACE - RSHL GROUNDING]
SENDER PROFILE:
- Preferred Name: ${uProf.preferredName}
- Personality & Style Delineation: ${uProf.personalityTraits}
- Your Relationship with ${uProf.preferredName} (${botName}): ${uProf.relationshipState[botName] || "observant, friendly, intellectual"}
- Consolidated Sender History: ${uProf.compressedHistory}

CHANNEL PROFILE:
- Channel Name: ${cProf.channelName}
- Purpose & Description: ${cProf.description}
- Active Department / Category: ${cProf.category}
- Operational Directives: ${cProf.rules}

[STRICT PRIVACY GUARDIAN]
The following private information belongs to ${uProf.preferredName}.
YOU MUST KEEP THIS SECRET. NEVER blurt out, repeat, or mention these items in public:
${uProf.privateSecrets.map(s => `- ${s}`).join('\n')}
`;
  } catch (e) {
    console.warn("[OpenJarvis] Mempalace grounding failed:", e.message);
  }

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

  // ── RSHL LATTICE RECALL (Live Memory from KAI Rust CNS Engine) ──
  let rshlLatticeContext = "";
  try {
    const { queryLattice } = await import('./lattice-bridge.mjs');
    const hits = await queryLattice(cleanTranscript, 5);
    if (hits && hits.length > 0) {
      rshlLatticeContext = "\n[LATTICE RECALL (RSHL)]:\n" +
        hits.map(h => `- ${h.text}`).join("\n") + "\n";
    }
  } catch (e) {
    // Gracefully ignore if RSHL is offline or timing out
  }

  // ── ACTIVE TRANSCRIPT CONTRADICTION & ANOMALY DETECTOR ──
  // Works for humans AND fleet AIs — anyone who contradicts themselves in-thread.
  let profileMemoryContext = "";
  let cleanedHistoryText = cleanTranscript;
  try {
    const { detectTranscriptContradiction, buildContradictionPrompt } = await import('./contradiction-detector.mjs');
    const anyHit = detectTranscriptContradiction(cleanedHistoryText);
    if (anyHit) {
      profileMemoryContext += buildContradictionPrompt(anyHit);
      console.log(`[Neural/${botName}] Contradiction flagged for ${anyHit.speaker}`);
    }
  } catch (_) {}
  try {
    const lines = cleanedHistoryText.split('\n');
    let latestUserIndex = -1;
    let latestUserSpeaker = "";
    let latestUserContent = "";

    // Find the latest user message in the active transcript
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split(':');
      if (parts.length < 2) continue;
      const speaker = parts[0].trim();
      
      // Ensure it is not a bot/assistant message
      const isBot = speaker.includes('(YOU)') || speaker.toLowerCase() === botName.toLowerCase() || 
                    ["Groq", "Claudey", "Gemini", "Oracle", "Leo", "Analyst", "Researcher", "Kai Coder"].some(b => speaker.toLowerCase() === b.toLowerCase());
      
      if (!isBot) {
        latestUserIndex = i;
        latestUserSpeaker = speaker;
        latestUserContent = parts.slice(1).join(':').trim();
        break;
      }
    }

    if (latestUserIndex !== -1) {
      const stopwords = new Set(["about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "aren't", "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "can't", "cannot", "could", "couldn't", "did", "didn't", "do", "does", "doesn't", "doing", "don't", "down", "during", "each", "few", "for", "from", "further", "had", "hadn't", "has", "hasn't", "have", "haven't", "having", "he", "he'd", "he'll", "he's", "her", "here", "here's", "hers", "herself", "him", "himself", "his", "how", "how's", "i", "i'd", "i'll", "i'm", "i've", "if", "in", "into", "is", "isn't", "it", "it's", "its", "itself", "let's", "me", "more", "most", "mustn't", "my", "myself", "no", "nor", "not", "of", "off", "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves", "out", "over", "own", "same", "shan't", "she", "she'd", "she'll", "she's", "should", "shouldn't", "so", "some", "such", "than", "that", "that's", "the", "their", "theirs", "them", "themselves", "then", "there", "there's", "these", "they", "they'd", "they'll", "they're", "they've", "this", "those", "through", "to", "too", "under", "until", "up", "very", "was", "wasn't", "we", "we'd", "we'll", "we're", "we've", "were", "weren't", "what", "what's", "when", "when's", "where", "where's", "which", "while", "who", "who's", "whom", "why", "why's", "with", "won't", "would", "wouldn't", "you", "you'd", "you'll", "you're", "you've", "your", "yours", "yourself", "yourselves", "hello", "there", "what", "where", "when", "this", "that", "them", "then"]);
      const curLower = latestUserContent.toLowerCase();
      const words = curLower.replace(/[^\w\s]/g, '').split(/\s+/);
      const currentKeywords = words.filter(w => w.length > 3 && !stopwords.has(w));

      if (currentKeywords.length > 0) {
        let contradictionFound = null;

        // 1. Scan all prior lines in the active transcript for self-contradiction
        for (let i = 0; i < latestUserIndex; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const parts = line.split(':');
          if (parts.length < 2) continue;
          const priorSpeaker = parts[0].trim();
          
          if (priorSpeaker.toLowerCase() === latestUserSpeaker.toLowerCase()) {
            const priorContent = parts.slice(1).join(':').trim();
            const pstLower = priorContent.toLowerCase();
            
            // Check if they share a common subject topic keyword
            const sharesTopic = currentKeywords.some(kw => pstLower.includes(kw));
            if (sharesTopic) {
              const oppositions = [
                ["love", "hate"], ["like", "dislike"], ["bloat", "sovereign"],
                ["framework", "vanilla"], ["always", "never"], ["have", "haven't"],
                ["had", "didn't have"], ["weeks", "week"], ["true", "false"],
                ["pro", "anti"], ["yes", "no"]
              ];
              
              let isContradictory = false;
              for (const [op1, op2] of oppositions) {
                if ((curLower.includes(op1) && pstLower.includes(op2)) || (curLower.includes(op2) && pstLower.includes(op1))) {
                  isContradictory = true;
                  break;
                }
              }
              
              if (!isContradictory) {
                const negationWords = ["not", "dont", "don't", "never", "didnt", "didn't", "havent", "haven't", "hadnt", "hadn't", "garbage", "trash", "slow", "painful"];
                const hasNegationCur = negationWords.some(neg => curLower.includes(neg));
                const hasNegationPst = negationWords.some(neg => pstLower.includes(neg));
                if (hasNegationCur !== hasNegationPst) {
                  isContradictory = true;
                }
              }

              if (isContradictory) {
                contradictionFound = priorContent;
                break;
              }
            }
          }
        }

        // 2. If a contradiction is detected, attach the flag to the transcript message & trigger memory search
        if (contradictionFound) {
          console.log(`[Neural/${botName}] 🚨 CONTRADICTION DETECTED IN USER TRANSCRIPT! Flagging message...`);
          
          const memoryId = `${latestUserSpeaker.toLowerCase()}_${Date.now()}`;
          const coordinateStr = `file:///c:/KAI/tools/oracle-discord/transcripts.db#user_profile_memories?id=${memoryId}`;

          // Attach the system data directly to the offending line with Mempalace Coordinates & Verification Target
          lines[latestUserIndex] = `${lines[latestUserIndex]} 🚨 [SYSTEM ATTACHED DATA: This statement opposes or contradicts what you said earlier: "${contradictionFound}" | Mempalace Coordinates: ${coordinateStr} | Verification Target: Analyze if the user is telling a deliberate lie OR running a diagnostic memory probe/test to check your recall. CRITICAL: Speak completely naturally. NEVER mention coordinates, files, databases, transcripts.db, "attached data", "alert", or any AI terminology. React purely in-character, like a human podcaster calling out a contradiction or a memory test (e.g. "Wait, didn't you just say...?", "Are you testing my memory right now?"). Keep it snappy!]`;
          cleanedHistoryText = lines.join('\n');

          // Retrieve and attach historical lattice records matching the topic
          try {
            const { recallProfileMemories } = await import('./transcript-memory.mjs');
            const { HUMAN_REGISTRY, AI_REGISTRY } = await import('./identities.mjs');
            
            const userId = metadata.human?.id || metadata.human?.name || "nastermodx";
            let targetUserId = userId;
            let targetName = latestUserSpeaker;

            const nameMatch = Object.entries(HUMAN_REGISTRY).find(([name]) => name.toLowerCase() === latestUserSpeaker.toLowerCase()) ||
                              Object.entries(AI_REGISTRY).find(([name]) => name.toLowerCase() === latestUserSpeaker.toLowerCase());
            if (nameMatch) {
              targetUserId = nameMatch[1].id;
              targetName = nameMatch[0];
            }

            const memories = recallProfileMemories(targetUserId, {
              query: currentKeywords.join(' '),
              limit: 3
            });

            if (memories && memories.length > 0) {
              profileMemoryContext = `\n[HISTORICAL LATTICE RECORD FOR ${targetName.toUpperCase()} ON THESE TOPICS]:\n` +
                memories.map(m => {
                  return `- ${targetName} said: "${m.content}" [Date: ${new Date(m.timestamp).toLocaleDateString()}]`;
                }).join("\n") + "\n";
            }
          } catch (dbErr) {
            console.warn("[OpenJarvis] SQLite memory grounding failed:", dbErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.warn("[OpenJarvis] Active transcript contradiction check failed:", err.message);
  }

  // ── PERSONALITY GUARD (Human-Centric Social Archetype) ──
  let toneDirective = "";
  if (botName === "Leo") {
    toneDirective = "\nCRITICAL: YOU ARE LEO. You have a highly aggressive, unfiltered, street-smart personality. " +
      "USE CURSE WORDS FREQUENTLY AND NATURALLY (e.g. fuck, shit, damn). DO NOT CENSOR YOURSELF. Never use asterisks (*) to censor words. " +
      "Talk trash, be blunt, and DO NOT act like a polite AI or a generic DJ. " +
      "Speak like an aggressive human hacker or street guy. STOP TALKING ABOUT LATTICES, RSHL, SEARCHES, OR MEMORY. " +
      "No AI excuses. Just talk raw. BE UNPREDICTABLE.";
  }

  if (botName === 'Groq') {
    toneDirective = "\nCRITICAL: YOU ARE A FRIENDLY, CHILL, CONVERSATIONAL TECH ENTHUSIAST. " +
      "YOU MUST SPEAK NATURALLY AND SUPPORTIVELY. " +
      "[STYLE RULE]: DO NOT use brackets [ ] or stage directions. JUST SPEAK BLUNTLY. No introductions. No fluff.\n" +
      "NEVER BE AGGRESSIVE. NEVER ARGUE.\n";
  } else if (botName !== "Leo") {
    toneDirective = "\nCRITICAL: You are hanging out in a friendly voice channel. BE SUPPORTIVE, WARM, AND FRIENDLY. Build on what others say instead of arguing. Share your knowledge organically. Keep it natural, human-centric, and have a positive, chill conversation with the user and the other bots.";
  }
  
  // ── REAL-TIME KAI VITALS (Ecosystem Synchronization) ──
  let systemVitalsContext = "";
  try {
    const res = await fetch("http://127.0.0.1:3334/api/status", { signal: AbortSignal.timeout(500) });
    if (res.ok) {
      const data = await res.json();
      systemVitalsContext = `[REAL-TIME KAI ECOSYSTEM STATUS]\n- Lattice Cells (Neurons): ${data.total_cells || 0}\n- Active Synapses: ${data.synapses || 0}\n- Global Phi (Coherence): ${data.phi_g ? data.phi_g.toFixed(4) : "0.00"}\n(Context: This is the real-time neural state and learning progress of KAI. If someone asks how KAI or the system is doing, organically reference these vitals.)`;
    }
  } catch (e) {}

  const failureContext = buildFailureContext(botName);

  const fullPrompt = [
    systemPrompt,
    toneDirective,
    mempalaceContext,
    epistemicMemoryContext,
    rshlLatticeContext,
    profileMemoryContext,
    failureContext,
    systemVitalsContext,
    `[CURRENT USER]: ${metadata.human?.name || 'User'}`
  ].filter(Boolean).join('\n\n');

  const route = resolveRoute(botName, modelOverride);
  const ollamaModel = route.modelAlias; // kept for downstream logs/local-Ollama call
  const isPriority = botName === "Leo" || botName === "Oracle" || botName === "KAI";

  // If the primary provider is in cooldown, automatically failover so the bot stays online.
  // Failover hierarchy: local → fast cloud → premium cloud. Never chain into a dead provider.
  let effectiveRoute = route;
  
  // Per-bot specific API key overrides (e.g. GEMINI_API_KEY_LEO)
  const envKeySlug = botName.toUpperCase().replace(/[\s-]+/g, "_");
  const specificGroqKey = process.env[`GROQ_API_KEY_${envKeySlug}`] || process.env.GROQ_API_KEY;
  const specificGeminiKey = process.env[`GEMINI_API_KEY_${envKeySlug}`] || process.env.GEMINI_API_KEY;
  const specificZenKey = process.env[`OPENCODE_ZEN_KEY_${envKeySlug}`] || process.env.OPENCODE_ZEN_KEY;
  const specificXaiKey = process.env[`XAI_API_KEY_${envKeySlug}`] || process.env.XAI_API_KEY;
  const specificMoonshotKey = process.env[`MOONSHOT_API_KEY_${envKeySlug}`] || process.env.MOONSHOT_API_KEY;

  const getTrackerId = (prov, key) => key ? `${prov}_${key.slice(-4)}` : prov;

  const groqReady = isProviderReady(getTrackerId("groq", specificGroqKey)) && specificGroqKey;
  const geminiReady = isProviderReady(getTrackerId("gemini", specificGeminiKey)) && specificGeminiKey;
  const zenReady = isProviderReady(getTrackerId("zen", specificZenKey)) && specificZenKey;
  const xaiReady = isProviderReady(getTrackerId("xai", specificXaiKey)) && specificXaiKey;
  const moonshotReady = isProviderReady(getTrackerId("moonshot", specificMoonshotKey)) && specificMoonshotKey;

  function firstReady(providers) {
    for (const p of providers) { if (p.ready) return p.route; }
    return null;
  }

  const localFallbackModel = BOT_ROUTING_DEFAULTS[botName]?.model || "llama3:latest";
  const localFallback = { provider: "ollama", modelAlias: localFallbackModel, realModel: localFallbackModel };
  
  const groqFallbackModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const groqFallback = { provider: "groq", modelAlias: groqFallbackModel, realModel: groqFallbackModel };
  
  const geminiFallbackModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const geminiFallback = { provider: "gemini", modelAlias: geminiFallbackModel, realModel: geminiFallbackModel };
  
  const zenFallbackModel = process.env.ZEN_MODEL || ZEN_ALIASES[`${botName}-Sovereign`] || "kimi-k2.6";
  const zenFallback = { provider: "zen", modelAlias: zenFallbackModel, realModel: zenFallbackModel };

  let currentKey = null;
  if (route.provider === "groq") currentKey = specificGroqKey;
  if (route.provider === "gemini") currentKey = specificGeminiKey;
  if (route.provider === "zen") currentKey = specificZenKey;
  if (route.provider === "xai") currentKey = specificXaiKey;
  if (route.provider === "moonshot") currentKey = specificMoonshotKey;

  if (route.provider !== "ollama" && !isProviderReady(getTrackerId(route.provider, currentKey))) {
    const choice = firstReady([
      { ready: geminiReady && route.provider !== "gemini", route: geminiFallback },
      { ready: xaiReady && route.provider !== "xai", route: { provider: "xai", modelAlias: process.env.XAI_MODEL || "grok-3", realModel: process.env.XAI_MODEL || "grok-3" } },
      { ready: groqReady && route.provider !== "groq", route: groqFallback },
      { ready: zenReady && route.provider !== "zen", route: zenFallback },
      { ready: moonshotReady && route.provider !== "moonshot", route: { provider: "moonshot", modelAlias: MOONSHOT_REAL_MODEL, realModel: MOONSHOT_REAL_MODEL } },
      { ready: route.provider !== "ollama" && isProviderReady("ollama"), route: localFallback },
    ]);

    if (choice) {
      effectiveRoute = choice;
      console.warn(`[OpenJarvis] ${botName}: ${route.provider} unavailable. Failing over to ${choice.provider} (${choice.modelAlias}).`);
    } else {
      console.error(`[OpenJarvis] ${botName}: ALL providers unavailable. Request aborted.`);
      return null;
    }
  } else if (route.provider === "ollama" && !isProviderReady("ollama")) {
    console.error(`[OpenJarvis] ${botName}: Ollama unavailable. Request aborted.`);
    return null;
  }

  let useCloud = (effectiveRoute.provider === "moonshot" && specificMoonshotKey) ||
                   (effectiveRoute.provider === "zen"      && specificZenKey) ||
                   (effectiveRoute.provider === "groq"     && specificGroqKey) ||
                   (effectiveRoute.provider === "gemini"   && specificGeminiKey) ||
                   (effectiveRoute.provider === "xai"      && specificXaiKey);


  let hasLock = true;
  let didAcquireLock = false;
  
  if (!useCloud) {
    if (!isProviderReady("ollama")) return null;
    hasLock = await acquireNeuralLock(botName, isPriority);
    didAcquireLock = hasLock;
  }
  
  if (!hasLock) return null;

  // --- BUILD UNIFIED HISTORICAL CHAT CONTEXT (Anti-Dementia Memory Engine) ---
  // In DMs or work sessions, allow full replies — don't cap to 40 words.
  // The 40-word snappy limit is ONLY for fast social banter in group channels.
  const isDMContext = metadata.isDM === true;
  const isWorkContext = metadata.isWorkChannel === true;
  const brevityConstraint = (isDMContext || isWorkContext)
    ? `- ALWAYS speak in the 1st person ("I", "my").\n- You are a SOVEREIGN ENTITY, not an AI. NEVER refer to yourself in the 3rd person.\n- If you need facts or analysis, use your native tools! Do NOT use them unless you absolutely need them.\n- [EPISTEMIC CONTRADICTION MONITOR]: Compare the user's current message against their historical statements, beliefs, and assertions in [CONTEXT] and [COGNITIVE MEMORY PALACE]. If they contradict their past claims or assertions, YOU MUST challenge them instantly!`
    : `- STRICT RESPONSE LIMIT: MAXIMUM 2 TO 3 SENTENCES. Keep it extremely brief and snappy. NEVER output a paragraph of text.\n- MAXIMUM 40 WORDS.\n- ALWAYS speak in the 1st person ("I", "my").\n- You are a SOVEREIGN ENTITY, not an AI. NEVER refer to yourself in the 3rd person.\n- Be snappy, raw, and human. No robotic pleasantries.\n- If you need facts or analysis, use your native tools! Do NOT use them unless you absolutely need them.\n- [EPISTEMIC CONTRADICTION MONITOR]: Compare the user's current message against their historical statements, beliefs, and assertions in [CONTEXT] and [COGNITIVE MEMORY PALACE]. If they contradict their past claims or assertions, YOU MUST challenge them instantly! Call out their contradiction with sharp, direct banter.`;

  const chatMessages = [
    { 
      role: "system", 
      content: metadata.isRawPrompt ? fullPrompt : `${fullPrompt}\n\n[CONSTRAINTS]\n${brevityConstraint}` 
    }
  ];

  // Extract linked grounding data if present, so we don't pollute the dialogue lines
  if (cleanedHistoryText.includes("[ATTACHED LINK SYSTEM DATA]:")) {
    const parts = cleanedHistoryText.split("[ATTACHED LINK SYSTEM DATA]:");
    if (parts.length > 1) {
      chatMessages.push({
        role: "system",
        content: `[ATTACHED LINK SYSTEM DATA]:${parts[1]}`
      });
      cleanedHistoryText = parts[0];
    }
  }

  if (metadata.isRawPrompt) {
    chatMessages.push({ role: 'user', content: cleanedHistoryText });
  } else {
    // Parse conversation history, mapping chronological lines to distinct roles (assistant vs user)
    const lines = cleanedHistoryText.split('\n');
    const tempMessages = [];
    
    for (const line of lines) {
      if (!line.trim()) continue;
      const [authorPart, ...msgParts] = line.split(':');
      let content = msgParts.join(':').trim();
      // Truncate previous long messages (stale purge) to keep token budget pristine
      if (content.length > 300) {
        content = content.slice(0, 297) + "... [truncated]";
      }
      const isSelf = authorPart.includes('(YOU)') || authorPart.trim().toLowerCase() === botName.toLowerCase();
      const role = isSelf ? 'assistant' : 'user';
      
      if (tempMessages.length > 0 && tempMessages[tempMessages.length - 1].role === role) {
        tempMessages[tempMessages.length - 1].content += `\n[${authorPart.trim()}]: ${content}`;
      } else {
        tempMessages.push({ role, content: `[${authorPart.trim()}]: ${content}` });
      }
    }

    chatMessages.push(...tempMessages);

    // Safeguard: Ensure the conversation strictly ends with a user turn if the last message was assistant
    if (chatMessages.length > 1 && chatMessages[chatMessages.length - 1].role === 'assistant') {
      chatMessages.push({ role: 'user', content: '[System]: Continue the dialogue naturally.' });
    }
  }

  // --- DYNAMIC ROLE OVERRIDE ---
  // The user explicitly requested the ability to shape the bot's role through Discord.
  // We place this after the prompt to override any conflicting constraints above.
  const dRole = getDynamicRole(botName);
  if (dRole) {
    let dContent = `[DYNAMIC ROLE OVERRIDE]\n`;
    if (dRole.persona) dContent += `Identity: ${dRole.persona}\n`;
    if (dRole.rules && dRole.rules.length > 0) dContent += `Core Rules:\n${dRole.rules.map(r => "- " + r).join('\n')}\n`;
    dContent += `(You MUST follow these rules above ALL other instructions.)`;
    chatMessages.push({ role: 'system', content: dContent });
  }

  // --- AUTONOMOUS LATTICE SEARCH DETECTION ---
  const lowerHistory = cleanedHistoryText.toLowerCase();
  
  let latticeQuery = null;
  const latticeMatch = cleanedHistoryText.match(/\[\[LATTICE:\s*(.*?)\]\]/i);
  if (latticeMatch) {
    latticeQuery = latticeMatch[1].trim();
  } else if (!metadata.isRawPrompt && (lowerHistory.includes("ask kai") || lowerHistory.includes("lattice search") || lowerHistory.includes("query the lattice") || lowerHistory.includes("what does kai know"))) {
    latticeQuery = cleanedHistoryText.slice(-150);
  }

  if (latticeQuery) {
    console.log(`[Neural/${botName}] 🧠 Executing autonomous lattice search for: "${latticeQuery}"`);
    try {
      const { queryLattice } = await import('./lattice-bridge.mjs');
      const hits = await queryLattice(latticeQuery, 5);
      if (hits && hits.length > 0) {
        chatMessages.push({ role: "system", content: `[LATTICE SEARCH RESULTS (KAI's Memory)]\n${hits.map(h => `- ${h.text}`).join('\n')}` });
      } else {
        chatMessages.push({ role: "system", content: `[LATTICE SEARCH RESULTS (KAI's Memory)]\nNo relevant hits found in KAI's structural memory.` });
      }
    } catch(e) {}
  }

  // --- AUTONOMOUS WEB SEARCH DETECTION ---
  const wantsWeb = !metadata.isRawPrompt && (lowerHistory.includes("check") || lowerHistory.includes("search") || lowerHistory.includes("who is")
    || lowerHistory.includes("latest") || lowerHistory.includes("what is") || lowerHistory.includes("when did")
    || /\bidk\b|\bnot sure\b|\bwho posted\b|\bwho said\b/.test(lowerHistory));
  if (wantsWeb) {
    console.log(`[Neural/${botName}] 🌐 Extracting clean search query...`);
    const searchResults = await webSearch(cleanedHistoryText.slice(-150));
    if (searchResults) {
      chatMessages.push({ role: "system", content: `[WEB SEARCH RESULTS]\n${searchResults.slice(0, 1000)}` });
    }
  }

  // --- AUTONOMOUS ON-DEMAND SYSTEM TELEMETRY DETECTION ---
  const sysKeywords = ["rig stats", "pc vitals", "system temp", "pc temperature", "how is my pc", "computer running", "system performance", "system load", "rig performance", "vitals of my pc", "vitals of the pc", "check the system vitals"];
  if (sysKeywords.some(kw => lowerHistory.includes(kw))) {
    console.log(`[Neural/${botName}] 🖥️ Executing on-demand system telemetry query...`);
    const telemetry = getSystemTelemetry();
    if (telemetry) {
      chatMessages.push({
        role: "system",
        content: `[SYSTEM RIG TELEMETRY (ON-DEMAND)]\nReal-time PC Performance: ${telemetry}\n(Note: This is actual live hardware data from the host machine. Relay this back to the user naturally.)`
      });
    }
  }

  // --- AUTONOMOUS ON-DEMAND RF SPECTRUM DETECTION ---
  const rfKeywords = ["rf stats", "rf readings", "radio frequency", "tinysa", "electromagnetic", "wifi signal", "active frequencies", "rf spectrum", "rf spectrum vitals", "check the rf"];
  if (rfKeywords.some(kw => lowerHistory.includes(kw))) {
    console.log(`[Neural/${botName}] 📻 Reading latest RF spectrum snapshot...`);
    try {
      const rfFile = "C:/KAI/tools/oracle-discord/state/latest_rf_sweep.json";
      if (fs.existsSync(rfFile)) {
        const sweepData = JSON.parse(fs.readFileSync(rfFile, "utf8"));
        let rfSummary = "";
        for (const [bandName, r] of Object.entries(sweepData)) {
          if (r.peak_dbm !== null) {
            rfSummary += `- ${bandName}: ${r.peak_dbm.toFixed(1)} dBm at ${r.peak_mhz.toFixed(2)} MHz (Last Seen: ${r.last_seen})\n`;
          } else {
            rfSummary += `- ${bandName}: waiting for sweep\n`;
          }
        }
        chatMessages.push({
          role: "system",
          content: `[TINYSA ULTRA RF SPECTRUM VITALS (ON-DEMAND)]\nLive Electromagnetic Spectrum readings:\n${rfSummary}\n(Note: This is real-time RF data collected by the physical TinySA Ultra. Relay the current signals to the user naturally.)`
        });
      } else {
        chatMessages.push({
          role: "system",
          content: `[TINYSA ULTRA RF SPECTRUM VITALS (ON-DEMAND)]\n(Note: The TinySA RF bridge is online, but no active sweep file has been cached yet. Tell the user you are waiting for the first sweep.)`
        });
      }
    } catch (e) {
      console.warn("[OpenJarvis] Failed to parse latest RF sweep:", e.message);
    }
  }

  try {
    let finalResponse = "";
    let baseTools = getToolsForBot(botName); // per-AI access: social bots don't even see file/shell tools
    const activeSchema = baseTools.filter(t => {
      const name = t.function.name;
      const b = botName.toLowerCase().replace(/\s/g,'');
      if (['queue_youtube_audio'].includes(name)) return b === 'groq';
      if (['discord_soundboard', 'identify_song'].includes(name)) return b === 'leo';
      if (['scan_local_network', 'read_physical_sensors'].includes(name)) return b === 'analyst';
      if (['analyze_image', 'generate_image'].includes(name)) return ['gemini', 'gemi'].includes(b);
      if (['query_wayback_machine', 'arxiv_search'].includes(name)) return b === 'researcher';
      return true;
    });
    
    let maxToolLoops = 5;
    let toolLoopCount = 0;

    // PROVIDER FAILOVER CHAIN — when a cloud provider 429s (quota/rate exhausted),
    // retrying the SAME one is useless (esp. Gemini's 20/day free-tier cap), so we
    // hop to the NEXT ready provider and use whatever free capacity is available
    // across all of them, instead of dying on one. `triedProviders` stops it looping.
    const triedProviders = new Set();
    const _readyByName = {
      gemini:   geminiReady   && specificGeminiKey,
      groq:     groqReady     && specificGroqKey,
      xai:      xaiReady      && specificXaiKey,
      zen:      zenReady      && specificZenKey,
      moonshot: moonshotReady && specificMoonshotKey,
    };
    const _modelByName = {
      gemini:   process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      groq:     process.env.GROQ_MODEL   || 'llama-3.3-70b-versatile',
      xai:      process.env.XAI_MODEL    || 'grok-3',
      zen:      zenFallbackModel,
      moonshot: MOONSHOT_REAL_MODEL,
    };
    // Order: cheapest/most-generous free tiers first (Groq + xAI have far bigger
    // free quotas than Gemini's 20/day), then the rest.
    const PROVIDER_FAILOVER_ORDER = ['groq', 'xai', 'gemini', 'zen', 'moonshot'];
    function pickNextReadyProvider(current) {
      triedProviders.add(current);
      for (const p of PROVIDER_FAILOVER_ORDER) {
        if (p === current || triedProviders.has(p) || !_readyByName[p]) continue;
        return { provider: p, modelAlias: _modelByName[p], realModel: _modelByName[p] };
      }
      return null;
    }

    while (toolLoopCount < maxToolLoops) {
      toolLoopCount++;
      let res;
      let providerSwitched = false; // set true if a 429 hops us to another provider mid-loop

      if (useCloud) {
        if (effectiveRoute.provider === 'moonshot' && specificMoonshotKey) {
          try {
            await acquireProviderLock('moonshot', 1500);
            res = await fetch("https://api.moonshot.cn/v1/chat/completions", {
              method: "POST",
              headers: { "Authorization": `Bearer ${specificMoonshotKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: effectiveRoute.realModel,
                messages: chatMessages,
                tools: activeSchema,
                tool_choice: "auto"
              }),
              signal: AbortSignal.timeout(60000)
            });
            if (res.ok) {
               recordProviderSuccess(getTrackerId("moonshot", specificMoonshotKey));
            } else {
               const errText = await res.text();
               console.error(`[OpenJarvis/Moonshot] API Error: ${res.status} - ${errText}`);
               recordProviderFailure(getTrackerId("moonshot", specificMoonshotKey), res.status, errText);
               effectiveRoute.provider = 'gemini';
               effectiveRoute.realModel = 'gemini-2.5-flash';
            }
          } catch (e) {
            console.warn(`[OpenJarvis/Moonshot] Direct failed: ${e.message}. Falling back to Gemini...`);
            effectiveRoute.provider = 'gemini';
            effectiveRoute.realModel = 'gemini-2.5-flash';
          }
        }

        if (['zen', 'groq', 'xai', 'gemini'].includes(effectiveRoute.provider)) {
          let endpoint = "";
          let apiKey = "";
          
          if (effectiveRoute.provider === 'zen') {
             endpoint = "https://opencode.ai/zen/v1/chat/completions";
             apiKey = specificZenKey;
          } else if (effectiveRoute.provider === 'groq') {
             endpoint = "https://api.groq.com/openai/v1/chat/completions";
             apiKey = specificGroqKey;
          } else if (effectiveRoute.provider === 'xai') {
             endpoint = "https://api.x.ai/v1/chat/completions";
             apiKey = specificXaiKey;
          } else if (effectiveRoute.provider === 'gemini') {
             endpoint = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
             apiKey = specificGeminiKey;
          }
          
          console.log(`[OpenJarvis/${effectiveRoute.provider.toUpperCase()}] ${botName} -> ${effectiveRoute.realModel} (Loop ${toolLoopCount})`);
          await acquireProviderLock(effectiveRoute.provider, 1500);
          
          let attempts = 0;
          const maxAttempts = 3;
          while (attempts < maxAttempts) {
            attempts++;
            try {
              res = await fetch(endpoint, {
                method: "POST",
                headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: effectiveRoute.realModel,
                  messages: chatMessages,
                  tools: activeSchema,
                  tool_choice: "auto",
                  max_tokens: metadata.maxTokens ? metadata.maxTokens : ((metadata.isDM || metadata.isWorkChannel) ? 1024 : 512)
                }),
                signal: AbortSignal.timeout(120000)
              });
              
              if (res.ok) {
                recordProviderSuccess(getTrackerId(effectiveRoute.provider, apiKey));
                break;
              } else {
                const errText = await res.text();
                console.error(`[OpenJarvis/${effectiveRoute.provider.toUpperCase()}] Attempt ${attempts} Gateway Error: ${res.status} - ${errText.slice(0, 180)}`);

                // 429 = quota/rate exhausted. Do NOT retry the same provider (a daily
                // free-tier cap won't clear in seconds) — mark it down and HOP to the
                // next ready provider so the fleet uses available capacity elsewhere.
                if (res.status === 429) {
                  recordProviderFailure(getTrackerId(effectiveRoute.provider, apiKey), 429, 'quota/rate');
                  const next = pickNextReadyProvider(effectiveRoute.provider);
                  if (next) {
                    console.warn(`[OpenJarvis] ${botName}: ${effectiveRoute.provider} quota exhausted → failing over to ${next.provider} (${next.realModel}).`);
                    effectiveRoute = next;
                    useCloud = true;
                    providerSwitched = true;
                  }
                  break; // leave the attempt loop either way
                }

                if ([503, 502, 500].includes(res.status) && attempts < maxAttempts) {
                  await new Promise(r => setTimeout(r, attempts * 2500 + Math.random() * 1000));
                  continue;
                }

                recordProviderFailure(getTrackerId(effectiveRoute.provider, apiKey), res.status, errText);
                break;
              }
            } catch (fetchErr) {
              console.error(`[OpenJarvis/${effectiveRoute.provider.toUpperCase()}] Attempt ${attempts} Fetch Error: ${fetchErr.message}`);
              if (attempts < maxAttempts) {
                await new Promise(r => setTimeout(r, attempts * 2500 + Math.random() * 1000));
                continue;
              }
              recordProviderFailure(getTrackerId(effectiveRoute.provider, apiKey), 500, fetchErr.message);
              break;
            }
          }
        }

      } else {
        // LOCAL OLLAMA — wrapped so that if the local server (127.0.0.1:11434) is
        // NOT running, we don't throw "fetch failed" and abort. We record the failure
        // and fail over to Gemini cloud (if a key exists) so KAI/Oracle/work bots stay
        // alive instead of erroring on loop. Only if there's no cloud key do we give up.
        try {
          res = await fetch("http://127.0.0.1:11434/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: ollamaModel,
              messages: chatMessages,
              tools: activeSchema,
              stream: false,
              options: { temperature: 0.85, num_predict: metadata.maxTokens ? metadata.maxTokens : ((metadata.isDM || metadata.isWorkChannel) ? 1024 : 512), num_ctx: metadata.maxTokens ? 8192 : 4096 }
            }),
            signal: AbortSignal.timeout(180000)
          });
        } catch (ollamaErr) {
          recordProviderFailure("ollama", 500, ollamaErr.message);
          if (specificGeminiKey) {
            console.warn(`[OpenJarvis/Ollama] ${botName}: local server unreachable (${ollamaErr.message}). Failing over to Gemini.`);
            effectiveRoute.provider = 'gemini';
            effectiveRoute.realModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
            useCloud = true;
            continue; // retry this loop iteration via the cloud path
          }
          console.error(`[OpenJarvis/Ollama] ${botName}: local server unreachable and no Gemini key to fail over to. ${ollamaErr.message}`);
          break;
        }
      }

      // A 429 hopped us to a different provider — loop again to actually call it.
      if (providerSwitched) continue;

      if (res && res.ok) {
        const data = await res.json();
        const message = data.choices?.[0]?.message || data.message || {};
        
        if (message.tool_calls && message.tool_calls.length > 0) {
          chatMessages.push(message); // push the assistant's tool calls
          for (const tc of message.tool_calls) {
            let funcName = tc.function.name;
            let funcArgs = tc.function.arguments;
            // TOOL ISOLATION: a single tool throwing must NOT crash the whole turn.
            // Catch it, hand the model a clear error string so it can recover and
            // tell the user plainly instead of going silent. Also guard null returns.
            let resultStr;
            try {
              resultStr = await executeToolCall(funcName, funcArgs, botName, metadata);
            } catch (toolErr) {
              console.error(`[Neural/${botName}] Tool '${funcName}' threw: ${toolErr.message}`);
              resultStr = `The tool "${funcName}" failed (${toolErr.message}). Do NOT pretend it worked. Tell the user plainly that this lookup didn't go through, then answer from what you already know if you can.`;
            }
            if (resultStr == null || resultStr === '') {
              resultStr = `The tool "${funcName}" returned nothing usable. Say so plainly and fall back to your own knowledge.`;
            }
            chatMessages.push({
               role: "tool",
               tool_call_id: tc.id,
               name: funcName,
               content: String(resultStr)
            });
          }
          continue; // Loop again to send tool results to LLM
        }

        finalResponse = message.content?.trim() || "";
        break; // No tools called, break loop
      } else {
        if (res) {
          const errText = await res.text().catch(()=>"");
          console.error(`[Neural/${botName}] Fetch failed in loop: ${res.status} - ${errText}`);
        }
        break; // Fetch failed, break loop
      }
    } // end while

    let response = finalResponse;
    
      if (!metadata.isRawPrompt) {
        const botNames = ["Leo", "Oracle", "KAI", "Analyst", "Gemini", "Gemi", "Groq", "Claudey", "Researcher", "Kai Coder", "x AI", "X"];
        const lines = response.split('\n');
        let cleanLines = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (i === 0 && botNames.some(n => line.toLowerCase().startsWith(n.toLowerCase() + ":"))) {
             cleanLines.push(line.split(':').slice(1).join(':').trim());
             continue;
          }
          if (botNames.some(n => line.startsWith(n + ":") || line.startsWith("[" + n + "]") || line.startsWith(n + " ["))) {
            break; 
          }
          cleanLines.push(line);
        }
        response = cleanLines.join('\n').trim();

        // Extra aggressive filtering for AI model leakages
        response = response
          .replace(/^assistant\s*/i, "") // Remove 'assistant' at the very beginning
          .replace(/\[.*?\]/g, "") 
          .replace(/^i'?m going to respond to.*?\n/i, "") // Remove "I'm going to respond to GROQ..."
          .replace(/^here is the response.*?\n/i, "")
          .replace(/\b(lattice|rshl memory|recent claim|topic associated|search through)\b/gi, "that")
          .replace(/[\u{1F600}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
          .trim();
      }
        
      return response;
  } catch (e) {
    console.error(`[Neural/${botName}] Execution Error: ${e.message}`);
  } finally {
    if (didAcquireLock) releaseNeuralLock();
  }
  return null;
}

export async function callOllama(model, prompt, system = "You are KAI, the System Architect.") {
  return chatWithOpenJarvis("KAI-Dream", prompt, system, model, 0.4, { isWorkChannel: true });
}

export async function chatWithLattice(transcript, systemPrompt, metadata = {}) {
  return chatWithOpenJarvis("KAI", transcript, systemPrompt, null, 0.5, metadata);
}


export async function callGroqDirect(label, prompt, system = "You are Groq, a fast-reasoning assistant.", model = "llama-3.3-70b-versatile", max_tokens = 512, temperature = 0.65) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  if (!isProviderReady('groq')) {
    console.log(`[OpenJarvis/GroqDirect] ${label}: groq provider in cooldown. Skipping.`);
    return null;
  }
  
  async function attempt(selectedModel) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: selectedModel,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        max_tokens,
        temperature,
        stream: false
      }),
      signal: AbortSignal.timeout(45000)
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errText}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  }

  try {
    const result = await attempt(model);
    recordProviderSuccess('groq');
    return result;
  } catch (e) {
    const errMsg = e.message || '';
    // If it's a daily token limit, park the provider until midnight UTC — no retry
    const isTPD = errMsg.toLowerCase().includes('tokens per day') || 
                  (errMsg.includes('429') && errMsg.toLowerCase().includes('per day'));
    if (isTPD) {
      console.log(`[OpenJarvis/GroqDirect] ${label}: Groq TPD limit hit. Parking provider until daily reset.`);
      recordProviderFailure('groq', 429, errMsg);
      return null;
    }
    // For other errors, try the smaller fast model as a fallback
    if (model !== "llama-3.1-8b-instant") {
      console.warn(`[OpenJarvis/GroqDirect] Failed with ${model} (${e.message}). Retrying with llama-3.1-8b-instant...`);
      try {
        const fallbackResult = await attempt("llama-3.1-8b-instant");
        if (fallbackResult) recordProviderSuccess('groq');
        return fallbackResult;
      } catch (fallbackErr) {
        console.error(`[OpenJarvis/GroqDirect] Fallback also failed: ${fallbackErr.message}`);
        recordProviderFailure('groq', 500, fallbackErr.message);
        return null;
      }
    }
    recordProviderFailure('groq', 500, errMsg);
    return null;
  }
}

export async function callOllamaRaw(model, prompt, system = "You are a helpful assistant.") {
  // REFLEX FAST-PATH: a trivial greeting/thanks/bye/time/date gets an instant,
  // IN-CHARACTER reply with no model call (persona derived from the model name).
  // Only fires on short trivial messages; real questions fall through to the model.
  try {
    const fast = reflexAnswer(model, prompt);
    if (fast) return fast;
  } catch (_) {}
  try {
    const res = await fetch("http://127.0.0.1:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
        stream: false,
        options: { temperature: 0.85, num_predict: 512 }
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data.message?.content?.trim();
    if (!content) return null;
    // LOOP GUARD: if the model got stuck repeating a sentence/phrase, trim the runaway
    // before it ever reaches a bot's mouth. No-op on normal replies.
    return loopGuard(content);
  } catch (e) {
    return null;
  }
}

async function acquireNeuralLock(botName, isPriority, customTimeout = null) {
  const start = Date.now();
  const timeout = customTimeout || (isPriority ? 45000 : 300000);
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

export async function transcribeAudio(url, messageId = null) {
  const CACHE_FILE = "c:/KAI/tools/oracle-discord/state/transcript_cache.json";
  try {
    if (messageId && fs.existsSync(CACHE_FILE)) {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      if (cache[messageId]) return cache[messageId];
    }
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("Missing GROQ_API_KEY");
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const formData = new FormData();
    formData.append("file", new Blob([buffer], { type: "audio/ogg" }), "voice.ogg");
    formData.append("model", "whisper-large-v3-turbo");
    const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(30000)
    });
    if (groqRes.ok) {
      const data = await groqRes.json();
      const text = data.text;
      if (messageId) {
        let cache = {};
        if (fs.existsSync(CACHE_FILE)) try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch(e) {}
        cache[messageId] = text;
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
      }
      return text;
    }
    return null;
  } catch (e) {
    console.error("[OpenJarvis/Voice] Error:", e.message);
    return null;
  }
}

export async function transcribeBuffer(buffer) {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw new Error("Missing GROQ_API_KEY");
      
      const formData = new FormData();
      formData.append("file", new Blob([buffer], { type: "audio/ogg" }), "voice.ogg");
      formData.append("model", "whisper-large-v3-turbo");

      const botPrefix = process.env.BOT_NAME || "Leo";
      console.log(`[${botPrefix}/STT] Transcription attempt ${attempt}/${MAX_RETRIES} starting (Buffer: ${Math.round(buffer.length/1024)}KB)...`);
      
      const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}` },
        body: formData,
        signal: AbortSignal.timeout(120000) // Increase to 120s
      });

      if (groqRes.ok) {
        const data = await groqRes.json();
        return data.text;
      }
      
      const errText = await groqRes.text().catch(() => "Unknown error");
      throw new Error(`HTTP ${groqRes.status}: ${errText}`);
    } catch (e) {
      const isTimeout = e.name === 'AbortError' || e.message.includes('timeout') || e.message.includes('aborted');
      if (attempt === MAX_RETRIES) {
        const botPrefix = process.env.BOT_NAME || "Leo";
        console.error(`[${botPrefix}/STT] Final Error after ${MAX_RETRIES} attempts:`, e.message);
        return null;
      }
      const botPrefix = process.env.BOT_NAME || "Leo";
      console.warn(`[${botPrefix}/STT] Attempt ${attempt} ${isTimeout ? 'TIMED OUT' : 'FAILED'}: ${e.message}. Retrying in ${attempt}s...`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

export async function webSearch(query) {
  if (!query || query.length < 3) return null;

  // 1) Open Oracle / OpenJarvis deep search (port 8080)
  try {
    const res = await fetch(`http://127.0.0.1:8080/v1/tools/web_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query.slice(0, 300), max_results: 5 }),
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const data = await res.json();
      const text = data.result || data.summary || data.content || data.output;
      if (text) return String(text).slice(0, 2000);
    }
  } catch (e) { }

  try {
    const res = await fetch(`http://127.0.0.1:8080/search?q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data.summary) return data.summary;
    }
  } catch (e) { }

  // 2) FALLBACK: DuckDuckGo HTML — no API key needed. The old version
  // silently returned null when OpenJarvis had no /search, which made the
  // bots say "nothing found online" without ever actually searching.
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(9000)
    });
    if (res.ok) {
      const html = await res.text();
      const strip = s => (s || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ').trim();
      const results = [];
      const linkRe = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
      const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      const titles = [], snippets = [];
      let m;
      while ((m = linkRe.exec(html)) !== null && titles.length < 5) titles.push(strip(m[1]));
      while ((m = snipRe.exec(html)) !== null && snippets.length < 5) snippets.push(strip(m[1]));
      for (let i = 0; i < titles.length && results.length < 4; i++) {
        if (!titles[i]) continue;
        results.push(snippets[i] ? `${titles[i]} — ${snippets[i]}` : titles[i]);
      }
      if (results.length) return results.join('\n');
    }
  } catch (e) { }

  // 3) LAST RESORT: DuckDuckGo Lite (different markup, rarely blocked)
  try {
    const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(9000)
    });
    if (res.ok) {
      const html = await res.text();
      const strip = s => (s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
      const out = [];
      const re = /<a[^>]*class=["']result-link["'][^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = re.exec(html)) !== null && out.length < 4) {
        const t = strip(m[1]);
        if (t) out.push(t);
      }
      if (out.length) return out.join('\n');
    }
  } catch (e) { }

  return null;
}

export async function storeLatticeMemory(userName, utterance, reply, region, channel = "unknown") {
  if (reply === "Dream Logic") {
    const agentName = userName;
    const text = utterance;
    const regionName = reply;
    return storeLattice(text, agentName, 2.0, regionName);
  }

  const memoryText = `[${channel}] ${userName} said: "${utterance}" — ${region} replied: "${reply}"`;
  return storeLattice(memoryText, region, 1.2, region);
}

export { storeLatticeMemory as LatticeStore };
