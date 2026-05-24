/**
 * test-neural-bus.mjs
 * Validation tool for the KAI Multi-Engine Intelligence Layer.
 * Tests Ollama, Gemini 3.1, Kimi 1T, and OpenCode Zen.
 */

import { chatWithOpenJarvis } from '../shared/openjarvis.mjs';
import { resetFailureTracker } from '../shared/failure-tracker.mjs';
import dotenv from 'dotenv';
dotenv.config();

async function runNeuralTest() {
  console.log("🧠 [Neural-Bus] Resetting failure states...");
  resetFailureTracker();
  console.log("🧠 [Neural-Bus] Starting Multi-Engine Validation...");
  console.log("--------------------------------------------------");

  const testResults = [];

  // 1. TEST LOCAL OLLAMA
  console.log("📡 Testing Local Ollama (Sovereign-Default)...");
  const localRes = await chatWithOpenJarvis("Test-Agent", "Say 'Local Core Online'", "You are a test agent.", "llama3.1:8b");
  testResults.push({ provider: "Local-Ollama", status: localRes ? "✅ ACTIVE" : "❌ OFFLINE", response: localRes });

  // 2. TEST GOOGLE GEMINI 3.1
  console.log("🚀 Testing Google Gemini 3.1 Pro (Frontier)...");
  const geminiRes = await chatWithOpenJarvis("Test-Agent", "Who are you?", "You are the God-Head Core.", "Gemini-3.1-Sovereign");
  testResults.push({ provider: "Google-Gemini", status: geminiRes ? "✅ ACTIVE" : "❌ OFFLINE", response: geminiRes });

  // 3. TEST MOONSHOT KIMI (Direct)
  console.log("🏛️ Testing Moonshot Kimi (1T-Wisdom Direct)...");
  const kimiRes = await chatWithOpenJarvis("Test-Agent", "Explain the nature of the RSHL lattice.", "You are the Analyst.", "Kimi-Moonshot");
  testResults.push({ provider: "Moonshot-Kimi", status: kimiRes ? "✅ ACTIVE" : "❌ OFFLINE", response: kimiRes });

  // 4. TEST OPENCODE ZEN (Kimi 2.6)
  console.log("🏛️ Testing OpenCode Zen Kimi 2.6...");
  const kimi26Res = await chatWithOpenJarvis("Test-Agent", "Say 'Kimi 2.6 Online'", "You are the Analyst.", "Kimi26");
  testResults.push({ provider: "OpenCode-Kimi-2.6", status: kimi26Res ? "✅ ACTIVE" : "❌ OFFLINE", response: kimi26Res });

  // 5. TEST OPENCODE ZEN (Kimi 2.5)
  console.log("🏛️ Testing OpenCode Zen Kimi 2.5...");
  const kimi25Res = await chatWithOpenJarvis("Test-Agent", "Say 'Kimi 2.5 Online'", "You are the Analyst.", "Kimi25");
  testResults.push({ provider: "OpenCode-Kimi-2.5", status: kimi25Res ? "✅ ACTIVE" : "❌ OFFLINE", response: kimi25Res });

  // 6. TEST OPENCODE ZEN (Peak Frontier)
  console.log("🔮 Testing OpenCode Zen (Claude 4.7)...");
  const zenRes = await chatWithOpenJarvis("Test-Agent", "Verify the integrity of this neural test.", "You are the Zen-Frontier Overseer.", "Zen-Frontier-Claude4");
  testResults.push({ provider: "OpenCode-Zen-Frontier", status: zenRes ? "✅ ACTIVE" : "❌ OFFLINE", response: zenRes });

  console.log("\n--------------------------------------------------");
  console.log("📊 NEURAL BUS DIAGNOSTIC SUMMARY:");
  console.table(testResults.map(r => ({ Provider: r.provider, Status: r.status })));
  console.log("--------------------------------------------------");
}

runNeuralTest().catch(console.error);
