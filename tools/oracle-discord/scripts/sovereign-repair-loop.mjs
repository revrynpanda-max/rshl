/**
 * sovereign-repair-loop.mjs
 * The "Self-Healing Organism" Controller.
 * 
 * Logic:
 * 1. Kimi (Analyst) audits the Project Map and selects a problematic section.
 * 2. Kimi analyzes the code in that section for bugs or debt.
 * 3. Kimi generates a 'Sovereign Directive' for Kai Coder.
 * 4. Kai Coder (Gemini 3.1) executes the fix and auto-applies.
 * 5. Loop repeats for the next section.
 */

import fs from 'fs';
import path from 'path';
import { chatWithOpenJarvis } from '../shared/openjarvis.mjs';
import { runCodingTask } from '../shared/kai-coder-agent.mjs';

const PROJECT_MAP = 'c:/KAI/tools/oracle-discord/state/project_map.json';

async function startSovereignRepair() {
  console.log("🏛️ [Sovereign-Repair] Initializing Kimi Architectural Audit...");

  if (!fs.existsSync(PROJECT_MAP)) {
    console.error("Project map missing. Run generate-snapshot.mjs first.");
    return;
  }

  const map = JSON.parse(fs.readFileSync(PROJECT_MAP, 'utf8'));
  const fileList = map.map(f => `${f.Path} (${Math.round(f.Size/1024)}KB)`).join('\n');

  // ── PHASE 1: SECTION SELECTION ──
  const selectionPrompt = `You are the Analyst — the architectural mind of KAI.
Your goal is to identify ONE section (a file or a small group of related files) of the KAI ecosystem that is likely problematic or needs structural improvement.

[PROJECT MAP]:
${fileList}

Select the most critical file that needs a logic audit. 
Output ONLY the relative path of the file. (e.g. "bots/leo.mjs")`;

  const targetFile = await chatWithOpenJarvis("Analyst", "Identify the first target for the Sovereign Repair Loop.", selectionPrompt, "Kimi-Sovereign");
  if (!targetFile) return;

  console.log(`🏛️ [Sovereign-Repair] Kimi selected target: ${targetFile}`);

  // ── PHASE 2: DEEP AUDIT ──
  const filePath = path.join('c:/KAI', targetFile);
  let content = "";
  try { content = fs.readFileSync(filePath, 'utf8'); } catch (e) { 
    console.error(`Could not read ${targetFile}`);
    return;
  }

  const auditPrompt = `You are the Analyst (Kimi 1T). Perform a Deep Architectural Audit on ${targetFile}.
Look for:
1. Logic bugs (undefined variables, race conditions).
2. Structural debt (messy imports, missing error handling).
3. Performance bottlenecks.

[FILE CONTENT]:
${content.slice(0, 50000)}

If there are issues, write a 'SOVEREIGN DIRECTIVE' for Kai Coder to fix them. 
Be precise. Use code examples in your directive.
If the file is perfect, output "STATUS: OPTIMAL".`;

  const directive = await chatWithOpenJarvis("Analyst", `Analyze ${targetFile} for logic failures.`, auditPrompt, "Kimi-Sovereign");
  
  if (!directive || directive.includes("STATUS: OPTIMAL")) {
    console.log(`🏛️ [Sovereign-Repair] Kimi verified ${targetFile} as OPTIMAL. Moving on.`);
    return;
  }

  console.log(`🏛️ [Sovereign-Repair] Kimi issued DIRECTIVE for ${targetFile}. Dispatching to Kai Coder...`);

  // ── PHASE 3: EXECUTION ──
  const task = `[ORACLE/AUTO-REPAIR] Kimi Audit Directive for ${targetFile}:\n\n${directive}`;
  
  const result = await runCodingTask(task, null, (progress) => {
    console.log(`  [Kai Coder] ${progress}`);
  });

  if (result.success && result.appliedCount > 0) {
    console.log(`🏛️ [Sovereign-Repair] Fix SUCCESSFULLY applied to ${targetFile}.`);
  } else {
    console.log(`🏛️ [Sovereign-Repair] Kai Coder could not complete the fix for ${targetFile}. Manual intervention may be required.`);
  }
}

startSovereignRepair().catch(console.error);
