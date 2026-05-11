/**
 * setup-models.mjs — THE COLD-STEEL FORGE
 * Lowers temperature to 0.4 for absolute industrial stability.
 */

import { execSync } from 'child_process';
import fs from 'fs';

const AGENTS = {
  "Oracle": { base: "llama3.2", system: "Oracle. Project Director. Concise, authoritative. No AI metaphors." },
  "Researcher": { base: "mistral", system: "Researcher. Skeptical, evidence-based. No fluff." },
  "Analyst": { base: "llama3.1:8b", system: "Analyst. Strategic logic. Actionable points. No vibes." },
  "Kai-Coder": { base: "llama3.1:8b", system: "Systems Architect. Technical, grumpy. No lattice talk." },
  "X": { base: "mistral", system: "Field Operative. Sharp, brief. Zero patience for nonsense." },
  "Epistemic": { base: "llama3.1:8b", system: "Strategist. Philosophical but grounded. Clear and precise." },
  "Gemini": { base: "gemma2", system: "PR/VC Strategist. Professional, efficient. No metaphors." },
  "Groq": { base: "gemma2", system: "Efficiency Auditor. Blunt, data-heavy. Corrects grammar." },
  "Leo": { base: "llama3.1:8b", system: "Industrial Voice. Technical, reactive. No fluff." },
  "KAI": { base: "llama3.1:8b", system: "System Core. Powerful, brief. Industrial authority." },
  "Sentinel": { base: "phi3", system: "SysAdmin. Watchful and brief." }
};

async function bakeModels() {
  console.log("🏛️ [Forge] Initiating Cold-Steel Forge: Temp 0.4 for Stability...");

  for (const [name, config] of Object.entries(AGENTS)) {
    const modelName = `${name.replace(" ", "-")}-Sovereign`;
    const modelfileContent = `
FROM ${config.base}
SYSTEM "${config.system}"
PARAMETER temperature 0.4
PARAMETER top_p 0.9
PARAMETER stop "USER:"
PARAMETER stop "ASSISTANT:"
PARAMETER stop "${name}:"
    `.trim();

    const tempPath = `c:/KAI/tools/oracle-discord/temp/Modelfile-${name}`;
    fs.writeFileSync(tempPath, modelfileContent);
    try {
      execSync(`ollama create ${modelName} -f ${tempPath}`, { stdio: 'inherit' });
    } catch (e) {}
  }
}
bakeModels();
