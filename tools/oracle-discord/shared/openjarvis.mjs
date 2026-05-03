import { isInternalMonologue } from './utils.mjs'; // We'll need a utils.mjs

const OPENJARVIS_URL = process.env.OPENJARVIS_URL || "http://127.0.0.1:8080";
const LEO_LATTICE = process.env.KAI_API_URL || "http://127.0.0.1:3333";

/**
 * Direct Groq call (Leo Protocol) - Bypasses Managed Agent layers for high speed.
 */
export async function callGroqDirect(userName, transcript, systemPrompt, model = "llama-3.1-8b-instant") {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return null;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `${userName}: ${transcript}` }],
        temperature: 0.7, max_tokens: 150
      }),
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error("[GroqDirect] Failed:", e.message);
    return null;
  }
}

/**
 * Send a chat message through OpenJarvis.
 * Hybrid Mode: Tries Managed Agent first, falls back to direct completion.
 */
export async function chatWithOpenJarvis(userName, transcript, systemPrompt, model = "kai-next:latest", agentId = null) {
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
    
    // UNIVERSAL FALLBACK: If any brain is silent/failed, use direct Groq
    console.log(`[OpenJarvis/Hybrid] Primary brain for ${userName} silent. Using direct-brain backup...`);
    return await callGroqDirect(userName, transcript, systemPrompt);

  } catch (e) { 
    console.warn(`[OpenJarvis] Hybrid request failed for ${userName}:`, e.message);
    return await callGroqDirect(userName, transcript, systemPrompt);
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
  try {
    await fetch(`${LEO_LATTICE}/api/rshl/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: memoryText,
        region: region,       
        source: region,       
        strength: 1.2,       
      }),
    });
    console.log(`[LatticeStore] Stored for ${region}: "${memoryText.slice(0, 80)}"`);
  } catch (e) {
    console.warn("[LatticeStore] Store failed:", e.message);
  }
}

export { storeLatticeMemory as LatticeStore };
