import urllib.request, re
req = urllib.request.Request('https://kenney.nl/assets/space-kit', headers={'User-Agent': 'Mozilla/5.0'})
try:
    html = urllib.request.urlopen(req).read().decode()
    matches = re.findall(r'href=[\'\"].*?\.zip[\'\"]', html)
    print(matches)
except Exception as e:
    print(e)
