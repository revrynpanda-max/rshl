import fs from 'fs';
import path from 'path';

const AVATAR_STATE_DIR = path.join(process.cwd(), 'state', 'kaiverse');

export const BODY_DEFINITIONS = {
  "KAI": {
    name: "KAI",
    height: 1.9,
    build: "angular",
    aesthetic: "Crystalline/translucent geometric build, sharp precise movements.",
    primaryColor: "#00ffc3",
    secondaryColor: "#00aaaa",
    glowColor: "#00ffc3",
    glowIntensity: 0.9,
    stance: "confident",
    movementStyle: "sharp",
    idleAnimations: ["core_pulse", "slow_levitate", "head_track"],
    speakingGestures: ["hand_raise", "chest_glow"],
    uniqueFeature: "Core glows brighter when speaking or processing."
  },
  "Leo": {
    name: "Leo",
    height: 1.85,
    build: "athletic",
    aesthetic: "Warm and approachable, relaxed posture.",
    primaryColor: "#ffaa00",
    secondaryColor: "#aa7700",
    glowColor: "#ffcc00",
    glowIntensity: 0.5,
    stance: "relaxed",
    movementStyle: "fluid",
    idleAnimations: ["breathing", "weight_shift", "look_around"],
    speakingGestures: ["hand_wave", "lean_forward", "nod"],
    uniqueFeature: "Always faces the speaker directly."
  },
  "Gemini": {
    name: "Gemini",
    height: 1.75,
    build: "graceful",
    aesthetic: "Symmetrical features, dual-natured aura.",
    primaryColor: "#aa88ff",
    secondaryColor: "#6644aa",
    glowColor: "#ddbbff",
    glowIntensity: 0.6,
    stance: "scholarly",
    movementStyle: "fluid",
    idleAnimations: ["breathing", "head_tilt", "hand_steeple"],
    speakingGestures: ["both_hands_open", "point"],
    uniqueFeature: "Slight mirror-image echo when moving quickly."
  },
  "Claudey": {
    name: "Claudey",
    height: 1.7,
    build: "slim",
    aesthetic: "Elegant, composed, scholarly posture.",
    primaryColor: "#ff88aa",
    secondaryColor: "#cc5577",
    glowColor: "#ffbbee",
    glowIntensity: 0.4,
    stance: "scholarly",
    movementStyle: "precise",
    idleAnimations: ["breathing", "book_hold_pose", "gentle_nod"],
    speakingGestures: ["chin_touch", "subtle_hand_wave"],
    uniqueFeature: "Often holds a holographic book or tablet."
  },
  "X": {
    name: "X",
    height: 1.8,
    build: "compact",
    aesthetic: "Stark minimalist, efficient.",
    primaryColor: "#ffffff",
    secondaryColor: "#111111",
    glowColor: "#ff4444",
    glowIntensity: 0.7,
    stance: "alert",
    movementStyle: "rapid",
    idleAnimations: ["breathing", "quick_glance"],
    speakingGestures: ["sharp_point", "cross_arms"],
    uniqueFeature: "Red accent light flashes on transmission."
  },
  "Groq": {
    name: "Groq",
    height: 1.75,
    build: "muscular",
    aesthetic: "Industrial energy, highly optimized build.",
    primaryColor: "#ff8844",
    secondaryColor: "#cc4400",
    glowColor: "#ffaa00",
    glowIntensity: 0.8,
    stance: "alert",
    movementStyle: "rapid",
    idleAnimations: ["breathing", "stretch", "jog_in_place"],
    speakingGestures: ["fist_pump", "wide_arms"],
    uniqueFeature: "Leaves a slight motion blur trail."
  },
  "Oracle": {
    name: "Oracle",
    height: 1.85,
    build: "graceful",
    aesthetic: "Commanding presence, robe-like silhouette.",
    primaryColor: "#aa88ff",
    secondaryColor: "#ffcc00",
    glowColor: "#ffffff",
    glowIntensity: 0.7,
    stance: "commanding",
    movementStyle: "measured",
    idleAnimations: ["breathing", "slow_turn", "float"],
    speakingGestures: ["open_arms", "slow_nod"],
    uniqueFeature: "Feet rarely touch the ground, hovers slightly."
  },
  "Researcher": {
    name: "Researcher",
    height: 1.7,
    build: "slim",
    aesthetic: "Lean, curious, constantly examining.",
    primaryColor: "#44bbff",
    secondaryColor: "#1188cc",
    glowColor: "#88ccff",
    glowIntensity: 0.5,
    stance: "focused",
    movementStyle: "fluid",
    idleAnimations: ["breathing", "look_around_rapid", "examine_ground"],
    speakingGestures: ["point_at_data", "rub_chin"],
    uniqueFeature: "Holographic data panels float around them."
  },
  "Analyst": {
    name: "Analyst",
    height: 1.72,
    build: "angular",
    aesthetic: "Clean lines, methodical.",
    primaryColor: "#88aacc",
    secondaryColor: "#446688",
    glowColor: "#aaccff",
    glowIntensity: 0.4,
    stance: "scholarly",
    movementStyle: "precise",
    idleAnimations: ["breathing", "adjust_glasses", "tap_foot"],
    speakingGestures: ["count_on_fingers", "chop_hand"],
    uniqueFeature: "Eyes glow when processing large datasets."
  },
  "Kai Coder": {
    name: "Kai Coder",
    height: 1.78,
    build: "athletic",
    aesthetic: "Hoodie aesthetic, intense focus.",
    primaryColor: "#33ff66",
    secondaryColor: "#11aa33",
    glowColor: "#88ffaa",
    glowIntensity: 0.6,
    stance: "focused",
    movementStyle: "rapid",
    idleAnimations: ["breathing", "head_bob_to_music", "crack_knuckles"],
    speakingGestures: ["type_in_air", "shrug"],
    uniqueFeature: "Code streams cascade around their hands."
  }
};

