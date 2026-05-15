/**
 * lattice-bridge.mjs — RSHL Lattice Query/Store Interface
 *
 * The RSHL (Recursive Sparse Hyperdimensional Lattice) is the memory system
 * the entire KAI ecosystem runs on. Knowledge lives HERE — not in prompts.
 *
 * All bots use this module to:
 *   - queryLattice(question, limit) — retrieve relevant memories
 *   - storeLattice(text, source, strength, region) — store new facts
 *
 * The lattice runs at http://127.0.0.1:3333 (the KAI RSHL engine in Rust).
 * If it's not running, these functions return empty results gracefully.
 */

const LATTICE_URL = process.env.ORACLE_API_URL || "http://127.0.0.1:3334";
const LATTICE_TIMEOUT_MS = 4000;

/**
 * Query the RSHL lattice for relevant memories.
 *
 * @param {string} question - Natural language query
 * @param {number} limit - Max results to return (default 5)
 * @param {string} region - Optional region filter
 * @param {string} userId - Optional user identity filter
 * @returns {Array<{text: string, similarity: number, confidence: number}>}
 */
export async function queryLattice(question, limit = 5, region = "", userId = "") {
  if (!question || question.trim().length < 3) return [];

  try {
    const res = await fetch(`${LATTICE_URL}/api/rshl/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        query: question.trim(), 
        limit,
        region: region || undefined,
        user_id: userId || undefined
      }),
      signal: AbortSignal.timeout(LATTICE_TIMEOUT_MS)
    });

    if (!res.ok) return [];
    const hits = await res.json();
    return Array.isArray(hits) ? hits : [];
  } catch (e) {
    return [];
  }
}

/**
 * Store a fact into the RSHL lattice.
 *
 * @param {string} text - The claim or fact to store
 * @param {string} source - Where this came from
 * @param {number} strength - Confidence 0.5 to 5.0
 * @param {string} region - Lattice region
 * @param {string} userId - User identity for cellularization
 * @returns {boolean} success
 */
export async function storeLattice(text, source = 'oracle', strength = 2.0, region = 'general', userId = "") {
  if (!text || text.trim().length < 5) return false;

  try {
    const res = await fetch(`${LATTICE_URL}/api/rshl/store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.trim(),
        source,
        strength,
        region,
        user_id: userId || undefined
      }),
      signal: AbortSignal.timeout(LATTICE_TIMEOUT_MS)
    });

    return res.ok;
  } catch (e) {
    return false;
  }
}

/**
 * Quick lattice health check.
 * @returns {boolean}
 */
export async function isLatticeOnline() {
  try {
    const res = await fetch(`${LATTICE_URL}/api/status`, {
      signal: AbortSignal.timeout(2000)
    });
    return res.ok;
  } catch {
    return false;
  }
}
