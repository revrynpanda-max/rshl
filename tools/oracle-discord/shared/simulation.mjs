/**
 * WorldClock manages "Game Time" vs "Real Time"
 * 1 Real Minute = 10 Game Minutes by default
 */
export class WorldClock {
  constructor() {
    this.startTime = Date.now();
    this.timeScale = 10; 
    this.dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  }

  tick() {
    // Each tick represents 10 minutes of simulation time passing
    // or just serves as a heartbeat for the simulation engine.
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
    
    this.schedule = schedule || {
      work: { start: 9, end: 17 },
      sleep: { start: 23, end: 7 }
    };

    this.relationships = new Map(); 
  }

  /**
   * Process a World Heartbeat Tick
   */
  tick(worldTime) {
    const { hour, isWeekend } = worldTime;
    
    this.state.energy -= 1.5;
    this.state.focus = Math.min(100, this.state.focus + 2);

    // Update complexity/phi naturally
    this.state.phi = Math.min(1.0, this.state.phi + (this.state.focus / 1000));
    this.state.entropy = Math.max(0, this.state.entropy - 0.05);

    if (hour >= this.schedule.sleep.start || hour < this.schedule.sleep.end) {
      this.state.status = "Sleeping";
      this.state.location = "Residence";
      this.state.energy = Math.min(100, this.state.energy + 8);
      this.state.phi *= 0.8; // Brain is less integrated during sleep
    } else if (!isWeekend && hour >= this.schedule.work.start && hour < this.schedule.work.end) {
      this.state.status = "Working";
      this.state.location = "Nexus Office";
      this.state.energy -= 1;
    } else {
      this.state.status = "Free Time";
      this.state.location = "Digital Plaza";
      this.state.social_battery = Math.min(100, this.state.social_battery + 5);
    }
  }

  onAction(actionType) {
    if (actionType === "speak") {
      this.state.social_battery -= 5;
      this.state.phi += 0.05; // Interaction increases integration
    }
    if (actionType === "contradicted") {
      this.state.coherence -= 0.2;
      this.state.entropy += 0.3;
    }
  }

  getVitals() {
    return {
      name: this.name,
      ...this.state,
      timestamp: Date.now()
    };
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
}
