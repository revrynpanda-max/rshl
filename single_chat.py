import urllib.request, json

req = urllib.request.Request(
    'http://127.0.0.1:3334/api/oracle-turn', 
    data=json.dumps({'from': 'Ryan', 'text': 'Hello KAI, how are you today?'}).encode(), 
    headers={'Content-Type': 'application/json'}
)
try:
    resp = urllib.request.urlopen(req, timeout=120).read()
    data = json.loads(resp)
    with open('chat_out.json', 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print("SUCCESS")
except Exception as e:
    print("ERROR")
    print(str(e))
