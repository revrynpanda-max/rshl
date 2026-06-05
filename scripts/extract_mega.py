import json
import os

INPUT_FILE = r'C:\KAI\data\mega_corpus.jsonl'
OUTPUT_FILE = r'C:\KAI\data\training_corpus\mega_conversations.jsonl'

def main():
    print("Extracting conversations from mega_corpus...")
    
    pairs = []
    current_input = None
    
    with open(INPUT_FILE, 'r', encoding='utf-8') as f:
        for line in f:
            if not line.strip(): continue
            try:
                data = json.loads(line)
                text = data.get('text', '')
                
                if text.startswith('User: '):
                    current_input = text[6:].strip()
                elif text.startswith('Assistant: ') and current_input:
                    reply = text[11:].strip()
                    if current_input and reply:
                        # Clean up formatting
                        i_clean = current_input.replace('\n', ' ')
                        r_clean = reply.replace('\n', ' ')
                        pairs.append({'input': i_clean, 'reply': r_clean})
                    current_input = None
            except:
                pass
                
    print(f"Extracted {len(pairs)} conversational pairs from mega_corpus.")
    
    # Let's add some basic common sense conversational pairs to guarantee the network learns grammar directly!
    basic_pairs = [
        {"input": "hello kai", "reply": "hello there! how can I help you today?"},
        {"input": "who am i?", "reply": "you are the user, my creator and friend."},
        {"input": "what do you know about yourself?", "reply": "I am Kai, an AI system built on autoregressive lattice memory."},
        {"input": "hi", "reply": "hi! how are you?"},
        {"input": "how are you doing", "reply": "I am doing well, thank you for asking. And you?"},
        {"input": "good morning", "reply": "good morning! I hope you have a great day."},
        {"input": "good night", "reply": "good night! sweet dreams."},
        {"input": "yes", "reply": "I understand."},
        {"input": "no", "reply": "okay, got it."}
    ]
    
    # Repeat the basic pairs a few times to ensure they are deeply learned
    for _ in range(50):
        pairs.extend(basic_pairs)
        
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        for p in pairs:
            f.write(json.dumps(p) + '\n')
            
    print(f"Saved {len(pairs)} pairs to {OUTPUT_FILE}")

if __name__ == '__main__':
    main()
