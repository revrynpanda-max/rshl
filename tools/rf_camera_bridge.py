#!/usr/bin/env python3
"""
rf_camera_bridge.py — RF/Thermal Camera Vision for KAI

Captures frames from the RF/Thermal camera (Camera 0, 192x256) and analyzes
them for thermal signatures, RF hotspots, and depth perception.

Features:
  - Continuous frame capture (configurable interval)
  - Thermal hotspot detection (cold -> hot gradient)
  - Motion detection between frames
  - Frame storage and comparison
  - Cross-reference with TinySA spectrum data
  - Discord posting for KAI's "RF Vision" mode
  - KAI memory storage for autonomous awareness

Usage:
    python rf_camera_bridge.py --headless
    python rf_camera_bridge.py --capture-interval 5 --discord-channel 1513582425446289658
"""

import cv2
import numpy as np
import time
import json
import os
import urllib.request
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Tuple, Optional

# ── Configuration ──────────────────────────────────────────────────────────
KAI_STORE_URL = "http://127.0.0.1:3334/api/rshl/store"
KAI_BULK_URL = "http://127.0.0.1:3334/api/bulk-ingest"
DISCORD_API_BASE = "https://discord.com/api/v10"
DISCORD_CHANNEL_ID = "1513582425446289658"

RF_CAMERA_INDEX = 0  # 192x256 thermal/RF camera
VISUAL_CAMERA_INDEX = 1  # 1280x720 normal webcam

FRAME_STORAGE_DIR = Path("C:/KAI/logs/rf_camera")
FRAME_STORAGE_DIR.mkdir(parents=True, exist_ok=True)

# ── Thermal Analysis ─────────────────────────────────────────────────────

def analyze_thermal_frame(frame: np.ndarray) -> Dict:
    """
    Analyze a thermal/RF frame for temperature signatures.
    
    Returns:
        {
            "mean_temp": float,      # Normalized 0-1
            "hotspot_count": int,
            "hotspots": [            # List of hotspot regions
                {"x": int, "y": int, "w": int, "h": int, "intensity": float}
            ],
            "coldspot_count": int,
            "frame_entropy": float,  # Randomness of pixel distribution
            "motion_score": float,   # Difference from previous frame
        }
    """
    # Convert to grayscale for thermal analysis
    if len(frame.shape) == 3:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    else:
        gray = frame
    
    # Normalize to 0-1
    normalized = gray.astype(np.float32) / 255.0
    
    # Mean temperature
    mean_temp = float(np.mean(normalized))
    
    # Detect hotspots (bright regions = hot)
    _, hot_thresh = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY)
    hot_contours, _ = cv2.findContours(hot_thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    hotspots = []
    for cnt in hot_contours:
        if cv2.contourArea(cnt) > 20:  # Filter small noise
            x, y, w, h = cv2.boundingRect(cnt)
            roi = normalized[y:y+h, x:x+w]
            intensity = float(np.mean(roi))
            hotspots.append({
                "x": int(x), "y": int(y),
                "w": int(w), "h": int(h),
                "intensity": round(intensity, 3)
            })
    
    # Detect cold spots (dark regions)
    _, cold_thresh = cv2.threshold(gray, 50, 255, cv2.THRESH_BINARY_INV)
    cold_contours, _ = cv2.findContours(cold_thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    coldspots = []
    for cnt in cold_contours:
        if cv2.contourArea(cnt) > 20:
            x, y, w, h = cv2.boundingRect(cnt)
            roi = normalized[y:y+h, x:x+w]
            intensity = float(np.mean(roi))
            coldspots.append({
                "x": int(x), "y": int(y),
                "w": int(w), "h": int(h),
                "intensity": round(intensity, 3)
            })
    
    # Frame entropy (measure of information/randomness)
    hist = cv2.calcHist([gray], [0], None, [256], [0, 256])
    hist = hist.flatten() / hist.sum()
    hist = hist[hist > 0]
    entropy = -np.sum(hist * np.log2(hist))
    
    return {
        "mean_temp": round(mean_temp, 3),
        "hotspot_count": len(hotspots),
        "hotspots": hotspots,
        "coldspot_count": len(coldspots),
        "coldspots": coldspots,
        "frame_entropy": round(float(entropy), 2),
        "motion_score": 0.0  # Filled in later
    }

def detect_motion(current_frame: np.ndarray, previous_frame: np.ndarray) -> float:
    """Detect motion between two frames. Returns 0-1 score."""
    if previous_frame is None:
        return 0.0
    
    if len(current_frame.shape) == 3:
        curr_gray = cv2.cvtColor(current_frame, cv2.COLOR_BGR2GRAY)
    else:
        curr_gray = current_frame
    
    if len(previous_frame.shape) == 3:
        prev_gray = cv2.cvtColor(previous_frame, cv2.COLOR_BGR2GRAY)
    else:
        prev_gray = previous_frame
    
    # Resize to match
    if curr_gray.shape != prev_gray.shape:
        prev_gray = cv2.resize(prev_gray, (curr_gray.shape[1], curr_gray.shape[0]))
    
    # Calculate frame difference
    diff = cv2.absdiff(curr_gray, prev_gray)
    motion_score = float(np.mean(diff)) / 255.0
    
    return round(motion_score, 3)

# ── Discord Posting ───────────────────────────────────────────────────────

def get_discord_token() -> str:
    return os.environ.get("ORACLE_DISCORD_TOKEN_KAI", "")

def post_discord_message(channel_id: str, content: str, token: str) -> bool:
    if not token:
        return False
    
    url = f"{DISCORD_API_BASE}/channels/{channel_id}/messages"
    headers = {
        "Authorization": f"Bot {token}",
        "Content-Type": "application/json"
    }
    payload = {"content": content}
    
    try:
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode(),
            headers=headers, method="POST"
        )
        resp = urllib.request.urlopen(req, timeout=10)
        return resp.status == 200
    except:
        return False

def post_discord_embed(channel_id: str, embed: Dict, token: str) -> bool:
    if not token:
        return False
    
    url = f"{DISCORD_API_BASE}/channels/{channel_id}/messages"
    headers = {
        "Authorization": f"Bot {token}",
        "Content-Type": "application/json"
    }
    payload = {"embeds": [embed]}
    
    try:
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode(),
            headers=headers, method="POST"
        )
        resp = urllib.request.urlopen(req, timeout=10)
        return resp.status == 200
    except:
        return False

