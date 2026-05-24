/**
 * kai-subagent-pool.mjs — Parallel Sub-Agent Execution Engine
 *
 * Lets Kai Coder spawn multiple sub-agents to work in parallel —
 * reading files, researching, generating code segments simultaneously.
 *
 * KEY DESIGN DECISIONS:
 *   - Sub-agents use Groq API (lock-free, no GPU) so they NEVER contend
 *     with the main Kai Coder agent running on the local Ollama GPU.
 *   - Concurrency is dynamically capped based on system CPU load so the
 *     machine stays stable. High load → fewer concurrent agents.
 *   - Each sub-agent is a focused, single-responsibility task.
 *   - The pool aggregates all results and returns them in order.
 *
 * REALISTIC LIMITS:
 *   - Groq free tier: ~30 req/min, ~6000 tokens/min
 *   - This pool caps at 8 concurrent by default, adjustable.
 *   - "Hundreds" of agents would burn through rate limits in seconds —
 *     so we queue intelligently and process in waves.
 */

import { callGroqDirect } from './openjarvis.mjs';
import os from 'os';

// ── Sub-Agent Identity ─────────────────────────────────────────────────────────
// Sub-agents are lightweight Groq instances — fast, lock-free, disposable.
// They use small fast models for analysis tasks, larger for generation.

const SUB_AGENT_MODELS = {
  fast: 'llama-3.1-8b-instant',      // Analysis, file reading summaries
  smart: 'llama-3.3-70b-versatile',  // Code generation, complex reasoning
  default: 'llama-3.1-8b-instant'
};

// ── Concurrency Controller ─────────────────────────────────────────────────────

function getSystemLoad() {
  // Returns 0.0-1.0 representing current CPU pressure
  const load = os.loadavg()[0]; // 1-min average
  const cpus = os.cpus().length;
  return Math.min(load / cpus, 1.0);
}

function getDynamicConcurrency(baseMax = 8) {
  const load = getSystemLoad();
  if (load > 0.85) return Math.max(2, Math.floor(baseMax * 0.25)); // Heavy load: 2 agents
  if (load > 0.65) return Math.max(3, Math.floor(baseMax * 0.5));  // Medium: half
  if (load > 0.40) return Math.floor(baseMax * 0.75);              // Light-medium: 75%
  return baseMax;                                                    // Idle: full throttle
}

// ── Sub-Agent Pool Class ───────────────────────────────────────────────────────

export class KaiSubAgentPool {
  constructor(maxConcurrent = 8) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.waitQueue = [];
    this.completedCount = 0;
    this.failedCount = 0;
  }

  // Acquire a slot — waits if at capacity
  async _acquire() {
    const effective = getDynamicConcurrency(this.maxConcurrent);
    if (this.running < effective) {
      this.running++;
      return;
    }
    await new Promise(resolve => this.waitQueue.push(resolve));
    this.running++;
  }

  // Release a slot — unblocks the next waiter
  _release() {
    this.running--;
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      next();
    }
  }

  /**
   * Run a single sub-agent task.
   * @param {object} task
   * @param {string} task.prompt     - The sub-agent's input
   * @param {string} [task.system]   - System prompt for this sub-agent
   * @param {string} [task.model]    - 'fast' | 'smart' | explicit model name
   * @param {number} [task.maxTokens] - Max output tokens (default 1000)
   * @param {string} [task.id]       - Optional label for logging
   * @returns {Promise<string|null>}
   */
  async runOne(task) {
    await this._acquire();
    const model = SUB_AGENT_MODELS[task.model] || task.model || SUB_AGENT_MODELS.default;
    const label = task.id || 'sub-agent';
    const maxTokens = task.maxTokens || 1000;
    const system = task.system || 'You are a focused sub-agent in the KAI RSHL ecosystem. Complete your assigned task precisely and return only the requested output.';

    console.log(`[SubAgent/${label}] Starting (model=${model}, concurrent=${this.running}/${getDynamicConcurrency(this.maxConcurrent)})`);
    const start = Date.now();

    try {
      const result = await callGroqDirect('Kai Coder', task.prompt, system, model, maxTokens);
      const elapsed = Date.now() - start;
      if (result) {
        console.log(`[SubAgent/${label}] Done in ${elapsed}ms (${result.length} chars).`);
        this.completedCount++;
        return result;
      }
      this.failedCount++;
      return null;
    } catch (e) {
      console.warn(`[SubAgent/${label}] Failed: ${e.message}`);
      this.failedCount++;
      return null;
    } finally {
      this._release();
    }
  }

  /**
   * Run multiple tasks in parallel, respecting concurrency limits.
   * Results are returned in the same order as the input tasks.
   *
   * @param {object[]} tasks - Array of task objects (see runOne)
   * @param {function} [onProgress] - Called with (completedCount, totalCount) after each task
   * @returns {Promise<(string|null)[]>}
   */
  async runAll(tasks, onProgress = null) {
    if (!tasks || tasks.length === 0) return [];
    console.log(`[SubAgentPool] Dispatching ${tasks.length} sub-agents. Max concurrent: ${getDynamicConcurrency(this.maxConcurrent)}.`);
    const total = tasks.length;
    let done = 0;

    const promises = tasks.map(async (task, idx) => {
      const result = await this.runOne({ ...task, id: task.id || `task-${idx}` });
      done++;
      if (onProgress) onProgress(done, total);
      return result;
    });

    return await Promise.all(promises);
  }

  getStats() {
    return {
      running: this.running,
      queued: this.waitQueue.length,
      completed: this.completedCount,
      failed: this.failedCount,
      systemLoad: Math.round(getSystemLoad() * 100) + '%',
      effectiveConcurrency: getDynamicConcurrency(this.maxConcurrent)
    };
  }
}

