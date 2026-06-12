import urllib.request, json, time, sys

sys.stdout.reconfigure(encoding='utf-8')
url = 'http://127.0.0.1:3334/api/oracle-turn'

def ask(text):
    print(f"\nUser: {text}")
    req = urllib.request.Request(url, data=json.dumps({'from': 'ryan', 'text': text}).encode(), headers={'Content-Type': 'application/json'})
    try:
        resp = urllib.request.urlopen(req, timeout=60)
        body = json.loads(resp.read())
        print(f"KAI: {body.get('text', body)}")
    except Exception as e:
        print(f"Error: {e}")

time.sleep(1)
ask("what is a noun?")
