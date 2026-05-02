/// Code Tools â€” KAI's code analysis and review engine.
///
/// KAI can read source files and understand their structure â€” not by
/// running a language model, but by extracting structural facts and
/// storing them as geometric knowledge cells.
///
/// Supports: Rust, TypeScript, JavaScript, Python, Go, C/C++
///
/// Commands:
///   analyze <file>  â€” extract functions, classes, imports, TODOs
///   review <file>   â€” KAI-powered code review using field resonance
///   scan <dir>      â€” scan a directory and build knowledge map
use crate::core::Universe;

/// UTF-8 safe byte slice â€” never splits a multi-byte character.
fn safe_slice(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// A structural element extracted from a source file.
#[derive(Debug, Clone)]
pub struct CodeElement {
    pub kind: ElementKind,
    pub name: String,
    pub line: usize,
    pub context: String, // surrounding text for knowledge storage
}

#[derive(Debug, Clone, PartialEq)]
pub enum ElementKind {
    Function,
    Method,
    Class,
    Struct,
    Enum,
    Trait,
    Interface,
    Import,
    Export,
    Constant,
    Todo,
    Fixme,
    Variable,
}

impl std::fmt::Display for ElementKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ElementKind::Function => write!(f, "fn"),
            ElementKind::Method => write!(f, "method"),
            ElementKind::Class => write!(f, "class"),
            ElementKind::Struct => write!(f, "struct"),
            ElementKind::Enum => write!(f, "enum"),
            ElementKind::Trait => write!(f, "trait"),
            ElementKind::Interface => write!(f, "interface"),
            ElementKind::Import => write!(f, "import"),
            ElementKind::Export => write!(f, "export"),
            ElementKind::Constant => write!(f, "const"),
            ElementKind::Todo => write!(f, "TODO"),
            ElementKind::Fixme => write!(f, "FIXME"),
            ElementKind::Variable => write!(f, "var"),
        }
    }
}

/// Full analysis result for a source file.
pub struct FileAnalysis {
    pub path: String,
    pub language: String,
    pub lines: usize,
    pub elements: Vec<CodeElement>,
    pub complexity_estimate: u32, // rough cyclomatic complexity
    pub todos: Vec<String>,
    pub summary: String,
}

impl FileAnalysis {
    pub fn format_display(&self) -> String {
        let mut out = Vec::new();
        out.push(format!("File: {} ({})", self.path, self.language));
        out.push(format!(
            "Lines: {}  |  Complexity: ~{}",
            self.lines, self.complexity_estimate
        ));

        // Group by kind
        let fns: Vec<_> = self
            .elements
            .iter()
            .filter(|e| matches!(e.kind, ElementKind::Function | ElementKind::Method))
            .collect();
        let types: Vec<_> = self
            .elements
            .iter()
            .filter(|e| {
                matches!(
                    e.kind,
                    ElementKind::Class
                        | ElementKind::Struct
                        | ElementKind::Enum
                        | ElementKind::Trait
                        | ElementKind::Interface
                )
            })
            .collect();
        let imports: Vec<_> = self
            .elements
            .iter()
            .filter(|e| matches!(e.kind, ElementKind::Import))
            .collect();

        if !types.is_empty() {
            out.push(format!("\nTypes ({}):", types.len()));
            for e in types.iter().take(12) {
                out.push(format!("  {} {} (line {})", e.kind, e.name, e.line));
            }
        }
        if !fns.is_empty() {
            out.push(format!("\nFunctions ({}):", fns.len()));
            for e in fns.iter().take(20) {
                out.push(format!("  {} {} (line {})", e.kind, e.name, e.line));
            }
            if fns.len() > 20 {
                out.push(format!("  ... and {} more", fns.len() - 20));
            }
        }
        if !imports.is_empty() {
            out.push(format!("\nImports ({}):", imports.len()));
            for e in imports.iter().take(8) {
                out.push(format!("  {}", e.name));
            }
            if imports.len() > 8 {
                out.push(format!("  ... and {} more", imports.len() - 8));
            }
        }
        if !self.todos.is_empty() {
            out.push(format!("\nTODOs ({}):", self.todos.len()));
            for t in self.todos.iter().take(5) {
                out.push(format!("  âš  {}", t));
            }
        }

        out.join("\n")
    }
}

