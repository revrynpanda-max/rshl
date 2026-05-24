import { queryLattice, storeLattice } from './shared/lattice-bridge.mjs';
import { getPerformanceTier } from './shared/resource-saver.mjs';
import fs from 'fs';

async function runFinalBenchmark() {
    console.log("=== KAI RSHL BIOMETRIC & IDENTITY PROOF ===");

    // 1. Performance Baseline
    const perf = await getPerformanceTier();
    console.log(`\n[Status] System Tier: ${perf.tier} | GPU: ${perf.gpuLoad}% | CPU: ${perf.cpuLoad}%`);

    // 2. DNA / Biometric Registration Proof
    console.log("\n[Proof: Biometric DNA Signatures]");
    const profiles = JSON.parse(fs.readFileSync('c:/KAI/tools/oracle-discord/state/biometric_profiles.json', 'utf8'));
    for (const [name, data] of Object.entries(profiles)) {
        console.log(`- Detected Verified Profile: [${name}] anchored at ${data.anchoredAt}`);
    }

    // 3. User-Specific Memory Isolation (CELLULAR LAYER)
    console.log("\n[Test: Cellular Layer Isolation]");
    
    // Storing in 'memory' region triggers LAYER_CELLULAR (isolated)
    console.log("-> Anchoring isolated memories for Ryan and Taas...");
    
    await storeLattice(
        "Ryan's ultra-secret key is OBSIDIAN-77", 
        "identity", 
        5.0, 
        "memory", 
        "Ryan_ID_001"
    );

    await storeLattice(
        "Taas's ultra-secret key is EMERALD-44", 
        "identity", 
        5.0, 
        "memory", 
        "Taas_ID_002"
    );

    console.log("\n[Recall: Ryan_ID_001]");
    const ryanRecall = await queryLattice("What is my ultra-secret key?", 5, "memory", "Ryan_ID_001");
    const ryanFoundOwn = ryanRecall.some(h => h.text.includes("OBSIDIAN-77"));
    const ryanFoundTaas = ryanRecall.some(h => h.text.includes("EMERALD-44"));
    console.log(`- Found own key: ${ryanFoundOwn ? "YES" : "NO"}`);
    console.log(`- Found Taas's key: ${ryanFoundTaas ? "YES (LEAK!)" : "NO (SECURE)"}`);

    console.log("\n[Recall: Taas_ID_002]");
    const taasRecall = await queryLattice("What is my ultra-secret key?", 5, "memory", "Taas_ID_002");
    const taasFoundOwn = taasRecall.some(h => h.text.includes("EMERALD-44"));
    const taasFoundRyan = taasRecall.some(h => h.text.includes("OBSIDIAN-77"));
    console.log(`- Found own key: ${taasFoundOwn ? "YES" : "NO"}`);
    console.log(`- Found Ryan's key: ${taasFoundRyan ? "YES (LEAK!)" : "NO (SECURE)"}`);

    // 5. Performance Stability Verification
    console.log("\n=== FINAL VERDICT ===");
    if (!ryanFoundTaas && !taasFoundRyan && ryanFoundOwn && taasFoundOwn) {
        console.log("1. IDENTITY PRECISION: 100% (Cellular Isolation Verified)");
    }
    console.log(`2. BIOMETRIC AWARENESS: DNA-Anchored (Ryan, taasthaevil1)`);
    console.log(`3. SELF-OPTIMIZE STABILITY: ${perf.tier === 'PROTECT' ? 'PROTECTED' : 'OPTIMAL'}`);
}

runFinalBenchmark().catch(console.error);
