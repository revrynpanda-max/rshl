import urllib.request, json
req = urllib.request.Request('http://127.0.0.1:3334/api/rshl/query', data=b'{"query": "hey kai", "limit": 3}', headers={'Content-Type': 'application/json'})
res = urllib.request.urlopen(req)
data = json.loads(res.read())
for d in data:
    print(f"LABEL: {d.get('label')}")
    print(f"TEXT: {d.get('text')}")
    print("-----")
