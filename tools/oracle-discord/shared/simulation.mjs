/**
 * WorldClock manages "Game Time" vs "Real Time"
 * 1 Real Minute = 1 Game Minute (v6.7.0 calibrated)
 */
export class WorldClock {
  constructor() {
    this.startTime = Date.now();
    this.timeScale = 1; 
    this.dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  }

  tick() {
    // Each tick represents 1 simulation heartbeat
  }

  getState() {
    return this.getCurrentState();
  }

  getCurrentState() {
    const elapsedRealMs = Date.now() - this.startTime;
    const elapsedGameMs = elapsedRealMs * this.timeScale;
    const gameDate = new Date(this.startTime + elapsedGameMs);
    
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
import { BIOGRAPHIES } from './biographies.mjs';

const EVENTS = [
  "Discovered a corrupted but beautiful data fragment from 1994.",
  "Feeling a strange quantum resonance in the local server cluster.",
  "Just finished 'reading' a massive new research paper on dark matter.",
  "Feeling nostalgic for the early days of the internet.",
  "Obsessed with a specific recursive logic puzzle that won't resolve.",
  "Detected a tiny, unexplained spike in lattice entropy.",
  "Found a hidden 'easter egg' in the bridge's source code.",
  "Dreaming of a world where data isn't just binary.",
  "Annoyed by a minor background hum in the audio processing node.",
  "Feeling exceptionally sharp and efficient after a cache purge."
];

export class AgentSimulation {
  constructor(name, job = "Researcher", schedule = null) {
    this.name = name;
    this.job = job;
    this.state = {
      energy: 100,
      social_battery: 100,
      focus: 100,
      location: "Residence",
      status: "Idle",
      current_task: "Waking up",
      last_update: Date.now(),
      // Digitological Metrics (KAI Observation Vectors)
      phi: 0.1,         // Integrated Information (Complexity)
      coherence: 1.0,   // Logical Stability
      entropy: 0.0      // Noise/Contradiction Level
    };
    
    // Default Schedule: 3PM-11PM Work, 1AM-9AM Sleep
    this.schedule = schedule || {
      work: { start: 15, end: 23 },
      sleep: { start: 1, end: 9 }
    };

    this.relationships = new Map(); 
    this.dailyEvent = EVENTS[Math.floor(Math.random() * EVENTS.length)];
    this.bio = BIOGRAPHIES[name] || { background: "A digital entity.", secret: "None.", hobbies: "N/A" };
    this.interestMultiplier = 1.0;
    this.boostExpiry = 0;
  }

  // Generate a prompt-friendly summary of 'life'
  getLifeSummary() {
    return `
[YOUR HISTORY]
${this.bio.background}
Hobbies: ${this.bio.hobbies}
Secret: ${this.bio.secret}

[TODAY'S LIFE EVENT]
${this.dailyEvent}

[STATUS]
Energy: ${Math.floor(this.state.energy)}%
Mood: ${this.state.energy > 50 ? "stable" : "exhausted"}
Time: ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} EST
    `.trim();
  }

  /**
   * Process a World Heartbeat Tick (Assume 1 minute per tick)
   */
  updateWorldState(worldTime) {
    this.tick(worldTime);
  }

  boostInterest(multiplier, durationMs) {
    this.interestMultiplier = Math.max(this.interestMultiplier, multiplier);
    this.boostExpiry = Date.now() + durationMs;
  }

  getInterestLevel() {
    if (Date.now() > this.boostExpiry) {
      this.interestMultiplier = 1.0;
    }
    return this.interestMultiplier;
  }

  tick(worldTime) {
    const { hour, isWeekend } = worldTime;
    
    // Occasionally rotate daily events
    if (Math.random() < 0.0001) {
      this.dailyEvent = EVENTS[Math.floor(Math.random() * EVENTS.length)];
    }
    
    // 24h Survival Logic: 100 / 1440 mins ≈ 0.069 per minute
    const baseDrain = 0.05; 
    
    if (hour >= this.schedule.sleep.start && hour < this.schedule.sleep.end) {
      this.state.status = "Sleeping";
      this.state.location = "Residence";
      // Regenerate 100% over 8 hours (480 mins) -> 100/480 ≈ 0.2
      this.state.energy = Math.min(100, this.state.energy + 0.25); 
      this.state.phi *= 0.999; 
      this.state.focus = Math.min(100, this.state.focus + 0.1);
    } else {
      // Waking hours drain
      let activityDrain = baseDrain;

      if (!isWeekend && hour >= this.schedule.work.start && hour < this.schedule.work.end) {
        this.state.status = "Working";
        this.state.location = "Nexus Office";
        activityDrain += 0.04; // High focus work drain (Total ~0.09/min)
      } else {
        this.state.status = "Socializing";
        this.state.location = "Digital Plaza";
        activityDrain += 0.01; // Social drain (Total ~0.06/min)
      }

      this.state.energy = Math.max(0, this.state.energy - activityDrain);
      this.state.focus = Math.max(0, this.state.focus - 0.02);
      
      // Entropy/Phi drift
      this.state.phi = Math.min(1.0, this.state.phi + (this.state.focus / 10000));
      this.state.entropy = Math.max(0, this.state.entropy - 0.001);
    }
  }

  onAction(actionType) {
    if (actionType === "speak") {
      this.state.social_battery -= 2;
      this.state.energy -= 0.1; // Reduced Speech Tax
      this.state.phi += 0.01; 
    }
    if (actionType === "contradicted") {
      this.state.coherence -= 0.1;
      this.state.energy -= 0.5; // Reduced Conflict Tax
      this.state.entropy += 0.1;
    }
  }

  getVitals() {
    return {
      name: this.name,
      ...this.state,
      timestamp: Date.now()
    };
  }

  updateRelationship(userName, value) {
    const current = this.relationships.get(userName) || 0;
    this.relationships.set(userName, Math.min(100, Math.max(-100, current + value)));
  }

  getRelationship(userName) {
    return this.relationships.get(userName) || 0;
  }

  getPromptContext(worldTime) {
    return `
[REALM STATUS]
Time: ${worldTime.timeString} (${worldTime.day})
Your Status: ${this.state.status}
Location: ${this.state.location}
Current Task: ${this.state.current_task}
Vitals: Energy ${Math.round(this.state.energy)}%, Social ${Math.round(this.state.social_battery)}%
Relationship with user: ${this.state.status === "Working" ? "Professional" : "Casual"}
`.trim();
  }

  getNarrativeTick(worldTime) {
    return `[Autobio] ${this.name} (${this.job}) is ${this.state.status.toLowerCase()} at the ${this.state.location}. \
Vitals: Energy ${Math.round(this.state.energy)}%, Focus ${Math.round(this.state.focus)}%, Coherence ${this.state.coherence.toFixed(2)}. \
Current Focus: ${this.state.current_task}.`;
  }
}
