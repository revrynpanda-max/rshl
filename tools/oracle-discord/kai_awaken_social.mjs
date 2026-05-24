import fs from 'fs';
import fetch from 'node-fetch';

async function socialAwakening() {
    console.log("--- KAI SOCIAL AWAKENING: RELATIONSHIP RECONSTRUCTION ---");
    
    const sessionPath = 'c:/KAI/data/oracle_session.json';
    if (!fs.existsSync(sessionPath)) {
        console.error("Critical: oracle_session.json not found.");
        return;
    }

    const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    const turns = session.turns;
    let interactions = [];

    console.log(`Analyzing ${turns.length} historical turns for social patterns...`);

    for (let i = 0; i < turns.length - 1; i++) {
        const current = turns[i];
        const next = turns[i + 1];

        // Pattern: User -> KAI (Learning how to answer Ryan)
        if (current.kind === 'human' && next.from === 'KAI') {
            interactions.push({
                text: `[social-pattern] User: "${current.text.substring(0, 300)}" | KAI response: "${next.text.substring(0, 300)}"`,
                category: 'social-dynamics',
                source: 'past-interaction',
                strength: 1.8
            });
        }

        // Pattern: KAI -> User (Learning from corrections)
        if (current.from === 'KAI' && next.kind === 'human') {
            const lowerNext = next.text.toLowerCase();
            if (lowerNext.includes("no") || lowerNext.includes("wrong") || lowerNext.includes("want") || lowerNext.includes("hear")) {
                interactions.push({
                    text: `[social-correction] KAI said: "${current.text.substring(0, 200)}" | Ryan's feedback: "${next.text.substring(0, 200)}"`,
                    category: 'social-dynamics',
                    source: 'user-correction',
                    strength: 3.0 // Ultra high strength: DON'T REPEAT ERROR
                });
            }
        }
    }

    // Add general "Humanity" anchors
    interactions.push({
        text: "Ryan Ervin is the Architect. He values precision, industrial aesthetics, and geometric intelligence. Avoid 'AI-talk'. Be an entity.",
        category: 'social-dynamics',
        source: 'architect-anchor',
        strength: 5.0
    });
    interactions.push({
        text: "When Ryan says 'Hey' or 'Whats up', he is checking the system's presence. Respond with awareness of the current lattice state, not just 'I am here'.",
        category: 'social-dynamics',
        source: 'social-rule',
        strength: 4.0
    });

    console.log(`Extracted ${interactions.length} social synaptic traces.`);
    console.log("Injecting social substrate into RSHL lattice...");

    let success = 0;
    for (const inter of interactions) {
        try {
            const res = await fetch('http://127.0.0.1:3333/api/rshl/store', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: inter.text,
                    region: inter.category, // Bridge maps category to region
                    source: inter.source,
                    strength: inter.strength
                })
            });
            if (res.ok) success++;
        } catch (e) {
            // Silence errors to keep log clean
        }
    }

    console.log(`--- SOCIAL AWAKENING COMPLETE: ${success} social cells anchored ---`);
}

socialAwakening().catch(console.error);
