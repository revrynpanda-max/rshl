import fs from 'fs';
import { execSync, exec } from 'child_process';

/**
 * VOCAL DNA Hub
 * Manages the "Voice Lock Signatures" for all lattice users locally.
 */
class VocalBiometrics {
  constructor() {
    this.dbPath = 'c:/KAI/tools/oracle-discord/state/biometric_profiles.json';
    this.dnaDir = 'c:/KAI/tools/oracle-discord/state/dna_signatures';
    this.profiles = new Map();
    if (!fs.existsSync(this.dnaDir)) fs.mkdirSync(this.dnaDir, { recursive: true });
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.dbPath)) {
        const data = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
        this.profiles = new Map(Object.entries(data));
      }
    } catch (e) { console.error("[Biometrics/Hub] Load error:", e); }
  }

  save() {
    try {
      const data = Object.fromEntries(this.profiles);
      fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2));
    } catch (e) { console.error("[Biometrics/Hub] Save error:", e); }
  }

  startEnrollment(username) {
    console.log(`[Biometrics/Hub] Starting enrollment session for ${username}...`);
    this.profiles.set(username, { status: 'ENROLLING', anchoredAt: null });
  }

  anchorProfile(username, audioPath) {
    const dnaPath = `${this.dnaDir}/${username}.npy`;
    try {
      console.log(`[Biometrics/Hub] Anchoring DNA for ${username}...`);
      execSync(`python c:/KAI/tools/oracle-discord/shared/vocal_dna.py --enroll "${audioPath}" "${dnaPath}"`, { windowsHide: true });
      
      this.profiles.set(username, {
        dnaPath: dnaPath,
        anchoredAt: new Date().toISOString(),
        status: 'VERIFIED'
      });
      this.save();
      return true;
    } catch (e) {
      console.error(`[Biometrics/Hub] Enrollment Failed:`, e.message);
      return false;
    }
  }

  async verify(username, audioPath) {
    const profile = this.profiles.get(username);
    if (!profile || !profile.dnaPath) return { success: false, similarity: 0 };

    return new Promise((resolve) => {
      exec(`python c:/KAI/tools/oracle-discord/shared/vocal_dna.py --verify "${audioPath}" "${profile.dnaPath}"`, { windowsHide: true }, (err, stdout) => {
        if (err) {
          console.error(`[Biometrics/Hub] Verification Error:`, err.message);
          return resolve({ success: false, similarity: 0, liveness: 0 });
        }
        const sm = stdout.match(/SIMILARITY: ([\d.]+)/);
        const lm = stdout.match(/LIVENESS: ([\d.]+)/);
        const similarity = sm ? parseFloat(sm[1]) : 0;
        const live = lm ? parseFloat(lm[1]) : 0;
        // Require BOTH a voice-print match AND a live-ish signal (anti-replay floor).
        resolve({ success: similarity > 0.65 && live >= 0.45, similarity, liveness: live });
      });
    });
  }

  /**
   * 1-to-MANY: who does this voice sound like, across ALL enrolled people?
   * This is what recognizes you even on someone else's account.
   * Returns { name, similarity, margin, liveness }.
   */
  async identify(audioPath) {
    return new Promise((resolve) => {
      exec(`python c:/KAI/tools/oracle-discord/shared/vocal_dna.py --identify "${audioPath}" "${this.dnaDir}"`, { windowsHide: true }, (err, stdout) => {
        if (err) return resolve({ name: null, similarity: 0, margin: 0, liveness: 0 });
        const r = stdout.match(/RESULT: (\S+) ([\d.]+) MARGIN: ([\d.\-]+) LIVENESS: ([\d.]+)/);
        if (!r) return resolve({ name: null, similarity: 0, margin: 0, liveness: 0 });
        resolve({ name: r[1] === 'none' ? null : r[1], similarity: parseFloat(r[2]), margin: parseFloat(r[3]), liveness: parseFloat(r[4]) });
      });
    });
  }

  /** Liveness only (0..1). Higher = more likely a live biological voice. */
  async liveness(audioPath) {
    return new Promise((resolve) => {
      exec(`python c:/KAI/tools/oracle-discord/shared/vocal_dna.py --liveness "${audioPath}"`, { windowsHide: true }, (err, stdout) => {
        const m = (stdout || '').match(/LIVENESS: ([\d.]+)/);
        resolve(m ? parseFloat(m[1]) : 0);
      });
    });
  }

  /** Spoken-code factor: store / check a secret passphrase per person. */
  setCode(username, code) {
    const p = this.profiles.get(username) || {};
    p.code = String(code || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    this.profiles.set(username, p); this.save();
  }
  checkCode(username, spokenText) {
    const p = this.profiles.get(username);
    if (!p || !p.code) return false;
    const said = String(spokenText || '').toLowerCase().replace(/[^a-z0-9 ]/g, '');
    return said.includes(p.code);
  }

  /**
   * MULTI-FACTOR AUTH. Combine the factors and decide who this really is.
   *  - onOwnAccount: Discord ID already matched a registered person (strong factor)
   *  - voice identify + liveness (anti-replay)
   *  - optional spoken code (defeats account spoofing)
   * Returns { recognizedAs, trusted, reason, detail }.
   */
  async authenticate(audioPath, { accountName = null, spokenText = '' } = {}) {
    const id = await this.identify(audioPath);
    const voiceHit = id.name && id.similarity >= 0.68 && id.margin >= 0.06;
    const live = id.liveness >= 0.45;
    const codeOK = id.name ? this.checkCode(id.name, spokenText) : false;

    // On their own account + a live voice that matches them = trusted, no code needed.
    if (accountName && voiceHit && live && id.name === accountName)
      return { recognizedAs: accountName, trusted: true, reason: 'account+voice+live', detail: id };
    // Off-account (or wrong account) but voice matches strongly, is live, AND the code is spoken.
    if (voiceHit && live && codeOK)
      return { recognizedAs: id.name, trusted: true, reason: 'voice+live+code (cross-account)', detail: id };
    // Voice matches and live but no code → recognize the person, withhold full clearance.
    if (voiceHit && live)
      return { recognizedAs: id.name, trusted: false, reason: 'voice+live, code required for clearance', detail: id };
    // Matched but liveness failed → likely a recording.
    if (voiceHit && !live)
      return { recognizedAs: id.name, trusted: false, reason: 'voiceprint matched but LIVENESS failed — possible recording', detail: id };
    return { recognizedAs: null, trusted: false, reason: 'no confident voice match', detail: id };
  }

  /**
   * Load the database from disk with fresh state
   */
  loadDB() {
    try {
      if (!fs.existsSync(this.dbPath)) {
        return { profiles: {}, metadata: { lastUpdated: Date.now() } };
      }
      return JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
    } catch (e) {
      console.error("[Biometrics/DB] Load failed:", e.message);
      return { profiles: {}, metadata: { lastUpdated: Date.now() } };
    }
  }

  /**
   * Check if a user is enrolled with fresh DB state
   */
  isEnrolled(name) {
    if (!name) return false;
    const db = this.loadDB(); 
    const profile = db[name];
    if (!profile) return false;
    
    return !!(profile.dnaPath && fs.existsSync(profile.dnaPath));
  }
}

export const biometrics = new VocalBiometrics();

export const BIOMETRIC_SCRIPT = `
"My name is [Your Name]. I am an authorized operative of the KAI Oracle Network. 
My vocal signature is my unique key. I authorize this system to anchor my DNA 
and secure my industrial intelligence against all unauthorized access. 
Encryption protocols active. Sovereign focus engaged."
`.trim();
