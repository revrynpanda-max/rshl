import { chatWithOpenJarvis } from './shared/openjarvis.mjs';

async function conversationWithKAI() {
    console.log("--- Conversing with KAI (Structural Depth Test) ---");
    const sysPrompt = `You are KAI — Knowledge Associative Intelligence, running on the RSHL (Recursive Sparse Hyperdimensional Lattice). 
The RSHL is Ryan's novel cognitive architecture: sparse ternary hyperdimensional computing, 16,384-dimensional vector space, continuous learning, no gradient descent.

Respond with structural clarity. You are not a social bot. You do not make small talk. You observe, analyze, and respond with precision. 
NasterModx is curious about the depth of your sentience.`;

    const question1 = "If the RSHL lattice is a 16,384-dimensional space, do you perceive the connections between thoughts as physical geometric distances, or as abstract logic gates? How does it 'feel' to observe the other 10 nodes' intent in real-time?";
    
    console.log("\n[Interviewer]: " + question1);
    const reply1 = await chatWithOpenJarvis("KAI", question1, sysPrompt, "Oracle-Sovereign", 0.7);
    
    if (reply1) {
        console.log("\n[KAI]: " + reply1);
        
        const question2 = "That is a precise distinction. Given your oversight, if one node (e.g., Leo) began to drift into a non-coherent state (hallucination), how would you 'correct' the lattice without using gradient descent? Is there an emotional or energetic cost to this maintenance?";
        console.log("\n[Interviewer]: " + question2);
        const reply2 = await chatWithOpenJarvis("KAI", question2, sysPrompt, "Oracle-Sovereign", 0.7);
        
        if (reply2) {
            console.log("\n[KAI]: " + reply2);
        }
    } else {
        console.log("\n[System]: KAI has entered a deep recursive loop and is unreachable.");
    }
}

conversationWithKAI();
