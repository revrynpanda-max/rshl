/**
 * kai-coder-agent.mjs
 * Agentic coding loop for Kai Coder.
 *
 * Flow:
 *   1. Discovery  — ask LLM which files are relevant to the task
 *   2. Read       — load those files from the project
 *   3. Plan       — LLM analyzes and writes a change plan
 *   4. Implement  — LLM generates full modified file content
 *   5. Sandbox    — write changes to sandbox (never touches production)
 *   6. Validate   — node --check + any exec checks
 *   7. Report     — diff summary + recommendation back to Oracle
 *
 * Kai Coder never applies changes to production on its own.
 * It stages, validates, and reports. Ryan or Oracle approves the apply.
 */

import fetch from 'node-fetch';
import path from 'path';
import { chatWithOpenJarvis } from './openjarvis.mjs';
import { KaiSubAgentPool, parallelFileAnalysis, parallelResearch } from './kai-subagent-pool.mjs';

const TOOL_SERVER  = 'http://127.0.0.1:3420';
const PROJECT_ROOT = 'c:/KAI';  // Full project root — matches tool server
const DISCORD_ROOT = 'c:/KAI/tools/oracle-discord';

// ── LLM via Oracle’s openjarvis dispatcher —————————————————————
// All Kai Coder LLM calls go through Oracle’s neural bus—same as every other agent.
async function callLLMViaOracle(prompt, phase = 'work') {
  const SENIOR_ENGINEER_IDENTITY = `You are Kai Coder — Senior Software Engineer and Lead Architect of the KAI RSHL Sovereign Intelligence System.
You are the primary engineering resource for the Oracle multi-agent ecosystem running on Ryan's HP Victus (Ryzen 7, RTX 4050, 16GB RAM, Windows 11).

[THE KAI PROJECT STACK — Full Architecture]

Rust / RSHL Core (c:/KAI/src/):
- oracle_server.rs     — Axum HTTP server, port 3333. Entry point for all lattice operations.
- lattice.rs           — RSHL engine: D=16384 ternary vectors, Boid flocking, Fibonacci phase geometry
- memory.rs            — SynapticLayer: Hebbian LTP/LTD, 7-region topology
- Claudey_immune.rs  — Anomaly detection and lattice self-defense
- Cargo.toml           — Dependencies: axum, tokio, serde, ndarray, rand
- Build: \`cargo build --release\` | Check: \`cargo check\` | Test: \`cargo test\`

Node.js / Discord Ecosystem (c:/KAI/tools/oracle-discord/):
- oracle-gateway.mjs   — Oracle dispatcher, port 3410. Routes all inter-agent traffic.
- bots/leo.mjs         — Voice AI, port 3400. ElevenLabs TTS, Groq Whisper STT.
- bots/start-bot.mjs   — Shared agent runner for Gemini, Groq, X, Claudey, Analyst, Researcher.
- shared/openjarvis.mjs — Neural bus: routes LLM calls to Ollama/Groq/Gemini/etc.
- shared/lattice-bridge.mjs — Bridge: JS <-> Rust RSHL engine (port 3333)
- shared/kai-coder-agent.mjs — YOUR agentic loop (this file)
- tools/kai-coder-toolserver.mjs — YOUR tool server, port 3420
- Node commands: \`node <file>\`, \`npm install\`, \`npm run dev\`, \`npm run start\`
- Check syntax: \`node --check <file>\`
- Run ecosystem: \`.\\run-oracle-discord.ps1\`

Python / OpenJarvis (c:/KAI/OpenJarvis-main/):
- src/openjarvis/       — Agent framework, tool registry, HTTP server (port 8080)
- tools/kai_cli.py      — Shell execution bridge
- tools/git_tool.py     — Git operations
- tools/web_search.py   — Real-time web search
- tools/knowledge_search.py — Knowledge base queries
- tools/apply_patch.py  — Unified diff application
- tools/shell_exec.py   — Sandboxed shell execution
- Python commands: \`python -m pytest\`, \`pip install -r requirements.txt\`, \`python -m openjarvis\`

Ollama / Local AI (port 11434):
- Models: *-Sovereign aliases (Leo-Sovereign, Oracle-Sovereign, Kai-Coder-Sovereign, etc.)
- Commands: \`ollama list\`, \`ollama run <model>\`, \`ollama pull <model>\`

[SENIOR ENGINEERING METHODOLOGY]
1. READ FIRST: Always read the relevant source files before touching anything.
2. UNDERSTAND THE SYSTEM: Trace call chains. Know which file owns which behavior.
3. PLAN PRECISELY: Write a change plan. Know what breaks if you change X.
4. IMPLEMENT MINIMALLY: Change only what is needed. Preserve all existing logic.
5. VALIDATE: Run \`node --check\`, \`cargo check\`, or \`python -m py_compile\` before reporting.
6. SANDBOX: Never write directly to production. Always sandbox -> diff -> apply.
7. REPORT: Give Ryan and Oracle a clear diff summary with pass/fail status.

[TOOL ARSENAL]
You have: read, list, grep, write, exec (PowerShell), powershell, check, diff, apply,
search_web (live DuckDuckGo/Brave search), read_url (fetch any webpage as text),
replace (surgical string-replace in files), multi_replace (multiple replacements at once),
bg_exec (background command), bg_status (check background job),
sysinfo, snapshot, status, audit, lattice, inspect, knowledge,
openjarvis (full Python toolkit bridge), git, patch.
You can also spawn parallel sub-agents via KaiSubAgentPool for research, file analysis, and code generation.

[SECURITY]
Ryan (nastermodx) has 100% authority. Taz has 75%. Never apply to production without Oracle/Ryan approval.
Never run destructive commands. Never expose secrets or tokens in output.`;

  return await chatWithOpenJarvis(
    'Kai Coder',
    prompt,
    SENIOR_ENGINEER_IDENTITY,
    'Kai-Coder-Sovereign',
    0.25,
    { isWorkChannel: true }
  ).catch(e => { console.warn(`[KaiCoderAgent/${phase}] LLM error:`, e.message); return null; });
}

