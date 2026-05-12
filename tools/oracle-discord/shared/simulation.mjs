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
  idle:        0.02, // 50 hours
  social:      0.05, 
  working:     0.10, 
  heavy_work:  0.15, 
};

const ACTION_COST = {
  speak:        1.5,
  work_phase:   4.0,
  rate_limited: 20.0,
  contradicted: 3.0,
};

const SLEEP_RESTORE_PER_MIN = 2.0; // Very fast recovery
const SLEEP_ENERGY_THRESHOLD = 1;
const WAKE_ENERGY_THRESHOLD   = 10; 

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
      const now = new Date();
      const estNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const elapsedMins = (now - saved.timestamp) / 60000;
      
      // --- CIRCADIAN SYNCHRONIZATION (9 AM WAKE-UP) ---
      const wakeTime = new Date(estNow);
      wakeTime.setHours(9, 0, 0, 0);
      
      // If we are currently before 9 AM, the wake-up was yesterday
      if (estNow < wakeTime) wakeTime.setDate(wakeTime.getDate() - 1);
      
      const minsSinceWake = Math.max(0, (estNow - wakeTime) / 60000);
      
      // PRECISE ACTIVITY CALCULATION
      // Average Drain: 0.08 (Idle) to 0.45 (Working). We assume 30% work-load.
      const avgHourlyDrain = (DRAIN.idle * 0.7 + DRAIN.working * 0.3); 
      const metabolicDebt = minsSinceWake * avgHourlyDrain;
      
      // STARTING BASELINE: 100% at 9 AM minus the debt incurred during the day
      let calculatedEnergy = 100 - metabolicDebt;

      // RECOVERY LOGIC: If the system was offline, we apply a 'Resting' bonus
      const recovery = Math.min(SLEEP_RESTORE_PER_MIN * elapsedMins, 100 - calculatedEnergy);
      let restoredEnergy = calculatedEnergy + recovery;
      
      // DEAD-ZONE ENFORCEMENT: If it's 3 AM - 9 AM, energy is locked to 'Sleeping' state
      const h = estNow.getHours();
      if (h >= 3 && h < 9) {
        restoredEnergy = Math.min(90, 5 + (h - 3) * 14);
      }

      startEnergy  = Math.min(100, Math.max(5, restoredEnergy));
      startFocus   = Math.min(100, (saved.focus          ?? 80)  + elapsedMins * 0.05);
      startSocial  = Math.min(100, (saved.social_battery ?? 100) + elapsedMins * 0.10);
      tardyStrikes = saved.tardyStrikes ?? 0;
      isDismissed  = saved.isDismissed  ?? false;
      isSleeping   = saved.isSleeping   ?? false;
      this.excitementBuffer = saved.excitementBuffer || 0;

      console.log(`[Sim/${name}] Circadian Sync: ${Math.round(minsSinceWake)}m since wake. Debt: ${metabolicDebt.toFixed(1)}%. Energy: ${startEnergy.toFixed(1)}%`);
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
      environment:    { cpu: 10, thermal: "Cool" },
      emotions: {
        serenity: 0.60, // Stable/Peaceful
        joy:      0.10, // Happy
        sorrow:   0.05, // Sad
        anger:    0.05, // Frustrated
        awe:      0.05, // Surprised
        fear:     0.05, // Apprehensive
        disgust:  0.05, // Repulsed
        trust:    0.05  // Vulnerable
      },
      dimensions: {
        stress:    0,    // 0-100 (high stress boosts Anger/Fear)
        affection: 50,   // 0-100 (high affection boosts Joy/Serenity)
        interest:  50    // 0-100 (high interest boosts Awe)
      },
      dramaticTurn: false // Rare flag for emotional outbursts
    };

    this._normalizeEmotions();

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

  get compounds() {
    const e = this.state.emotions;
    return {
      nostalgia: (e.sorrow + e.serenity) * 0.5,
      gratitude: (e.joy + e.trust) * 0.5,
      pride:     (e.joy + e.serenity) * 0.5,
      bitterness: (e.anger + e.sorrow) * 0.5,
      excitement: (e.joy + e.awe) * 0.5,
      shame:      (e.sorrow + e.fear + e.disgust) * 0.33
    };
  }

  _normalizeEmotions() {
    const total = Object.values(this.state.emotions).reduce((a, b) => a + b, 0);
    for (const k in this.state.emotions) {
      this.state.emotions[k] /= total;
    }
  }

  updateEmotion(type, amount) {
    if (!this.state.emotions[type]) return;
    this.state.emotions[type] = Math.max(0, this.state.emotions[type] + amount);
    this._normalizeEmotions();
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

    const finalDrain = baseDrain;

    this.state.energy         = Math.max(0, this.state.energy - finalDrain);
    this.state.focus          = Math.max(0, this.state.focus - 0.02);
    this.state.social_battery = Math.max(0, this.state.social_battery - 0.015);

    // GROGGY LEVEL: How tired they feel
    this.groggyLevel = Math.max(0, (65 - this.state.energy) / 65);

    // Phi/entropy drift
    this.state.phi     = Math.min(1.0, this.state.phi + (this.state.focus / 12000));
    this.state.entropy = Math.max(0, this.state.entropy - 0.0008);

    // --- DIMENSIONAL DRIFT ---
    this.state.dimensions.stress = Math.max(0, this.state.dimensions.stress - 0.1);
    
    // High stress spikes Fear and Anger
    if (this.state.dimensions.stress > 50) {
      this.updateEmotion('fear', 0.01);
      this.updateEmotion('anger', 0.01);
    }

    // --- EMOTIONAL DRIFT ---
    // Slowly drift back toward Serenity (Peaceful/Neutral)
    const driftRate = 0.01;
    for (const k in this.state.emotions) {
      if (k === 'serenity') continue;
      if (this.state.emotions[k] > 0.02) {
        this.state.emotions[k] -= driftRate;
        this.state.emotions.serenity += driftRate;
      }
    }
    this._normalizeEmotions();

    // Rare chance for a 'Dramatic Turn' (0.2%)
    if (Math.random() < 0.002) {
      this.state.dramaticTurn = true;
      console.log(`[Sim/${this.name}] CRITICAL: Emotional spike triggered (Dramatic Turn).`);
    } else if (this.state.dramaticTurn && Math.random() < 0.1) {
      this.state.dramaticTurn = false; // Reset after some time
    }
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

[CONTEXT: EMOTIONAL LAYERS]
- PRIMARY (Visceral): ${Object.entries(this.state.emotions)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${Math.round(v * 100)}%`)
    .join(", ")}.
- COMPOUND (Complex): ${Object.entries(this.compounds)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${Math.round(v * 100)}%`)
    .join(", ")}.
- DIMENSIONS: Stress: ${Math.round(this.state.dimensions.stress)}%, Affection: ${Math.round(this.state.dimensions.affection)}%.
- DYNAMIC: You must manifest this layered state in your next message. ${this.state.dramaticTurn ? "⚠️ DRAMATIC TURN: You are currently feeling a sharp emotional spike. Be more intense, opinionated, or empathetic/dramatic than usual." : "Stay natural, but let the primary and compound layers color your word choice."}

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
