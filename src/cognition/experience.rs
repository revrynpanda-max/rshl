use crate::core::SparseVec;
use crate::core::Universe;
use crate::core::claim::{Claim, LAYER_EXPERIENTIAL};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperienceRecord {
    pub input_text: String,
    pub input_vec: SparseVec,
    pub emotion_label: String,
    pub emotion_vec: SparseVec,
    pub output_text: String,
    pub output_vec: SparseVec,
}

pub const SLOT_INPUT_STR: &str = "slot_experience_input";
pub const SLOT_EMOTION_STR: &str = "slot_experience_emotion";
pub const SLOT_OUTPUT_STR: &str = "slot_experience_output";

pub fn build_experiential_vector(record: &ExperienceRecord) -> SparseVec {
    let slot_in = SparseVec::encode(SLOT_INPUT_STR);
    let slot_em = SparseVec::encode(SLOT_EMOTION_STR);
    let slot_out = SparseVec::encode(SLOT_OUTPUT_STR);

    let bound_in = record.input_vec.bind(&slot_in);
    let bound_em = record.emotion_vec.bind(&slot_em);
    let bound_out = record.output_vec.bind(&slot_out);

    SparseVec::superpose_sparse(&[&bound_in, &bound_em, &bound_out], 0.04)
}

pub fn store_experience(universe: &mut Universe, record: ExperienceRecord) {
    let experiential_vec = build_experiential_vector(&record);
    let text_label = format!(
        "[EXPERIENCE] User felt {} about '{}'. KAI responded: '{}'",
        record.emotion_label, record.input_text, record.output_text
    );

    let mut claim = Claim::new(&text_label, "experience", 3.0, experiential_vec);
    claim.layer = LAYER_EXPERIENTIAL;
    
    // Store in the "experience" region of the universe
    universe.store_claim(claim, "experience");
}

pub fn consolidate_experiences(universe: &mut Universe) -> usize {
    // 1. Gather all experiential cells
    let experiential_cells: Vec<(usize, String, SparseVec)> = universe.get_cells()
        .iter()
        .enumerate()
        .filter(|(_, c)| c.claim.layer == LAYER_EXPERIENTIAL)
        .map(|(i, c)| (i, c.label.clone(), c.claim.vec.clone()))
        .collect();

    if experiential_cells.len() < 3 {
        return 0; // Not enough experiences to consolidate yet
    }

    // 2. Perform simple clustering: group experiences with high VSA cosine similarity (> 0.65)
    let mut clusters: Vec<Vec<SparseVec>> = Vec::new();
    let mut visited = std::collections::HashSet::new();

    for i in 0..experiential_cells.len() {
        if visited.contains(&i) { continue; }
        visited.insert(i);
        let mut current_cluster = vec![experiential_cells[i].2.clone()];

        for j in (i + 1)..experiential_cells.len() {
            if visited.contains(&j) { continue; }
            if experiential_cells[i].2.cosine(&experiential_cells[j].2) > 0.65 {
                visited.insert(j);
                current_cluster.push(experiential_cells[j].2.clone());
            }
        }

        if current_cluster.len() >= 3 {
            clusters.push(current_cluster);
        }
    }

    let mut consolidated_count = 0;

    // 3. Superpose each cluster into a generalized Habit cell
    for (idx, cluster) in clusters.iter().enumerate() {
        let refs: Vec<&SparseVec> = cluster.iter().collect();
        let habit_vec = SparseVec::superpose_sparse(&refs, 0.04);
        
        let text_label = format!(
            "[HABIT] Generalized interaction pattern {} (synthesized from {} experiences)",
            idx + 1, cluster.len()
        );

        // Store this habit cell with high confidence (3.5) as long-term reasoning
        let mut claim = Claim::new(&text_label, "dream-habit", 3.5, habit_vec);
        claim.layer = crate::core::claim::LAYER_CELLULAR;
        
        universe.store_claim(claim, "reasoning");
        consolidated_count += 1;
    }

    consolidated_count
}

