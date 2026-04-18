/**
 * RSHL basic usage — JavaScript
 *
 * Demonstrates: store memories, recall by resonance, decay over time.
 * Zero dependencies. Run: node examples/basic-js.js
 */

"use strict";

const { textVec, resonance } = require("../rshl-core");

// ── 1. Build a small memory store ─────────────────────────────────────────────
// Each memory is a { key, vec, strength } object.
// In production you'd persist these to disk / SQLite.

const memory = [];

function remember(key, text, strength = 1.0) {
  const vec = textVec(text);
  const existing = memory.find(m => m.key === key);
  if (existing) {
    // Reinforce: increase strength, no re-vectorize (vec is deterministic anyway)
    existing.strength = Math.min(5.0, existing.strength + 0.2);
  } else {
    memory.push({ key, vec, strength });
  }
}

function recall(query, topK = 3) {
  const qv = textVec(query);
  return memory
    .map(m => ({ key: m.key, score: resonance(qv, m.vec), strength: m.strength }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ── 2. Store some memories ─────────────────────────────────────────────────────

remember("api-timeout",   "api connection timeout endpoint failed retry");
remember("board-pass",    "test station board calibration passed all checks");
remember("deploy-done",   "deployment pipeline completed successfully all stages");
remember("mem-error",     "memory allocation error in worker thread process");
remember("config-drift",  "configuration drift detected on node cluster settings");
remember("auth-token",    "authentication token issued user session started");
remember("sensor-range",  "sensor reading out of expected range threshold exceeded");

// ── 3. Recall by query ─────────────────────────────────────────────────────────

const queries = [
  "api error timeout",
  "test board passed",
  "memory problem crash",
];

for (const q of queries) {
  const hits = recall(q, 3);
  console.log(`\nQuery: "${q}"`);
  for (const h of hits) {
    const bar = "█".repeat(Math.round(h.score * 20));
    console.log(`  ${bar.padEnd(20)} ${h.score.toFixed(3)}  ${h.key}`);
  }
}

// ── 4. Show orthogonality — unrelated queries score near 0.5 ──────────────────

console.log("\nOrthogonality check (unrelated text → score near 0.5):");
const unrelated = textVec("banana smoothie recipe blender fruit");
const apiVec    = textVec("api connection timeout endpoint failed retry");
const sim = resonance(apiVec, unrelated);
console.log(`  "api timeout" vs "banana smoothie" → ${sim.toFixed(3)} (ideal: ~0.50)`);
