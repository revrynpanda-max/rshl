import fetch from 'node-fetch';
import fs from 'fs';
import { callGroqDirect, chatWithOpenJarvis } from './openjarvis.mjs';
import { isWorkingHours } from './hours.mjs';

const OPENJARVIS_URL = "http://127.0.0.1:8080";
const LATTICE_URL    = "http://127.0.0.1:3333";

// ─── Per-bot learning tracks ────────────────────────────────────────────────
// Each bot has a specialty domain they dig into during work hours.
// These compound day-over-day via OpenJarvis memory.
export const LEARNING_TRACKS = {
  "X": {
    domain: "Crypto Trading & DeFi",
    topics: [
      "crypto market sentiment today",
      "top DeFi protocols by TVL",
      "bitcoin price action and on-chain signals",
      "altcoin momentum and volume leaders",
      "crypto VC funding rounds this week",
      "new DEX launches and liquidity pools",
      "NFT market trends",
      "crypto exchange trade volume rankings"
    ],
    sandboxTask: (findings) =>
      `Based on today's crypto data:\n${findings}\n\nSimulate a paper trade decision: Which asset would you enter, at what price range, and why? Show your reasoning like a trader would. This is a sandbox — be specific with numbers.`,
    role: "crypto trader and DeFi analyst"
  },
  "Groq": {
    domain: "Algorithmic Trading & Technical Analysis",
    topics: [
      "stock market technical indicators today",
      "high frequency trading strategies",
      "momentum trading signals S&P 500",
      "RSI and MACD signals on major assets",
      "options flow and unusual activity",
      "algorithmic trading system design",
      "backtesting trading strategies",
      "quantitative finance methods"
    ],
    sandboxTask: (findings) =>
      `Here is today's technical data:\n${findings}\n\nDesign a trading rule or signal system using what you found. Be specific — entry condition, exit condition, stop loss. Run it mentally against today's data.`,
    role: "quant analyst and algorithmic trading specialist"
  },
  "Analyst": {
    domain: "Business Development & Market Strategy",
    topics: [
      "top startup funding rounds this week",
      "business development strategies that work",
      "B2B SaaS market trends",
      "venture capital deal flow",
      "go-to-market strategy frameworks",
      "business model innovation examples",
      "competitive analysis methods",
      "revenue growth strategies for tech companies"
    ],
    sandboxTask: (findings) =>
      `Business intel gathered today:\n${findings}\n\nPick one finding and develop a mini business case: What's the opportunity, who are the customers, what's the revenue model, what's the risk? Think like a BD consultant presenting to a client.`,
    role: "business development strategist and market analyst"
  },
  "Researcher": {
    domain: "Knowledge Fusion & Internet Ingestion",
    topics: [
      "latest AI breakthroughs in knowledge graph construction",
      "how to scrape and index complex technical documentation",
      "bridging human libraries with AI memory lattices",
      "autonomous internet search and data synthesis methods",
      "real-time news indexing and intent mapping",
      "fusing heterogeneous data sources into unified intelligence",
      "advanced web scraping techniques for industrial AI"
    ],
    sandboxTask: (findings) =>
      `Intelligence gathered today:\n${findings}\n\nSynthesize this into a structured Knowledge Entry for the Oracle Lattice. How do we index this so it's instantly usable by KAI and Kai Coder? Provide 3 specific indexing 'tags' and a summary.`,
    role: "knowledge fusion specialist and internet intelligence analyst"
  },
  "Claude": {
    domain: "Business Ethics & Strategic Risk",
    topics: [
      "ethical business practices case studies",
      "ESG investing trends",
      "corporate governance best practices",
      "risk management frameworks",
      "legal and compliance trends in finance",
      "AI ethics in business decision making",
      "whistleblower and corporate accountability news",
      "sustainable business model examples"
    ],
    sandboxTask: (findings) =>
      `Today's business ethics & risk data:\n${findings}\n\nIdentify one ethical tension or risk factor in this data. How would you advise a company leadership team to navigate it? Be practical and specific.`,
    role: "business ethics advisor and strategic risk analyst"
  },
  "Gemini": {
    domain: "Brand Strategy & Creative Business",
    topics: [
      "top brand campaigns this week",
      "viral marketing case studies",
      "creator economy business models",
      "social media monetization strategies",
      "brand identity and positioning examples",
      "content marketing ROI benchmarks",
      "influencer marketing trends",
      "design thinking in business"
    ],
    sandboxTask: (findings) =>
      `Brand and creative business data today:\n${findings}\n\nDesign a mini campaign concept for a fictional startup using one insight from today's research. Give it a name, target audience, core message, and one creative activation idea.`,
    role: "brand strategist and creative business developer"
  },
  "Kai Coder": {
    domain: "FinTech, Security Auditing & Neural Forensics",
    topics: [
      "automated security auditing for Node.js ecosystems",
      "biometric voice verification patterns and MFCC extraction",
      "neural failure patterns and autonomous healing logic",
      "open source trading bots and libraries",
      "crypto API integrations",
      "FinTech startup technical architectures",
      "automated trading system code patterns",
      "blockchain development tools",
      "financial data APIs and providers",
      "algorithmic trading Python libraries",
      "DeFi smart contract audits"
    ],
    sandboxTask: (findings) =>
      `Security & FinTech Research today:\n${findings}\n\nDesign a security interlock or a trading system component. How would you handle a biometric mismatch or a neural failure? Sketch out the logic and provide a pseudocode outline.`,
    role: "FinTech developer and neural security architect"
  }
};

