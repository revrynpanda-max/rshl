import sys

# Fix voice.rs
with open('src/cognition/voice.rs', 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace('ollama,', 'candle_voice,')
with open('src/cognition/voice.rs', 'w', encoding='utf-8') as f:
    f.write(content)

# Fix ipc_server.rs
with open('src/bridge/ipc_server.rs', 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace('ollama_voice: Option<&crate::cognition::ollama_voice::OllamaVoice>', 'candle_voice: Option<&crate::cognition::candle_voice::CandleVoice>')
content = content.replace('ollama: Option<&crate::cognition::ollama_voice::OllamaVoice>', 'candle_voice: Option<&crate::cognition::candle_voice::CandleVoice>')
content = content.replace('ollama,', 'candle_voice,')
content = content.replace('ollama_voice,', 'candle_voice,')
with open('src/bridge/ipc_server.rs', 'w', encoding='utf-8') as f:
    f.write(content)

print("Fixed lingering ollama references")
