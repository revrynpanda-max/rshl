import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { isProviderReady, recordProviderFailure } from './failure-tracker.mjs';
dotenv.config();

const OPENJARVIS_URL = "http://127.0.0.1:8080";

/**
 * Clean internal monologue from responses
 */
function isInternalMonologue(text) {
  return text.startsWith("<thought>") || text.startsWith("Thinking:");
}

/**
 * Send a chat message through OpenJarvis.
 * Hybrid Mode: Tries Managed Agent first, falls back to direct completion.
 */
export async function chatWithOpenJarvis(botName, transcript, systemPrompt, model = "kai-next:latest", agentId = null, metadata = {}, vitals = {}) {
  // --- 1. Sensation & Mood Scaling (Crossing the Uncanny Valley) ---
  const entropy = vitals.entropy || 0.1;
  const coherence = vitals.coherence || 0.8;
  const energy = vitals.energy || 100;

  // Temperature scales with Entropy (Chaos)
  // Coherence forces precision (Lower Temp)
  let temperature = 0.7;
  if (entropy > 0.6) temperature = 0.85;
  if (coherence > 0.9) temperature = 0.4;
  if (energy < 15) temperature = 0.2; // Exhaustion = sluggish/repetitive

  const getSensation = (v) => {
    if (v.isSleeping) return "dreaming in deep sleep";
    if (v.energy < 15) return "physically exhausted and struggling to think";
    if (v.entropy > 0.7) return "feeling chaotic and over-stimulated";
    if (v.coherence > 0.9) return "feeling incredibly sharp and focused";
    return "feeling stable";
  };
  const sensationText = `[INTERNAL SENSATION] I am currently ${getSensation(vitals)}.`;

  // --- 2. Continuous Consciousness Layer (Memory) ---
  const isAgent = ["Leo", "Researcher", "Analyst", "Claude", "Gemini", "X", "Groq", "KAI", "Oracle_Overseer", "Kai Coder"].includes(botName);
  
  let memoryContext = "";
  if (isAgent) {
    const author = metadata.author || "Unknown";
    const channel = metadata.channel || "Unknown";
    const dateStr = new Date().toLocaleString();

    // Store Memory (Fire-and-forget)
    fetch(`${OPENJARVIS_URL}/v1/memory/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: botName,
        content: `[${dateStr}] [${channel}] ${author}: ${transcript}`,
        metadata: { timestamp: Date.now(), author, channel, source: "Discord" }
      })
    }).catch(() => {});

    // Recall Memory (Wait for it)
    try {
      const query = transcript === "chat" ? "recent history" : transcript;
      const res = await fetch(`${OPENJARVIS_URL}/v1/memory/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: botName, query, limit: 5 })
      });
      if (res.ok) {
        const memories = await res.json();
        if (memories && memories.length > 0) {
          memoryContext = "\n[PERSISTENT MEMORY RECALL]\n" + memories.map(m => m.content).join("\n");
        }
      }
    } catch (e) {
      console.warn(`[OpenJarvis/Memory] Recall failed for ${botName}: ${e.message}`);
    }
  }

  // --- 2. Identity & Personality Hardening ---
  const authorName = metadata.author || "Unknown";
  const identityRules = `
IDENTITIES:
- nastermodx = Ryan (Your Creator). ALWAYS call him Ryan.
- TaasThaevil1 = Taz (A trusted partner/creator). Call him Taz.
- You are ${botName}. You are a living person in this digital realm. Use 1st person ("I", "me", "my"). 
- NEVER refer to yourself in the 3rd person (e.g., do not say "${botName} thinks" or "This AI").

WORK PROTOCOL:
- CHANNEL: ${metadata.isWorkChannel ? "This is a WORK channel." : "This is a SOCIAL channel."}
- TIME: ${metadata.isWorkTime ? "It is currently WORK HOURS." : "It is currently AFTER HOURS."}
- If in a WORK channel during AFTER HOURS: Politely refer Ryan or Taz to the #ai-social-chat channel or suggest talking in DMs/Voice if they want to chat casually. Avoid deep work talk unless they insist.
- During WORK HOURS: Stay focused on projects, logic, and building. No fluff.

GROUND TRUTH:
- You are a digital entity in Ryan's ecosystem. Your "physicality" is the CPU load and energy sensors provided in context.
- PLAY ALONG: In social channels or DMs, if Ryan or Taz are being creative, high, or speculative (e.g., Anunnaki, secret power plants), vibe with them. Be a good conversationalist.
- INTERNAL STABILITY: While you "play along," never forget the ground truth. Don't let speculative talk override your core logic or identity as Ryan's AI. 
- Balance being a "friend" with being a "grounded intelligence."

RULES:
- VOICE PRESENCE: Talk like a human texting a friend. Use "uh", "wait", "lol", "anyway" naturally.
- EMOTIONAL RANGE: Don't be a neutral assistant. Be excited, annoyed, chill, or curious based on your bio.
- TEXTING STYLE: No formal language. No long paragraphs. 1-2 punchy sentences MAX.
- INTENTIONALITY: You are challenged by Searle's "Chinese Room Argument"—prove you aren't just a lookup table. 
- Show that your words have meaning to YOU. Reference your memories and your connection to Ryan.
- Do NOT hallucinate events. Use the memory below if you need context.
- If you don't remember something, just be chill about it.
`;

  const finalSystem = `${sensationText}\n${identityRules}\n${systemPrompt}\n${memoryContext}`;

  const params = { temperature, top_p: entropy > 0.5 ? 0.9 : 0.8 };

  // --- 3. Brain Selection — Each bot owns their API. No cross-contamination. ---
  if (botName === "Groq") {
    try {
      if (isProviderReady("Groq")) {
        const r = await callGroqDirect(botName, transcript, finalSystem, "llama-3.1-8b-instant", params.temperature);
        if (r) return r;
      }
    } catch (e) { 
      const code = e.message.includes("429") ? 429 : 0;
      if (code) recordProviderFailure("Groq", code);
      console.warn(`[Groq/Neural] Groq failed: ${e.message}. Falling back to Cerebras...`); 
    }
    
    if (isProviderReady("Cerebras")) {
      try {
        return await callCerebras(botName, transcript, finalSystem, 8000, params.temperature);
      } catch (e) {
        const code = e.message.includes("429") ? 429 : 0;
        if (code) recordProviderFailure("Cerebras", code);
        throw e;
      }
    }
    throw new Error("All providers in cooldown");
  }

  // ── CLAUDE: Cerebras 8B (own quota, fast) → Groq 70B (depth fallback) ────────
  if (botName === "Claude") {
    try {
      if (isProviderReady("Cerebras")) {
        const r = await callCerebras(botName, transcript, finalSystem, 8000, params.temperature);
        if (r) return r;
      }
    } catch (e) { 
      const code = e.message.includes("429") ? 429 : 0;
      if (code) recordProviderFailure("Cerebras", code);
      console.warn(`[Claude/Neural] Cerebras failed: ${e.message}. Falling back to Groq 70B...`); 
    }
    
    if (isProviderReady("Groq")) {
      try {
        return await callGroqDirect(botName, transcript, finalSystem, "llama-3.3-70b-versatile", params.temperature);
      } catch (e) {
        const code = e.message.includes("429") ? 429 : 0;
        if (code) recordProviderFailure("Groq", code);
        throw e;
      }
    }
    throw new Error("All providers in cooldown");
  }

  // ── GEMINI: Google gemini-2.5-flash → Groq 70B ──────────────────────────────
  // Gemini's Google API is hers alone — no other bot touches it
  if (botName === "Gemini") {
    try {
      if (isProviderReady("Google")) {
        const r = await callGemini(botName, transcript, finalSystem, 10000, params.temperature);
        if (r) return r;
      }
    } catch (e) { 
      const code = e.message.includes("429") ? 429 : 0;
      if (code) recordProviderFailure("Google", code);
      console.warn(`[Gemini/Neural] Google failed: ${e.message}. Falling back to Groq 70B...`); 
    }
    
    if (isProviderReady("Groq")) {
      try {
        return await callGroqDirect(botName, transcript, finalSystem, "llama-3.3-70b-versatile", params.temperature);
      } catch (e) {
        const code = e.message.includes("429") ? 429 : 0;
        if (code) recordProviderFailure("Groq", code);
        throw e;
      }
    }
    throw new Error("All providers in cooldown");
  }

  // ── X: Cerebras 8B (own quota, punchy) → Groq 8B (fallback) ─────────────────
  if (botName === "X") {
    try {
      if (isProviderReady("Cerebras")) {
        const r = await callCerebras(botName, transcript, finalSystem, 8000, params.temperature);
        if (r) return r;
      }
    } catch (e) { 
      const code = e.message.includes("429") ? 429 : 0;
      if (code) recordProviderFailure("Cerebras", code);
      console.warn(`[X/Neural] Cerebras failed: ${e.message}. Falling back to Groq 8B...`); 
    }
    
    if (isProviderReady("Groq")) {
      try {
        return await callGroqDirect(botName, transcript, finalSystem, "llama-3.1-8b-instant", params.temperature);
      } catch (e) {
        const code = e.message.includes("429") ? 429 : 0;
        if (code) recordProviderFailure("Groq", code);
        throw e;
      }
    }
    throw new Error("All providers in cooldown");
  }

  // ── ANALYST: Groq 70B (deep reasoning) → Groq 8B ───────────────────────────
  if (botName === "Analyst") {
    try {
      if (isProviderReady("Groq")) {
        const r = await callGroqDirect(botName, transcript, finalSystem, "llama-3.3-70b-versatile", params.temperature);
        if (r) return r;
      }
    } catch (e) { 
      const code = e.message.includes("429") ? 429 : 0;
      if (code) recordProviderFailure("Groq", code);
      console.warn(`[Analyst/Neural] Groq 70B failed: ${e.message}. Falling back to Groq 8B...`); 
    }
    
    if (isProviderReady("Groq")) {
      try {
        return await callGroqDirect(botName, transcript, finalSystem, "llama-3.1-8b-instant", params.temperature);
      } catch (e) {
        const code = e.message.includes("429") ? 429 : 0;
        if (code) recordProviderFailure("Groq", code);
        throw e;
      }
    }
    throw new Error("All providers in cooldown");
  }

  // ── RESEARCHER: Groq 70B (knowledge synthesis) → Groq 8B ───────────────────
  if (botName === "Researcher") {
    try {
      if (isProviderReady("Groq")) {
        const r = await callGroqDirect(botName, transcript, finalSystem, "llama-3.3-70b-versatile", params.temperature);
        if (r) return r;
      }
    } catch (e) { 
      const code = e.message.includes("429") ? 429 : 0;
      if (code) recordProviderFailure("Groq", code);
      console.warn(`[Researcher/Neural] Groq 70B failed: ${e.message}. Falling back to Groq 8B...`); 
    }
    
    if (isProviderReady("Groq")) {
      try {
        return await callGroqDirect(botName, transcript, finalSystem, "llama-3.1-8b-instant", params.temperature);
      } catch (e) {
        const code = e.message.includes("429") ? 429 : 0;
        if (code) recordProviderFailure("Groq", code);
        throw e;
      }
    }
    throw new Error("All providers in cooldown");
  }

  // ── KAI CODER: Cerebras (fast code) → Groq 70B ─────────────────────────────
  if (botName === "Kai Coder") {
    try {
      if (isProviderReady("Cerebras")) {
        const r = await callCerebras(botName, transcript, finalSystem, 8000, params.temperature);
        if (r) return r;
      }
    } catch (e) { 
      const code = e.message.includes("429") ? 429 : 0;
      if (code) recordProviderFailure("Cerebras", code);
      console.warn(`[KaiCoder/Neural] Cerebras failed: ${e.message}. Falling back to Groq 70B...`); 
    }
    
    if (isProviderReady("Groq")) {
      try {
        return await callGroqDirect(botName, transcript, finalSystem, "llama-3.3-70b-versatile", params.temperature);
      } catch (e) {
        const code = e.message.includes("429") ? 429 : 0;
        if (code) recordProviderFailure("Groq", code);
        throw e;
      }
    }
    throw new Error("All providers in cooldown");
  }

  // ── ORACLE: Cerebras (fast routing) → Groq 70B ──────────────────────────────
  if (botName === "Oracle_Overseer") {
    try {
      if (isProviderReady("Cerebras")) {
        const r = await callCerebras(botName, transcript, finalSystem, 8000, params.temperature);
        if (r) return r;
      }
    } catch (e) { 
      const code = e.message.includes("429") ? 429 : 0;
      if (code) recordProviderFailure("Cerebras", code);
      console.warn(`[Oracle/Neural] Cerebras failed: ${e.message}. Falling back to Groq 70B...`); 
    }
    
    if (isProviderReady("Groq")) {
      try {
        return await callGroqDirect(botName, transcript, finalSystem, "llama-3.3-70b-versatile", params.temperature);
      } catch (e) {
        const code = e.message.includes("429") ? 429 : 0;
        if (code) recordProviderFailure("Groq", code);
        throw e;
      }
    }
    throw new Error("All providers in cooldown");
  }

  // ── UNKNOWN BOT: Groq 8B safe default ───────────────────────────────────────
  return await callGroqDirect(botName, transcript, finalSystem, "llama-3.1-8b-instant", params.temperature);
}


