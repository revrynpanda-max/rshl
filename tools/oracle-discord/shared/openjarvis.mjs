import { isInternalMonologue } from './utils.mjs'; // We'll need a utils.mjs

const OPENJARVIS_URL = process.env.OPENJARVIS_URL || "http://127.0.0.1:8080";
const LEO_LATTICE = process.env.KAI_API_URL || "http://127.0.0.1:3333";

/**
 * Send a chat message through OpenJarvis.
 * Supports both generic completions and specialized Managed Agents.
 */
export async function chatWithOpenJarvis(userName, transcript, systemPrompt, model = "kai-next:latest", agentId = null) {
  try {
    let url = `${OPENJARVIS_URL}/api/chat`;
    let body = { 
      message: `${userName}: ${transcript}`, 
      system: systemPrompt, 
      model: model 
    };

    // If an agentId is provided (e.g. 'oracle-core'), use the Managed Agent endpoint
    // This enables persistence, tool-calling, and custom agent logic.
    if (agentId) {
      url = `${OPENJARVIS_URL}/v1/agents/${agentId}/messages`;
      body = {
        content: transcript,
        mode: "immediate", // Process immediately
        stream: false      // Get the full response back
      };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000), // Increased timeout for tool-calling agents
    });
    
    if (res.ok) {
      const data = await res.json();
      // Handle different response shapes (Generic Chat vs Managed Agent Message)
      const reply = (data?.response || data?.reply || data?.text || data?.content || "").trim();
      if (reply && !isInternalMonologue(reply)) { 
        return reply; 
      }
    }
    
    // FAILSAFE: If the specialized brain is empty/stalled, try a generic social fallback
    if (!agentId || agentId === "kai-observer") return null; 
    
    console.log(`[OpenJarvis] Agent ${agentId} was silent. Attempting social fallback...`);
    return await chatWithOpenJarvis(userName, transcript, systemPrompt, "llama-3.1-8b-instant", null);

  } catch (e) { 
    console.warn(`[OpenJarvis] Chat request failed (${agentId || "generic"}):`, e.message); 
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
