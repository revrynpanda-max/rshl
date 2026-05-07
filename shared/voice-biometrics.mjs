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
      execSync(`python c:/KAI/tools/oracle-discord/shared/vocal_dna.py --enroll "${audioPath}" "${dnaPath}"`);
      
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
      exec(`python c:/KAI/tools/oracle-discord/shared/vocal_dna.py --verify "${audioPath}" "${profile.dnaPath}"`, (err, stdout) => {
        if (err) {
          console.error(`[Biometrics/Hub] Verification Error:`, err.message);
          return resolve({ success: false, similarity: 0 });
        }
        const match = stdout.match(/SIMILARITY: ([\d.]+)/);
        const similarity = match ? parseFloat(match[1]) : 0;
        
        resolve({
          success: similarity > 0.65, 
          similarity: similarity
        });
      });
    });
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
