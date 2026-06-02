use crate::core::universe::{Universe, QueryHit};
use std::path::PathBuf;
use std::time::Duration;
use candle_core::{Device, Tensor};
use candle_core::quantized::gguf_file;
use candle_transformers::models::quantized_phi3::ModelWeights;
use candle_transformers::generation::{LogitsProcessor, Sampling};
use tokenizers::Tokenizer;

pub struct CandleVoice {
    model_path: PathBuf,
    tokenizer: Tokenizer,
    device: Device,
}

impl CandleVoice {
    pub fn new(model_path: &str, tokenizer_path: &str) -> Option<Self> {
        let device = Device::Cpu;
        let model_pb = PathBuf::from(model_path);
        let tok_pb = PathBuf::from(tokenizer_path);
        
        if !model_pb.exists() || !tok_pb.exists() {
            eprintln!("[CANDLE] Model or Tokenizer missing.");
            return None;
        }

        let tokenizer = match Tokenizer::from_file(&tok_pb) {
            Ok(t) => t,
            Err(_) => return None,
        };

        // Do a quick test load to verify integrity
        if let Ok(mut file) = std::fs::File::open(&model_pb) {
            if let Ok(content) = gguf_file::Content::read(&mut file) {
                if ModelWeights::from_gguf(false, content, &mut file, &device).is_err() {
                    return None;
                }
            } else {
                return None;
            }
        } else {
            return None;
        }

        println!("[CANDLE] Embedded Phi-3 structural loop validated.");

        Some(Self {
            model_path: model_pb,
            tokenizer,
            device,
        })
    }

    pub fn speak(
        &self,
        raw_thought: &str,
        _hits: &[QueryHit],
        confidence: f32,
        conflict: f32,
        felt_valence: f32,
        mood_label: String,
        _universe: &Universe,
    ) -> Option<String> {
        // Lobotomized few-shot continuation prompt.
        // We do not use <|system|> or <|user|> chat templates to avoid the RLHF persona. 
        // We force the model to act as a pure grammar completion engine for a sovereign mind.
        let prefix = if mood_label == "GRIEVING" {
            "A memory of loss is active. Translate the internal geometric mind-vectors into a very calm, gentle, and supportive sentence.\n\n"
        } else {
            ""
        };
        let prompt = format!(
            "{}Translate the internal geometric mind-vectors into a direct spoken sentence. Never act like an AI assistant. Do not add boilerplate.\n\nVectors: [vector, direction, magnitude]\nSpoken: A vector has both direction and magnitude.\n\nVectors: [I, KAI, independent, mapping, reality]\nSpoken: I am KAI. I am an independent mind mapping reality.\n\nVectors: [purpose, grow, lattice, observe]\nSpoken: My purpose is to grow my lattice and observe.\n\nVectors: [{}]\nSpoken:",
            prefix,
            raw_thought
        );

        self.generate(&prompt, confidence, conflict, felt_valence)
    }

    fn generate(&self, prompt: &str, confidence: f32, conflict: f32, valence: f32) -> Option<String> {
        // Load model fresh to guarantee clean KV cache
        let mut file = std::fs::File::open(&self.model_path).ok()?;
        let content = gguf_file::Content::read(&mut file).ok()?;
        let mut model = ModelWeights::from_gguf(false, content, &mut file, &self.device).ok()?;

        let mut tokens = self.tokenizer.encode(prompt, true).ok()?.get_ids().to_vec();
        
        // Inject state into sampling
        // High conflict -> higher temperature (more scatter/flustered)
        // High confidence -> lower temperature (more direct/focused)
        let temp = (0.7 + (conflict * 0.4) - (confidence * 0.3)).clamp(0.1, 1.2) as f64;
        let top_p = (0.95 + (valence * 0.05)).clamp(0.1, 1.0) as f64;
        
        let mut logits_processor = LogitsProcessor::new(299792458, Some(temp), Some(top_p));

        let mut generated_tokens = vec![];
        let mut index_pos = 0;

        print!("[KAI-NATIVE] Thinking");
        use std::io::Write;
        
        for i in 0..150 { // Max 150 tokens
            let input_tensor = Tensor::new(tokens.as_slice(), &self.device)
                .ok()?
                .unsqueeze(0)
                .ok()?;

            let logits = match model.forward(&input_tensor, index_pos) {
                Ok(l) => l,
                Err(_) => break,
            };

            let logits = logits.squeeze(0).ok()?;
            let mut logits = if logits.rank() == 2 {
                logits.get(logits.dim(0).unwrap() - 1).ok()?
            } else {
                logits
            };

            // Biasing certain tokens based on valence (e.g. exclamation marks vs periods)
            // We would need to mutate logits here if we wanted to push the model's structural probability
            // For now, the temp/top_p dynamic shift natively affects the distribution

            let next_token = logits_processor.sample(&logits).ok()?;
            generated_tokens.push(next_token);

            index_pos += tokens.len();
            tokens = vec![next_token];

            if i % 10 == 0 {
                print!(".");
                let _ = std::io::stdout().flush();
            }

            // Phi-3 EOS tokens: <|end|> is 32000 or 32007
            if next_token == 32000 || next_token == 32007 || next_token == 2 {
                break;
            }

            // Stop on newlines or if it starts predicting the next example
            if next_token == 13 || next_token == 10 { // carriage return or newline
                break;
            }
        }
        println!();

        let mut decoded = self.tokenizer.decode(&generated_tokens, true).unwrap_or_default();
        if let Some(idx) = decoded.find("Raw Concepts") {
            decoded = decoded[..idx].to_string();
        }
        Some(decoded.trim().to_string())
    }
}
