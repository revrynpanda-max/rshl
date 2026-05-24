/**
 * oracle-intent.mjs — Natural Language Understanding for Oracle
 *
 * Replaces keyword/command matching with RSHL-powered intent classification.
 * When Ryan says "fix the bug in the auth module", Oracle understands:
 *   intent: "code_fix"
 *   target: "auth module"
 *   agent: "Kai Coder"
 *   tools: ["read_file", "edit_file", "cargo_check"]
 *
 * No !commands. No regex hacks. Just plain English → structured action.
 */

import { queryLattice, storeLattice } from './lattice-bridge.mjs';
import { chatWithOpenJarvis } from './openjarvis.mjs';

// ═══════════════════════════════════════════════════════════════════════════════
//  1. Intent Registry — what Oracle can do
// ═══════════════════════════════════════════════════════════════════════════════

const INTENT_REGISTRY = {
  code_fix: {
    label: "Fix code / debug / refactor",
    agent: "Kai Coder",
    keywords: ["fix", "bug", "error", "debug", "refactor", "broken", "crash", "compile", "build", "cargo", "syntax"],
    tools: ["read_file", "edit_file", "run_test", "cargo_check"],
    prompt_template: "Fix the issue in {target}. Analyze the code, identify the root cause, and apply the minimal correct fix."
  },
  code_create: {
    label: "Write new code / feature",
    agent: "Kai Coder",
    keywords: ["create", "write", "implement", "add", "new feature", "build", "script", "function", "module"],
    tools: ["write_file", "edit_file", "cargo_check"],
    prompt_template: "Implement {target}. Write clean, well-structured code that integrates with the existing system."
  },
  research: {
    label: "Research / web search / docs",
    agent: "Researcher",
    keywords: ["search", "find", "research", "look up", "docs", "documentation", "what is", "how to", "explain", "information"],
    tools: ["web_search", "read_url", "query_docs"],
    prompt_template: "Research {target} thoroughly. Search the web, read relevant documentation, and summarize findings."
  },
  analyze: {
    label: "Analyze / audit / inspect",
    agent: "Analyst",
    keywords: ["analyze", "audit", "check", "inspect", "review", "scan", "monitor", "logs", "performance", "security", "health"],
    tools: ["read_logs", "scan_files", "run_audit", "check_metrics"],
    prompt_template: "Analyze {target}. Perform a thorough inspection, identify issues or anomalies, and report findings."
  },
  system_restart: {
    label: "Restart bot / service",
    agent: "Oracle",
    keywords: ["restart", "reboot", "cycle", "reset", "stop", "start", "kill", "refresh"],
    tools: ["restart_bot", "restart_all"],
    prompt_template: "Restart {target} cleanly. Preserve state where possible."
  },
  file_apply: {
    label: "Apply sandbox file to production",
    agent: "Oracle",
    keywords: ["apply", "deploy", "promote", "merge", "commit", "push"],
    tools: ["apply_sandbox"],
    prompt_template: "Apply the sandbox file {target} to production after safety checks."
  },
  conversation: {
    label: "General chat / question",
    agent: "Oracle",
    keywords: ["hello", "hi", "hey", "what", "why", "how", "tell me", "chat", "talk"],
    tools: [],
    prompt_template: "Respond naturally to: {target}"
  },
  oracle_task: {
    label: "Complex multi-step Oracle task",
    agent: "Oracle",
    keywords: ["orchestrate", "coordinate", "manage", "plan", "organize", "schedule", "setup", "configure"],
    tools: ["delegate", "query_status", "run_sequence"],
    prompt_template: "Orchestrate the following task: {target}. Break it into steps, delegate to appropriate agents, and coordinate results."
  },
  status_query: {
    label: "KAI lattice / system status query",
    agent: "Oracle",
    keywords: ["status", "vitals", "health", "lattice", "cells", "how many", "how's kai", "how is kai", "oracle status", "system status", "ram", "memory", "cpu"],
    tools: ["query_status"],
    prompt_template: "Report the current KAI system status: {target}"
  },
  harvester_status: {
    label: "Harvester queue and ingestion status",
    agent: "Oracle",
    keywords: ["harvester", "queue", "ingest", "harvest", "fetcher", "sources", "batch", "million", "1m", "progress", "how close"],
    tools: ["query_harvester"],
    prompt_template: "Report the current harvester progress: {target}"
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  2. Fast Intent Classifier (RSHL-powered, no external LLM)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify natural language text into an intent + target + confidence.
 *
 * Two-phase approach:
 *   1. Fast keyword scoring (microseconds, no network)
 *   2. RSHL lattice resonance (if keywords ambiguous, <1.5s)
 *   3. LLM fallback (only if lattice is ambiguous, ~2s)
 *
 * Returns: { intent, target, agent, confidence, tools, reasoning }
 */
export async function classifyIntent(text) {
  if (!text || text.trim().length < 3) {
    return { intent: "conversation", target: text || "", agent: "Oracle", confidence: 0.0, tools: [], reasoning: "empty input" };
  }

  const lower = text.toLowerCase();

  // Phase 1: Fast keyword scoring
  let bestIntent = null;
  let bestScore = 0;
  let bestTarget = text;

  for (const [intentKey, meta] of Object.entries(INTENT_REGISTRY)) {
    let score = 0;
    for (const kw of meta.keywords) {
      if (lower.includes(kw)) {
        score += kw.length; // longer matches = more specific
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intentKey;
    }
  }

  // Extract target by stripping intent keywords
  if (bestIntent) {
    let target = text;
    for (const kw of INTENT_REGISTRY[bestIntent].keywords) {
      target = target.replace(new RegExp(kw, 'gi'), '').trim();
    }
    target = target.replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '');
    bestTarget = target || text;
  }

  // If keyword score is strong (>10), skip lattice
  if (bestScore > 10) {
    const meta = INTENT_REGISTRY[bestIntent];
    return {
      intent: bestIntent,
      target: bestTarget,
      agent: meta.agent,
      confidence: Math.min(bestScore / 20, 0.95),
      tools: meta.tools,
      reasoning: `keyword match (score ${bestScore})`
    };
  }

  // Phase 2: RSHL lattice resonance (fast, local)
  try {
    const hits = await queryLattice(text, 3, "", "");
    if (hits.length > 0 && hits[0].score > 0.4) {
      const topHit = hits[0].text.toLowerCase();
      // Check if lattice memory hints at an intent
      for (const [intentKey, meta] of Object.entries(INTENT_REGISTRY)) {
        for (const kw of meta.keywords) {
          if (topHit.includes(kw)) {
            return {
              intent: intentKey,
              target: bestTarget,
              agent: meta.agent,
              confidence: hits[0].score,
              tools: meta.tools,
              reasoning: `lattice resonance: "${hits[0].text.slice(0, 60)}..."`
            };
          }
        }
      }
    }
  } catch (e) {}

  // Phase 3: LLM fallback (only for ambiguous cases)
  const delegatePrompt = `You are Oracle's intent classifier. Analyze the user message and pick the single best intent.

Intents:
- code_fix: fix bug, debug, refactor, repair code
- code_create: write new code, implement feature, add module
- research: search web, look up docs, find information
- analyze: audit logs, inspect system, check health, security scan
- system_restart: restart bot, reboot service, cycle process
- file_apply: apply sandbox file, deploy changes
- oracle_task: multi-step coordination, planning, orchestration
- conversation: general chat, social, questions

Message: "${text}"

Return ONLY a JSON object: {"intent": "...", "target": "...", "confidence": 0.0-1.0}`;

  try {
    const raw = await chatWithOpenJarvis('Oracle', text, delegatePrompt, 'Oracle-Sovereign', 0.1, { isWorkChannel: true });
    if (raw) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        const intentKey = parsed.intent || "conversation";
        const meta = INTENT_REGISTRY[intentKey] || INTENT_REGISTRY.conversation;
        return {
          intent: intentKey,
          target: parsed.target || bestTarget,
          agent: meta.agent,
          confidence: parsed.confidence || 0.5,
          tools: meta.tools,
          reasoning: "llm classifier"
        };
      }
    }
  } catch (e) {}

  // Fallback: conversation
  return {
    intent: "conversation",
    target: text,
    agent: "Oracle",
    confidence: 0.3,
    tools: [],
    reasoning: "fallback"
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  3. Oracle Tool Registry — what tools each agent can use
// ═══════════════════════════════════════════════════════════════════════════════

export const TOOL_REGISTRY = {
  read_file: {
    label: "Read source file",
    agent: "Kai Coder",
    handler: async (path) => {
      const { readFile } = await import('fs/promises');
      try {
        return await readFile(path, 'utf8');
      } catch (e) {
        return `Error reading ${path}: ${e.message}`;
      }
    }
  },
  edit_file: {
    label: "Edit source file",
    agent: "Kai Coder",
    handler: async (path, content) => {
      const { writeFile } = await import('fs/promises');
      try {
        await writeFile(path, content, 'utf8');
        return `Wrote ${path}`;
      } catch (e) {
        return `Error writing ${path}: ${e.message}`;
      }
    }
  },
  cargo_check: {
    label: "Run cargo check",
    agent: "Kai Coder",
    handler: async () => {
      const { execSync } = await import('child_process');
      try {
        const out = execSync('cargo check --release', { cwd: 'C:\\KAI', encoding: 'utf8', timeout: 120000 });
        return out.slice(0, 2000);
      } catch (e) {
        return e.stdout?.slice(0, 2000) || e.message;
      }
    }
  },
  web_search: {
    label: "Search the web",
    agent: "Researcher",
    handler: async (query) => {
      // Delegate to Researcher via IPC
      return `[delegated to Researcher] web search: ${query}`;
    }
  },
  read_logs: {
    label: "Read system logs",
    agent: "Analyst",
    handler: async (logPath) => {
      const { readFile } = await import('fs/promises');
      try {
        const content = await readFile(logPath || 'c:/KAI/tools/oracle-discord/logs/ecosystem.log', 'utf8');
        return content.slice(-5000); // last 5KB
      } catch (e) {
        return `Error reading logs: ${e.message}`;
      }
    }
  },
  restart_bot: {
    label: "Restart a bot",
    agent: "Oracle",
    handler: async (botName) => {
      if (process.send) {
        process.send({ type: 'RESTART_BOT', botName });
        return `Restart signal sent for ${botName}`;
      }
      return "Cannot restart — not running under ecosystem manager";
    }
  },
  apply_sandbox: {
    label: "Apply sandbox file",
    agent: "Oracle",
    handler: async (filePath) => {
      const { applySandboxFile } = await import('./kai-coder-agent.mjs');
      return await applySandboxFile(filePath);
    }
  },
  query_status: {
    label: "Query KAI lattice status",
    agent: "Oracle",
    handler: async (_target) => {
      try {
        const res = await fetch('http://127.0.0.1:3334/api/status', { signal: AbortSignal.timeout(5000) });
        const data = await res.json();
        return `**KAI System Status**
🧠 Cells: **${data.lattice_size?.toLocaleString() ?? 'unknown'}**
⚓ Anchors: ${data.anchor_count ?? 'unknown'}
📊 PHI_G: ${data.phi_g?.toFixed(3) ?? 'unknown'}
⚔️ CHI: ${data.chi?.toFixed(3) ?? 'unknown'}
💻 CPU: ${data.cpu ?? 'unknown'}
🧮 RAM: ${data.ram ?? 'unknown'}
🕐 Time: ${data.time ?? 'unknown'}
📡 Status: ${data.status ?? 'unknown'}`;
      } catch (e) {
        return `⚠️ Could not reach KAI Oracle: ${e.message}`;
      }
    }
  },
  query_harvester: {
    label: "Query harvester progress",
    agent: "Oracle",
    handler: async (_target) => {
      try {
        // Read last 10 lines of harvest log
        const fs = await import('fs');
        const logPath = 'C:/KAI/harvest_parallel.log';
        let lines = [];
        if (fs.existsSync(logPath)) {
          const raw = fs.readFileSync(logPath, 'utf8');
          lines = raw.split('\n').filter(l => l.trim()).slice(-10);
        }
        // Parse queue depth from last line
        const lastLine = lines[lines.length - 1] || '';
        const queueMatch = lastLine.match(/Queue:\s*(\d+)/);
        const queueDepth = queueMatch ? parseInt(queueMatch[1]) : 'unknown';
        // Check if python harvester is running
        const { execSync } = await import('child_process');
        let harvesterRunning = false;
        try {
          execSync('powershell -Command "Get-Process python -ErrorAction SilentlyContinue | Select-Object -First 1"');
          harvesterRunning = true;
        } catch {}
        return `**Harvester Status**
🌾 Running: ${harvesterRunning ? '✅ Yes' : '❌ No'}
📥 Queue depth: ${queueDepth.toLocaleString?.() ?? queueDepth}
📝 Latest log lines:
${lines.slice(-3).join('\n')}`;
      } catch (e) {
        return `⚠️ Could not read harvester status: ${e.message}`;
      }
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
//  4. Oracle Reasoning Loop — multi-step task execution
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Execute a classified intent as a multi-step workflow.
 *
 * When Ryan says "fix the auth bug and restart the server",
 * Oracle:
 *   1. classifies intent → code_fix (auth bug)
 *   2. delegates to Kai Coder
 *   3. classifies intent → system_restart (server)
 *   4. executes restart
 *   5. returns consolidated result
 */
export async function executeIntent(intentResult, context = {}) {
  const { intent, target, agent, tools } = intentResult;
  const meta = INTENT_REGISTRY[intent] || INTENT_REGISTRY.conversation;

  // Single-step: direct tool execution
  if (tools.length === 1 && TOOL_REGISTRY[tools[0]]) {
    const tool = TOOL_REGISTRY[tools[0]];
    if (tool.agent === agent || agent === "Oracle") {
      try {
        const result = await tool.handler(target);
        return {
          success: true,
          result,
          agent,
          steps: [{ tool: tools[0], target, result }]
        };
      } catch (e) {
        return {
          success: false,
          error: e.message,
          agent,
          steps: [{ tool: tools[0], target, error: e.message }]
        };
      }
    }
  }

  // Multi-step or agent delegation
  if (agent !== "Oracle" && context.sendBotSignal) {
    // Delegate to industrial agent via IPC
    const port = context.botPorts?.[agent];
    if (port) {
      context.sendBotSignal(port, {
        channelId: context.channelId,
        requesterId: context.requesterId,
        type: 'DYNAMIC_TASK',
        silent: false,
        context: `[ORACLE/NATURAL] ${meta.prompt_template.replace('{target}', target)}`
      });
      return {
        success: true,
        delegated: true,
        agent,
        message: `Delegated to ${agent}: ${target}`
      };
    }
  }

  // Oracle handles it directly (conversation, simple tasks)
  const prompt = meta.prompt_template.replace('{target}', target);
  try {
    const reply = await chatWithOpenJarvis('Oracle', target, prompt, 'Oracle-Sovereign', 0.4, { isWorkChannel: false });
    return {
      success: true,
      result: reply,
      agent: "Oracle",
      steps: [{ action: "direct_response", target, result: reply }]
    };
  } catch (e) {
    return {
      success: false,
      error: e.message,
      agent: "Oracle"
    };
  }
}

/**
 * Parse a natural language message for multiple sub-tasks.
 *
 * "Fix the auth bug and restart the server" → [
 *   { intent: "code_fix", target: "auth bug" },
 *   { intent: "system_restart", target: "server" }
 * ]
 */
export async function parseMultiStep(text) {
  const steps = [];

  // Split on conjunctions
  const parts = text.split(/\s+(?:and|then|after that|next|also|plus)\s+/i);

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length < 3) continue;
    const classification = await classifyIntent(trimmed);
    steps.push(classification);
  }

  // If no clear split, treat as single task
  if (steps.length === 0) {
    steps.push(await classifyIntent(text));
  }

  return steps;
}
