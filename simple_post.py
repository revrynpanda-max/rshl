import urllib.request
import json
url = 'http://127.0.0.1:3334/api/oracle-turn'
payload = json.dumps({'from': 'Antigravity', 'text': 'run command echo hello kai', 'async_mode': True}).encode('utf-8')
headers = {'Content-Type': 'application/json'}
req = urllib.request.Request(url, data=payload, headers=headers)
try:
    response = urllib.request.urlopen(req, timeout=10)
    print(response.read().decode('utf-8'))
except Exception as e:
    print('Error:', e)
