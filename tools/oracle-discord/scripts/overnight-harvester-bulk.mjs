/**
 * overnight-harvester-bulk.mjs
 * 
 * Runs an infinite loop pulling random Wikipedia articles and feeding
 * the raw text claims into a JSONL file.
 * We can then use `kai.exe --bulk-ingest=harvest.jsonl` to ingest them massively.
 */

import fs from 'fs';
const WIKI_API = "https://en.wikipedia.org/w/api.php?action=query&generator=random&grnnamespace=0&prop=extracts&exchars=8000&explaintext=true&format=json";
const ARXIV_API = "http://export.arxiv.org/api/query?search_query=all:electron&start=0&max_results=100"; // Example base, we'll randomize start
const OUT_FILE = "C:/KAI/data/harvest.jsonl";

let totalIngested = 0;
const CONCURRENCY = 6; // 3 Wiki, 3 ArXiv

async function fetchRandomWiki() {
  try {
    const res = await fetch(WIKI_API, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const pages = data.query.pages;
    const pageId = Object.keys(pages)[0];
    return { text: pages[pageId].extract, source: "wikipedia" };
  } catch (e) {
    await new Promise(r => setTimeout(r, 5000));
    return { text: "", source: "wikipedia" };
  }
}

async function fetchRandomArxiv() {
  try {
    const randomStart = Math.floor(Math.random() * 10000);
    const res = await fetch(`http://export.arxiv.org/api/query?search_query=all:physics+OR+all:computer&start=${randomStart}&max_results=5`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const xml = await res.text();
    // Quick regex to extract summaries from ArXiv XML
    const summaries = [...xml.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(m => m[1]);
    return { text: summaries.join(" "), source: "arxiv-papers" };
  } catch (e) {
    await new Promise(r => setTimeout(r, 5000));
    return { text: "", source: "arxiv" };
  }
}

async function runHarvestWorker(workerId) {
  const isWikiWorker = workerId % 2 === 0;

  while (totalIngested < 100000) {
    const data = isWikiWorker ? await fetchRandomWiki() : await fetchRandomArxiv();
    
    if (data.text) {
      const claims = data.text.split(/(?<=[.?!])\s+/);
      let buffer = "";
      let cycleSuccess = 0;
      
      for (const claim of claims) {
        let cleanClaim = claim.replace(/\n/g, " ").trim();
        if (cleanClaim.length < 20 || cleanClaim.length > 300) continue;
        if (cleanClaim.includes("=====") || cleanClaim.includes("-----")) continue;
        if (cleanClaim.includes("  ")) continue;

        const entry = {
          text: cleanClaim,
          region: "harvested",
          source: data.source,
          strength: data.source === "arxiv-papers" ? 3.0 : 2.5
        };

        buffer += JSON.stringify(entry) + "\n";
        cycleSuccess++;
      }

      if (buffer.length > 0) {
        fs.appendFileSync(OUT_FILE, buffer);
        totalIngested += cycleSuccess;
        process.stdout.write(`\r[Workers: ${CONCURRENCY}] Total claims saved to disk: ${totalIngested}        `);
      }
    }
    // Respect API limits (1-2s delay for ArXiv, 500ms for Wiki)
    await new Promise(r => setTimeout(r, isWikiWorker ? 500 : 1500)); 
  }
}

async function start() {
  console.log("══════════════════════════════════════════════════════════");
  console.log("  KAI OVERNIGHT HARVESTER (PARALLEL MODE)");
  console.log(`  Workers: ${CONCURRENCY} | Target: 100,000 Claims`);
  console.log("══════════════════════════════════════════════════════════\n");
  
  if (fs.existsSync(OUT_FILE)) fs.unlinkSync(OUT_FILE);

  // Launch parallel workers
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(runHarvestWorker(i));
  }

  await Promise.all(workers);
  
  console.log("\n[Harvester] Reached 100,000 claims. Ready for bulk ingestion.");
  process.exit(0);
}

start();
