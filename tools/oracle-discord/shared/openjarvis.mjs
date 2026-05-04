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

  // --- 2. Brain Selection (Turbo-Boost) ---
  let targetModel = model;
  
  // GROQ-BYPASS: Force the Groq persona to use direct API calls for maximum speed
  if (userName === "Groq" || (isSocial && !model.includes(":") && !model.includes("gpt") && !model.includes("claude"))) {
    return await callGroqDirect(userName, transcript, systemPrompt, "llama-3.1-8b-instant");
  }

  try {
    // Wait for memory recall
    if (memoryPromise) {
      const memData = await memoryPromise;
      if (memData?.memories?.length > 0) {
        const pastContext = memData.memories.map(m => `- ${m.content}`).join("\n");
        systemPrompt = `${systemPrompt}\n\n[RECALLED MEMORIES]:\n${pastContext}`;
      }
    }

    const res = await fetch(`${OPENJARVIS_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `${userName}: ${transcript}`, system: systemPrompt, model: targetModel }),
      signal: AbortSignal.timeout(10000), 
    });
    
    if (res.ok) {
      const data = await res.json();
      const reply = (data?.response || data?.reply || data?.text || data?.content || data?.message || "").trim();
      if (reply && !isInternalMonologue(reply)) return reply; 
    }
    
    throw new Error("Primary brain silent or invalid response");

  } catch (e) { 
    console.warn(`[OpenJarvis/Fallback] ${userName} failed: ${e.message}. Using recursive fallback...`);
    
    // RECURSIVE FAILOVER LADDER
    if (userName === "Claude") return await callAnthropic(userName, transcript, systemPrompt);
    if (userName === "Gemini") return await callGemini(userName, transcript, systemPrompt);
    if (userName === "X") return await callXAI(userName, transcript, systemPrompt);
    
    // ORACLE / CODING / LOGIC FALLBACK
    if (userName === "Oracle_Overseer" || userName === "Kai Coder" || targetModel.includes("gpt")) {
      try { return await callOpenAI(userName, transcript, systemPrompt); } catch (e2) {
        try { return await callGemini(userName, transcript, systemPrompt); } catch (e3) {
          return await callGroqDirect(userName, transcript, systemPrompt, "llama-3.1-70b-versatile");
        }
      }
    }

    // GENERAL SPEED FALLBACK
    return await callGroqDirect(userName, transcript, systemPrompt, "gemma2-9b-it");
  }
}

/**
 * Direct Brain Callers (Bypassing Gateway for speed/reliability)
 */
export async function callOpenAI(userName, transcript, systemPrompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `${userName}: ${transcript}` }],
      max_tokens: 500
    })
  });
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

export async function callAnthropic(userName, transcript, systemPrompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20240620",
      system: systemPrompt,
      messages: [{ role: "user", content: `${userName}: ${transcript}` }],
      max_tokens: 500
    })
  });
  const data = await res.json();
  return data.content[0].text.trim();
}

export async function callGemini(userName, transcript, systemPrompt) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GOOGLE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\nUSER: ${userName}: ${transcript}` }] }],
      generationConfig: { maxOutputTokens: 500 }
    })
  });
  const data = await res.json();
  return data.candidates[0].content.parts[0].text.trim();
}

export async function callXAI(userName, transcript, systemPrompt) {
  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.XAI_API_KEY}` },
    body: JSON.stringify({
      model: "grok-beta",
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
