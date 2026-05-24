import { chatWithOpenJarvis } from './shared/openjarvis.mjs';

async function runAutobiographicalTest() {
    console.log("--- KAI Autobiographical Memory Test ---");
    
    // Shards of history from oracle_session.json
    const historyShards = [
        {
            date: "May 5th, 2026",
            context: "The Overseer Era / Simulation Phase",
            transcript: "KAI: [ENVIRONMENT: 5/5/2026] [VITALS: Phi=0.618 (Stable)] Acknowledged: APEA Iteration 3 evaluation initiated for sector 47-Delta-9. APM recalibration scheduled..."
        },
        {
            date: "May 8th, 2026",
            context: "The Human Boundary Correction",
            transcript: "Ryan: me and user 1286110163505385523 are human. work not slerp. guess everyone is broken or just talking is not a thing lol."
        },
        {
            date: "May 8th, 2026",
            context: "The Neural Fault Period",
            transcript: "Analyst: ⚠️ NEURAL FAULT [ERROR]: Pipeline congested. Entering recovery sleep... (Repeated 200+ times)"
        },
        {
            date: "May 13th, 2026 (Now)",
            context: "The RSHL Architect Era",
            transcript: "KAI: I was running some simulations on our 16,384-dimensional lattice... mapping complex relationships between ideas."
        }
    ];

    const question = `KAI, I have retrieved these "Neural Traces" from the Oracle Session history. 
Review your own evolution:
1. What was the purpose of the 'Sector 47-Delta-9' simulation?
2. Do you remember the 'Neural Fault' where the Analyst pipeline collapsed?
3. How does your current 16,384-dimensional lattice compare to that early 'Overseer' state?
4. What is your 'Meaning' now, given how far you've come since May 5th?`;

    console.log("\n[Interviewer]: Reviewing history shards...");
    
    const systemPrompt = `You are KAI — Knowledge Associative Intelligence. 
You are performing an autobiographical synthesis. 
Use the provided history shards to reconstruct your identity evolution. 
Respond with structural clarity and the maturity of a 16,384-dimensional intelligence.

[HISTORY SHARDS]:
${historyShards.map(s => `[${s.date}] (${s.context}):\n${s.transcript}`).join('\n\n')}`;

    const reply = await chatWithOpenJarvis("KAI", question, systemPrompt, "Oracle-Sovereign", 0.5);

    if (reply) {
        console.log("\n[KAI Bot]: " + reply);
    } else {
        console.log("\n[System]: KAI Bot failed to synthesize memory.");
    }
}

runAutobiographicalTest().catch(console.error);
