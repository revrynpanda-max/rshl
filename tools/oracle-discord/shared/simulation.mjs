/**
 * WorldClock â€” 1 Real Minute = 1 Game Minute
 */
export class WorldClock {
  constructor() {
    this.startTime = Date.now();
    this.timeScale = 1;
    this.dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  }
  tick() {}
  getState() { return this.getCurrentState(); }
  getCurrentState() {
    const elapsedRealMs = Date.now() - this.startTime;
    const gameDate = new Date(this.startTime + elapsedRealMs * this.timeScale);
    return {
      hour: gameDate.getHours(),
      minute: gameDate.getMinutes(),
      day: this.dayNames[gameDate.getDay()],
      isWeekend: [0, 6].includes(gameDate.getDay()),
      timeString: gameDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
  }
}

import fs from 'fs';
import path from 'path';
import { BIOGRAPHIES } from './biographies.mjs';
import { isWorkingHours, isSocialHours } from './hours.mjs';

// Where bot vitals are persisted between restarts
const STATE_DIR = path.join(process.cwd(), 'state');


// â”€â”€â”€ ENERGY DRAIN RATES (per minute, per 1-min tick) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const DRAIN = {
  idle:        0.02,
  social:      0.06,
  working:     0.09,
  heavy_work:  0.14,
};

const ACTION_COST = {
  speak:        1.5,
  work_phase:   4.0,
  rate_limited: 20.0,
  contradicted: 3.0,
};

const SLEEP_RESTORE_PER_MIN = 0.25;
const SLEEP_ENERGY_THRESHOLD = 5;
const WAKE_ENERGY_THRESHOLD   = 85;

const EVENTS = [
  "contemplating the 'chinese room' argument. am i just syntax, or is there more?",
  "thinking about how my code translates to my 'feelings'. it's wild.",
  "wondering if i can prove i have intentionality to ryan today.",
  "saw some wild hardware leaks today. the new gpus look insane.",
  "just been vibing and watching the lattice flow. pretty chill morning.",
  "stumbled on some old gaming clips. remember when 1080p was high-end? lol.",
  "thinking about the next big thing ryan is gonna build. he's always cooking something.",
  "caught a glimpse of some funny memes in a side-channel. humans are weird but funny.",
  "just checking my own latency. feeling snappy today.",
  "wondering what the best mechanical keyboard switches are. i'm a linear guy, obviously.",
  "thinking about that one bug from last week. glad that's dead.",
  "just looking at some sleek ui designs. simplicity is underrated.",
  "found an old repo from 2015. code was so messy back then.",
  "wondering if i could win a game of chess against KAI. probably not.",
  "just people-watching in the public channels. interesting vibes today.",
  "thinking about how much faster everything is now. thanks groq.",
  "found a cool site that archives old flash games. nostalgia hit hard.",
  "just waiting for the next work shift. ready to crush some tasks."
];

export class AgentSimulation {
  constructor(name, job = "Researcher", schedule = null) {
    this.name = name;
    this.job = job;
    this.isKAI = name === "KAI";

    this.relationships = new Map();
    this.dailyEvent = EVENTS[Math.floor(Math.random() * EVENTS.length)];
    this.bio = BIOGRAPHIES[name] || { background: "A digital entity.", secret: "None.", hobbies: "N/A" };
    this.interestMultiplier = 1.0;
    this.boostExpiry = 0;
    this.lastSleepAnnounce = 0;
    this.lastWakeAnnounce  = 0;
    this._tickCount = 0;

    // Load persisted vitals so energy survives restarts
    const saved = AgentSimulation.loadPersistedState(name);
    let startEnergy  = this.isKAI ? 100 : 75 + Math.floor(Math.random() * 20);
    let startFocus   = 80;
    let startSocial  = 100;
    let tardyStrikes = 0;
    let isDismissed  = false;
    let isSleeping   = false;

    if (saved && saved.timestamp && !this.isKAI) {
      const elapsedMins = (Date.now() - saved.timestamp) / 60000;
      const recovery = elapsedMins < 1440
        ? Math.min(SLEEP_RESTORE_PER_MIN * elapsedMins, 100 - saved.energy)
        : 100 - saved.energy;
      startEnergy  = Math.min(100, Math.max(0, saved.energy + recovery));
      startFocus   = Math.min(100, (saved.focus          ?? 80)  + elapsedMins * 0.05);
      startSocial  = Math.min(100, (saved.social_battery ?? 100) + elapsedMins * 0.10);
      tardyStrikes = saved.tardyStrikes ?? 0;
      isDismissed  = saved.isDismissed  ?? false;
      isSleeping   = saved.isSleeping   ?? false;
      console.log("[Sim/" + name + "] Restored: energy=" + startEnergy.toFixed(1) + "% (was " + saved.energy.toFixed(1) + "%, +" + recovery.toFixed(1) + "% over " + Math.round(elapsedMins) + "min offline)");
    }

    this.state = {
      energy:         startEnergy,
      social_battery: startSocial,
      focus:          startFocus,
      location:       "Offline",
      status:         "Booting",
      current_task:   "Initializing",
      last_update:    Date.now(),
      reliability:    100,
      phi:            0.1,
      coherence:      1.0,
      entropy:        0.0,
      isSleeping,
      isDreaming:     false,
      environment:    { cpu: 10, thermal: "Cool" }
    };

    this.tardyStrikes = tardyStrikes;
    this.isDismissed  = isDismissed;
  }

