import sys

path = r'C:\KAI\src\bridge\oracle_server.rs'
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

target = '''    let ar_reply = crate::cognition::lattice_attention::generate_autoregressive_response(
        &final_query,
        &mut u,
        25, // max 25 tokens for final reply
    );
    
    ar_reply
}'''

repl = '''    let ar_reply = crate::cognition::lattice_attention::generate_autoregressive_response(
        &final_query,
        &mut u,
        25, // max 25 tokens for final reply
    );
    
    // 5. Broca's Area (LLM Synthesis)
    let synthesis_prompt = format!(
        "User: {}\\n\\nYour internal retrieved context:\\n{}\\n{}\\n\\nRespond to the user naturally and directly as KAI.",
        user_query, attentive_reply, ar_reply
    );
    
    if let Ok(synthesized) = call_ollama("KAI-Sovereign:latest", &synthesis_prompt, &system_prompt) {
        let cleaned = synthesized.trim().to_string();
        if !cleaned.is_empty() {
            return cleaned;
        }
    }
    
    ar_reply
}'''

if target in content:
    content = content.replace(target, repl)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(content)
    print('SUCCESS')
else:
    print('TARGET NOT FOUND')
