use kai::cognition::reasoner::Reasoner;
use kai::core::Universe;

#[test]
fn test_cognitive_resonance_loop() {
    let mut universe = Universe::new();

    // 1. Seed with high-resonance knowledge
    universe.store(
        "KAI is a geometric intelligence engine using RSHL architecture",
        "reasoning",
        "seed",
        2.0,
    );
    universe.store(
        "RSHL uses 4096-dimensional sparse ternary vectors",
        "reasoning",
        "seed",
        2.0,
    );
    universe.store(
        "Ryan built KAI as a digital species in 2026",
        "reasoning",
        "ryan",
        2.0,
    );

    // 2. Perform a resonance query for a specific concept
    let hits = universe.query("geometric RSHL architecture", 5);
    assert!(
        !hits.is_empty(),
        "KAI should have found hits for 'geometric RSHL architecture'"
    );
    let any_match = hits
        .iter()
        .any(|h| h.text.contains("geometric intelligence"));
    assert!(
        any_match,
        "KAI should have found the geometric intelligence cell in top hits. Hits: {:?}",
        hits
    );

    // 3. Test the iterative reasoner convergence
    let reasoner = Reasoner::new();
    // High-resonance query that exactly matches a seed
    let result = reasoner.reason(
        "geometric intelligence engine using RSHL architecture",
        &universe,
    );

    assert!(
        result.confidence > 0.1,
        "Reasoning should have converged with healthy confidence: {}",
        result.confidence
    );
    assert!(
        !result.output_text.is_empty(),
        "Reasoner should have generated output text"
    );

    // Verify the output text matches our seed data knowledge
    let has_intel =
        result.output_text.contains("intelligence") || result.output_text.contains("geometric");
    let has_rshl =
        result.output_text.contains("RSHL") || result.output_text.contains("architecture");

    assert!(
        has_intel || has_rshl,
        "Reasoning result should be semantically linked to seed data. Got: {}",
        result.output_text
    );
}

#[test]
fn test_hebbian_persistence() {
    let mut universe = Universe::new();
    let fact = "The universe is expanding";

    // Store it once
    universe.store(fact, "memory", "world-bridge", 1.0);
    let strength_initial = universe.cells()[0].strength;

    // Store it again (should reinforce)
    universe.store_or_reinforce(fact, "memory", "world-bridge", 1.0);
    let strength_after = universe.cells()[0].strength;

    assert!(
        strength_after > strength_initial,
        "Hebbian reinforcement failed: {} -> {}",
        strength_initial,
        strength_after
    );
}
