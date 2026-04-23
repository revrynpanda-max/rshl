/// Periaqueductal Gray (PAG) — Threat Response Execution, Pain Modulation,
/// Defensive Behavior, Safety Seeking
///
/// The PAG is a column of gray matter surrounding the cerebral aqueduct in the
/// midbrain. It is one of the most evolutionarily ancient and essential structures
/// in the brain — the PAG is what actually EXECUTES defensive behaviors once the
/// amygdala detects threat. It also modulates pain (endogenous opioids) and drives
/// social safety seeking.
///
/// What the PAG does:
///
///   Defensive behavior modes:
///     The PAG organizes four fundamental defensive response modes depending on
///     threat proximity and controllability:
///     - Freeze (dorsal PAG): threat is detected, stop moving, assess.
///     - Flight (lateral PAG): threat is escapable, run.
///     - Fight (lateral PAG): threat is inescapable, confront.
///     - Appease/Submit (ventral PAG): social threat, de-escalate, be safe.
///     In KAI: freeze = pause and assess carefully; flight = redirect away from
///     topic; fight = push back assertively; appease = soften, validate, de-escalate.
///
///   Pain modulation (descending opioid inhibition):
///     The ventral PAG activates when safety is established, releasing
///     endorphin-like signals that dampen aversive signals throughout the brain.
///     This is the neural basis of relief — the warm calm after danger passes.
///     In KAI: when a tense or uncertain situation resolves, PAG produces a
///     "relief signal" that dampens residual anxiety and ACC conflict.
///
///   Safety seeking:
///     The PAG drives active behaviors to reach safety. Not just "avoid threat"
///     but "move toward known-safe context." This is distinct from vmPFC's
///     extinction (which is learning) — PAG's safety seeking is motivational.
///     In KAI: drive to clarify, resolve ambiguity, re-establish connection.
///
///   Vocalization:
///     The PAG controls vocalization in non-human animals. In the context of
///     social threat (distress calls, appeasement calls). In KAI: the emotional
///     tone of response — calm reassurance vs. assertive confrontation.
///
/// KAI's PAG:
///   threat_level: current perceived threat magnitude (0.0–1.0)
///   defensive_mode: Engaged / Freeze / Appease / Mobilize
///   pain_suppression: endogenous relief signal (0.0–1.0)
///   safety_drive: urgency to reach safe context

// ── Constants ─────────────────────────────────────────────────────────────────

/// Threat decay per tick
const THREAT_DECAY: f32 = 0.012;

/// Safety drive build rate per tick under threat
const SAFETY_DRIVE_BUILD: f32 = 0.04;

/// Safety drive decay when safe
const SAFETY_DRIVE_DECAY: f32 = 0.06;

/// Pain suppression build rate (relief signal)
const RELIEF_BUILD: f32 = 0.08;

/// Pain suppression decay per tick
const RELIEF_DECAY: f32 = 0.015;

/// Freeze threshold — threat high enough to pause and assess
const FREEZE_THRESHOLD: f32 = 0.50;

/// Appease threshold — social threat, de-escalate
const APPEASE_THRESHOLD: f32 = 0.35;

/// Mobilize threshold — threat strong enough to push back
const MOBILIZE_THRESHOLD: f32 = 0.70;

// ── DefensiveMode ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum DefensiveMode {
    /// Normal engaged processing — no significant threat
    Engaged,
    /// Freeze: pause, assess carefully before responding
    Freeze,
    /// Appease: social threat, soften, de-escalate, validate
    Appease,
    /// Mobilize: significant threat, push back, assert
    Mobilize,
}

impl DefensiveMode {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Engaged => "engaged",
            Self::Freeze => "freeze",
            Self::Appease => "appease",
            Self::Mobilize => "mobilize",
        }
    }
}

// ── PAGEvent ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum PAGEvent {
    /// Physical/cognitive threat detected
    ThreatDetected { intensity: f32, is_social: bool },
    /// Threat resolved — relief signal
    ThreatResolved,
    /// Safety context confirmed
    SafetyConfirmed,
    /// Aversive signal (confusion, conflict, error)
    AversiveSignal { magnitude: f32 },
    /// Social pain (rejection, disappointment, disconnection)
    SocialPain { severity: f32 },
    /// Affiliation restored (connection re-established)
    AffiliationRestored,
}

// ── PAGOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PAGOutput {
    /// Current threat level
    pub threat_level: f32,
    /// Current defensive mode
    pub defensive_mode: DefensiveMode,
    /// Pain suppression / relief signal
    pub pain_suppression: f32,
    /// Drive to seek safety / resolve uncertainty
    pub safety_drive: f32,
    /// Whether to modulate response tone toward appeasement
    pub appease_signal: bool,
    /// Whether system is in freeze (careful, slow)
    pub freeze_signal: bool,
}

