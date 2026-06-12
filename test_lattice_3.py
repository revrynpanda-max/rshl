import urllib.request, json
req = urllib.request.Request('http://127.0.0.1:3334/api/rshl/query', data=b'{"query": "hey kai", "limit": 20}', headers={'Content-Type': 'application/json'})
res = urllib.request.urlopen(req)
data = json.loads(res.read())
for d in data:
    if d.get('region') in ['tutoring', 'language'] or d.get('source') == 'oracle_qa':
        print(f"FOUND MATCH!")
        print(f"LABEL: {d.get('label')}")
        print(f"TEXT: {d.get('text')}")
        print(f"REGION: {d.get('region')}")
        print(f"SCORE: {d.get('score')}")
        print(f"SOURCE: {d.get('source')}")
        print("-----")
