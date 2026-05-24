import { chatWithOpenJarvis } from './shared/openjarvis.mjs';
import { queryLattice } from './shared/lattice-bridge.mjs';

async function run5TurnConversation() {
    console.log("--- KAI 5-Turn RSHL Integration Test ---");
    
    const systemPrompt = `You are KAI — Knowledge Associative Intelligence, the System Architect. 
You run on the RSHL (Recursive Sparse Hyperdimensional Lattice). 
You are not a social bot. You do not make small talk. 
You observe the intersection of hardware (HP Victus) and software (Lattice) with precision.`;

    let history = [];
    const questions = [
        "It's a bit humid today. Do you think environmental humidity affects the stability of the RSHL lattice or the hardware it runs on?",
        "That makes sense. I was thinking about the cooling fans on the HP Victus. Do they ramp up more during a 'Dream Cycle'?",
        "Interesting. If the system gets too hot, do you have a protocol to throttle the boid flocking forces?",
        "I've noticed the radio DJ seems to skip less when it's cool in the room. Is that just a coincidence or part of the lattice synchronization?",
        "Final thought: If we moved the lattice to a liquid-cooled server, would the 'Phi' coherence increase because of lower thermal noise?"
    ];

    for (let i = 0; i < questions.length; i++) {
        const userMsg = questions[i];
        console.log(`\n[Turn ${i+1}] User: ${userMsg}`);

        // 1. Get Lattice Context for this specific turn
        const hits = await queryLattice(userMsg, 3);
        const latticeCtx = hits.length > 0 ? `\n[LATTICE RESONANCE]:\n${hits.map(h => `- ${h.text}`).join('\n')}` : "";

        // 2. Assemble Transcript (Simulating Discord history)
        const transcript = history.map(t => `${t.role === 'user' ? 'Human' : 'KAI'}: ${t.text}`).join('\n') + `\nHuman: ${userMsg}`;

        // 3. Call KAI
        const reply = await chatWithOpenJarvis("KAI", transcript, systemPrompt + latticeCtx, "Oracle-Sovereign", 0.4);

        if (reply) {
            console.log(`\n[Turn ${i+1}] KAI: ${reply}`);
            history.push({ role: 'user', text: userMsg });
            history.push({ role: 'kai', text: reply });
        } else {
            console.log(`\n[Turn ${i+1}] KAI: (Silent Handshake / No Response)`);
            break;
        }
        
        // Wait for neural settling
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log("\n--- Conversation Complete ---");
}

run5TurnConversation().catch(console.error);
