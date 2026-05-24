import { requestOracleHelp } from './shared/oracle-pipeline.mjs';

async function launchAutonomousHunt() {
    console.log("--- INITIATING ZERO-HINT AUTONOMOUS REPAIR ---");
    
    // Vague, high-level directive. No file paths. No line numbers.
    const directive = "Oracle, the social hub is having identity synchronization issues. Bots like Claudey and X are being misidentified or double-named in their responses. Find the logic responsible for this 'ghost naming' and fix it so the hub is professional and clean. REPORT YOUR DISCOVERY PROCESS.";
    
    console.log("[Test] Sending directive to Oracle Gateway (Port 3410)...");
    const requestId = await requestOracleHelp("Ryan-Direct", directive, "1489796367466500128");

    if (requestId) {
        console.log(`[Test] Request ${requestId} is live. The specialists are now 'hunting'.`);
    }
}

launchAutonomousHunt();