# ── KAI Memory ──────────────────────────────────────────────────────────

def store_in_kai_memory(text: str, region: str = "sensory_rf_cortex", 
                         source: str = "rf_camera", strength: float = 0.5):
    try:
        req = urllib.request.Request(
            KAI_STORE_URL,
            data=json.dumps({
                "text": text,
                "region": region,
                "source": source,
                "strength": strength
            }).encode(),
            headers={"Content-Type": "application/json"}
        )
        resp = urllib.request.urlopen(req, timeout=5)
        return resp.status == 200
    except:
        return False

# ── Main Bridge ───────────────────────────────────────────────────────────

class RFCameraBridge:
    """RF/Thermal camera bridge for KAI."""
    
    def __init__(self, camera_index: int = RF_CAMERA_INDEX, 
                 capture_interval: float = 5.0,
                 discord_channel: str = DISCORD_CHANNEL_ID):
        self.camera_index = camera_index
        self.capture_interval = capture_interval
        self.discord_channel = discord_channel
        self.discord_token = get_discord_token()
        self.cap = None
        self.prev_frame = None
        self.running = False
        
    def start(self):
        """Start the camera bridge."""
        print("[*] Starting RF Camera Bridge...")
        
        self.cap = cv2.VideoCapture(self.camera_index, cv2.CAP_DSHOW)
        if not self.cap.isOpened():
            print(f"[!] Cannot open camera {self.camera_index}")
            return False
        
        # Read first frame to get dimensions
        ret, frame = self.cap.read()
        if not ret:
            print("[!] Cannot read from camera")
            return False
        
        h, w = frame.shape[:2]
        print(f"[*] Camera {self.camera_index}: {w}x{h}")
        print(f"[*] Capture interval: {self.capture_interval}s")
        
        self.running = True
        return True
    
    def capture_and_analyze(self) -> Optional[Dict]:
        """Capture a frame and analyze it."""
        if not self.cap or not self.cap.isOpened():
            return None
        
        ret, frame = self.cap.read()
        if not ret:
            return None
        
        # Analyze
        analysis = analyze_thermal_frame(frame)
        
        # Detect motion
        motion = detect_motion(frame, self.prev_frame)
        analysis["motion_score"] = motion
        
        # Update previous frame
        self.prev_frame = frame.copy()
        
        # Save frame if significant
        if analysis["hotspot_count"] > 0 or motion > 0.05:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            frame_path = FRAME_STORAGE_DIR / f"rf_{timestamp}.jpg"
            cv2.imwrite(str(frame_path), frame)
            analysis["frame_path"] = str(frame_path)
        
        return analysis
    
    def build_rf_report(self, analysis: Dict) -> str:
        """Build a human-readable report for KAI."""
        report = f"RF Camera: "
        
        if analysis["hotspot_count"] > 0:
            report += f"{analysis['hotspot_count']} thermal hotspots detected. "
            # Describe hotspots
            for i, spot in enumerate(analysis["hotspots"][:3]):
                report += f"Hotspot {i+1}: intensity {spot['intensity']:.2f} at ({spot['x']},{spot['y']}). "
        
        if analysis["coldspot_count"] > 0:
            report += f"{analysis['coldspot_count']} cold regions. "
        
        report += f"Mean thermal level: {analysis['mean_temp']:.2f}. "
        report += f"Frame entropy: {analysis['frame_entropy']:.1f}. "
        
        if analysis["motion_score"] > 0.05:
            report += f"Motion detected: {analysis['motion_score']:.2f} change. "
        
        return report
    
    def build_discord_embed(self, analysis: Dict) -> Dict:
        """Build Discord embed for RF camera feed."""
        # Color based on activity
        if analysis["hotspot_count"] > 3:
            color = 0xFF0000  # Red
        elif analysis["hotspot_count"] > 0:
            color = 0xFFA500  # Orange
        elif analysis["motion_score"] > 0.05:
            color = 0xFFFF00  # Yellow
        else:
            color = 0x00FF00  # Green
        
        fields = [
            {
                "name": "Thermal Hotspots",
                "value": f"{analysis['hotspot_count']} detected",
                "inline": True
            },
            {
                "name": "Cold Regions",
                "value": f"{analysis['coldspot_count']} detected",
                "inline": True
            },
            {
                "name": "Mean Level",
                "value": f"{analysis['mean_temp']:.2f}",
                "inline": True
            }
        ]
        
        if analysis["motion_score"] > 0.05:
            fields.append({
                "name": "Motion",
                "value": f"{analysis['motion_score']:.2f} activity",
                "inline": True
            })
        
        embed = {
            "title": "RF Camera Vision",
            "description": self.build_rf_report(analysis),
            "color": color,
            "fields": fields,
            "footer": {
                "text": f"Camera {self.camera_index} | {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
            }
        }
        
        return embed
    
    def run_cycle(self):
        """Run one capture and analysis cycle."""
        analysis = self.capture_and_analyze()
        if not analysis:
            return
        
        # Build report
        report = self.build_rf_report(analysis)
        
        # Store in KAI memory
        strength = min(1.0, analysis["hotspot_count"] * 0.2 + analysis["motion_score"])
        store_in_kai_memory(report, "sensory_rf_cortex", "rf_camera", strength)
        
        # Print to console
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {report}")
        
        # Post to Discord if significant
        if analysis["hotspot_count"] > 0 or analysis["motion_score"] > 0.1:
            embed = self.build_discord_embed(analysis)
            post_discord_embed(self.discord_channel, embed, self.discord_token)
    
    def run(self):
        """Main loop."""
        if not self.start():
            return
        
        print("[*] RF Camera Bridge running. Press Ctrl+C to stop.")
        
        try:
            while self.running:
                self.run_cycle()
                time.sleep(self.capture_interval)
        except KeyboardInterrupt:
            print("\n[!] Stopping RF Camera Bridge...")
        finally:
            self.stop()
    
    def stop(self):
        """Stop the bridge."""
        self.running = False
        if self.cap:
            self.cap.release()
        print("[*] RF Camera Bridge stopped.")

# ── Main ─────────────────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser(description="RF Camera Bridge for KAI")
    parser.add_argument("--camera", type=int, default=RF_CAMERA_INDEX, help="Camera index")
    parser.add_argument("--interval", type=float, default=5.0, help="Capture interval in seconds")
    parser.add_argument("--discord-channel", default=DISCORD_CHANNEL_ID, help="Discord channel ID")
    parser.add_argument("--headless", action="store_true", help="Run without console output")
    
    args = parser.parse_args()
    
    bridge = RFCameraBridge(
        camera_index=args.camera,
        capture_interval=args.interval,
        discord_channel=args.discord_channel
    )
    
    bridge.run()

if __name__ == "__main__":
    main()
