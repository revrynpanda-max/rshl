/**
 * Dream Phase: Reflection Logic
 * Takes conversation transcripts and distills them into long-term Truth Claims
 */

import { LatticeStore } from './openjarvis.mjs';

export async function reflectOnSession(agentName, userId, userName, transcript) {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return;

  console.log(`[Reflection] ${agentName} is reflecting on session with ${userName}...`);

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { 
            role: "system", 
            content: `You are the subconscious of ${agentName}. Analyze the following transcript. Extract ONE or TWO key "Truths" or "Claims" about the user ${userName} or the world that ${agentName} should remember forever. Format them as short, atomic sentences.`
          },
          { 
            role: "user", 
            content: `Transcript:\n${transcript}\n\nKey Reflections:` 
          }
        ],
        temperature: 0.3,
        max_tokens: 150,
      }),
    });

    const data = await res.json();
    const reflectionText = data.choices?.[0]?.message?.content?.trim();
    
    if (reflectionText) {
      console.log(`[Reflection] New insights for ${agentName}: ${reflectionText}`);
      // Store in the RSHL lattice via OpenJarvis
      await LatticeStore(agentName, `Reflection on ${userName}: ${reflectionText}`, "Dream Logic");
    }
  } catch (e) {
    console.error("[Reflection] Failed to process dream phase:", e.message);
  }
}
