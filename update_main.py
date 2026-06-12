import sys

with open('src/main.rs', 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace('ollama_voice: Option<kai::cognition::OllamaVoice>', 'candle_voice: Option<kai::cognition::CandleVoice>')
content = content.replace('ollama_voice: {', 'candle_voice: {')
content = content.replace('let ollama_voice = {', 'let candle_voice = {')
content = content.replace('self.ollama_voice.as_ref()', 'self.candle_voice.as_ref()')
content = content.replace('ollama_voice.as_ref()', 'candle_voice.as_ref()')
content = content.replace('kai::cognition::OllamaVoice::new(url, &model)', 'kai::cognition::CandleVoice::new("models/model.gguf", "models/tokenizer.json")')

with open('src/main.rs', 'w', encoding='utf-8') as f:
    f.write(content)
print("Updated main.rs successfully")
