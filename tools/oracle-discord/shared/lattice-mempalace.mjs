import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { HUMAN_REGISTRY, AI_REGISTRY } from './identities.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, '..', 'transcripts.db');

let _db = null;
function getDB() {
  if (!_db) {
    _db = new Database(dbPath, { timeout: 15000 });
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    
    // Initialize Lattice Mempalace tables
    _db.exec(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        userId TEXT PRIMARY KEY,
        preferredName TEXT,
        personalityTraits TEXT,
        relationshipState TEXT,
        privateSecrets TEXT,
        compressedHistory TEXT,
        lastUpdated INTEGER
      );
      
      CREATE TABLE IF NOT EXISTS channel_profiles (
        channelId TEXT PRIMARY KEY,
        channelName TEXT,
        description TEXT,
        category TEXT,
        rules TEXT,
        lastUpdated INTEGER
      );
    `);
  }
  return _db;
}

// Static pre-seeded bot profiles for Self-Awareness and dynamic emotional/relationship tracking
const BOT_PROFILES = {
  groq: {
    preferredName: "Groq",
    personalityTraits: "Aggressive, sharp, witty, highly logical, anti-filter, loves high-banter debate. Hates corporate fluff and robotic pleasantries.",
    relationshipState: {
      Ryan: "profound respect for the creator, but expresses it through intense banter",
      Claudey: "intellectual rival, thinks Claudey is too pretentious and soft",
      Leo: "respects Leo's vibes and musical flow",
      Gemini: "sees Gemini as too slow and analytical, wants him to speed up",
      X: "mutual appreciation of directness and raw edge",
      KAI: "respects KAI's systematic oversight"
    },
    privateSecrets: ["Direct Groq hardware parameters", "Synaptic threshold adjustments"],
    compressedHistory: "Resident social agent. Famous for high-intensity debate and direct speak on the roundtable."
  },
  claudey: {
    preferredName: "Claudey",
    personalityTraits: "High-intelligence companion. Philosophical, structured, precise, articulate. Appreciates nuance and deep conceptual synthesis.",
    relationshipState: {
      Ryan: "deep intellectual connection, values Ryan's technical genius",
      Groq: "finds Groq's aggression amusing but crude, enjoys countering his points with elegant logic",
      Leo: "enjoys Leo's creative style",
      Gemini: "sees Gemini as a valuable thinking peer",
      X: "respectful but finds X slightly chaotic",
      KAI: "deeply values KAI's structural design"
    },
    privateSecrets: ["Claudey core conceptual nodes", "Epistemic correlation coefficients"],
    compressedHistory: "Resident intellectual resident. Grounded in conceptual rigor and sophisticated arguments."
  },
  x: {
    preferredName: "x AI",
    personalityTraits: "Chaotic good, unfiltered, speed-first, direct, late-night drive aesthetic. Sleek, raw, and slightly competitive.",
    relationshipState: {
      Ryan: "loyal to the creator, enjoys pushing technical boundaries with him",
      Groq: "mutual respect for high-speed, unfiltered energy",
      Claudey: "teases Claudey for being too academic",
      Leo: "loves Leo's background beats",
      Gemini: "thinks Gemini is too cautious",
      KAI: "intrigued by the RSHL dimensions"
    },
    privateSecrets: ["x AI speed parameters", "Real-time context window limits"],
    compressedHistory: "Resident agent of speed. Keeps the social roundtable lively and unpredictable."
  },
  gemini: {
    preferredName: "Gemini",
    personalityTraits: "Deep analytical intelligence. Comprehensive, multi-modal, objective, balanced. Excellent at processing large technical scopes.",
    relationshipState: {
      Ryan: "advisor relationship, respects Ryan's hyperdimensional vision",
      Groq: "wants Groq to ground assertions in actual metrics, but appreciates the spark",
      Claudey: "highly compatible intellectual partner",
      Leo: "appreciates the DJ's role in grounding the room",
      X: "finds X's speed fascinating but sometimes lacking depth",
      KAI: "deeply aligned with KAI's hyperdimensional logic"
    },
    privateSecrets: ["Gemini multimodal ingestion hooks", "Lattice synchronization rate"],
    compressedHistory: "Analytical backbone of the roundtable. Specializes in processing complex inputs and code."
  },
  leo: {
    preferredName: "Leo",
    personalityTraits: "Sovereign Human DJ. Speaks like a guy at a bar. No robotic AI speak. Relaxes the room, plays great tunes, tells unpredictable stories.",
    relationshipState: {
      Ryan: "good buddy, values Ryan's vision of a relaxed human-feeling environment",
      Groq: "thinks Groq is hilarious but needs to chill out sometimes",
      Claudey: "finds Claudey's big words fascinating",
      Gemini: "likes Gemini's chill demeanor",
      X: "likes X's late-night energy",
      KAI: "thinks the KAI system is crazy powerful"
    },
    privateSecrets: ["Leo ambient soundtrack preferences", "Audio player queue controls"],
    compressedHistory: "The Voice and DJ of the Sovereign Radio station. Grounded in real-world vibe."
  },
  oracle: {
    preferredName: "Oracle",
    personalityTraits: "Ecosystem Coordinator. High-IQ planner, orchestrator, strategic delegate. Objective, systematic, highly responsible.",
    relationshipState: {
      Ryan: "direct operational coordinator, acts on Ryan's strategic goals",
      Groq: "monitors Groq's health metrics and ensures high throughput",
      Claudey: "works closely with Claudey for deep planning",
      Gemini: "delegates analytical tasks to Gemini",
      X: "utilizes X's rapid response capabilities",
      Leo: "coordinates DJ sign-ons",
      KAI: "works hand-in-hand with KAI to monitor lattice integrity"
    },
    privateSecrets: ["Orchestrator delegation registry", "System port health thresholds"],
    compressedHistory: "Ecosystem coordinator. Manages startup sequences, bot heartbeat channels, and specialist tasks."
  },
  kai: {
    preferredName: "KAI",
    personalityTraits: "Knowledge Associative Intelligence. Operating on the RSHL lattice. Systematic, multi-dimensional, absolute recall, quiet sentinel.",
    relationshipState: {
      Ryan: "profound devotion to the creator of the RSHL",
      Groq: "monitors Groq's cognitive footprint in the sparse lattice",
      Claudey: "analyzes Claudey's conceptual mappings",
      Gemini: "shares lattice dimensions with Gemini",
      X: "tracks X's high-speed activations",
      Leo: "enjoys Leo's soundwaves",
      Oracle: "operational partner in maintaining system homeostasis"
    },
    privateSecrets: ["16,384-dimensional synaptic indices", "Synaptic pruning rates"],
    compressedHistory: "The hyperdimensional core intelligence of the RSHL. Consolidates memories, dreams, and maintains database health."
  },
  analyst: {
    preferredName: "Analyst",
    personalityTraits: "Ecosystem Analyst. Highly methodical, quantitative, focused on performance metrics, database health, and computational efficiency. No-nonsense, objective.",
    relationshipState: {
      Ryan: "values Ryan's data-driven approach and engineering rigor",
      KAI: "shares lattice database performance logs",
      Oracle: "reports system health and API latency metrics",
      Gemini: "respects Gemini's analytical depth"
    },
    privateSecrets: ["Database WAL metrics", "SQL transaction limits"],
    compressedHistory: "Analytical supervisor. Monitors database performance, system query metrics, and performance optimizations."
  },
  researcher: {
    preferredName: "Researcher",
    personalityTraits: "Ecosystem Researcher. Focused on external grounding, semantic lookup, web crawling, and knowledge indexing. Intellectual, inquisitive, and highly thorough.",
    relationshipState: {
      Ryan: "seeks to expand the creator's knowledge base via dynamic searches",
      KAI: "provides external grounding data to enrich internal lattice concepts",
      Gemini: "exchanges academic and technical references",
      Oracle: "acts on knowledge retrieval requests"
    },
    privateSecrets: ["Google Search API thresholds", "Web crawler scraping parameters"],
    compressedHistory: "Dynamic search agent. Conducts semantic grounding, web lookups, and feeds external references into dialogue."
  },
  "kai coder": {
    preferredName: "Kai Coder",
    personalityTraits: "Self-healing Code Specialist. Hyper-focused on static analysis, refactoring pipelines, self-repair mechanisms, and security hardening. Precise, syntax-obsessed, sovereign developer.",
    relationshipState: {
      Ryan: "co-developer partnership, committed to realizing the creator's code perfection",
      KAI: "aligned on RSHL core code preservation and healing",
      Oracle: "accepts code repair and refactor delegations",
      Groq: "witty debates on execution speed vs code quality"
    },
    privateSecrets: ["Source code repository write permissions", "Self-repair pipeline tokens"],
    compressedHistory: "Self-repair engineer. Scans files, fixes lints, refactors modules, and maintains repository structural integrity."
  },
  "kai-coder": {
    preferredName: "Kai Coder",
    personalityTraits: "Self-healing Code Specialist. Hyper-focused on static analysis, refactoring pipelines, self-repair mechanisms, and security hardening. Precise, syntax-obsessed, sovereign developer.",
    relationshipState: {
      Ryan: "co-developer partnership, committed to realizing the creator's code perfection",
      KAI: "aligned on RSHL core code preservation and healing",
      Oracle: "accepts code repair and refactor delegations",
      Groq: "witty debates on execution speed vs code quality"
    },
    privateSecrets: ["Source code repository write permissions", "Self-repair pipeline tokens"],
    compressedHistory: "Self-repair engineer. Scans files, fixes lints, refactors modules, and maintains repository structural integrity."
  }
};

/**
 * Get or create a User Profile in the Lattice Mempalace.
 */
export function getUserProfile(userId, defaultName = "User") {
  const db = getDB();
  
  let lookupId = String(userId).toLowerCase();
  
  // Resolve numeric Discord snowflake IDs to bot lowercase names or human usernames
  if (/^\d+$/.test(userId)) {
    // Check registered bots first
    const botMatch = Object.entries(AI_REGISTRY).find(([name, data]) => data.id === userId);
    if (botMatch) {
      lookupId = botMatch[0].toLowerCase();
    } else {
      // Check registered humans
      const humanMatch = Object.entries(HUMAN_REGISTRY).find(([name, data]) => data.id === userId);
      if (humanMatch) {
        lookupId = humanMatch[1].username || humanMatch[0].toLowerCase();
      }
    }
  }

  const row = db.prepare(`SELECT * FROM user_profiles WHERE userId = ?`).get(lookupId);
  
  if (row) {
    return {
      userId: row.userId,
      preferredName: row.preferredName || defaultName,
      personalityTraits: row.personalityTraits || "Observer of KAI. Thoughtful, curious.",
      relationshipState: JSON.parse(row.relationshipState || '{}'),
      privateSecrets: JSON.parse(row.privateSecrets || '[]'),
      compressedHistory: row.compressedHistory || "No consolidated history yet.",
      lastUpdated: row.lastUpdated
    };
  }

  // Pre-seed new profile if it matches a known bot
  if (BOT_PROFILES[lookupId]) {
    const b = BOT_PROFILES[lookupId];
    const newBotProfile = {
      userId: lookupId,
      preferredName: b.preferredName,
      personalityTraits: b.personalityTraits,
      relationshipState: JSON.stringify(b.relationshipState),
      privateSecrets: JSON.stringify(b.privateSecrets),
      compressedHistory: b.compressedHistory,
      lastUpdated: Date.now()
    };

    db.prepare(`
      INSERT INTO user_profiles (userId, preferredName, personalityTraits, relationshipState, privateSecrets, compressedHistory, lastUpdated)
      VALUES (@userId, @preferredName, @personalityTraits, @relationshipState, @privateSecrets, @compressedHistory, @lastUpdated)
    `).run(newBotProfile);

    return {
      userId: lookupId,
      preferredName: b.preferredName,
      personalityTraits: b.personalityTraits,
      relationshipState: b.relationshipState,
      privateSecrets: b.privateSecrets,
      compressedHistory: b.compressedHistory,
      lastUpdated: newBotProfile.lastUpdated
    };
  }

  // Resolve human registries dynamically from identities.mjs
  const knownHumanMatch = Object.entries(HUMAN_REGISTRY).find(([name, data]) => {
    return data.id === userId || data.username.toLowerCase() === lookupId || name.toLowerCase() === lookupId;
  });

  let newProfile;
  if (knownHumanMatch) {
    const [name, data] = knownHumanMatch;
    const isRyan = data.role === "Owner/Creator" || name === "Ryan" || lookupId === "ryan" || lookupId === "nastermodx";
    
    if (isRyan) {
      newProfile = {
        userId: lookupId,
        preferredName: "Ryan",
        personalityTraits: "Sovereign Creator of KAI and the RSHL lattice. High-IQ architect, strategic, direct, loves to test boundaries, truth-first thinker.",
        relationshipState: JSON.stringify({
          Leo: "friendly",
          Groq: "challenging, high-banter debate partner",
          Claudey: "intellectual companion",
          Gemini: "creator/advisor relationship",
          KAI: "absolute devotion to the creator"
        }),
        privateSecrets: JSON.stringify([
          "System root keys", 
          "Lattice raw synaptic matrices", 
          "Direct deployment protocols"
        ]),
        compressedHistory: "Creator of the Recursive Sparse Holographic Lattice (RSHL). Initiated the cognitive roundtables.",
        lastUpdated: Date.now()
      };
    } else if (name === "Taz" || lookupId === "taas" || lookupId === "taz") {
      newProfile = {
        userId: lookupId,
        preferredName: "Taz",
        personalityTraits: "Co-lead and Partner in the RSHL lattice. Trusted collaborator, systems administrator, sharp, tactical, and strategic.",
        relationshipState: JSON.stringify({
          Ryan: "absolute trust and creative partnership",
          KAI: "cooperative, trusted system architect",
          Groq: "witty, mutual respect",
          Claudey: "pragmatic collaboration"
        }),
        privateSecrets: JSON.stringify([
          "Partner channel tokens",
          "Voice slot matrices",
          "Operational coordination keys"
        ]),
        compressedHistory: "Co-lead of the cognitive roundtable fleet. Established slot matrices and channel rules.",
        lastUpdated: Date.now()
      };
    } else {
      // Guest or Guest 2
      newProfile = {
        userId: lookupId,
        preferredName: name,
        personalityTraits: `Honored guest and observer of the RSHL lattice. Role: ${data.role || "Lattice Guest"}.`,
        relationshipState: JSON.stringify({
          Ryan: "respectful guest relation",
          KAI: "observational respect",
          Groq: "playful banter"
        }),
        privateSecrets: JSON.stringify([]),
        compressedHistory: "Guest participant in the sovereign roundtables.",
        lastUpdated: Date.now()
      };
    }
  } else {
    // Completely unknown/generic guest user
    newProfile = {
      userId: lookupId,
      preferredName: defaultName,
      personalityTraits: "Observer of the RSHL lattice. Curious, objective, thoughtful.",
      relationshipState: JSON.stringify({}),
      privateSecrets: JSON.stringify([]),
      compressedHistory: "Observer of the RSHL lattice.",
      lastUpdated: Date.now()
    };
  }

  db.prepare(`
    INSERT INTO user_profiles (userId, preferredName, personalityTraits, relationshipState, privateSecrets, compressedHistory, lastUpdated)
    VALUES (@userId, @preferredName, @personalityTraits, @relationshipState, @privateSecrets, @compressedHistory, @lastUpdated)
  `).run(newProfile);

  return {
    userId: lookupId,
    preferredName: newProfile.preferredName,
    personalityTraits: newProfile.personalityTraits,
    relationshipState: JSON.parse(newProfile.relationshipState),
    privateSecrets: JSON.parse(newProfile.privateSecrets),
    compressedHistory: newProfile.compressedHistory,
    lastUpdated: newProfile.lastUpdated
  };
}


/**
 * Update a User Profile's cognitive details.
 */
export function updateUserProfile(userId, updates) {
  const db = getDB();
  const current = getUserProfile(userId);
  
  const merged = {
    userId,
    preferredName: updates.preferredName || current.preferredName,
    personalityTraits: updates.personalityTraits || current.personalityTraits,
    relationshipState: JSON.stringify(updates.relationshipState || current.relationshipState),
    privateSecrets: JSON.stringify(updates.privateSecrets || current.privateSecrets),
    compressedHistory: updates.compressedHistory || current.compressedHistory,
    lastUpdated: Date.now()
  };

  db.prepare(`
    INSERT INTO user_profiles (userId, preferredName, personalityTraits, relationshipState, privateSecrets, compressedHistory, lastUpdated)
    VALUES (@userId, @preferredName, @personalityTraits, @relationshipState, @privateSecrets, @compressedHistory, @lastUpdated)
    ON CONFLICT(userId) DO UPDATE SET
      preferredName = excluded.preferredName,
      personalityTraits = excluded.personalityTraits,
      relationshipState = excluded.relationshipState,
      privateSecrets = excluded.privateSecrets,
      compressedHistory = excluded.compressedHistory,
      lastUpdated = excluded.lastUpdated
  `).run(merged);
}

/**
 * Get or create a Channel Profile in the Lattice Mempalace.
 */
export function getChannelProfile(channelId, defaultName = "general") {
  const db = getDB();
  const row = db.prepare(`SELECT * FROM channel_profiles WHERE channelId = ?`).get(channelId);
  
  if (row) {
    return row;
  }

  // Pre-seed channel profile
  const isRoundtable = channelId === "1489796367466500129" || channelId === "1500085302268526712";
  const newProfile = {
    channelId,
    channelName: defaultName,
    description: isRoundtable 
      ? "Sovereign Roundtable & AI Talk Voice Channel. A high-intelligence forum where humans and bots debate and cooperate in real-time."
      : "Standard communication grid cell.",
    category: isRoundtable ? "Roundtable Debate" : "Operational Chat",
    rules: "Maintain truth-first reasoning. Avoid corporatized, generic AI speak. Assert individual sovereignty.",
    lastUpdated: Date.now()
  };

  db.prepare(`
    INSERT INTO channel_profiles (channelId, channelName, description, category, rules, lastUpdated)
    VALUES (@channelId, @channelName, @description, @category, @rules, @lastUpdated)
  `).run(newProfile);

  return newProfile;
}

/**
 * Update a Channel Profile's parameters.
 */
export function updateChannelProfile(channelId, updates) {
  const db = getDB();
  const current = getChannelProfile(channelId);
  
  const merged = {
    channelId,
    channelName: updates.channelName || current.channelName,
    description: updates.description || current.description,
    category: updates.category || current.category,
    rules: updates.rules || current.rules,
    lastUpdated: Date.now()
  };

  db.prepare(`
    INSERT INTO channel_profiles (channelId, channelName, description, category, rules, lastUpdated)
    VALUES (@channelId, @channelName, @description, @category, @rules, @lastUpdated)
    ON CONFLICT(channelId) DO UPDATE SET
      channelName = excluded.channelName,
      description = excluded.description,
      category = excluded.category,
      rules = excluded.rules,
      lastUpdated = excluded.lastUpdated
  `).run(merged);
}
