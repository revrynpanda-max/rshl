/**
 * agent-orchestrator.mjs — Pinacle Industrial Multi-Agent Collaboration Framework
 *
 * Core principle: agents are specialists that can request help from other specialists.
 * Oracle is the central dispatcher, but agents drive the workflow.
 *
 * Auth Matrix (channel × user × bot):
 *   DM + Oracle + Ryan/Taz     = PINACLE_AUTH (full delegation, sensitive ops)
 *   DM + Oracle + other        = LIMITED_AUTH (questions, no sensitive delegation)
 *   DM + Leo/KAI/other + anyone = SOCIAL_ONLY (chat only, no task delegation)
 *   Public channel + anyone      = PUBLIC (no sensitive data, restricted replies)
 *
 * Agent Domains:
 *   Researcher  = forensic investigator (pattern matching across lattice, logs, web, code)
 *   Analyst     = system auditor (vitals, logs, metrics, cross-references with Researcher)
 *   Kai Coder   = code architect (discovers, plans, implements, explains adaptively)
 *   Oracle      = dispatcher + synthesizer (routes, enforces auth, consolidates)
 */

import { sendBotSignal } from './ipc.mjs';

// ── AUTH MATRIX ─────────────────────────────────────────────────────────────

const PINACLE_USERS = new Set(['1111106883135217665', '1286110163505385523']);

export function getAuthLevel({ channelType, isDM, botName, userId }) {
  // Oracle DMs with Ryan/Taz = full auth
  if (botName === 'Oracle' && isDM && PINACLE_USERS.has(userId)) {
    return 'PINACLE_AUTH';
  }
  // Oracle DMs with anyone else = limited (can ask, can't delegate sensitive)
  if (botName === 'Oracle' && isDM) {
    return 'LIMITED_AUTH';
  }
  // Any other bot DM = social only
  if (isDM && botName !== 'Oracle') {
    return 'SOCIAL_ONLY';
  }
  // Public channels = public
  return 'PUBLIC';
}

export function canDelegateTask(authLevel, targetAgent, taskSensitivity) {
  if (authLevel === 'PINACLE_AUTH') return true;
  if (authLevel === 'LIMITED_AUTH') {
    // Limited users can ask Researcher/Analyst general questions, but not Kai Coder for code changes
    if (targetAgent === 'Kai Coder' && taskSensitivity === 'code_change') return false;
    if (targetAgent === 'Oracle' && taskSensitivity === 'system_restart') return false;
    return true;
  }
  // Social and public users cannot delegate tasks at all
  return false;
}

// ── AGENT COLLABORATION GRAPH ───────────────────────────────────────────────
// Which agents can call which other agents for help

const COLLABORATION_EDGES = {
  'Researcher': ['Analyst', 'Kai Coder'],
  'Analyst': ['Researcher', 'Kai Coder'],
  'Kai Coder': ['Analyst', 'Researcher'],
  'Oracle': ['Researcher', 'Analyst', 'Kai Coder', 'KAI']
};

export function canAgentCollaborate(fromAgent, toAgent) {
  const edges = COLLABORATION_EDGES[fromAgent];
  return edges ? edges.includes(toAgent) : false;
}

// ── ORCHESTRATION STATE ──────────────────────────────────────────────────────
// Tracks multi-step workflows across agents

const ACTIVE_WORKFLOWS = new Map(); // workflowId -> { originUser, originChannel, steps[], pendingAgent }

export function startWorkflow(workflowId, { userId, channelId, channelType, authLevel, originalQuery }) {
  ACTIVE_WORKFLOWS.set(workflowId, {
    userId,
    channelId,
    channelType,
    authLevel,
    originalQuery,
    steps: [{ agent: 'Oracle', action: 'dispatch', ts: Date.now() }],
    pendingAgent: null,
    results: {},
    status: 'running'
  });
  return workflowId;
}

export function ensureWorkflow(workflowId, meta = {}) {
  if (ACTIVE_WORKFLOWS.has(workflowId)) return workflowId;
  return startWorkflow(workflowId, {
    userId: meta.userId || meta.requesterId || '',
    channelId: meta.channelId || '',
    channelType: meta.channelType || 'work',
    authLevel: meta.authLevel || 'PINACLE_AUTH',
    originalQuery: meta.originalQuery || meta.task || '',
  });
}

