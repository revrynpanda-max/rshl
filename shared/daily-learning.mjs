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
  "Claude": {
    domain: "Strategic Synthesis Support",
    focus: ["Synthesizing R&D data", "Industrial risk assessment", "Departmental collaboration"]
  },
  "Gemini": {
    domain: "Corporate Identity & Expansion",
    focus: ["Brand strategy", "Victus Core presentation", "User experience logic"]
  },
  "X": {
    domain: "Digital Asset Intelligence",
    focus: ["Market monitoring", "Resource allocation logic", "Asset security"]
  },
  "Groq": {
    domain: "Quantitative Metrics & Analysis",
    focus: ["Lattice performance data", "Computational load modeling", "Metric reporting"]
  }
};

export function getDailyDomain(botName) {
  const track = LEARNING_TRACKS[botName];
  return track ? track.domain : "General System Awareness";
}

export async function runDailyWorkSession(botName, workerFn) {
  const track = LEARNING_TRACKS[botName];
  if (!track) return [];

  console.log(`[${botName}/Work] Departmental session starting: ${track.domain}`);
  
  const phases = [];
  for (const focusItem of track.focus) {
    const prompt = `[INDUSTRIAL WORK UNIT: ${botName}]
Department: ${track.domain}
Focus Area: ${focusItem}
TASK: Perform a deep audit or research update on this area. 
- Scan history for unfinished business.
- Monitor the RSHL lattice for stability.
- Format as a concise industrial report.`;
    
    const output = await workerFn(prompt, `You are a specialist in the ${track.domain} department of the Victus Core.`);
    if (output) phases.push({ phase: focusItem, output });
  }
  
  return phases;
}
