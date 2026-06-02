import urllib.request
import json
import time
import sys

URL = "http://127.0.0.1:3334/api/oracle-turn"

def send_message(text):
    payload = json.dumps({"from": "user", "text": text}).encode('utf-8')
    req = urllib.request.Request(URL, data=payload, headers={'Content-Type': 'application/json'}, method='POST')
    try:
        # Long timeout for the first query because it triggers an index rebuild
        with urllib.request.urlopen(req, timeout=300) as response:
            if response.status == 200:
                data = json.loads(response.read().decode('utf-8'))
                return data.get('response', '')
            else:
                return f"Error: {response.status}"
    except Exception as e:
        return f"Exception: {e}"

if __name__ == "__main__":
    print("Testing what Kai sounds like right now...", flush=True)
    msg = "Hello Kai, how are you?"
    print(f"\nUser: {msg}", flush=True)
    reply = send_message(msg)
    print(f"Kai: {reply}", flush=True)

    msg = "Tell me about yourself."
    print(f"\nUser: {msg}", flush=True)
    reply = send_message(msg)
    print(f"Kai: {reply}", flush=True)
