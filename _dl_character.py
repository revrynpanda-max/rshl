import urllib.request, zipfile, io, os
url = 'https://kenney.nl/media/pages/assets/space-kit/20874c75ac-1677698978/kenney_space-kit.zip'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
response = urllib.request.urlopen(req)
z = zipfile.ZipFile(io.BytesIO(response.read()))

char_dir = r'C:\KAI\models\character'
os.makedirs(char_dir, exist_ok=True)
with open(os.path.join(char_dir, 'astronaut.glb'), 'wb') as out_f:
    out_f.write(z.read('Models/GLTF format/astronautA.glb'))

ship_dir = r'C:\KAI\models\ship'
with open(os.path.join(ship_dir, 'player-ship.glb'), 'wb') as out_f:
    out_f.write(z.read('Models/GLTF format/craft_speederD.glb'))

print('Saved astronaut.glb and updated player-ship.glb')