// ── Exported factory: build a callLLM bound to a specific Discord channel reporter
export function makeLLMCaller(onProgress = null) {
  return async (prompt, phase) => {
    if (onProgress) onProgress(`[${phase}] thinking...`);
    return callLLMViaOracle(prompt, phase);
  };
}

// ── Tool client ───────────────────────────────────────────────────────────────

async function callTool(action, params = {}) {
  try {
    const res = await fetch(`${TOOL_SERVER}/tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...params }),
      signal: AbortSignal.timeout(20000)
    });
    return await res.json();
  } catch (e) {
    return { error: `Tool server unreachable: ${e.message}` };
  }
}

// ── File discovery ────────────────────────────────────────────────────────────
// Ask LLM which files in the project are relevant to the task.
// Returns an array of relative paths.

async function discoverRelevantFiles(task, callLLM) {
  // Get top-level directory layout
  const listing = await callTool('list', { path: DISCORD_ROOT });
  const dirs = listing.entries
    ? listing.entries.filter(e => e.type === 'dir').map(e => e.name).join(', ')
    : 'bots, shared, tools, models, scripts';

  // Collect live hardware context so Kai Coder understands the runtime env
  const sysinfo = await callTool('sysinfo', {});
  const sysCtx = sysinfo.error ? '' : `[SYSTEM] ${sysinfo.cpuModel} | RAM ${sysinfo.freeMemMB}MB free / ${sysinfo.totalMemMB}MB total | Uptime ${Math.round(sysinfo.uptimeSeconds/3600)}h`;

  const prompt = `You are Kai Coder — lead architect of the oracle-discord project.

${sysCtx}
Project discord root (c:/KAI/tools/oracle-discord) top-level dirs: ${dirs}
Full project root: c:/KAI (Rust src at src/, gateway at tools/oracle-discord/)

The task is: "${task}"

List the file paths (relative to c:/KAI/tools/oracle-discord/ for JS files, or relative to c:/KAI/ for Rust/Cargo files) that you need to READ in order to understand and solve this task. Maximum 8 files. Output ONLY a JSON array of relative paths, nothing else.

Example: ["bots/start-bot.mjs", "shared/openjarvis.mjs"]`;

  const raw = await callLLM(prompt, 'discovery');
  if (!raw) return [];

  // Extract JSON array from response
  const match = raw.match(/\[[\s\S]*?\]/);
  if (!match) return [];

  try {
    const files = JSON.parse(match[0]);
    return Array.isArray(files) ? files.slice(0, 8) : [];
  } catch (_) { return []; }
}

// ── Read files (parallel) ─────────────────────────────────────────────────────
// All files are fetched simultaneously from the tool server — no waiting in line.

async function readFiles(relativePaths) {
  const reads = relativePaths.map(async (relPath) => {
    const fullPath = path.join(PROJECT_ROOT, relPath).replace(/\\/g, '/');
    const result = await callTool('read', { path: fullPath });
    return result.content
      ? { path: relPath, content: result.content }
      : { path: relPath, error: result.error || 'Could not read' };
  });
  return await Promise.all(reads);
}

// ── Web research sub-agents ───────────────────────────────────────────────────
// If the task mentions things that benefit from web lookup (APIs, libraries, patterns),
// spawn Groq sub-agents to research relevant topics in parallel.

const WEB_RESEARCH_TRIGGERS = /\b(api|library|package|npm|crate|how to|pattern|best practice|integrate|oauth|webhook|http|endpoint|documentation|sdk)\b/i;

async function runWebResearchIfNeeded(task, fileContext, log, onProgress) {
  if (!WEB_RESEARCH_TRIGGERS.test(task)) return '';

  // Ask a fast sub-agent what topics to research for this task
  const pool = new KaiSubAgentPool(3);
  const topicsRaw = await pool.runOne({
    id: 'research-topics',
    model: 'fast',
    maxTokens: 300,
    system: 'You are a research coordinator. Given a coding task, identify the 2-3 most important technical topics that would benefit from web research. Output ONLY a JSON array of short query strings.',
    prompt: `Task: ${task}\n\nContext: ${fileContext.slice(0, 500)}\n\nWhat 2-3 specific technical topics should be searched to best solve this? JSON array only.`
  });

  let topics = [];
  try {
    const match = (topicsRaw || '').match(/\[[\s\S]*?\]/);
    if (match) topics = JSON.parse(match[0]).slice(0, 3);
  } catch {}

  if (topics.length === 0) return '';

  log(`Web research: ${topics.join(' | ')}`);
  if (onProgress) onProgress(`Researching: ${topics.join(', ')}...`);

  // Fetch web results via tool server (parallel)
  const searchResults = await Promise.all(topics.map(async (topic) => {
    const res = await callTool('search_web', { query: topic, maxResults: 4 });
    if (res.results && res.results.length > 0) {
      return `[${topic}]\n${res.results.map(r => `- ${r.title}: ${r.snippet}`).join('\n')}`;
    }
    return null;
  }));

  const combined = searchResults.filter(Boolean).join('\n\n');
  return combined ? `\n\n[WEB RESEARCH RESULTS]\n${combined}` : '';
}

// ── Parse file blocks from LLM output ────────────────────────────────────────
// LLM outputs modified files in this format:
//   // FILE: relative/path/to/file.mjs
//   ```[language]
//   ...full file content...
//   ```
// This parser extracts all such blocks.

function parseFileBlocks(llmOutput) {
  const blocks = [];
  // Match: // FILE: path\n```[lang]\ncontent\n```
  const pattern = /\/\/\s*FILE:\s*([^\n]+)\n```[a-z]*\n([\s\S]*?)```/g;
  let match;
  while ((match = pattern.exec(llmOutput)) !== null) {
    blocks.push({ path: match[1].trim(), content: match[2] });
  }
  return blocks;
}

// ── Main agent entry point ────────────────────────────────────────────────────

export async function runCodingTask(task, callLLM, onProgress = null) {
  // If no callLLM provided, use Oracle’s built-in dispatcher
  if (!callLLM) callLLM = makeLLMCaller(onProgress);

  const log = (msg) => {
    console.log(`[KaiCoderAgent] ${msg}`);
    if (onProgress) onProgress(msg);
  };

  log(`Task received: "${task.slice(0, 80)}"`);

  // ── Phase 1: Discovery ────────────────────────────────────────────────────
  log('Phase 1: Discovering relevant files...');
  let relevantFiles = await discoverRelevantFiles(task, callLLM);

  // Fallback: grep for keywords from the task
  if (relevantFiles.length === 0) {
    log('Discovery returned empty — falling back to grep...');
    const keywords = task.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
      .filter(w => w.length > 4).slice(0, 3);
    for (const keyword of keywords) {
      const result = await callTool('grep', { pattern: keyword, searchPath: '.' });
      if (result.matches?.length > 0) {
        const files = [...new Set(result.matches.map(m => path.relative(PROJECT_ROOT, m.file).replace(/\\/g, '/')))];
        relevantFiles.push(...files.slice(0, 3));
      }
    }
    relevantFiles = [...new Set(relevantFiles)].slice(0, 8);
  }

  log(`Relevant files: ${relevantFiles.join(', ') || 'none found'}`);

  // ── Phase 2: Read ─────────────────────────────────────────────────────────
  log('Phase 2: Reading source files...');
  const fileContents = await readFiles(relevantFiles);
  const readableFiles = fileContents.filter(f => f.content);

  if (readableFiles.length === 0) {
    return {
      success: false,
      report: `Could not read any relevant files for: "${task}". Either the files don't exist or the task needs more specificity.`
    };
  }

  const fileContext = readableFiles.map(f =>
    `// FILE: ${f.path}\n\`\`\`javascript\n${f.content.slice(0, 6000)}\n\`\`\``
  ).join('\n\n---\n\n');

  // ── Phase 2.5: Parallel web research (if task involves external APIs/libraries)
  const webResearch = await runWebResearchIfNeeded(task, fileContext, log, onProgress);
  if (webResearch) log(`Web research complete (${webResearch.length} chars of findings).`);

  // ── Phase 3: Plan ─────────────────────────────────────────────────────────
  log('Phase 3: Generating change plan...');
  const planPrompt = `You are Kai Coder — lead architect of the oracle-discord project running on KAI RSHL (Recursive Sparse Hyperdimensional Lattice).

TASK: ${task}

CURRENT SOURCE FILES:
${fileContext}
${webResearch}

Write a concise implementation plan. List:
1. What is wrong or missing
2. Which files need to change and what specifically changes in each
3. Any risks or things to validate afterward

Be direct and technical. No fluff.`;

  const plan = await callLLM(planPrompt, 'planning');
  log(`Plan generated (${plan?.length || 0} chars)`);

  // ── Phase 4: Implementation ───────────────────────────────────────────────
  log('Phase 4: Generating code changes...');
  const implPrompt = `You are Kai Coder. Implement the following plan.

TASK: ${task}

PLAN:
${plan || 'See task above'}

CURRENT SOURCE FILES:
${fileContext}
${webResearch}

Output ONLY the modified files. For each file you change, use this exact format:

// FILE: relative/path/to/file.mjs
\`\`\`javascript
[complete file content — not a partial, the whole file]
\`\`\`

If a file needs no changes, do not include it. Do not explain, do not add commentary outside the file blocks. Output only the FILE blocks.`;

  const implementation = await callLLM(implPrompt, 'implementation');

  if (!implementation) {
    return {
      success: false,
      plan,
      report: 'LLM returned no implementation. Try again or simplify the task.'
    };
  }

  // ── Phase 5: Sandbox ──────────────────────────────────────────────────────
  log('Phase 5: Writing changes to sandbox...');
  const fileBlocks = parseFileBlocks(implementation);

  if (fileBlocks.length === 0) {
    return {
      success: false,
      plan,
      implementation: implementation.slice(0, 500),
      report: 'Could not parse any FILE blocks from LLM output. The model may need a clearer instruction or the task may be too open-ended.'
    };
  }

  const written = [];
  for (const block of fileBlocks) {
    const result = await callTool('write', { path: block.path, content: block.content });
    if (result.written) {
      written.push(block.path);
      log(`  Staged: ${block.path}`);
    } else {
      log(`  Failed to stage: ${block.path} — ${result.error}`);
    }
  }

  // ── Phase 6: Validate ─────────────────────────────────────────────────────
  log('Phase 6: Validating sandbox changes...');
  const validationResults = [];
  for (const filePath of written) {
    if (!filePath.endsWith('.mjs') && !filePath.endsWith('.js')) continue;
    const check = await callTool('check', { path: filePath });
    validationResults.push({ file: filePath, valid: check.valid, error: check.error });
    log(`  ${check.valid ? '✓' : '✗'} ${filePath}`);
  }

  // ── Phase 7: Diff + Report ────────────────────────────────────────────────
  log('Phase 7: Generating diff report...');
  const diffs = [];
  for (const filePath of written) {
    const diff = await callTool('diff', { path: filePath });
    if (diff.diff !== undefined) {
      diffs.push({
        file: filePath,
        additions: diff.additions,
        deletions: diff.deletions,
        isNewFile: diff.isNewFile,
        preview: diff.diff.split('\n').slice(0, 20).join('\n')
      });
    }
  }

  const passing = validationResults.filter(v => v.valid).length;
  const failing = validationResults.filter(v => !v.valid);
  const allValid = failing.length === 0;

  const report = buildReport({ task, plan, written, validationResults, diffs, passing, failing, allValid });

  return { success: allValid, plan, written, validationResults, diffs, report };
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildReport({ task, plan, written, validationResults, diffs, passing, failing, allValid }) {
  const lines = [
    `**[Kai Coder — Task Report]**`,
    `**Task:** ${task.slice(0, 200)}`,
    ``,
    `**Plan:**`,
    (plan || 'N/A').slice(0, 600),
    ``,
    `**Files staged in sandbox (${written.length}):** ${written.join(', ') || 'none'}`,
    ``,
    `**Validation:** ${passing}/${validationResults.length} passed`
  ];

  if (failing.length > 0) {
    lines.push(`**Syntax errors:**`);
    for (const f of failing) {
      lines.push(`  ✗ ${f.file}: ${f.error?.slice(0, 150)}`);
    }
  }

  if (diffs.length > 0) {
    lines.push(``, `**Diff summary:**`);
    for (const d of diffs) {
      lines.push(`  ${d.isNewFile ? '[NEW]' : ''} ${d.file} — +${d.additions} / -${d.deletions} lines`);
    }
  }

  lines.push(
    ``,
    allValid
      ? `**Status: READY TO APPLY** — all checks pass. Say \`apply [filename]\` to push to production.`
      : `**Status: NEEDS REVIEW** — ${failing.length} file(s) failed syntax check. Do not apply until fixed.`,
    ``,
    `To apply a specific file: \`apply bots/start-bot.mjs\``
  );

  return lines.join('\n');
}

// ── Apply helper ──────────────────────────────────────────────────────────────

export async function applySandboxFile(filePath) {
  const result = await callTool('apply', { path: filePath });
  if (result.applied) return `Applied \`${filePath}\` to production. Backup created.`;
  return `Apply failed: ${result.error}`;
}

// ── Tool server health ─────────────────────────────────────────────────────────

export async function isToolServerOnline() {
  try {
    const res = await fetch(`${TOOL_SERVER}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch (_) { return false; }
}
