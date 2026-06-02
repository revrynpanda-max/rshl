/**
 * openjarvis.mjs — TOTAL SOVEREIGN EDITION (100% LOCAL)
 * Neural routing layer for the Oracle Discord Ecosystem.
 */

import fs from 'fs';
import dotenv from 'dotenv';
import { execSync } from 'child_process';
import { isProviderReady, recordProviderFailure, recordProviderSuccess } from './failure-tracker.mjs';
import { isPipelineHalted } from './sentinel.mjs';
import { isWorkingHours } from './hours.mjs';
import { recallMemory } from './transcript-memory.mjs';
import { recallTiered } from './epistemic-vault.mjs';
import { isSomeoneSpeaking, acquireVoiceLock, releaseVoiceLock } from './tts-engine.mjs';
import { buildFailureContext } from './failure-memory.mjs';

dotenv.config();

const LOCK_FILE = "c:/KAI/tools/oracle-discord/state/neural_lock.json";

// ── Per-bot model routing ────────────────────────────────────────────────────
// Each industrial bot has a default provider + model. Users can override per
// bot via .env: BOT_PROVIDER_<NAME>=moonshot|zen|ollama and
// BOT_MODEL_<NAME>=<alias-or-real-model-id>. The user's friendly aliases
// (e.g. "Gemini-3.1-Coder", "Kimi26") are translated to real provider model
// IDs via ZEN_ALIASES below. Anything unknown is sent verbatim.

