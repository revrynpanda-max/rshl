import { requestOracleHelp } from './shared/oracle-pipeline.mjs';

async function triggerSelfRepair() {
    console.log("--- INITIATING SYSTEM SELF-REPAIR ---");
    
    const question = "ENVIRONMENTAL CRASH: The system cannot talk to Ollama because the '-Sovereign' models are missing. 1. Use your tools to run 'ollama create Kai-Coder-Sovereign -f Modelfile' (or use a simple 'FROM kai-coder:latest' script). 2. Create aliases for Oracle-Sovereign (from kai-next) and Researcher-Sovereign (from kai-fast). 3. Once fixed, repair the regex bug in shared/openjarvis.mjs (line 84). REPORT ALL COMMANDS.";
    
    console.log("[Test] Sending high-priority repair directive to Oracle...");
    const requestId = await requestOracleHelp("Antigravity-Probe", question, "1489796367466500128");

    if (requestId) {
        console.log(`[Test] Repair Request ${requestId} is in flight.`);
    }
}

triggerSelfRepair();
