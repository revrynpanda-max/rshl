//! Math Rule Engine — KAI's symbolic arithmetic solver
//!
//! Humans don't memorize that 2+2=4. They learn the *rule* of addition
//! and apply it to any numbers. This module gives KAI the same ability.
//!
//! When a user asks a math question, KAI should:
//!   1. Detect it as a math question (not a memory question)
//!   2. Find the relevant arithmetic rule
//!   3. Compute the answer symbolically
//!   4. Return the answer directly — no lattice search needed
//!
//! This is the DNA/RNA analogy the user described:
//!   Math rules = DNA (instructions)
//!   Numbers given = RNA (payload)
//!   Computation = Protein synthesis (applying rules to payload)

use chrono::{Local, NaiveDate, Duration};

/// Result of trying to solve a math question
#[derive(Debug, Clone)]
pub struct MathResult {
    pub original: String,
    pub operation: String,
    pub answer: String,
    pub confidence: f32,
    pub rule_notation: Option<String>,
}

/// Try to detect and solve a math expression in natural language.
/// Returns None if the input is not a math question.
pub fn try_solve(input: &str) -> Option<MathResult> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Quick reject: if no digits and no logic keywords, return None
    let lower = trimmed.to_lowercase();
    let has_logic = lower.contains("true") || lower.contains("false") || lower.contains("not ");
    let has_date = lower.contains("day") || lower.contains("date") || lower.contains("until");
    let has_unit = lower.contains("meter") || lower.contains("mile") || lower.contains("km") || lower.contains("kg");
    if !has_logic && !has_date && !has_unit && !trimmed.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }

    let lower = trimmed.to_lowercase();

    // ── Strip leading question words ───────────────────────────────────
    let stripped = lower
        .trim_start_matches("what is ")
        .trim_start_matches("what's ")
        .trim_start_matches("calculate ")
        .trim_start_matches("compute ")
        .trim_start_matches("how much is ")
        .trim_start_matches("solve ")
        .trim_start_matches("how many ")
        .trim_end_matches('?')
        .trim();

    // ── Addition ───────────────────────────────────────────────────────
    if let Some((a, b)) = parse_binary_op(stripped, &[" plus ", " added to ", " and ", " + "], false) {
        let ans = a + b;
        return Some(MathResult {
            original: trimmed.to_string(),
            operation: "addition".to_string(),
            answer: format_answer(ans),
            confidence: 0.95,
            rule_notation: Some("rule::addition = a + b".to_string()),
        });
    }

    // ── Subtraction ────────────────────────────────────────────────────
    if let Some((a, b)) = parse_binary_op(stripped, &[" minus ", " subtract ", " take away ", " less ", " - "], false) {
        let ans = a - b;
        return Some(MathResult {
            original: trimmed.to_string(),
            operation: "subtraction".to_string(),
            answer: format_answer(ans),
            confidence: 0.95,
            rule_notation: Some("rule::subtraction = a - b".to_string()),
        });
    }

    // ── Multiplication ─────────────────────────────────────────────────
    if let Some((a, b)) = parse_binary_op(stripped, &[" times ", " multiplied by ", " * "], false) {
        let ans = a * b;
        return Some(MathResult {
            original: trimmed.to_string(),
            operation: "multiplication".to_string(),
            answer: format_answer(ans),
            confidence: 0.95,
            rule_notation: Some("rule::multiplication = a * b".to_string()),
        });
    }

    // ── Division & Fake Math ──────────────────────────────────────────
    if let Some((a, b)) = parse_binary_op(stripped, &[" divided by ", " over ", " / "], false) {
        if b == 0.0 { 
            return Some(MathResult {
                original: trimmed.to_string(),
                operation: "division_zero".to_string(),
                answer: "undefined".to_string(),
                confidence: 0.99,
                rule_notation: Some("rule::division = a / b, b != 0".to_string()),
            });
        }
        let ans = a / b;
        return Some(MathResult {
            original: trimmed.to_string(),
            operation: "division".to_string(),
            answer: format_answer(ans),
            confidence: 0.95,
            rule_notation: Some("rule::division = a / b".to_string()),
        });
    }

    // ── Exponentiation ─────────────────────────────────────────────────
    if stripped.ends_with(" squared") || stripped.ends_with(" to the power of 2") {
        let num_part = stripped
            .trim_end_matches(" squared")
            .trim_end_matches(" to the power of 2")
            .trim();
        let a: f64 = num_part.parse().ok()?;
        let ans = a.powi(2);
        return Some(MathResult {
            original: trimmed.to_string(),
            operation: "exponentiation".to_string(),
            answer: format_answer(ans),
            confidence: 0.92,
            rule_notation: Some("rule::exponentiation = a ^ 2".to_string()),
        });
    }
    if let Some((a, b)) = parse_binary_op(stripped, &[" to the power of ", " raised to "], false) {
        let ans = a.powf(b);
        return Some(MathResult {
            original: trimmed.to_string(),
            operation: "exponentiation".to_string(),
            answer: format_answer(ans),
            confidence: 0.92,
            rule_notation: Some("rule::exponentiation = a ^ b".to_string()),
        });
    }

    // ── Percentages ────────────────────────────────────────────────────
    if let Some((pct, val)) = parse_binary_op(stripped, &["% of ", " percent of "], false) {
        let ans = (pct / 100.0) * val;
        return Some(MathResult {
            original: trimmed.to_string(),
            operation: "percentage".to_string(),
            answer: format_answer(ans),
            confidence: 0.95,
            rule_notation: Some("rule::percentage = (pct / 100) * val".to_string()),
        });
    }

    // ── Comparisons ────────────────────────────────────────────────────
    if let Some((a, b)) = parse_binary_op(stripped, &[" is greater than ", " greater than ", " > "], false) {
        return Some(MathResult {
            original: trimmed.to_string(),
            operation: "comparison_gt".to_string(),
            answer: (a > b).to_string(),
            confidence: 0.98,
            rule_notation: Some("rule::comparison_gt = a > b".to_string()),
        });
    }
    if let Some((a, b)) = parse_binary_op(stripped, &[" is less than ", " less than ", " < "], false) {
        return Some(MathResult {
            original: trimmed.to_string(),
            operation: "comparison_lt".to_string(),
            answer: (a < b).to_string(),
            confidence: 0.98,
            rule_notation: Some("rule::comparison_lt = a < b".to_string()),
        });
    }
    if let Some((a, b)) = parse_binary_op(stripped, &[" equal to ", " equals ", " = "], false) {
        return Some(MathResult {
            original: trimmed.to_string(),
            operation: "comparison_eq".to_string(),
            answer: (a == b).to_string(),
            confidence: 0.98,
            rule_notation: Some("rule::comparison_eq = a == b".to_string()),
        });
    }

    // ── Unit Conversions ───────────────────────────────────────────────
    if let Some((val, from_unit, to_unit)) = parse_unit_conversion(stripped) {
        if let Some(converted) = convert_unit(val, &from_unit, &to_unit) {
            return Some(MathResult {
                original: trimmed.to_string(),
                operation: "unit_conversion".to_string(),
                answer: format_answer(converted),
                confidence: 0.95,
                rule_notation: Some(format!("rule::unit_conversion = {} {} -> {}", val, from_unit, to_unit)),
            });
        }
    }

    // ── Date Math ─────────────────────────────────────────────────────
    if let Some((date1, date2)) = parse_date_range(stripped) {
        if let Some(days) = days_between(date1, date2) {
            return Some(MathResult {
                original: trimmed.to_string(),
                operation: "date_math".to_string(),
                answer: format_answer(days as f64),
                confidence: 0.95,
                rule_notation: Some("rule::date_math = days_between(d1, d2)".to_string()),
            });
        }
    }

    // ── Boolean Logic ──────────────────────────────────────────────────
    if let Some((a, b)) = parse_logic_op(stripped, &[" and ", " && "]) {
        return Some(MathResult {
            original: trimmed.to_string(),
            operation: "logic_and".to_string(),
            answer: (a && b).to_string(),
            confidence: 0.98,
            rule_notation: Some("rule::logic_and = a && b".to_string()),
        });
    }
    if let Some((a, b)) = parse_logic_op(stripped, &[" or ", " || "]) {
        return Some(MathResult {
            original: trimmed.to_string(),
            operation: "logic_or".to_string(),
            answer: (a || b).to_string(),
            confidence: 0.98,
            rule_notation: Some("rule::logic_or = a || b".to_string()),
        });
    }
    if let Some((a, b)) = parse_logic_op(stripped, &[" xor "]) {
        return Some(MathResult {
            original: trimmed.to_string(),
            operation: "logic_xor".to_string(),
            answer: (a ^ b).to_string(),
            confidence: 0.98,
            rule_notation: Some("rule::logic_xor = a ^ b".to_string()),
        });
    }
    if stripped.starts_with("not ") || stripped.starts_with("!") {
        let rest = stripped.trim_start_matches("not ").trim_start_matches('!').trim();
        if let Some(val) = parse_bool(rest) {
            return Some(MathResult {
                original: trimmed.to_string(),
                operation: "logic_not".to_string(),
                answer: (!val).to_string(),
                confidence: 0.98,
                rule_notation: Some("rule::logic_not = !a".to_string()),
            });
        }
    }

    None
}

