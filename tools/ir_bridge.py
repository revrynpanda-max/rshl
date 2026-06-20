"""
KAI IR Camera Sensory Bridge
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Reads IR/thermal camera frames and feeds presence/heat/motion events
into KAI's neural lattice as sensory memories.

Works with:
  - Any UVC-compliant thermal camera (appears as a standard webcam)
  - Generic USB infrared cameras (night vision, etc.)
  - FLIR Lepton / seek thermal if using UVC mode

Usage:
  python ir_bridge.py            # normal mode
  python ir_bridge.py --headless # silent background mode
"""

import cv2
import time
import requests
import sys
import os
from dotenv import load_dotenv
load_dotenv(r'c:\KAI\tools\oracle-discord\.env')
import argparse
import numpy as np
from datetime import datetime

# ─── Parse Arguments ──────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="KAI IR Camera Sensory Bridge")
parser.add_argument("--headless", action="store_true",
                    help="Run silently in background (no terminal output)")
parser.add_argument("--device", type=int, default=-1,
                    help="Camera device index (default: auto-detect)")
args = parser.parse_args()

HEADLESS      = args.headless
DEVICE_HINT   = args.device
KAI_URL       = "http://127.0.0.1:3333/api/store"
POST_INTERVAL = 10.0   # seconds between KAI memory posts
RETRY_WAIT    = 10.0   # seconds to wait before retrying if no camera found


def log(msg):
    if not HEADLESS:
        print(msg, flush=True)
    else:
        print(f"[KAI-IR] {msg}", file=sys.stderr, flush=True)


def post_to_kai(text, strength=1.0):
    """POST a sensory memory to KAI's neural lattice."""
    try:
        requests.post(KAI_URL, json={
            "text":     text,
            "region":   "sensory_ir_cortex",
            "source":   "ir_camera",
            "strength": round(min(2.0, max(0.5, strength)), 3)
        }, timeout=2)
    except Exception:
        pass


def find_camera():
    """Try camera indices 0-4 and return the first one that opens."""
    indices = [DEVICE_HINT] if DEVICE_HINT >= 0 else [0, 1, 2, 3, 4]
    for idx in indices:
        cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW)  # CAP_DSHOW faster on Windows
        if cap.isOpened():
            ret, frame = cap.read()
            if ret and frame is not None:
                log(f"[IR] Camera found at device index {idx}")
                return cap, idx
        cap.release()
    return None, -1


def analyze_frame(frame, prev_frame):
    """
    Analyze a camera frame for presence/heat/motion.

    Returns dict with:
      - presence: bool (bright/warm regions detected)
      - motion:   bool (significant change from previous frame)
      - intensity: float 0.0–1.0 (relative brightness/heat level)
      - description: str (human-readable event description)
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    # ── Presence detection (bright/warm regions) ──────────────────────────────
    # For thermal cameras: warm objects = brighter pixels
    # For IR night-vision: illuminated objects = brighter pixels
    mean_brightness = float(np.mean(gray)) / 255.0
    bright_pixels   = float(np.sum(gray > 180)) / gray.size

    # Presence is detected if >2% of pixels are very bright (warm body / IR hit)
    presence = bright_pixels > 0.02 or mean_brightness > 0.15

    # ── Motion detection ──────────────────────────────────────────────────────
    motion = False
    motion_score = 0.0
    if prev_frame is not None:
        prev_gray = cv2.cvtColor(prev_frame, cv2.COLOR_BGR2GRAY)
        diff      = cv2.absdiff(gray, prev_gray)
        motion_score = float(np.mean(diff)) / 255.0
        motion    = motion_score > 0.03  # >3% mean pixel change = motion

    # ── Intensity score ───────────────────────────────────────────────────────
    intensity = min(1.0, mean_brightness * 2.0 + motion_score * 3.0)

    # ── Description ───────────────────────────────────────────────────────────
    parts = []
    if motion:
        parts.append("Movement detected")
    if presence:
        parts.append("Warm/IR presence in frame")
    if not presence and not motion:
        parts.append("No presence detected — environment appears clear")

    description = "; ".join(parts)

    return {
        "presence":    presence,
        "motion":      motion,
        "intensity":   intensity,
        "description": description,
        "brightness":  mean_brightness,
        "motion_score": motion_score,
    }


def format_event_text(analysis, timestamp):
    """Format the event text for KAI memory."""
    ts   = timestamp.strftime("%H:%M:%S")
    desc = analysis["description"]
    bri  = analysis["brightness"]
    mot  = analysis["motion_score"]

    return (
        f"[IR Sensory Event @ {ts}] {desc}. "
        f"Frame brightness: {bri:.2%}. "
        f"Motion magnitude: {mot:.2%}. "
        f"This is KAI's real-time visual/thermal environmental awareness."
    )


def main():
    log("")
    log("  KAI IR Camera Sensory Bridge — Starting Up")
    log(f"  KAI endpoint: {KAI_URL}")
    log(f"  Post interval: every {POST_INTERVAL}s")
    log("")

    while True:
        # ── Find camera ───────────────────────────────────────────────────────
        cap, cam_idx = find_camera()
        if cap is None:
            log("[IR] No camera found. Waiting 10s and retrying...")
            time.sleep(RETRY_WAIT)
            continue

        log(f"[IR] Capturing from camera {cam_idx}. Feeding KAI every {POST_INTERVAL}s.")

        prev_frame   = None
        last_post    = time.time()
        frames_read  = 0

        try:
            while True:
                ret, frame = cap.read()
                if not ret or frame is None:
                    log("[IR] Camera read failed. Reconnecting...")
                    break

                frames_read += 1
                now = time.time()

                # Analyze every 5th frame (to reduce CPU) for motion baseline
                if frames_read % 5 == 0 and now - last_post >= POST_INTERVAL:
                    analysis = analyze_frame(frame, prev_frame)
                    event_text = format_event_text(analysis, datetime.now())

                    # Calculate strength (1.0 baseline, +1.0 for heavy motion/presence)
                    strength = 1.0
                    if analysis["presence"]:
                        strength += 0.5
                    if analysis["motion"]:
                        strength += min(0.5, analysis["motion_score"] * 5.0)

                    post_to_kai(event_text, strength)
                    last_post = now

                    if not HEADLESS:
                        print(f"  [{datetime.now().strftime('%H:%M:%S')}] "
                              f"presence={analysis['presence']} "
                              f"motion={analysis['motion']} "
                              f"intensity={analysis['intensity']:.2f} "
                              f"→ KAI (strength={strength:.2f})", flush=True)

                    prev_frame = frame.copy()

                time.sleep(0.1)

        except cv2.error as e:
            log(f"[IR] OpenCV error: {e}")
        except Exception as e:
            log(f"[IR] Error: {e}")
        finally:
            cap.release()

        log("[IR] Camera released. Reconnecting in 5s...")
        time.sleep(5)


if __name__ == "__main__":
    main()
