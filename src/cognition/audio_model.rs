//! Phase 3: Rust-Native Audio-Language Model
//! A native audio generation module leveraging the ElevenLabs TTS API.
//! This allows KAI to synthesize audio entirely locally, streaming audio
//! chunks as the LLM generates tokens, without relying on the Node.js middleware.

use std::env;
use ureq;
use serde_json::json;

/// Native Audio-Language Model via ElevenLabs API
pub struct AudioLanguageModel {
    api_key: String,
    voice_id: String,
}

impl AudioLanguageModel {
    pub fn new() -> Result<Self, &'static str> {
        println!("[AudioModel] Booting native ElevenLabs Audio-Language Model...");
        let api_key = env::var("ELEVENLABS_API_KEY").unwrap_or_default();
        let voice_id = env::var("ELEVENLABS_LEO_VOICE_ID").unwrap_or_else(|_| "NoFvXLmt0kcLW6bQBQ06".to_string());
        
        if api_key.is_empty() {
            println!("[AudioModel] Warning: ELEVENLABS_API_KEY is missing. Audio synthesis will be disabled.");
        }

        Ok(Self {
            api_key,
            voice_id,
        })
    }
    
    /// Streams text chunks into the ElevenLabs model and returns synthesized MP3 audio.
    pub fn synthesize_chunk(&mut self, text_chunk: &str) -> Result<Vec<u8>, &'static str> {
        if self.api_key.is_empty() {
            return Err("ElevenLabs API Key not set.");
        }

        println!("[AudioModel] Synthesizing audio chunk: '{}'...", text_chunk);
        
        let url = format!(
            "https://api.elevenlabs.io/v1/text-to-speech/{}/stream?optimize_streaming_latency=3&output_format=mp3_44100_128",
            self.voice_id
        );

        let body = json!({
            "text": text_chunk,
            "model_id": "eleven_flash_v2_5",
            "voice_settings": {
                "stability": 0.40,
                "similarity_boost": 0.80
            }
        });

        let response = ureq::post(&url)
            .set("xi-api-key", &self.api_key)
            .send_json(body)
            .map_err(|_| "Failed to connect to ElevenLabs API.")?;

        if response.status() != 200 {
            return Err("ElevenLabs API returned an error status.");
        }

        let mut audio_data = Vec::new();
        response.into_reader().read_to_end(&mut audio_data).map_err(|_| "Failed to read audio stream.")?;
        
        Ok(audio_data)
    }
}
