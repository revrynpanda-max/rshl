        }

        // ── readfile <path> — read a file and learn from it (FileReadTool) ────
        if lower.starts_with("readfile ") {
            let path = input[9..].trim().to_string();
            self.turns.push(Turn {
                role: "user".into(),
                text: input.clone(),
                region: None,
                score: None,
            });

            match std::fs::read_to_string(&path) {
                Ok(content) => {
                    let lines: Vec<&str> = content
                        .lines()
                        .map(|l| l.trim())
                        .filter(|l| l.len() > 15 && !l.starts_with('#') && !l.starts_with("//"))
                        .collect();

                    let shown: String = lines
                        .iter()
                        .take(30)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join("\n");

                    let total_lines = content.lines().count();
                    let display = if shown.is_empty() {
                        format!("File is empty or has no readable content.\nPath: {}", path)
                    } else if total_lines > 30 {
                        format!("{}\n\n[showing first 30 of {} lines]", shown, total_lines)
                    } else {
                        shown.clone()
                    };

                    // Store file content as knowledge cells
                    let mut added = 0usize;
                    let mut reinforced = 0usize;
                    for line in lines.iter().take(60) {
                        let lower_line = line.to_lowercase();
                        let is_personal = lower_line.contains("ryan")
                            || lower_line.contains("[about")
                            || lower_line.starts_with("i am")
                            || lower_line.starts_with("my ")
                            || lower_line.contains("kai is")
                            || lower_line.contains("kai was");
                        let (region, source, strength) = if is_personal {
                            ("memory", "ryan", 1.8f32)
                        } else {
                            ("reasoning", "file-read", 1.1f32)
                        };
                        if self
                            .universe
                            .store_or_reinforce(line, region, source, strength)
                        {
                            added += 1;
                        } else {
                            reinforced += 1;
                        }
                    }

                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!(
                            "{}\n\n[+{} new cells, {} reinforced from {}]",
                            display, added, reinforced, path
                        ),
                        region: Some("memory".into()),
                        score: None,
                    });
                }
                Err(e) => {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("✗ Can't read \"{}\": {}", path, e),
                        region: None,
                        score: None,
                    });
                }
            }
            return;
        }

        // ── writefile <path> <content> — write to a file (FileWriteTool) ────
        if lower.starts_with("writefile ") {
            self.turns.push(Turn {
                role: "user".into(),
                text: input.clone(),
                region: None,
                score: None,
            });
            let rest = &input[10..];
            // Path is first word, rest is content
            let mut parts = rest.splitn(2, char::is_whitespace);
            let path = parts.next().unwrap_or("").trim().to_string();
            let content = parts.next().unwrap_or("").trim().to_string();

            if path.is_empty() {
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: "Usage: writefile <path> <content>\nExample: writefile notes.txt this is a note".into(),
                    region: None, score: None,
                });
                return;
            }

            if content.is_empty() {
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: format!("No content given for \"{}\" — nothing written.", path),
                    region: None,
                    score: None,
                });
                return;
            }

            match std::fs::write(&path, &content) {
                Ok(_) => {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("✓ Written {} bytes to \"{}\".", content.len(), path),
                        region: Some("action".into()),
                        score: None,
                    });
                }
                Err(e) => {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("✗ Could not write to \"{}\": {}", path, e),
                        region: None,
                        score: None,
                    });
                }
            }
            return;
        }


        // ── brief — session summary from transcript ────────────────────────
        if lower.trim() == "brief" {
            self.turns.push(Turn {
                role: "user".into(),
                text: input.clone(),
                region: None,
                score: None,
            });
            let summary = kai::cognition::transcript::brief(&self.base_dir, &self.session_id);
            self.turns.push(Turn {
                role: "kai".into(),
                text: summary,
                region: Some("memory".into()),
                score: None,
            });
            return;
        }

        // ── recall <query> — search full conversation history ─────────────
        if lower.starts_with("recall ") {
            let query = input[7..].trim().to_string();
            self.turns.push(Turn {
                role: "user".into(),
                text: input.clone(),
                region: None,
                score: None,
            });

            let entries = kai::cognition::transcript::recall(&self.base_dir, &query, 10);
            if entries.is_empty() {
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: format!("Nothing in my transcript matches \"{}\".", query),
                    region: None,
                    score: None,
                });
            } else {
                let mut lines = vec![format!(
                    "Found {} matching transcript entries for \"{}\":\n",
                    entries.len(),
                    query
                )];
                for e in &entries {
                    let preview = safe_slice(&e.text, 100);
                    lines.push(format!("  [{}] {}: {}…", e.ts, e.role, preview));
                }
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: lines.join("\n"),
                    region: Some("memory".into()),
                    score: None,
                });
            }
            return;
        }

        // ── learn <word/topic> — store a word/concept directly or from the web ──
        // Supports both:
        //   "learn bitch"                     → web lookup for "bitch"
        //   "it means X. learn bitch"          → store the preceding definition + word
        //   "learn bitch" at end of longer msg → same inline form
        let learn_word_pos = {
            // Check if "learn <word>" appears at end of message (inline teach)
            let words: Vec<&str> = lower.split_whitespace().collect();
            if words.len() >= 2 && words[words.len() - 2] == "learn" {
                Some(words[words.len() - 1].to_string())
            } else {
                None
            }
        };
        let is_standalone_learn =
            lower.starts_with("learn ") && lower.split_whitespace().count() <= 4;

        if is_standalone_learn || learn_word_pos.is_some() {
            let topic = if let Some(ref w) = learn_word_pos {
                w.as_str()
            } else {
                input[6..].trim()
            };
            self.turns.push(Turn {
                role: "user".into(),
                text: input.clone(),
                region: None,
                score: None,
            });

            // If there's definition text before the "learn" command, store it directly
            let definition_text = if learn_word_pos.is_some() {
                let before = input[..input.to_lowercase().rfind("learn").unwrap_or(0)].trim();
                if before.len() > 5 {
                    Some(before.to_string())
                } else {
                    None
                }
            } else {
                None
            };

            if let Some(def) = definition_text {
                // Store the user-provided definition directly — more reliable than web
                let tagged = format!("{} means: {}", topic, def);
                self.universe.store(&tagged, "memory", "user-teach", 2.5);
                // Also add the word to the lexicon so it's no longer "unknown"
                self.lexicon.add_word(topic);
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: format!("Got it. \"{}\" — stored from your definition.", topic),
                    region: Some("memory".into()),
                    score: None,
                });
            } else {
                // Fall back to web lookup
                let added = kai::bridge::ingest_topic(&mut self.universe, topic);
                if added > 0 {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!(
                            "Learned \"{}\" — +{} cells (universe: {})",
                            topic,
                            added,
                            self.universe.count()
                        ),
                        region: Some("memory".into()),
                        score: None,
                    });
                } else {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("No results found for \"{}\"", topic),
                        region: None,
                        score: None,
                    });
                }
            }
            return;
        }

        // ── spell <word> — test spelling correction ──────────────────
        if lower.starts_with("spell ") {
            let word = &input[6..].trim();
            self.turns.push(Turn {
                role: "user".into(),
                text: input.clone(),
                region: None,
                score: None,
            });

            let known = self.lexicon.is_known(word);
            let correction = self.lexicon.correct(word);
            let suggestions = self.lexicon.suggest(word, 5);

            let mut response = if known {
                format!(
                    "✓ \"{}\" is a known word (rank #{})",
                    word,
                    self.lexicon.rank(word).unwrap_or(0)
                )
            } else if let Some(ref corrected) = correction {
                format!(
                    "✎ \"{}\" → \"{}\" (rank #{})",
                    word,
                    corrected,
                    self.lexicon.rank(corrected).unwrap_or(0)
                )
            } else {
                format!("✗ \"{}\" is unknown, no close match found", word)
            };

            if !suggestions.is_empty() && !known {
                let sug_text: Vec<String> = suggestions
                    .iter()
                    .map(|(w, d, r)| format!("{}(d={},r={})", w, d, r))
                    .collect();
                response = format!("{}\nSuggestions: {}", response, sug_text.join(", "));
            }

            self.turns.push(Turn {
                role: "kai".into(),
                text: response,
                region: Some("language".into()),
                score: None,
            });
            return;
        }

        if lower.starts_with("store ") {
            let body = &input[6..];
            self.turns.push(Turn {
                role: "user".into(),
                text: input.clone(),
                region: None,
                score: None,
            });
            self.universe.store(body, "memory", "user-input", 1.0);
            self.turns.push(Turn {
                role: "kai".into(),
                text: format!("✓ Stored. Universe: {} cells", self.universe.count()),
                region: Some("memory".into()),
                score: None,
            });
            return;
        }

        // ── import <path> — bulk-load a text file into the universe ──────
        if lower.starts_with("import ") {
            let path = input[7..].trim().to_string();
            self.turns.push(Turn {
                role: "user".into(),
                text: input.clone(),
                region: None,
                score: None,
            });
            match std::fs::read_to_string(&path) {
                Ok(content) => {
                    let before = self.universe.count();
                    let mut added = 0usize;
                    let mut reinforced = 0usize;
                    for line in content.lines() {
                        let line = line.trim();
                        // Skip blank lines, comments, and very short lines
                        if line.is_empty() || line.starts_with('#') || line.len() < 8 {
                            continue;
                        }
                        // Detect if it's personal (ryan/kai flavored) or general
                        let lower_line = line.to_lowercase();
                        let is_personal = lower_line.contains("ryan")
                            || lower_line.contains("[about-ryan]")
                            || lower_line.contains("[about-kai]")
                            || lower_line.starts_with("i am")
                            || lower_line.starts_with("my ")
                            || lower_line.contains("kai is")
                            || lower_line.contains("kai was");
                        let (region, source, strength) = if is_personal {
                            ("memory", "ryan", 1.8f32)
                        } else {
                            ("reasoning", "import", 1.2f32)
                        };
                        let is_new = self
                            .universe
                            .store_or_reinforce(line, region, source, strength);
                        if is_new {
                            added += 1;
                        } else {
                            reinforced += 1;
                        }
                    }
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!(
                            "✓ Import complete: +{} new cells, {} reinforced\n  Source: {}\n  Universe: {} → {} cells",
                            added, reinforced, path, before, self.universe.count()
                        ),
                        region: Some("memory".into()),
                        score: None,
                    });
                }
                Err(e) => {
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!("✗ Could not read \"{}\": {}", path, e),
                        region: None,
                        score: None,
                    });
                }
            }
            return;
        }

        // ── REASON through the universe (iterative resonance chain) ──────
        self.turns.push(Turn {
            role: "user".into(),
            text: input.clone(),
            region: None,
            score: None,
        });
        self.last_ryan_input = input.clone();
        // Feed Ryan's turn into the central self-state hub so the reactive
        // context (charge, is-question, freshness) propagates to every
        // module that reads from the hub next tick.
        let ryan_charge = self.amygdala.emotional_charge_factor(&input, "user");
        self.hub.ingest_input(&input, ryan_charge, self.tick);

        // ── Transcript: record user turn ──────────────────────────────────
        kai::cognition::transcript::append(&self.base_dir, &self.session_id, "user", &input);

        // ── Episodic Memory: store this user turn ─────────────────────────
        {
            let sal = kai::cognition::compute_salience(&input, "user");
            let is_hot = self.episodic.store(&input, "user", &self.session_id, sal);
            self.hippocampus.store(
                &input,
                sal.clamp(0.20, 1.0),
                "memory",
                "ryan-moment",
                self.amygdala
                    .emotional_charge_factor(&input, "user")
                    .clamp(1.0, 3.0)
                    / 3.0,
            );
            self.pfc.bind_context(&input);
            if is_hot && self.spectate_mode {
                self.think(
                    "RAM",
                    "📍",
                    format!(
                        "High-salience memory stored (sal={:.2}): {}",
                        sal,
                        if input.len() > 60 {
                            format!("{}…", &input[..60])
                        } else {
                            input.clone()
                        }
                    ),
                );
            }
            // Global Workspace: user input always competes for the spotlight
            self.global_workspace
                .post("user-input", &input, sal.max(0.55));
        }

        // ── Conversational Learning — scan for things Ryan is teaching KAI ─
        // This runs BEFORE reasoning so the new knowledge is already in the
        // universe when the query happens (immediate Hebbian wiring).
        if let Some(learned_msg) = self.learn_from_statement(&input) {
            self.turns.push(Turn {
                role: "kai".into(),
                text: learned_msg,
                region: Some("memory".into()),
                score: None,
            });
        }

        // ── Working Memory: store the user's turn ─────────────────────
        self.working_memory.push(&input, "user", self.tick);

        // ── Predictive RSHL: fold the user's turn into the conversation trace.
        // The trace is a single 16384-dim sparse-ternary hypervector that the
        // voice path uses to rank cells by *continuation fit*, not just
        // "most similar to the input". Pushing here means the voice engine
        // sees this turn as the most recent (depth-0) entry.
        self.conv_trace.push(&input, "user");

        // ── Conversation Memory: store only substantive user turns ──────
        // Skip pure questions — they echo back as nonsense hits.
        // Very low strength (0.3) so they never win queries over real knowledge.
        let lower_input_check = input.to_lowercase();
        // Skip storing if there's ANY '?' in the input (catches embedded questions
        // in compound sentences like "well what is your name? im Ryan Nice to meet you")
        let is_question_input = input.contains('?')
            || lower_input_check.starts_with("what ")
            || lower_input_check.starts_with("who ")
            || lower_input_check.starts_with("where ")
            || lower_input_check.starts_with("when ")
            || lower_input_check.starts_with("how ")
            || lower_input_check.starts_with("why ");
        if !is_question_input {
            // Store Ryan's raw input with no "user asked:" prefix in
            // the text. Echo classification lives in the source tag
            // ("user-echo"), not in the cell's text content — so the
            // pattern-computation hot paths never need to inspect text
            // to know what a cell is. The universe.query() filter will
            // also exclude user-echo cells from voice output, so KAI
            // can never parrot Ryan's words back as his own reply.
            let conv_strength = self.amygdala.gate(&input, "user", 0.3);
            self.universe
                .store(&input, "memory", "user-echo", conv_strength);
        }

        // ── Spelling correction: auto-correct input before reasoning ─────
        let (corrected_input, corrections) = self.lexicon.correct_sentence(&input);
        // Silently use corrected input — no TUI clutter for routine typo fixes
        let reasoning_input = if corrections.is_empty() {
            input.clone()
        } else {
            corrected_input
        };

        // ── Build context slots from working memory ────────────────────
        let context_slots: Vec<ContextSlot> = self
            .working_memory
            .active_slots()
            .iter()
            .map(|(vec, strength)| ContextSlot {
                vec: (*vec).clone(),
                role: "user".to_string(), // simplified — both roles contribute
                strength: *strength,
            })
            .collect();

        // ── Reason WITH context (conversation-aware) ─────────────────
        let result =
            self.reasoner
                .reason_with_context(&reasoning_input, &self.universe, &context_slots);

        // ── Detect query type for voice engine ───────────────────────
        let query_type = detect_query_type(&reasoning_input);

        // ── LexSem: analyze what Ryan's language is actually doing ────
        // This gives KAI semantic field awareness — is this emotional, technical,
        // identity-related? What's the expressed certainty? Urgency? Negation?
        // These signals feed into BrainSignals and shape the response register.
        let lex_out = self.lexsem.analyze(&reasoning_input);
        if self.spectate_mode {
            self.think(
                "CPU",
                "📖",
                format!(
                    "LexSem: field={} | valence={:+.2} | certainty={:.2} | register={}{}{}",
                    lex_out.primary_field.label(),
                    lex_out.language_valence,
                    lex_out.expressed_certainty,
                    lex_out.suggested_register.label(),
                    if lex_out.has_negation { " NEG" } else { "" },
                    if lex_out.urgency > 0.3 { " URG" } else { "" },
                ),
            );
        }