/// Parse a binary operation: find the first matching operator, parse left and right operands.
fn parse_binary_op(text: &str, ops: &[&str], standalone_only: bool) -> Option<(f64, f64)> {
    for op in ops {
        if let Some(pos) = text.find(op) {
            let left_str = text[..pos].trim();
            let right_str = text[pos + op.len()..].trim().trim_end_matches('?').trim();
            // For standalone expressions like "5 + 3", left_str should be just a number
            if standalone_only && left_str.chars().any(|c| !c.is_ascii_digit() && c != '-' && c != '.') {
                continue;
            }
            let a: f64 = left_str.parse().ok()?;
            let b: f64 = right_str.parse().ok()?;
            return Some((a, b));
        }
    }
    None
}

/// Parse a string into a boolean
fn parse_bool(text: &str) -> Option<bool> {
    match text.trim() {
        "true" | "t" | "1" => Some(true),
        "false" | "f" | "0" => Some(false),
        _ => None,
    }
}

/// Parse a binary boolean operation
fn parse_logic_op(text: &str, ops: &[&str]) -> Option<(bool, bool)> {
    for op in ops {
        if let Some(pos) = text.find(op) {
            let left_str = text[..pos].trim();
            let right_str = text[pos + op.len()..].trim().trim_end_matches('?').trim();
            let a = parse_bool(left_str)?;
            let b = parse_bool(right_str)?;
            return Some((a, b));
        }
    }
    None
}

