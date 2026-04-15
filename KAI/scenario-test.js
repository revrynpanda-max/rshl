const { RSHLLattice } = require("./rshl-lattice");
const fs = require("fs");

async function scenarioTest() {
  console.log("🚀 STARTING RSHL SCENARIO TEST\n");

  const memFile = "active-memory.json";
  if (fs.existsSync(memFile)) fs.unlinkSync(memFile);

  const lattice = new RSHLLattice({ userName: "Ryan" });

  // --- PHASE 1: STORING SPECIFIC KNOWLEDGE ---
  console.log("📝 Phase 1: Storing specific project knowledge...");
  
  // Rule 1: Architecture
  lattice.store("The team decided that we will use Vitest for all unit testing in the KAI project.");
  
  // Rule 2: User Preference
  lattice.store("I prefer using dark mode with a Neon Cyan accent color for the UI.");

  // Rule 3: A random fact
  lattice.store("The server backend is located in the Frankfurt region to minimize latency for European users.");

  console.log("✅ Knowledge stored. Saving to disk...\n");
  lattice.save(memFile);

  // --- PHASE 2: PERSISTENCE CHECK ---
  console.log("💾 Phase 2: Simulating a brand new session (loading from disk)...");
  const newLattice = new RSHLLattice({ userName: "Ryan" });
  newLattice.load(memFile);
  console.log("✅ Session loaded.\n");

  // --- PHASE 3: ASSOCIATIVE RECALL (The 'Magic' Part) ---
  console.log("🧠 Phase 3: Testing Associative Recall (Semantic Matching)");

  const queries = [
    { q: "How are we testing the code?", target: "Vitest" },
    { q: "Tell me about my UI preferences.", target: "Neon Cyan" },
    { q: "Where is the cloud server hosted?", target: "Frankfurt" }
  ];

  for (const { q, target } of queries) {
    console.log(`\nQuery: "${q}"`);
    const results = newLattice.recall(q, 1);
    
    if (results.length > 0) {
      const match = results[0];
      console.log(`Found: "${match.text}"`);
      console.log(`Resonance Score: ${match.score} (Similarity: ${match.sim})`);
      
      if (match.text.includes(target)) {
        console.log(`✨ SUCCESS: Perfectly recalled the "${target}" context!`);
      } else {
        console.log(`❌ FAILURE: Did not find the expected context.`);
      }
    } else {
      console.log("❌ No memories found.");
    }
  }

  // CLEANUP
  console.log("\n--- TEST COMPLETE ---");
  // fs.unlinkSync(memFile); // Keep it so the user can see it if they want
}

scenarioTest().catch(console.error);
