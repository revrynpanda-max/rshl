//! HLV-Native Lattice Training Engine
//!
//! Dedicated pipeline for absorbing the Helix-Light-Vortex (HLV) Theory
//! into the RSHL lattice. This is not token prediction; it is geometric
//! resonance absorption.

use crate::core::Universe;
use lopdf::Document;

/// Minimum character length for a theoretical claim to be ingested.
const MIN_CLAIM_LEN: usize = 25;

/// Ingest the HLV theory directly from a PDF file.
pub fn ingest_hlv_pdf(universe: &mut Universe, pdf_path: &str) -> Result<IngestSummary, Box<dyn std::error::Error>> {
    println!("Loading PDF: {}", pdf_path);
    let full_text = extract_text_from_pdf(pdf_path)?;
    
    let mut summary = IngestSummary::default();
    let sections = segment_by_toc(&full_text);
    
    summary.total_sections = sections.len();

    for (title, content) in sections {
        let region = format!("hlv:{}", sanitize_title(&title));
        
        // Anchor the section
        universe.store_or_reinforce(
            &format!("Section: {}", title),
            &region,
            "hlv-anchor",
            0.85
        );
        summary.anchors_added += 1;

        // Absorb claims
        let sentences = split_sentences(content);
        for sentence in sentences {
            if sentence.len() < MIN_CLAIM_LEN { continue; }

            let is_new = universe.store_or_reinforce(
                &sentence,
                &region,
                "hlv-theory",
                1.3
            );
            
            if is_new {
                summary.claims_added += 1;
            } else {
                summary.claims_reinforced += 1;
            }

            // B: Resonance Check (Targeted Cross-Sectional Binding)
            // We increase search depth and lower threshold to force connections.
            let hits = universe.query(&sentence, 15);
            for hit in hits {
                let is_near_duplicate = word_overlap_ratio(&sentence, &hit.text) > 0.8;
                let is_different_region = hit.region != region;
                
                if hit.score > 0.35 && !is_near_duplicate && is_different_region {
                    let bridge = format!("Synthesizing: {} <-> {}", sentence, hit.text);
                    universe.store_or_reinforce(&bridge, "hlv-bridge", "hlv-resonance", 1.2);
                    summary.bridges_created += 1;
                }
            }
        }
    }

    Ok(summary)
}

/// Simple Jaccard-style overlap to detect near-duplicates
fn word_overlap_ratio(a: &str, b: &str) -> f32 {
    let a_lower = a.to_lowercase();
    let b_lower = b.to_lowercase();
    let set_a: std::collections::HashSet<_> = a_lower.split_whitespace().collect();
    let set_b: std::collections::HashSet<_> = b_lower.split_whitespace().collect();
    
    if set_a.is_empty() || set_b.is_empty() { return 0.0; }
    
    let intersection = set_a.intersection(&set_b).count();
    let union = set_a.union(&set_b).count();
    
    intersection as f32 / union as f32
}


/// Extracts raw text from all pages of a PDF.
fn extract_text_from_pdf(path: &str) -> Result<String, Box<dyn std::error::Error>> {
    let doc = Document::load(path)?;
    let mut full_text = String::new();
    
    // Pages are 1-indexed in lopdf
    let pages = doc.get_pages();
    for (page_num, _) in pages.iter() {
        let text_res = doc.extract_text(&[*page_num]);
        if let Ok(text) = text_res {
            full_text.push_str(&text);
            full_text.push('\n');
        }
    }
    
    if full_text.is_empty() {
        return Err("No text could be extracted from PDF. Is it an image-based PDF?".into());
    }
    
    Ok(full_text)
}

#[derive(Debug, Default)]
pub struct IngestSummary {
    pub total_sections: usize,
    pub anchors_added: usize,
    pub claims_added: usize,
    pub claims_reinforced: usize,
    pub bridges_created: usize,
}

fn segment_by_toc(text: &str) -> Vec<(String, String)> {
    let mut sections = Vec::new();
    let mut current_title = "Preamble".to_string();
    let mut current_start = 0;

    let lines: Vec<&str> = text.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if is_section_header(line) {
            let section_text = get_section_body(&lines, current_start, i);
            if !section_text.trim().is_empty() {
                sections.push((current_title.clone(), section_text));
            }
            current_title = line.trim().to_string();
            current_start = i + 1;
        }
    }
    
    let final_text = get_section_body(&lines, current_start, lines.len());
    sections.push((current_title, final_text));
    sections
}

fn is_section_header(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() { return false; }
    
    let first = trimmed.chars().next().unwrap();
    if !first.is_numeric() { return false; }
    
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    if parts.len() < 2 { return false; }
    
    let marker = parts[0];
    marker.chars().all(|c| c.is_numeric() || c == '.') && (marker.ends_with('.') || marker.contains('.'))
}

fn get_section_body(lines: &[&str], start_idx: usize, end_idx: usize) -> String {
    let mut body = String::new();
    for i in start_idx..end_idx {
        body.push_str(lines[i]);
        body.push('\n');
    }
    body
}

fn split_sentences(text: String) -> Vec<String> {
    text.split(|c| c == '.' || c == '!' || c == '?')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn sanitize_title(title: &str) -> String {
    title.to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ')
        .collect::<String>()
        .replace(" ", "_")
}