/// Parse unit conversion: "5 meters to feet" or "10 km in miles"
fn parse_unit_conversion(text: &str) -> Option<(f64, String, String)> {
    let patterns = [
        (" to ", " to "),
        (" in ", " in "),
        (" into ", " into "),
    ];
    
    for (pattern, _) in &patterns {
        if let Some(pos) = text.find(pattern) {
            let left = text[..pos].trim();
            let right = text[pos + pattern.len()..].trim().trim_end_matches('?').trim();
            
            // Find the first number in the left side (may not be at start)
            let mut num_start = 0;
            let mut num_end = 0;
            let mut found = false;
            for (i, c) in left.chars().enumerate() {
                if c.is_ascii_digit() || c == '.' || c == '-' {
                    if !found {
                        num_start = i;
                        found = true;
                    }
                    num_end = i + 1;
                } else if found && c.is_whitespace() {
                    break;
                }
            }
            if !found || num_end == 0 {
                continue;
            }
            let num_str = &left[num_start..num_end];
            let val: f64 = num_str.parse().ok()?;
            
            // Unit is the rest of the left side after the number
            let from_unit = left[num_end..].trim().to_lowercase();
            let to_unit = right.to_lowercase();
            
            if !from_unit.is_empty() && !to_unit.is_empty() {
                return Some((val, from_unit, to_unit));
            }
        }
    }
    None
}

