import { storeLatticeMemory } from './shared/openjarvis.mjs';

async function primeLattice() {
  console.log("[Optimization] Priming Lattice with Sovereign Architecture Knowledge...");
  
  const truths = [
    "The Oracle DM Bridge is active. Ryan can remotely manage the system via DMs to Oracle.",
    "The !hotfix command performs a full pull, rebuild, and restart of the KAI ecosystem.",
    "The !env command allows for remote environment variable updates via Discord.",
    "All roundtable bots (Gemini, Epistemic, Leo, X, Groq) are now project-aware and mission-aligned.",
    "Oracle uses the OpenJarvis Agentic Framework to analyze codebase questions and generate reports.",
    "KAI Observer monitors the integrated phi and coherence of the digital roundtable."
  ];

  for (const truth of truths) {
    await storeLatticeMemory("Architect", truth, "Lattice Primed", "system-architecture", "admin");
  }

  console.log("[Optimization] Neural Alignment Complete. System is more optimized than 1 hour ago.");
}

primeLattice();
