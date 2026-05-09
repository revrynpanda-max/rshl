//! Scale Manager — Layer-specific management for the RSHL lattice.
//!
//! Different layers (Quantum, Syncytium, Cellular, Organ, Body) have
//! different temporal speeds, movement radii, and vitality budgets.

pub struct LayerSettings {
    pub scale_factor: f32,      // f(sigma)
    pub vitality_decay: f32,    // delta
    pub vitality_replenish: f32,// epsilon
    pub movement_speed: f32,
    pub neighbor_radius: f32,   // Cosine similarity threshold for neighbors
}

pub fn get_settings_for_layer(layer_id: u8) -> LayerSettings {
    // NOTE: movement_speed must be scaled for ternary vectors (positions are ±1).
    // Velocities must exceed ~0.3-0.5 to compete with the ternary magnitude after
    // requantization. Previous values (0.005–0.1) were 10-50x too small — boids
    // were completely frozen. Empirically validated at DIM=1024, density=4%.
    match layer_id {
        // Layer 0: Quantum (Substrate) - Fast, highly volatile, maximum exploration
        0 => LayerSettings {
            scale_factor: 1.5,
            vitality_decay: 0.05,
            vitality_replenish: 0.01,
            movement_speed: 0.40,
            neighbor_radius: 0.3,
        },
        // Layer 1: Global Syncytium (Shared Knowledge) - Gentle drift, broad consensus
        1 => LayerSettings {
            scale_factor: 1.0,
            vitality_decay: 0.01,
            vitality_replenish: 0.005,
            movement_speed: 0.25,
            neighbor_radius: 0.4,
        },
        // Layer 2: User Cellularization (Isolated Memory) - Responsive, personalized
        2 => LayerSettings {
            scale_factor: 1.2,
            vitality_decay: 0.02,
            vitality_replenish: 0.01,
            movement_speed: 0.35,
            neighbor_radius: 0.5,
        },
        // Layer 3: Agent/Organ - Stable, slow deliberate movement
        3 => LayerSettings {
            scale_factor: 0.8,
            vitality_decay: 0.005,
            vitality_replenish: 0.002,
            movement_speed: 0.15,
            neighbor_radius: 0.6,
        },
        // Layer 4: Global Body - Near-frozen, only moves under strong consensus
        4 => LayerSettings {
            scale_factor: 0.5,
            vitality_decay: 0.001,
            vitality_replenish: 0.001,
            movement_speed: 0.08,
            neighbor_radius: 0.7,
        },
        _ => get_settings_for_layer(1), // Default to Syncytium
    }
}
