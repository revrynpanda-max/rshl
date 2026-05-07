import fs from 'fs';
import { execSync } from 'child_process';

/**
 * TEMPORAL STATE MANAGER
 * Tracks the "Frozen Time" between restarts and detects "Structural Ripples" (Updates).
 */
class TemporalStateManager {
  constructor() {
    this.statePath = 'c:/KAI/tools/oracle-discord/state/temporal_state.json';
    this.state = {
      lastFrozenAt: Date.now(),
      lastThawedAt: Date.now(),
      lastStructuralUpdate: Date.now(),
      totalVoidTime: 0
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, 'utf8').trim();
        if (raw) {
          this.state = JSON.parse(raw);
        }
      }
    } catch (e) { 
      console.warn("[Temporal/State] Load error (healing):", e.message); 
    }
  }

  save() {
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (e) { console.error("[Temporal/State] Save error:", e); }
  }

  /**
   * Called on bot startup to calculate the Ripple.
   */
  thaw() {
    const now = Date.now();
    const voidDuration = now - this.state.lastFrozenAt;
    
    // Detect "Structural Ripple" (Check if any bot file was modified recently)
    let rippleType = "RESUMPTION";
    try {
      // Check for file modifications in the last 10 minutes (approx update time)
      const modifiedFiles = execSync('powershell "Get-ChildItem -Path c:/KAI/tools/oracle-discord/bots/*.mjs | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-10) }"').toString().trim();
      if (modifiedFiles) {
        rippleType = "EVOLUTIONARY_SHIFT";
        this.state.lastStructuralUpdate = now;
      }
    } catch (e) { /* Fallback */ }

    this.state.lastThawedAt = now;
    this.state.totalVoidTime = voidDuration;
    this.save();

    return {
      voidDurationMinutes: Math.round(voidDuration / 60000),
      rippleType,
      message: rippleType === "EVOLUTIONARY_SHIFT" 
        ? "I feel a structural ripple. My code has evolved during the freeze."
        : "Time has resumed. The void was silent."
    };
  }

  /**
   * Called by the ecosystem manager on shutdown.
   */
  freeze() {
    this.state.lastFrozenAt = Date.now();
    this.save();
  }
}

export const temporal = new TemporalStateManager();
