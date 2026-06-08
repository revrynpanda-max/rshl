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
import { buildGraph, blastRadius, riskScore } from './dependency-graph.mjs';
import { recordMetric } from './metrics-store.mjs';
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
- oracle_server.rs     — Axum HTTP server, port 3334. Entry point for all lattice operations.
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
- shared/lattice-bridge.mjs — Bridge: JS <-> Rust RSHL engine (port 3334)
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
    { isWorkChannel: true, isRawPrompt: true, maxTokens: 4096 }
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
  // Pre-Discovery: Extract explicit file paths from the task (e.g., from stack traces)
  const pathRegex = /(?:[a-zA-Z]:)?[\\\/][^:\s]+\.(?:mjs|js|rs|toml|py|json|md)\b/g;
  const rawPaths = task.match(pathRegex) || [];
  const explicitFiles = rawPaths.map(p => {
    let clean = p.replace(/file:\/\/\/?/i, '').replace(/\\/g, '/');
    // If it's absolute, try to make it relative to PROJECT_ROOT or DISCORD_ROOT
    if (clean.includes('tools/oracle-discord/')) {
       clean = clean.split('tools/oracle-discord/')[1];
    } else if (clean.includes('c:/KAI/')) {
       clean = clean.split('c:/KAI/')[1];
    }
    return clean;
  }).filter(f => f && f.includes('.'));

  // Get top-level directory layout
  const listing = await callTool('list', { path: DISCORD_ROOT });
  const dirs = listing.entries
    ? listing.entries.filter(e => e.type === 'dir').map(e => e.name).join(', ')
    : 'bots, shared, tools, models, scripts';

  const prompt = `You are Kai Coder — lead architect of the KAI system.
The task is: "${task}"

[IDENTIFIED FILES FROM STACK TRACE/CONTEXT]: ${explicitFiles.join(', ') || 'None'}

Your goal is to identify the EXACT source files needed to solve this. 
PRIORITIZE:
1. Files mentioned in stack traces or error messages.
2. Active logic files (bots/*.mjs, shared/*.mjs, src/*.rs).
3. Config files (.env, Cargo.toml).
IGNORE: General documentation (ARCHITECTURE.md, etc.) unless specifically relevant to a conceptual refactor.

Project structure: ${dirs}
Output ONLY a JSON array of relative paths (e.g. ["bots/leo.mjs", "shared/utils.mjs"]). Max 8 files.`;

  const raw = await callLLM(prompt, 'discovery');
  if (!raw) return explicitFiles.slice(0, 8);

  const match = raw.match(/\[[\s\S]*?\]/);
  try {
    const suggested = match ? JSON.parse(match[0]) : [];
    // Merge explicit files with LLM suggestions, removing duplicates
    const final = [...new Set([...explicitFiles, ...suggested])];
    return final.slice(0, 8);
  } catch (_) { return explicitFiles.slice(0, 8); }
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
  const planPrompt = `You are Kai Coder — Lead Architect of the KAI RSHL Sovereign Intelligence System.

[SITUATION]
The system has issued an architectural directive: "${task}"

[SOURCE CONTEXT]
${fileContext}
${webResearch}

[ARCHITECTURAL ANALYSIS]
Provide a senior-level analysis and implementation plan.
1. Core Logic Failure: Identify the root cause within the system topology (imports, state, or logic).
2. Structural Resolution: Define the precise architectural changes required to restore coherence and prevent regression.
3. Validation Strategy: Define the verification metrics (syntax check, build, or runtime audit).

Focus on system integrity, robust error handling, and maintaining the sovereign identity of the codebase. No low-level fluff.`;

  const plan = await callLLM(planPrompt, 'planning');
  log(`Plan generated (${plan?.length || 0} chars)`);

  // ── Phase 4: Implementation ───────────────────────────────────────────────
  log('Phase 4: Generating code changes...');
  const implPrompt = `You are Kai Coder. Execute the Architectural Implementation based on the plan below.

[DIRECTIVE]
${task}

[PLAN]
${plan || 'See task above'}

[ARCHITECTURAL CONTEXT]
${fileContext}
${webResearch}

[IMPLEMENTATION]
Output ONLY the high-fidelity, production-ready source files. 
Ensure every change adheres to senior architectural standards: robust error boundaries, clear dependency mapping, and structural coherence. 

For each file you change, use this exact format:

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

  // ── Phase 6: Validate (Stage 6 — sandbox safety pipeline) ────────────────
  // Three checks per staged file:
  //   (a) Shape sanity — non-empty, no NUL bytes, ends in newline. Catches
  //       mid-write corruption from the flaky mount layer BEFORE it reaches
  //       production source.
  //   (b) Syntax check — node --check for JS, cargo check for Rust if cargo
  //       is available. Skipped politely for other file types.
  //   (c) Metric emission — every validation outcome lands in the unified
  //       metrics store so we can audit the auto-repair pipeline over time.
  log('Phase 6: Validating sandbox changes...');
  const validationResults = [];
  for (const filePath of written) {
    let valid = true;
    let error = null;

    // (a) Shape sanity — read the staged file and check for corruption signs
    try {
      const fs = await import('fs');
      const fullPath = path.resolve(PROJECT_ROOT, filePath);
      const buf = fs.readFileSync(fullPath);
      if (buf.length === 0) { valid = false; error = 'sandbox file is empty'; }
      else if (buf.indexOf(0) >= 0) { valid = false; error = `NUL byte at offset ${buf.indexOf(0)} (mid-write corruption?)`; }
      else if (buf[buf.length - 1] !== 0x0A) { valid = false; error = 'file does not end in newline (possible truncation)'; }
    } catch (e) {
      valid = false;
      error = `could not read staged file: ${e.message}`;
    }

    // (b) Syntax check by extension
    if (valid) {
      if (filePath.endsWith('.mjs') || filePath.endsWith('.js') || filePath.endsWith('.cjs')) {
        const check = await callTool('check', { path: filePath });
        valid = !!check.valid;
        error = check.error || null;
      } else if (filePath.endsWith('.rs')) {
        // Best-effort: run `cargo check` if available, otherwise skip
        try {
          const { execSync } = await import('child_process');
          execSync('cargo --version', { stdio: 'ignore', timeout: 5000 });
          const root = (filePath.split(/[\\/]/).indexOf('src') > 0) ? filePath.split(/[\\/]/).slice(0, filePath.split(/[\\/]/).indexOf('src')).join('/') : null;
          if (root) {
            try {
              execSync('cargo check --manifest-path=' + root + '/Cargo.toml --message-format=short', { timeout: 120_000, stdio: 'pipe' });
            } catch (e) {
              valid = false;
              error = 'cargo check failed: ' + String(e.stderr || e.message).slice(0, 200);
            }
          }
        } catch (_) { /* cargo not installed — skip gracefully */ }
      }
      // Other extensions (.toml, .json) — leave valid=true (no validator wired)
    }

    validationResults.push({ file: filePath, valid, error });
    log(`  ${valid ? '✓' : '✗'} ${filePath}${error ? ' — ' + error : ''}`);
    try {
      const { recordMetric } = await import('./metrics-store.mjs');
      recordMetric('kai-coder-agent', 'sandbox_validation', valid ? 1 : 0, {
        file: filePath,
        error: error ? String(error).slice(0, 80) : '',
      });
    } catch (_) {}
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

  // SAFETY BRAKE: Unsupervised auto-apply is disabled by default.
  // Set KAI_AUTOAPPLY=1 in .env to enable this feature for trusted agents.
  const canAutoApply = process.env.KAI_AUTOAPPLY === "1";
  let appliedCount = 0;
  const appliedFiles = [];
  const isAutoRepair = task.includes('[ORACLE/AUTO-REPAIR]');
  
  if (canAutoApply && isAutoRepair && allValid) {
    log('System auto-repair validated. Evaluating blast radius per file before applying...');
    let graph = null;
    try { graph = buildGraph(); }
    catch (e) { log('blast-radius graph build failed: ' + e.message); }

    let blockedByBlast = 0;
    for (const filePath of written) {
      let blast = 0, risk = 'low';
      if (graph) {
        try { blast = blastRadius(filePath, graph); risk = riskScore(blast); }
        catch (_) {}
      }
      recordMetric('kai-coder-agent', 'auto_apply_evaluation', blast, {
        file: filePath, risk,
      });

      // Stage 3 "car part" gate: refuse to silently overwrite files that many
      // others depend on. High blast = a change here can ripple system-wide,
      // never auto-apply it — stage for human review only.
      if (risk === 'high') {
        log(`REFUSING auto-apply for ${filePath} — blast radius ${blast} (high). Staged for human review only.`);
        recordMetric('kai-coder-agent', 'auto_apply_blocked_high_blast', 1, { file: filePath, blast });
        blockedByBlast++;
        continue;
      }
      if (risk === 'medium') {
        log(`Auto-applying ${filePath} (medium blast=${blast}) — flagged for spot-check.`);
      } else {
        log(`Auto-applying ${filePath} (low blast=${blast}).`);
      }
      const applyRes = await applySandboxFile(filePath);
      if (applyRes.includes('Applied')) {
        appliedCount++;
        recordMetric('kai-coder-agent', 'auto_apply_applied', 1, { file: filePath, blast, risk });
        appliedFiles.push(filePath);
      }
    }
    if (blockedByBlast > 0) {
      log(`Auto-apply summary: ${appliedCount} applied, ${blockedByBlast} BLOCKED by blast-radius gate.`);
    }

    // Stage 18: close the loop. For each successfully-applied patch, request a
    // surgical restart of the affected bot and verify it came back healthy.
    // hintedBot can be passed in via the task context (e.g. diagnostic-router
    // forwards "Groq is the bot that failed" so we restart Groq specifically,
    // not whatever the file path heuristic guesses).
    if (appliedFiles.length > 0) {
      try {
        const { healPath } = await import('./process-supervisor.mjs');
        for (const filePath of appliedFiles) {
          const result = await healPath(filePath, { hintedBot: task?.affectedBot || null, reason: 'kai-coder-auto-patch' });
          if (result.healed) {
            log(`Surgical heal: ${result.bot} restored in ${result.waitedMs}ms after patch to ${filePath}`);
          } else if (result.bot) {
            log(`Surgical heal incomplete for ${result.bot} (${result.reason}) — patch on disk, bot will pick it up on next natural restart.`);
          }
        }
      } catch (e) {
        log(`Surgical-restart hook failed: ${e.message} (patches applied, will take effect on next manual restart)`);
      }
    }
  } else if (isAutoRepair) {
    log('Auto-apply is disabled. (Set KAI_AUTOAPPLY=1 to enable). Staging changes for review.');
  }

  const report = buildReport({ task, plan, written, validationResults, diffs, passing, failing, allValid, appliedCount });

  return { success: allValid, plan, written, validationResults, diffs, report, appliedCount };
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildReport({ task, plan, written, validationResults, diffs, passing, failing, allValid, appliedCount }) {
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

  const isAutoRepair = task.includes('[ORACLE/AUTO-REPAIR]');

  if (isAutoRepair && appliedCount > 0) {
     lines.push(``, `**⚡ AUTONOMOUS RESOLUTION COMPLETE**`, `All fixes successfully applied to production.`);
  } else {
    lines.push(
      ``,
      allValid
        ? `**Status: READY TO APPLY** — all checks pass. Say \`apply [filename]\` to push to production.`
        : `**Status: NEEDS REVIEW** — ${failing.length} file(s) failed syntax check. Do not apply until fixed.`,
      ``,
      `To apply a specific file: \`apply bots/start-bot.mjs\``
    );
  }

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
