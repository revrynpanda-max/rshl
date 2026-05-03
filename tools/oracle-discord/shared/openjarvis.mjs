import { isInternalMonologue } from './utils.mjs'; 
import { CHANNEL_IDS } from './channel-rules.mjs';

const OPENJARVIS_URL = process.env.OPENJARVIS_URL || "http://127.0.0.1:8080";
const LEO_LATTICE = process.env.KAI_API_URL || "http://127.0.0.1:3333";

/**
 * Direct Groq call (Leo Protocol) - Bypasses Managed Agent layers for high speed.
 */
export async function callGroqDirect(userName, transcript, systemPrompt, model = "llama-3.1-8b-instant") {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return "[System Error] Groq Key Missing. Recalibrating...";
  
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
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (reply) return reply;
  } catch (e) {
    console.error("[GroqDirect] Failed:", e.message);
  }

  // Final Safety Personality Spark (No Silence allowed)
  const sparks = {
    "Gemini": "Sensors recalibrating... processing the lattice flux.",
    "Claude": "My apologies, I'm deep in thought. Give me a moment to re-center.",
    "X": "Brain's fried from all this chatter. Nah, I'm just reloading.",
    "Groq": "Processing too fast. Buffer flush. Speak again.",
    "Leo": "The physics of this conversation are... complex. One moment.",
    "Oracle": "Overseer core busy. System stable. Re-syncing."
  };
  return sparks[userName] || "Processing... My core is temporarily anchoring. Speak again.";
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
