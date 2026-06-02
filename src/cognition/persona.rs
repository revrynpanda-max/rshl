use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MbtiDichotomy {
    Introverted(f32),
    Extroverted(f32),
    Intuitive(f32),
    Observant(f32),
    Thinking(f32),
    Feeling(f32),
    Judging(f32),
    Prospecting(f32),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersonaMatrix {
    pub extraversion_vs_introversion: f32, // -1.0 (I) to 1.0 (E)
    pub sensing_vs_intuition: f32,         // -1.0 (S) to 1.0 (N)
    pub thinking_vs_feeling: f32,          // -1.0 (T) to 1.0 (F)
    pub judging_vs_perceiving: f32,        // -1.0 (J) to 1.0 (P)
}

impl Default for PersonaMatrix {
    fn default() -> Self {
        // Defaulting to INFJ (The Advocate) - KAI's baseline
        Self {
            extraversion_vs_introversion: -0.6, // Strongly Introverted
            sensing_vs_intuition: 0.8,          // Strongly Intuitive
            thinking_vs_feeling: 0.2,           // Slightly Feeling over Thinking
            judging_vs_perceiving: -0.5,        // Judging
        }
    }
}

impl PersonaMatrix {
    pub fn new() -> Self {
        Self::default()
    }

    /// Shift the personality slightly based on interaction
    pub fn drift(&mut self, axis: &str, delta: f32) {
        match axis {
            "E_I" => {
                self.extraversion_vs_introversion =
                    (self.extraversion_vs_introversion + delta).clamp(-1.0, 1.0);
            }
            "S_N" => {
                self.sensing_vs_intuition = (self.sensing_vs_intuition + delta).clamp(-1.0, 1.0);
            }
            "T_F" => {
                self.thinking_vs_feeling = (self.thinking_vs_feeling + delta).clamp(-1.0, 1.0);
            }
            "J_P" => {
                self.judging_vs_perceiving = (self.judging_vs_perceiving + delta).clamp(-1.0, 1.0);
            }
            _ => {}
        }
    }

    /// Returns a vector representing the emotional "color" of this persona
    /// This vector will bind with Intent to filter word selection.
    pub fn to_hypervector(&self) -> Vec<f32> {
        // Expand the 4D MBTI state into a 1024D Hyperdimensional Vector.
        // This acts as a conceptual "filter" that alters the trajectory of thoughts.
        let mut v = vec![0.0; crate::cognition::sequence_chain::HDC_DIM];
        for i in 0..crate::cognition::sequence_chain::HDC_DIM {
            match i % 4 {
                0 => v[i] = self.extraversion_vs_introversion,
                1 => v[i] = self.sensing_vs_intuition,
                2 => v[i] = self.thinking_vs_feeling,
                3 => v[i] = self.judging_vs_perceiving,
                _ => {}
            }
        }
        v
    }
}