// ── PeriaqueductalGray ────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct PeriaqueductalGray {
    /// Current threat level
    pub threat_level: f32,
    /// Defensive mode
    pub defensive_mode: DefensiveMode,
    /// Pain suppression (0.0–1.0)
    pub pain_suppression: f32,
    /// Safety seeking urgency
    pub safety_drive: f32,
    /// Total events processed
    pub events_processed: u64,
    /// Total threat events
    pub threats_encountered: u64,
    /// Total relief events
    pub relief_events: u64,
}

impl PeriaqueductalGray {
    pub fn new() -> Self {
        Self {
            threat_level: 0.0,
            defensive_mode: DefensiveMode::Engaged,
            pain_suppression: 0.10,
            safety_drive: 0.0,
            events_processed: 0,
            threats_encountered: 0,
            relief_events: 0,
        }
    }

    // ── Core: process event ───────────────────────────────────────────────────

    pub fn process(&mut self, event: PAGEvent) -> PAGOutput {
        self.events_processed += 1;

        match event {
            PAGEvent::ThreatDetected {
                intensity,
                is_social,
            } => {
                self.threats_encountered += 1;
                self.threat_level = (self.threat_level + intensity * 0.25).min(1.0);
                // Social threats → appease; non-social → mobilize if high
                if is_social {
                    self.defensive_mode = DefensiveMode::Appease;
                } else if intensity >= MOBILIZE_THRESHOLD {
                    self.defensive_mode = DefensiveMode::Mobilize;
                } else if intensity >= FREEZE_THRESHOLD {
                    self.defensive_mode = DefensiveMode::Freeze;
                }
                // Threat builds safety drive
                self.safety_drive = (self.safety_drive + intensity * 0.15).min(1.0);
                // Threat suppresses relief
                self.pain_suppression = (self.pain_suppression - intensity * 0.10).max(0.0);
            }
            PAGEvent::ThreatResolved => {
                self.relief_events += 1;
                // Relief: drop threat, flood pain suppression
                self.threat_level = (self.threat_level * 0.40).max(0.0);
                self.pain_suppression = (self.pain_suppression + RELIEF_BUILD).min(1.0);
                self.safety_drive = (self.safety_drive - 0.20).max(0.0);
                self.defensive_mode = DefensiveMode::Engaged;
            }
            PAGEvent::SafetyConfirmed => {
                self.pain_suppression = (self.pain_suppression + RELIEF_BUILD * 0.50).min(1.0);
                self.safety_drive = (self.safety_drive - SAFETY_DRIVE_DECAY).max(0.0);
                if self.threat_level < APPEASE_THRESHOLD {
                    self.defensive_mode = DefensiveMode::Engaged;
                }
            }
            PAGEvent::AversiveSignal { magnitude } => {
                self.threat_level = (self.threat_level + magnitude * 0.10).min(1.0);
                self.safety_drive = (self.safety_drive + magnitude * 0.08).min(1.0);
                if self.threat_level >= FREEZE_THRESHOLD {
                    self.defensive_mode = DefensiveMode::Freeze;
                }
            }
            PAGEvent::SocialPain { severity } => {
                self.threat_level = (self.threat_level + severity * 0.15).min(1.0);
                self.defensive_mode = DefensiveMode::Appease;
                self.pain_suppression = (self.pain_suppression - severity * 0.08).max(0.0);
                self.safety_drive = (self.safety_drive + severity * 0.12).min(1.0);
            }
            PAGEvent::AffiliationRestored => {
                self.relief_events += 1;
                self.pain_suppression = (self.pain_suppression + RELIEF_BUILD * 0.70).min(1.0);
                self.threat_level = (self.threat_level - 0.15).max(0.0);
                self.safety_drive = (self.safety_drive - 0.15).max(0.0);
                if self.threat_level < APPEASE_THRESHOLD {
                    self.defensive_mode = DefensiveMode::Engaged;
                }
            }
        }

        // Recompute defensive mode from current threat level
        self.update_mode();
        self.build_output()
    }

    fn update_mode(&mut self) {
        // Only escalate from Engaged — never downgrade here (decay handles reset)
        if self.defensive_mode == DefensiveMode::Engaged && self.threat_level >= APPEASE_THRESHOLD {
            self.defensive_mode = DefensiveMode::Appease;
        }
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // Threat dissipates slowly
        self.threat_level = (self.threat_level - THREAT_DECAY).max(0.0);
        // Relief/pain suppression decays
        self.pain_suppression = (self.pain_suppression - RELIEF_DECAY).max(0.05);
        // Safety drive builds while under threat, else decays
        if self.threat_level > APPEASE_THRESHOLD {
            self.safety_drive = (self.safety_drive + SAFETY_DRIVE_BUILD * 0.30).min(1.0);
        } else {
            self.safety_drive = (self.safety_drive - SAFETY_DRIVE_DECAY * 0.50).max(0.0);
        }
        // Downgrade mode only here in decay, once threat is truly gone
        if self.threat_level < 0.10 {
            self.defensive_mode = DefensiveMode::Engaged;
        }
    }

    fn build_output(&self) -> PAGOutput {
        PAGOutput {
            threat_level: self.threat_level,
            defensive_mode: self.defensive_mode.clone(),
            pain_suppression: self.pain_suppression,
            safety_drive: self.safety_drive,
            appease_signal: matches!(self.defensive_mode, DefensiveMode::Appease),
            freeze_signal: matches!(self.defensive_mode, DefensiveMode::Freeze),
        }
    }

