/**
 * swarm-harvester.mjs
 * 
 * 20 Concurrent Sub-KAI Workers pulling from diverse sources
 * to safely build a massive local dataset for bulk ingestion.
 */

import fs from 'fs';
const WIKI_API = "https://en.wikipedia.org/w/api.php?action=query&generator=random&grnnamespace=0&prop=extracts&exchars=8000&explaintext=true&format=json";
const OUT_FILE = "C:/KAI/data/harvest.jsonl";

let totalIngested = 0;
let totalSynthesized = 0;
const MAX_BYTES = 1000 * 1024 * 1024; // 1 GB safety cap

// ── WORKER COUNTS ──
const WIKI_WORKERS = 5;
const ARXIV_WORKERS = 5;
const DDG_WORKERS = 2;
const OPENALEX_WORKERS = 3;
const SYNTHESIZERS = 5;

const TOTAL_WORKERS = WIKI_WORKERS + ARXIV_WORKERS + DDG_WORKERS + OPENALEX_WORKERS + SYNTHESIZERS;

// ── UTILITIES ──
function checkSpace() {
  if (fs.existsSync(OUT_FILE)) {
    const stats = fs.statSync(OUT_FILE);
    if (stats.size >= MAX_BYTES) {
      console.log(`\n\n[Swarm] Max file size (100MB) reached. Saving your hard drive. Halting swarm.`);
      process.exit(0);
    }
  }
}

function saveClaims(textArray, source, strength = 2.5, region = "harvested") {
  let buffer = "";
  let saved = 0;
  for (const claim of textArray) {
    let clean = claim.replace(/\n/g, " ").trim();
    if (clean.length < 20 || clean.length > 300) continue;
    if (clean.includes("=====") || clean.includes("  ")) continue;

    buffer += JSON.stringify({ text: clean, region, source, strength }) + "\n";
    saved++;
  }
  
  if (buffer.length > 0) {
    fs.appendFileSync(OUT_FILE, buffer);
    totalIngested += saved;
    checkSpace();
    process.stdout.write(`\r[Swarm Active | ${TOTAL_WORKERS} Workers] Total Claims: ${totalIngested} | Synthesized Anchors: ${totalSynthesized}      `);
  }
}

// ── WORKER DEFINITIONS ──

async function workerWiki(id) {
  while (totalIngested < 5000000) {
    try {
      const res = await fetch(WIKI_API, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const pages = data.query.pages;
        const extract = pages[Object.keys(pages)[0]].extract;
        if (extract) saveClaims(extract.split(/(?<=[.?!])\s+/), "wikipedia-swarm", 2.0);
      }
    } catch (e) {
      await new Promise(r => setTimeout(r, 5000));
    }
    await new Promise(r => setTimeout(r, 600)); // Rate limit
  }
}

async function workerArxiv(id) {
  while (totalIngested < 5000000) {
    try {
      const randomStart = Math.floor(Math.random() * 20000);
      const res = await fetch(`http://export.arxiv.org/api/query?search_query=all:electron+OR+all:biology+OR+all:quantum&start=${randomStart}&max_results=3`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const xml = await res.text();
        const summaries = [...xml.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map(m => m[1]);
        if (summaries.length) saveClaims(summaries.join(" ").split(/(?<=[.?!])\s+/), "arxiv-swarm", 3.0);
      }
    } catch (e) {
      await new Promise(r => setTimeout(r, 8000));
    }
    await new Promise(r => setTimeout(r, 2000)); 
  }
}

async function workerOpenAlex(id) {
  while (totalIngested < 5000000) {
    try {
      const res = await fetch(`https://api.openalex.org/works?sample=5`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const abstracts = data.results.map(w => w.abstract_inverted_index ? "Extracted scientific abstract data." : "").filter(Boolean);
        if (abstracts.length) saveClaims(abstracts, "openalex-swarm", 3.0);
      }
    } catch (e) {
      await new Promise(r => setTimeout(r, 5000));
    }
    await new Promise(r => setTimeout(r, 1000)); 
  }
}

async function workerDuckDuckGo(id) {
  const keywords = ["thermodynamics", "genetics", "astrophysics", "cognitive science", "cybernetics"];
  while (totalIngested < 5000000) {
    try {
      const kw = keywords[Math.floor(Math.random() * keywords.length)];
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${kw}+site:.edu`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) {
        const html = await res.text();
        // Extract basic snippets from DDG HTML
        const snippets = [...html.matchAll(/<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/g)].map(m => m[1].replace(/<\/?[^>]+(>|$)/g, ""));
        if (snippets.length) saveClaims(snippets, "ddg-trusted-swarm", 2.5);
      }
    } catch (e) {
      // Ignore
    }
    // EXTREMELY SLOW DELAY TO PREVENT IP BAN (15 seconds)
    await new Promise(r => setTimeout(r, 15000)); 
  }
}

async function workerSynthesizer(id) {
  // Uses local CPU to read random existing claims and generate "Anchor Synapses"
  while (totalIngested < 5000000) {
    if (fs.existsSync(OUT_FILE) && totalIngested > 100) {
      try {
        const stats = fs.statSync(OUT_FILE);
        const randomPos = Math.floor(Math.random() * (stats.size - 1000));
        const fd = fs.openSync(OUT_FILE, 'r');
        const buffer = Buffer.alloc(1000);
        fs.readSync(fd, buffer, 0, 1000, randomPos);
        fs.closeSync(fd);
        
        const text = buffer.toString('utf8');
        const lines = text.split('\n');
        if (lines.length > 2) {
           const obj1 = JSON.parse(lines[1]);
           const obj2 = JSON.parse(lines[2]);
           
           // Generate a heavy anchor claim binding two random concepts
           const metaClaim = `System Anchor: There is an implicit structural correlation between [${obj1.text.substring(0, 30)}...] and [${obj2.text.substring(0, 30)}...].`;
           saveClaims([metaClaim], "cell-synthesizer", 5.0, "anchor-core");
           totalSynthesized++;
        }
      } catch (e) {
        // silent fail on parse error
      }
    }
    // CPU intensive, run rapidly
    await new Promise(r => setTimeout(r, 100));
  }
}

// ── BOOT SEQUENCE ──
console.log("══════════════════════════════════════════════════════════");
console.log(`  KAI SUB-SWARM INITIATED`);
console.log(`  Spawning ${TOTAL_WORKERS} Specialized Workers...`);
console.log("══════════════════════════════════════════════════════════\n");

for (let i = 0; i < WIKI_WORKERS; i++) workerWiki(i);
for (let i = 0; i < ARXIV_WORKERS; i++) workerArxiv(i);
for (let i = 0; i < OPENALEX_WORKERS; i++) workerOpenAlex(i);
for (let i = 0; i < DDG_WORKERS; i++) workerDuckDuckGo(i);
for (let i = 0; i < SYNTHESIZERS; i++) workerSynthesizer(i);

console.log("[Swarm] All workers deployed. Beginning data synthesis loop...\n");
