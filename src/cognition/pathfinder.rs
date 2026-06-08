use std::collections::{BinaryHeap, HashMap, HashSet};
use std::cmp::Ordering;
use crate::core::{Universe, SynapticLayer};

#[derive(Clone)]
struct State {
    cost: f32,
    label: String,
}

impl PartialEq for State {
    fn eq(&self, other: &Self) -> bool {
        self.label == other.label && self.cost == other.cost
    }
}

impl Eq for State {}

impl PartialOrd for State {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        // We want a min-heap, so we reverse the ordering
        other.cost.partial_cmp(&self.cost)
    }
}

impl Ord for State {
    fn cmp(&self, other: &Self) -> Ordering {
        self.partial_cmp(other).unwrap_or(Ordering::Equal)
    }
}

/// A* Algorithm to find the shortest semantic path between two concepts.
/// 
/// - Nodes are cell labels.
/// - Edges are Synapses (weight > 0.05).
/// - Edge cost = 1.0 / (synapse_weight + 0.01). Strong synapses have low travel cost.
/// - Heuristic h(n) = 1.0 - cosine(n_vec, target_vec). Geometrically closer cells look cheaper.
pub fn find_semantic_path(
    universe: &Universe,
    synaptic_layer: &SynapticLayer,
    start_label: &str,
    target_label: &str,
) -> Option<Vec<String>> {
    let start_cell = universe.get_cell_by_label(start_label)?;
    let target_cell = universe.get_cell_by_label(target_label)?;
    let target_keywords = crate::core::universe::extract_query_keywords(&target_cell.claim.text);

    let mut open_set = BinaryHeap::new();
    let mut came_from: HashMap<String, String> = HashMap::new();
    
    // g_score[n] is the cost of the cheapest path from start to n currently known.
    let mut g_score: HashMap<String, f32> = HashMap::new();
    g_score.insert(start_label.to_string(), 0.0);

    // Initial state
    open_set.push(State {
        cost: 0.0,
        label: start_label.to_string(),
    });

    let mut closed_set = HashSet::new();
    let mut steps = 0;
    const MAX_STEPS: usize = 2000;

    while let Some(State { cost: _, label: current }) = open_set.pop() {
        steps += 1;
        if steps > MAX_STEPS {
            break;
        }

        if current == target_label {
            // We reached the target. Reconstruct path.
            let mut path = vec![current.clone()];
            let mut curr = current;
            while let Some(prev) = came_from.get(&curr) {
                path.push(prev.clone());
                curr = prev.clone();
            }
            path.reverse();
            return Some(path);
        }

        if !closed_set.insert(current.clone()) {
            continue; // Already processed
        }

        let current_g = *g_score.get(&current).unwrap_or(&f32::INFINITY);

        // Get neighbors (outgoing synapses)
        let synapses = synaptic_layer.strongest_from(&current, 50); // Look at top 50 connections
        
        for syn in synapses {
            if syn.weight < 0.05 { continue; } // Ignore very weak connections
            
            let neighbor = syn.post_label.to_string();
            if closed_set.contains(&neighbor) { continue; }

            // Edge cost is inverse of synapse strength
            let edge_cost = 1.0 / (syn.weight + 0.01);
            let tentative_g_score = current_g + edge_cost;

            let neighbor_g = *g_score.get(&neighbor).unwrap_or(&f32::INFINITY);
            
            if tentative_g_score < neighbor_g {
                // This path to neighbor is better than any previous one. Record it!
                came_from.insert(neighbor.clone(), current.clone());
                g_score.insert(neighbor.clone(), tentative_g_score);

                // Calculate heuristic (geometric distance + lexical penalty)
                let mut h = 0.0;
                if let Some(neighbor_cell) = universe.get_cell_by_label(&neighbor) {
                    let cos = neighbor_cell.claim.vec.cosine(&target_cell.claim.vec);
                    let kw = crate::core::universe::keyword_overlap_score(&target_keywords, &neighbor_cell.claim.text);
                    h = (1.0 - cos) * 0.6 + (1.0 - kw) * 0.4; // Hybrid semantic-lexical distance
                }

                let f_score = tentative_g_score + h;
                
                open_set.push(State {
                    cost: f_score,
                    label: neighbor.clone(),
                });
            }
        }
    }

    // No path found
    None
}