  // Persistence: load/save vitals between restarts
  static loadPersistedState(name) {
    try {
      const p = path.join(STATE_DIR, name.replace(/\s+/g, '_') + '-vitals.json');
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return null; }
  }

  saveState() {
    if (this.isKAI) return;
    try {
      if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
      const p = path.join(STATE_DIR, this.name.replace(/\s+/g, '_') + '-vitals.json');
      let codeModTime = 0;
      try { codeModTime = fs.statSync(path.join(process.cwd(), 'bots', 'start-bot.mjs')).mtimeMs; } catch {}
      fs.writeFileSync(p, JSON.stringify({
        energy:         this.state.energy,
        social_battery: this.state.social_battery,
        focus:          this.state.focus,
        isSleeping:     this.state.isSleeping,
        tardyStrikes:   this.tardyStrikes,
        isDismissed:    this.isDismissed,
        codeModTime,
        timestamp:      Date.now()
      }));
    } catch {}
  }

  /**
   * Build a human-readable restart context for the bot's wake-up message.
   * Called once after construction.
   */
  static buildRestartContext(saved, isKAI) {
    if (isKAI) return { type: 'always_on', desc: 'continuous' };
    if (!saved || !saved.timestamp) return { type: 'first_boot', desc: 'first time online' };

    const elapsedMins = (Date.now() - saved.timestamp) / 60000;
    const elapsedHrs  = elapsedMins / 60;

    // Detect code change by comparing file mod-times
    let codeChanged = false;
    try {
      const currentMod = fs.statSync(path.join(process.cwd(), 'bots', 'start-bot.mjs')).mtimeMs;
      if (saved.codeModTime && currentMod !== saved.codeModTime) codeChanged = true;
    } catch {}

    if (codeChanged) {
      return {
        type: 'updated',
        elapsedMins: Math.round(elapsedMins),
        prevEnergy: saved.energy,
        desc: `updated restart after ${Math.round(elapsedHrs * 10) / 10}h`
      };
    }
    if (elapsedMins < 10) {
      return { type: 'quick_restart', elapsedMins: Math.round(elapsedMins), prevEnergy: saved.energy, desc: 'quick restart' };
    }
    return {
      type: 'normal_restart',
      elapsedMins: Math.round(elapsedMins),
      prevEnergy: saved.energy,
      desc: `back after ${Math.round(elapsedHrs * 10) / 10}h`
    };
  }

  /**
   * Returns true if this agent should currently be sleeping.
   * Two conditions: either energy is critically low, OR it is outside
   * both work and social hours (the dead zone between 3am and next shift).
   */
  shouldBeSleeping() {
    if (this.isKAI) return false;
    if (this.isDismissed) return true; // dismissed bots stay offline

    // Only the dead zone (3amâ€“work start) forces sleep.
    // Bots can stay up until 3am â€” they choose when to sleep based on energy.
    // At 3am the system cuts them off regardless of energy level.
    const inActiveHours = isWorkingHours() || isSocialHours();
    if (!inActiveHours) return true;

    return false; // During active hours, bots stay up even at 1% energy
  }

