#!/usr/bin/env python3
"""
Replay unique queries from phi_c_log.csv to rebuild lost synaptic weights,
confidence scores, and convergence updates after delta overwrite.
Sends queries to KAI Oracle /api/oracle-turn in controlled batches.
"""
import csv
import json
import urllib.request
import time
from collections import OrderedDict

API_URL = "http://127.0.0.1:3334/api/oracle-turn"
LOG_PATH = r"C:\KAI\data\phi_c_log.csv"
BATCH_SIZE = 20
DELAY_PER_QUERY = 0.5  # seconds — don't overload Oracle
SKIP_PREFIXES = [
    "what is your name?",
    "[RECALLED FROM",
    "[system",
    "error:",
    "---",
    "===",
]
MIN_QUERY_LEN = 10


def is_noise(text: str) -> bool:
    t = text.lower().strip()
    if len(t) < MIN_QUERY_LEN:
        return True
    for p in SKIP_PREFIXES:
        if t.startswith(p.lower()):
            return True
    # Skip pure punctuation/whitespace
    if all(c.isspace() or c in "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~" for c in t):
        return True
    return False


def post_query(text):
    payload = json.dumps({"from": "RecoveryBot", "text": text}).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read().decode()
    except urllib.error.HTTPError as e:
        return f"HTTP {e.code}"
    except Exception as e:
        return f"ERROR: {e}"


def main():
    # Read and deduplicate queries while preserving order
    seen = OrderedDict()
    with open(LOG_PATH, "r", encoding="utf-8", errors="ignore") as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) < 3:
                continue
            query = row[-1].strip().strip('"')
            if not query or is_noise(query):
                continue
            if query not in seen:
                seen[query] = True

    queries = list(seen.keys())
    print(f"[replay] {len(queries)} unique queries to replay")

    total = len(queries)
    for i, q in enumerate(queries):
        res = post_query(q)
        print(f"  [{i+1}/{total}] {q[:60]}{'...' if len(q) > 60 else ''} -> {res[:80]}")
        time.sleep(DELAY_PER_QUERY)

    print(f"[replay] Done. {total} queries replayed.")


if __name__ == "__main__":
    main()
