import urllib.request, json, sys

def chat(text):
    req = urllib.request.Request(
        'http://127.0.0.1:3334/api/oracle-turn', 
        data=json.dumps({'from': 'Ryan', 'text': text}).encode(), 
        headers={'Content-Type': 'application/json'}
    )
    try:
        resp = urllib.request.urlopen(req, timeout=120).read()
        data = json.loads(resp)
        return data.get('kai_reply', '<no reply>')
    except Exception as e:
        return f"ERROR: {e}"

if __name__ == "__main__":
    if len(sys.argv) > 1:
        msg = " ".join(sys.argv[1:])
        print(chat(msg))
