/**
 * BridgeError — structured error type for lattice service failures.
 */
export class BridgeError extends Error {
  constructor(code, cause) {
    super(`${code}: ${cause?.message || 'Unknown bridge error'}`);
    this.name = 'BridgeError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * In-memory failure tracker for circuit-breaking.
 */
const failureCount = new Map();
let circuitOpen = false;
let circuitTimer = null;
const FAILURE_THRESHOLD = 3;
const CIRCUIT_RESET_MS = 30000;

function recordBridgeFailure(service, err) {
  const count = (failureCount.get(service) || 0) + 1;
  failureCount.set(service, count);
  if (count >= FAILURE_THRESHOLD) {
    circuitOpen = true;
    if (!circuitTimer) {
      circuitTimer = setTimeout(() => {
        circuitOpen = false;
        failureCount.clear();
        circuitTimer = null;
      }, CIRCUIT_RESET_MS);
    }
  }
  // Optionally notify parent process
  if (process.send && typeof process.send === 'function') {
    try {
      process.send({ type: 'bridge_failure', service, error: err.message, timestamp: Date.now() });
    } catch (_) {}
  }
}

/**
 * Query the RSHL lattice engine with stream-safe fetch and circuit breaker.
 *
 * @param {Object} payload - JSON payload for the lattice endpoint.
 * @param {Object} [options]
 * @param {number} [options.timeout=5000] - Request timeout in ms.
 * @returns {Promise<Object>} Parsed JSON response.
 */
export async function queryLattice(payload, options = {}) {
  if (circuitOpen) {
    throw new BridgeError(
      'LATTICE_CIRCUIT_OPEN',
      new Error('Circuit breaker is open, request not dispatched')
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout ?? 5000);

  try {
    const res = await fetch('http://localhost:3333/lattice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = res.body;
    if (!body) throw new Error('No response body stream');

    let data = '';
    await new Promise((resolve, reject) => {
      body.on('data', chunk => { data += chunk; });
      body.on('error', err => reject(new Error(`Stream error: ${err.message}`)));
      body.on('end', resolve);
    });

    // On success, reset failure count for this service and potentially close circuit
    failureCount.delete('lattice');
    if (circuitOpen) {
      circuitOpen = false;
      if (circuitTimer) {
        clearTimeout(circuitTimer);
        circuitTimer = null;
      }
    }

    return JSON.parse(data);
  } catch (err) {
    recordBridgeFailure('lattice', err);
    throw new BridgeError('LATTICE_OFFLINE', err);
  } finally {
    clearTimeout(timeout);
  }
}