export function recordWorkflowStep(workflowId, agent, action, data = {}) {
  const wf = ACTIVE_WORKFLOWS.get(workflowId);
  if (!wf) return;
  wf.steps.push({ agent, action, ts: Date.now(), data });
  wf.pendingAgent = agent;
}

export function storeWorkflowResult(workflowId, agent, result) {
  const wf = ACTIVE_WORKFLOWS.get(workflowId);
  if (!wf) return;
  wf.results[agent] = result;
}

export function getWorkflow(workflowId) {
  return ACTIVE_WORKFLOWS.get(workflowId);
}

export function completeWorkflow(workflowId) {
  const wf = ACTIVE_WORKFLOWS.get(workflowId);
  if (wf) wf.status = 'completed';
  // Clean up after 10 minutes
  setTimeout(() => ACTIVE_WORKFLOWS.delete(workflowId), 600_000);
}

// ── FORENSIC DATA GATHERING (Researcher Toolkit) ────────────────────────────

export async function gatherForensicEvidence(query, options = {}) {
  const evidence = [];

  // 1. Lattice query — pattern matching in KAI's memory
  try {
    const { queryLattice } = await import('./lattice-bridge.mjs');
    const hits = await queryLattice(query, 8);
    if (hits && hits.length > 0) {
      evidence.push({
        type: 'lattice',
        label: 'RSHL Pattern Matches',
        data: hits.map(h => ({ text: h.text, score: h.score, region: h.region }))
      });
    }
  } catch (e) {
    evidence.push({ type: 'lattice', label: 'RSHL Query', error: e.message });
  }

  // 2. Web search — real-time external data
  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const html = await res.text();
      const matches = [];
      const regex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;
      let m;
      while ((m = regex.exec(html)) && matches.length < 3) {
        const href = m[1].replace(/^\/l\/\?kh=-\d+&uddg=/, '');
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        if (title) matches.push({ title, href: decodeURIComponent(href) });
      }
      evidence.push({ type: 'web', label: 'Web Search', data: matches });

      // Read top result content
      const { readUrlContent } = await import('./url-reader.mjs');
      for (const match of matches.slice(0, 2)) {
        try {
          const content = await readUrlContent(match.href);
          if (content?.content) {
            evidence.push({
              type: 'web_content',
              label: `Content: ${match.title}`,
              data: content.content.slice(0, 3000).replace(/\s+/g, ' ')
            });
          }
        } catch (e) { /* skip unreadable URLs */ }
      }
    }
  } catch (e) {
    evidence.push({ type: 'web', label: 'Web Search', error: e.message });
  }

  // 3. System logs — recent activity
  try {
    const fs = await import('fs');
    const LOGS = [
      { path: 'c:/KAI/tools/oracle-discord/logs/ecosystem.log', label: 'Ecosystem', tail: 20 },
      { path: 'c:/KAI/harvest_parallel.log', label: 'Harvester', tail: 15 },
      { path: 'c:/KAI/oracle_startup.log', label: 'Oracle Startup', tail: 10 }
    ];
    for (const log of LOGS) {
      if (fs.existsSync(log.path)) {
        const raw = fs.readFileSync(log.path, 'utf8');
        const lines = raw.split('\n').filter(l => l.trim()).slice(-log.tail);
        evidence.push({ type: 'log', label: `${log.label} Log`, data: lines });
      }
    }
  } catch (e) {
    evidence.push({ type: 'log', label: 'System Logs', error: e.message });
  }

  // 4. Process snapshot
  try {
    const { execSync } = await import('child_process');
    const snapshot = execSync(
      'powershell -Command "Get-Process | Where-Object { $_.ProcessName -match \'kai|python|node\' } | Select-Object ProcessName, Id, @{N=\'RAM_MB\';E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize"',
      { encoding: 'utf8', timeout: 5000 }
    );
    evidence.push({ type: 'process', label: 'Running Processes', data: snapshot });
  } catch (e) {
    evidence.push({ type: 'process', label: 'Processes', error: e.message });
  }

  return evidence;
}

