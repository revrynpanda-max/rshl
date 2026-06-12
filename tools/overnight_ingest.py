import urllib.request, json, time, random, urllib.parse, sys
sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://127.0.0.1:3334"

def fetch_random_topic():
    try:
        url = "https://en.wikipedia.org/w/api.php?action=query&list=random&rnnamespace=0&rnlimit=1&format=json"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode())
            return data['query']['random'][0]['title']
    except Exception as e:
        print(f"Random topic fetch failed: {e}")
        return "Consciousness" # fallback

def fetch_wiki(topic):
    try:
        url = f"https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&titles={urllib.parse.quote(topic)}"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode())
            pages = data['query']['pages']
            for page_id in pages:
                if page_id != "-1":
                    return pages[page_id].get('extract', '')
    except Exception as e:
        print(f"Wiki fetch failed for {topic}: {e}")
    return ""

print("--- Starting Dynamic Deep Lattice Ingestion ---")
print("Focus: Continuous discovery of new concepts and weaving them into dialogue.")
print("Script will terminate automatically after 3 hours.")

END_TIME = time.time() + (3.0 * 3600) # 3 hours from now
import os
def adaptive_sleep():
    try:
        path = 'c:/KAI/tools/oracle-discord/state/self_optimize_state.json'
        if os.path.exists(path):
            with open(path, 'r') as f:
                state = json.load(f)
                tier = state.get('tier', 'NORMAL')
                if tier == 'PROTECT':
                    time.sleep(15)
                elif tier == 'REDUCED':
                    time.sleep(6)
                else:
                    time.sleep(1)
        else:
            time.sleep(1)
    except:
        time.sleep(1)

count = 0
while time.time() < END_TIME:
    adaptive_sleep()
    topic = fetch_random_topic()
    print(f"\n[{count}] Discovered new concept: {topic}")
    
    # 1. Fetch raw facts about the topic and inject it directly as physical knowledge
    wiki_text = fetch_wiki(topic)
    if wiki_text and len(wiki_text) > 50:
        print(f"[{count}] Injecting raw factual data...")
        sentences = wiki_text.split('.')
        for s in sentences[:10]: # Max 10 sentences to keep it diverse
            s = s.strip()
            if len(s) > 20:
                try:
                    req = urllib.request.Request(
                        f"{BASE}/api/store",
                        data=json.dumps({"text": s, "region": "everyday", "source": "knowledge"}).encode(),
                        headers={"Content-Type": "application/json"}
                    )
                    urllib.request.urlopen(req, timeout=10)
                except:
                    pass
    
    # 2. Ask KAI to weave this new knowledge into his dialogue
    print(f"[{count}] Weaving concept '{topic}' into generative conversation...")
    prompt = f"What are your thoughts on {topic}?"
    try:
        req = urllib.request.Request(
            f"{BASE}/api/oracle-turn",
            data=json.dumps({"from": "conversation", "text": prompt}).encode(),
            headers={"Content-Type": "application/json"}
        )
        urllib.request.urlopen(req, timeout=30)
    except:
        pass
    
    count += 1
    
    # Save every 20 loops
    if count > 0 and count % 20 == 0:
        print(f"[{count}] Saving lattice state...")
        try:
            req = urllib.request.Request(f"{BASE}/api/lattice/compact-save", method="POST")
            urllib.request.urlopen(req, timeout=30)
        except Exception as e:
            print(f"Save failed: {e}")

print("\n--- Time Limit Reached (Approaching 11:00 AM) ---")
print("Flushing final state to disk...")
try:
    req = urllib.request.Request(f"{BASE}/api/lattice/compact-save", method="POST")
    urllib.request.urlopen(req, timeout=30)
except:
    pass
print("Ingestion gracefully complete.")