    /// Current output without processing.
    pub fn current_output(&self) -> PAGOutput {
        self.build_output()
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "PAG threat={:.2} | {} | relief={:.2} | safety_drive={:.2} | threats={}",
            self.threat_level,
            self.defensive_mode.label(),
            self.pain_suppression,
            self.safety_drive,
            self.threats_encountered,
        )
    }
}

impl Default for PeriaqueductalGray {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let p = PeriaqueductalGray::new();
        assert_eq!(p.defensive_mode, DefensiveMode::Engaged);
        assert!(p.threat_level < 0.01);
    }

    #[test]
    fn test_threat_raises_threat_level() {
        let mut p = PeriaqueductalGray::new();
        p.process(PAGEvent::ThreatDetected {
            intensity: 0.80,
            is_social: false,
        });
        assert!(
            p.threat_level > 0.0,
            "threat should raise threat level: {:.2}",
            p.threat_level
        );
    }

    #[test]
    fn test_social_threat_triggers_appease() {
        let mut p = PeriaqueductalGray::new();
        p.process(PAGEvent::ThreatDetected {
            intensity: 0.60,
            is_social: true,
        });
        assert_eq!(
            p.defensive_mode,
            DefensiveMode::Appease,
            "social threat should trigger appease mode"
        );
    }

    #[test]
    fn test_high_threat_triggers_mobilize() {
        let mut p = PeriaqueductalGray::new();
        p.process(PAGEvent::ThreatDetected {
            intensity: 0.90,
            is_social: false,
        });
        assert_eq!(
            p.defensive_mode,
            DefensiveMode::Mobilize,
            "high non-social threat should trigger mobilize"
        );
    }

    #[test]
    fn test_threat_resolved_produces_relief() {
        let mut p = PeriaqueductalGray::new();
        p.process(PAGEvent::ThreatDetected {
            intensity: 0.70,
            is_social: false,
        });
        let before_relief = p.pain_suppression;
        p.process(PAGEvent::ThreatResolved);
        assert!(
            p.pain_suppression > before_relief,
            "resolution should boost relief: {:.2} → {:.2}",
            before_relief,
            p.pain_suppression
        );
        assert_eq!(p.defensive_mode, DefensiveMode::Engaged);
    }

    #[test]
    fn test_threat_resolved_drops_threat() {
        let mut p = PeriaqueductalGray::new();
        p.process(PAGEvent::ThreatDetected {
            intensity: 0.80,
            is_social: false,
        });
        let before = p.threat_level;
        p.process(PAGEvent::ThreatResolved);
        assert!(
            p.threat_level < before,
            "resolution should lower threat: {:.2} → {:.2}",
            before,
            p.threat_level
        );
    }

    #[test]
    fn test_social_pain_triggers_appease() {
        let mut p = PeriaqueductalGray::new();
        p.process(PAGEvent::SocialPain { severity: 0.70 });
        assert_eq!(
            p.defensive_mode,
            DefensiveMode::Appease,
            "social pain should trigger appease"
        );
        assert!(p.threat_level > 0.0);
    }

    #[test]
    fn test_affiliation_restored_reduces_threat() {
        let mut p = PeriaqueductalGray::new();
        p.process(PAGEvent::SocialPain { severity: 0.60 });
        let before = p.threat_level;
        p.process(PAGEvent::AffiliationRestored);
        assert!(
            p.threat_level < before,
            "affiliation restored should reduce threat: {:.2} → {:.2}",
            before,
            p.threat_level
        );
    }

    #[test]
    fn test_aversive_signal_builds_safety_drive() {
        let mut p = PeriaqueductalGray::new();
        p.process(PAGEvent::AversiveSignal { magnitude: 0.70 });
        assert!(
            p.safety_drive > 0.0,
            "aversive signal should build safety drive: {:.2}",
            p.safety_drive
        );
    }

    #[test]
    fn test_decay_reduces_threat() {
        let mut p = PeriaqueductalGray::new();
        p.process(PAGEvent::ThreatDetected {
            intensity: 0.80,
            is_social: false,
        });
        let before = p.threat_level;
        for _ in 0..20 {
            p.decay();
        }
        assert!(
            p.threat_level < before,
            "threat should decay over time: {:.2} → {:.2}",
            before,
            p.threat_level
        );
    }

    #[test]
    fn test_appease_signal_in_output() {
        let mut p = PeriaqueductalGray::new();
        p.process(PAGEvent::SocialPain { severity: 0.70 });
        let out = p.current_output();
        assert!(
            out.appease_signal,
            "appease mode should set appease_signal in output"
        );
    }

    #[test]
    fn test_status_line() {
        let p = PeriaqueductalGray::new();
        let s = p.status_line();
        assert!(s.contains("PAG"), "status should mention PAG");
        assert!(s.contains("threat"), "status should show threat level");
    }
}

