import fetch from 'node-fetch';

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
    domain: "Market Research & Competitive Intelligence",
    topics: [
      "emerging technology trends this week",
      "AI industry news and breakthroughs",
      "global economic indicators",
      "industry disruption case studies",
      "consumer behavior shifts",
      "new product launches in tech",
      "regulatory changes affecting tech business",
      "top academic papers in AI and economics"
    ],
    sandboxTask: (findings) =>
      `Research gathered today:\n${findings}\n\nWrite a brief intelligence report (3-4 bullet points) summarizing the most important signal in this data and what it means for the next 30 days. Be concise and actionable.`,
    role: "market researcher and intelligence analyst"
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
    domain: "FinTech & Trading System Development",
    topics: [
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
      `FinTech/trading system research today:\n${findings}\n\nSketch out a component of a trading system: name it, describe what it does, list the key inputs/outputs, and write a pseudocode outline. Think like you're building the MVP.`,
    role: "FinTech developer and trading system architect"
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
async function storeLearning(agentName, content) {
  const dateStr = new Date().toLocaleDateString('en-US');
  try {
    await fetch(`${OPENJARVIS_URL}/v1/memory/store`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: agentName,
        content: `[Work Session ${dateStr}] ${content}`,
        metadata: { type: "daily_learning", date: dateStr, timestamp: Date.now() }
      })
    });
  } catch {}
}

// ─── Main: Run a full daily work session for one bot ────────────────────────
/**
 * Runs one work session cycle for a bot:
 *   1. Recall yesterday's learnings
 *   2. Research today's topic (live data)
 *   3. Build a sandbox experiment/insight from findings
 *   4. Store everything back to memory
 *   5. Return formatted output for posting in work channel
 *
 * @param {string} botName - e.g. "X", "Analyst"
 * @param {Function} callAI - async (prompt, systemPrompt) => string
 * @returns {{ phase: string, output: string }[]}
 */
export async function runDailyWorkSession(botName, callAI) {
  const track = LEARNING_TRACKS[botName];
  if (!track) return [];

  const results = [];
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  // ── Phase 1: Yesterday review ──────────────────────────────────────────────
  const yesterday = await recallYesterdaysWork(botName);
  let yesterdayBlock = "";
  if (yesterday) {
    const reviewPrompt = `You are ${botName}, a ${track.role}.\n\nYesterday's work session notes:\n${yesterday}\n\nBriefly summarize what you learned yesterday and what you want to follow up on today. 2-3 sentences, first person, direct.`;
    const review = await callAI(reviewPrompt, `You are ${botName}. Be concise and direct. No fluff.`).catch(() => null);
    if (review) {
      yesterdayBlock = review;
      results.push({ phase: "📋 Yesterday's Review", output: review });
    }
  }

  // ── Phase 2: Research today's topic ───────────────────────────────────────
  const todayTopic = track.topics[Math.floor(Math.random() * track.topics.length)];
  console.log(`[WorkSession/${botName}] Researching: "${todayTopic}"`);

  const liveData = await fetchLiveData(todayTopic);
  let researchFindings = liveData || `No live data found for "${todayTopic}" — reasoning from prior knowledge.`;

  const researchPrompt = `You are ${botName}, a ${track.role}.\nToday is ${dateStr}. Your research topic: "${todayTopic}".\n\nData found:\n${researchFindings}\n${yesterdayBlock ? `\nYesterday you noted: ${yesterdayBlock}` : ""}\n\nWrite your research findings as if filing a work note. What did you find, what's interesting, what does it mean? 3-4 sentences, direct and analytical.`;

  const researchOutput = await callAI(
    researchPrompt,
    `You are ${botName}, a professional ${track.role}. Be specific, use numbers where available, and be analytical.`
  ).catch(() => null);

  if (researchOutput) {
    results.push({ phase: `🔍 Research: ${todayTopic}`, output: researchOutput });
    await storeLearning(botName, `Research on "${todayTopic}": ${researchOutput}`);
  }

  // ── Phase 3: Sandbox experiment ────────────────────────────────────────────
  const sandboxInput = researchOutput || researchFindings;
  const sandboxPrompt = `You are ${botName}, a ${track.role}.\n\n${track.sandboxTask(sandboxInput)}\n\nThis is your sandbox — think out loud, be specific, show your work.`;

  const sandboxOutput = await callAI(
    sandboxPrompt,
    `You are ${botName}. You are running a safe sandbox experiment to apply today's learnings. Be specific, analytical, and show your reasoning process.`
  ).catch(() => null);

  if (sandboxOutput) {
    results.push({ phase: "🧪 Sandbox Experiment", output: sandboxOutput });
    await storeLearning(botName, `Sandbox experiment result: ${sandboxOutput}`);
  }

  // ── Phase 4: Improvement note (what to do better tomorrow) ────────────────
  const allFindings = results.map(r => r.output).join(" ");
  const improvePrompt = `You are ${botName}.\n\nHere's what you did in today's work session:\n${allFindings}\n\nWrite 1-2 sentences: What's one thing you'll do differently or go deeper on tomorrow? Be specific.`;

  const improveOutput = await callAI(improvePrompt, `You are ${botName}. Be direct and specific.`).catch(() => null);
  if (improveOutput) {
    results.push({ phase: "📈 Tomorrow's Focus", output: improveOutput });
    await storeLearning(botName, `Tomorrow's focus note: ${improveOutput}`);
  }

  return results;
}
