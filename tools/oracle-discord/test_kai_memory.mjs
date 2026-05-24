import { chatWithOpenJarvis } from './shared/openjarvis.mjs';
import { queryLattice } from './shared/lattice-bridge.mjs';

async function testKAIMemory() {
    console.log("--- Testing KAI Memory (Lattice to Bot Bridge) ---");
    
    const question = "When was the Sovereign Radio DJ code optimized?";
    console.log("\n[Interviewer]: " + question);

    // 1. Manually check if the lattice returns the hit (like the bot does)
    const hits = await queryLattice(question, 5);
    console.log("\n[Lattice Hits]: " + (hits.length > 0 ? hits[0].text : "No hits found"));

    if (hits.length === 0) {
        console.log("CRITICAL: Lattice returned no hits for the test question.");
        return;
    }

    // 2. Call the KAI Bot logic (which should include these hits)
    const kaiSys = `You are KAI — Knowledge Associative Intelligence, running on the RSHL (Recursive Sparse Hyperdimensional Lattice). 
[LATTICE MEMORY]
${hits.map((h, i) => `${i+1}. ${h.text}`).join('\n')}

Respond with structural clarity. Use the lattice memory provided above to answer.`;

    const reply = await chatWithOpenJarvis("KAI", question, kaiSys, "Oracle-Sovereign", 0.5);
    
    if (reply) {
        console.log("\n[KAI Bot]: " + reply);
    } else {
        console.log("\n[System]: KAI Bot failed to respond.");
    }
}

testKAIMemory();
