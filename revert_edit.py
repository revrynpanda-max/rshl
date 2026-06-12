import sys

with open('src/cognition/voice.rs', 'r', encoding='utf-8') as f:
    content = f.read()

target = """            let mut decoded = lex.incremental_generate_with(state, params);
            
            // --- Option 2A Formatting ---
            decoded = decoded.to_lowercase();
            decoded = format!("◆ {}", decoded.trim());
            
            if !decoded.trim().is_empty() && decoded.trim() != "◆" {"""

replacement = """            let decoded = lex.incremental_generate_with(state, params);
            if !decoded.trim().is_empty() {"""

if target in content:
    content = content.replace(target, replacement)
    with open('src/cognition/voice.rs', 'w', encoding='utf-8') as f:
        f.write(content)
    print("Replaced successfully")
else:
    print("Target not found")
