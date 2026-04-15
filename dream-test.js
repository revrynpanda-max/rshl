"use strict";

const fs = require("fs");
require("./seed");
const { Plasma } = require("./plasma");
const { consolidate } = require("./rshl-lattice");

const kai = new Plasma(false);
const full = [];

console.log("=== DREAM TEST START ===");

for (let i = 0; i < 5; i++) {
    const out = consolidate(kai, {
        goalText: "coherent world understanding with low contradiction and natural intelligence growth"
    });

    console.log(`\n--- DREAM ${i + 1} ---`);

    if (!out) {
        console.log("No viable dream result.");
        full.push({ dream: i + 1, result: null });
        continue;
    }

    full.push({ dream: i + 1, result: out });

    console.log(`A: ${out.conceptA}`);
    console.log(`B: ${out.conceptB}`);
    console.log(`Insight: ${out.insight}`);
    console.log(`Resonance: ${out.resonance.toFixed(4)}`);
    console.log(`Confidence: ${Number(out.confidence || 0).toFixed(4)}`);

    if (out.field) {
        console.log(
            `Field -> phi_g=${out.field.phi_g.toFixed(4)} ` +
            `C=${out.field.C.toFixed(4)} ` +
            `Wm=${out.field.Wm.toFixed(4)} ` +
            `Pr=${out.field.Pr.toFixed(4)} ` +
            `X=${out.field.X.toFixed(4)}`
        );
    }

    console.log(`Duplicate Echo: ${!!out.duplicateEcho}`);
    console.log(`Used Non-Source Insight: ${!!out.usedNonSourceInsight}`);
    console.log(`Promotion Ready: ${!!out.promotionReady}`);
    console.log(`Source Reinforcement: ${Number(out.sourceReinforcement || 0).toFixed(4)}`);
    console.log(`Contradiction Pressure: ${Number(out.contradictionPressure || 0).toFixed(4)}`);
}

fs.writeFileSync("dream-output-full.json", JSON.stringify(full, null, 2), "utf8");

console.log("\nSaved full output to dream-output-full.json");
console.log("=== DREAM TEST END ===");