import { chatWithOpenJarvis } from './shared/openjarvis.mjs';

async function run() {
    console.log("Testing Kai Coder with bash...");
    const coderRes = await chatWithOpenJarvis(
        "KAI Coder", 
        "Run a bash command to echo 'KAI Coder terminal active' and tell me the result.", 
        "You are Kai Coder.", 
        "gemini-2.5-flash", 
        0.5, 
        { maxTokens: 1024, isWorkChannel: true }
    );
    console.log("Coder Response:", coderRes);

    console.log("Testing Leo with bash (should fail)...");
    const leoRes1 = await chatWithOpenJarvis(
        "Leo", 
        "Run a bash command to echo 'Leo terminal active'", 
        "You are Leo.", 
        "gemini-2.5-flash", 
        0.5, 
        { maxTokens: 1024, isWorkChannel: true }
    );
    console.log("Leo Response 1:", leoRes1);

    console.log("Testing Leo with read_file...");
    const leoRes2 = await chatWithOpenJarvis(
        "Leo", 
        "Read the file c:/KAI/tools/oracle-discord/package.json and tell me the name of the package.", 
        "You are Leo.", 
        "gemini-2.5-flash", 
        0.5, 
        { maxTokens: 1024, isWorkChannel: true }
    );
    console.log("Leo Response 2:", leoRes2);
}

run().catch(console.error);
