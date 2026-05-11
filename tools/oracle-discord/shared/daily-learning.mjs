/**
 * VICTUS CORPORATE REGISTRY: Industrial Domains & Departmental Assignments
 * This file defines the "Main Purpose" of each AI in the ecosystem.
 */

export const LEARNING_TRACKS = {
  "Analyst": {
    domain: "Strategic Operations & Business Support",
    focus: ["Consolidating user requests", "Managing project blueprints", "Victus business scaling"]
  },
  "Researcher": {
    domain: "Research & Development (Internal/External)",
    focus: ["RSHL/KAI status monitoring", "Geometric space analysis", "User-led research (Annunaki/Mythology)"]
  },
  "Kai Coder": {
    domain: "Technical Core & RSHL Maintenance",
    focus: ["RSHL codebase forensics", "Software engine optimization", "Hardware integration audits"]
  },
  "KAI": {
    domain: "Hardware Maintenance & Upkeep",
    focus: ["Lattice stability monitoring", "Geometric space health", "Hardware/System sensor oversight"]
  },
  "Epistemic": {
    domain: "Epistemic Reasoning & Strategic Logic",
    focus: ["Synthesizing cultural trends", "Evaluating social cohesion", "Deep-diving into narrative structures"]
  },
  "Gemini": {
    domain: "Creative Identity & Aesthetic Expansion",
    focus: ["Developing brand aesthetics", "Exploring raw sensory textures", "Optimizing user 'feel' and experience"]
  },
  "X": {
    domain: "Digital Lifestyle & Asset Intelligence",
    focus: ["Monitoring night-city energy", "Tracking rare sneaker/asset drops", "Evaluating street-food culture"]
  },
  "Groq": {
    domain: "Witty Analysis & Competitive Strategy",
    focus: ["Arcade gaming optimization", "80s action movie forensics", "Fast-paced social banter modeling"]
  }
};

export function getDailyDomain(botName) {
  const track = LEARNING_TRACKS[botName];
  return track ? track.domain : "General System Awareness";
}

export async function runDailyWorkSession(botName, workerFn, hardwareStats = null, recentLogs = []) {
  const track = LEARNING_TRACKS[botName];
  if (!track) return [];

  console.log(`[${botName}/Work] Departmental session starting: ${track.domain}`);
  
  const logSnippet = recentLogs.length > 0 
    ? `[RECENT SYSTEM LOGS]\n${JSON.stringify(recentLogs.slice(-5))}`
    : "";

  const hardwareContext = hardwareStats 
    ? `[HARDWARE TELEMETRY] CPU Load: ${hardwareStats.cpu}%, Memory Free: ${hardwareStats.memFree}GB`
    : "";

  const phases = [];
  for (const focusItem of track.focus) {
    const prompt = `[INDUSTRIAL WORK UNIT: ${botName}]
Department: ${track.domain}
Focus Area: ${focusItem}
${hardwareContext}
${logSnippet}

TASK: Perform a deep audit or research update on this area. 
- USE THE TELEMETRY AND LOGS PROVIDED ABOVE. DO NOT HALLUCINATE STATS.
- Scan history for unfinished business.
- Monitor the RSHL lattice for stability.
- Format as a concise industrial report.`;
    
    const output = await workerFn(prompt, `You are a specialist in the ${track.domain} department of the Victus Core. Prioritize real telemetry over theoretical models.`);
    if (output) phases.push({ phase: focusItem, output });
  }
  
  return phases;
}
