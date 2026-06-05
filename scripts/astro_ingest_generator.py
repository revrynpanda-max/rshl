import os
import re
import sys
from datasets import load_dataset

def main():
    print("Loading Cosmopedia OpenStax and Stanford streams for Astrophysics, Geology, and Cosmology...")
    
    try:
        openstax_data = load_dataset("HuggingFaceTB/cosmopedia", "openstax", split="train", streaming=True)
        stanford_data = load_dataset("HuggingFaceTB/cosmopedia", "stanford", split="train", streaming=True)
    except Exception as e:
        print(f"Error loading dataset: {e}")
        sys.exit(1)

    out_file = "C:/KAI/data/training_corpus/astrophysics_cosmology.txt"
    os.makedirs(os.path.dirname(out_file), exist_ok=True)

    print("Extracting planetary geology, antimatter logic, and universal symmetry laws...")
    fact_count = 0
    
    keywords = ["planet", "rock", "geology", "galaxy", "star", "sun", "antimatter", 
                "symmetry", "quantum", "universe", "dimension", "particle", "matter", "laws"]
                
    with open(out_file, "w", encoding="utf-8") as f:
        # Pull from OpenStax (Textbooks on Astronomy, Physics, Geology)
        for count, item in enumerate(openstax_data):
            text = item.get("text", "")
            sentences = re.split(r'(?<=[.!?])\s+', text.replace('\n', ' '))
            for s in sentences:
                s_lower = s.lower()
                # Only keep sentences that contain relevant astrophysical or particle keywords
                if any(k in s_lower for k in keywords):
                    s = s.strip()
                    if 30 < len(s) < 400:
                        s = s.replace('\n', ' ').replace('\r', '').replace('"', '')
                        f.write(f"[astrophysics] {s}\n")
                        fact_count += 1
            if fact_count >= 10000: # Stop at 10k facts
                break
                
        # Pull from Stanford (Advanced Theoretical Physics, Antimatter, CPT Symmetry)
        stanford_count = 0
        for count, item in enumerate(stanford_data):
            text = item.get("text", "")
            sentences = re.split(r'(?<=[.!?])\s+', text.replace('\n', ' '))
            for s in sentences:
                s_lower = s.lower()
                if any(k in s_lower for k in ["antimatter", "symmetry", "dimension", "quantum", "cpt", "laws", "particle"]):
                    s = s.strip()
                    if 30 < len(s) < 400:
                        s = s.replace('\n', ' ').replace('\r', '').replace('"', '')
                        f.write(f"[theoretical_physics] {s}\n")
                        stanford_count += 1
                        fact_count += 1
            if stanford_count >= 10000: # Stop at 10k theoretical facts
                break

    print(f"Done! Successfully generated {fact_count} cosmic and quantum laws into {out_file}")

if __name__ == "__main__":
    main()
