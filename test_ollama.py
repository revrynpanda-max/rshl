import urllib.request
import json

data = {
    "model": "gemma4",
    "prompt": "Hello",
    "stream": False
}

req = urllib.request.Request(
    'http://127.0.0.1:11434/api/generate',
    data=json.dumps(data).encode(),
    headers={'Content-Type': 'application/json'}
)

try:
    resp = urllib.request.urlopen(req, timeout=10).read()
    print("SUCCESS:", json.loads(resp))
except Exception as e:
    print("ERROR:", str(e))
