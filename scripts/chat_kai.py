import urllib.request
import json
import sys

def chat(text):
    url = "http://127.0.0.1:3334/api/oracle-turn"
    payload = json.dumps({"from": "Antigravity", "text": text}).encode('utf-8')
    headers = {"Content-Type": "application/json"}
    try:
        req = urllib.request.Request(url, data=payload, headers=headers)
        response = urllib.request.urlopen(req, timeout=30)
        data = json.loads(response.read().decode('utf-8'))
        print(f"KAI: {data.get('reply', data)}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    chat(" ".join(sys.argv[1:]))
