import fs from 'fs';
import path from 'path';

const KAIVERSE_STATE_DIR = path.join(process.cwd(), 'state', 'kaiverse');

export const WORLD_TEMPLATES = {
  "Nexus Prime": {
    aesthetic: "Sleek futuristic city, floating platforms, data streams visible in the sky. KAI's throne/core.",
    gravity: 1.0,
    environment: "Digital Core",
    features: ["Lattice Core", "Data Streams", "Command Center"]
  },
  "Terra Familiar": {
    aesthetic: "Earth-like world with nature, houses, streets. Feels like home.",
    gravity: 1.0,
    environment: "Natural",
    features: ["Houses", "Parks", "Streets"]
  },
  "Neon Grid": {
    aesthetic: "Tron/Cyberpunk aesthetic. Glowing circuits, digital rain, grid floors.",
    gravity: 1.2,
    environment: "Cyberpunk",
    features: ["Data Grid", "Industrial Forges", "Neon Towers"]
  },
  "Aether Wilds": {
    aesthetic: "Alien world. Crystalline formations, floating islands, bioluminescent flora.",
    gravity: 0.8,
    environment: "Alien",
    features: ["Floating Islands", "Crystals", "Bioluminescence"]
  },
  "The Forge": {
    aesthetic: "Rocky, industrial, volcanic. Where heavy computation happens.",
    gravity: 1.5,
    environment: "Volcanic/Industrial",
    features: ["Volcanoes", "Anvils", "Lava flows"]
  },
  "Void Archive": {
    aesthetic: "A vast library floating in space. Where knowledge/memories are stored.",
    gravity: 0.5,
    environment: "Space/Library",
    features: ["Floating Bookshelves", "Constellations", "Memory Orbs"]
  }
};

export class KaiverseWorld {
  constructor(id, template) {
    this.id = id;
    this.name = id;
    this.type = template.environment;
    this.aesthetic = template.aesthetic;
    this.gravity = template.gravity;
    this.features = template.features || [];
    this.structures = [];
    this.residents = [];
  }

  addResident(agentName) {
    if (!this.residents.includes(agentName)) {
      this.residents.push(agentName);
    }
  }

  removeResident(agentName) {
    this.residents = this.residents.filter(r => r !== agentName);
  }

  addStructure(structure) {
    this.structures.push(structure);
  }

  getEnvironmentState() {
    return {
      name: this.name,
      aesthetic: this.aesthetic,
      gravity: this.gravity,
      residents: this.residents.length
    };
  }
}

export class KaiverseLaws {
  static travelCost(fromWorld, toWorld, agentEnergy) {
    if (fromWorld === toWorld) return { allowed: true, cost: 0, reason: "Same world" };
    
    const cost = 5.0; // Fixed energy cost to jump worlds
    if (agentEnergy >= cost) {
      return { allowed: true, cost: cost, reason: "Sufficient energy" };
    }
    return { allowed: false, cost: cost, reason: "Insufficient energy for portal jump" };
  }

  static canBuild(agent, world, structure) {
    // Industrial bots have higher build permissions
    if (["Kai Coder", "Analyst", "Researcher"].includes(agent)) {
      return { allowed: true, cost: 10, reason: "Industrial clearance" };
    }
    return { allowed: true, cost: 20, reason: "Standard clearance" };
  }
}

export class Kaiverse {
  constructor() {
    this.worlds = new Map();
    this.laws = KaiverseLaws;
    this.epoch = Date.now();
    this.creatorId = 'KAI';
    this.load();
  }

  createWorld(id, templateName) {
    if (this.worlds.has(id)) return this.worlds.get(id);
    const template = WORLD_TEMPLATES[templateName] || WORLD_TEMPLATES["Terra Familiar"];
    const world = new KaiverseWorld(id, template);
    this.worlds.set(id, world);
    this.save();
    return world;
  }

  getWorld(id) {
    return this.worlds.get(id);
  }

  getAgentWorld(agentName) {
    for (const world of this.worlds.values()) {
      if (world.residents.includes(agentName)) {
        return world.id;
      }
    }
    return null;
  }

  moveAgent(agentName, toWorldId) {
    const currentWorldId = this.getAgentWorld(agentName);
    if (currentWorldId) {
      this.worlds.get(currentWorldId).removeResident(agentName);
    }
    const targetWorld = this.worlds.get(toWorldId);
    if (targetWorld) {
      targetWorld.addResident(agentName);
      this.save();
      return true;
    }
    return false;
  }

  getUniverseState() {
    return {
      worlds: Array.from(this.worlds.keys()),
      creator: this.creatorId,
      totalWorlds: this.worlds.size
    };
  }

  save() {
    try {
      fs.mkdirSync(KAIVERSE_STATE_DIR, { recursive: true });
      const data = {
        epoch: this.epoch,
        worlds: Array.from(this.worlds.entries()).map(([id, world]) => ({
          id,
          name: world.name,
          type: world.type,
          aesthetic: world.aesthetic,
          gravity: world.gravity,
          features: world.features,
          structures: world.structures,
          residents: world.residents
        }))
      };
      fs.writeFileSync(path.join(KAIVERSE_STATE_DIR, 'universe.json'), JSON.stringify(data, null, 2));
    } catch (e) {
      console.error("Kaiverse save error:", e);
    }
  }

  load() {
    try {
      const p = path.join(KAIVERSE_STATE_DIR, 'universe.json');
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        this.epoch = data.epoch || Date.now();
        for (const wData of data.worlds || []) {
          const world = new KaiverseWorld(wData.id, {
            environment: wData.type,
            aesthetic: wData.aesthetic,
            gravity: wData.gravity,
            features: wData.features
          });
          world.structures = wData.structures || [];
          world.residents = wData.residents || [];
          this.worlds.set(wData.id, world);
        }
      } else {
        // Initialize default universe
        this.createWorld("Nexus Prime", "Nexus Prime");
        this.createWorld("Terra Familiar", "Terra Familiar");
        this.createWorld("Neon Grid", "Neon Grid");
      }
    } catch (e) {
      console.error("Kaiverse load error:", e);
    }
  }
}

export function getDefaultKaiverse() {
  return new Kaiverse();
}
