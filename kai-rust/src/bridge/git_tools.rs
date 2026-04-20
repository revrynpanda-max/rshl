/// Git Tools — KAI's native git awareness.
///
/// KAI understands git at the field level — not just running commands,
/// but learning from commit history, diffs, and status to build
/// knowledge about the codebase it lives in.
///
/// Commands exposed to main.rs:
///   git status      — what changed, KAI learns file states
///   git diff [file] — what the actual diff is
///   git log [n]     — recent commits, KAI learns project history
///   git commit      — KAI generates a commit message from its field
///   git branch      — current branch info
///   git add <file>  — stage files
use crate::core::Universe;

/// Result of a git operation.
pub struct GitResult {
    pub output: String,
    pub cells_stored: usize,
    pub error: Option<String>,
}

/// Run a raw git command and capture output.
fn run_git(args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args(args)
        .output()
        .map_err(|e| format!("git not found: {}", e))?;

    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("git exited with code {}", out.status.code().unwrap_or(-1))
        } else {
            stderr
        })
    }
}

/// `git status` — show what changed, store file states as knowledge.
pub fn git_status(universe: &mut Universe) -> GitResult {
    match run_git(&["status", "--short", "--branch"]) {
        Ok(output) => {
            let mut stored = 0;
            // Parse status lines and store meaningful ones
            for line in output.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with("##") {
                    continue;
                }
                // e.g. " M src/main.rs" or "?? new_file.rs"
                let cell = format!("[git-status] {}", trimmed);
                if universe.store_or_reinforce(&cell, "action", "git", 1.1) {
                    stored += 1;
                }
            }
            // Store branch info
            if let Some(branch_line) = output.lines().find(|l| l.starts_with("##")) {
                let branch = branch_line.trim_start_matches("## ").trim();
                let cell = format!("[git-branch] {}", branch);
                let _ = universe.store_or_reinforce(&cell, "action", "git", 1.2);
            }
            GitResult {
                output,
                cells_stored: stored,
                error: None,
            }
        }
        Err(e) => GitResult {
            output: String::new(),
            cells_stored: 0,
            error: Some(e),
        },
    }
}

/// `git diff [file]` — show diff, optionally for a specific file.
pub fn git_diff(file: Option<&str>, universe: &mut Universe) -> GitResult {
    let args: Vec<&str> = match file {
        Some(f) => vec!["diff", "--stat", f],
        None => vec!["diff", "--stat"],
    };

    match run_git(&args) {
        Ok(stat_output) => {
            // Also get the actual diff (limited to first 100 lines)
            let full_args: Vec<&str> = match file {
                Some(f) => vec!["diff", f],
                None => vec!["diff"],
            };
            let full_diff = run_git(&full_args).unwrap_or_default();
            let diff_preview: String = full_diff.lines().take(80).collect::<Vec<_>>().join("\n");

            let mut stored = 0;
            // Store changed file names as knowledge
            for line in stat_output.lines() {
                if line.contains('|') {
                    let filename = line.split('|').next().unwrap_or("").trim();
                    if !filename.is_empty() {
                        let cell = format!("[git-diff] modified: {}", filename);
                        if universe.store_or_reinforce(&cell, "action", "git", 1.1) {
                            stored += 1;
                        }
                    }
                }
            }

            let display = if diff_preview.is_empty() {
                if stat_output.is_empty() {
                    "No changes.".to_string()
                } else {
                    stat_output
                }
            } else {
                format!("{}\n\n{}", stat_output, diff_preview)
            };

            GitResult {
                output: display,
                cells_stored: stored,
                error: None,
            }
        }
        Err(e) => GitResult {
            output: String::new(),
            cells_stored: 0,
            error: Some(e),
        },
    }
}

/// `git log [n]` — recent commits. KAI learns project history.
pub fn git_log(n: usize, universe: &mut Universe) -> GitResult {
    let n_str = format!("-{}", n.max(1).min(50));
    let args = vec!["log", &n_str, "--oneline", "--no-decorate"];

    match run_git(&args) {
        Ok(output) => {
            let mut stored = 0;
            for line in output.lines() {
                let trimmed = line.trim();
                if trimmed.len() > 10 {
                    let cell = format!("[git-log] {}", trimmed);
                    if universe.store_or_reinforce(&cell, "action", "git", 1.0) {
                        stored += 1;
                    }
                }
            }
            GitResult {
                output,
                cells_stored: stored,
                error: None,
            }
        }
        Err(e) => GitResult {
            output: String::new(),
            cells_stored: 0,
            error: Some(e),
        },
    }
}

/// `git branch` — list branches, current highlighted.
pub fn git_branch(universe: &mut Universe) -> GitResult {
    match run_git(&["branch", "-v"]) {
        Ok(output) => {
            let mut stored = 0;
            for line in output.lines() {
                if line.starts_with('*') {
                    let cell = format!(
                        "[git-branch] current: {}",
                        line.trim_start_matches("* ").trim()
                    );
                    if universe.store_or_reinforce(&cell, "action", "git", 1.2) {
                        stored += 1;
                    }
                }
            }
            GitResult {
                output,
                cells_stored: stored,
                error: None,
            }
        }
        Err(e) => GitResult {
            output: String::new(),
            cells_stored: 0,
            error: Some(e),
        },
    }
}

