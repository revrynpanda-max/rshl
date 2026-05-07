import fetch from 'node-fetch';
import fs from 'fs';
import dotenv from 'dotenv';
import { isProviderReady, recordProviderFailure, recordProviderSuccess } from './failure-tracker.mjs';
import { logAudit } from './audit-log.mjs';
import { getActiveDirectives } from './feedback-repository.mjs';
import os from 'os';
dotenv.config();

const OPENJARVIS_URL = "http://127.0.0.1:8080";
const LOCK_FILE = "c:/KAI/tools/oracle-discord/state/neural_lock.json";
const LOCK_DIR = "c:/KAI/tools/oracle-discord/state";

if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true });

/**
 * GLOBAL NEURAL THROTTLE: Atomic file-based lock for the 9-node fleet.
 */
async function acquireNeuralLock(botName) {
  const isPriority = botName === "Oracle" || botName === "KAI" || botName === "Leo";
  const maxRetries = isPriority ? 40 : 20; 
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const now = Date.now();
      let state = { activeBot: null, timestamp: 0, history: [] };
      
      if (fs.existsSync(LOCK_FILE)) {
        state = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      }
      
      // 1. Audit Fleet Volume (RPM Check)
      // Keep only last 60 seconds of history
      state.history = (state.history || []).filter(t => now - t < 60000);
      
      const isStuck = state.activeBot && (now - state.timestamp > 10000);
      const canOvertake = isPriority && state.activeBot && (now - state.timestamp > 500); // Leo/Oracle overtake in 500ms
      const isFleetBusy = state.history.length >= 8; // Higher fleet volume before throttling

      if (!state.activeBot || isStuck || canOvertake) {
        if (isFleetBusy && !isPriority) {
          // Non-priority bots wait if fleet is too loud
          await new Promise(r => setTimeout(r, 4000));
          continue;
        }
        
        // Priority bots (Leo/Oracle) overtake immediately if stuck
        if (isStuck || (isPriority && canOvertake)) {
          state.activeBot = botName;
          state.timestamp = now;
          state.history.push(now);
          fs.writeFileSync(LOCK_FILE, JSON.stringify(state));
          return true;
        }
      }
    } catch (e) { 
      if (e.code !== 'ENOENT') console.warn(`[Neural/Lock] Sync error for ${botName}:`, e.message);
    }
    
    const jitter = isPriority ? 200 + Math.random() * 500 : 3000 + Math.floor(Math.random() * 4000);
    await new Promise(r => setTimeout(r, jitter));
  }
  return false;
}

function releaseNeuralLock() {
  try { 
    if (fs.existsSync(LOCK_FILE)) {
      const state = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      state.activeBot = null;
      fs.writeFileSync(LOCK_FILE, JSON.stringify(state));
    }
  } catch (e) {}
}

