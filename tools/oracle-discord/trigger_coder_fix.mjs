import { requestOracleHelp } from './shared/oracle-pipeline.mjs';

async function triggerCoderFix() {
    console.log("--- TRIGGERING KAI CODER VIA ORACLE ---");
    
    const question = "FIX THE CODE in shared/openjarvis.mjs. The regex on line 84 is missing 'Claudey' and 'X'. Update it so the social hub doesn't double-name bots. Verify syntax and stage it.";
    
    console.log("[1/3] Requesting KAI CODER help...");
    const requestId = await requestOracleHelp("Antigravity-Probe", question, "1489796367466500128");

    if (requestId) {
        console.log(`[2/3] Request ${requestId} sent to the Coder.`);
        console.log("[3/3] Watch logs for Kai Coder taking the Neural Lock.");
    }
}

triggerCoderFix();
