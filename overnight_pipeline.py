#!/usr/bin/env python3
"""
KAI Overnight Pipeline — Harvest + Auto-Ingest Loop
Fetches from web sources, queues entries, and bulk-ingests into KAI every 30 min.
Governor: pauses if RAM >33 GB or CPU >90%.
"""
import os, sys, json, time, random, urllib.request, urllib.error, glob, shutil
from datetime import datetime

BASE_DIR = r"C:\KAI"
QUEUE_DIR = os.path.join(BASE_DIR, "data", "harvest_queue")
INGESTED_DIR = os.path.join(QUEUE_DIR, "ingested")
KAI_API = "http://127.0.0.1:3334/api/bulk-ingest"
STATUS_API = "http://127.0.0.1:3334/api/status"

# Ensure dirs exist
os.makedirs(QUEUE_DIR, exist_ok=True)
os.makedirs(INGESTED_DIR, exist_ok=True)

# ── Simple fetchers ──────────────────────────────────────────────────────

def fetch_wikipedia(n=50):
    """Fetch random Wikipedia snippets."""
    try:
        url = "https://en.wikipedia.org/w/api.php?action=query&generator=random&grnnamespace=0&grnlimit={}&prop=extracts&exintro&explaintext&exchars=800&format=json&origin=*"
        req = urllib.request.Request(url.format(n), headers={"User-Agent": "KAI-Harvester/1.0"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
        pages = data.get("query", {}).get("pages", {})
        results = []
        for p in pages.values():
            title = p.get("title", "")
            text = p.get("extract", "")
            if text and len(text) > 100:
                results.append({"text": f"{title}: {text}", "region": "knowledge", "source": "wikipedia", "strength": 1.0})
        return results
    except Exception as e:
        print(f"[harvest] Wikipedia error: {e}")
        return []

def fetch_wikidata(n=20):
    """Fetch random Wikidata entity descriptions."""
    try:
        url = "https://www.wikidata.org/wiki/Special:EntityData/Q{}.json"
        results = []
        for _ in range(n):
            qid = random.randint(1, 12000000)
            req = urllib.request.Request(url.format(qid), headers={"User-Agent": "KAI-Harvester/1.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode())
            entity = data.get("entities", {}).get(f"Q{qid}", {})
            labels = entity.get("labels", {})
            desc = entity.get("descriptions", {})
            text = desc.get("en", {}).get("value", "")
            if not text:
                text = labels.get("en", {}).get("value", "")
            if text and len(text) > 20:
                results.append({"text": text, "region": "knowledge", "source": "wikidata", "strength": 1.0})
        return results
    except Exception as e:
        print(f"[harvest] Wikidata error: {e}")
        return []

# ── Queue & Ingest ───────────────────────────────────────────────────────

def queue_entries(entries, batch_name=None):
    if not entries:
        return 0
    if batch_name is None:
        batch_name = f"overnight_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{os.getpid()}.jsonl"
    path = os.path.join(QUEUE_DIR, batch_name)
    with open(path, "a", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    print(f"[queue] +{len(entries)} entries -> {batch_name}")
    return len(entries)

import re

def ingest_queued_files():
    """POST all queued JSONL files to KAI bulk-ingest API."""
    files = sorted(glob.glob(os.path.join(QUEUE_DIR, "*.jsonl")))
    if not files:
        return 0
    total = 0
    CHUNK = 1000
    stored_pat = re.compile(r"Stored (\d+) / (\d+) entries?")
    for path in files:
        try:
            with open(path, "r", encoding="utf-8") as f:
                lines = [json.loads(line) for line in f if line.strip()]
            if not lines:
                os.remove(path)
                continue
            file_total = 0
            # Chunk large files to avoid massive payloads
            for i in range(0, len(lines), CHUNK):
                chunk = lines[i:i + CHUNK]
                payload = json.dumps({"entries": chunk}).encode("utf-8")
                req = urllib.request.Request(KAI_API, data=payload, headers={"Content-Type": "application/json"}, method="POST")
                with urllib.request.urlopen(req, timeout=180) as resp:
                    body = resp.read().decode()
                m = stored_pat.search(body)
                if m:
                    file_total += int(m.group(1))
                else:
                    file_total += len(chunk)
            total += file_total
            # Move to ingested
            shutil.move(path, os.path.join(INGESTED_DIR, os.path.basename(path)))
            print(f"[ingest] {os.path.basename(path)} -> {file_total}/{len(lines)} cells ingested")
        except Exception as e:
            print(f"[ingest] FAILED {os.path.basename(path)}: {e}")
    return total

def check_governor():
    """Return True if we should pause (RAM >33 GB or CPU >90%)."""
    try:
        import psutil
        mem = psutil.virtual_memory()
        cpu = psutil.cpu_percent(interval=1)
        if mem.used > 33 * 1024**3 or cpu > 90:
            print(f"[governor] PAUSE — RAM {mem.used/(1024**3):.1f}GB, CPU {cpu:.0f}%")
            return True
    except ImportError:
        pass
    return False

def check_kai_alive():
    try:
        urllib.request.urlopen(STATUS_API, timeout=5)
        return True
    except:
        return False

# ── Main Loop ───────────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("KAI Overnight Pipeline")
    print("Harvest -> Queue -> Bulk-Ingest every 30 min")
    print(f"Queue: {QUEUE_DIR}")
    print("=" * 60)

    # Phase 1: Ingest existing queue
    print("\n[Phase 1] Ingesting existing queued files...")
    existing = ingest_queued_files()
    print(f"[Phase 1] Done — {existing} cells ingested from existing queue")

    # Phase 2: Continuous harvest + periodic ingest
    print("\n[Phase 2] Starting continuous harvest loop...")
    cycle = 0
    accumulated = []
    last_ingest = time.time()
    INGEST_INTERVAL = 30 * 60  # 30 minutes

    while True:
        cycle += 1
        print(f"\n[cycle {cycle}] {datetime.now().strftime('%H:%M:%S')}")

        if not check_kai_alive():
            print("[ERROR] KAI Oracle is down. Sleeping 60s...")
            time.sleep(60)
            continue

        if check_governor():
            time.sleep(60)
            continue

        # Harvest a small batch
        batch = []
        batch.extend(fetch_wikipedia(random.randint(30, 60)))
        batch.extend(fetch_wikidata(random.randint(10, 25)))
        accumulated.extend(batch)
        print(f"[harvest] Accumulated {len(accumulated)} entries this cycle")

        # Queue them to disk
        if batch:
            queue_entries(batch)

        # Bulk ingest every 30 minutes
        elapsed = time.time() - last_ingest
        if elapsed >= INGEST_INTERVAL:
            print(f"[ingest] 30-min interval reached. Ingesting queued files...")
            count = ingest_queued_files()
            print(f"[ingest] {count} cells added this round")
            accumulated = []
            last_ingest = time.time()

            # Also check KAI stats
            try:
                with urllib.request.urlopen(STATUS_API, timeout=5) as resp:
                    stats = json.loads(resp.read().decode())
                print(f"[status] Cells: {stats.get('lattice_size', '?')}, RAM: {stats.get('ram', '?')}")
            except:
                pass

        # Sleep before next harvest cycle
        sleep_time = random.randint(45, 90)
        print(f"[sleep] {sleep_time}s before next harvest...")
        time.sleep(sleep_time)

if __name__ == "__main__":
    main()