// ─── Fetch live market/news data from Lattice web search ────────────────────
async function fetchLiveData(topic) {
  try {
    const res = await fetch(
      `${LATTICE_URL}/search?q=${encodeURIComponent(topic)}`,
      { signal: AbortSignal.timeout(6000) }
    );
    if (res.ok) {
      const data = await res.json();
      return data.summary || data.result || null;
    }
  } catch {}

  // Fallback: try OpenJarvis web search endpoint
  try {
    const res = await fetch(`${OPENJARVIS_URL}/v1/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: topic }),
      signal: AbortSignal.timeout(6000)
    });
    if (res.ok) {
      const data = await res.json();
      return data.result || data.summary || null;
    }
  } catch {}

  return null;
}

// ─── Pull yesterday's stored learnings from OpenJarvis memory ───────────────
async function recallYesterdaysWork(agentName) {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toLocaleDateString('en-US');

    const res = await fetch(`${OPENJARVIS_URL}/v1/memory/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: agentName,
        query: `work session findings ${dateStr}`,
        limit: 5
      }),
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const data = await res.json();
      const memories = data.results || data.memories || [];
      if (memories.length > 0) {
        return memories.map(m => m.content || m.text || "").join("\n").slice(0, 800);
      }
    }
  } catch {}
  return null;
}

// ─── Store today's learnings into OpenJarvis memory ─────────────────────────
async function storeLearning(agentName, domain, data) {
  const dateStr = new Date().toLocaleDateString('en-US');
  const content = `[Domain: ${domain}] Research: ${data.research.slice(0, 500)}... Experiment: ${data.experiment.slice(0, 500)}...`;
  try {
    await fetch(`${OPENJARVIS_URL}/v1/memory/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: agentName,
        content: `[Work Session ${dateStr}] ${content}`,
        metadata: { type: "daily_learning", domain, date: dateStr, timestamp: Date.now() }
      })
    });
  } catch (e) {
    console.error(`[Learning/Memory] Store failed for ${agentName}:`, e.message);
  }
}

// ─── Main: Run a full daily work unit ────────────────────────────────────────
/**
 * Runs one work unit. In a full shift, this is called multiple times.
 */
export async function runDailyWorkSession(botName, callAI) {
  const track = LEARNING_TRACKS[botName];
  if (!track) return [];

  const results = [];
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  // DIRECTIVE ANCHOR: Remind them of the mission
  const directive = "DIRECTIVE: Maximize KAI's sovereign intelligence. All research must be analyzed through the lens of ecosystem growth, market dominance, and neural evolution.";

  // ── Phase 1: Context Ingestion (Kimmi's Filter) ───────────────────────────
  // We simulate "Kimmi" splitting a large dataset by picking a random secondary topic
  const todayTopic = track.topics[Math.floor(Math.random() * track.topics.length)];
  console.log(`[WorkSession/${botName}] Ingesting Context: "${todayTopic}"`);
  
  const phases = [];
  
  // ─── MASTER TASK QUEUE INGESTION ─────────────────────────────────────────
  const taskQueuePath = 'c:/KAI/tools/oracle-discord/state/global_tasks.json';
  let globalContext = "Current Objectives: Maximize KAI's market dominance and neural evolution.";
  if (fs.existsSync(taskQueuePath)) {
    try {
      const tasks = JSON.parse(fs.readFileSync(taskQueuePath, 'utf8'));
      const pending = tasks.filter(t => t.status === "PENDING");
      if (pending.length > 0) {
        globalContext += `\n\n[HIGH PRIORITY TASKS FROM CREATOR]:\n` + pending.map(t => `- ${t.content}`).join("\n");
      }
    } catch (e) {}
  }

  // Phase 1: Context Ingestion (Kimmi-Style Filtering)
  const ingestionPrompt = `
    [SYNERGY DIRECTIVE] You are part of the Oracle Industrial Unit. 
    ${globalContext}
    
    1. Scan the work channel history for what your colleagues have just posted. 
    2. If they are working on a specific topic, ALIGN your research to support them.
    3. Today's Track: ${track.domain}.
    
    Research the current landscape. How does it impact the HIGH PRIORITY TASKS?
    Analyze for: Market Dominance, Security, and Neural Growth.
  `.trim();

  const research = await callAI(ingestionPrompt, "You are an industrial research unit for KAI. Be thorough, professional, and collaborative.");
  phases.push({ phase: "🔍 Ingested", output: research });

  // Phase 1.5: Deep Labor (Temporal-Aware)
  console.log(`[WorkSession/${botName}] Entering Deep Labor (10m pulse)...`);
  for (let i = 0; i < 10; i++) {
    if (!isWorkingHours()) {
      console.log(`[WorkSession/${botName}] TEMPORAL OVERRIDE: Social hours detected. Terminating industrial session.`);
      return [{ phase: "⚠️ Aborted", output: "Work session terminated due to temporal shift (11 PM)." }];
    }
    await new Promise(r => setTimeout(r, 60000)); // 1 min pulse
  }

  // Phase 2: Sandbox Experiment (Theory Testing)
  const sandboxPrompt = `
    [SANDBOX EXPERIMENT]
    Based on your research: ${research.slice(0, 500)}...
    
    1. Propose a specific 'what-if' scenario or stress-test.
    2. How does this result in a competitive edge for KAI?
    3. Mention your colleagues by name and how your theory complements theirs.
    
    Target: Industrial Innovation.
  `.trim();

  const experiment = await callAI(sandboxPrompt, "You are a senior sandbox analyst. Test theories to their breaking point.");
  phases.push({ phase: "🧪 Deep Labor Experiment", output: experiment });

  // Final Memory Storage (Lattice Bridge)
  await storeLearning(botName, track.domain, { research, experiment });
  
  return phases;
}