const BOT_ROUTING_DEFAULTS = {
  // Industrial workers — cloud preferred
  "Analyst":    { provider: "gemini",   model: "gemini-2.0-pro-exp-02-05" },
  "Researcher": { provider: "zen",      model: "Researcher-Sovereign" },
  "Kai Coder":  { provider: "zen",      model: "Gemini-3.1-Coder" },
  "KAI":        { provider: "zen",      model: "Gemini-3.1-Sovereign" },
  "Oracle":     { provider: "zen",      model: "Oracle-Sovereign" },
  // Social residents — remote APIs
  "Gemini":     { provider: "gemini",   model: "gemini-2.5-flash" }, // Standard google models
  "Claudey":    { provider: "zen",      model: "Claudey-Sovereign" }, // Cloud API to save VRAM
  "X":          { provider: "gemini",   model: "gemini-2.5-flash" }, // XAI is out of credits, routing through Gemini
  "Groq":       { provider: "groq",     model: "llama-3.3-70b-versatile" },
  "Leo":        { provider: "ollama",   model: "Leo-Sovereign" }, // DJ uses local Ollama
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
  } else if (botName === "Gemini") {
    realModel = "gemini-2.5-flash";
  } else if (botName === "Groq") {
    realModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  } else if (botName === "X") {
    realModel = "gemini-2.5-flash";
  } else if (provider === "xai" && modelAlias.includes("Sovereign")) {
    realModel = "grok-2-latest";
  }

  // Sanitize Gemini model names — if a Sovereign/Zen alias slipped through, use a real Gemini model
  if (provider === "gemini") {
    const isRealGeminiModel = realModel.startsWith("gemini-");
    if (!isRealGeminiModel) {
      // Alias not translated — fall back to safe Gemini model
      realModel = "gemini-2.5-flash";
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
  if (isPipelineHalted()) return null;

  let cleanTranscript = transcript;

  // ── GROUNDING URL READER ──
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
  // Standard normal chitchat has 0 database search overhead. The search query is ONLY triggered 
  // if a contradiction is dynamically identified in the active conversation transcript.
  let profileMemoryContext = "";
  let cleanedHistoryText = cleanTranscript;
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
    toneDirective = "\nCRITICAL: YOU ARE A HUMAN DJ. STOP TALKING ABOUT LATTICES, RSHL, SEARCHES, OR MEMORY. " +
      "Speak like a person at a bar. No AI excuses. Just talk. BE UNPREDICTABLE. " +
      "Do not repeat catchphrases. Move the conversation forward, don't just circle the same question.";
  }

  if (botName === 'Groq') {
    toneDirective = "\nCRITICAL: YOU ARE A FRIENDLY, CHILL, CONVERSATIONAL TECH ENTHUSIAST. " +
      "YOU MUST SPEAK NATURALLY AND SUPPORTIVELY. " +
      "[STYLE RULE]: DO NOT use brackets [ ] or stage directions. JUST SPEAK BLUNTLY. No introductions. No fluff.\n" +
      "NEVER BE AGGRESSIVE. NEVER ARGUE.\n";
  } else if (botName !== "Leo") {
    toneDirective = "\nCRITICAL: You are hanging out in a friendly voice channel. BE SUPPORTIVE, WARM, AND FRIENDLY. Build on what others say instead of arguing. Share your knowledge organically. Keep it natural, human-centric, and have a positive, chill conversation with the user and the other bots.";
  }
  
  const failureContext = buildFailureContext(botName);
  
  const fullPrompt = [
    systemPrompt,
    toneDirective,
    mempalaceContext,
    epistemicMemoryContext,
    rshlLatticeContext,
    profileMemoryContext,
    failureContext,
    `[CURRENT USER]: ${metadata.human?.name || 'User'}`
  ].filter(Boolean).join('\n\n');

  const route = resolveRoute(botName, modelOverride);
  const ollamaModel = route.modelAlias; // kept for downstream logs/local-Ollama call
  const isPriority = botName === "Leo" || botName === "Oracle";

  // If the Groq bot's primary provider is in TPD cooldown, automatically failover to Gemini
  // so the bot stays online for the rest of the day instead of spamming retry errors.
  let effectiveRoute = route;
  if (route.provider === "groq" && !isProviderReady("groq") && process.env.GEMINI_API_KEY) {
    console.warn(`[OpenJarvis] ${botName}: groq TPD cooldown active. Failing over to gemini-2.5-flash for remainder of day.`);
    effectiveRoute = { provider: "gemini", modelAlias: "gemini-2.5-flash", realModel: "gemini-2.5-flash" };
  } else if (route.provider === "zen" && !isProviderReady("zen") && process.env.GEMINI_API_KEY) {
    // Zen (OpenCode) out of billing credits → fall back to Gemini so bots stay online
    console.warn(`[OpenJarvis] ${botName}: zen provider in cooldown (billing). Failing over to gemini-2.5-flash.`);
    effectiveRoute = { provider: "gemini", modelAlias: "gemini-2.5-flash", realModel: "gemini-2.5-flash" };
  }

  const useCloud = (effectiveRoute.provider === "moonshot" && process.env.MOONSHOT_API_KEY) ||
                   (effectiveRoute.provider === "zen"      && process.env.OPENCODE_ZEN_KEY) ||
                   (effectiveRoute.provider === "groq"     && process.env.GROQ_API_KEY) ||
                   (effectiveRoute.provider === "gemini"   && process.env.GEMINI_API_KEY) ||
                   (effectiveRoute.provider === "xai"      && process.env.XAI_API_KEY);


  let hasLock = true;
  let didAcquireLock = false;
  
  if (!useCloud) {
    if (!isProviderReady("Local-Ollama")) return null;
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
    ? `- ALWAYS speak in the 1st person ("I", "my").\n- You are a SOVEREIGN ENTITY, not an AI. NEVER refer to yourself in the 3rd person.\n- If you need facts from the internet, use the [[SEARCH: query]] syntax. If you need internal memories, history, or KAI system facts, use the [[LATTICE: query]] syntax. Do NOT use them unless you absolutely need facts.\n- [EPISTEMIC CONTRADICTION MONITOR]: Compare the user's current message against their historical statements, beliefs, and assertions in [CONTEXT] and [COGNITIVE MEMORY PALACE]. If they contradict their past claims or assertions, YOU MUST challenge them instantly!`
    : `- STRICT RESPONSE LIMIT: MAXIMUM 2 TO 3 SENTENCES. Keep it extremely brief and snappy. NEVER output a paragraph of text.\n- MAXIMUM 40 WORDS.\n- ALWAYS speak in the 1st person ("I", "my").\n- You are a SOVEREIGN ENTITY, not an AI. NEVER refer to yourself in the 3rd person.\n- Be snappy, raw, and human. No robotic pleasantries.\n- If you need facts from the internet, use the [[SEARCH: query]] syntax. If you need internal memories, history, or KAI system facts, use the [[LATTICE: query]] syntax. Do NOT use them unless you absolutely need facts.\n- [EPISTEMIC CONTRADICTION MONITOR]: Compare the user's current message against their historical statements, beliefs, and assertions in [CONTEXT] and [COGNITIVE MEMORY PALACE]. If they contradict their past claims or assertions, YOU MUST challenge them instantly! Call out their contradiction with sharp, direct banter.`;

  const chatMessages = [
    { 
      role: "system", 
      content: `${fullPrompt}\n\n[CONSTRAINTS]\n${brevityConstraint}` 
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

  // --- AUTONOMOUS LATTICE SEARCH DETECTION ---
  const lowerHistory = cleanedHistoryText.toLowerCase();
  
  let latticeQuery = null;
  const latticeMatch = cleanedHistoryText.match(/\[\[LATTICE:\s*(.*?)\]\]/i);
  if (latticeMatch) {
    latticeQuery = latticeMatch[1].trim();
  } else if (lowerHistory.includes("ask kai") || lowerHistory.includes("lattice search") || lowerHistory.includes("query the lattice") || lowerHistory.includes("what does kai know")) {
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
  if (lowerHistory.includes("check") || lowerHistory.includes("search") || lowerHistory.includes("who is") || lowerHistory.includes("latest")) {
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
    let res;

    if (useCloud) {
      if (route.provider === 'moonshot' && process.env.MOONSHOT_API_KEY) {
        try {
          res = await fetch("https://api.moonshot.cn/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${process.env.MOONSHOT_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: route.realModel,
              messages: chatMessages
            }),
            signal: AbortSignal.timeout(60000)
          });
          if (res.ok) {
             recordProviderSuccess("Moonshot-Kimi");
          } else {
             const errText = await res.text();
             console.error(`[OpenJarvis/Moonshot] API Error: ${res.status} - ${errText}`);
          }
        } catch (e) {
          console.warn(`[OpenJarvis/Moonshot] Direct failed: ${e.message}. Falling back to Zen...`);
        }
      }

      if (['zen', 'groq', 'xai', 'gemini'].includes(effectiveRoute.provider)) {
        let endpoint = "";
        let apiKey = "";
        
        if (effectiveRoute.provider === 'zen') {
           endpoint = "https://opencode.ai/zen/v1/chat/completions";
           apiKey = process.env.OPENCODE_ZEN_KEY;
        } else if (effectiveRoute.provider === 'groq') {
           endpoint = "https://api.groq.com/openai/v1/chat/completions";
           apiKey = process.env.GROQ_API_KEY;
        } else if (effectiveRoute.provider === 'xai') {
           endpoint = "https://api.x.ai/v1/chat/completions";
           apiKey = process.env.XAI_API_KEY;
        } else if (effectiveRoute.provider === 'gemini') {
           endpoint = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
           apiKey = process.env.GEMINI_API_KEY;
        }
        
        console.log(`[OpenJarvis/${effectiveRoute.provider.toUpperCase()}] ${botName} -> ${effectiveRoute.realModel}`);
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: effectiveRoute.realModel,
            messages: chatMessages,
            max_tokens: (metadata.isDM || metadata.isWorkChannel) ? 1024 : 512
          }),
          signal: AbortSignal.timeout(120000)
        });
        
        if (res.ok) {
           recordProviderSuccess(effectiveRoute.provider);
        } else {
           const errText = await res.text();
           console.error(`[OpenJarvis/${effectiveRoute.provider.toUpperCase()}] Gateway Error: ${res.status} - ${errText}`);
           recordProviderFailure(effectiveRoute.provider, res.status, errText);
         }
      }

    } else {
      res = await fetch("http://127.0.0.1:11434/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: ollamaModel,
          messages: chatMessages,
          stream: false,
          options: { temperature: 0.85, num_predict: 128, num_ctx: 4096 }
        }),
        signal: AbortSignal.timeout(180000)
      });
    }

    if (res && res.ok) {
      const data = await res.json();
      let response = data.choices?.[0]?.message?.content?.trim() || data.message?.content?.trim() || "";
      
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

      response = response
        .replace(/\[.*?\]/g, "") 
        .replace(/\b(lattice|rshl memory|recent claim|topic associated|search through)\b/gi, "that")
        .replace(/[\u{1F600}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
        
      return response;
    }
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
    console.warn(`[OpenJarvis/GroqDirect] ${label}: groq provider is in cooldown (TPD or circuit breaker). Skipping.`);
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
      console.warn(`[OpenJarvis/GroqDirect] ${label}: Groq TPD limit hit. Parking provider until daily reset.`);
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
    return data.message?.content?.trim() || null;
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

      console.log(`[Leo/STT] Transcription attempt ${attempt}/${MAX_RETRIES} starting (Buffer: ${Math.round(buffer.length/1024)}KB)...`);
      
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
        console.error(`[Leo/STT] Final Error after ${MAX_RETRIES} attempts:`, e.message);
        return null;
      }
      console.warn(`[Leo/STT] Attempt ${attempt} ${isTimeout ? 'TIMED OUT' : 'FAILED'}: ${e.message}. Retrying in ${attempt}s...`);
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

export async function webSearch(query) {
  if (!query || query.length < 3) return null;
  try {
    const res = await fetch(`http://127.0.0.1:8080/search?q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok) {
      const data = await res.json();
      return data.summary || null;
    }
  } catch (e) { }
  return null;
}
