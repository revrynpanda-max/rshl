"use strict";

// Import the seeded instance
const kai = require('./seed');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'YOU> '
});

console.log('--- KAI NEURAL INTERFACE ONLINE ---');
console.log('Mode: Sparse Ternary Resonance');
console.log('Regions: [Memory, Reasoning, Language, Action]\n');

rl.prompt();

rl.on('line', (line) => {
    const input = line.trim();
    if (!input) {
        rl.prompt();
        return;
    }

    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
        process.exit(0);
    }

    const results = kai.query(input, 3);
    const best = results[0];

    // Mirroring KAI's "Literal/Silent" reasoning logic:
    // If resonance is too low, we trigger the seeded 'No strong resonance' behavior.
    if (!best || best.score < 0.53) {
        console.log('\nKAI: ... (No strong resonance)');
    } else {
        console.log(`\nKAI [${best.region}]: ${best.text}`);
        console.log(`(geometric match: ${best.score.toFixed(4)})`);
    }
    
    console.log();
    rl.prompt();
}).on('close', () => {
    console.log('\nIdentity dissolved. Hyperspace collapsed.');
    process.exit(0);
});
