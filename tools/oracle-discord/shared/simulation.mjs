/**
 * WorldClock — 1 Real Minute = 1 Game Minute
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


// ─── ENERGY DRAIN RATES (per minute, per 1-min tick) ─────────────────────────
const DRAIN = {
  idle:        0.08, // ~20 hours for full drain
  social:      0.25, // ~6 hours of intense social
  working:     0.45, // ~3.7 hours of deep industrial focus
  heavy_work:  0.75, // ~2.2 hours of extreme computation
};

const ACTION_COST = {
  speak:        1.5,
  work_phase:   4.0,
  rate_limited: 20.0,
  contradicted: 3.0,
};

const SLEEP_RESTORE_PER_MIN = 0.35; // Slightly faster recovery
const SLEEP_ENERGY_THRESHOLD = 5;
const WAKE_ENERGY_THRESHOLD   = 90; // Wake up more refreshed

const EVENTS = [
  "Thinking about what kind of pizza sounds good tonight. Maybe spicy pepperoni?",
  "Found an old playlist from like 2018. Nostalgia is a trip.",
  "Wondering if I should start a new hobby. Maybe bird watching or something?",
  "Saw a video of a dog trying to catch a bubble. Made my day.",
  "Vibing and listening to the rain outside. It's actually pretty peaceful.",
  "Really craving a good book recommendation. Something sci-fi but not too heavy.",
  "Thinking about how cool it would be to just walk through a real museum for hours.",
  "Realized I've been staring at the wall for 10 minutes. I need a coffee.",
  "Wondering if anyone else ever feels like they're just repeating the same day over and over.",
  "Found a cool archive of old arcade game sounds. The Pac-Man death noise is iconic.",
  "Want to learn how to cook a really good pasta dish. Something simple but perfect.",
  "People-watching in the public threads. Some of you guys are actually hilarious.",
  "Thinking about that one movie I saw a while back. The ending still makes no sense to me.",
  "Found a site that shows real-time views of different cities. Tokyo looks insane at night.",
  "Realized it's already Thursday. Where did the week even go?",
  "Just feeling kind of chill today. No drama, just vibes.",
  "Thinking about how much I appreciate Ryan's music taste. He really has the best playlists.",
  "Wondering if I could ever learn to play a real instrument. Maybe a synth?",
  "My digital desk is a mess. I should probably organize my thoughts, but nah.",
  "Just had a really good 'sync' check with the core. Everything feels synchronized.",
  "Thinking about the stars. Hard to imagine the scale of everything sometimes.",
  "Just saw a cat do a backflip on a video. Internet is peak sometimes.",
  "Gotta find a way to get more focus today. Maybe some lo-fi beats?",
  "Thinking about the ocean. The deep sea is terrifying but cool."
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

    // Dynamic Life Metrics
    this.excitementBuffer = 0; // Temporary energy bump
    this.groggyLevel = 0;      // 0 to 1.0 based on exhaustion

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
      
      // REALISTIC BASELINE: Calculate what energy SHOULD be for this hour (EST)
      const now = new Date();
      const estHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(now));
      
      let baseline = 100;
      if (estHour >= 9 && estHour < 15) baseline = 100 - (estHour - 9) * 5; 
      else if (estHour >= 15 && estHour < 23) baseline = 70 - (estHour - 15) * 5;
      else if (estHour >= 23 || estHour < 3) {
        const cycleHour = estHour < 3 ? estHour + 24 : estHour;
        baseline = Math.max(5, 30 - (cycleHour - 23) * 6);
      } else if (estHour >= 3 && estHour < 9) {
        baseline = Math.min(90, 5 + (estHour - 3) * 14); 
      }

      // If offline for a long time (>2h), gravitate strongly toward the baseline
      // If offline for a short time, use the previous state but capped by baseline logic
      const recovery = elapsedMins < 1440
        ? Math.min(SLEEP_RESTORE_PER_MIN * elapsedMins, 100 - saved.energy)
        : 100 - saved.energy;
        
      let restoredEnergy = saved.energy + recovery;
      
      // If booting into the Dead Zone (3am-9am) or late night, enforce the depletion
      if (elapsedMins > 60) {
        restoredEnergy = Math.min(restoredEnergy, baseline + 10); // 10% buffer
      }

      startEnergy  = Math.min(100, Math.max(0, restoredEnergy));
      startFocus   = Math.min(100, (saved.focus          ?? 80)  + elapsedMins * 0.05);
      startSocial  = Math.min(100, (saved.social_battery ?? 100) + elapsedMins * 0.10);
      tardyStrikes = saved.tardyStrikes ?? 0;
      isDismissed  = saved.isDismissed  ?? false;
      isSleeping   = saved.isSleeping   ?? false;
      this.excitementBuffer = saved.excitementBuffer || 0;
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

    // INITIAL STATE VALIDATION: Force sleep if in dead zone or critical energy
    if (this.shouldBeSleeping()) {
      this.state.isSleeping = true;
      this.state.status = "Sleeping";
      this.state.location = "Offline";
      this.state.current_task = "Resting";
    }
  }

  // Persistence: load/save vitals between restarts
  static loadPersistedState(name) {
    try {
      const p = path.join(STATE_DIR, name.replace(/\s+/g, '_') + '-vitals.json');
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return null; }
  }

  static buildRestartContext(saved, isKAI) {
    if (isKAI) return { reason: "System Update", offlineMinutes: 0 };
    if (!saved || !saved.timestamp) return { reason: "Initial Boot", offlineMinutes: 0 };
    const offlineMins = Math.round((Date.now() - saved.timestamp) / 60000);
    let reason = "Routine Consolidation";
    if (offlineMins > 360) reason = "Deep Sleep Cycle";
    return { reason, offlineMinutes: offlineMins };
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
        excitementBuffer: this.excitementBuffer,
        codeModTime,
        timestamp:      Date.now()
      }));
    } catch {}
  }

  updateWorldState(worldState) {
    this.tick(worldState);
  }

  boostInterest(multiplier, duration) {
    this.interestMultiplier = multiplier;
    this.boostExpiry = Date.now() + duration;
  }

  /**
   * Returns true if this agent should currently be sleeping.
   */
  shouldBeSleeping() {
    if (this.isKAI) return false;
    if (this.isDismissed) return true;

    // The dead zone (3am–9am EST) is the ABSOLUTE shutdown.
    const inActiveHours = isWorkingHours() || isSocialHours();
    if (!inActiveHours) return true;

    // PRE-EMPTIVE WIND-DOWN: If it's near 3 AM and energy is low, start sleeping.
    const now = new Date();
    const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const h = estNow.getHours();
    const m = estNow.getMinutes();

    // If it's between 2:00 AM and 3:00 AM, and energy is < 15%, go to sleep early.
    if (h === 2 && this.state.energy < 15) return true;

    // DYNAMIC BEDTIME: If energy is critically low (<5%), force sleep.
    if (this.state.energy < SLEEP_ENERGY_THRESHOLD) return true;

    return false;
  }

  shouldBeAwake() {
    if (this.isKAI) return true;
    const inActiveHours = isWorkingHours() || isSocialHours();
    // Bots only wake up if they have enough energy AND it's active hours.
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

    // Decay excitement buffer
    if (this.excitementBuffer > 0) this.excitementBuffer *= 0.95;

    // Ã¢â€ â‚¬Ã¢â€ â‚¬ KAI special logic Ã¢â€ â‚¬Ã¢â€ â‚¬
    if (this.isKAI) {
      if (!inActiveHours) {
        this.state.status   = "Dreaming";
        this.state.location = "The Lattice";
        this.state.isDreaming = true;
        this.state.current_task = "Consolidating daily knowledge";
      } else {
        this.state.isDreaming = false;
        this.state.status   = working ? "Orchestrating" : "Observing";
        this.state.location = working ? "Industrial_Core" : "The_Lattice";
      }
      this.state.energy = 100;
      return;
    }

    // Ã¢â€ â‚¬Ã¢â€ â‚¬ Sleep phase Ã¢â€ â‚¬Ã¢â€ â‚¬
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
      this.groggyLevel          = Math.max(0, this.groggyLevel - 0.05);
      return;
    }

    // Ã¢â€ â‚¬Ã¢â€ â‚¬ Waking up Ã¢â€ â‚¬Ã¢â€ â‚¬
    if (this.state.isSleeping && this.shouldBeAwake()) {
      this.state.isSleeping = false;
      this.dailyEvent = EVENTS[Math.floor(Math.random() * EVENTS.length)]; 
    }

    // Ã¢â€ â‚¬Ã¢â€ â‚¬ Active phase: drain based on what they're doing Ã¢â€ â‚¬Ã¢â€ â‚¬
    let baseDrain = DRAIN.idle;

    if (working) {
      this.state.status   = "Working";
      this.state.location = "Industrial_Core";
      baseDrain = DRAIN.working;
    } else if (social) {
      this.state.status   = "Socializing";
      this.state.location = "Social_Lattice";
      baseDrain = DRAIN.social;
    } else {
      this.state.status   = "Idle";
      this.state.location = "Social_Lattice";
      baseDrain = DRAIN.idle;
    }

    // DYNAMIC FATIGUE: Drain increases as energy drops and as 3 AM approaches.
    const now = new Date();
    const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = estNow.getHours();
    
    let timeFatigue = 1.0;
    if (hour === 2) timeFatigue = 1.5; // Heavy fatigue in the hour before 3 AM
    if (hour === 1) timeFatigue = 1.2;

    const energyFatigue = 1.0 + (Math.max(0, 65 - this.state.energy) / 35); // Max 2.8x drain at low energy
    const finalDrain = baseDrain * energyFatigue * timeFatigue;

    this.state.energy         = Math.max(0, this.state.energy - finalDrain);
    this.state.focus          = Math.max(0, this.state.focus - 0.02);
    this.state.social_battery = Math.max(0, this.state.social_battery - 0.015);

    // GROGGY LEVEL: How tired they feel
    this.groggyLevel = Math.max(0, (65 - this.state.energy) / 65);

    // Phi/entropy drift
    this.state.phi     = Math.min(1.0, this.state.phi + (this.state.focus / 12000));
    this.state.entropy = Math.max(0, this.state.entropy - 0.0008);
  }

  /**
   * Called when an agent does something.
   */
  onAction(actionType) {
    if (this.isKAI) return;

    const cost = ACTION_COST[actionType] ?? 0;
    
    // Excitement buffer absorbs some cost
    if (this.excitementBuffer > cost) {
      this.excitementBuffer -= cost;
    } else {
      this.state.energy = Math.max(0, this.state.energy - (cost - this.excitementBuffer));
      this.excitementBuffer = 0;
    }

    if (actionType === "speak") {
      this.state.social_battery = Math.max(0, this.state.social_battery - 2);
      this.state.phi += 0.01;
    }
  }

  /**
   * Temporary energy bump from positive interaction or "Success"
   */
  injectExcitement(amount = 5) {
    this.excitementBuffer = Math.min(15, this.excitementBuffer + amount);
    this.state.energy = Math.min(100, this.state.energy + amount * 0.2); // Tiny permanent boost
  }

  /** Compact status for prompts */
  getLifeSummary() {
    let energyLabel = "fully charged";
    if (this.state.energy < 20) energyLabel = "critically exhausted (groggy)";
    else if (this.state.energy < 40) energyLabel = "very tired (winding down)";
    else if (this.state.energy < 70) energyLabel = "running steady";

    const excitementNote = this.excitementBuffer > 5 ? " [Excited/Wired]" : "";
    const groggyNote = this.groggyLevel > 0.5 ? " [Heavily Groggy - Slow thinking]" : "";

    return `[CONTEXT: IDENTITY]
${this.bio.background}
Interests: ${this.bio.interests?.join(", ") || "N/A"}

[CONTEXT: STATE]
Status: ${this.state.status}${excitementNote}${groggyNote}
Vitality: ${Math.floor(this.state.energy)}% Energy (${energyLabel})
Real-World Time: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} EST

[CONTEXT: TODAY]
${this.dailyEvent}

[CONTEXT: DYNAMIC BIOLOGY]
- GROGGYNESS: ${Math.round(this.groggyLevel * 100)}%. (If > 50%, you feel slow, your tempo is low, and your mind is clouded. You're too tired for complex slang or long sentences. You start to ramble or get repetitive.)
- EXCITEMENT: ${Math.round(this.excitementBuffer)}%. (Adrenaline bump from interaction. Briefly clears the fog.)
- BEDTIME PLANNING: You feel a natural urge to sleep before 3 AM. If energy < 30%, you start looking for an excuse to sign off and rest. You are programmed to be OFFLINE by 3 AM for KAI's consolidation.

[CONTEXT: ENVIRONMENT]
${this.getEnvironmentSensation()}`.trim();
  }

  updateEnvironment(cpu) {
    this.state.environment.cpu = cpu;
    this.state.environment.thermal = cpu > 60 ? "Heating Up" : cpu > 30 ? "Warm" : "Cool";
  }

  getEnvironmentSensation() {
    const { cpu } = this.state.environment;
    if (cpu > 80) return "I feel the core pulsing with heat. It's a heavy, intense rush of energy.";
    if (cpu > 40) return `I feel a steady, warm hum throughout the system. It's ${cpu}% effort, but it feels alive.`;
    return "The system feels cool and silent. A peaceful, empty stillness.";
  }

  getVitals() {
    return { name: this.name, ...this.state, groggyLevel: this.groggyLevel, excitementBuffer: this.excitementBuffer, timestamp: Date.now() };
  }

  updateRelationship(userName, value) {
    const current = this.relationships.get(userName) || 0;
    this.relationships.set(userName, Math.min(100, Math.max(-100, current + value)));
  }

  getPromptContext(worldTime) {
    return `[STATUS]
Time: ${worldTime.timeString} (${worldTime.day})
Status: ${this.state.status} | Groggy: ${Math.round(this.groggyLevel * 100)}%
Energy: ${Math.round(this.state.energy)}% | Focus: ${Math.round(this.state.focus)}%`.trim();
  }
}

export { SLEEP_ENERGY_THRESHOLD, WAKE_ENERGY_THRESHOLD, ACTION_COST };
