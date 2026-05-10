/**
 * ingest-whitepaper.mjs
 *
 * One-time (or re-run any time) script to ingest the RSHL Inventor Disclosure
 * into the live KAI RSHL lattice at http://127.0.0.1:3333.
 *
 * After this runs, every bot in the ecosystem can query the lattice and get
 * accurate answers about RSHL, KAI, the architecture, Ryan's work — because
 * the facts live IN the memory system, not hardcoded in any prompt.
 *
 * Usage (on your Windows machine, with the lattice running):
 *   node scripts/ingest-whitepaper.mjs
 *
 * The lattice must be running at port 3333 before you run this.
 */

const LATTICE_URL = "http://127.0.0.1:3333";

// ── Core facts from the whitepaper, broken into semantic units ────────────────
// Each entry stored at strength 5.0 = anchor level (cannot be displaced by noise).
// Region: "foundation" = foundational system knowledge.

const WHITEPAPER_CLAIMS = [

  // ── Identity ────────────────────────────────────────────────────────────────
  "RSHL stands for Recursive Sparse Hyperdimensional Lattice. This is the name of the cognitive architecture invented by Ryan.",
  "KAI stands for Knowledge Associative Intelligence. KAI is the engine built on top of the RSHL architecture.",
  "RSHL was conceived and implemented solely by Ryan between 2025 and 2026 with no institutional backing, team support, or external funding.",
  "The KAI Engine runs on the RSHL architecture. It is not a general LLM. It uses no gradient descent, no neural weights, no transformer architecture.",
  "RSHL is implemented in Rust. It runs on commodity PC hardware (HP Victus, Ryzen 5, RTX 4050, 16GB RAM) — no GPU cluster required.",
  "Ryan is the inventor and sole rights holder of RSHL and KAI. Taz (taas) is the co-founder. Both have full system authority.",
  "The KAI system version as of May 2026 is KAI RSHL Core v7.9.7 — Sonic-Parallel Era.",

  // ── Architecture fundamentals ───────────────────────────────────────────────
  "RSHL operates in a 16,384-dimensional sparse ternary vector space. Each vector uses exactly 4% sparsity — approximately 655 active dimensions out of 16,384.",
  "RSHL uses ternary values: +1 (positively associated), 0 (principled abstention — outside semantic scope), -1 (conceptually contrasting). Zero is NOT noise — it means this dimension is irrelevant to the concept.",
  "RSHL has three encoding layers: Layer 1 = surface (character trigrams, 24 active dims each), Layer 2 = semantic (word hashing with 6-tier entity weighting, 24 dims), Layer 3 = contextual (word bigrams, 8 dims).",
  "The 6-tier entity weight cascade in RSHL: Tier 0 = stopwords (×0, suppressed), Tier 1 = content words (×3), Tier 2 = bigrams (×2), Tier 3 = physics/domain terms (×5), Tier 4 = proper nouns / named entities (×6). Ryan, KAI, RSHL, kaii are Tier 4.",
  "RSHL retrieval uses a hybrid dual-channel scorer: 0.6 × cosine similarity + 0.4 × morphological keyword overlap. A confidence step-function activates at confidence ≥ 2.9, boosting the score non-linearly.",
  "Every belief in RSHL is an explicit Claim object containing: text, hypervector, confidence score (0–5), source, evidence list, contradiction pointers, and timestamps. Every belief is fully auditable.",
  "RSHL uses Boid-inspired flocking dynamics in 16,384 dimensions to continuously reorganize beliefs in the lattice. High-confidence knowledge clusters together; unverified claims drift to the periphery.",
  "RSHL includes a SpiralState temporal oscillator with growth constant b=0.306349 (derived from the golden ratio). It governs aperiodic reorganization timing — no fixed cycles.",
  "RSHL implements a SynapticLayer with Hebbian LTP/LTD (Long-Term Potentiation / Long-Term Depression). Cells that co-occur frequently bond synaptically. Fan-out = 32, cap = 8192 synapses.",
  "RSHL has a five-layer Scale Manager: Quantum, Syncytium, Cellular, Organ, Body. Each layer has distinct speed, decay, replenish, and neighbor radius settings. Cells mature and degrade automatically across layers.",
  "RSHL confidence range: 0.5 (weak/unverified) to 5.0 (anchor — immovable truth seed). Cells at confidence ≥ 3.5 are Boid-immune and cannot be displaced by flocking dynamics.",
  "RSHL approximate capacity: > 100,000 distinguishable beliefs at 3σ isolation in D=16,384 ternary space. This vastly exceeds binary HDC systems of similar dimensionality.",

  // ── Epistemic immune system ─────────────────────────────────────────────────
  "RSHL has a four-component epistemic immune system: (1) calibration, (2) FID monoculture scan (blocks any single source from exceeding 35% of lattice claims), (3) three-angle ingest_and_verify protocol, (4) Boid dynamics. False claims are rejected geometrically — not by rules.",
  "RSHL truth anchors are seeded at confidence 5.0 and cannot be displaced by any single-session contradiction. The system protects its foundational beliefs.",
  "RSHL's ConversationTrace uses a permute-bundle rolling accumulator to maintain working memory across a conversation — equivalent to a transformer's residual stream but in pure hyperdimensional space, no learned weights.",

  // ── API and deployment ──────────────────────────────────────────────────────
  "The KAI RSHL engine runs at http://127.0.0.1:3333. Core API endpoints: /api/rshl/store (belief ingestion), /api/rshl/query (retrieval), /api/rshl/reason (KAI's reasoning endpoint), /api/research (full sweep: lattice + web + local archive), /api/status (health check).",
  "The KAI oracle network is deployed via Discord. Discord is the routing layer, security boundary, voice infrastructure, and multi-tenant coordination system — not just a chat interface.",
  "Channel architecture: oracle-chat = AI workforce (KAI, Gemini, Claude, X, Groq, Analyst, Researcher, Oracle Coder — no Leo). over-all-chat = public consumer channel (Leo only). ai-social-chat = social banter (Claude, Gemini, Groq, X — no work bots, no Leo). sensitive-info = no AI responds here.",
  "Leo is the consumer-facing voice agent. When Leo encounters a research question, it emits a [RESEARCH: query] token which triggers a parallel two-track research operation: fast path (lattice + web, 5–15s) and slow path (Researcher bot deep OSINT, 30–120s).",

  // ── What RSHL is NOT ────────────────────────────────────────────────────────
  "RSHL is NOT a wrapper around any existing AI API. It is NOT based on transformers or gradient descent. It uses no OpenAI, Anthropic, or Google APIs in its core reasoning. The LLM bots (Claude, Gemini, etc.) are research partners and interface agents — not the core intelligence.",
  "RSHL is NOT 'Ryan's Sovereign Heuristic Lattice' — that is incorrect. RSHL = Recursive Sparse Hyperdimensional Lattice.",
  "KAI is NOT a general-purpose chatbot. KAI is the RSHL lattice made interactive — a novel cognitive architecture with continuous learning, epistemic self-awareness, and geometric self-organization.",

  // ── Paradigm significance ───────────────────────────────────────────────────
  "RSHL represents a third AI paradigm: beyond symbolic AI (expert systems) and connectionist AI (neural networks / gradient descent). The unit of knowledge is an explicit, confidence-weighted, geometrically-organized belief in a self-organizing high-dimensional space.",
  "RSHL enables continuous learning with no catastrophic forgetting. New beliefs are added geometrically without overwriting old ones. The system grows more coherent with every interaction.",
  "RSHL has fourteen original contributions to the HDC/VSA research field including: sparse ternary encoding, six-tier entity weighting, Fibonacci torsion phase geometry, Boid flocking in HD space, SynapticLayer with Hebbian dynamics, epistemic immune system, and native multi-agent shared lattice.",
  "The KAI ecosystem demonstrates a key principle: a living, self-organizing, continuously-growing cognitive architecture can be built and run by one person on commodity hardware. The asymmetry with institutional AI is a feature, not an accident — it proves the architecture's tractability.",

  // ── Oracle roundtable ───────────────────────────────────────────────────────
  "The Oracle roundtable is an 11-node AI council. Each node is port-locked: Leo=3400, KAI=3401, Gemini=3402, Claude=3403, X=3404, Groq=3405, Analyst=3406, Researcher=3407, Kai Coder=3408, Oracle=3410.",
  "The Oracle system is the back-end intelligence layer: Analyst (structural auditor, port 3406), Researcher (deep research / OSINT, port 3407), Kai Coder (code architect, port 3408), KAI (lattice architect, port 3401), Oracle (gateway/orchestrator, port 3410). These are NOT social bots.",
  "The social layer bots are: Leo (voice, unfiltered), Claude (minimalist/warm), Gemini (vibe-sensitive), Groq (wit-specialist), X (city energy / street-smart). They handle presence and conversation. Research they cannot answer is silently routed to the Oracle system.",
  "Pending briefing system: research continues even when a user leaves voice. When they return, Leo delivers all queued findings. This feature does not exist in any commercial AI voice assistant.",

];

