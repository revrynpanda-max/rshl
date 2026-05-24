import fetch from 'node-fetch';
import { logAudit } from './audit-log.mjs';

const serviceHealth = new Map(); // serviceName -> { up, failures, lastAttempt }

function setServiceHealth(name, up) {
  const entry = serviceHealth.get(name) || { up: true, failures: 0 };
  entry.failures = up ? 0 : entry.failures + 1;
  entry.up = up;
  entry.lastAttempt = Date.now();
  serviceHealth.set(name, entry);
}

export function isServiceHealthy(name) {
  const entry = serviceHealth.get(name);
  if (!entry) return true; // unknown = assumed healthy
  if (entry.failures >= 3) return false; // circuit opens after 3 consecutive failures
  return entry.up;
}

/**
 * Performs a fetch with retry logic, timeout, and circuit‑breaker awareness.
 *
 * @param {string} url          - Target URL
 * @param {object} [options={}] - node-fetch options
 * @param {object} [opts={}]    - Additional configuration
 * @param {number} [opts.retries=3]       - Max retries after the first attempt
 * @param {number} [opts.baseDelay=1000]  - Base exponential backoff delay (ms)
 * @param {number} [opts.timeout=5000]    - Per‑request timeout (ms)
 * @param {string} [opts.serviceName='unknown'] - Logical service name for health tracking
 * @param {AbortSignal|null} [opts.signal=null] - External abort signal to combine
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}, {
  retries = 3,
  baseDelay = 1000,
  timeout = 5000,
  serviceName = 'unknown',
  signal = null,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Circuit‑breaker: fast reject before any I/O
    if (!isServiceHealthy(serviceName)) {
      throw new Error(`Service "${serviceName}" is offline (circuit open after 3 consecutive failures).`);
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      const mergedSignal = signal
        ? combineSignals(signal, controller.signal)
        : controller.signal;

      const response = await fetch(url, { ...options, signal: mergedSignal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      // Success – reset health
      setServiceHealth(serviceName, true);
      return response;
    } catch (err) {
      lastError = err;
      clearTimeout(); // safety
      setServiceHealth(serviceName, false);

      const delay = baseDelay * Math.pow(2, attempt) + (Math.random() * 200);
      logAudit('fetch_retry', {
        url,
        attempt: attempt + 1,
        retriesLeft: retries - attempt,
        serviceName,
        error: err.message,
      });

      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // All retries exhausted
  console.error(`[HTTP/CRITICAL] ${serviceName} fetch failed after ${retries + 1} attempts: ${lastError.message}`);
  throw lastError;
}

function combineSignals(...signals) {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) { controller.abort(); break; }
    s.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}
