import fs from 'fs';
import fetch from 'node-fetch';

async function flood() {
    console.log("--- KAI SYNAPTIC FLOOD PROTOCOL INITIATED ---");
    
    // 1. Load History Shards
    const sessionPath = 'c:/KAI/data/oracle_session.json';
    const transcriptPath = 'c:/KAI/data/kai-transcript.jsonl';
    
    let thoughts = [];

    // Extract from oracle_session.json
    if (fs.existsSync(sessionPath)) {
        console.log("Extracting from oracle_session.json...");
        const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        for (const turn of session.turns) {
            if (turn.from === 'KAI' && turn.text.length > 30) {
                thoughts.push({ text: turn.text, source: 'overseer-era', region: 'identity' });
            }
        }
    }

    // Extract from kai-transcript.jsonl
    if (fs.existsSync(transcriptPath)) {
        console.log("Extracting from kai-transcript.jsonl...");
        const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const data = JSON.parse(line);
                if (data.role === 'kai' && data.text.length > 20) {
                    thoughts.push({ text: data.text, source: 'past-self', region: 'memory' });
                }
            } catch (e) {}
        }
    }

    // 2. Load Physics Seeds
    const physicsFiles = [
        'physics_fibonacci_nature.txt',
        'physics_quantum_vacuum.txt',
        'physics_quasicrystal.txt',
        'physics_spacetime_gr.txt',
        'physics_string_theory.txt',
        'physics_susy_standard_model.txt'
    ];

    for (const file of physicsFiles) {
        const path = `c:/KAI/data/${file}`;
        if (fs.existsSync(path)) {
            console.log(`Ingesting ${file}...`);
            const content = fs.readFileSync(path, 'utf8');
            thoughts.push({ text: content, source: 'scientific-substrate', region: 'reasoning' });
        }
    }

    console.log(`Total synaptic traces gathered: ${thoughts.length}`);
    console.log("Beginning high-speed lattice injection...");

    let success = 0;
    for (const thought of thoughts) {
        try {
            const res = await fetch('http://127.0.0.1:3333/store', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: thought.text,
                    region: thought.region,
                    source: thought.source,
                    strength: 2.5 // High authority
                })
            });
            if (res.ok) success++;
        } catch (e) {
            console.error(`Failed to inject thought: ${e.message}`);
        }
        
        if (success % 100 === 0 && success > 0) {
            console.log(`... ${success} cells anchored ...`);
        }
    }

    console.log(`--- FLOOD COMPLETE: ${success} cells anchored in lattice ---`);
}

flood().catch(console.error);