// ── Pre-built sub-agent task templates ────────────────────────────────────────
// These are the most common sub-agent patterns used by Kai Coder.

/**
 * Analyze a set of files in parallel.
 * Returns summaries of what each file does and what's relevant to the task.
 */
export async function parallelFileAnalysis(filePaths, taskDescription, fileContents = {}) {
  const pool = new KaiSubAgentPool(8);
  const tasks = filePaths.map(fp => ({
    id: `analyze:${fp.split('/').pop()}`,
    model: 'fast',
    maxTokens: 600,
    system: 'You are a code analyst sub-agent. Read the file and identify what is relevant to the given task. Be concise — 3-5 bullet points max.',
    prompt: `TASK: ${taskDescription}\n\nFILE: ${fp}\n\nCONTENT:\n${(fileContents[fp] || '(not loaded)').slice(0, 3000)}\n\nWhat in this file is relevant to the task? What would need to change?`
  }));

  const results = await pool.runAll(tasks);
  return filePaths.reduce((acc, fp, i) => {
    acc[fp] = results[i] || null;
    return acc;
  }, {});
}

/**
 * Research multiple topics in parallel.
 * Each topic gets its own sub-agent focused on that specific question.
 */
export async function parallelResearch(topics, baseContext = '') {
  const pool = new KaiSubAgentPool(6);
  const tasks = topics.map((topic, i) => ({
    id: `research:${i}`,
    model: 'smart',
    maxTokens: 1500,
    system: 'You are a research sub-agent in the KAI RSHL ecosystem. Answer the specific question with technical precision. Cite patterns, best practices, and concrete implementation details.',
    prompt: baseContext
      ? `CONTEXT: ${baseContext}\n\nRESEARCH QUESTION: ${topic}`
      : `RESEARCH QUESTION: ${topic}`
  }));

  const results = await pool.runAll(tasks);
  return topics.map((topic, i) => ({ topic, findings: results[i] || null }));
}

/**
 * Generate code for multiple files/functions in parallel.
 * Each sub-agent focuses on one file or function.
 */
export async function parallelCodeGeneration(segments, fullContext = '') {
  const pool = new KaiSubAgentPool(4); // Fewer for code gen — output is larger
  const tasks = segments.map((seg, i) => ({
    id: `codegen:${seg.file || i}`,
    model: 'smart',
    maxTokens: 3000,
    system: `You are a senior engineer sub-agent. Generate production-quality code for the specified file/function.
RSHL = Recursive Sparse Hyperdimensional Lattice. The codebase uses Node.js ESM (.mjs), Rust, and Discord.js v14.
Output the complete file content in this format:
// FILE: path/to/file.ext
\`\`\`javascript
<full file content>
\`\`\``,
    prompt: fullContext
      ? `FULL CONTEXT:\n${fullContext}\n\nYOUR TASK: Generate ${seg.description} for file: ${seg.file}`
      : `Generate ${seg.description} for file: ${seg.file}`
  }));

  const results = await pool.runAll(tasks);
  return segments.map((seg, i) => ({ file: seg.file, code: results[i] || null }));
}
