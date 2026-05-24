import { queryLattice, storeLattice } from './shared/lattice-bridge.mjs';
import { getPerformanceTier } from './shared/resource-saver.mjs';

async function runIdentityBenchmark() {
    console.log("--- KAI RSHL Identity Precision & Performance Benchmark ---");

    // 1. Hardware Performance Check
    const perf = await getPerformanceTier();
    console.log(`\n[Performance Status] Tier: ${perf.tier}, CPU: ${perf.cpuLoad}%, GPU: ${perf.gpuLoad}%`);

    // 2. Multi-User Knowledge Injection
    const userA = "User_Ryan";
    const userB = "User_Naster";

    console.log("\n[Test 1] Injecting User-Specific Memories...");
    
    // Fact for Ryan
    await storeLattice(
        "Ryan prefers the lattice to run in 'Silent Mode' during late-night coding sessions.",
        "Ryan-Private",
        5.0,
        "identity",
        userA
    );

    // Fact for Naster
    await storeLattice(
        "Naster enjoys the Sovereign Radio when it plays high-tempo synthwave during gaming.",
        "Naster-Private",
        5.0,
        "identity",
        userB
    );

    console.log("-> Memories anchored. Running cross-retrieval benchmarks...");

    // 3. Precision Recall Benchmark
    const startTime = Date.now();
    
    // Querying as Ryan
    console.log("\n[Recall Test: Ryan]");
    const ryanHits = await queryLattice("What are my preferences?", 3, userA);
    ryanHits.forEach(h => console.log(`- (Score: ${h.score.toFixed(3)}) ${h.text}`));
    
    // Querying as Naster
    console.log("\n[Recall Test: Naster]");
    const nasterHits = await queryLattice("What do I enjoy?", 3, userB);
    nasterHits.forEach(h => console.log(`- (Score: ${h.score.toFixed(3)}) ${h.text}`));

    const endTime = Date.now();
    const latency = (endTime - startTime) / 2; // Avg latency per query
    console.log(`\n[Benchmark Results] Avg Lattice Latency: ${latency.toFixed(2)}ms`);

    // 4. Isolation Check
    const ryanFoundNasterInfo = ryanHits.some(h => h.text.includes("synthwave"));
    const nasterFoundRyanInfo = nasterHits.some(h => h.text.includes("Silent Mode"));

    if (!ryanFoundNasterInfo && !nasterFoundRyanInfo) {
        console.log("-> SUCCESS: 100% Identity Isolation. Users cannot 'see' each other's lattice regions.");
    } else {
        console.log("-> FAILURE: Identity bleed detected.");
    }

    if (latency < 200) {
        console.log(`-> SUCCESS: Performance is nominal (${latency.toFixed(2)}ms) under ${perf.tier} mode.`);
    }
}

runIdentityBenchmark().catch(console.error);