/// Convert between units
fn convert_unit(val: f64, from: &str, to: &str) -> Option<f64> {
    let from = from.trim();
    let to = to.trim();
    
    // Length conversions
    match (from, to) {
        ("meters", "feet") | ("meter", "feet") | ("m", "ft") => Some(val * 3.28084),
        ("feet", "meters") | ("ft", "m") => Some(val / 3.28084),
        ("kilometers", "miles") | ("km", "miles") => Some(val * 0.621371),
        ("miles", "kilometers") | ("miles", "km") => Some(val / 0.621371),
        ("inches", "centimeters") | ("in", "cm") => Some(val * 2.54),
        ("centimeters", "inches") | ("cm", "in") => Some(val / 2.54),
        ("meters", "kilometers") | ("m", "km") => Some(val / 1000.0),
        ("kilometers", "meters") | ("km", "m") => Some(val * 1000.0),
        // Weight conversions
        ("kilograms", "pounds") | ("kg", "lbs") => Some(val * 2.20462),
        ("pounds", "kilograms") | ("lbs", "kg") => Some(val / 2.20462),
        ("grams", "kilograms") | ("g", "kg") => Some(val / 1000.0),
        ("kilograms", "grams") | ("kg", "g") => Some(val * 1000.0),
        ("ounces", "grams") | ("oz", "g") => Some(val * 28.3495),
        ("grams", "ounces") | ("g", "oz") => Some(val / 28.3495),
        // Temperature conversions
        ("celsius", "fahrenheit") | ("c", "f") => Some(val * 9.0/5.0 + 32.0),
        ("fahrenheit", "celsius") | ("f", "c") => Some((val - 32.0) * 5.0/9.0),
        ("celsius", "kelvin") | ("c", "k") => Some(val + 273.15),
        ("kelvin", "celsius") | ("k", "c") => Some(val - 273.15),
        // Time conversions
        ("seconds", "minutes") | ("sec", "min") => Some(val / 60.0),
        ("minutes", "seconds") | ("min", "sec") => Some(val * 60.0),
        ("minutes", "hours") | ("min", "hr") => Some(val / 60.0),
        ("hours", "minutes") | ("hr", "min") => Some(val * 60.0),
        ("hours", "days") | ("hr", "days") => Some(val / 24.0),
        ("days", "hours") | ("days", "hr") => Some(val * 24.0),
        _ => None,
    }
}

/// Parse date range: "days between 2024-01-01 and 2024-12-31" or "days until 2025-06-01"
fn parse_date_range(text: &str) -> Option<(NaiveDate, NaiveDate)> {
    let text = text.trim();
    
    // Pattern: "days between YYYY-MM-DD and YYYY-MM-DD"
    if text.contains("between") {
        let parts: Vec<&str> = text.split("between").collect();
        if parts.len() == 2 {
            let dates: Vec<&str> = parts[1].split("and").collect();
            if dates.len() == 2 {
                let d1 = parse_date(dates[0].trim())?;
                let d2 = parse_date(dates[1].trim().trim_end_matches('?'))?;
                return Some((d1, d2));
            }
        }
    }
    
    // Pattern: "days until YYYY-MM-DD"
    if text.contains("until") {
        let parts: Vec<&str> = text.split("until").collect();
        if parts.len() == 2 {
            let target_date = parse_date(parts[1].trim().trim_end_matches('?'))?;
            let today = Local::now().naive_local().date();
            return Some((today, target_date));
        }
    }
    
    None
}

/// Parse a date string in various formats
fn parse_date(text: &str) -> Option<NaiveDate> {
    let text = text.trim().trim_matches('"').trim_matches('\'');
    
    // Try YYYY-MM-DD
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return Some(date);
    }
    
    // Try MM/DD/YYYY
    if let Ok(date) = NaiveDate::parse_from_str(text, "%m/%d/%Y") {
        return Some(date);
    }
    
    // Try DD/MM/YYYY
    if let Ok(date) = NaiveDate::parse_from_str(text, "%d/%m/%Y") {
        return Some(date);
    }
    
    None
}

/// Calculate days between two dates
fn days_between(d1: NaiveDate, d2: NaiveDate) -> Option<i64> {
    let duration = d2.signed_duration_since(d1);
    Some(duration.num_days())
}

