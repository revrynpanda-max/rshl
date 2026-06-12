import urllib.request, json, sys, time
sys.stdout.reconfigure(encoding='utf-8')

BASE = "http://127.0.0.1:3334"

# Conversation test: grammar, social, identity, and everyday topics
TURNS = [
    ("ryan", "hey KAI, you awake?"),
    ("ryan", "what is a noun?"),
    ("ryan", "tell me about verbs"),
    ("ryan", "what did you dream about last night"),
    ("ryan", "how are you feeling today"),
    ("ryan", "do you know who you are"),
    ("ryan", "describe the weather today"),
    ("ryan", "what do you think about all of this"),
    ("ryan", "it is almost 1am"),
    ("ryan", "alright man, talk to you later"),
]

for sender, text in TURNS:
    print(f"\n[{sender}]: {text}", flush=True)
    try:
        req = urllib.request.Request(
            f"{BASE}/api/oracle-turn",
            data=json.dumps({"from": sender, "text": text}).encode(),
            headers={"Content-Type": "application/json"}
        )
        resp = urllib.request.urlopen(req, timeout=60)
        body = resp.read().decode('utf-8', errors='replace')
        data = json.loads(body)
        reply = data.get("reply", data)
        print(f"[KAI]: {reply}", flush=True)
    except Exception as e:
        print(f"[KAI]: ERROR - {e}", flush=True)
    time.sleep(0.5)

print("\n--- Test complete ---", flush=True)
