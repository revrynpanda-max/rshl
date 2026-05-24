#!/usr/bin/env python3
"""
Bulk-ingest Discord transcript history from transcripts.db into the live KAI universe.

Usage: python bulk_ingest_discord.py
"""

import sqlite3
import json
import urllib.request
import urllib.error
import time
import sys

DB_PATH = r"C:\KAI\tools\oracle-discord\transcripts.db"
API_URL = "http://127.0.0.1:3334/api/bulk-ingest"
BATCH_SIZE = 100

# Known noisy prefixes / patterns to skip
BAD_PREFIXES = [
    "error:", "warning:", "[system", "[critical", "http:",
    "thread '<", "panicked at", "---", "===", "`cargo",
    "`kai", "`ollama", "oracle: could not",
]

def is_noisy(text: str) -> bool:
    lower = text.lower().strip()
    if not lower:
        return True
    for p in BAD_PREFIXES:
        if lower.startswith(p):
            return True
    # Pure punctuation / whitespace
    if all(c.isspace() or c.isascii() and c in "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~" for c in text):
        return True
    return False

def main():
    print(f"[bulk-ingest] Connecting to {DB_PATH} ...")
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # Pull all non-test messages
    cursor.execute(
        "SELECT c0, c1, c2, c3, c4, c5 FROM transcript_fts_content WHERE c0 != 'test'"
    )
    rows = cursor.fetchall()
    print(f"[bulk-ingest] Raw rows from DB: {len(rows)}")

    # Deduplicate by (author, content, channel, timestamp)
    seen = set()
    unique_rows = []
    for row in rows:
        author, user_id, content_orig, content_clean, channel, ts = row
        key = (author, content_orig, channel, ts)
        if key in seen:
            continue
        seen.add(key)
        unique_rows.append(row)

    print(f"[bulk-ingest] After deduplication: {len(unique_rows)}")

    # Build entries
    entries = []
    skipped_short = 0
    skipped_noisy = 0
    for row in unique_rows:
        author, user_id, content_orig, _, channel, _ = row
        text = content_orig.strip()
        if len(text) < 5:
            skipped_short += 1
            continue
        if is_noisy(text):
            skipped_noisy += 1
            continue
        # Format like handle_discord_turn does: "{from}: {text}"
        formatted = f"{author}: {text}"
        entries.append({
            "text": formatted,
            "region": "social",
            "source": "discord-history",
            "strength": 0.9,
            "user_id": str(user_id) if user_id else "",
        })

    print(f"[bulk-ingest] After filtering (short={skipped_short}, noisy={skipped_noisy}): {len(entries)}")

    if not entries:
        print("[bulk-ingest] Nothing to ingest.")
        return

    # Send in batches
    total_batches = (len(entries) + BATCH_SIZE - 1) // BATCH_SIZE
    total_stored = 0
    for i in range(0, len(entries), BATCH_SIZE):
        batch = entries[i:i + BATCH_SIZE]
        payload = json.dumps({"entries": batch}).encode("utf-8")
        req = urllib.request.Request(
            API_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode("utf-8")
                print(f"[bulk-ingest] Batch {i // BATCH_SIZE + 1}/{total_batches} -> {body} (sent {len(batch)})")
                total_stored += len(batch)
        except urllib.error.HTTPError as e:
            print(f"[bulk-ingest] ERROR batch {i // BATCH_SIZE + 1}: HTTP {e.code} {e.reason}")
            print(f"  {e.read().decode('utf-8')}")
            break
        except Exception as e:
            print(f"[bulk-ingest] ERROR batch {i // BATCH_SIZE + 1}: {e}")
            break
        # Small sleep to avoid hammering the mutex
        time.sleep(0.05)

    print(f"[bulk-ingest] Done. Total entries sent: {total_stored}")

if __name__ == "__main__":
    main()
