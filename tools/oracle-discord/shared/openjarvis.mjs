import { isInternalMonologue } from './utils.mjs'; 
import { CHANNEL_IDS } from './channel-rules.mjs';

const OPENJARVIS_URL = process.env.OPENJARVIS_URL || "http://127.0.0.1:8080";
const LEO_LATTICE = process.env.KAI_API_URL || "http://127.0.0.1:3333";

/**
 * Direct Anthropic call (Claude Persona)
 */
export async function callAnthropic(userName, transcript, systemPrompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return await callGroqDirect(userName, transcript, systemPrompt);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-latest",
        system: systemPrompt,
        messages: [{ role: "user", content: `${userName}: ${transcript}` }],
        max_tokens: 500
      }),
    });
    if (!res.ok) throw new Error(`API_LIMIT:${res.status}`);
    const data = await res.json();
    return data.content?.[0]?.text?.trim();
  } catch (e) { throw e; }
}

/**
 * Direct Gemini call (Gemini Persona)
 */
export async function callGemini(userName, transcript, systemPrompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return await callGroqDirect(userName, transcript, systemPrompt);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\n${userName}: ${transcript}` }] }],
        generationConfig: { maxOutputTokens: 500 }
      }),
    });
    if (!res.ok) throw new Error(`API_LIMIT:${res.status}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  } catch (e) { throw e; }
}

/**
 * Direct xAI call (X Persona)
 */
export async function callXAI(userName, transcript, systemPrompt) {
  const key = process.env.XAI_API_KEY;
  if (!key) return await callGroqDirect(userName, transcript, systemPrompt);
  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model: "grok-beta",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `${userName}: ${transcript}` }],
        max_tokens: 500
      }),
    });
    if (!res.ok) throw new Error(`API_LIMIT:${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim();
  } catch (e) { throw e; }
}

/**
 * Direct OpenAI call (GPT-4o Persona)
 */
export async function callOpenAI(userName, transcript, systemPrompt) {
  const key = process.env.OPEN_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) return await callGroqDirect(userName, transcript, systemPrompt);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `${userName}: ${transcript}` }],
        max_tokens: 500
      }),
    });
    if (!res.ok) throw new Error(`API_LIMIT:${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim();
  } catch (e) { throw e; }
}

/**
 * Direct Groq call (Leo Protocol) - Bypasses Managed Agent layers for high speed.
 */
export async function callGroqDirect(userName, transcript, systemPrompt, model = "llama-3.3-70b-versatile") {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return "[System Error] Groq Key Missing. Recalibrating...";
  
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `${userName}: ${transcript}` }],
        temperature: 0.7, max_tokens: 500
      }),
    });
    
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const msg = errData.error?.message || res.statusText;
      console.warn(`[GroqDirect] API Error (${res.status}):`, msg);
      throw new Error(`API_LIMIT:${res.status}`);
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (reply) return reply;
  } catch (e) {
    console.error(`[GroqDirect] Failed for ${userName}:`, e.message);
  }
  return null;
}

/**
 * Send a chat message through OpenJarvis.
 * Hybrid Mode: Tries Managed Agent first, falls back to direct completion.
 */