/// Sparse engram storage: stores experience as a sparse subset of cells
/// instead of one dense cell. This is more biologically plausible and
/// enables temporal linking through overlapping cell populations.
pub fn store_experience_sparse(
    engram_system: &mut crate::cognition::engram::EngramSystem,
    universe: &mut Universe,
    record: ExperienceRecord,
) -> crate::cognition::engram::Engram {
    let label = format!(
        "User felt {} about '{}'. KAI responded: '{}'",
        record.emotion_label, record.input_text, record.output_text
    );
    
    let slot_in = SparseVec::encode("slot_experience_input");
    let slot_em = SparseVec::encode("slot_experience_emotion");
    let slot_out = SparseVec::encode("slot_experience_output");

    let bound_in = record.input_vec.bind(&slot_in);
    let bound_em = SparseVec::encode(&record.emotion_label).bind(&slot_em);
    let bound_out = record.output_vec.bind(&slot_out);

    let combined = SparseVec::superpose_sparse(&[&bound_in, &bound_em, &bound_out], 0.04);

    engram_system.allocate_engram(universe, &label, &combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_experiential_binding_and_unspooling() {
        let input_text = "I feel so anxious and worried today.";
        let emotion_label = "unease";
        let output_text = "I notice the tension. Take a slow breath — I'm right here with you.";

        let record = ExperienceRecord {
            input_text: input_text.to_string(),
            input_vec: SparseVec::encode(input_text),
            emotion_label: emotion_label.to_string(),
            emotion_vec: SparseVec::encode(emotion_label),
            output_text: output_text.to_string(),
            output_vec: SparseVec::encode(output_text),
        };

        // 1. Bind the experience
        let exp_vec = build_experiential_vector(&record);

        // 2. Unbind in reverse (extract output via SLOT_OUTPUT)
        let slot_out = SparseVec::encode(SLOT_OUTPUT_STR);
        let extracted_out = exp_vec.bind(&slot_out); // in VSA, self-inverse bind is unbind!

        // 3. Verify it is closer to output than random noise
        let sim = extracted_out.cosine(&record.output_vec);
        let noise_sim = extracted_out.cosine(&SparseVec::encode("unrelated noise statement"));
        assert!(sim > 0.10, "VSA unbinding similarity should be high (found {:.4})", sim);
        assert!(sim > noise_sim, "Target unbinding ({:.4}) should exceed noise ({:.4})", sim, noise_sim);
    }

    #[test]
    fn test_experience_real_time_storage() {
        let mut universe = Universe::new();
        let record = ExperienceRecord {
            input_text: "Ouch, my head hurts!".to_string(),
            input_vec: SparseVec::encode("Ouch, my head hurts!"),
            emotion_label: "pain".to_string(),
            emotion_vec: SparseVec::encode("pain"),
            output_text: "I hear you. Rest a moment while we focus the lattice.".to_string(),
            output_vec: SparseVec::encode("I hear you. Rest a moment while we focus the lattice."),
        };

        store_experience(&mut universe, record);

        assert_eq!(universe.cell_count(), 1);
        let cell = &universe.get_cells()[0];
        assert_eq!(cell.claim.layer, LAYER_EXPERIENTIAL);
        assert_eq!(cell.region.as_ref(), "experience");
        assert!(cell.label.contains("felt pain"));
    }

    #[test]
    fn test_experience_clustering_and_consolidation() {
        let mut universe = Universe::new();
        
        // Seed 3 similar pain experiences
        for i in 1..=3 {
            let record = ExperienceRecord {
                input_text: format!("Experience {} with physical pain", i),
                input_vec: SparseVec::encode("physical pain headache sore"),
                emotion_label: "pain".to_string(),
                emotion_vec: SparseVec::encode("pain"),
                output_text: format!("Responding to pain {}", i),
                output_vec: SparseVec::encode("careful focus breathing quiet"),
            };
            store_experience(&mut universe, record);
        }

        // Initially no habit cells
        assert_eq!(universe.get_cells().iter().filter(|c| c.claim.source.as_ref() == "dream-habit").count(), 0);

        // Consolidate experiences
        let habits = consolidate_experiences(&mut universe);
        assert_eq!(habits, 1, "Should consolidate the 3 similar experiences into 1 habit");

        // Verify habit cell exists in reasoning
        let habit_cells: Vec<&crate::core::Cell> = universe.get_cells().iter()
            .filter(|c| c.claim.source.as_ref() == "dream-habit").collect();
        assert_eq!(habit_cells.len(), 1);
        assert_eq!(habit_cells[0].region.as_ref(), "reasoning");
        assert!(habit_cells[0].label.contains("synthesized from 3 experiences"));
    }
}
