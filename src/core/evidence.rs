/// Evidence Source — Tracks where information came from.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum EvidenceSource {
    PhysicsCore,
    Article,
    User,
    Document,
    InternalSynthesis,
}

/// Trust Level — Qualitative trust in an evidence source.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum TrustLevel {
    High,
    Medium,
    Low,
}

/// Support Type — Nature of the link between evidence and a claim.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum SupportType {
    Direct,
    Indirect,
    Disputed,
}

/// A structured evidence record.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Evidence {
    pub source_type: EvidenceSource,
    pub trust: TrustLevel,
    pub support: SupportType,
    pub description: String,
}