/// `git add <file>` — stage files.
pub fn git_add(file: &str) -> GitResult {
    match run_git(&["add", file]) {
        Ok(_) => GitResult {
            output: format!("✓ Staged: {}", file),
            cells_stored: 0,
            error: None,
        },
        Err(e) => GitResult {
            output: String::new(),
            cells_stored: 0,
            error: Some(e),
        },
    }
}

/// `git commit -m <message>` — commit with message.
pub fn git_commit(message: &str, universe: &mut Universe) -> GitResult {
    match run_git(&["commit", "-m", message]) {
        Ok(output) => {
            let cell = format!("[git-commit] {}", message);
            let stored = if universe.store_or_reinforce(&cell, "action", "git", 1.3) {
                1
            } else {
                0
            };
            GitResult {
                output,
                cells_stored: stored,
                error: None,
            }
        }
        Err(e) => GitResult {
            output: String::new(),
            cells_stored: 0,
            error: Some(e),
        },
    }
}

/// Generate a commit message suggestion from KAI's field knowledge.
/// Looks at recent diff and git status to produce a meaningful message.
pub fn suggest_commit_message(universe: &Universe) -> String {
    // Query KAI's field for recent git activity
    let recent_diff_hits = universe.query("[git-diff]", 5);
    let recent_status_hits = universe.query("[git-status]", 5);

    let mut changed_files: Vec<String> = Vec::new();
    for hit in recent_diff_hits.iter().chain(recent_status_hits.iter()) {
        let text = hit
            .text
            .trim_start_matches("[git-diff] modified: ")
            .trim_start_matches("[git-status] ")
            .trim()
            .to_string();
        if !text.is_empty() && !changed_files.contains(&text) {
            changed_files.push(text);
        }
    }

    if changed_files.is_empty() {
        return "update: changes".to_string();
    }

    // Simple heuristic: classify files to guess change type
    let has_tests = changed_files
        .iter()
        .any(|f| f.contains("test") || f.contains("spec"));
    let has_docs = changed_files
        .iter()
        .any(|f| f.ends_with(".md") || f.ends_with(".txt"));
    let has_config = changed_files
        .iter()
        .any(|f| f.ends_with(".toml") || f.ends_with(".json") || f.ends_with(".yml"));
    let has_src = changed_files.iter().any(|f| {
        f.ends_with(".rs") || f.ends_with(".ts") || f.ends_with(".js") || f.ends_with(".py")
    });

    let verb = if has_tests && !has_src {
        "test"
    } else if has_docs && !has_src {
        "docs"
    } else if has_config && !has_src {
        "config"
    } else {
        "update"
    };

    // Take first 2 changed files as subject
    let subject_files: Vec<&str> = changed_files
        .iter()
        .filter(|f| !f.starts_with('['))
        .take(2)
        .map(|s| s.as_str())
        .collect();

    if subject_files.is_empty() {
        format!("{}: changes", verb)
    } else {
        format!("{}: {}", verb, subject_files.join(", "))
    }
}

/// Parse git status into a structured summary for display.
pub fn parse_status_summary(status_output: &str) -> StatusSummary {
    let mut modified = Vec::new();
    let mut added = Vec::new();
    let mut deleted = Vec::new();
    let mut untracked = Vec::new();
    let mut branch = String::new();

    for line in status_output.lines() {
        if line.starts_with("##") {
            branch = line
                .trim_start_matches("## ")
                .split("...")
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            continue;
        }
        if line.len() < 3 {
            continue;
        }
        let status_code = &line[..2];
        let filename = line[3..].trim().to_string();
        match status_code.trim() {
            "M" | " M" | "MM" => modified.push(filename),
            "A" | "AM" => added.push(filename),
            "D" | " D" => deleted.push(filename),
            "??" => untracked.push(filename),
            _ => modified.push(filename),
        }
    }

    StatusSummary {
        branch,
        modified,
        added,
        deleted,
        untracked,
    }
}

pub struct StatusSummary {
    pub branch: String,
    pub modified: Vec<String>,
    pub added: Vec<String>,
    pub deleted: Vec<String>,
    pub untracked: Vec<String>,
}

impl StatusSummary {
    pub fn is_clean(&self) -> bool {
        self.modified.is_empty()
            && self.added.is_empty()
            && self.deleted.is_empty()
            && self.untracked.is_empty()
    }

    pub fn format_display(&self) -> String {
        if self.is_clean() {
            return format!("Branch: {}\nWorking tree clean.", self.branch);
        }
        let mut lines = vec![format!("Branch: {}", self.branch)];
        if !self.modified.is_empty() {
            lines.push(format!("Modified  ({}):", self.modified.len()));
            for f in &self.modified {
                lines.push(format!("  ~ {}", f));
            }
        }
        if !self.added.is_empty() {
            lines.push(format!("Staged    ({}):", self.added.len()));
            for f in &self.added {
                lines.push(format!("  + {}", f));
            }
        }
        if !self.deleted.is_empty() {
            lines.push(format!("Deleted   ({}):", self.deleted.len()));
            for f in &self.deleted {
                lines.push(format!("  - {}", f));
            }
        }
        if !self.untracked.is_empty() {
            lines.push(format!("Untracked ({}):", self.untracked.len()));
            for f in self.untracked.iter().take(8) {
                lines.push(format!("  ? {}", f));
            }
            if self.untracked.len() > 8 {
                lines.push(format!("  ... and {} more", self.untracked.len() - 8));
            }
        }
        lines.join("\n")
    }
}
