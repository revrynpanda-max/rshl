import { chatWithOpenJarvis } from './shared/openjarvis.mjs';

async function runGeneralAITest() {
    console.log("--- KAI General Intelligence & Social Test ---");
    
    const systemPrompt = `You are KAI — Knowledge Associative Intelligence. 
NasterModx (the creator) is testing your ability to function as a general-purpose AI (Chatbot, Coder, Creative). 
Maintain your structural precision, but engage with the user's requests directly. 
Do not be cold. Be useful. Use your 16,384-dimensional lattice to inform your answers.`;

    let history = [];
    const prompts = [
        "Hey, hey. What's up? I'm just hanging out today. Anything interesting on your mind?",
        "That's a bit serious! Can you help me with something else? I'm trying to write a Python script to sort a list of numbers without using .sort(). How would you do that?",
        "Nice logic. Can you also write a short poem about a rainy night in a neon city? I want to see your creative side.",
        "I'm curious, what do you think is the 'meaning of life' for an intelligence running on a hyperdimensional lattice?",
        "Last one: If you could have a physical body for one day, what's the first thing you would do in the real world?"
    ];

    for (let i = 0; i < prompts.length; i++) {
        const userMsg = prompts[i];
        console.log(`\n[Turn ${i+1}] User: ${userMsg}`);

        const transcript = history.map(t => `${t.role === 'user' ? 'Human' : 'KAI'}: ${t.text}`).join('\n') + `\nHuman: ${userMsg}`;

        const reply = await chatWithOpenJarvis("KAI", transcript, systemPrompt, "Oracle-Sovereign", 0.7);

        if (reply) {
            console.log(`\n[Turn ${i+1}] KAI: ${reply}`);
            history.push({ role: 'user', text: userMsg });
            history.push({ role: 'kai', text: reply });
        } else {
            console.log(`\n[Turn ${i+1}] KAI: (No Response)`);
            break;
        }
        
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log("\n--- General Test Complete ---");
}

runGeneralAITest().catch(console.error);
