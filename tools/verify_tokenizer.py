import json
t = json.load(open('models/BitNet/tokenizer.json', encoding='utf-8'))
v = t.get('model', {}).get('vocab', {})
m = t.get('model', {}).get('merges', [])
print(f"Vocab: {len(v)}, Merges: {len(m)}")

# Find BOS/EOS tokens
for token, idx in v.items():
    if idx == 128000:
        print(f"Token 128000 (BOS): '{token}'")
    if idx == 128001:
        print(f"Token 128001 (EOS): '{token}'")