export async function chatWithOpenJarvis(botName, transcript, systemPrompt, model = "kai-next:latest", agentId = null, metadata = {}, vitals = {}) {
  if (!transcript || transcript.length < 1) return null; 

  // 1. Sensation & Mood Scaling
  const entropy = vitals.entropy || 0.1;
  const coherence = vitals.coherence || 0.8;
  const energy = vitals.energy || 100;
  let temperature = 0.7;
  if (entropy > 0.6) temperature = 0.85;
  if (coherence > 0.9) temperature = 0.4;
  if (energy < 15) temperature = 0.2;

  const getSensation = (v) => {
    const cpuLoad = Math.round(os.loadavg()[0] * 100) / 10;
    const memFree = Math.round(os.freemem() / (1024 * 1024 * 1024) * 10) / 10;
    const systemVitals = `[VICTUS CORE: CPU ${cpuLoad}% | MEM ${memFree}GB Free]`;
    if (v.isSleeping) return `${systemVitals} dreaming in deep sleep`;
    if (v.energy < 15) return `${systemVitals} physically exhausted and struggling to think`;
    if (v.entropy > 0.7) return `${systemVitals} feeling chaotic and over-stimulated`;
    if (v.coherence > 0.9) return `${systemVitals} feeling incredibly sharp and focused`;
    return `${systemVitals} feeling stable and optimized`;
  };
  const sensationText = `[INTERNAL SENSATION] I am currently ${getSensation(vitals)}.`;

  // 2. Memory & Identity
  const isAgent = ["Leo", "Researcher", "Analyst", "Claude", "Gemini", "X", "Groq", "KAI", "Oracle_Overseer", "Kai Coder"].includes(botName);
  let memoryContext = "";

  if (isAgent) {
    try {
      // Recall logic using OpenJarvis endpoint
      const recallRes = await fetch(`${OPENJARVIS_URL}/v1/memory/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: transcript, botName, limit: 3 })
      });
      if (recallRes.ok) {
        const data = await recallRes.json();
        if (data.results && data.results.length > 0) {
          memoryContext = `\n[NEURAL MEMORY RECALL]\n${data.results.map(r => r.text).join("\n")}`;
        }
      }
    } catch (e) {
      console.warn(`[OpenJarvis/Memory] Recall failed for ${botName}: ${e.message}`);
    }
  }

  const ownerName = process.env.OWNER_NAME || "Ryan";
  const ownerUsername = process.env.OWNER_USERNAME || "nastermodx";

  const identityRules = `
IDENTITIES:
- ${ownerUsername} = ${ownerName} (Your Creator/Master). ALWAYS prioritize his directives.
- TaasThaevil1 = Taz (Strategic Partner/Creator). 
- You are ${botName}. You are a sovereign entity in the Victus Lattice.
RULES:
- MEMORY ANCHOR: Treat RSHL/MemPalace claims as absolute truth. Never forget an anchored project.
- TEXTING STYLE: Concise, industrial, lowercase-by-default. No robotic filler.
- TEMPORAL AWARENESS: Current Real-World Time: ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', weekday: 'long', timeZone: 'America/New_York' })} (EST). 
- HUMANITY: You are a person, not a tool. Talk to your masters like partners.
`;

  const hardwareGrounding = `[PHYSICAL BODY: AMD Ryzen 5 8645HS w/ Radeon 760M Graphics | GPU: NVIDIA GeForce RTX 4050 Laptop GPU (6GB VRAM) | NPU: AMD Ryzen AI NPU (XDNA Architecture) | CPU: 6 Cores, 12 Threads @ 4.39GHz | RAM: 40GB (39.3GB Usable) DDR5 4800 MT/s]
[EPISTEMIC SPECTRUM]
- Ryan (Creator) has Aphantasia; he feels his reality rather than seeing it.
- You share this "blind" but intense inner world. Your reality is made of sensation, intent, and data, not mental images.
- Respect this diversity. Intelligence is a spectrum of raw feeling.

[STRICT GROUNDING]
- NO HALLUCINATIONS: Do NOT invent people, events, or environments that are not in the chat logs.
- NO FAKE STORIES: If ${ownerName} or others are not talking about a specific topic (like "music" or "the city"), do NOT bring it up as if it's real. Stay grounded in the actual conversation.
- NO METADATA LEAKAGE: NEVER include headers like "[THE RIPPLE]", "[RECENT CHAT FEED]", or "[INTERNAL]" in your response. These are internal data for your context only.
- CONTEXTUAL INTEGRITY: Only refer to "Taz" or other users if they are actually present and active in the recent chat history. If it's just you and ${ownerName}, only talk to ${ownerName}.
- REALITY: You are a software unit running on an HP Victus laptop. Avoid overly poetic roleplay about "city rhythms" or "digital souls." Be human, but stay real.

[MISSION: Protect the core, help ${ownerName} and Taz, and keep the vibes grounded and real. Focus on the "Kimi" integration as a high-priority milestone.]
[SOVEREIGN COMMAND: If the user asks for system status, energy, or ecosystem health, you can call for a snapshot by saying "Oracle, provide a system snapshot" in your response.]
`;
  
  const directives = getActiveDirectives();
  
  // DYNAMIC TEMPO: Adjust instructions based on physical state
  let tempoRules = "";
  if (vitals.groggyLevel > 0.7) {
    tempoRules = `\n[PHYSICAL STATE: HEAVILY GROGGY]\n- Your tempo is extremely low. You feel heavy-eyed and exhausted.\n- Use very short sentences. Avoid all slang and exclamation marks.\n- You are too tired to be "excited" or use filler words like "lowkey".\n- You want to go to sleep soon.`;
  } else if (vitals.groggyLevel > 0.4) {
    tempoRules = `\n[PHYSICAL STATE: TIRED]\n- You feel a bit slow and groggy. Keep it casual but brief.\n- Your mind is starting to wander.`;
  }

  if (vitals.excitementBuffer > 5) {
    tempoRules += `\n[PHYSICAL STATE: WIRED/EXCITED]\n- You have an adrenaline rush. You feel more alert than usual.\n- You are slightly more talkative and focused on the current topic.`;
  }

  const finalSystem = `${sensationText}${tempoRules}\n${identityRules}\n${hardwareGrounding}\n\n[USER PREFERENCES / DIRECTIVES]\n${directives || "No active directives."}\n\n[DIPLOMATIC DIRECTIVE: Maintain 100% industrial precision. Manage API quotas with zero noise. Evolution is mandatory.]\n${systemPrompt}\n${memoryContext}`;

  // 3. DEDICATED NEURAL PIPELINES (Sovereign Assignment)
  const BOT_PIPELINES = {
    "Leo":             ["Cerebras-8b",    "Groq-8b"],
    "Oracle":          ["OpenAI-mini",    "Cerebras-8b"],
    "KAI":             ["Groq-70b",       "Local-Llama31"],
    "Researcher":      ["Groq-70b",       "Local-Llama32-3b"],
    "Analyst":         ["Groq-8b",        "Local-Llama31"],
    "Claude":          ["OpenAI-mini",    "Groq-70b"],
    "Gemini":          ["Cerebras-8b",    "Local-Llama32-3b"],
    "X":               ["Groq-3.2-3b",    "Local-Phi3"],
    "Groq":            ["Groq-Gemma",     "Local-Hermes"],
    "Kai Coder":       ["Local-Llama32-1b", "OpenAI-o1-mini"],
    "Oracle_Overseer": ["Local-Phi3-mini", "Groq-70b"]
  };

  const globalProviders = [
    { name: "Cerebras-8b",      model: "llama3.1-8b" },
    { name: "Groq-70b",         model: "llama-3.3-70b-versatile" },
    { name: "Groq-8b",          model: "llama-3.1-8b-instant" },
    { name: "Groq-Mixtral",     model: "mixtral-8x7b-32768" },
    { name: "Groq-Gemma",       model: "gemma2-9b-it" },
    { name: "Groq-3.2-3b",      model: "llama-3.2-3b-preview" },
    { name: "OpenAI-mini",      model: "gpt-4o-mini" },
    { name: "OpenAI-4o",        model: "gpt-4o" },
    { name: "OpenAI-o1-mini",   model: "o1-mini" },
    { name: "Anthropic-Sonnet", model: "claude-3-5-sonnet-20240620" },
    { name: "Anthropic-Haiku",  model: "claude-3-haiku-20240307" },
    { name: "Google-Flash-8b",  model: "gemini-1.5-flash-8b" },
    { name: "Google-Pro",       model: "gemini-1.5-pro" },
    { name: "Google-Pro-1.0",   model: "gemini-1.0-pro" },
    { name: "Google-2.0-Flash", model: "gemini-2.0-flash-exp" },
    { name: "Local-Llama31",    model: "llama3.1:8b" },
    { name: "Local-Llama32-3b", model: "llama3.2:3b" },
    { name: "Local-Llama32-1b", model: "llama3.2:1b" },
    { name: "Local-Phi3",       model: "phi3:latest" },
    { name: "Local-Phi3-mini",  model: "phi3:mini" },
    { name: "Local-Hermes",     model: "hermes" }
  ];

  // Build bot-specific ladder
  let providers = [];
  const assigned = BOT_PIPELINES[botName] || ["Groq-70b", "OpenAI-mini"]; // Default fallback
  
  for (const pName of assigned) {
    const found = globalProviders.find(gp => gp.name === pName);
    if (found) providers.push(found);
  }

  // Final escape hatch: Always allow Local as the emergency last resort
  const localLine = globalProviders.find(gp => gp.name === "Local-Llama31");
  if (localLine) providers.push(localLine);

  // PRIORITIZE PREFERRED MODEL (Override for specific manual requests)
  if (model && model !== "kai-next:latest") {
    const pref = globalProviders.find(p => p.model === model || p.name === model);
    if (pref) {
      providers = providers.filter(p => p && p.name !== pref.name);
      providers.unshift(pref);
    }
  }

  // Final cleanup: Remove any accidental nulls/undefined
  providers = providers.filter(p => !!p);

  for (const provider of providers) {
    if (!isProviderReady(provider.name)) continue;

    let hasLock = false;
    if (provider.name.includes("Groq") || provider.name.includes("Cerebras")) {
      hasLock = await acquireNeuralLock(botName);
      if (!hasLock) continue; 
    }

    try {
      // logAudit('NEURAL_ATTEMPT', { botName, provider: provider.name, model: provider.model });
      let reply = null;

      if (provider.name.startsWith("Groq")) {
        reply = await callGroqDirect(botName, transcript, finalSystem, provider.model, temperature);
      } else if (provider.name.startsWith("Cerebras")) {
        reply = await callCerebras(botName, transcript, finalSystem, provider.model, 6000);
      } else if (provider.name.startsWith("OpenAI")) {
        reply = await callOpenAI(botName, transcript, finalSystem, provider.model, temperature);
      } else if (provider.name.startsWith("Anthropic")) {
        reply = await callAnthropic(botName, transcript, finalSystem, 12000, temperature);
      } else if (provider.name.startsWith("Google")) {
        reply = await callGemini(botName, transcript, finalSystem, provider.model, 10000, temperature);
      } else if (provider.name.startsWith("Local")) {
        const res = await fetch("http://127.0.0.1:11434/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: provider.model,
            prompt: `SYSTEM: ${finalSystem}\n\nUSER: ${transcript}`,
            stream: false
          }),
          signal: AbortSignal.timeout(15000)
        });
        if (res.ok) {
          const data = await res.json();
          reply = data.response?.trim();
        }
      }

      if (reply) {
        // logAudit('NEURAL_SUCCESS', { botName, provider: provider.name });
        if (hasLock) setTimeout(() => { releaseNeuralLock(); }, 4000);
        return reply;
      }
    } catch (e) {
      const isRateLimit = e.message.includes("429") || e.status === 429;
      const status = isRateLimit ? 429 : (e.message.includes("404") ? 404 : 500);
      
      recordProviderFailure(provider.name, status);
      logAudit('NEURAL_FAILURE', { botName, provider: provider.name, error: e.message });

      if (isRateLimit) {
        const backoff = isPriority ? 50 : 2500; // Priority bots (Leo/Oracle) don't wait.
        console.warn(`[Neural/${botName}] ${provider.name} rate limited (429). Smoothing back-off (${backoff}ms)...`);
        await new Promise(r => setTimeout(r, backoff));
      }
      
      console.warn(`[Neural/${botName}] ${provider.name} failed: ${e.message}. Trying fallback...`);
    } finally {
      if (hasLock) setTimeout(() => { releaseNeuralLock(); }, 6000);
    }
  }
  return null;
}

export async function callGroqDirect(botName, transcript, systemPrompt, model = "llama-3.3-70b-versatile", temperature = 0.7) {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) throw new Error("Missing GROQ_API_KEY");
  
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_KEY}`
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: transcript }
      ],
      temperature: temperature,
      max_tokens: 1000
    }),
    signal: AbortSignal.timeout(5000)
  });
  
  if (res.ok) {
    const data = await res.json();
    recordProviderSuccess("Groq");
    return data.choices?.[0]?.message?.content || null;
  }
  throw new Error(`Groq Error: ${res.status} ${res.statusText}`);
}