/// Detect language from file extension.
fn detect_language(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".rs") {
        return "Rust";
    }
    if lower.ends_with(".ts") || lower.ends_with(".tsx") {
        return "TypeScript";
    }
    if lower.ends_with(".js") || lower.ends_with(".mjs") {
        return "JavaScript";
    }
    if lower.ends_with(".py") {
        return "Python";
    }
    if lower.ends_with(".go") {
        return "Go";
    }
    if lower.ends_with(".c") || lower.ends_with(".h") {
        return "C";
    }
    if lower.ends_with(".cpp") || lower.ends_with(".cc") {
        return "C++";
    }
    if lower.ends_with(".java") {
        return "Java";
    }
    if lower.ends_with(".cs") {
        return "C#";
    }
    if lower.ends_with(".md") {
        return "Markdown";
    }
    if lower.ends_with(".json") {
        return "JSON";
    }
    if lower.ends_with(".toml") {
        return "TOML";
    }
    if lower.ends_with(".yaml") || lower.ends_with(".yml") {
        return "YAML";
    }
    "Text"
}

/// Parse a source file and extract structural elements.
pub fn analyze_file(path: &str) -> Result<FileAnalysis, String> {
    let content =
        std::fs::read_to_string(path).map_err(|e| format!("Cannot read \"{}\": {}", path, e))?;

    let language = detect_language(path);
    let lines = content.lines().count();
    let mut elements: Vec<CodeElement> = Vec::new();
    let mut todos: Vec<String> = Vec::new();
    let mut complexity = 0u32;

    for (i, line) in content.lines().enumerate() {
        let lineno = i + 1;
        let trimmed = line.trim();

        // TODOs and FIXMEs â€” any language
        if let Some(pos) = trimmed.to_uppercase().find("TODO") {
            let todo_text = trimmed[pos..]
                .trim()
                .trim_start_matches(':')
                .trim()
                .to_string();
            if todo_text.len() > 4 {
                todos.push(format!("line {}: {}", lineno, safe_slice(&todo_text, 80)));
                elements.push(CodeElement {
                    kind: ElementKind::Todo,
                    name: safe_slice(&todo_text, 60).to_string(),
                    line: lineno,
                    context: safe_slice(trimmed, 100).to_string(),
                });
            }
        }
        if trimmed.to_uppercase().contains("FIXME") {
            todos.push(format!(
                "line {}: FIXME: {}",
                lineno,
                safe_slice(trimmed, 60)
            ));
        }

        // Complexity drivers (branches)
        if trimmed.starts_with("if ")
            || trimmed.starts_with("} else")
            || trimmed.starts_with("else {")
            || trimmed.starts_with("match ")
            || trimmed.starts_with("for ")
            || trimmed.starts_with("while ")
            || trimmed.starts_with("case ")
            || trimmed.contains("? ") && trimmed.contains(" : ")
        {
            complexity += 1;
        }

        match language {
            "Rust" => parse_rust_line(trimmed, lineno, &mut elements),
            "TypeScript" | "JavaScript" => parse_ts_line(trimmed, lineno, &mut elements),
            "Python" => parse_python_line(trimmed, lineno, &mut elements),
            "Go" => parse_go_line(trimmed, lineno, &mut elements),
            _ => {}
        }
    }

    let fn_count = elements
        .iter()
        .filter(|e| matches!(e.kind, ElementKind::Function | ElementKind::Method))
        .count();
    let type_count = elements
        .iter()
        .filter(|e| {
            matches!(
                e.kind,
                ElementKind::Class | ElementKind::Struct | ElementKind::Enum | ElementKind::Trait
            )
        })
        .count();

    let summary = format!(
        "{} file: {} lines, ~{} functions, ~{} types, {} TODOs, complexity ~{}",
        language,
        lines,
        fn_count,
        type_count,
        todos.len(),
        complexity
    );

    Ok(FileAnalysis {
        path: path.to_string(),
        language: language.to_string(),
        lines,
        elements,
        complexity_estimate: complexity,
        todos,
        summary,
    })
}