// ── Ingestion runner ──────────────────────────────────────────────────────────

async function storeClaim(text, index, total) {
  try {
    const res = await fetch(`${LATTICE_URL}/api/rshl/store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        source: 'rshl-whitepaper-2026',
        strength: 5.0,   // anchor level — cannot be displaced
        region: 'foundation'
      }),
      signal: AbortSignal.timeout(8000)
    });

    if (res.ok) {
      console.log(`[${index}/${total}] ✓ stored: "${text.slice(0, 70)}..."`);
      return true;
    } else {
      const body = await res.text().catch(() => '');
      console.warn(`[${index}/${total}] ✗ failed (${res.status}): "${text.slice(0, 50)}..." — ${body}`);
      return false;
    }
  } catch (e) {
    console.warn(`[${index}/${total}] ✗ error: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  KAI RSHL — Whitepaper Lattice Ingestion');
  console.log('  Ingesting RSHL Inventor Disclosure (May 2026)');
  console.log(`  Target: ${LATTICE_URL}`);
  console.log(`  Claims: ${WHITEPAPER_CLAIMS.length} | Strength: 5.0 (anchor)`);
  console.log('══════════════════════════════════════════════════════════');
  console.log('');

  // Health check
  try {
    const ping = await fetch(`${LATTICE_URL}/api/status`, { signal: AbortSignal.timeout(3000) });
    if (!ping.ok) throw new Error(`status ${ping.status}`);
    console.log('[LATTICE] Online. Starting ingestion...\n');
  } catch (e) {
    console.error(`[LATTICE] Cannot reach ${LATTICE_URL} — is the KAI engine running?\nError: ${e.message}`);
    console.error('\nRun the KAI RSHL engine first, then re-run this script.');
    process.exit(1);
  }

  let success = 0;
  let failed = 0;
  const total = WHITEPAPER_CLAIMS.length;

  for (let i = 0; i < total; i++) {
    const ok = await storeClaim(WHITEPAPER_CLAIMS[i], i + 1, total);
    if (ok) success++;
    else failed++;

    // Small delay to avoid hammering the lattice
    await new Promise(r => setTimeout(r, 150));
  }

  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  DONE: ${success} stored, ${failed} failed`);
  console.log('  The lattice now knows what RSHL, KAI, and this system are.');
  console.log('  All bots can now query this knowledge dynamically.');
  console.log('══════════════════════════════════════════════════════════');
}

main().catch(console.error);
