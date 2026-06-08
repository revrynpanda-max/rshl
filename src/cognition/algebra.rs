use crate::core::PosDictionary;

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Tense {
    Past,
    Present,
    PresentContinuous,
    Future,
    Unknown,
}

impl std::fmt::Display for Tense {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Tense::Past => write!(f, "Past"),
            Tense::Present => write!(f, "Present"),
            Tense::PresentContinuous => write!(f, "Present-Continuous"),
            Tense::Future => write!(f, "Future"),
            Tense::Unknown => write!(f, "Unknown"),
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum AlgebraicNode {
    QuestionNode(String),
    FillerNode(String),
    EntityNode(String), // X, Y
    ActionNode(String, Tense),
    RelationalNode(String),
    StateOfBeingNode(String, Tense),
    TemporalNode(String, Tense),
}

impl AlgebraicNode {
    pub fn symbol(&self) -> &str {
        match self {
            Self::QuestionNode(_) => "Q",
            Self::FillerNode(_) => "F",
            Self::EntityNode(_) => "E",
            Self::ActionNode(_, _) => "A",
            Self::RelationalNode(_) => "R",
            Self::StateOfBeingNode(_, _) => "S",
            Self::TemporalNode(_, _) => "T",
        }
    }
    
    pub fn text(&self) -> &str {
        match self {
            Self::QuestionNode(s) => s,
            Self::FillerNode(s) => s,
            Self::EntityNode(s) => s,
            Self::ActionNode(s, _) => s,
            Self::RelationalNode(s) => s,
            Self::StateOfBeingNode(s, _) => s,
            Self::TemporalNode(s, _) => s,
        }
    }
}

pub struct SemanticEquation {
    pub nodes: Vec<AlgebraicNode>,
    pub formula: String,
    pub intent_sum: String,
    pub has_action: bool,
    pub entities: Vec<String>,
    pub actions: Vec<String>,
    pub overall_tense: Tense,
}

pub fn parse_equation(input: &str, pos_dict: Option<&PosDictionary>) -> SemanticEquation {
    let mut nodes = Vec::new();
    let mut has_action = false;
    let mut entities = Vec::new();
    let mut actions = Vec::new();
    let mut active_tense = Tense::Unknown;

    let question_words = ["what", "who", "where", "when", "why", "how", "which"];
    let fillers = ["the", "a", "an", "to", "of", "and", "but", "so"];
    let relations = ["with", "for", "about", "against", "toward", "from", "by", "in", "on", "at"];
    
    let present_states = ["is", "are", "am", "be"];
    let continuous_states = ["being"];
    let past_states = ["was", "were", "been"];
    
    let past_temps = ["did", "had"];
    let present_temps = ["do", "does", "have", "has", "can"];
    let future_temps = ["will", "would", "shall", "could"];
    
    let time_dimensions = ["year", "time", "date", "day", "month", "century", "moment", "era"];

    // Rolling state tracker for compounding intent
    let mut dimensional_index = String::new();
    let mut previous_was_question = false;
    let mut sequence_intent_modifiers = Vec::new();

    let words: Vec<&str> = input.split_whitespace().collect();
    
    for (i, word) in words.iter().enumerate() {
        let clean = word.trim_matches(|c: char| !c.is_alphanumeric());
        if clean.is_empty() {
            continue;
        }
        let lower = clean.to_lowercase();
        let is_capitalized = clean.chars().next().map(|c| c.is_uppercase()).unwrap_or(false);

        // Check for dimensional state collapse (e.g., "What" + "year" -> Time Dimension Index)
        if previous_was_question && time_dimensions.contains(&lower.as_str()) {
            dimensional_index = format!("TimeDimension[{}]", clean);
            nodes.push(AlgebraicNode::TemporalNode(dimensional_index.clone(), active_tense));
            sequence_intent_modifiers.push(format!("Collapsed superposition to {}", dimensional_index));
            previous_was_question = false;
            continue;
        }

        if question_words.contains(&lower.as_str()) {
            nodes.push(AlgebraicNode::QuestionNode(clean.to_string()));
            previous_was_question = true;
            if lower == "when" {
                dimensional_index = "TimeDimension[when]".to_string();
                sequence_intent_modifiers.push("Initialized Time Dimension".to_string());
            }
            continue;
        }
        previous_was_question = false;

        if fillers.contains(&lower.as_str()) {
            nodes.push(AlgebraicNode::FillerNode(clean.to_string()));
            continue;
        }

        if relations.contains(&lower.as_str()) {
            nodes.push(AlgebraicNode::RelationalNode(clean.to_string()));
            continue;
        }
        
        // Check States of Being and deeply inspect compound morphology ("be" + "come" handled via LexSem usually, but we capture the root intent)
        if present_states.contains(&lower.as_str()) {
            active_tense = Tense::Present;
            nodes.push(AlgebraicNode::StateOfBeingNode(clean.to_string(), Tense::Present));
            continue;
        } else if continuous_states.contains(&lower.as_str()) {
            active_tense = Tense::PresentContinuous;
            nodes.push(AlgebraicNode::StateOfBeingNode(clean.to_string(), Tense::PresentContinuous));
            continue;
        } else if past_states.contains(&lower.as_str()) {
            active_tense = Tense::Past;
            nodes.push(AlgebraicNode::StateOfBeingNode(clean.to_string(), Tense::Past));
            continue;
        }
        
        // Check Temporal Modifiers
        if past_temps.contains(&lower.as_str()) {
            active_tense = Tense::Past;
            nodes.push(AlgebraicNode::TemporalNode(clean.to_string(), Tense::Past));
            sequence_intent_modifiers.push("Shifted vector to Past".to_string());
            continue;
        } else if present_temps.contains(&lower.as_str()) {
            active_tense = Tense::Present;
            nodes.push(AlgebraicNode::TemporalNode(clean.to_string(), Tense::Present));
            sequence_intent_modifiers.push("Anchored vector to Present".to_string());
            continue;
        } else if future_temps.contains(&lower.as_str()) {
            active_tense = Tense::Future;
            nodes.push(AlgebraicNode::TemporalNode(clean.to_string(), Tense::Future));
            sequence_intent_modifiers.push("Projected vector to Future".to_string());
            continue;
        }

        // Deep Suffix/Prefix Dimensional Analysis
        let mut morphological_intent = String::new();
        if lower.starts_with("re") && lower.len() > 4 {
            morphological_intent = "Repetitive/Reversal intent ".to_string();
        } else if lower.starts_with("un") || lower.starts_with("dis") || lower.starts_with("anti") {
            morphological_intent = "Inverted/Negative intent ".to_string();
        }

        // Use POS dictionary for action vs entity
        let mut is_action = false;
        let mut known_noun = false;
        
        if let Some(dict) = pos_dict {
            // Check direct word
            let mut found_entry = dict.lookup(&lower);
            
            // Check singular form if not found
            if found_entry.is_none() && lower.ends_with("s") {
                let singular = if lower.ends_with("ies") {
                    format!("{}y", &lower[..lower.len() - 3])
                } else if lower.ends_with("es") {
                    lower[..lower.len() - 2].to_string()
                } else {
                    lower[..lower.len() - 1].to_string()
                };
                found_entry = dict.lookup(&singular);
            }
            
            if let Some(entry) = found_entry {
                let pos = entry.pos.to_lowercase();
                if pos == "verb" || pos == "v" {
                    is_action = true;
                } else if pos == "noun" || pos == "n" || pos == "adj" || pos == "adjective" {
                    known_noun = true;
                }
            }
        }

        // Prevent Proper Nouns from being treated as actions
        if is_capitalized && !["What", "Who", "Where", "When", "Why", "How", "Do", "Does", "Did"].contains(&clean) {
            is_action = false;
        } else if !known_noun {
            // Suffix check for morphological actions
            if !is_action && lower.len() > 4 && (lower.ends_with("ing") || lower.ends_with("ed") || lower.ends_with("es") || lower.ends_with("s") || lower.ends_with("ize") || lower.ends_with("ate") || lower.ends_with("ify")) {
                if !["thing", "king", "ring", "morning", "evening", "spring", "bring", "sing", "series", "species", "news", "always", "state"].contains(&lower.as_str()) {
                    is_action = true;
                }
            }
            if !is_action && ["say", "said", "make", "made", "get", "got", "go", "went", "become", "became"].contains(&lower.as_str()) {
                 is_action = true;
            }
        }

        if is_action {
            let mut resolved_tense = active_tense;
            
            // Extract Time Dimensions from suffixes natively
            if lower.ends_with("ed") || lower.ends_with("en") {
                if active_tense == Tense::Unknown { resolved_tense = Tense::Past; }
                morphological_intent.push_str("[Past Completion Vector]");
            } else if lower.ends_with("ing") {
                if active_tense == Tense::Unknown { resolved_tense = Tense::PresentContinuous; }
                morphological_intent.push_str("[Continuous Activity Vector]");
            } else if lower.ends_with("ize") || lower.ends_with("ify") {
                morphological_intent.push_str("[Transformation Vector]");
            }
            
            active_tense = resolved_tense;
            if !morphological_intent.is_empty() {
                sequence_intent_modifiers.push(morphological_intent);
            }
            
            nodes.push(AlgebraicNode::ActionNode(clean.to_string(), resolved_tense));
            has_action = true;
            actions.push(clean.to_string());
        } else {
            nodes.push(AlgebraicNode::EntityNode(clean.to_string()));
            entities.push(clean.to_string());
        }
    }

    let formula = nodes.iter().map(|n| n.symbol()).collect::<Vec<_>>().join(" + ");
    
    // Calculate sum meaning based on Temporal Tense and Dimensional State
    let time_context = match active_tense {
        Tense::Past => "[Occurred in the Past] ",
        Tense::Present => "[Currently happening] ",
        Tense::PresentContinuous => "[Ongoing state bridging into Future] ",
        Tense::Future => "[Intended for the Future] ",
        Tense::Unknown => "[Timeless] ",
    };
    
    // Dimensional prefix overrides
    let mut context_prefix = time_context.to_string();
    if !dimensional_index.is_empty() {
        context_prefix = format!("[Target: {}] {}", dimensional_index, time_context);
    }
    
    let intent_sum = if has_action && !entities.is_empty() {
        if entities.len() > 1 && formula.contains("R") {
            format!("{}Action Interaction: {} intent of '{}' towards {}", context_prefix, entities[0], actions.join(", "), entities.last().unwrap_or(&entities[0]))
        } else {
            format!("{}Action execution: '{}' regarding entity '{}'", context_prefix, actions.join(", "), entities.join(" "))
        }
    } else if !entities.is_empty() {
        format!("{}Definitional inquiry regarding '{}'", context_prefix, entities.join(" "))
    } else {
        "Unknown formulation".to_string()
    };

    SemanticEquation {
        nodes,
        formula,
        intent_sum,
        has_action,
        entities,
        actions,
        overall_tense: active_tense,
    }
}

