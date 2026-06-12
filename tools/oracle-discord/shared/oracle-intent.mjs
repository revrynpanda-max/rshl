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
import fs from 'fs';
import { buildKnowledgeContext, isKaiTopic } from './codex.mjs';
import {
  canOracleDelegateTo,
  hasExplicitWorkIntent,
  isCasualConversation,
  INDUSTRIAL_WORKERS,
} from './fleet-registry.mjs';
import { getResilienceBrief } from './resilience-status.mjs';
import {
  getIntentHints,
  recordOracleLearning,
  recordIntentPattern,
  hydrateConvoMemory,
  persistConvoMemory,
} from './conversation-learning.mjs';

// ── ORACLE WORKING MEMORY ───────────────────────────────────────────────────
// Oracle was stateless: every reply forgot the entire conversation ("input
// alive, output, memory dead"). Now he keeps a rolling per-user transcript
// (last 14 turns, 2h freshness) and feeds it into every conversational reply.
const CONVO_MEMORY = new Map(); // requesterId -> [{who, text, ts}]
hydrateConvoMemory(CONVO_MEMORY);

export function rememberTurn(requesterId, who, text) {
  if (!requesterId || !text) return;
  const buf = CONVO_MEMORY.get(requesterId) || [];
  buf.push({ who, text: String(text).slice(0, 500), ts: Date.now() });
  while (buf.length > 14) buf.shift();
  CONVO_MEMORY.set(requesterId, buf);
  persistConvoMemory(CONVO_MEMORY);
}
function recallConversation(requesterId) {
  const buf = (CONVO_MEMORY.get(requesterId) || []).filter(t => Date.now() - t.ts < 2 * 3600_000);
  return buf.map(t => `${t.who}: ${t.text}`).join('\n');
}
function lastOracleReply(requesterId) {
  const buf = (CONVO_MEMORY.get(requesterId) || []).filter(t => Date.now() - t.ts < 2 * 3600_000);
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].who === 'Oracle') return buf[i].text;
  }
  return '';
}

export { isCasualConversation, hasExplicitWorkIntent };

// ── LIVE SYSTEM AWARENESS ───────────────────────────────────────────────────
// Cheap file reads (no HTTP): governor tier, fleet roster, KAI's memory and
// school report. Injected into every conversational reply so Oracle answers
// "what's going on with the server" with FACTS instead of vibes.
function liveSystemBrief() {
  const parts = [];
  try {
    const wc = JSON.parse(fs.readFileSync('c:/KAI/tools/oracle-discord/state/world-clock.json', 'utf8'));
    if (wc.updatedAt) parts.push(`World tick #${wc.tickSeq ?? '?'} @ ${wc.updatedAt}`);
  } catch (_) {}
  try {
    const s = JSON.parse(fs.readFileSync('c:/KAI/tools/oracle-discord/state/self_optimize_state.json', 'utf8'));
    parts.push(`Governor: tier=${s.tier}, drift=${s.project?.drift}, KAI footprint=${s.project?.memoryMB}MB`);
  } catch (_) {}
  try {
    const m = JSON.parse(fs.readFileSync('c:/KAI/tools/oracle-discord/state/ecosystem-manager.json', 'utf8'));
    const up = (m.children || []).filter(c => c.pid && !c.sleeping).map(c => c.name);
    const asleep = (m.children || []).filter(c => c.sleeping).map(c => c.name);
    const ageS = Math.round((Date.now() - new Date(m.updatedAt).getTime()) / 1000);
    parts.push(`Fleet (as of ${ageS}s ago): ONLINE=[${up.join(', ')}]${asleep.length ? ` ASLEEP=[${asleep.join(', ')}]` : ''}`);
    parts.push(`Workers ONLY: Oracle, KAI, Researcher, Analyst, Kai Coder. Social plaza: Leo, Gemini, Claudey, Groq, X.`);
    if (ageS > 120) parts.push(`⚠ Manager state is ${ageS}s stale — the ecosystem manager may be down.`);
  } catch (_) { parts.push('⚠ Ecosystem manager state unreadable.'); }
  try {
    const h = JSON.parse(fs.readFileSync('c:/KAI/data/hippocampus_status.json', 'utf8'));
    parts.push(`KAI memory: ${h.patterns} short-term patterns, ${h.pending_consolidations} queued, ${h.promoted_total} promoted to Universe`);
  } catch (_) {}
  try {
    const c = JSON.parse(fs.readFileSync('c:/KAI/data/pipeline_curriculum.json', 'utf8'));
    parts.push(`Training: level ${c.level}, ${c.total_passed}/${c.total_tests} sections passed, recent quizzes=[${(c.recent_scores || []).slice(-4).map(x => Math.round(x)).join(', ')}]`);
  } catch (_) {}
  const resilience = getResilienceBrief();
  if (resilience) parts.push(resilience);
  return parts.join('\n');
}