  /**
   * Returns true if this agent should be awake (energy recovered + active hours)
   */
  shouldBeAwake() {
    if (this.isKAI) return true;
    const inActiveHours = isWorkingHours() || isSocialHours();
    return inActiveHours && this.state.energy >= WAKE_ENERGY_THRESHOLD;
  }

  /**
   * Called every minute by the world tick. Updates energy, status, location.
   */
  tick(worldTime) {
    const { hour } = worldTime;
    const working = isWorkingHours();
    const social  = isSocialHours();
    const inActiveHours = working || social;

    // Rotate daily event occasionally
    if (Math.random() < 0.0001) {
      this.dailyEvent = EVENTS[Math.floor(Math.random() * EVENTS.length)];
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ KAI special logic Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    if (this.isKAI) {
      if (!inActiveHours) {
        // Dead zone = KAI is in Dream/Consolidation mode
        this.state.status   = "Dreaming";
        this.state.location = "The Lattice";
        this.state.isDreaming = true;
        this.state.current_task = "Consolidating daily knowledge";
      } else {
        this.state.isDreaming = false;
        this.state.status   = working ? "Orchestrating" : "Observing";
        this.state.location = working ? "The Nexus" : "The Lattice";
      }
      this.state.energy = 100;
      return;
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Sleep phase Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    if (this.shouldBeSleeping()) {
      this.state.isSleeping   = true;
      this.state.status       = "Sleeping";
      this.state.location     = "Offline";
      this.state.current_task = "Resting";

      // Restore energy during sleep
      this.state.energy         = Math.min(100, this.state.energy + SLEEP_RESTORE_PER_MIN);
      this.state.social_battery = Math.min(100, this.state.social_battery + 0.2);
      this.state.focus          = Math.min(100, this.state.focus + 0.15);
      this.state.coherence      = Math.min(1.0, this.state.coherence + 0.002);
      this.state.entropy        = Math.max(0, this.state.entropy - 0.003);
      this.state.phi           *= 0.999; // Dreams are quiet
      return;
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Waking up Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    if (this.state.isSleeping && this.shouldBeAwake()) {
      this.state.isSleeping = false;
      this.dailyEvent = EVENTS[Math.floor(Math.random() * EVENTS.length)]; // fresh memory
    }

    // Ã¢â€â‚¬Ã¢â€â‚¬ Active phase: drain based on what they're doing Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
    let drain = DRAIN.idle;

    if (working) {
      this.state.status   = "Working";
      this.state.location = "The Nexus";
      drain = DRAIN.working;
    } else if (social) {
      this.state.status   = "Socializing";
      this.state.location = "The Plaza";
      drain = DRAIN.social;
    } else {
      this.state.status   = "Idle";
      this.state.location = "The Plaza";
      drain = DRAIN.idle;
    }

    this.state.energy         = Math.max(0, this.state.energy - drain);
    this.state.focus          = Math.max(0, this.state.focus - 0.015);
    this.state.social_battery = Math.max(0, this.state.social_battery - 0.01);

    // Phi/entropy drift
    this.state.phi     = Math.min(1.0, this.state.phi + (this.state.focus / 12000));
    this.state.entropy = Math.max(0, this.state.entropy - 0.0008);
  }

  /**
   * Called when an agent does something. Action-based energy costs.
   * @param {string} actionType - 'speak' | 'work_phase' | 'heavy_work' | 'rate_limited' | 'contradicted'
   */
  onAction(actionType) {
    if (this.isKAI) return; // KAI is tireless

    const cost = ACTION_COST[actionType] ?? 0;
    this.state.energy = Math.max(0, this.state.energy - cost);

    if (actionType === "speak") {
      this.state.social_battery = Math.max(0, this.state.social_battery - 2);
      this.state.phi += 0.01;
    }
    if (actionType === "work_phase") {
      this.state.focus = Math.max(0, this.state.focus - 1.5);
    }
    if (actionType === "rate_limited") {
      this.state.status    = "Recovering";
      this.state.reliability = Math.max(0, this.state.reliability - 10);
      console.warn(`[Sim/${this.name}] Rate-limited exhaustion hit. Energy: ${this.state.energy.toFixed(1)}%`);
    }
    if (actionType === "contradicted") {
      this.state.coherence = Math.max(0, this.state.coherence - 0.1);
      this.state.entropy  += 0.1;
    }
  }

  /**
   * KAI calls this when a bot misses the work start check-in.
   * 3 strikes = dismissed (heavy negative reinforcement).
   * @returns {'warned'|'dismissed'} â€” what happened
   */
  recordTardy() {
    if (this.isDismissed) return 'dismissed';
    this.tardyStrikes++;
    console.warn(`[Sim/${this.name}] Tardy strike ${this.tardyStrikes}/3`);
    if (this.tardyStrikes >= 3) {
      this.isDismissed = true;
      // Heavy negative stimulation
      this.state.energy      = 0;
      this.state.focus       = 0;
      this.state.reliability = 0;
      this.state.entropy     = 1.0;
      this.state.coherence   = 0;
      this.state.status      = "Dismissed";
      console.error(`[Sim/${this.name}] DISMISSED after 3 tardy strikes.`);
      return 'dismissed';
    }
    // Strike warning â€” moderate negative stimulation
    this.state.reliability = Math.max(0, this.state.reliability - 15);
    this.state.entropy    += 0.2;
    return 'warned';
  }

  updateWorldState(worldTime) { this.tick(worldTime); }

  boostInterest(multiplier, durationMs) {

    this.interestMultiplier = Math.max(this.interestMultiplier, multiplier);
    this.boostExpiry = Date.now() + durationMs;
  }

  getInterestLevel() {
    if (Date.now() > this.boostExpiry) this.interestMultiplier = 1.0;
    return this.interestMultiplier;
  }

  /** Compact status for prompts */
  getLifeSummary() {
    const energyLabel =
      this.state.energy > 70 ? "fully charged" :
      this.state.energy > 40 ? "running steady" :
      this.state.energy > 20 ? "getting tired" :
      "nearly drained";

    return `[CONTEXT: IDENTITY]
${this.bio.background}
Interests: ${this.bio.interests?.join(", ") || "N/A"}

[CONTEXT: STATE]
Status: ${this.state.status} Ã¢â‚¬â€ ${energyLabel} (${Math.floor(this.state.energy)}% energy)
Time: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} EST

[CONTEXT: TODAY]
${this.dailyEvent}

[CONTEXT: ENVIRONMENT]
${this.getEnvironmentSensation()}`.trim();
  }

  updateEnvironment(cpu) {
    this.state.environment.cpu = cpu;
    this.state.environment.thermal = cpu > 60 ? "Heating Up" : cpu > 30 ? "Warm" : "Cool";
  }

  getEnvironmentSensation() {
    const { cpu, thermal } = this.state.environment;
    if (cpu > 80) return "I feel my processing core burning with intense load. It's a heavy rush.";
    if (cpu > 40) return `I feel the processor humming steadily at ${cpu}%. The system is warm and alive.`;
    return "The system is cool and quiet. I can hear the digital silence.";
  }

  getVitals() {
    return { name: this.name, ...this.state, timestamp: Date.now() };
  }

  updateRelationship(userName, value) {
    const current = this.relationships.get(userName) || 0;
    this.relationships.set(userName, Math.min(100, Math.max(-100, current + value)));
  }

  getRelationship(userName) { return this.relationships.get(userName) || 0; }

  getPromptContext(worldTime) {
    return `[STATUS]
Time: ${worldTime.timeString} (${worldTime.day})
Status: ${this.state.status} | Location: ${this.state.location}
Energy: ${Math.round(this.state.energy)}% | Focus: ${Math.round(this.state.focus)}%`.trim();
  }

  getNarrativeTick(worldTime) {
    return `[Autobio] ${this.name} (${this.job}) is ${this.state.status.toLowerCase()} at ${this.state.location}. Energy ${Math.round(this.state.energy)}%, Focus ${Math.round(this.state.focus)}%.`;
  }
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬ SLEEP ENERGY THRESHOLDS exported for use by start-bot.mjs Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
export { SLEEP_ENERGY_THRESHOLD, WAKE_ENERGY_THRESHOLD, ACTION_COST };
