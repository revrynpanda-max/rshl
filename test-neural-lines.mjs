import { chatWithOpenJarvis } from './shared/openjarvis.mjs';
import dotenv from 'dotenv';
dotenv.config();

const BOT_PIPELINES = {
  "Leo":             ["Cerebras-70b",   "Groq-8b"],
  "Oracle":          ["Groq-70b",       "OpenAI-4o"],
  "KAI":             ["OpenAI-mini",    "Anthropic-Haiku"],
  "Researcher":      ["Google-Pro",     "Groq-Mixtral"],
  "Analyst":         ["Local-Llama31",  "Google-Flash-8b"],
  "Claude":          ["Anthropic-Sonnet", "Google-2.0-Flash"],
  "Gemini":          ["Google-Flash",   "Cerebras-8b"],
  "X":               ["Groq-Llama32-3b", "Local-Phi3"],
  "Groq":            ["Groq-Gemma",     "Groq-Llama32-1b"],
  "Kai Coder":       ["OpenAI-o1-mini", "Local-Llama32"],
  "Oracle_Overseer": ["Local-Gemma2",   "Google-Pro-1.0"]
};

async function testLines() {
  console.log("=== 🏛️ NEURAL PULSE AUDIT: 22-LINE ISOLATION TEST ===");
  
  for (const [botName, lines] of Object.entries(BOT_PIPELINES)) {
    console.log(`\n[${botName}] Checking Pipelines...`);
    
    for (let i = 0; i < lines.length; i++) {
      const lineName = lines[i];
      const type = i === 0 ? "PRIMARY" : "FALLBACK";
      
      try {
        process.stdout.write(`  - ${type}: ${lineName} ... `);
        const start = Date.now();
        // Use a simple prompt and force the specific model/line
        const reply = await chatWithOpenJarvis(botName, "respond with exactly the word 'PULSE'", "You are a test probe.", lineName);
        const duration = Date.now() - start;
        
        if (reply && reply.toLowerCase().includes("pulse")) {
          console.log(`✅ SUCCESS (${duration}ms)`);
        } else {
          console.log(`⚠️ UNEXPECTED REPLY: "${reply}"`);
        }
      } catch (err) {
        console.log(`❌ FAILED: ${err.message}`);
      }
    }
  }
  
  console.log("\n=== AUDIT COMPLETE ===");
}

testLines().catch(console.error);
