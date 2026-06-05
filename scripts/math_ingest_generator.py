import os
import re
import sys
from datasets import load_dataset

def main():
    print("Loading Cosmopedia Advanced Math & Stanford Physics dataset streams...")
    
    # We will pull a mix of pure math equations/logic and advanced university physics
    try:
        math_data = load_dataset("HuggingFaceTB/cosmopedia", "auto_math_text", split="train", streaming=True)
        physics_data = load_dataset("HuggingFaceTB/cosmopedia", "stanford", split="train", streaming=True)
    except Exception as e:
        print(f"Error loading dataset: {e}")
        sys.exit(1)

    out_file = "C:/KAI/data/training_corpus/advanced_math_physics.txt"
    os.makedirs(os.path.dirname(out_file), exist_ok=True)

    print("Extracting quantum physics, classical mechanics, and mathematical topologies...")
    fact_count = 0
    
    with open(out_file, "w", encoding="utf-8") as f:
        # Pull 500 advanced math / theorems / proofs
        for count, item in enumerate(math_data):
            text = item.get("text", "")
            sentences = re.split(r'(?<=[.!?])\s+', text.replace('\n', ' '))
            for s in sentences:
                s = s.strip()
                if 20 < len(s) < 300:
                    s = s.replace('\n', ' ').replace('\r', '').replace('"', '')
                    f.write(f"[advanced_math] {s}\n")
                    fact_count += 1
            if count >= 300: 
                break
                
        # Pull 500 Stanford-level physics / quantum mechanics texts
        for count, item in enumerate(physics_data):
            text = item.get("text", "")
            sentences = re.split(r'(?<=[.!?])\s+', text.replace('\n', ' '))
            for s in sentences:
                s = s.strip()
                if 20 < len(s) < 300:
                    s = s.replace('\n', ' ').replace('\r', '').replace('"', '')
                    f.write(f"[quantum_physics] {s}\n")
                    fact_count += 1
            if count >= 300:
                break

    print(f"Done! Successfully generated {fact_count} advanced math and physics facts into {out_file}")

if __name__ == "__main__":
    main()