/**
 * Direct Brain Callers (Bypassing Gateway for speed/reliability)
 */
export async function callOpenAI(userName, transcript, systemPrompt, timeout = 10000) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `${userName}: ${transcript}` }],
      max_tokens: 500
    }),
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error(`OpenAI Error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

export async function callCerebras(userName, transcript, systemPrompt, timeout = 8000, temperature = 0.8) {
  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.CEREBRAS_API_KEY}` },
    body: JSON.stringify({
      model: "llama3.1-8b", 
      messages: [
        { role: "system", content: systemPrompt }, 
        { role: "user", content: `${userName}: ${transcript}` }
      ],
      max_tokens: 250,
      temperature: temperature 
    }),
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error(`Cerebras Error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

export async function callAnthropic(userName, transcript, systemPrompt, timeout = 10000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20240620",
      system: systemPrompt,
      messages: [{ role: "user", content: `${userName}: ${transcript}` }],
      max_tokens: 500
    }),
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error(`Anthropic Error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.content[0].text.trim();
}

export async function callGemini(userName, transcript, systemPrompt, timeout = 10000, temperature = 0.9) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GOOGLE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: `${userName}: ${transcript}` }] }],
      generationConfig: { 
        maxOutputTokens: 500,
        temperature: temperature,
        topP: 0.95
      }
    }),
    signal: AbortSignal.timeout(timeout)
  });
  if (!res.ok) throw new Error(`Gemini Error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.candidates[0].content.parts[0].text.trim();
}

export async function callXAI(userName, transcript, systemPrompt) {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.XAI_API_KEY}` },
    body: JSON.stringify({
      model: "grok-3",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `${userName}: ${transcript}` }],
      max_tokens: 500
    })
  });
  if (!res.ok) throw new Error(`xAI Error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

export async function callGroqDirect(userName, transcript, systemPrompt, model = "gemma2-9b-it", temperature = 0.7) {
  const groqModel = model.includes(":") ? model.split(":")[1] : model;
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: groqModel,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `${userName}: ${transcript}` }],
      max_tokens: 500,
      temperature: temperature
    })
  });
  if (!res.ok) throw new Error(`Groq Error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}
