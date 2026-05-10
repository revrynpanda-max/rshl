/**
 * rshl-context.mjs — DEPRECATED
 *
 * This approach (hardcoding RSHL facts into prompts) was wrong.
 *
 * RSHL knowledge lives IN THE LATTICE — not in any prompt.
 * The whitepaper has been ingested via scripts/ingest-whitepaper.mjs.
 * All bots query the lattice via shared/lattice-bridge.mjs.
 *
 * DO NOT import or use this file. Use lattice-bridge.mjs instead.
 *   import { queryLattice } from './lattice-bridge.mjs';
 *
 * Corrections:
 *   RSHL = Recursive Sparse Hyperdimensional Lattice (NOT "Ryan's Sovereign Heuristic Lattice")
 *   KAI  = Knowledge Associative Intelligence
 */

// No-op exports so old imports don't crash
export function getRshlContext() { return ''; }
export const RSHL_GLOSSARY = '';
export const RSHL_SHORT = '';