/// Format a float answer: if it's a whole number, show without decimal.
fn format_answer(v: f64) -> String {
    if (v - v.round()).abs() < 1e-9 {
        format!("{:.0}", v)
    } else {
        let s = format!("{:.6}", v);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// Build a natural-language response from a MathResult.
/// KAI speaks like a geometric intelligence — concise, precise, no fluff.
/// Rule: max 12 words. One sentence. The answer is the payload; the rule
/// is the DNA. KAI doesn't lecture — he states the result and tags the rule.
pub fn explain_result(result: &MathResult) -> String {
    match result.operation.as_str() {
        "addition" => format!("{}. Addition: combining quantities.", result.answer),
        "subtraction" => format!("{}. Subtraction: removing one quantity from another.", result.answer),
        "multiplication" => format!("{}. Multiplication: repeated addition, scaled.", result.answer),
        "division" => format!("{}. Division: splitting into equal parts.", result.answer),
        "division_zero" => format!("{}. Division by zero collapses the rule.", result.answer),
        "exponentiation" => format!("{}. Exponentiation: repeated multiplication.", result.answer),
        "percentage" => format!("{}. Percentage scaling.", result.answer),
        "comparison_gt" => format!("{}. Greater than comparison.", result.answer),
        "comparison_lt" => format!("{}. Less than comparison.", result.answer),
        "comparison_eq" => format!("{}. Equal comparison.", result.answer),
        "unit_conversion" => format!("{}. Unit conversion.", result.answer),
        "date_math" => format!("{}. Days between dates.", result.answer),
        "logic_and" => format!("{}. AND requires both.", result.answer),
        "logic_or" => format!("{}. OR needs one.", result.answer),
        "logic_xor" => format!("{}. XOR: exactly one.", result.answer),
        "logic_not" => format!("{}. NOT flips the bit.", result.answer),
        _ => format!("{}.", result.answer),
    }
}

/// Store a rule in the lattice as a tutoring cell.
/// This allows KAI to learn rules from the Oracle and apply them later.
pub fn store_rule_as_cell(rule: &str, explanation: &str) -> Option<(String, String, String, f32)> {
    if rule.is_empty() || explanation.is_empty() {
        return None;
    }
    
    let text = format!("Rule: {}\nExplanation: {}", rule, explanation);
    Some((text, "rule".to_string(), "rule_engine".to_string(), 10.0))
}

// ── Tests ─────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_addition_natural() {
        let r = try_solve("What is 5 plus 3?").unwrap();
        assert_eq!(r.answer, "8");
        assert_eq!(r.operation, "addition");
    }

    #[test]
    fn test_addition_symbol() {
        let r = try_solve("5 + 3").unwrap();
        assert_eq!(r.answer, "8");
    }

    #[test]
    fn test_subtraction() {
        let r = try_solve("What is 10 minus 4?").unwrap();
        assert_eq!(r.answer, "6");
    }

    #[test]
    fn test_multiplication() {
        let r = try_solve("What is 6 times 7?").unwrap();
        assert_eq!(r.answer, "42");
    }

    #[test]
    fn test_division() {
        let r = try_solve("What is 20 divided by 5?").unwrap();
        assert_eq!(r.answer, "4");
    }

    #[test]
    fn test_division_by_zero() {
        let r = try_solve("What is 5 divided by 0?").unwrap();
        assert_eq!(r.answer, "undefined");
        assert_eq!(r.operation, "division_zero");
    }

    #[test]
    fn test_squared() {
        let r = try_solve("What is 5 squared?").unwrap();
        assert_eq!(r.answer, "25");
    }

    #[test]
    fn test_percentage() {
        let r = try_solve("What is 20 percent of 50?").unwrap();
        assert_eq!(r.answer, "10");
    }

    #[test]
    fn test_comparison() {
        let r = try_solve("What is 5 greater than 3?").unwrap();
        assert_eq!(r.answer, "true");
        assert_eq!(r.operation, "comparison_gt");
    }

    #[test]
    fn test_unit_conversion() {
        let r = try_solve("5 meters to feet").unwrap();
        assert_eq!(r.answer, "16.4042");
        assert_eq!(r.operation, "unit_conversion");
    }

    #[test]
    fn test_date_math() {
        let r = try_solve("days between 2024-01-01 and 2024-01-10").unwrap();
        assert_eq!(r.answer, "9");
        assert_eq!(r.operation, "date_math");
    }

    #[test]
    fn test_logic() {
        let r1 = try_solve("What is true and false?").unwrap();
        assert_eq!(r1.answer, "false");
        assert_eq!(r1.operation, "logic_and");

        let r2 = try_solve("What is true or false?").unwrap();
        assert_eq!(r2.answer, "true");

        let r3 = try_solve("What is not true?").unwrap();
        assert_eq!(r3.answer, "false");
    }

    #[test]
    fn test_not_math() {
        assert!(try_solve("What is the capital of France?").is_none());
        assert!(try_solve("hello").is_none());
    }
}
