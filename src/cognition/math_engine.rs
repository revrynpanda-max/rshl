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

/// Result of trying to solve a math question
#[derive(Debug, Clone)]
pub struct MathResult {
    pub original: String,
    pub operation: String,
    pub answer: String,
    pub confidence: f32,
}

/// Try to detect and solve a math expression in natural language.
/// Returns None if the input is not a math question.
pub fn try_solve(input: &str) -> Option<MathResult> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Quick reject: no digits = no math
    if !trimmed.chars().any(|c| c.is_ascii_digit()) {
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
        });
    }

    // ── Division ─────────────────────────────────────────────────────
    if let Some((a, b)) = parse_binary_op(stripped, &[" divided by ", " over ", " / "], false) {
        if b == 0.0 { return None; }
        let ans = a / b;
        return Some(MathResult {
            original: trimmed.to_string(),
            operation: "division".to_string(),
            answer: format_answer(ans),
            confidence: 0.95,
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
        });
    }
    if let Some((a, b)) = parse_binary_op(stripped, &[" to the power of ", " raised to "], false) {
        let ans = a.powf(b);
        return Some(MathResult {
            original: trimmed.to_string(),
            operation: "exponentiation".to_string(),
            answer: format_answer(ans),
            confidence: 0.92,
        });
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
/// KAI should sound like he knows the rule, not like he looked it up.
pub fn explain_result(result: &MathResult) -> String {
    match result.operation.as_str() {
        "addition" => format!("{}. That's addition - combining two quantities.", result.answer),
        "subtraction" => format!("{}. Subtraction: removing one quantity from another.", result.answer),
        "multiplication" => format!("{}. Multiplication: repeated addition, scaled.", result.answer),
        "division" => format!("{}. Division: splitting a quantity into equal parts.", result.answer),
        "exponentiation" => format!("{}. Raising a number to a power: repeated multiplication.", result.answer),
        _ => format!("The result is {}.", result.answer),
    }
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
    fn test_squared() {
        let r = try_solve("What is 5 squared?").unwrap();
        assert_eq!(r.answer, "25");
    }

    #[test]
    fn test_negative_addition() {
        let r = try_solve("What is -3 plus 7?").unwrap();
        assert_eq!(r.answer, "4");
    }

    #[test]
    fn test_not_math() {
        assert!(try_solve("What is the capital of France?").is_none());
        assert!(try_solve("hello").is_none());
    }
}
