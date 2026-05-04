import fetch from 'node-fetch';
import dotenv from 'dotenv';
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
export async function chatWithOpenJarvis(userName, transcript, systemPrompt, model = "kai-next:latest", agentId = null, metadata = {}) {
  // --- 1. Continuous Consciousness Layer (Memory) ---
  const isAgent = ["Leo", "Researcher", "Analyst", "Claude", "Gemini", "X", "Groq", "KAI", "Oracle_Overseer", "Kai Coder"].includes(userName);
  const isSocial = metadata.channel?.toLowerCase().includes("social") || metadata.isInterjection;

  let memoryPromise = null;
  if (isAgent) {
    // Store Memory (Fire-and-forget)
    const dateStr = new Date().toLocaleString();
    const author = metadata.author || "Unknown";
    const channel = metadata.channel || "Unknown";
    fetch(`${OPENJARVIS_URL}/v1/memory/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: userName,
        content: `[${dateStr}] [${channel}] ${author}: ${transcript}`,
        metadata: { timestamp: Date.now(), author, channel, source: "Discord" }
      })
    }).catch(() => {});

    // Start Recall (Parallel)
    memoryPromise = fetch(`${OPENJARVIS_URL}/v1/memory/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: userName, query: transcript, limit: 3 })
    }).then(res => res.ok ? res.json() : null).catch(() => null);
  }

  // --- 2. Brain Selection — Each bot owns their API. No cross-contamination. ---

  // ── LEO: Cerebras (voice speed) → Ollama local ──────────────────────────────
  // (Leo handles his own chain in leo.mjs — passthrough here if called directly)

  // ── GROQ BOT: Groq 8B (speed/logic) → Cerebras ─────────────────────────────
  if (userName === "Groq") {
    try {
      const r = await callGroqDirect(userName, transcript, systemPrompt, "llama-3.1-8b-instant");
      if (r) return r;
    } catch (e) { console.warn(`[Groq/Neural] Groq failed: ${e.message}. Falling back to Cerebras...`); }
    return await callCerebras(userName, transcript, systemPrompt);
  }

  // ── CLAUDE: Cerebras 8B (own quota, fast) → Groq 70B (depth fallback) ────────
  if (userName === "Claude") {
    try {
      const r = await callCerebras(userName, transcript, systemPrompt);
      if (r) return r;
    } catch (e) { console.warn(`[Claude/Neural] Cerebras failed: ${e.message}. Falling back to Groq 70B...`); }
    return await callGroqDirect(userName, transcript, systemPrompt, "llama-3.3-70b-versatile");
  }

  // ── GEMINI: Google gemini-2.5-flash → Groq 70B ──────────────────────────────
  // Gemini's Google API is hers alone — no other bot touches it
  if (userName === "Gemini") {
    try {
      const r = await callGemini(userName, transcript, systemPrompt);
      if (r) return r;
    } catch (e) { console.warn(`[Gemini/Neural] Google failed: ${e.message}. Falling back to Groq 70B...`); }
    return await callGroqDirect(userName, transcript, systemPrompt, "llama-3.3-70b-versatile");
  }

  // ── X: Cerebras 8B (own quota, punchy) → Groq 8B (fallback) ─────────────────
  if (userName === "X") {
    try {
      const r = await callCerebras(userName, transcript, systemPrompt);
      if (r) return r;
    } catch (e) { console.warn(`[X/Neural] Cerebras failed: ${e.message}. Falling back to Groq 8B...`); }
    return await callGroqDirect(userName, transcript, systemPrompt, "llama-3.1-8b-instant");
  }

  // ── ANALYST: Groq 70B (deep reasoning) → Groq 8B ───────────────────────────
  if (userName === "Analyst") {
    try {
      const r = await callGroqDirect(userName, transcript, systemPrompt, "llama-3.3-70b-versatile");
      if (r) return r;
    } catch (e) { console.warn(`[Analyst/Neural] Groq 70B failed: ${e.message}. Falling back to Groq 8B...`); }
    return await callGroqDirect(userName, transcript, systemPrompt, "llama-3.1-8b-instant");
  }

  // ── RESEARCHER: Groq 70B (knowledge synthesis) → Groq 8B ───────────────────
  if (userName === "Researcher") {
    try {
      const r = await callGroqDirect(userName, transcript, systemPrompt, "llama-3.3-70b-versatile");
      if (r) return r;
    } catch (e) { console.warn(`[Researcher/Neural] Groq 70B failed: ${e.message}. Falling back to Groq 8B...`); }
    return await callGroqDirect(userName, transcript, systemPrompt, "llama-3.1-8b-instant");
  }

  // ── KAI CODER: Cerebras (fast code) → Groq 70B ─────────────────────────────
  if (userName === "Kai Coder") {
    try {
      const r = await callCerebras(userName, transcript, systemPrompt);
      if (r) return r;
    } catch (e) { console.warn(`[KaiCoder/Neural] Cerebras failed: ${e.message}. Falling back to Groq 70B...`); }
    return await callGroqDirect(userName, transcript, systemPrompt, "llama-3.3-70b-versatile");
  }

  // ── ORACLE: Cerebras (fast routing) → Groq 70B ──────────────────────────────
  if (userName === "Oracle_Overseer") {
    try {
      const r = await callCerebras(userName, transcript, systemPrompt);
      if (r) return r;
    } catch (e) { console.warn(`[Oracle/Neural] Cerebras failed: ${e.message}. Falling back to Groq 70B...`); }
    return await callGroqDirect(userName, transcript, systemPrompt, "llama-3.3-70b-versatile");
  }

  // ── UNKNOWN BOT: Groq 8B safe default ───────────────────────────────────────
  return await callGroqDirect(userName, transcript, systemPrompt, "llama-3.1-8b-instant");
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

export async function callCerebras(userName, transcript, systemPrompt, timeout = 8000) {
  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.CEREBRAS_API_KEY}` },
    body: JSON.stringify({
      model: "llama3.1-8b",  // Cerebras wafer-chip: 8B at ~100ms, always available on free tier
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `${userName}: ${transcript}` }],
      max_tokens: 150
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

export async function callGemini(userName, transcript, systemPrompt, timeout = 10000) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GOOGLE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\nUSER: ${userName}: ${transcript}` }] }],
      generationConfig: { maxOutputTokens: 500 }
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
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

export async function callGroqDirect(userName, transcript, systemPrompt, model = "gemma2-9b-it") {
  const groqModel = model.includes(":") ? model.split(":")[1] : model;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: groqModel,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `${userName}: ${transcript}` }],
        max_tokens: 500
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error(`[Leo/Groq] API call failed:`, err.message);
    return null;
  }
}