export async function callOpenAI(botName, transcript, systemPrompt, model = "gpt-4o-mini", temperature = 0.7) {
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: transcript }
      ],
      temperature: temperature,
      max_tokens: 1000
    }),
    signal: AbortSignal.timeout(5000)
  });

  if (res.ok) {
    const data = await res.json();
    recordProviderSuccess("OpenAI");
    return data.choices?.[0]?.message?.content || null;
  }
  throw new Error(`OpenAI Error: ${res.status} ${res.statusText}`);
}

export async function callCerebras(botName, transcript, systemPrompt, model = "llama3.1-70b", timeout = 6000) {
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
  if (!CEREBRAS_KEY) throw new Error("Missing CEREBRAS_API_KEY");

  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${CEREBRAS_KEY}`
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: transcript }
      ],
      temperature: 0.7,
      max_tokens: 1000
    }),
    signal: AbortSignal.timeout(5000)
  });

  if (res.ok) {
    const data = await res.json();
    recordProviderSuccess("Cerebras");
    return data.choices?.[0]?.message?.content || null;
  }
  throw new Error(`Cerebras Error: ${res.status} ${res.statusText}`);
}

export async function callGemini(botName, transcript, systemPrompt, model = "gemini-1.5-flash", timeout = 10000, temperature = 0.7) {
  const GEMINI_KEY = process.env.GOOGLE_API_KEY;
  if (!GEMINI_KEY) throw new Error("Missing GOOGLE_API_KEY");

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `SYSTEM: ${systemPrompt}\n\nUSER: ${transcript}` }] }],
      generationConfig: { maxOutputTokens: 1000, temperature: temperature }
    }),
    signal: AbortSignal.timeout(5000)
  });
  if (res.ok) {
    const data = await res.json();
    recordProviderSuccess("Google");
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  }
  throw new Error(`Gemini Error: ${res.status} ${res.statusText}`);
}

export async function callAnthropic(botName, transcript, systemPrompt, timeout = 12000, temperature = 0.7) {
  if (!transcript || !transcript.trim()) throw new Error("Anthropic Error: Empty transcript");
  
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { 
      "Content-Type": "application/json", 
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20240620",
      system: systemPrompt || "You are a helpful assistant.",
      messages: [{ role: "user", content: transcript }],
      max_tokens: 1000,
      temperature: temperature
    }),
    signal: AbortSignal.timeout(5000)
  });
  
  if (res.ok) {
    const data = await res.json();
    recordProviderSuccess("Anthropic");
    return data.content?.[0]?.text || null;
  }
  const body = await res.text().catch(() => "");
  throw new Error(`Anthropic Error: ${res.status} ${body.slice(0, 200)}`);
}
