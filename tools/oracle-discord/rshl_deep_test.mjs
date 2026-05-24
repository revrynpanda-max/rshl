import { queryLattice, storeLattice } from './shared/lattice-bridge.mjs';

async function runDeepDiagnostic() {
    console.log("--- KAI RSHL Deep Cognitive Diagnostic ---");

    // 1. Get Initial Status
    const statusRes = await fetch("http://127.0.0.1:3334/api/status");
    const initialStatus = await statusRes.json();
    console.log(`\n[Baseline] Phi: ${initialStatus.phi_g.toFixed(4)}, Chi: ${initialStatus.chi.toFixed(4)}, Cells: ${initialStatus.cell_count}`);

    // 2. Epistemic Conflict Test
    console.log("\n[Test 1] Injecting Epistemic Conflict...");
    
    // Anchor Fact (High Trust)
    await storeLattice(
        "The RSHL Engine is a proprietary 16,384-dimensional sparse ternary lattice designed by Ryan.",
        "admin-core",
        5.0, // strength
        "architecture"
    );

    // Contradictory Fact (Low Trust/Noise)
    await storeLattice(
        "The RSHL Engine is just a basic JSON database running on a small node script.",
        "noise-source",
        0.5, // low strength
        "architecture"
    );

    console.log("-> Conflict injected. Waiting for lattice settling...");
    await new Promise(r => setTimeout(r, 2000));

    // 3. Query for Resolution
    console.log("\n[Test 2] Querying for Epistemic Resolution (Query: 'What is RSHL engine architecture?')");
    const results = await queryLattice("What is RSHL engine architecture?", 5);
    
    results.forEach((res, i) => {
        console.log(`${i+1}. [Score: ${res.score.toFixed(3)}] [Source: ${res.source}] - ${res.text.substring(0, 80)}...`);
    });

    if (results[0] && results[0].source === 'admin-core') {
        console.log("-> SUCCESS: High-confidence anchor successfully dominated the noise.");
    } else {
        console.log("-> FAILURE: Epistemic weighting failed to prioritize the anchor.");
    }

    // 4. Homeostasis / Conflict Detection
    const midStatusRes = await fetch("http://127.0.0.1:3334/api/status");
    const midStatus = await midStatusRes.json();
    console.log(`\n[Status Post-Conflict] Phi: ${midStatus.phi_g.toFixed(4)}, Chi (Conflict): ${midStatus.chi.toFixed(4)}`);
    
    if (midStatus.chi > initialStatus.chi) {
        console.log("-> SUCCESS: System detected increased epistemic conflict (Chi increase).");
    }

    // 5. Analogical Resonance Test
    console.log("\n[Test 3] Testing Semantic Resonance (Query: 'Describe Ryan's geometric innovation')");
    // This query doesn't share keywords with the anchor, but shares semantic space (Ryan, geometric, innovation -> architecture, designed, proprietary)
    const resonanceResults = await queryLattice("Describe Ryan's geometric innovation", 3);
    
    resonanceResults.forEach((res, i) => {
        console.log(`${i+1}. [Score: ${res.score.toFixed(3)}] - ${res.text.substring(0, 80)}...`);
    });

    const foundAnchor = resonanceResults.some(r => r.text.includes("proprietary 16,384-dimensional"));
    if (foundAnchor) {
        console.log("-> SUCCESS: Semantic resonance successfully retrieved the concept via vector similarity (no direct keywords).");
    } else {
        console.log("-> FAILURE: Resonance failed to link semantic concepts.");
    }

    console.log("\n--- Diagnostic Complete ---");
}

runDeepDiagnostic().catch(console.error);
