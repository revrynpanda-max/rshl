import { requestOracleHelp } from './shared/oracle-pipeline.mjs';
import fs from 'fs';

async function triggerFix() {
    console.log("--- INITIATING SOVEREIGN REPAIR PIPELINE ---");
    
    const question = "In shared/openjarvis.mjs, the name-stripping regex on line 84 is missing 'Claudey' and 'X'. This causes double-naming in the social hub. Update the regex to: /^(Leo|Oracle|KAI|Analyst|Gemini|Claudey|X|Groq|Researcher|Kai Coder):\\s*/gi. Verify the change and stage it.";
    
    console.log("[1/4] Sending Request to Oracle Gateway...");
    const requestId = await requestOracleHelp("Antigravity-Probe", question, "1489796367466500128");

    if (requestId) {
        console.log(`[2/4] Request ${requestId} is QUEUED.`);
        console.log("[3/4] Monitoring logs for delegation...");
    }
}

triggerFix();
