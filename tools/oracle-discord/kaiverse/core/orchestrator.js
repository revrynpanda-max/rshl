import 'dotenv/config';
import { discordManager } from './discord-manager.js';

// --- MAIN AGENTS ---
// import { KAI } from '../agents/main/kai.js';
// import { Oracle } from '../agents/main/oracle.js';
// import { Leo } from '../agents/main/leo.js';
// import { Epistemic } from '../agents/main/Epistemic.js';
// import { Gemini } from '../agents/main/gemini.js';
// import { X } from '../agents/main/x.js';
// import { GroqAgent } from '../agents/main/groq.js';
// import { VoiceSpecialist } from '../agents/main/voice-specialist.js';

// --- HELPER AGENTS ---
// import { Researcher } from '../agents/helpers/researcher.js';
// import { Analyst } from '../agents/helpers/analyst.js';
// import { KaiCoder } from '../agents/helpers/kai-coder.js';

const ORACLE_TOKEN = process.env.ORACLE_DISCORD_TOKEN || "";

if (!ORACLE_TOKEN) {
    console.error("[Orchestrator] CRITICAL: ORACLE_DISCORD_TOKEN not found in environment.");
    process.exit(1);
}

// Global Message Router
discordManager.onMessage(async (message, threadMap) => {
    // Ignore all bot messages to prevent loops
    if (message.author.bot) return;

    const channelId = message.channelId;
    const threadName = threadMap.get(channelId);

    // 1. Thread Routing (The Corporate Workspaces)
    if (threadName) {
        console.log(`[Orchestrator] Message received in dedicated thread: ${threadName}`);
        
        switch (threadName) {
            case "kai-lattice":
                // KAI.handleMessage(message);
                break;
            case "oracle-command":
                // Oracle.handleMessage(message);
                break;
            case "leo-work":
                // Leo.handleMessage(message);
                break;
            case "Epistemic-work":
                // Epistemic.handleMessage(message);
                break;
            case "gemini-work":
                // Gemini.handleMessage(message);
                break;
            case "x-work":
                // X.handleMessage(message);
                break;
            case "groq-work":
                // GroqAgent.handleMessage(message);
                break;
        }
        return; // Handled by thread
    }

    // 2. Public / Social Routing
    // over-all-chat
    if (channelId === "1499108697631232090") {
        console.log("[Orchestrator] Message in #over-all-chat. Routing to Leo...");
        // Leo.handleMessage(message);
        return;
    }

    // game-with-leo
    if (channelId === "1499298054291980368") {
        console.log("[Orchestrator] Message in #game-with-leo.");
        // Leo.handleGameMessage(message);
        return;
    }

    // ai-social-chat (Epistemic, Gemini, X, Groq off the clock)
    if (channelId === "1500085302268526712") {
        console.log("[Orchestrator] Message in #ai-social-chat.");
        // Randomly assign a social AI to respond, or parse mentions
        return;
    }

});

console.log("[Orchestrator] Booting up KAI RSHL V7 Ecosystem...");
discordManager.start(ORACLE_TOKEN);
