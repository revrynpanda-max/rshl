import os
import requests
from io import BytesIO
from PIL import Image, ImageFilter

os.makedirs('C:/KAI/textures', exist_ok=True)

BASE_URL = "https://www.solarsystemscope.com/textures/download/"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
    "Referer": "https://www.solarsystemscope.com/textures/"
}

def download_img(filename):
    print(f"Downloading {filename}...")
    r = requests.get(BASE_URL + filename, headers=HEADERS, timeout=120)
    r.raise_for_status()
    return Image.open(BytesIO(r.content)).convert('RGB')

def generate_normal_from_color(img):
    """Generate a tangent-space normal map from a color image via luminance gradient."""
    gray = img.convert('L')
    # Sobel-like kernels for X and Y gradients
    kernel_x = ImageFilter.Kernel((3, 3), [-1, 0, 1, -2, 0, 2, -1, 0, 1], scale=1, offset=128)
    kernel_y = ImageFilter.Kernel((3, 3), [-1, -2, -1, 0, 0, 0, 1, 2, 1], scale=1, offset=128)
    gx = gray.filter(kernel_x)
    gy = gray.filter(kernel_y)
    b = Image.new('L', img.size, 255)
    normal = Image.merge('RGB', (gx, gy, b))
    return normal

def create_clouds(img, tint=(255, 255, 255)):
    """Create an alpha-transparent cloud PNG from a white-on-black cloud map."""
    gray = img.convert('L')
    color = Image.new('RGB', img.size, tint)
    clouds = color.copy()
    clouds.putalpha(gray)
    return clouds

# Mapping: AI name -> (source_color, source_normal_or_None, source_clouds_or_None, cloud_tint)
# We download 8k where available, fall back to 2k
PLANET_MAP = {
    "default":    ("8k_earth_daymap.jpg",    "8k_earth_normal_map.tif", "8k_earth_clouds.jpg",    (255,255,255)),
    "kai":        ("8k_jupiter.jpg",         None,                      None,                     None),
    "leo":        ("8k_mars.jpg",            None,                      "8k_earth_clouds.jpg",    (255,255,255)),
    "gemini":     ("2k_venus_surface.jpg",   None,                      "2k_venus_atmosphere.jpg",(255,240,200)),
    "claudey":    ("2k_neptune.jpg",         None,                      "8k_earth_clouds.jpg",    (255,255,255)),
    "x":          ("8k_moon.jpg",            None,                      None,                     None),
    "groq":       ("2k_uranus.jpg",          None,                      "8k_earth_clouds.jpg",    (255,255,255)),
    "analyst":    ("8k_mercury.jpg",         None,                      None,                     None),
    "researcher": ("2k_makemake_fictional.jpg", None,                   None,                     None),
    "kaicoder":   ("2k_ceres_fictional.jpg", None,                      "8k_earth_clouds.jpg",    (255,255,255)),
}

# Cache downloaded source images to avoid re-downloading shared ones (e.g. earth clouds)
src_cache = {}

def get_src(filename):
    if filename not in src_cache:
        src_cache[filename] = download_img(filename)
    return src_cache[filename]

for name, (color_src, normal_src, cloud_src, cloud_tint) in PLANET_MAP.items():
    print(f"\n=== Processing {name} ===")
    
    # COLOR - save at 4096x2048 (good balance of quality vs file size)
    color = get_src(color_src)
    color_out = color.resize((4096, 2048), Image.Resampling.LANCZOS)
    color_out.save(f"C:/KAI/textures/{name}.jpg", quality=85)
    fsize = os.path.getsize(f"C:/KAI/textures/{name}.jpg")
    print(f"  Color: {color_out.size} -> {fsize/1024:.0f} KB")
    
    # NORMAL - generate from color if no dedicated source, save at 2048x1024
    if normal_src:
        try:
            norm_img = get_src(normal_src)
        except:
            print(f"  Normal source {normal_src} failed, generating from color")
            norm_img = generate_normal_from_color(color)
    else:
        norm_img = generate_normal_from_color(color)
    
    norm_out = norm_img.resize((2048, 1024), Image.Resampling.LANCZOS)
    norm_out.save(f"C:/KAI/textures/{name}_normal.jpg", quality=85)
    fsize = os.path.getsize(f"C:/KAI/textures/{name}_normal.jpg")
    print(f"  Normal: {norm_out.size} -> {fsize/1024:.0f} KB")
    
    # CLOUDS - alpha PNG at 1024x512
    if cloud_src and cloud_tint:
        cloud_img = get_src(cloud_src)
        clouds = create_clouds(cloud_img, cloud_tint)
        clouds_out = clouds.resize((1024, 512), Image.Resampling.LANCZOS)
        clouds_out.save(f"C:/KAI/textures/{name}_clouds.png", optimize=True)
        fsize = os.path.getsize(f"C:/KAI/textures/{name}_clouds.png")
        print(f"  Clouds: {clouds_out.size} -> {fsize/1024:.0f} KB")

# Update CREDITS
CREDITS = """KAIVERSE Planet Textures
========================
Source: Solar System Scope (https://www.solarsystemscope.com/textures/)
License: CC BY 4.0 (Attribution 4.0 International)
Attribution: "Solar Textures by Solar System Scope" - https://www.solarsystemscope.com

Textures based on NASA elevation and imagery data.
Colors tuned according to true-color photos from Messenger, Viking, Cassini, and Hubble.

Planet Assignments:
  default  → Earth (day map + normal + clouds)
  kai      → Jupiter (gas giant bands)
  leo      → Mars (red rocky surface)
  gemini   → Venus (surface radar map)
  claudey  → Neptune (deep blue gas giant)
  x        → Moon (cratered rocky surface)
  groq     → Uranus (cyan gas giant)
  analyst  → Mercury (heavily cratered)
  researcher → Makemake (fictional icy dwarf)
  kaicoder → Ceres (fictional dwarf planet)
"""
with open('C:/KAI/textures/CREDITS.txt', 'w') as f:
    f.write(CREDITS)

print("\n✅ All textures processed and saved.")
print(f"Total files: {len(os.listdir('C:/KAI/textures'))}")
total_size = sum(os.path.getsize(os.path.join('C:/KAI/textures', f)) for f in os.listdir('C:/KAI/textures'))
print(f"Total size: {total_size/1024/1024:.1f} MB")
