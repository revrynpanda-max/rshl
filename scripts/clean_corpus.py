import json
import os

def clean_corpus():
    corpus_dir = "data/training_corpus"
    target_file = os.path.join(corpus_dir, "transcript_pairs.jsonl")
    
    if not os.path.exists(target_file):
        print(f"File not found: {target_file}")
        return

    cleaned_pairs = []
    removed_count = 0
    total_count = 0

    print(f"Reading {target_file}...")
    with open(target_file, "r", encoding="utf-8") as f:
        for line in f:
            total_count += 1
            try:
                data = json.loads(line.strip())
                input_text = data.get("input", "").strip()
                reply_text = data.get("reply", "").strip()
                
                # Check if reply is basically an exact echo of the input
                # We lowercase and remove punctuation to be safe
                clean_in = ''.join(e for e in input_text.lower() if e.isalnum())
                clean_out = ''.join(e for e in reply_text.lower() if e.isalnum())
                
                if clean_in == clean_out and len(clean_in) > 0:
                    removed_count += 1
                    continue
                
                cleaned_pairs.append(line.strip())
            except:
                continue

    # Write it back out
    with open(target_file, "w", encoding="utf-8") as f:
        for p in cleaned_pairs:
            f.write(p + "\n")

    print(f"--- CORPUS CLEANUP COMPLETE ---")
    print(f"Total pairs scanned: {total_count}")
    print(f"Removed (Parrots): {removed_count}")
    print(f"Remaining pairs: {len(cleaned_pairs)}")

if __name__ == "__main__":
    clean_corpus()
