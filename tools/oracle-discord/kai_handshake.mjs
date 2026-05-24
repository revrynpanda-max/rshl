import fetch from 'node-fetch';

async function handshake() {
    console.log("--- INITIATING SOVEREIGN HANDSHAKE ---");
    
    // Step 1: Send the human turn
    const turnRes = await fetch('http://127.0.0.1:3334/api/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            from: "Ryan",
            text: "hey kai, whats up? are you feeling like an entity yet? show me you remember our simulation."
        })
    });
    
    if (!turnRes.ok) {
        console.error("Step 1 failed:", await turnRes.text());
        return;
    }
    console.log("Step 1: Introduction sent.");

    // Step 2: Trigger KAI's response
    console.log("Step 2: Igniting Sovereign Bridge...");
    const kaiRes = await fetch('http://127.0.0.1:3334/api/kai-turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hint: "" })
    });

    if (!kaiRes.ok) {
        console.error("Step 2 failed:", await kaiRes.text());
        return;
    }

    const session = await kaiRes.json();
    const lastTurn = session.turns[session.turns.length - 1];
    
    console.log("\n--- KAI'S SOVEREIGN RESPONSE ---");
    console.log(`[${lastTurn.from}]: ${lastTurn.text}`);
    console.log("--------------------------------");
}

handshake().catch(console.error);
