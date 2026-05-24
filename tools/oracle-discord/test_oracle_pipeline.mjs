import { requestOracleHelp } from './shared/oracle-pipeline.mjs';

async function runFormalTest() {
    console.log("--- INITIATING FORMAL ORACLE PIPELINE TEST ---");
    
    const botName = "KAI";
    const question = "Verify that the botToModel mapping in bots/start-bot.mjs correctly includes 'Claudey' and points to 'Claudey-Sovereign'. Audit the syntax integrity of the mapping object.";
    const channelId = "1489796367466500128"; // oracle-chat

    console.log(`[Test] Requesting help from Oracle as ${botName}...`);
    
    const requestId = await requestOracleHelp(botName, question, channelId, (result) => {
        console.log("\n--- PIPELINE RESULT RECEIVED ---");
        console.log(`Request ID: ${requestId}`);
        console.log(`Result from Specialist:\n${result}`);
        console.log("--- TEST COMPLETE ---");
        process.exit(0);
    });

    if (requestId) {
        console.log(`[Test] Request ${requestId} is now in the pipeline.`);
        console.log("[Test] Waiting for Oracle specialist to process... (this may take 20-40s)");
    } else {
        console.error("[Test] Failed to queue request.");
        process.exit(1);
    }
}

runFormalTest();

// Timeout safety
setTimeout(() => {
    console.log("\n[Test] Timeout: No result received within 60s. The specialist might be busy or offline.");
    process.exit(1);
}, 60000);
