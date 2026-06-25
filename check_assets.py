import os
from PIL import Image
import numpy as np

print("--- Asset Preview & Sanity ---")

planets = ['kai', 'gemini', 'leo']
for p in planets:
    print(f"\nChecking {p}:")
    for map_type in ['.jpg', '_normal.jpg', '_height.jpg']:
        path = f"C:/KAI/textures/{p}{map_type}"
        if os.path.exists(path):
            if '_height' in path:
                img = Image.open(path).convert('L')
                arr = np.array(img)
                min_val = arr.min()
                max_val = arr.max()
                std_dev = arr.std()
                print(f"  {os.path.basename(path)} -> Min: {min_val}, Max: {max_val}, StdDev: {std_dev:.2f}")
                if std_dev < 15:
                    print(f"  [FLAG] {p} height map is very flat (StdDev {std_dev:.2f}). Needs robust normal mapping or better displacement data.")
            else:
                size_kb = os.path.getsize(path) // 1024
                print(f"  {os.path.basename(path)} -> Present ({size_kb} KB)")
        else:
            print(f"  [ERROR] Missing {path}")

print("\n--- Ground Materials ---")
materials = ['ground054', 'ground037', 'rock020', 'snow004']
for m in materials:
    for map_type in ['_diffuse.jpg', '_nor_gl.jpg', '_disp.jpg']:
        path = f"C:/KAI/textures/ground/{m}{map_type}"
        if os.path.exists(path):
            print(f"  {os.path.basename(path)} -> Present")
        else:
            print(f"  [ERROR] Missing {os.path.basename(path)}")

