import os
import requests
import json
from io import BytesIO
from PIL import Image, ImageFilter

# 1. Setup Directories
os.makedirs('C:/KAI/textures/ground', exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
}

# --- PLANETARY ASSETS ---
print("--- Phase 1: Planetary Assets ---")

# We use the existing Color and Normal maps in C:/KAI/textures to generate perfectly aligned Height maps.
# The user's main complaint was "bump maps don't line up with the photo".
# By deriving the height map directly from the color/normal maps we ALREADY downloaded,
# we guarantee 100% perfect alignment. Canyons in the color map will exactly match the displacement canyons.

planets = ['default', 'kai', 'leo', 'gemini', 'claudey', 'x', 'groq', 'analyst', 'researcher', 'kaicoder']

def generate_height_map(color_path, out_path, is_gas_giant):
    if not os.path.exists(color_path):
        print(f"Skipping {color_path}, not found.")
        return
    
    img = Image.open(color_path).convert('L')
    
    if is_gas_giant:
        # Gas giants don't have sharp terrain, just soft cloud bands
        img = img.filter(ImageFilter.GaussianBlur(10))
        # Low contrast
        img = img.point(lambda p: 128 + (p - 128) * 0.3)
    else:
        # Rocky planets: darker areas (craters/canyons) should be lower.
        # We can enhance the contrast to make craters deeper.
        img = img.point(lambda p: max(0, min(255, (p - 128) * 1.5 + 128)))
        # Slight blur to avoid jagged displacement spikes
        img = img.filter(ImageFilter.GaussianBlur(2))
    
    img.save(out_path, quality=85)
    size_kb = os.path.getsize(out_path) // 1024
    print(f"Generated {os.path.basename(out_path)} ({size_kb} KB)")

gas_giants = ['kai', 'claudey', 'groq']

for p in planets:
    color_file = f"C:/KAI/textures/{p}.jpg"
    height_file = f"C:/KAI/textures/{p}_height.jpg"
    if not os.path.exists(height_file):
        generate_height_map(color_file, height_file, p in gas_giants)
    else:
        print(f"{p}_height.jpg already exists.")

# --- GROUND MATERIALS (POLY HAVEN) ---
print("\n--- Phase 2: Ground Materials ---")

# A list of good ground materials for walking surfaces
materials = [
    "aerial_rocks_02",    # Rocky / Moon / Asteroid
    "coast_sand_rocks_02",# Sand / Desert / Mars
    "cracked_concrete_wall", # Cracked / Dry / Wasteland
    "snow_02"             # Ice / Snow
]

def download_polyhaven(mat_id, res="1k"):
    print(f"Fetching {mat_id} at {res}...")
    # Get file list from API
    api_url = f"https://api.polyhaven.com/files/{mat_id}"
    r = requests.get(api_url)
    if r.status_code != 200:
        print(f"Failed to fetch metadata for {mat_id}")
        return
    
    data = r.json()
    files = data.get('blend', {}).get(res, {}).get('gltf', {})
    
    # Actually, the textures are inside 'textures' dict usually, but the API changed.
    # Let's pull directly from the raw texture endpoints or parse carefully.
    # If the standard API is tricky to parse for raw textures, we can use ambientCG or known URLs.
    # Fortunately, PolyHaven provides direct links in the JSON under "textures" (if we request it properly)
    pass

# We will use direct known links to ensure reliability, or ambientCG's API which provides zip files.
# Let's use ambientCG API to get zips.

def download_ambientcg(asset_id, res="1K"):
    print(f"Downloading ambientCG: {asset_id} at {res}...")
    zip_url = f"https://ambientcg.com/get?file={asset_id}_{res}-JPG.zip"
    r = requests.get(zip_url, headers=HEADERS, stream=True)
    if r.status_code == 200:
        import zipfile
        zip_path = f"C:/KAI/textures/ground/{asset_id}.zip"
        with open(zip_path, 'wb') as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
                
        # Extract specific maps (Color, NormalGL, Displacement)
        with zipfile.ZipFile(zip_path, 'r') as z:
            for file in z.namelist():
                if "Color.jpg" in file or "NormalGL.jpg" in file or "Displacement.jpg" in file:
                    z.extract(file, "C:/KAI/textures/ground/")
                    # Rename to a simpler format
                    new_name = f"{asset_id}_{file.split('_')[-1]}"
                    new_name = new_name.replace("Color", "diffuse").replace("NormalGL", "nor_gl").replace("Displacement", "disp")
                    os.rename(f"C:/KAI/textures/ground/{file}", f"C:/KAI/textures/ground/{new_name.lower()}")
        os.remove(zip_path)
        print(f"Extracted {asset_id} successfully.")
    else:
        print(f"Failed to download {asset_id}")

ambient_materials = [
    "Ground054", # Rocky ground
    "Ground037", # Sand / Mars
    "Rock020",   # Lava / Dark rock
    "Snow004"    # Ice / Snow
]

for mat in ambient_materials:
    # check if already exists
    if not os.path.exists(f"C:/KAI/textures/ground/{mat.lower()}_diffuse.jpg"):
        download_ambientcg(mat)
    else:
        print(f"{mat} already downloaded.")

print("\n✅ All matched assets and ground materials processed.")
