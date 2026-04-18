const { RSHLLattice } = require("./rshl-lattice");
const fs = require("fs");
const path = require("path");

async function test() {
  console.log("--- RSHL Integration Test ---");

  const memFile = "test-memory.json";
  if (fs.existsSync(memFile)) fs.unlinkSync(memFile);

  const lattice = new RSHLLattice({ userName: "Tester" });

  console.log("Storing memory...");
  lattice.store("The AI assistant now supports RSHL memory integration.");
  lattice.save(memFile);

  console.log("Verifying persistence...");
  const lattice2 = new RSHLLattice({ userName: "Tester" });
  lattice2.load(memFile);

  const results = lattice2.recall("what does the assistant support?");
  console.log("Recall Results:", JSON.stringify(results, null, 2));

  if (results.length > 0 && results[0].text.includes("RSHL memory integration")) {
    console.log("SUCCESS: RSHL persistence and recall work!");
  } else {
    console.log("FAILURE: RSHL recall failed.");
    process.exit(1);
  }

  // Cleanup
  fs.unlinkSync(memFile);
}

test().catch(err => {
  console.error(err);
  process.exit(1);
});
