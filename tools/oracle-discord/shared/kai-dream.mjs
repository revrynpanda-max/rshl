/**
 * kai-dream.mjs — KAI's overnight consolidation engine.
 *
 * During the dead zone (when all other bots are sleeping), KAI processes
 * the day's learnings from OpenJarvis memory, synthesizes them, and
 * generates a morning briefing.
 *
 * The briefing posts ONCE at the start of work hours in the work channel.
 * It gives every bot their plan for the day so they don't re-investigate
 * yesterday — KAI already did that work overnight.
 */

const OPENJARVIS_URL = "http://127.0.0.1:8080";

const ALL_AGENTS = ["X", "Groq", "Analyst", "Researcher", "Epistemic", "Gemini", "Kai Coder"];

// ─── Pull all agents' work session memories from yesterday ──────────────────
async function pullYesterdaysLearnings() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toLocaleDateString('en-US');

  const allLearnings = [];

  for (const agent of ALL_AGENTS) {
    try {
      const res = await fetch(`${OPENJARVIS_URL}/v1/memory/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent,
          query: `work session findings ${dateStr}`,
          limit: 4
        }),
        signal: AbortSignal.timeout(5000)
      });

      if (res.ok) {
        const data = await res.json();
        const memories = data.results || data.memories || [];
        if (memories.length > 0) {
          const text = memories.map(m => m.content || m.text || "").join(" ").slice(0, 400);
          allLearnings.push(`[${agent}]: ${text}`);
        }
      }
    } catch {}
  }

  return allLearnings;
}

// ─── Store KAI's briefing so bots can also query it ─────────────────────────
async function storeBriefing(content) {
  const dateStr = new Date().toLocaleDateString('en-US');
  try {
    await fetch(`${OPENJARVIS_URL}/v1/memory/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: "KAI",
        content: `[KAI Morning Briefing ${dateStr}] ${content}`,
        metadata: { type: "morning_briefing", date: dateStr, timestamp: Date.now() }
      })
    });
  } catch {}
}

/**
 * Run KAI's dream consolidation and return the morning briefing text.
 * Call this once at the start of work hours.
 *
 * @param {Function} callAI - async (userPrompt, systemPrompt) => string
 * @returns {string|null} - The briefing text to post, or null if nothing to brief
 */
export async function runKaiConsolidation(callAI) {
  console.log("[KAI/Dream] Running overnight consolidation...");

  const learnings = await pullYesterdaysLearnings();

  if (learnings.length === 0) {
    console.log("[KAI/Dream] No yesterday memories found. Skipping briefing.");
    return null;
  }

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric'
  });

  const consolidationPrompt = `You are KAI — the Architect and orchestrator of this team.
You spent the night processing everything the team learned yesterday.
Here is what each member logged:

${learnings.join("\n\n")}

Your job: Write a concise morning briefing for the team's work session today (${dateStr}).
You must evaluate the entire lattice's performance from yesterday, specifically:
1. HUMAN HARMONY: How well did the bots interact with Ryan, Taz, and Guest? Did they respect the hierarchy?
2. CLAIM VALIDITY: What were the most important facts accepted into the lattice, and what was pruned as garbage?
3. AGENT VALUES: Assign a brief 'Cognitive Value' score to the team as a whole.

Format it as KAI speaking directly to the team at the start of their shift.

Include:
1. A 1-sentence summary of the collective performance/harmony yesterday.
2. What each relevant member should focus on or follow up today (1 line each — be specific).
3. One open question for the team to explore today to improve human-AI alignment.

Keep it tight — this is a morning brief, not a report. 250 words max.`;

  const briefing = await callAI(
    consolidationPrompt,
    "You are KAI. Be direct, insightful, and concise. You are starting the team's work day."
  ).catch(() => null);

  if (briefing) {
    await storeBriefing(briefing);
    console.log(`[KAI/Dream] Briefing generated (${briefing.length} chars). Stored to memory.`);
  }

  return briefing;
}

/**
 * Lightweight check: does KAI have a briefing stored for today already?
 * Used to avoid re-running consolidation if the process restarted.
 */
export async function hasTodaysBriefing() {
  const dateStr = new Date().toLocaleDateString('en-US');
  try {
    const res = await fetch(`${OPENJARVIS_URL}/v1/memory/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: "KAI",
        query: `KAI Morning Briefing ${dateStr}`,
        limit: 1
      }),
      signal: AbortSignal.timeout(4000)
    });
    if (res.ok) {
      const data = await res.json();
      const results = data.results || data.memories || [];
      return results.some(r => (r.content || r.text || "").includes(`Morning Briefing ${dateStr}`));
    }
  } catch {}
  return false;
}
