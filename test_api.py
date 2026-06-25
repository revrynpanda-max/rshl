import os
import requests
import json

def check_url(url):
    try:
        r = requests.head(url, timeout=5)
        print(f"URL: {url} -> Status: {r.status_code}")
    except Exception as e:
        print(f"URL: {url} -> Error: {e}")

# Let's see if we can get a Poly Haven material
poly_url = "https://api.polyhaven.com/files/aerial_rocks_02"
r = requests.get(poly_url)
if r.status_code == 200:
    data = r.json()
    print("Poly Haven test successful.")
else:
    print("Poly Haven test failed.")
