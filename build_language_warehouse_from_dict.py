#!/usr/bin/env python3
"""
build_language_warehouse_from_dict.py

Build a language warehouse from KAI's existing semantic dictionary.
This is a fallback when BitNet extraction fails (custom quantization).

Converts the semantic dictionary (9,649 words with definitions) into
sparse ternary vectors that the Language Warehouse can load.

Usage:
    python build_language_warehouse_from_dict.py --input data/semantic_dict.json --output data/language_warehouse.json
"""

import json
import argparse
from pathlib import Path

def build_warehouse(dict_path: str, output_path: str):
    print(f"[Build] Loading semantic dictionary from {dict_path}")
    
    with open(dict_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    words = data.get("words", {})
    print(f"[Build] Found {len(words)} words")
    
    vocab = {}
    dim = 16384  # KAI's standard dimension
    
    # Build sparse ternary vectors from word properties
    # Each word gets a vector based on:
    #   - Its character n-grams (positions 0-8191)
    #   - Its synonym relationships (positions 8192-12287)
    #   - Its POS tag (positions 12288-16383)
    
    for word, info in words.items():
        indices = []
        signs = []
        
        # Character n-gram hashing (positions 0-8191)
        for i in range(len(word) - 1):
            bigram = word[i:i+2]
            hash_val = hash(bigram) % 8192
            idx = abs(hash_val)
            if idx not in indices:
                indices.append(idx)
                signs.append(1)
        
        # Word length hash (position 8192)
        len_hash = (len(word) * 31) % 4096 + 8192
        indices.append(len_hash)
        signs.append(1)
        
        # POS tag (positions 12288-16383)
        pos = info.get("pos", "unknown")
        pos_hash = hash(pos) % 4096 + 12288
        indices.append(pos_hash)
        signs.append(1)
        
        # Synonym links
        synonyms = info.get("synonyms", [])
        for syn in synonyms[:5]:  # Limit to 5 synonyms
            syn_hash = hash(syn) % 4096 + 8192
            if syn_hash not in indices:
                indices.append(syn_hash)
                signs.append(1)
        
        # Sort indices
        combined = sorted(zip(indices, signs), key=lambda x: x[0])
        indices = [int(x[0]) for x in combined]
        signs = [int(x[1]) for x in combined]
        
        vocab[word] = {
            "indices": indices,
            "signs": signs
        }
    
    result = {
        "source_model": "semantic_dict",
        "dim": dim,
        "vocab_size": len(vocab),
        "format": "sparse_ternary",
        "vocab": vocab
    }
    
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, separators=(',', ':'))
    
    file_size = Path(output_path).stat().st_size / (1024 * 1024)
    print(f"[Build] Saved {len(vocab)} words ({file_size:.1f} MB) to {output_path}")
    print(f"[Build] Average sparsity: {sum(len(v['indices']) for v in vocab.values()) / len(vocab) / dim:.4f}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="data/semantic_dict.json")
    parser.add_argument("--output", default="data/language_warehouse.json")
    args = parser.parse_args()
    
    build_warehouse(args.input, args.output)
    print("[Build] Done! Language warehouse ready.")
