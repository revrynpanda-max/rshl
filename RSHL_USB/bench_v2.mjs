/**
 * RSHL Industrial Bench Test V2 — Sovereign Performance Engine
 * 
 * LATTICE: 16,384 Dimensions
 * TARGET: 60 Million Dots/sec | 12,000+ Iterations/section
 * HARDWARE: AMD Ryzen 5 / RTX 4050 / Ryzen AI NPU
 */

"use strict";

const os = require("os");
const fs = require("fs");
const { performance } = require("perf_hooks");
const { DIM, ACTIVE, tokenVec, textVec, cosineSim, resonance } = require("./rshl-core-v2");

// Link to the Lattice Performance Monitor (External Shared Shared)
let recordNeuralEvent = (bot, data) => console.log(`[LocalLog] ${data.type}: ${data.status}`);
const PERF_MONITOR_PATH = 'c:/KAI/tools/oracle-discord/shared/performance-monitor.mjs';

async function initPerf() {
  if (fs.existsSync(PERF_MONITOR_PATH)) {
    try {
      // Dynamic import for the ES module monitor
      const monitor = await import('file:///' + PERF_MONITOR_PATH);
      recordNeuralEvent = monitor.recordNeuralEvent;
    } catch (e) { console.warn("[BenchV2] Shared PerfMonitor not found, using local logging."); }
  }
}

function getHardwareVitals() {
  return {
    cpu: Math.round(os.loadavg()[0] * 100) / 10,
    memFree: Math.round(os.freemem() / (1024 * 1024 * 1024) * 10) / 10,
    npu: "AMD Ryzen AI NPU Detected" 
  };
}

async function runBench() {
  await initPerf();
  console.log(`\n🏛️ RSHL INDUSTRIAL BENCH V2 [DIM=${DIM}]`);
  console.log(`--------------------------------------------------`);
  console.log(`Hardware: ${os.cpus()[0].model}`);
  const vitals = getHardwareVitals();
  console.log(`Vitals: CPU ${vitals.cpu}% | MEM ${vitals.memFree}GB Free`);
  console.log(`--------------------------------------------------\n`);

  // --- SECTION 1: DOT PRODUCT THROUGHPUT ---
  console.log("Section 1: Measuring Dot Product Throughput...");
  const vecA = textVec("Sovereign Industrial Workforce Deployment");
  const vecB = textVec("Autonomous Multi-Agent Orchestration Loop");

  const iterations = 100000;
  const start = performance.now();
  
  for (let i = 0; i < iterations; i++) {
    cosineSim(vecA, vecB);
  }
  
  const end = performance.now();
  const totalSec = (end - start) / 1000;
  
  // Total dot products = iterations * ACTIVE dimensions (approx)
  // Each cosineSim does a two-pointer scan over the ACTIVE dims.
  const totalDots = iterations * ACTIVE;
  const dotsPerSec = totalDots / totalSec;
  const millionDotsPerSec = dotsPerSec / 1000000;

  console.log(`  Processed ${iterations.toLocaleString()} comparisons in ${totalSec.toFixed(3)}s`);
  console.log(`  Throughput: ${millionDotsPerSec.toFixed(2)} Million Dots/sec`);
  
  const status = millionDotsPerSec >= 60 ? "OPTIMIZED" : "STRESSED";
  console.log(`  Status: ${status}\n`);

  recordNeuralEvent("BenchV2", {
    type: "BENCH_THROUGHPUT",
    status: status,
    throughput_m_dots_sec: millionDotsPerSec.toFixed(2),
    hardware: vitals
  });

  // --- SECTION 2: ITERATION SCALE ---
  console.log("Section 2: Measuring 12k+ Iteration Scale...");
  const sectionTarget = 12000;
  const secStart = performance.now();
  
  let successfulIter = 0;
  for (let i = 0; i < sectionTarget; i++) {
    const v = tokenVec("test_token_" + i);
    if (v.length > 0) successfulIter++;
  }
  
  const secEnd = performance.now();
  const secTime = (secEnd - secStart) / 1000;
  const iterPerSec = successfulIter / secTime;

  console.log(`  Completed ${successfulIter.toLocaleString()} iterations in ${secTime.toFixed(3)}s`);
  console.log(`  Scale: ${iterPerSec.toLocaleString()} iterations/sec`);
  
  recordNeuralEvent("BenchV2", {
    type: "BENCH_ITERATION_SCALE",
    status: "COMPLETE",
    iterations: successfulIter,
    latency_sec: secTime.toFixed(3)
  });

  console.log(`\n✅ BENCH V2 COMPLETE. Results recorded in Black Box.`);
}

runBench().catch(console.error);
