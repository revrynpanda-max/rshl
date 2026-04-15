"use strict";

const { Plasma } = require('./plasma');
const { REGIONS } = require('./anchors');
const readline = require('readline');

// Import the seed to populate the brain
require('./seed'); 

const kai = new Plasma(false); // Do not clear

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\nVOICE> '
});

console.log('🌌 KAI PLASMA NEURAL MONITOR');
console.log('System: 4096-Dim Sparse Ternary (RSHL)');
console.log('Isolation: Holographic Sign Modulation');
console.log('Logic: Forcing Query Phase across all Fluids');
console.log('-------------------------------------------');

rl.prompt();

rl.on('line', (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    console.log(`\nNeural Scan for: "${input}"`);
    console.log('='.repeat(60));

    // We force the query into EVERY region's phase state independently.
    // This allows us to see true cross-region leakage.
    REGIONS.forEach(region => {
        const results = kai.queryRegion(input, region, 3);

        console.log(`\n[${region.toUpperCase()} FLUID]`);
        results.forEach((hit, i) => {
            // Visual resonance bar
            const score = hit.score || 0;
            const barWidth = Math.max(0, Math.floor(score * 30));
            const bar = '█'.repeat(barWidth).padEnd(30, '░');
            
            console.log(`  ${i+1}. ${score.toFixed(4)} [${bar}] "${hit.text}"`);
        });
    });

    console.log('\n' + '='.repeat(60));
    rl.prompt();
});
