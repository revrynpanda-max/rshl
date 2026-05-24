#!/usr/bin/env python3
"""
Fast Replay script: rebuild lost synaptic weights and confidence scores 
by querying the lattice associatively and then batch-training the hits,
bypassing the slow LLM pipeline.
"""
import csv
import json
import urllib.request
import time
from collections import OrderedDict

QUERY_URL = "http://127.0.0.1:3334/api/rshl/query"
TRAIN_URL = "http://127.0.0.1:3334/api/synapse/train"
LOG_PATH = r"C:\KAI\data\phi_c_log.csv"
SKIP_PREFIXES = ["what is your name?", "[RECALLED FROM", "[system", "error:", "---", "==="]
MIN_QUERY_LEN = 10

def is_noise(text: str) -> bool:
    t = text.lower().strip()
    if len(t) < MIN_QUERY_LEN: return True
    for p in SKIP_PREFIXES:
        if t.startswith(p.lower()): return True
    if all(c.isspace() or c in "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~" for c in t): return True
    return False

def query_lattice(text):
    payload = json.dumps({"query": text, "n": 30}).encode("utf-8")
    req = urllib.request.Request(QUERY_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"Query error: {e}")
        return []

def train_synapses(pair_group):
    if len(pair_group) < 2: return
    payload = json.dumps({"pairs": [pair_group]}).encode("utf-8")
    req = urllib.request.Request(TRAIN_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"Train error: {e}")

def main():
    seen = OrderedDict()
    with open(LOG_PATH, "r", encoding="utf-8", errors="ignore") as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) < 3: continue
            query = row[-1].strip().strip('"')
            if not query or is_noise(query): continue
            if query not in seen: seen[query] = True

    queries = list(seen.keys())
    print(f"[replay] {len(queries)} unique queries to replay")
    
    total_trained = 0
    for i, q in enumerate(queries):
        hits = query_lattice(q)
        labels = [hit["label"] for hit in hits if "label" in hit]
        if len(labels) >= 2:
            train_synapses(labels)
            total_trained += 1
        
        if (i+1) % 50 == 0:
            print(f"Processed {i+1}/{len(queries)} queries. Fired {total_trained} synapse training batches.")

    print(f"[replay] Done. Trained {total_trained} memory associations.")

if __name__ == "__main__":
    main()
