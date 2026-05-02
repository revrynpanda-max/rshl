use serde::{Deserialize, Serialize};
use std::path::Path;

use super::universe::Universe;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Polarity {
    Positive,
    Negative,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClaimStatus {
    Hypothesis,
    Claim,
    Stable,
    Contested,
    Rejected,
}

impl ClaimStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ClaimStatus::Hypothesis => "hypothesis",
            ClaimStatus::Claim => "claim",
            ClaimStatus::Stable => "stable",
            ClaimStatus::Contested => "contested",
            ClaimStatus::Rejected => "rejected",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StructuredClaim {
    pub subject: String,
    pub relation: String,
    pub object: String,
    pub polarity: Polarity,
    pub confidence: f32,
    pub source: String,
    pub source_trust: f32,
    pub status: ClaimStatus,
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum EvidenceKind {
    SourceLabelOnly,
    UserAssertion,
    TruthAnchor,
    ExternalReference,
    DerivedFromMemory,
}

impl EvidenceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EvidenceKind::SourceLabelOnly => "source_label_only",
            EvidenceKind::UserAssertion => "user_assertion",
            EvidenceKind::TruthAnchor => "truth_anchor",
            EvidenceKind::ExternalReference => "external_reference",
            EvidenceKind::DerivedFromMemory => "derived_from_memory",
        }
    }

    pub fn is_real(&self) -> bool {
        !matches!(self, EvidenceKind::SourceLabelOnly)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EvidenceRecord {
    pub claim_index: usize,
    pub kind: EvidenceKind,
    pub source: String,
    pub raw_text: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContradictionKind {
    PolarityConflict,
    ValueConflict,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContradictionRecord {
    pub claim_a: usize,
    pub claim_b: usize,
    pub kind: ContradictionKind,
    pub subject: String,
    pub relation: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RejectionRecord {
    pub raw_text: String,
    pub source: String,
    pub reason: String,
    pub timestamp: u64,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ClaimStore {
    pub claims: Vec<StructuredClaim>,
    pub evidence: Vec<EvidenceRecord>,
    pub contradictions: Vec<ContradictionRecord>,
    pub rejections: Vec<RejectionRecord>,
    pub universe_cells_seen: usize,
    pub structured_claims_parsed: usize,
    pub source_filtered_skipped: usize,
    pub unparseable_skipped: usize,
    pub contradictions_found: usize,
    pub promoted_this_run: usize,
    pub demoted_this_run: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpistemicSelfTest {
    pub fixture_claims: usize,
    pub expected: usize,
    pub found: usize,
    pub pass: bool,
}

impl ClaimStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn ingest(&mut self, raw_text: &str, source: &str) -> Option<usize> {
        let timestamp = unix_now();
        self.ingest_with_metadata(raw_text, source, 1.0, timestamp)
    }

    pub fn from_universe(universe: &Universe) -> Self {
        let mut store = ClaimStore::new();

        for cell in universe.cells() {
            store.universe_cells_seen += 1;
            if source_policy(&cell.claim.source, cell.claim.confidence).is_none() {
                store.source_filtered_skipped += 1;
                continue;
            }

            let timestamp = if cell.claim.last_verified != 0 {
                cell.claim.last_verified
            } else {
                cell.claim.created_at
            };

            if store
                .ingest_with_metadata(
                    &cell.claim.text,
                    &cell.claim.source,
                    cell.claim.confidence,
                    timestamp,
                )
                .is_some()
            {
                store.structured_claims_parsed += 1;
            } else {
                store.unparseable_skipped += 1;
            }
        }

        store
    }

    pub fn detect_contradictions(&mut self) -> usize {
        self.contradictions.clear();
        let mut contested_indices = Vec::new();

        for a in 0..self.claims.len() {
            if self.claims[a].status == ClaimStatus::Rejected {
                continue;
            }
            for b in (a + 1)..self.claims.len() {
                if self.claims[b].status == ClaimStatus::Rejected {
                    continue;
                }
                let Some(kind) = contradiction_kind(&self.claims[a], &self.claims[b]) else {
                    continue;
                };
                contested_indices.push(a);
                contested_indices.push(b);
                self.contradictions.push(ContradictionRecord {
                    claim_a: a,
                    claim_b: b,
                    kind,
                    subject: self.claims[a].subject.clone(),
                    relation: self.claims[a].relation.clone(),
                });
            }
        }

        for idx in contested_indices {
            if let Some(claim) = self.claims.get_mut(idx) {
                claim.status = ClaimStatus::Contested;
            }
        }

        self.contradictions_found = self.contradictions.len();
        self.contradictions_found
    }

    pub fn demote(&mut self) -> usize {
        self.demoted_this_run = 0;
        let stable_claims: Vec<StructuredClaim> = self
            .claims
            .iter()
            .filter(|claim| claim.status == ClaimStatus::Stable)
            .cloned()
            .collect();

        for idx in 0..self.claims.len() {
            if self.claims[idx].status != ClaimStatus::Hypothesis {
                continue;
            }
            let conflicts_stable = stable_claims
                .iter()
                .any(|stable| contradiction_kind(&self.claims[idx], stable).is_some());
            if !conflicts_stable {
                continue;
            }

            self.claims[idx].status = ClaimStatus::Rejected;
            self.demoted_this_run += 1;
            self.rejections.push(RejectionRecord {
                raw_text: self.raw_text_for_claim(idx),
                source: self.claims[idx].source.clone(),
                reason: "hypothesis_conflicts_with_stable_claim".to_string(),
                timestamp: unix_now(),
            });
        }

        self.demoted_this_run
    }

    pub fn promote(&mut self) -> usize {
        self.promoted_this_run = 0;
        let stable_claims: Vec<StructuredClaim> = self
            .claims
            .iter()
            .filter(|claim| claim.status == ClaimStatus::Stable)
            .cloned()
            .collect();

        for claim in &mut self.claims {
            if claim.status != ClaimStatus::Hypothesis {
                continue;
            }
            let confirmed_by_stable = stable_claims.iter().any(|stable| same_claim(claim, stable));
            if confirmed_by_stable {
                claim.status = ClaimStatus::Stable;
                self.promoted_this_run += 1;
            }
        }

        self.promoted_this_run
    }

    pub fn promote_and_demote(&mut self) -> (usize, usize) {
        let demoted = self.demote();
        let promoted = self.promote();
        (promoted, demoted)
    }

    pub fn save_json<P: AsRef<Path>>(&self, path: P) -> std::io::Result<usize> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        std::fs::write(path, &json)?;
        Ok(json.len())
    }

    pub fn load_json<P: AsRef<Path>>(path: P) -> std::io::Result<Self> {
        let raw = std::fs::read_to_string(path)?;
        serde_json::from_str(&raw)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }

    pub fn run_self_test() -> EpistemicSelfTest {
        let mut store = ClaimStore::new();
        let fixtures = [
            "KAI is not an LLM",
            "KAI is an LLM",
            "Ryan lives in Ohio",
            "Ryan lives in Florida",
            "The Earth is round",
            "The Earth is flat",
            "E equals mc2",
            "E equals zero",
            "Water is ice",
            "Water is steam",
        ];

        for fixture in fixtures {
            let _ = store.ingest(fixture, "self-test");
        }

        let found = store.detect_contradictions();
        let expected = 5;
        EpistemicSelfTest {
            fixture_claims: store.claims.len(),
            expected,
            found,
            pass: found == expected,
        }
    }

    pub fn ingest_with_metadata(
        &mut self,
        raw_text: &str,
        source: &str,
        confidence: f32,
        timestamp: u64,
    ) -> Option<usize> {
        let claim = parse_claim(raw_text, source, confidence, timestamp)?;
        let claim_index = self.claims.len();
        self.claims.push(claim);
        self.evidence.push(EvidenceRecord {
            claim_index,
            kind: evidence_kind_for_source(source),
            source: source.to_string(),
            raw_text: raw_text.trim().to_string(),
            timestamp,
        });
        Some(claim_index)
    }

    fn raw_text_for_claim(&self, claim_index: usize) -> String {
        self.evidence
            .iter()
            .find(|e| e.claim_index == claim_index)
            .map(|e| e.raw_text.clone())
            .unwrap_or_else(|| claim_text(&self.claims[claim_index]))
    }
}

fn contradiction_kind(a: &StructuredClaim, b: &StructuredClaim) -> Option<ContradictionKind> {
    if a.subject != b.subject || a.relation != b.relation {
        return None;
    }

    if a.object == b.object && a.polarity != b.polarity {
        return Some(ContradictionKind::PolarityConflict);
    }

    if a.object != b.object && a.polarity == Polarity::Positive && b.polarity == Polarity::Positive
    {
        if is_exclusive_relation(&a.relation) || exclusive_is_values(&a.object, &b.object) {
            return Some(ContradictionKind::ValueConflict);
        }
    }

    None
}

fn same_claim(a: &StructuredClaim, b: &StructuredClaim) -> bool {
    a.subject == b.subject
        && a.relation == b.relation
        && a.object == b.object
        && a.polarity == b.polarity
}

fn claim_text(claim: &StructuredClaim) -> String {
    let polarity = match claim.polarity {
        Polarity::Positive => "",
        Polarity::Negative => "not ",
    };
    format!(
        "{} {} {}{}",
        claim.subject, claim.relation, polarity, claim.object
    )
}

fn is_exclusive_relation(relation: &str) -> bool {
    matches!(relation, "name" | "lives_in" | "equals")
}

fn exclusive_is_values(a: &str, b: &str) -> bool {
    let pairs = [
        ("round", "flat"),
        ("true", "false"),
        ("real", "fake"),
        ("alive", "dead"),
        ("ice", "steam"),
        ("solid", "liquid"),
        ("solid", "gas"),
        ("liquid", "gas"),
    ];

    pairs
        .iter()
        .any(|(left, right)| (a == *left && b == *right) || (a == *right && b == *left))
}

fn parse_claim(
    raw_text: &str,
    source: &str,
    confidence: f32,
    timestamp: u64,
) -> Option<StructuredClaim> {
    let normalized = normalize_text(raw_text);

    for sentence in claim_sentences(&normalized) {
        let sentence = strip_casual_opener(sentence);
        if is_question_like(sentence) {
            continue;
        };

        if let Some(name) = sentence.strip_prefix("my name is ") {
            let object = clean_object(first_clause(name));
            if !is_clean_object(&object) {
                continue;
            }
            let (status, source_trust) =
                source_policy(source, confidence).unwrap_or(default_source_policy());
            return Some(StructuredClaim {
                subject: first_person_subject_for_source(source),
                relation: "name".to_string(),
                object,
                polarity: Polarity::Positive,
                confidence,
                source: source.to_string(),
                source_trust,
                status,
                timestamp,
            });
        }

        let patterns = [
            (" is not ", "is", Polarity::Negative),
            (" does not have ", "has", Polarity::Negative),
            (" is located in ", "located_in", Polarity::Positive),
            (" was born in ", "born_in", Polarity::Positive),
            (" works at ", "works_at", Polarity::Positive),
            (" lives in ", "lives_in", Polarity::Positive),
            (" equals ", "equals", Polarity::Positive),
            (" is greater than ", "greater_than", Polarity::Positive),
            (" created ", "created", Polarity::Positive),
            (" built ", "built", Polarity::Positive),
            (" stores ", "stores", Polarity::Positive),
            (" detects ", "detects", Polarity::Positive),
            (" causes ", "causes", Polarity::Positive),
            (" supports ", "supports", Polarity::Positive),
            (" contradicts ", "contradicts", Polarity::Positive),
            (" has ", "has", Polarity::Positive),
            (" is ", "is", Polarity::Positive),
        ];

        for (needle, relation, polarity) in patterns {
            let Some((mut subject, object)) = split_once_clean(sentence, needle) else {
                continue;
            };
            if matches!(subject.as_str(), "i" | "me") {
                subject = first_person_subject_for_source(source);
            }
            if !is_clean_subject(&subject) || !is_clean_object(&object) {
                continue;
            }
            let (status, source_trust) =
                source_policy(source, confidence).unwrap_or(default_source_policy());
            return Some(StructuredClaim {
                subject,
                relation: relation.to_string(),
                object,
                polarity,
                confidence,
                source: source.to_string(),
                source_trust,
                status,
                timestamp,
            });
        }
    }

    None
}

fn is_question_like(text: &str) -> bool {
    let text = strip_casual_opener(text);
    text.ends_with('?')
        || matches!(
            text.split_whitespace().next(),
            Some("what" | "who" | "where" | "when" | "why" | "how" | "do" | "does" | "did")
        )
}

fn strip_casual_opener(text: &str) -> &str {
    let mut text = text.trim_start();
    loop {
        let Some(opener) = [
            "hey again, ",
            "again, ",
            "again ",
            "well ",
            "so ",
            "ok ",
            "okay ",
            "wait ",
            "hey ",
            "yo ",
            "like ",
        ]
        .iter()
        .find(|opener| text.starts_with(**opener)) else {
            return text;
        };
        text = text[opener.len()..].trim_start();
    }
}

fn first_person_subject_for_source(source: &str) -> String {
    match source {
        "ryan" | "conversation" => "ryan".to_string(),
        _ => "kai".to_string(),
    }
}

fn source_policy(source: &str, confidence: f32) -> Option<(ClaimStatus, f32)> {
    let source = source.to_lowercase();

    match source.as_str() {
        "truth-anchor" => Some((stable_if_confident(confidence), 1.00)),
        "physics-core" => Some((ClaimStatus::Stable, 0.95)),
        "identity" => Some((stable_if_confident(confidence), 0.90)),
        "ryan" => Some((ClaimStatus::Stable, 0.85)),
        "seed" => Some((ClaimStatus::Claim, 0.70)),
        "world-bridge" => Some((ClaimStatus::Hypothesis, 0.45)),
        "conversation" => Some((ClaimStatus::Hypothesis, 0.35)),
        "self-test" => Some((ClaimStatus::Claim, 1.00)),
        _ => None,
    }
}

fn stable_if_confident(confidence: f32) -> ClaimStatus {
    if confidence >= 0.9 {
        ClaimStatus::Stable
    } else {
        ClaimStatus::Claim
    }
}

fn default_source_policy() -> (ClaimStatus, f32) {
    (ClaimStatus::Claim, 0.50)
}

fn evidence_kind_for_source(source: &str) -> EvidenceKind {
    match source {
        "truth-anchor" => EvidenceKind::TruthAnchor,
        "physics-core" => EvidenceKind::ExternalReference,
        "ryan" => EvidenceKind::UserAssertion,
        "identity" | "seed" => EvidenceKind::DerivedFromMemory,
        _ => EvidenceKind::SourceLabelOnly,
    }
}

fn normalize_text(raw_text: &str) -> String {
    strip_leading_tags(raw_text)
        .trim_matches(|c: char| {
            matches!(
                c,
                '.' | ',' | ';' | ':' | '!' | '?' | '"' | '\'' | '(' | ')' | '[' | ']'
            )
        })
        .to_lowercase()
}

fn strip_leading_tags(raw_text: &str) -> &str {
    let mut text = raw_text.trim();
    loop {
        let Some(rest) = text.strip_prefix('[') else {
            return text;
        };
        let Some(end) = rest.find(']') else {
            return text;
        };
        text = rest[end + 1..].trim_start();
    }
}

fn claim_sentences(text: &str) -> impl Iterator<Item = &str> {
    text.split(['.', '!', '?', '\n', '\r'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn split_once_clean(text: &str, needle: &str) -> Option<(String, String)> {
    let (left, right) = text.split_once(needle)?;
    Some((clean_subject(left), clean_object(right)))
}

fn first_clause(text: &str) -> &str {
    text.split([',', ';', ':']).next().unwrap_or(text)
}

fn clean_atom(text: &str) -> String {
    let stopwords = ["a ", "an ", "the "];
    let mut atom = text.trim().to_string();
    for stopword in stopwords {
        if atom.starts_with(stopword) {
            atom = atom[stopword.len()..].to_string();
            break;
        }
    }
    atom
}

fn clean_subject(text: &str) -> String {
    let mut subject = clean_atom(text);
    if let Some((title, rest)) = subject.split_once(" - ") {
        let title = title.trim();
        let rest = rest.trim();
        if rest == title
            || rest.starts_with(title)
            || title.starts_with(rest)
            || word_count(title) <= 8
        {
            subject = title.to_string();
        }
    }
    subject
}

fn clean_object(text: &str) -> String {
    clean_atom(text)
}

fn is_clean_subject(subject: &str) -> bool {
    let words = word_count(subject);
    words > 0
        && words <= 8
        && !has_dirty_chars(subject)
        && !is_question_like(subject)
        && !subject.contains(" who ")
        && !subject.contains(" what ")
        && !subject.contains(" claims")
}

fn is_clean_object(object: &str) -> bool {
    let words = word_count(object);
    words > 0 && words <= 40 && !has_dirty_chars(object) && !is_question_like(object)
}

fn has_dirty_chars(text: &str) -> bool {
    text.contains('[') || text.contains(']') || text.contains('{') || text.contains('}')
}

fn word_count(text: &str) -> usize {
    text.split_whitespace().count()
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_patterns() {
        let claim = parse_claim("KAI is not an LLM.", "test", 0.7, 7).unwrap();
        assert_eq!(claim.subject, "kai");
        assert_eq!(claim.relation, "is");
        assert_eq!(claim.object, "llm");
        assert_eq!(claim.polarity, Polarity::Negative);
        assert_eq!(claim.confidence, 0.7);
        assert_eq!(claim.status, ClaimStatus::Claim);
        assert_eq!(claim.source_trust, 0.5);
        assert_eq!(claim.timestamp, 7);

        let claim = parse_claim("Ryan lives in Ohio", "test", 1.0, 7).unwrap();
        assert_eq!(claim.subject, "ryan");
        assert_eq!(claim.relation, "lives_in");
        assert_eq!(claim.object, "ohio");

        let claim = parse_claim("E equals mc2", "test", 1.0, 7).unwrap();
        assert_eq!(claim.subject, "e");
        assert_eq!(claim.relation, "equals");
        assert_eq!(claim.object, "mc2");

        let claim = parse_claim("X is greater than Y", "test", 1.0, 7).unwrap();
        assert_eq!(claim.subject, "x");
        assert_eq!(claim.relation, "greater_than");
        assert_eq!(claim.object, "y");

        let claim = parse_claim("Ryan created KAI", "test", 1.0, 7).unwrap();
        assert_eq!(claim.subject, "ryan");
        assert_eq!(claim.relation, "created");
        assert_eq!(claim.object, "kai");

        let claim = parse_claim("KAI has ClaimStore", "test", 1.0, 7).unwrap();
        assert_eq!(claim.subject, "kai");
        assert_eq!(claim.relation, "has");
        assert_eq!(claim.object, "claimstore");

        let claim = parse_claim("Universe stores cells", "test", 1.0, 7).unwrap();
        assert_eq!(claim.subject, "universe");
        assert_eq!(claim.relation, "stores");
        assert_eq!(claim.object, "cells");

        let claim = parse_claim("ClaimStore detects contradictions", "test", 1.0, 7).unwrap();
        assert_eq!(claim.subject, "claimstore");
        assert_eq!(claim.relation, "detects");
        assert_eq!(claim.object, "contradictions");
    }

    #[test]
    fn skips_questions_and_resolves_first_person_names() {
        assert!(parse_claim("What is a quasicrystal?", "conversation", 1.0, 7).is_none());
        assert!(parse_claim("[about-kai] well what is this?", "conversation", 1.0, 7).is_none());

        let claim = parse_claim(
            "My name is KAI. I am a geometric intelligence.",
            "identity",
            4.0,
            7,
        )
        .unwrap();
        assert_eq!(claim.subject, "kai");
        assert_eq!(claim.relation, "name");
        assert_eq!(claim.object, "kai");

        let claim = parse_claim("My name is Ryan", "ryan", 2.0, 7).unwrap();
        assert_eq!(claim.subject, "ryan");
        assert_eq!(claim.relation, "name");
        assert_eq!(claim.object, "ryan");

        let claim = parse_claim("Hey again, my name is Ryan", "ryan", 2.0, 7).unwrap();
        assert_eq!(claim.subject, "ryan");
        assert_eq!(claim.relation, "name");
        assert_eq!(claim.object, "ryan");

        let claim = parse_claim(
            "[about-ryan] Hey again, My name is Ryan, i say again because I'm your creator.",
            "ryan",
            2.0,
            7,
        )
        .unwrap();
        assert_eq!(claim.subject, "ryan");
        assert_eq!(claim.relation, "name");
        assert_eq!(claim.object, "ryan");
    }

    #[test]
    fn parses_sentence_atoms_and_cleans_article_titles() {
        let claim = parse_claim(
            "Aboulomania - Aboulomania is a mental disorder characterized by pathological indecisiveness. Extra text follows.",
            "world-bridge",
            0.8,
            7,
        )
        .unwrap();

        assert_eq!(claim.subject, "aboulomania");
        assert_eq!(claim.relation, "is");
        assert_eq!(
            claim.object,
            "mental disorder characterized by pathological indecisiveness"
        );
    }

    #[test]
    fn rejects_long_dirty_subjects() {
        assert!(parse_claim(
            "Adaptive performance in the work environment refers to adjusting to and understanding change in the workplace. An employee who claims is not clean.",
            "world-bridge",
            0.8,
            7,
        )
        .is_none());
    }

    #[test]
    fn only_exclusive_is_values_conflict() {
        let creator = parse_claim("Ryan Ervin is my creator", "identity", 3.0, 7).unwrap();
        let reason = parse_claim("Ryan Ervin is the reason I exist", "identity", 3.0, 7).unwrap();
        assert!(contradiction_kind(&creator, &reason).is_none());

        let round = parse_claim("Earth is round", "truth-anchor", 5.0, 7).unwrap();
        let flat = parse_claim("Earth is flat", "world-bridge", 1.0, 7).unwrap();
        assert_eq!(
            contradiction_kind(&round, &flat),
            Some(ContradictionKind::ValueConflict)
        );
    }

    #[test]
    fn finds_self_test_contradictions() {
        let result = ClaimStore::run_self_test();
        assert_eq!(result.fixture_claims, 10);
        assert_eq!(result.expected, 5);
        assert_eq!(result.found, 5);
        assert!(result.pass);
    }

    #[test]
    fn from_universe_parses_real_cells() {
        let mut universe = Universe::new();
        universe.store("KAI is not an LLM", "memory", "seed", 2.5);

        let store = ClaimStore::from_universe(&universe);

        assert_eq!(store.universe_cells_seen, 1);
        assert_eq!(store.structured_claims_parsed, 1);
        assert_eq!(store.unparseable_skipped, 0);
        assert_eq!(store.claims[0].subject, "kai");
        assert_eq!(store.claims[0].relation, "is");
        assert_eq!(store.claims[0].object, "llm");
        assert_eq!(store.claims[0].polarity, Polarity::Negative);
        assert_eq!(store.claims[0].confidence, 2.5);
        assert_eq!(store.claims[0].source, "seed");
        assert_eq!(store.claims[0].status, ClaimStatus::Claim);
        assert_eq!(store.claims[0].source_trust, 0.70);
        assert_eq!(store.evidence[0].kind, EvidenceKind::DerivedFromMemory);
    }

    #[test]
    fn from_universe_skips_unparseable() {
        let mut universe = Universe::new();
        universe.store(
            "spiral resonance dreaming through symbolic plasma",
            "memory",
            "seed",
            0.8,
        );

        let store = ClaimStore::from_universe(&universe);

        assert_eq!(store.universe_cells_seen, 1);
        assert_eq!(store.structured_claims_parsed, 0);
        assert_eq!(store.source_filtered_skipped, 0);
        assert_eq!(store.unparseable_skipped, 1);
        assert!(store.claims.is_empty());
    }

    #[test]
    fn from_universe_filters_dream_and_bridge_sources() {
        let mut universe = Universe::new();
        universe.store("KAI is not an LLM", "memory", "dream-discovery", 2.5);
        universe.store("KAI is an LLM", "memory", "hlv-bridge", 1.0);

        let store = ClaimStore::from_universe(&universe);

        assert_eq!(store.universe_cells_seen, 2);
        assert_eq!(store.source_filtered_skipped, 2);
        assert_eq!(store.structured_claims_parsed, 0);
        assert!(store.claims.is_empty());
    }

    #[test]
    fn from_universe_allows_world_bridge_despite_name() {
        let mut universe = Universe::new();
        universe.store("Earth is round", "reasoning", "world-bridge", 1.5);

        let store = ClaimStore::from_universe(&universe);

        assert_eq!(store.universe_cells_seen, 1);
        assert_eq!(store.source_filtered_skipped, 0);
        assert_eq!(store.structured_claims_parsed, 1);
        assert_eq!(store.claims[0].source, "world-bridge");
    }

    #[test]
    fn from_universe_finds_real_contradictions() {
        let mut universe = Universe::new();
        universe.store("KAI is not an LLM", "memory", "seed", 2.5);
        universe.store("KAI is an LLM", "memory", "ryan", 1.0);

        let mut store = ClaimStore::from_universe(&universe);
        let found = store.detect_contradictions();

        assert_eq!(store.universe_cells_seen, 2);
        assert_eq!(store.structured_claims_parsed, 2);
        assert_eq!(found, 1);
        assert_eq!(store.contradictions_found, 1);
        assert_eq!(store.claims[0].status, ClaimStatus::Contested);
        assert_eq!(store.claims[1].status, ClaimStatus::Contested);
    }

    #[test]
    fn source_policy_assigns_status_and_trust() {
        let mut universe = Universe::new();
        universe.store("Earth is round", "reasoning", "truth-anchor", 5.0);
        universe.store(
            "A web claim is provisional",
            "reasoning",
            "world-bridge",
            1.0,
        );
        universe.store("Ryan lives in Ohio", "memory", "ryan", 2.0);

        let store = ClaimStore::from_universe(&universe);

        assert_eq!(store.claims[0].status, ClaimStatus::Stable);
        assert_eq!(store.claims[0].source_trust, 1.00);
        assert_eq!(store.evidence[0].kind, EvidenceKind::TruthAnchor);
        assert_eq!(store.claims[1].status, ClaimStatus::Hypothesis);
        assert_eq!(store.claims[1].source_trust, 0.45);
        assert_eq!(store.evidence[1].kind, EvidenceKind::SourceLabelOnly);
        assert_eq!(store.claims[2].status, ClaimStatus::Stable);
        assert_eq!(store.claims[2].source_trust, 0.85);
        assert_eq!(store.evidence[2].kind, EvidenceKind::UserAssertion);
    }

    #[test]
    fn promotion_promotes_hypothesis_confirmed_by_stable_claim() {
        let mut store = ClaimStore::new();
        assert!(store
            .ingest_with_metadata("Earth is round", "truth-anchor", 1.0, 7)
            .is_some());
        assert!(store
            .ingest_with_metadata("Earth is round", "world-bridge", 0.5, 8)
            .is_some());

        let (promoted, demoted) = store.promote_and_demote();

        assert_eq!(promoted, 1);
        assert_eq!(demoted, 0);
        assert_eq!(store.promoted_this_run, 1);
        assert_eq!(store.demoted_this_run, 0);
        assert_eq!(store.claims[0].status, ClaimStatus::Stable);
        assert_eq!(store.claims[1].status, ClaimStatus::Stable);
    }

    #[test]
    fn demotion_quarantines_hypothesis_conflicting_with_stable_claim() {
        let mut store = ClaimStore::new();
        assert!(store
            .ingest_with_metadata("Earth is round", "truth-anchor", 1.0, 7)
            .is_some());
        assert!(store
            .ingest_with_metadata("Earth is flat", "world-bridge", 0.5, 8)
            .is_some());

        let (promoted, demoted) = store.promote_and_demote();
        let _contradictions = store.detect_contradictions();

        assert_eq!(promoted, 0);
        assert_eq!(demoted, 1);
        assert_eq!(store.promoted_this_run, 0);
        assert_eq!(store.demoted_this_run, 1);
        assert_eq!(store.claims[0].status, ClaimStatus::Stable);

    }
}

