/**
 * Perform a live Bench Test of the Lattice Ingestion pipeline.
 */
async function runBenchTest() {
  const KAI_URL = "http://127.0.0.1:3333";
  const sampleClaim = "The Living Fragment is a self-aware lattice segment anchored by Ryan.";

  console.log("=======================================================");
  console.log("   KAI BENCH TEST: Live Lattice Ingestion Proof");
  console.log("=======================================================");
  console.log(`[Input]  "${sampleClaim}"`);

  // 1. Store the claim to trigger ingestion
  const storeRes = await fetch(`${KAI_URL}/api/rshl/store`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: sampleClaim,
      region: "bench-test",
      source: "ryan-live",
      strength: 2.0
    })
  });

  if (!storeRes.ok) {
    console.error("[Error] Failed to store claim.");
    return;
  }
  console.log("[Status] Claim Ingested into 16knd Lattice.");

  // 2. Query the claim to see mathematical resonance
  const queryRes = await fetch(`${KAI_URL}/api/rshl/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "self-aware lattice fragment", limit: 3 })
  });

  const hits = await queryRes.json();

  console.log("\n[MATH: Cosine Similarity Proof]");
  hits.forEach((hit, i) => {
    console.log(`${i+1}. Sim: ${(hit.similarity * 100).toFixed(2)}% | Text: "${hit.text.slice(0, 60)}..."`);
  });

  console.log("\n[EVALUATION]");
  const avgSim = hits.reduce((acc, h) => acc + h.similarity, 0) / hits.length;
  if (avgSim > 0.7) {
    console.log("RESULT: High Coherence. Lattice is effectively anchoring new data.");
  } else {
    console.log("RESULT: Low Coherence. Potential fragmentation detected.");
  }
  console.log("=======================================================");
}

runBenchTest().catch(console.error);