// â”€â”€ Language-specific parsers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn parse_rust_line(line: &str, lineno: usize, elements: &mut Vec<CodeElement>) {
    // Functions: pub fn, fn, async fn, pub async fn
    if let Some(name) =
        extract_after_keyword(line, &["pub fn ", "pub async fn ", "async fn ", "fn "])
    {
        let name = name.split('(').next().unwrap_or("").trim().to_string();
        if !name.is_empty() && is_valid_ident(&name) {
            let is_method =
                line.contains("&self") || line.contains("&mut self") || line.contains("self,");
            elements.push(CodeElement {
                kind: if is_method {
                    ElementKind::Method
                } else {
                    ElementKind::Function
                },
                name,
                line: lineno,
                context: safe_slice(line, 80).to_string(),
            });
        }
        return;
    }
    // Structs
    if let Some(name) = extract_after_keyword(line, &["pub struct ", "struct "]) {
        let name = name
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .next()
            .unwrap_or("")
            .to_string();
        if !name.is_empty() && is_valid_ident(&name) {
            elements.push(CodeElement {
                kind: ElementKind::Struct,
                name,
                line: lineno,
                context: safe_slice(line, 80).to_string(),
            });
        }
        return;
    }
    // Enums
    if let Some(name) = extract_after_keyword(line, &["pub enum ", "enum "]) {
        let name = name
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .next()
            .unwrap_or("")
            .to_string();
        if !name.is_empty() && is_valid_ident(&name) {
            elements.push(CodeElement {
                kind: ElementKind::Enum,
                name,
                line: lineno,
                context: safe_slice(line, 80).to_string(),
            });
        }
        return;
    }
    // Traits
    if let Some(name) = extract_after_keyword(line, &["pub trait ", "trait "]) {
        let name = name
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .next()
            .unwrap_or("")
            .to_string();
        if !name.is_empty() && is_valid_ident(&name) {
            elements.push(CodeElement {
                kind: ElementKind::Trait,
                name,
                line: lineno,
                context: safe_slice(line, 80).to_string(),
            });
        }
        return;
    }
    // Imports
    if line.starts_with("use ") {
        elements.push(CodeElement {
            kind: ElementKind::Import,
            name: {
                let trimmed_name = line[4..].trim_end_matches(';').trim();
                safe_slice(trimmed_name, 70).to_string()
            },
            line: lineno,
            context: safe_slice(line, 80).to_string(),
        });
    }
    // Constants
    if let Some(name) = extract_after_keyword(line, &["pub const ", "const "]) {
        let name = name.split(':').next().unwrap_or("").trim().to_string();
        if !name.is_empty() && is_valid_ident(&name) {
            elements.push(CodeElement {
                kind: ElementKind::Constant,
                name,
                line: lineno,
                context: safe_slice(line, 80).to_string(),
            });
        }
    }
}

fn parse_ts_line(line: &str, lineno: usize, elements: &mut Vec<CodeElement>) {
    // Functions: function foo, const foo = () =>, export function
    if let Some(name) = extract_after_keyword(
        line,
        &[
            "export function ",
            "export async function ",
            "function ",
            "async function ",
        ],
    ) {
        let name = name.split('(').next().unwrap_or("").trim().to_string();
        if !name.is_empty() && is_valid_ident(&name) {
            elements.push(CodeElement {
                kind: ElementKind::Function,
                name,
                line: lineno,
                context: safe_slice(line, 80).to_string(),
            });
        }
        return;
    }
    // Arrow functions: const foo = ... =>
    if (line.contains("= (") || line.contains("= async (") || line.contains("=> {"))
        && line.contains("const ")
    {
        if let Some(name) = extract_after_keyword(line, &["export const ", "const "]) {
            let name = name
                .split([' ', '=', ':'])
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !name.is_empty()
                && is_valid_ident(&name)
                && (line.contains("=>") || line.contains("function"))
            {
                elements.push(CodeElement {
                    kind: ElementKind::Function,
                    name,
                    line: lineno,
                    context: safe_slice(line, 80).to_string(),
                });
            }
        }
        return;
    }
    // Classes and interfaces
    if let Some(name) =
        extract_after_keyword(line, &["export class ", "class ", "export default class "])
    {
        let name = name
            .split([' ', '{', '<'])
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !name.is_empty() && is_valid_ident(&name) {
            elements.push(CodeElement {
                kind: ElementKind::Class,
                name,
                line: lineno,
                context: safe_slice(line, 80).to_string(),
            });
        }
        return;
    }
    if let Some(name) = extract_after_keyword(line, &["export interface ", "interface "]) {
        let name = name
            .split([' ', '{', '<'])
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !name.is_empty() && is_valid_ident(&name) {
            elements.push(CodeElement {
                kind: ElementKind::Interface,
                name,
                line: lineno,
                context: safe_slice(line, 80).to_string(),
            });
        }
        return;
    }
    // Imports
    if line.starts_with("import ") {
        elements.push(CodeElement {
            kind: ElementKind::Import,
            name: safe_slice(line, 80).to_string(),
            line: lineno,
            context: safe_slice(line, 80).to_string(),
        });
    }
}