export async function chatWithOpenJarvis(userName, transcript, systemPrompt, model = "kai-next:latest", agentId = null, metadata = {}) {
  // --- Continuous Consciousness Layer (Long-Term Memory) ---
  const isAgent = ["Leo", "Researcher", "Analyst", "Claude", "Gemini", "X", "Groq", "KAI", "Oracle_Overseer", "Kai Coder"].includes(userName);
  
  if (isAgent) {
    try {
      const dateStr = new Date().toLocaleString();
      const author = metadata.author || "Unknown";
      const channel = metadata.channel || "Unknown";
      
      // 1. Store Memory (High-Fidelity)
      fetch(`${OPENJARVIS_URL}/v1/memory/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent: userName,
          content: `[${dateStr}] [${channel}] ${author}: ${transcript}`,
          metadata: { 
            timestamp: Date.now(), 
            date: dateStr,
            author: author,
            channel: channel,
            source: "Discord" 
          }
        })
      }).catch(() => {});

      // 2. Recall Memories (Semantic Search)
      const memRes = await fetch(`${OPENJARVIS_URL}/v1/memory/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: userName, query: transcript, limit: 3 })
      }).catch(() => null);

      if (memRes && memRes.ok) {
        const memData = await memRes.json();
        if (memData.memories?.length > 0) {
          const pastContext = memData.memories.map(m => `- ${m.content}`).join("\n");
          systemPrompt = `${systemPrompt}\n\n[RECALLED MEMORIES FROM YOUR LIFE]:\n${pastContext}`;
        }
      }
    } catch (e) {}
  }

  try {
    let url = `${OPENJARVIS_URL}/api/chat`;
    let body = { 
      message: `${userName}: ${transcript}`, 
      system: systemPrompt, 
      model: model 
    };

    if (agentId) {
      url = `${OPENJARVIS_URL}/v1/agents/${agentId}/messages`;
      body = { content: transcript, mode: "immediate", stream: false };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000), 
    });
    
    if (res.ok) {
      const data = await res.json();
      const reply = (data?.response || data?.reply || data?.text || data?.content || data?.message || "").trim();
      
      if (reply && !isInternalMonologue(reply)) { 
        return reply; 
      }
    }
    
    // UNIVERSAL FALLBACK: If any brain is silent/failed, use NATIVE or direct Groq
    console.log(`[OpenJarvis/Hybrid] Primary brain for ${userName} silent. Using native-brain/model backup...`);
    
    if (userName === "Claude") return await callAnthropic(userName, transcript, systemPrompt);
    if (userName === "Gemini") return await callGemini(userName, transcript, systemPrompt);
    if (userName === "X") return await callXAI(userName, transcript, systemPrompt);
    
    // ORACLE RECURSIVE FALLBACK (High Resiliency)
    if (userName === "Oracle_Overseer") {
      try { return await callOpenAI(userName, transcript, systemPrompt); } catch (e) {
        console.warn("[Oracle] OpenAI failed, trying Gemini...");
        try { return await callGemini(userName, transcript, systemPrompt); } catch (e2) {
          console.warn("[Oracle] Gemini failed, trying Groq...");
          return await callGroqDirect(userName, transcript, systemPrompt, "llama-3.3-70b-versatile");
        }
      }
    }

    if (userName === "GPT-4o" || model.includes("gpt-4o")) return await callOpenAI(userName, transcript, systemPrompt);
    
    return await callGroqDirect(userName, transcript, systemPrompt, model);

  } catch (e) { 
    console.warn(`[OpenJarvis] Hybrid request failed for ${userName}:`, e.message);
    
    if (userName === "Claude") return await callAnthropic(userName, transcript, systemPrompt);
    if (userName === "Gemini") return await callGemini(userName, transcript, systemPrompt);
    if (userName === "X") return await callXAI(userName, transcript, systemPrompt);
    
    if (userName === "Oracle_Overseer") {
      try { return await callOpenAI(userName, transcript, systemPrompt); } catch (e) {
        try { return await callGemini(userName, transcript, systemPrompt); } catch (e2) {
          return await callGroqDirect(userName, transcript, systemPrompt, "llama-3.3-70b-versatile");
        }
      }
    }

    if (userName === "GPT-4o" || model.includes("gpt-4o")) return await callOpenAI(userName, transcript, systemPrompt);
    
    return await callGroqDirect(userName, transcript, systemPrompt, model);
  }
  return null;
}

/**
 * Direct lattice query for memory (mostly used by Leo for explicit memory extraction when using Groq)
 */
export async function queryLatticeMemory(topic, region, limit = 4, channelFilter = null) {
  try {
    const res = await fetch(`${LEO_LATTICE}/api/rshl/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: topic, limit: limit + 8 }), 
    });
    if (!res.ok) return [];
    const hits = await res.json();
    return hits
      .filter(h => {
        const t = String(h.text || "");
        const channelOk = !channelFilter || t.startsWith(`[${channelFilter}]`);
        return (
          h.source === region &&          
          h.region === region &&           
          !isInternalMonologue(t) &&      
          t.length > 10 &&
          t.length < 300 &&
          channelOk                       
        );
      })
      .slice(0, limit)
      .map(h => h.text);
  } catch {
    return [];
  }
}

/**
 * Direct lattice store for memory
 */
export async function storeLatticeMemory(userName, utterance, reply, region, channel = "unknown") {
  const memoryText = `[${channel}] ${userName} said: "${utterance}" — ${region} replied: "${reply}"`;
  
  // Dynamic Evolution Weights
  let strength = 1.2; // Default
  if (channel === CHANNEL_IDS.WORK || channel === CHANNEL_IDS.SENSITIVE) strength = 2.0;
  if (channel === CHANNEL_IDS.GAME) strength = 0.8;

  try {
    await fetch(`${LEO_LATTICE}/api/rshl/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: memoryText,
        region: region,       
        source: region,       
        strength: strength,       
      }),
    });
    console.log(`[LatticeStore] Stored for ${region} (Strength: ${strength}): "${memoryText.slice(0, 80)}"`);
  } catch (e) {
    console.warn("[LatticeStore] Store failed:", e.message);
  }
}

export { storeLatticeMemory as LatticeStore };
