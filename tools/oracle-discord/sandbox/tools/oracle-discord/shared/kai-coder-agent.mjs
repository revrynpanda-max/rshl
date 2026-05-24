/**
 * kai-coder-agent.mjs — Sovereign Coding Agent
 * Part of the KAI RSHL ecosystem.
 *
 * Implements the core coding loop: tool server health, task execution,
 * LLM chat, and lattice integration. All network calls now go through
 * the resilient HTTP client with retry + circuit breaker.
 */

import { fetchWithRetry, isServiceHealthy } from './http-client.mjs';
import { logAudit } from './audit-log.mjs';
import { queryLattice } from './lattice-bridge.mjs';

// ── CONFIGURATION ───────────────────────────────────────────────────────────
const TOOL_SERVER_URL   = 'http://127.0.0.1:3420';
const OPENJARVIS_URL    = 'http://127.0.0.1:8080';
const OLLAMA_URL        = 'http://127.0.0.1:11434';
const LATTICE_URL       = 'http://127.0.0.1:3333';

// ── HEALTH CHECK ────────────────────────────────────────────────────────────
export async function isToolServerOnline() {
  try {
    const res = await fetchWithRetry(`${TOOL_SERVER_URL}/health`, {
      method: 'GET',
    }, {
      serviceName: 'toolserver',
      timeout: 2000,
      retries: 1,
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureToolServer() {
  if (!isServiceHealthy('toolserver')) {
    throw new Error('Tool server is currently offline after repeated failures.');
  }
  return true;
}

// ── EXECUTE CODING TASK ─────────────────────────────────────────────────────
export async function runCodingTask(taskDescription, context = {}) {
  await ensureToolServer();
  const url = `${TOOL_SERVER_URL}/execute`;

  try {
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: taskDescription, context }),
    }, {
      serviceName: 'toolserver',
      timeout: 30000, // long timeout for long‑running tasks
      retries: 2,
    });
    return await res.json();
  } catch (err) {
    logAudit('kai_coder_task_error', { taskDescription, error: err.message });
    // Emit anomaly to lattice
    try {
      await queryLattice({
        type: 'metric',
        source: 'kai-coder',
        metric: 'task_failure',
        value: 1,
        service: 'toolserver',
        error: err.message,
      });
    } catch (_) {}
    throw err;
  }
}

// ── APPLY SANDBOX FILE ──────────────────────────────────────────────────────
export async function applySandboxFile(filePath, content) {
  await ensureToolServer();
  const url = `${TOOL_SERVER_URL}/apply-file`;

  try {
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content }),
    }, {
      serviceName: 'toolserver',
      timeout: 10000,
      retries: 1,
    });
    return await res.json();
  } catch (err) {
    logAudit('kai_coder_apply_error', { filePath, error: err.message });
    try {
      await queryLattice({
        type: 'metric',
        source: 'kai-coder',
        metric: 'apply_failure',
        value: 1,
        service: 'toolserver',
        file: filePath,
        error: err.message,
      });
    } catch (_) {}
    throw err;
  }
}

// ── LLM CALLER (via OpenJarvis or Ollama) ────────────────────────────────────
export async function makeLLMCaller(prompt, model = 'kai-coder-Sovereign', options = {}) {
  // Try OpenJarvis first, fall back to Ollama
  const maxRetries = 2;
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // OpenJarvis
    try {
      const url = `${OPENJARVIS_URL}/v1/chat/completions`;
      const res = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: options.systemPrompt || 'You are Kai Coder, an AI coding agent.' },
            { role: 'user', content: prompt },
          ],
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 2048,
        }),
      }, {
        serviceName: 'openjarvis',
        timeout: 15000,
        retries: 1,
      });
      const data = await res.json();
      if (data.choices && data.choices.length > 0) {
        return data.choices[0].message.content;
      }
      throw new Error('OpenJarvis returned empty choices');
    } catch (err) {
      lastError = err;
      logAudit('llm_openjarvis_error', { prompt, error: err.message, attempt });

      // Fallback to Ollama
      try {
        const url = `${OLLAMA_URL}/api/generate`;
        const res = await fetchWithRetry(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt,
            stream: false,
            options: { temperature: options.temperature ?? 0.2 },
          }),
        }, {
          serviceName: 'ollama',
          timeout: 20000,
          retries: 1,
        });
        const data = await res.json();
        if (data.response) return data.response;
      } catch (fallbackErr) {
        lastError = fallbackErr;
        logAudit('llm_ollama_error', { prompt, error: fallbackErr.message, attempt });
      }
    }

    // If both failed, wait and retry (with backoff)
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  // All attempts exhausted
  console.error(`[LLM/CRITICAL] All LLM sources failed for prompt. Last error: ${lastError.message}`);
  try {
    await queryLattice({
      type: 'metric',
      source: 'kai-coder',
      metric: 'llm_failure',
      value: 1,
      service: 'llm',
      error: lastError.message,
    });
  } catch (_) {}
  throw lastError;
}

// ── LATTICE QUERY (with resilience) ─────────────────────────────────────────
export async function queryLatticeResilient(data) {
  try {
    const res = await fetchWithRetry(`${LATTICE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }, {
      serviceName: 'lattice',
      timeout: 5000,
      retries: 2,
    });
    return await res.json();
  } catch (err) {
    logAudit('lattice_query_error', { data, error: err.message });
    // Non‑critical – return null
    return null;
  }
}