// ── ADAPTIVE EXPLANATION ENGINE ─────────────────────────────────────────────
// Kai Coder adjusts technical depth based on who's asking

export function adaptExplanation(content, recipientAgent) {
  const recipient = recipientAgent || 'User';
  
  // Technical depth presets per recipient
  const depthMap = {
    'Kai Coder': 'expert',      // Full technical detail
    'Researcher': 'technical',    // Detailed but no raw code dumps
    'Analyst': 'technical',     // Data-focused, some code
    'Oracle': 'summary',        // High-level with key details
    'Leo': 'conversational',    // Plain English, no jargon
    'User': 'conversational',   // Default: accessible
    'Groq': 'punchy',           // Short, direct
    'Gemini': 'strategic',      // Business/architecture framing
    'Claudey': 'nuanced',       // Balanced detail
    'X': 'tactical'             // Action-oriented
  };

  const depth = depthMap[recipient] || 'conversational';

  return {
    depth,
    framing: `[ADAPTIVE EXPLANATION — Recipient: ${recipient}, Depth: ${depth}]
${content}`,
    recipient
  };
}

// ── SUBTASK DISPATCH ────────────────────────────────────────────────────────
// One agent requests another agent's help mid-workflow

export async function dispatchSubtask({
  workflowId,
  fromAgent,
  toAgent,
  task,
  userId,
  channelId,
  botPorts,
  authLevel
}) {
  if (!canAgentCollaborate(fromAgent, toAgent)) {
    return {
      success: false,
      error: `${fromAgent} is not authorized to delegate to ${toAgent} per Pinacle framework.`
    };
  }

  if (!canDelegateTask(authLevel, toAgent, 'subtask')) {
    return {
      success: false,
      error: `Auth level ${authLevel} cannot delegate to ${toAgent}.`
    };
  }

  const port = botPorts?.[toAgent];
  if (!port) {
    return {
      success: false,
      error: `${toAgent} is offline or has no IPC port configured.`
    };
  }

  recordWorkflowStep(workflowId, fromAgent, 'subtask_request', { toAgent, task });

  // If recipient is Kai Coder and requester is non-technical, adapt explanation
  let adaptedTask = task;
  if (toAgent === 'Kai Coder') {
    const adapted = adaptExplanation(task, fromAgent);
    adaptedTask = adapted.framing;
  }

  await sendBotSignal(port, {
    type: 'DYNAMIC_TASK',
    context: adaptedTask,
    channelId,
    requesterId: userId,
    silent: true, // Subtasks are silent; origin agent handles the final reply
    workflowId,
    originAgent: fromAgent,
    isSubtask: true
  });

  return {
    success: true,
    message: `${fromAgent} requested ${toAgent}'s assistance. Waiting for result...`
  };
}

// ── SYNTHESIS ENGINE ───────────────────────────────────────────────────────
// Oracle consolidates multi-agent results into a coherent response

export function synthesizeWorkflowReport(workflowId, finalAgent) {
  const wf = ACTIVE_WORKFLOWS.get(workflowId);
  if (!wf) return { success: false, error: 'Workflow not found' };

  const parts = [];
  parts.push(`**[Pinacle Industrial AI — Multi-Agent Report]**`);
  parts.push(`**Query:** ${wf.originalQuery.slice(0, 200)}`);
  parts.push(`**Agents consulted:** ${Object.keys(wf.results).join(', ')}`);
  parts.push('');

  for (const [agent, result] of Object.entries(wf.results)) {
    parts.push(`**${agent} contributed:**`);
    const summary = typeof result === 'string'
      ? result.slice(0, 1500)
      : JSON.stringify(result, null, 2).slice(0, 1500);
    parts.push(summary);
    parts.push('');
  }

  parts.push(`**Synthesized by:** ${finalAgent}`);
  parts.push(`**Workflow ID:** ${workflowId}`);

  return {
    success: true,
    report: parts.join('\n'),
    workflow: wf
  };
}