fn parse_python_line(line: &str, lineno: usize, elements: &mut Vec<CodeElement>) {
    if let Some(name) = extract_after_keyword(line, &["async def ", "def "]) {
        let name = name.split('(').next().unwrap_or("").trim().to_string();
        if !name.is_empty() && is_valid_ident(&name) {
            let is_method = line.starts_with("    ") || line.starts_with("\t");
            elements.push(CodeElement {
                kind: if is_method {
                    ElementKind::Method
                } else {
                    ElementKind::Function
                },
                name,
                line: lineno,
                context: safe_slice(line, 80).to_string(),
            });
        }
        return;
    }
    if let Some(name) = extract_after_keyword(line, &["class "]) {
        let name = name
            .split(['(', ':'])
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !name.is_empty() && is_valid_ident(&name) {
            elements.push(CodeElement {
                kind: ElementKind::Class,
                name,
                line: lineno,
                context: safe_slice(line, 80).to_string(),
            });
        }
        return;
    }
    if line.starts_with("import ") || line.starts_with("from ") {
        elements.push(CodeElement {
            kind: ElementKind::Import,
            name: safe_slice(line, 80).to_string(),
            line: lineno,
            context: safe_slice(line, 80).to_string(),
        });
    }
}

fn parse_go_line(line: &str, lineno: usize, elements: &mut Vec<CodeElement>) {
    if let Some(name) = extract_after_keyword(line, &["func ("]) {
        // Method: func (r Receiver) MethodName(
        let after_paren = name.split(')').nth(1).unwrap_or("").trim();
        let name = after_paren
            .split('(')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !name.is_empty() && is_valid_ident(&name) {
            elements.push(CodeElement {
                kind: ElementKind::Method,
                name,
                line: lineno,
                context: safe_slice(line, 80).to_string(),
            });
        }
        return;
    }
    if let Some(name) = extract_after_keyword(line, &["func "]) {
        let name = name.split('(').next().unwrap_or("").trim().to_string();
        if !name.is_empty() && is_valid_ident(&name) {
            elements.push(CodeElement {
                kind: ElementKind::Function,
                name,
                line: lineno,
                context: safe_slice(line, 80).to_string(),
            });
        }
        return;
    }
    if let Some(name) = extract_after_keyword(line, &["type "]) {
        let parts: Vec<&str> = name.split_whitespace().collect();
        if parts.len() >= 2 {
            let tname = parts[0].to_string();
            let tkind = match parts[1] {
                "struct" => ElementKind::Struct,
                "interface" => ElementKind::Interface,
                _ => ElementKind::Variable,
            };
            if is_valid_ident(&tname) {
                elements.push(CodeElement {
                    kind: tkind,
                    name: tname,
                    line: lineno,
                    context: safe_slice(line, 80).to_string(),
                });
            }
        }
    }
}

