import urllib.request, json, sys, time

BASE = "http://127.0.0.1:3334"

TURNS = [
    ("ryan", "hey KAI, you awake?"),
    ("ryan", "what is a noun?"),
    ("ryan", "if you were a fruit, what kind of fruit would you be and why?")
]

print("Starting oddball conversation with KAI...\n", flush=True)

for sender, text in TURNS:
    print(f"[{sender}]: {text}", flush=True)
    try:
        req = urllib.request.Request(
            f"{BASE}/api/oracle-turn",
            data=json.dumps({"from": sender, "text": text}).encode(),
            headers={"Content-Type": "application/json"}
        )
        resp = urllib.request.urlopen(req, timeout=120)
        body = resp.read().decode('utf-8', errors='replace')
        data = json.loads(body)
        reply = data.get("reply", data)
        print(f"[KAI]: {reply}\n", flush=True)
    except Exception as e:
        print(f"[KAI]: ERROR - {e}\n", flush=True)
    time.sleep(1.0)

print("--- Conversation complete ---", flush=True)
