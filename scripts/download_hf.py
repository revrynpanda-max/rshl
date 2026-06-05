import urllib.request
import json
import os
import zipfile

OUTPUT_FILE = r'C:\KAI\data\training_corpus\reddit_conversations.jsonl'
# Daily dialog raw text zip:
URL = "http://yanran.li/files/ijcnlp_dailydialog.zip"

def main():
    print("Downloading dataset...")
    zip_path = "dataset.zip"
    urllib.request.urlretrieve(URL, zip_path)
    
    pairs = []
    
    with zipfile.ZipFile(zip_path, 'r') as z:
        # The file inside is usually 'ijcnlp_dailydialog/dialogues_text.txt'
        for name in z.namelist():
            if name.endswith('dialogues_text.txt'):
                with z.open(name) as f:
                    for line in f:
                        line = line.decode('utf-8').strip()
                        # Turns are separated by __eou__
                        turns = [t.strip() for t in line.split('__eou__') if t.strip()]
                        for i in range(len(turns) - 1):
                            pairs.append({'input': turns[i], 'reply': turns[i+1]})
                break
                
    print(f"Extracted {len(pairs)} conversational pairs.")
    
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        for p in pairs:
            f.write(json.dumps(p) + '\n')
            
    print(f"Saved to {OUTPUT_FILE}")

if __name__ == '__main__':
    main()