// â”€â”€ KAI-powered code review â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// Review a file using KAI's field knowledge.
/// Runs analysis, then queries KAI's universe for relevant patterns/warnings.
pub fn review_file(path: &str, universe: &Universe) -> Result<String, String> {
    let analysis = analyze_file(path)?;
    let mut review = Vec::new();

    review.push(format!("â—† Code Review: {}", path));
    review.push(format!(
        "  {} | {} lines | {} fns | complexity ~{}",
        analysis.language,
        analysis.lines,
        analysis
            .elements
            .iter()
            .filter(|e| matches!(e.kind, ElementKind::Function | ElementKind::Method))
            .count(),
        analysis.complexity_estimate
    ));
    review.push(String::new());

    // TODOs
    if !analysis.todos.is_empty() {
        review.push(format!("âš  Unresolved TODOs ({}):", analysis.todos.len()));
        for t in analysis.todos.iter().take(5) {
            review.push(format!("  {}", t));
        }
        review.push(String::new());
    }

    // Complexity warning
    if analysis.complexity_estimate > 20 {
        review.push(format!(
            "âš  High complexity (~{}) â€” consider splitting into smaller functions.",
            analysis.complexity_estimate
        ));
    }

    // Large file warning
    if analysis.lines > 500 {
        review.push(format!(
            "âš  Large file ({} lines) â€” consider modularizing.",
            analysis.lines
        ));
    }

    // Query KAI's field for relevant patterns
    let query = format!("{} code quality patterns best practices", analysis.language);
    let hits = universe.query(&query, 3);

    if !hits.is_empty() {
        review.push("â—† KAI field knowledge on this:".to_string());
        for hit in hits.iter().take(2) {
            let clean = hit
                .label
                .trim_start_matches("[from-kai] ")
                .trim_start_matches("[about-kai] ")
                .trim();
            if clean.len() > 20 {
                review.push(format!("  Â· {}", safe_slice(clean, 120)));
            }
        }
    }

    // Check function count
    let fn_count = analysis
        .elements
        .iter()
        .filter(|e| matches!(e.kind, ElementKind::Function | ElementKind::Method))
        .count();
    if fn_count == 0 && analysis.lines > 50 {
        review.push("âš  No functions detected â€” file may be mostly data or config.".to_string());
    }

    if review.len() <= 3 {
        review.push("âœ“ No obvious structural issues found.".to_string());
    }

    Ok(review.join("\n"))
}

/// Store analysis results as KAI knowledge cells.
pub fn store_analysis(analysis: &FileAnalysis, universe: &mut Universe) -> usize {
    let mut stored = 0;

    // Store the summary
    let summary_cell = format!("[code-analysis] {} â€” {}", analysis.path, analysis.summary);
    if universe.store_or_reinforce(&summary_cell, "reasoning", "code-analysis", 1.2) {
        stored += 1;
    }

    // Store key functions and types
    for elem in analysis.elements.iter() {
        if matches!(elem.kind, ElementKind::Todo | ElementKind::Import) {
            continue;
        }
        let cell = format!(
            "[{}] {} {} in {}",
            analysis.language.to_lowercase(),
            elem.kind,
            elem.name,
            analysis.path
        );
        if universe.store_or_reinforce(&cell, "action", "code-analysis", 1.0) {
            stored += 1;
        }
    }

    stored
}

// â”€â”€ Utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

fn extract_after_keyword<'a>(line: &'a str, keywords: &[&str]) -> Option<&'a str> {
    for kw in keywords {
        if line.contains(kw) {
            if let Some(pos) = line.find(kw) {
                return Some(&line[pos + kw.len()..]);
            }
        }
    }
    None
}

fn is_valid_ident(s: &str) -> bool {
    !s.is_empty()
        && s.len() < 60
        && s.chars()
            .next()
            .map(|c| c.is_alphabetic() || c == '_')
            .unwrap_or(false)
        && s.chars().all(|c| c.is_alphanumeric() || c == '_')
}

/// Scan a directory for source files and analyze them all.
pub fn scan_directory(dir: &str, universe: &mut Universe) -> (usize, usize) {
    let source_extensions = [".rs", ".ts", ".tsx", ".js", ".py", ".go", ".cs", ".java"];
    let mut files_analyzed = 0;
    let mut cells_stored = 0;

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let path_str = path.to_string_lossy().to_string();

            // Skip node_modules, target, .git
            if path_str.contains("node_modules")
                || path_str.contains("\\target\\")
                || path_str.contains("/target/")
                || path_str.contains(".git")
            {
                continue;
            }

            if path.is_file() {
                let has_src_ext = source_extensions
                    .iter()
                    .any(|ext| path_str.to_lowercase().ends_with(ext));
                if has_src_ext {
                    if let Ok(analysis) = analyze_file(&path_str) {
                        cells_stored += store_analysis(&analysis, universe);
                        files_analyzed += 1;
                    }
                }
            }
        }
    }

    (files_analyzed, cells_stored)
}
