#!/usr/bin/env python3
"""
Recovery script: re-ingest harvest queue JSONL files after delta overwrite.
Pushes entries to KAI Oracle /api/bulk-ingest in batches of 50.
"""
import json
import os
import urllib.request
import time

API_URL = "http://127.0.0.1:3334/api/bulk-ingest"
QUEUE_DIR = r"C:\KAI\data\harvest_queue"
BATCH_SIZE = 50


def post_batch(entries):
    payload = json.dumps({"entries": entries}).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode()
            # Parse "Stored X / Y entries" plain text
            if "Stored" in body and "/" in body:
                parts = body.split()
                stored = int(parts[1]) if len(parts) > 1 else 0
                return {"stored": stored}
            return json.loads(body)
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode()}")
        return None
    except Exception as e:
        print(f"  Error: {e}")
        return None


def main():
    files = sorted(f for f in os.listdir(QUEUE_DIR) if f.endswith(".jsonl"))
    print(f"[recover] Found {len(files)} queue files to re-ingest")

    total_queued = 0
    total_ingested = 0

    for fn in files:
        path = os.path.join(QUEUE_DIR, fn)
        with open(path, "r", encoding="utf-8") as f:
            lines = [line.strip() for line in f if line.strip()]

        entries = []
        for line in lines:
            try:
                obj = json.loads(line)
                entries.append({
                    "text": obj.get("text", ""),
                    "region": obj.get("region", "knowledge"),
                    "source": obj.get("source", "harvest_queue"),
                    "strength": obj.get("strength", 1.0),
                })
            except json.JSONDecodeError:
                continue

        if not entries:
            continue

        print(f"[recover] {fn}: {len(entries)} entries")
        total_queued += len(entries)

        # Post in batches
        for i in range(0, len(entries), BATCH_SIZE):
            batch = entries[i : i + BATCH_SIZE]
            res = post_batch(batch)
            if res:
                stored = res.get("stored", 0)
                total_ingested += stored
                print(f"  batch {i//BATCH_SIZE + 1}: stored {stored}/{len(batch)}")
            else:
                print(f"  batch {i//BATCH_SIZE + 1}: FAILED")
            time.sleep(0.1)

    print(f"[recover] Done. Queued: {total_queued}, Ingested: {total_ingested}")


if __name__ == "__main__":
    main()
