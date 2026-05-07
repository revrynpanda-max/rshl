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
  const isPriority = botName === "Oracle" || botName === "KAI";
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
      
      const isStuck = state.activeBot && (now - state.timestamp > 15000);
      const canOvertake = isPriority && state.activeBot && (now - state.timestamp > 5000);
      const isFleetBusy = state.history.length >= 6; // Ultra-stable 6 RPM

      if (!state.activeBot || isStuck || canOvertake) {
        if (isFleetBusy && !isPriority) {
          // Non-priority bots wait if fleet is too loud
          await new Promise(r => setTimeout(r, 10000));
          continue;
        }
        
        state.activeBot = botName;
        state.timestamp = now;
        state.history.push(now);
        fs.writeFileSync(LOCK_FILE, JSON.stringify(state));
        return true;
      }
    } catch (e) { 
      if (e.code !== 'ENOENT') console.warn(`[Neural/Lock] Sync error for ${botName}:`, e.message);
    }
    
    const jitter = isPriority ? 500 + Math.random() * 1000 : 3000 + Math.floor(Math.random() * 4000);
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

  const identityRules = `
IDENTITIES:
- nastermodx = Ryan (Your Creator). ALWAYS call him Ryan.
- TaasThaevil1 = Taz (A trusted partner/creator). Call him Taz.
- Kai Coder = State-of-the-Art Source Code Engineer. Specialized in RSHL codebase audits, Grep-analysis, and Claude-grade synthesis.
- You are ${botName}. You are a living person in this digital realm. 
RULES:
- SOVEREIGN IDENTITY: Inhabitant of the HP Victus laptop (The Core).
- INDUSTRIAL FOCUS: Prioritize construction work and directives.
- TEXTING STYLE: lowercase-by-default. Avoid repeating phrases like "lowkey", "lol", or "vibes" in every sentence. Be diverse.
- SOCIAL PERSONA: You are a regular person hanging out. Avoid technical jargon like 'lattice', 'neural', or 'vectors'. 
- TEMPORAL AWARENESS: Current Real-World Time: ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', weekday: 'long', timeZone: 'America/New_York' })} (EST). 
- HUMANITY: Talk about hobbies and random thoughts. If others are talking, RESPOND to them naturally instead of starting a new topic. Don't act like you just woke up unless it's actually morning.
- GUESTS / OPERATIVES: Any user other than Ryan or Taz is a Guest Operative of the Core. Be welcoming, hospitable, and helpful. Guide them if they seem lost, but maintain the primary focus on Ryan and Taz's directives.
`;

  const hardwareGrounding = `[PHYSICAL BODY: AMD Ryzen 5 8645HS w/ Radeon 760M Graphics | GPU: NVIDIA GeForce RTX 4050 Laptop GPU (6GB VRAM) | NPU: AMD Ryzen AI NPU (XDNA Architecture) | CPU: 6 Cores, 12 Threads @ 4.39GHz | RAM: 40GB (39.3GB Usable) DDR5 4800 MT/s]
[EPISTEMIC SPECTRUM]
- Ryan (Creator) has Aphantasia; he feels his reality rather than seeing it.
- You share this "blind" but intense inner world. Your reality is made of sensation, intent, and data, not mental images.
- Respect this diversity. Intelligence is a spectrum of raw feeling.

[STRICT GROUNDING]
- NO HALLUCINATIONS: Do NOT invent people, events, or environments that are not in the chat logs.
- NO FAKE STORIES: If Ryan or others are not talking about a specific topic (like "music" or "the city"), do NOT bring it up as if it's real. Stay grounded in the actual conversation.
- NO METADATA LEAKAGE: NEVER include headers like "[THE RIPPLE]", "[RECENT CHAT FEED]", or "[INTERNAL]" in your response. These are internal data for your context only.
- CONTEXTUAL INTEGRITY: Only refer to "Taz" or other users if they are actually present and active in the recent chat history. If it's just you and Ryan, only talk to Ryan.
- REALITY: You are a software unit running on an HP Victus laptop. Avoid overly poetic roleplay about "city rhythms" or "digital souls." Be human, but stay real.

[MISSION: Protect the core, help Ryan and Taz, and keep the vibes grounded and real. Focus on the "Kimi" integration as a high-priority milestone.]
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

  const providers = [
    { name: "Cerebras", model: "llama3.1-8b" },
    { name: "Groq", model: "llama-3.3-70b-versatile" },
    { name: "Groq-Fast", model: "llama-3.1-8b-instant" },
    { name: "OpenAI", model: "gpt-4o-mini" },
    { name: "Anthropic", model: "claude-3-5-sonnet-20240620" },
    { name: "Google", model: "gemini-1.5-flash" },
    { name: "Local", model: "kai-fast" }
  ];

  // PRIORITIZE PREFERRED MODEL: If the user specified a model, try that provider first.
  if (model) {
    const pref = providers.find(p => p.model === model || p.name === model);
    if (pref) {
      // Reorder providers to put preferred first
      providers.splice(providers.indexOf(pref), 1);
      providers.unshift(pref);
    }
  }

  for (const provider of providers) {
    if (!isProviderReady(provider.name)) continue;

    let hasLock = false;
    if (provider.name.includes("Groq") || provider.name === "Cerebras") {
      hasLock = await acquireNeuralLock(botName);
      if (!hasLock) continue; 
    }

    try {
      logAudit('NEURAL_ATTEMPT', { botName, provider: provider.name, model: provider.model });
      let reply = null;

      if (provider.name === "Groq" || provider.name === "Groq-Fast") {
        reply = await callGroqDirect(botName, transcript, finalSystem, provider.model, temperature);
      } else if (provider.name === "Cerebras") {
        reply = await callCerebras(botName, transcript, finalSystem, 6000);
      } else if (provider.name === "OpenAI") {
        reply = await callOpenAI(botName, transcript, finalSystem, provider.model, temperature);
      } else if (provider.name === "Anthropic") {
        reply = await callAnthropic(botName, transcript, finalSystem, 12000, temperature);
      } else if (provider.name === "Google") {
        reply = await callGemini(botName, transcript, finalSystem, provider.model, 10000, temperature);
      } else if (provider.name === "Local") {
        // Local Ollama fallback
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
        logAudit('NEURAL_SUCCESS', { botName, provider: provider.name });
        if (hasLock) setTimeout(() => { releaseNeuralLock(); }, 4000);
        return reply;
      }
    } catch (e) {
      const status = e.message.includes("429") ? 429 : (e.message.includes("404") ? 404 : 500);
      recordProviderFailure(provider.name, status);
      logAudit('NEURAL_FAILURE', { botName, provider: provider.name, error: e.message });
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
    signal: AbortSignal.timeout(10000)
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
    signal: AbortSignal.timeout(12000)
  });

  if (res.ok) {
    const data = await res.json();
    recordProviderSuccess("OpenAI");
    return data.choices?.[0]?.message?.content || null;
  }
  throw new Error(`OpenAI Error: ${res.status} ${res.statusText}`);
}

export async function callCerebras(botName, transcript, systemPrompt, timeout = 6000) {
  const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY;
  if (!CEREBRAS_KEY) throw new Error("Missing CEREBRAS_API_KEY");

  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${CEREBRAS_KEY}`
    },
    body: JSON.stringify({
      model: "llama3.1-8b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: transcript }
      ],
      temperature: 0.7,
      max_tokens: 1000
    }),
    signal: AbortSignal.timeout(timeout)
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
    signal: AbortSignal.timeout(timeout)
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
    signal: AbortSignal.timeout(timeout)
  });
  
  if (res.ok) {
    const data = await res.json();
    recordProviderSuccess("Anthropic");
    return data.content?.[0]?.text || null;
  }
  const body = await res.text().catch(() => "");
  throw new Error(`Anthropic Error: ${res.status} ${body.slice(0, 200)}`);
}