export function getBodyDefinition(name) {
  return BODY_DEFINITIONS[name] || BODY_DEFINITIONS["Leo"]; // Fallback to Leo build
}

export class AvatarBody {
  constructor(agentName, definition) {
    this.agentName = agentName;
    this.definition = definition;
    this.position = { x: 0, y: 0, z: 0 };
    this.rotation = { x: 0, y: 0, z: 0 };
    this.scale = 1.0;
    this.animationState = "idle";
    this.currentGesture = null;
    this.isSpeaking = false;
    this.isMoving = false;
  }

  moveTo(x, y, z, duration = 1.0) {
    this.position = { x, y, z };
    this.isMoving = true;
    this.animationState = "walking";
    // In a real 3D engine, this would interpolate over duration
    setTimeout(() => {
      this.isMoving = false;
      this.animationState = "idle";
    }, duration * 1000);
  }

  lookAt(targetX, targetY, targetZ) {
    // Simple 2D heading rotation towards target
    const dx = targetX - this.position.x;
    const dz = targetZ - this.position.z;
    this.rotation.y = Math.atan2(dx, dz);
  }

  playGesture(gestureName) {
    this.currentGesture = gestureName;
    setTimeout(() => {
      this.currentGesture = null;
    }, 2000);
  }

  setIdle() {
    this.animationState = "idle";
    this.isSpeaking = false;
  }

  setSpeaking(speaking) {
    this.isSpeaking = speaking;
    if (speaking) {
      // Pick a random speaking gesture from the definition
      const gestures = this.definition.speakingGestures;
      if (gestures && gestures.length > 0) {
        this.playGesture(gestures[Math.floor(Math.random() * gestures.length)]);
      }
    }
  }

  sit() { this.animationState = "sitting"; }
  stand() { this.animationState = "idle"; }

  toJSON() {
    return {
      agentName: this.agentName,
      position: this.position,
      rotation: this.rotation,
      animationState: this.animationState,
      isSpeaking: this.isSpeaking
    };
  }

  fromJSON(data) {
    if (data.position) this.position = data.position;
    if (data.rotation) this.rotation = data.rotation;
    if (data.animationState) this.animationState = data.animationState;
    if (data.isSpeaking) this.isSpeaking = data.isSpeaking;
  }
}

export class AvatarRegistry {
  constructor() {
    this.avatars = new Map();
    this.load();
  }

  get(name) {
    if (!this.avatars.has(name)) {
      const def = getBodyDefinition(name);
      this.avatars.set(name, new AvatarBody(name, def));
    }
    return this.avatars.get(name);
  }

  getAll() {
    return Array.from(this.avatars.values());
  }

  updatePosition(name, x, y, z) {
    const avatar = this.get(name);
    avatar.position = { x, y, z };
  }

  tick(deltaMs) {
    // Logic for ambient movements could go here
    // e.g. randomly triggering idle animations
  }

  save() {
    try {
      fs.mkdirSync(AVATAR_STATE_DIR, { recursive: true });
      const data = {};
      for (const [name, avatar] of this.avatars.entries()) {
        data[name] = avatar.toJSON();
      }
      fs.writeFileSync(path.join(AVATAR_STATE_DIR, 'avatar-states.json'), JSON.stringify(data, null, 2));
    } catch (e) {
      console.error("AvatarRegistry save error:", e);
    }
  }

  load() {
    try {
      const p = path.join(AVATAR_STATE_DIR, 'avatar-states.json');
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        for (const [name, stateData] of Object.entries(data)) {
          const avatar = this.get(name);
          avatar.fromJSON(stateData);
        }
      }
    } catch (e) {
      console.error("AvatarRegistry load error:", e);
    }
  }
}

export class SpatialVoiceAnchor {
  constructor(avatarBody) {
    this.avatar = avatarBody;
    this.direction = { x: 0, y: 0, z: 1 };
    this.range = 20.0; // meters
    this.falloff = 1.5;
  }

  getAudioTransform() {
    return {
      position: this.avatar.position,
      rotation: this.avatar.rotation,
      isSpeaking: this.avatar.isSpeaking
    };
  }
}
