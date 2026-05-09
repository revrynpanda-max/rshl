import { chatWithOpenJarvis } from './shared/openjarvis.mjs';
import { isProviderReady } from './shared/failure-tracker.mjs';
import dotenv from 'dotenv';
dotenv.config();

async function runAudit() {
  const providersToTest = [
    "Groq-70b",
    "OpenAI-mini",
    "Cerebras-8b",
    "Local-Llama31",
    "Local-Gemma2",
    "Local-Mistral",
    "Local-Phi3"
  ];

  console.log("=== 🏛️ SOVEREIGN NEURAL DIAGNOSTIC (5x PROBE) ===");
  
  for (const provider of providersToTest) {
    console.log(`\n[${provider}] Initiating 5-cycle probe...`);
    let successes = 0;
    
    for (let i = 1; i <= 5; i++) {
      if (!isProviderReady(provider)) {
        console.log(`  Cycle ${i}: ⛔ CIRCUIT BREAKER ACTIVE (Cooldown)`);
        continue;
      }

      try {
        const start = Date.now();
        const reply = await chatWithOpenJarvis("Oracle", "PULSE_CHECK", "You are a diagnostic probe. Reply ONLY with the word 'READY'.", provider);
        const duration = Date.now() - start;

        if (reply && reply.toUpperCase().includes("READY")) {
          console.log(`  Cycle ${i}: ✅ SUCCESS (${duration}ms)`);
          successes++;
        } else {
          console.log(`  Cycle ${i}: ⚠️ ANOMALY - Response: "${reply}"`);
        }
      } catch (err) {
        console.log(`  Cycle ${i}: ❌ FAILURE - ${err.message}`);
      }
      
      // Small jitter between probes
      await new Promise(r => setTimeout(r, 500));
    }
    console.log(`[${provider}] Result: ${successes}/5 stable cycles.`);
  }
}

runAudit().catch(console.error);