const ORACLE_COMMAND_POWERS = `[YOUR REAL COMMAND POWERS — these exact phrases from Ryan trigger REAL actions through your deterministic handlers. If Ryan asks for one of these, tell him the exact phrase (or confirm it's already happening):]
- "restart <botname>" — surgical single-bot restart
- "wake <botname>" / "sleep <botname>" / "wake up all" / "quiet mode"
- "restart the whole show" (also: restart the entire server/everything) — FULL infrastructure reboot: engine, backends, fleet
- "stop the whole system" — total shutdown (everything dies, including you)
- "leo voices" — list Leo's voices | "set leo's voice to <name>" — change + auto-restart Leo
- "!teach <bot> <rule>" / "!role <bot> <persona>" / "!prune <bot>"
Never claim you cannot restart or control the system — you CAN, via the phrases above.`;

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
    keywords: ["search for", "look up", "research", "documentation", "find information", "web search"],
    tools: ["web_search", "read_url", "query_docs"],
    prompt_template: "Research {target} thoroughly. Search the web, read relevant documentation, and summarize findings."
  },
  analyze: {
    label: "Analyze / audit / inspect",
    agent: "Analyst",
    keywords: ["analyze", "audit", "inspect", "review", "scan logs", "monitor", "performance audit", "security scan"],
    tools: ["read_logs", "scan_files", "run_audit", "check_metrics"],
    prompt_template: "Analyze {target}. Perform a thorough inspection, identify issues or anomalies, and report findings."
  },
  system_restart: {
    label: "Restart bot / service",
    agent: "Oracle",
    keywords: ["restart", "reboot", "cycle", "reset bot", "refresh bot"],
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
    keywords: ["hello", "hi", "hey", "chat", "talk", "what's on your mind"],
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
export async function classifyIntent(text, requesterId = '') {
  if (!text || text.trim().length < 3) {
    return { intent: "conversation", target: text || "", agent: "Oracle", confidence: 0.0, tools: [], reasoning: "empty input" };
  }

  if (isCasualConversation(text)) {
    return {
      intent: "conversation",
      target: text,
      agent: "Oracle",
      confidence: 0.95,
      tools: [],
      reasoning: "casual conversation — no delegation",
    };
  }

  // Phase 0: Learn from past Ryan↔Oracle intent patterns (same user)
  if (requesterId) {
    const hints = getIntentHints(requesterId, text, 2);
    if (hints.length > 0 && hints[0].overlap >= 2 && hints[0].confidence > 0.4) {
      const meta = INTENT_REGISTRY[hints[0].intent] || INTENT_REGISTRY.conversation;
      if (hints[0].intent === 'conversation' || hasExplicitWorkIntent(text)) {
        return {
          intent: hints[0].intent,
          target: text,
          agent: meta.agent,
          confidence: Math.min(0.85, (hints[0].confidence || 0.5) + 0.1),
          tools: meta.tools,
          reasoning: `intent memory: prior ${hints[0].intent} (${hints[0].overlap} keyword overlap)`,
        };
      }
    }
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
    let intent = bestIntent;
    let agent = meta.agent;
    // Never delegate social bots; research/analyze need explicit work intent
    if (!INDUSTRIAL_WORKERS.has(agent)) {
      intent = 'conversation';
      agent = 'Oracle';
    } else if ((intent === 'research' || intent === 'analyze') && !hasExplicitWorkIntent(text)) {
      intent = 'conversation';
      agent = 'Oracle';
    } else if (intent === 'system_restart' && !/\b(restart|reboot|wake|sleep|stop the whole|cycle)\b/i.test(lower)) {
      intent = 'conversation';
      agent = 'Oracle';
    }
    return {
      intent,
      target: bestTarget,
      agent,
      confidence: Math.min(bestScore / 20, 0.95),
      tools: intent === bestIntent ? meta.tools : [],
      reasoning: intent === bestIntent ? `keyword match (score ${bestScore})` : `demoted from ${bestIntent} — not explicit work`,
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

  // Even action commands enter working memory, so follow-up conversation
  // ("did that work?", "yes please") has context.
  if (intent !== 'conversation') {
    rememberTurn(context.requesterId, 'Ryan', `[command: ${intent}] ${target}`);
  }

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

  // Multi-step or agent delegation — industrial workers only, explicit tasks only
  if (agent !== "Oracle" && context.sendBotSignal && canOracleDelegateTo(agent)) {
    const shouldDelegate = hasExplicitWorkIntent(target) || (intentResult.confidence >= 0.65 && ['research', 'analyze', 'code_fix', 'code_create'].includes(intent));
    if (shouldDelegate) {
      const port = context.botPorts?.[agent];
      if (port) {
        context.sendBotSignal(port, {
          channelId: context.channelId,
          requesterId: context.requesterId,
          type: 'DYNAMIC_TASK',
          silent: false,
          originAgent: 'Oracle',
          workflowId: context.workflowId,
          context: `[ORACLE/NATURAL] ${meta.prompt_template.replace('{target}', target)}`
        });
        recordIntentPattern(context.requesterId, target, intentResult).catch(() => {});
        return {
          success: true,
          delegated: true,
          agent,
          message: `Delegated to ${agent}: ${target}`
        };
      }
    }
  }

  // Oracle handles it directly (conversation, simple tasks) — WITH memory,
  // live system state, command awareness, and Codex/lattice grounding.
  const prompt = meta.prompt_template.replace('{target}', target);
  const memory = recallConversation(context.requesterId);
  const prevOracle = lastOracleReply(context.requesterId);
  let grounding = '';
  try {
    if (isKaiTopic(target)) grounding = (await buildKnowledgeContext(target, 1800)) || '';
  } catch (_) {}

  const isChat = intent === 'conversation' || isCasualConversation(target);
  const systemBlock = isChat
    ? `[MODE: CONVERSATION — Ryan is talking with you like a person, NOT assigning work unless he explicitly asks you to DO something (fix code, restart a bot, research a topic, audit logs).
- Match his energy: gaming venting, jokes, "hey you okay?", opinions = talk back naturally like a friend who runs the fleet.
- Do NOT open with "You know I'm always ready for a chat" or "How can I assist you today?" — vary your tone and answer what he actually said.
- Do NOT dump system health, drift, footprint, or tier unless he asks about the system/KAI/fleet.
- Workers are ONLY: Oracle, KAI, Researcher, Analyst, Kai Coder. Leo/Groq/Gemini/Claudey/X are SOCIAL bots in plaza chat — never delegate tasks to them.
- If he states fleet facts ("only X are workers"), acknowledge and remember — do not spawn Researcher tasks.
- Game rage / hyperbole ("kill everyone" about Overwatch) is NOT a restart command.
- Keep replies concise unless he asks for detail.
- You learn from every turn: patterns go to KAI's lattice so future replies get sharper. Use conversation history — if Ryan clarified workers vs social bots, honor that forever in this session.]`
    : `[MODE: TASK — Ryan issued a work request. Be precise and action-oriented.]`;

  const fullSystem = `${prompt}

${systemBlock}

[IDENTITY] You are ORACLE — sovereign coordinator of the KAI kaiverse. You remember this conversation. Ryan controls the system through you when he asks; otherwise you're just present with him.

[LIVE SYSTEM STATE — use ONLY when Ryan asks about status/health/fleet; otherwise ignore]
${liveSystemBrief() || '(state files unavailable)'}

${ORACLE_COMMAND_POWERS}

[CONVERSATION SO FAR — remember and use this context]
${memory || '(first message of this conversation)'}
${prevOracle ? `\n[ANTI-REPEAT: your last reply was "${prevOracle.slice(0, 120)}..." — do NOT repeat that opener or phrasing.]` : ''}
${grounding ? `\n[GROUNDED KNOWLEDGE]\n${grounding}` : ''}`;

  try {
    const reply = await chatWithOpenJarvis('Oracle', target, fullSystem, 'Oracle-Sovereign', 0.4, { isWorkChannel: false });
    rememberTurn(context.requesterId, 'Ryan', target);
    rememberTurn(context.requesterId, 'Oracle', reply || '(no reply)');
    recordOracleLearning({
      requesterId: context.requesterId,
      userText: target,
      intentResult,
      oracleReply: reply,
      channelId: context.channelId,
    }).catch(() => {});
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
export async function parseMultiStep(text, requesterId = '') {
  if (isCasualConversation(text)) {
    return [await classifyIntent(text, requesterId)];
  }

  const steps = [];

  // Split on conjunctions
  const parts = text.split(/\s+(?:and|then|after that|next|also|plus)\s+/i);

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length < 3) continue;
    const classification = await classifyIntent(trimmed, requesterId);
    steps.push(classification);
  }

  // If no clear split, treat as single task
  if (steps.length === 0) {
    steps.push(await classifyIntent(text, requesterId));
  }

  return steps;
}
