use kai::core::{Reasoner, Universe};

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
    let strength_initial = universe.cells()[0].claim.confidence;

    // Store it again (should reinforce)
    universe.store_or_reinforce(fact, "memory", "world-bridge", 1.0);
    let strength_after = universe.cells()[0].claim.confidence;

    assert!(
        strength_after > strength_initial,
        "Hebbian reinforcement failed: {} -> {}",
        strength_initial,
        strength_after
    );
}

#[test]
fn test_legacy_cells_deserialize_into_claims() {
    let raw = r#"{
        "cells": [{
            "label": "",
            "text": "Legacy truth survives schema migration",
            "vec": {"len": 16384, "nz": [[7, 1]]},
            "region": "memory",
            "strength": 2.5,
            "source": "seed",
            "created": 123,
            "continuation": {"len": 16384, "nz": []},
            "last_fired": 9,
            "convergence_score": 0.4
        }]
    }"#;

    let universe: Universe = serde_json::from_str(raw).expect("legacy universe should load");
    let cell = &universe.cells()[0];

    assert_eq!(cell.label, "Legacy truth survives schema migration");
    assert_eq!(cell.claim.text, "Legacy truth survives schema migration");
    assert_eq!(cell.claim.source, "seed");
    assert_eq!(cell.claim.confidence, 2.5);
    assert_eq!(cell.claim.created_at, 123);
    assert_eq!(cell.claim.last_verified, 123);
    assert_eq!(cell.last_fired, 9);
    assert_eq!(cell.nnz, 1);
    assert_eq!(cell.claim.evidence, vec!["seed".to_string()]);
}
