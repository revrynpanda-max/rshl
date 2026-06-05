import os
import json
import re

def process_textbooks():
    ingest_dir = r"C:\KAI\data\ingest"
    output_file = r"C:\KAI\data\bulk.jsonl"
    
    files_to_process = [
        "advanced_math_physics.txt",
        "astrophysics_cosmology.txt",
        "k12_curriculum.txt"
    ]
    
    total_chunks = 0
    
    with open(output_file, 'w', encoding='utf-8') as outfile:
        for filename in files_to_process:
            filepath = os.path.join(ingest_dir, filename)
            if not os.path.exists(filepath):
                print(f"Skipping {filename}, not found.")
                continue
                
            print(f"Processing {filename}...")
            source_name = filename.replace('.txt', '')
            
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
                
            # Split by double newlines or single newlines depending on text structure
            # We want meaningful chunks (e.g. paragraphs or sentences)
            paragraphs = re.split(r'\n\s*\n', content)
            
            for para in paragraphs:
                clean_text = para.strip().replace('\n', ' ')
                if len(clean_text) > 30: # Only ingest meaningful chunks
                    # Max chunk size logic (split if too large)
                    if len(clean_text) > 1000:
                        sentences = re.split(r'(?<=[.!?]) +', clean_text)
                        chunk = ""
                        for sent in sentences:
                            if len(chunk) + len(sent) > 1000:
                                if chunk:
                                    outfile.write(json.dumps({
                                        "text": chunk.strip(),
                                        "region": "reasoning",
                                        "source": source_name,
                                        "strength": 1.0,
                                        "user_id": ""
                                    }) + "\n")
                                    total_chunks += 1
                                chunk = sent + " "
                            else:
                                chunk += sent + " "
                        if chunk:
                            outfile.write(json.dumps({
                                "text": chunk.strip(),
                                "region": "reasoning",
                                "source": source_name,
                                "strength": 1.0,
                                "user_id": ""
                            }) + "\n")
                            total_chunks += 1
                    else:
                        outfile.write(json.dumps({
                            "text": clean_text,
                            "region": "reasoning",
                            "source": source_name,
                            "strength": 1.0,
                            "user_id": ""
                        }) + "\n")
                        total_chunks += 1
                        
    print(f"Done! Extracted {total_chunks} atomic chunks to bulk.jsonl")

if __name__ == "__main__":
    process_textbooks()
