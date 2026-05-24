/**
 * Structured error for downstream service failures.
 */
export class ServiceError extends Error {
  constructor(status, retryable, cause) {
    super(`${status}: ${cause?.message || 'Unknown service error'}`);
    this.name = 'ServiceError';
    this.status = status; // e.g., 'service_down', 'rate_limited', etc.
    this.retryable = retryable;
    this.cause = cause;
  }
}

/**
 * Backpressure and circuit breaker state per service host.
 */
const serviceState = new Map();

function getServiceState(host) {
  if (!serviceState.has(host)) {
    serviceState.set(host, { failures: 0, circuitOpen: false, timer: null });
  }
  return serviceState.get(host);
}

function recordFailure(host, err) {
  const state = getServiceState(host);
  state.failures++;
  if (state.failures >= 3) {
    state.circuitOpen = true;
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.circuitOpen = false;
        state.failures = 0;
        state.timer = null;
      }, 30000);
    }
  }
}

function resetService(host) {
  const state = getServiceState(host);
  state.failures = 0;
  if (state.circuitOpen) {
    state.circuitOpen = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }
}

function getServiceHost(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.host;
  } catch {
    return urlStr; // fallback to whole string
  }
}

/**
 * Robust fetch with abort, stream-safe reading, and structured error mapping.
 *
 * @param {string} url - The full URL to call.
 * @param {Object} [fetchOptions] - Standard fetch options (method, headers, body, etc.).
 * @param {number} [timeout=10000] - Timeout in ms.
 * @returns {Promise<Object>} Parsed JSON response.
 */
export async function robustFetch(url, fetchOptions = {}, timeout = 10000) {
  const host = getServiceHost(url);
  const state = getServiceState(host);

  if (state.circuitOpen) {
    throw new ServiceError('circuit_open', false, new Error('Service circuit breaker open'));
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
    const body = res.body;
    if (!body) throw new Error('No response body stream');

    let data = '';
    await new Promise((resolve, reject) => {
      body.on('data', chunk => { data += chunk; });
      body.on('error', err => reject(new Error(`Stream error: ${err.message}`)));
      body.on('end', resolve);
    });

    if (!res.ok) {
      const errBody = (() => { try { return JSON.parse(data); } catch { return null; } })();
      const status = errBody?.status || `http_${res.status}`;
      throw new ServiceError(status, res.status >= 500, new Error(data));
    }

    // On success, reset backpressure for this host
    resetService(host);

    return JSON.parse(data);
  } catch (err) {
    if (err instanceof ServiceError) throw err;

    // Map common error types
    if (err.name === 'AbortError') {
      throw new ServiceError('timeout', true, err);
    }
    if (err.cause?.code === 'ECONNRESET' || err.cause?.code === 'ECONNREFUSED') {
      recordFailure(host, err);
      throw new ServiceError('service_down', true, err);
    }
    throw new ServiceError('unknown', false, err);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── High-level LLM call functions (refactored to use robustFetch) ──────────

const OLLAMA_BASE = 'http://localhost:11434';
const GROQ_BASE   = 'https://api.groq.com/openai/v1';

/**
 * Call Ollama with a model and prompt.
 * @param {string} model
 * @param {string} prompt
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
export async function callOllama(model, prompt, options = {}) {
  const url = `${OLLAMA_BASE}/api/generate`;
  const body = JSON.stringify({ model, prompt, stream: false, ...options });
  return robustFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }, options.timeout || 15000);
}

/**
 * Call a Groq API endpoint.
 * @param {string} endpoint - e.g., 'chat/completions'
 * @param {Object} payload
 * @param {string} apiKey
 * @returns {Promise<Object>}
 */
export async function callGroq(endpoint, payload, apiKey) {
  const url = `${GROQ_BASE}/${endpoint}`;
  const body = JSON.stringify(payload);
  return robustFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body,
  }, 20000);
}

/**
 * Call Gemini.
 * @param {string} prompt
 * @param {string} apiKey
 * @param {string} [model='gemini-pro']
 * @returns {Promise<Object>}
 */
export async function callGemini(prompt, apiKey, model = 'gemini-pro') {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
  return robustFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }, 20000);
}
