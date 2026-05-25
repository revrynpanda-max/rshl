import re

with open('C:/KAI/src/core/universe.rs', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Update Universe struct
text = text.replace('pub text_store: Option<super::text_store::TextStore>,\n}', 'pub text_store: Option<super::text_store::TextStore>,\n    #[serde(default = "default_calibration_floor")]\n    pub calibration_floor: f32,\n    #[serde(default)]\n    pub recent_contradictions: u32,\n}\n\nfn default_calibration_floor() -> f32 { 0.40 }')

# 2. Update Universe::clone
text = text.replace('text_store: None,\n        }', 'text_store: None,\n            calibration_floor: self.calibration_floor,\n            recent_contradictions: self.recent_contradictions,\n        }')

# 3. Update Universe::new
text = text.replace('text_store: None,\n        }\n    }', 'text_store: None,\n            calibration_floor: 0.40,\n            recent_contradictions: 0,\n        }\n    }')

# 4. Update ingest_and_verify
text = text.replace('const COHERENCE_FLOOR: f32 = 0.40;', 'let coherence_floor = if self.calibration_floor > 0.0 { self.calibration_floor } else { 0.40 };')
text = text.replace('if angle3_resonance < COHERENCE_FLOOR {', 'if angle3_resonance < coherence_floor {')
text = text.replace('angle3_resonance, COHERENCE_FLOOR', 'angle3_resonance, coherence_floor')

gatekeeper = '        // ── Epistemic Gatekeeper ───────────────────────────────────────────'
new_gatekeeper = '''        if angle2_score > 0.0 {
            self.recent_contradictions = self.recent_contradictions.saturating_add(1);
            if self.recent_contradictions > 5 {
                self.calibration_floor = (self.calibration_floor + 0.05).min(0.65);
                self.recent_contradictions = 0;
            }
        } else {
            self.calibration_floor = (self.calibration_floor - 0.01).max(0.40);
        }

        // ── Epistemic Gatekeeper ───────────────────────────────────────────'''
text = text.replace(gatekeeper, new_gatekeeper)

# 5. Phasor Coherence in query_fast
qfast_start = '''        let mag_q_sqrt = mag_q.sqrt();

        let mut scored: Vec<(usize, f32)> = self.cells
            .iter()'''
qfast_new_start = '''        let mag_q_sqrt = mag_q.sqrt();
        let theta_q = q.phase_angle();

        let mut scored: Vec<(usize, f32)> = self.cells
            .iter()'''
text = text.replace(qfast_start, qfast_new_start)

qfast_cosine = '''                let cosine = if mag_q > 0.0 && mag_c > 0.0 {
                    dot as f32 / (mag_q_sqrt * mag_c.sqrt())
                } else { 0.0 };
                let kw = keyword_overlap_score(&query_words, &cell.claim.text);
                let raw = 0.6 * cosine + 0.4 * kw;'''
qfast_phasor = '''                let cosine = if mag_q > 0.0 && mag_c > 0.0 {
                    dot as f32 / (mag_q_sqrt * mag_c.sqrt())
                } else { 0.0 };
                let theta_c = cell.claim.vec.phase_angle();
                let phasor_coherence = cosine * (theta_q - theta_c).cos();
                let kw = keyword_overlap_score(&query_words, &cell.claim.text);
                let raw = 0.6 * phasor_coherence + 0.4 * kw;'''
text = text.replace(qfast_cosine, qfast_phasor)

# 6. Phasor Coherence in query_in_regions
qreg_start = '''        let mag_q = q.nnz() as f32;
        let mag_q_sqrt = mag_q.sqrt();

        let mut scored: Vec<(usize, f32)> = self.cells
            .iter()'''
qreg_new_start = '''        let mag_q = q.nnz() as f32;
        let mag_q_sqrt = mag_q.sqrt();
        let theta_q = q.phase_angle();

        let mut scored: Vec<(usize, f32)> = self.cells
            .iter()'''
text = text.replace(qreg_start, qreg_new_start)

text = text.replace('let raw = 0.6 * cosine + 0.4 * kw;', 'let theta_c = cell.claim.vec.phase_angle();\n                let phasor_coherence = cosine * (theta_q - theta_c).cos();\n                let raw = 0.6 * phasor_coherence + 0.4 * kw;')

# 7. Phasor Coherence in predictive_query_filtered (and others using state.cosine)
text = text.replace('let sim = state.cosine(&cell.claim.vec).max(0.0);', 'let sim = state.phasor_coherence(&cell.claim.vec).max(0.0);')
text = text.replace('prediction_anchor.cosine(c).max(0.0)', 'prediction_anchor.phasor_coherence(c).max(0.0)')

with open('C:/KAI/src/core/universe.rs', 'w', encoding='utf-8') as f:
    f.write(text)
