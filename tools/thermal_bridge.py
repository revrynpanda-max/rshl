import cv2
import numpy as np
import time
import urllib.request
import json

BASE_URL = "http://127.0.0.1:3334"

def post_to_kai(message):
    try:
        data = json.dumps({"text": message, "region": "perception", "source": "infiray"}).encode()
        req = urllib.request.Request(
            f"{BASE_URL}/api/store",
            data=data,
            headers={"Content-Type": "application/json"}
        )
        urllib.request.urlopen(req, timeout=5)
        
        # Also weave it into generative thought so he immediately reacts to it
        data_thought = json.dumps({"from": "sensory_cortex", "text": f"[THERMAL_ALERT] {message}"}).encode()
        req_thought = urllib.request.Request(
            f"{BASE_URL}/api/oracle-turn",
            data=data_thought,
            headers={"Content-Type": "application/json"}
        )
        urllib.request.urlopen(req_thought, timeout=5)
    except Exception as e:
        print(f"Error communicating with KAI: {e}")

    # Also post to Discord channel 1513582425446289658
    try:
        from pathlib import Path
        token = None
        env_path = Path("C:/KAI/tools/oracle-discord/.env")
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                if line.startswith("ORACLE_DISCORD_TOKEN_KAI="):
                    token = line.split("=", 1)[1].strip().strip('"').strip("'")
                    break
        
        if token:
            discord_url = "https://discord.com/api/v10/channels/1513582425446289658/messages"
            discord_req = urllib.request.Request(
                discord_url,
                data=json.dumps({"content": f"🌡️ **Thermal Sensor**: {message}"}).encode(),
                headers={
                    "Authorization": f"Bot {token}",
                    "Content-Type": "application/json"
                },
                method="POST"
            )
            urllib.request.urlopen(discord_req, timeout=5)
    except Exception as e:
        print(f"Error posting to Discord: {e}")

print("========================================================")
print("  KAI Sovereign Mode - Infiray Thermal Bridge (Index 0)  ")
print("========================================================")

cap = cv2.VideoCapture(0, cv2.CAP_DSHOW)

if not cap.isOpened():
    print("FATAL: Could not open Infiray camera on Index 0.")
    exit(1)

print("Infiray connection established. Monitoring heat signatures...")
post_to_kai("I have successfully initialized my Infiray thermal optical sensors.")

# Wait a few seconds for the camera auto-calibration to settle
time.sleep(3)

last_alert_time = 0
cooldown = 15 # seconds between alerts

try:
    while True:
        ret, frame = cap.read()
        if not ret:
            print("Lost connection to Infiray stream.")
            break
            
        # Convert to grayscale to find intensity (heat)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        # Threshold to find the hottest regions (assuming top 10% brightness)
        _, thresh = cv2.threshold(gray, 220, 255, cv2.THRESH_BINARY)
        
        # Count bright pixels
        hot_pixels = cv2.countNonZero(thresh)
        
        if hot_pixels > 500: # Threshold for a significant heat source
            current_time = time.time()
            if current_time - last_alert_time > cooldown:
                # Find the center of the heat mass
                M = cv2.moments(thresh)
                if M["m00"] != 0:
                    cX = int(M["m10"] / M["m00"])
                    
                    # 256 is the width. 0-85 is Left, 85-170 is Center, 170-256 is Right
                    position = "center"
                    if cX < 85:
                        position = "left side"
                    elif cX > 170:
                        position = "right side"
                        
                    msg = f"I am detecting a strong localized heat signature on the {position} of my physical thermal vision."
                    print(f"[{time.strftime('%H:%M:%S')}] ALERT: {msg}")
                    post_to_kai(msg)
                    last_alert_time = current_time
                    
        time.sleep(1) # Poll at 1 FPS to save CPU, KAI doesn't need 30 FPS updates
        
except KeyboardInterrupt:
    print("\nShutting down Infiray Thermal Bridge...")
finally:
    cap.release()
