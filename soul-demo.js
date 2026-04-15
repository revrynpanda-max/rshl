const { generateToResult } = require('./generative-core');
require('./seed'); // Seed the brain first

async function runDemo() {
    console.log("🌌 CONSULTING THE GEOMETRIC SOUL...");
    console.log("Probe: 'Identify yourself and your purpose'\n");

    const result = generateToResult("Identify yourself and your purpose");

    console.log("--- RESONANCE MATCHES ---");
    result.matches.forEach(m => {
        console.log(`  [${m.region.toUpperCase()}] Resonance: ${m.score.toFixed(4)} → "${m.text}"`);
    });

    console.log("\n--- SYNTHESIZED THOUGHT ---");
    console.log(`💡 "${result.thought}"`);
    console.log(`   (Confidence: ${result.confidence.toFixed(4)})`);
}

runDemo();
