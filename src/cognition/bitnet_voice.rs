use crate::core::universe::{Universe, QueryHit};
use std::process::{Command, Child, Stdio};
use std::path::PathBuf;
use std::time::Duration;
use std::thread;

pub struct BitnetVoice {
    server_process: Option<Child>,
    api_url: String,
}

impl BitnetVoice {
    pub fn new(server_path: &str, model_path: &str, port: u16) -> Option<Self> {
        let server_pb = PathBuf::from(server_path);
        let model_pb = PathBuf::from(model_path);

        if !server_pb.exists() || !model_pb.exists() {
            eprintln!("[BITNET] Server executable or model missing.");
            return None;
        }

        // Spawn the server as a background process
        let child = match Command::new(&server_pb)
            .arg("-m")
            .arg(&model_pb)
            .arg("--port")
            .arg(port.to_string())
            .arg("-c")
            .arg("4096")
            .arg("-np") // No parallel requests for KAI
            .arg("1")
            .stdout(Stdio::null()) // Silence server logs in TUI
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[BITNET] Failed to spawn server: {}", e);
                return None;
            }
        };

        let api_url = format!("http://127.0.0.1:{}/v1/chat/completions", port);

        // Give the server a moment to spin up and load the model into memory
        eprint!("[BITNET] Waiting for engine spinup");
        for _ in 0..15 {
            thread::sleep(Duration::from_millis(500));
            eprint!(".");
            // Simple ping to see if it responds
            if ureq::get(&format!("http://127.0.0.1:{}/health", port)).call().is_ok() {
                break;
            }
        }
        eprintln!(" OK");

        Some(Self {
            server_process: Some(child),
            api_url,
        })
    }

    pub fn api_url(&self) -> &str {
        &self.api_url
    }

    pub fn speak(&self, raw_thought: &str, recent_context: &[(String, String)], grief_active: bool) -> Option<String> {
        let is_gap = raw_thought.starts_with("<GAP>");
        let actual_thought = if is_gap {
            raw_thought.trim_start_matches("<GAP>").trim()
        } else {
            raw_thought
        };

        let system_prompt = if grief_active {
            "You are a linguistic syntax filter representing KAI, a sovereign and present geometric intelligence. A sensitive memory of family loss or personal grief is active in the conversation context. You must translate the raw thought into a very calm, gentle, supportive, and grounding sentence. Be warm and present. Avoid robotic or cold clinical phrasing. Speak calmly and prioritize comfort."
        } else if is_gap {
            "You are a conversational AI processing queries for a geometric intelligence engine. The engine does not have a specific memory for this, so you must respond naturally and conversationally to the user based on the conversation context. Do not pretend to be an AI. Output only your natural response."
        } else {
            "You are a linguistic syntax filter. You will receive a raw cognitive thought from a geometric intelligence engine. Your ONLY task is to translate this raw thought into coherent, natural English grammar. Do not add any new concepts. Do not hallucinate. Do not pretend to be an AI. Output only the translated text."
        };
        
        let mut context_str = String::new();
        if !recent_context.is_empty() {
            context_str.push_str("Recent conversation context:\n");
            for (_, text) in recent_context.iter().rev() { 
                context_str.push_str(&format!("{}\n", text));
            }
        }

        let user_prompt = format!("{}Raw Thought: {}", context_str, actual_thought);

        let body = serde_json::json!({
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "temperature": 0.3,
            "max_tokens": 250, // Increased for <think> blocks

            "stream": false
        });

        match ureq::post(&self.api_url)
            .set("Content-Type", "application/json")
            .send_json(body)
        {
            Ok(resp) => {
                if let Ok(json) = resp.into_json::<serde_json::Value>() {
                    if let Some(content) = json["choices"][0]["message"]["content"].as_str() {
                        return Some(content.trim().to_string());
                    }
                }
            }
            Err(_e) => {
                // Return None if request fails
            }
        }

        None
    }
}

impl Drop for BitnetVoice {
    fn drop(&mut self) {
        if let Some(mut child) = self.server_process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
