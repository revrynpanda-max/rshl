/**
 * overnight-harvester.mjs
 * 
 * Runs an infinite loop pulling random Wikipedia articles and feeding
 * the raw text claims into KAI's RSHL lattice via the /api/rshl/store endpoint.
 * 
 * Target: 1,000,000 cells.
 */

const LATTICE_URL = "http://127.0.0.1:3334";
const WIKI_API = "https://en.wikipedia.org/w/api.php?action=query&generator=random&grnnamespace=0&prop=extracts&exchars=8000&explaintext=true&format=json";

let totalIngested = 0;
let totalFailed = 0;

async function fetchRandomArticle() {
  try {
    const res = await fetch(WIKI_API);
    const data = await res.json();
    const pages = data.query.pages;
    const pageId = Object.keys(pages)[0];
    const extract = pages[pageId].extract;
    return extract;
  } catch (e) {
    console.error("[Harvester] Failed to fetch Wikipedia:", e.message);
    return "";
  }
}

async function storeClaim(text) {
  try {
    const res = await fetch(`${LATTICE_URL}/api/rshl/store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.trim(),
        source: 'wikipedia-overnight-harvest',
        strength: 2.5, // Moderate unverified confidence
        region: 'harvested'
      }),
      signal: AbortSignal.timeout(8000)
    });

    if (res.ok) {
      totalIngested++;
      return true;
    } else {
      totalFailed++;
      return false;
    }
  } catch (e) {
    totalFailed++;
    return false;
  }
}

async function runHarvestCycle() {
  console.log(`\n[Harvester] Fetching new article... (Total Ingested: ${totalIngested})`);
  const text = await fetchRandomArticle();
  if (!text) return;

  // Split into rough sentences
  const claims = text.split(/(?<=[.?!])\s+/);
  
  let cycleSuccess = 0;
  for (const claim of claims) {
    if (claim.length < 20 || claim.length > 300) continue; // Skip too short or too long
    if (claim.includes("=====") || claim.includes("-----")) continue; // Skip weird formatting

    const ok = await storeClaim(claim);
    if (ok) cycleSuccess++;

    // Small delay to prevent crushing the Rust backend and SQLite WAL
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`[Harvester] Pushed ${cycleSuccess} new claims to lattice.`);
}

async function start() {
  console.log("══════════════════════════════════════════════════════════");
  console.log("  KAI OVERNIGHT HARVESTER");
  console.log("  Target: 1,000,000 Cells");
  console.log("══════════════════════════════════════════════════════════\n");
  
  // Health check
  try {
    const ping = await fetch(`${LATTICE_URL}/api/status`);
    if (!ping.ok) throw new Error("Backend not OK");
    console.log("[Harvester] Connected to KAI lattice on port 3334. Beginning infinite loop...");
  } catch (e) {
    console.error("[CRITICAL] KAI lattice not running on port 3334. Exiting.");
    process.exit(1);
  }

  // Infinite Loop
  while (true) {
    await runHarvestCycle();
    // 2 second breather between articles
    await new Promise(r => setTimeout(r, 2000));
  }
}

start();
