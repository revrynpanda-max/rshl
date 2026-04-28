                    role: "user".into(),
                    text: input,
                    region: None,
                    score: None,
                });
                let rc = self.universe.region_counts();
                let regions: String = rc
                    .iter()
                    .map(|(k, v)| format!("{}:{}", k, v))
                    .collect::<Vec<_>>()
                    .join(" ");
                let status = format!(
                    "Universe: {} cells | Avg str: {:.2} | Candidates: {}\nRegions: {}\nMood: {} | V={:+.3} | Φg={:.4}\nTempo: {}ms | Tick: {} | Dreams: {}",
                    self.universe.count(), self.universe.avg_strength(), self.candidates.count(),
                    regions, self.drive.mood, self.drive.valence, self.drive.avg_phi_g,
                    self.drive.adaptive_interval_ms(), self.tick, self.dream_count,
                );
                self.turns.push(Turn {
                    role: "kai".into(),
                    text: status,
                    region: None,
                    score: None,
                });
                return;
            }
            "mood" => {
                self.turns.push(Turn {
                    role: "user".into(),
                    text: input,
                    region: None,
                    score: None,
                });
                let d = &self.drive;
                let text = format!(
                    "{} · V={:+.3} · Φg={:.4} · χ={:.4} · {}ms",
                    d.mood.to_string().to_uppercase(),
                    d.valence,
                    d.avg_phi_g,
                    d.avg_chi,
                    d.adaptive_interval_ms()
                );
                self.turns.push(Turn {
                    role: "kai".into(),
                    text,
                    region: None,
                    score: None,
                });
                return;
            }
            "dream" => {
                self.turns.push(Turn {
                    role: "user".into(),
                    text: input,
                    region: None,
                    score: None,
                });
                self.run_dream_cycle();
                let text = if self.last_dream_text.is_empty() {
                    "No dream produced this cycle".to_string()
                } else {
                    self.last_dream_text.clone()
                };
                self.turns.push(Turn {
                    role: "kai".into(),
                    text,
                    region: Some("reasoning".into()),
                    score: None,
                });
                return;
            }
            "spectate" | "watch" | "mindview" => {
                let arg = input.split_whitespace().nth(1).map(|s| s.to_lowercase());

                if self.spectate_mode {
                    // If already on, check if we're switching modes or turning off
                    if let Some(ref a) = arg {
                        if a == "full" && !self.spectate_full {
                            self.spectate_full = true;
                            self.think("CPU", "👁", "Status pulses ENABLED (verbose mode)".into());
                        } else if a == "brief" && self.spectate_full {
                            self.spectate_full = false;
                            self.think("CPU", "👁", "Status pulses DISABLED (brief mode)".into());
                        } else {
                            // No change in mode, so toggle off
                            self.spectate_mode = false;
                            self.spectate_full = false;
                            self.turns.push(Turn {
                                role: "user".into(),
                                text: input.clone(),
                                region: None,
                                score: None,
                            });
                            self.turns.push(Turn {
                                role: "kai".into(),
                                text: "Spectate mode OFF — back to conversation.".into(),
                                region: None,
                                score: None,
                            });
                        }
                    } else {
                        // Toggle off
                        self.spectate_mode = false;
                        self.spectate_full = false;
                        self.turns.push(Turn {
                            role: "user".into(),
                            text: input.clone(),
                            region: None,
                            score: None,
                        });
                        self.turns.push(Turn {
                            role: "kai".into(),
                            text: "Spectate mode OFF — back to conversation.".into(),
                            region: None,
                            score: None,
                        });
                    }
                } else {
                    // Turning on
                    self.spectate_mode = true;
                    self.spectate_full = arg.as_deref() == Some("full");

                    self.think(
                        "CPU",
                        "👁",
                        format!(
                            "Spectate mode ACTIVATED ({}) — you can now see inside my mind",
                            if self.spectate_full { "full" } else { "brief" }
                        ),
                    );

                    self.turns.push(Turn {
                        role: "user".into(),
                        text: input.clone(),
                        region: None,
                        score: None,
                    });
                    self.turns.push(Turn {
                        role: "kai".into(),
                        text: format!(
                            "👁 Spectate mode ON ({}) — watching KAI think in real-time. Type 'spectate' again to exit.",
                            if self.spectate_full { "full" } else { "brief" }
                        ),
                        region: None,
                        score: None
                    });
                }
                return;
            }
            "save" => {
                self.turns.push(Turn {
                    role: "user".into(),
                    text: input,
