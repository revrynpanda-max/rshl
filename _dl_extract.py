import urllib.request, zipfile, io, os, shutil

url = 'https://kenney.nl/media/pages/assets/space-kit/20874c75ac-1677698978/kenney_space-kit.zip'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
print('Downloading Space Kit...')
response = urllib.request.urlopen(req)
z = zipfile.ZipFile(io.BytesIO(response.read()))

rocks_dir = r'C:\KAI\models\rocks'
ship_dir = r'C:\KAI\models\ship'
os.makedirs(rocks_dir, exist_ok=True)
os.makedirs(ship_dir, exist_ok=True)

glbs = [f for f in z.namelist() if f.endswith('.glb')]
rocks = [f for f in glbs if 'meteor' in f.lower() or 'rock' in f.lower() or 'asteroid' in f.lower()]
ships = [f for f in glbs if 'craft' in f.lower() or 'ship' in f.lower()]

print('Found rocks:', rocks)
print('Found ships:', ships)

# Extract 4 rocks
for r in rocks[:4]:
    basename = os.path.basename(r)
    with open(os.path.join(rocks_dir, basename), 'wb') as out_f:
        out_f.write(z.read(r))
    print(f'Saved {basename}')

# Extract 1 ship
if ships:
    ship = ships[0]
    with open(os.path.join(ship_dir, 'player-ship.glb'), 'wb') as out_f:
        out_f.write(z.read(ship))
    print(f'Saved player-ship.glb')

