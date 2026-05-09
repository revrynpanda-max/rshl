import fetch from 'node-fetch';
import dotenv from 'dotenv';
dotenv.config();

const RYAN_ID = "1068285521633513542";
const RYAN_USERNAME = "nastermodx";
const RESEARCHER_PORT = 3407;

async function injectDirective() {
  console.log(`[Sandbox] Mimicking User: ${RYAN_USERNAME} (${RYAN_ID})`);
  console.log(`[Sandbox] Injecting Strategic Directive into Researcher (Port ${RESEARCHER_PORT})...`);

  try {
    const res = await fetch(`http://127.0.0.1:${RESEARCHER_PORT}/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'ORACLE_DIRECTIVE',
        channelId: 'SANDBOX_THREAD_001',
        context: `[${RYAN_USERNAME}] STRATEGIC DIRECTIVE: Perform a neural audit of the Lattice. Prove that the simSummary bug is resolved.`
      })
    });

    if (res.ok) {
      console.log(`[Sandbox] Directive INJECTED successfully.`);
      console.log(`[Sandbox] Check the Researcher console/logs for processing output.`);
    } else {
      console.error(`[Sandbox] Injection failed: ${res.statusText}`);
    }
  } catch (e) {
    console.error(`[Sandbox] Could not connect to bot: ${e.message}`);
    console.log(`[Sandbox] Tip: Make sure the bots are running (.\run-oracle-discord.ps1) before running this test.`);
  }
}

injectDirective();
