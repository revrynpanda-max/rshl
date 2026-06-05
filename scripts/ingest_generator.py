import os
import re
import sys
from datasets import load_dataset

def main():
    print("Loading Cosmopedia K-12 textbooks dataset stream...")
    try:
        # Load the khanacademy slice of Cosmopedia via streaming
        dataset = load_dataset("HuggingFaceTB/cosmopedia", "khanacademy", split="train", streaming=True)
    except Exception as e:
        print(f"Error loading dataset: {e}")
        sys.exit(1)

    out_file = "C:/KAI/data/ingest/k12_curriculum.txt"
    os.makedirs(os.path.dirname(out_file), exist_ok=True)

    print("Extracting educational facts and formatting for Oracle Ingestion...")
    count = 0
    fact_count = 0
    
    with open(out_file, "w", encoding="utf-8") as f:
        for item in dataset:
            text = item.get("text", "")
            # Basic sentence splitting
            sentences = re.split(r'(?<=[.!?])\s+', text.replace('\n', ' '))
            
            for s in sentences:
                s = s.strip()
                # Filter out garbage, headings, or overly long sentences
                if 20 < len(s) < 250:
                    # Clean up quotes and newlines
                    s = s.replace('\n', ' ').replace('\r', '').replace('"', '')
                    f.write(f"[education] {s}\n")
                    fact_count += 1
            
            count += 1
            if count >= 250:  # 250 textbooks = approx 15,000 to 25,000 facts
                break

    print(f"Done! Successfully generated {fact_count} K-12 facts into {out_file}")

if __name__ == "__main__":
    main()
