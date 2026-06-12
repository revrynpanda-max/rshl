#!/usr/bin/env python3
"""
tinysa_discord_bridge.py — Advanced RF Intelligence Bridge for KAI

Connects TinySA Ultra (COM6) to both:
  1. KAI's memory lattice (physics region)
  2. Discord channel #kai-freq (1513582425446289658)

Features:
  - Multi-band spectrum sweeps (10 MHz – 6 GHz)
  - Expanded frequency database (military, aviation, maritime, space, emergency, IoT)
  - Geological RF mapping (CSV sweep logging)
  - Distance estimation via free-space path loss (FSPL)
  - Rich Discord embeds with signal classification, strength, and distance
  - KAI memory reinforcement for autonomous RF awareness

Usage:
    python tinysa_discord_bridge.py --headless
    python tinysa_discord_bridge.py --port COM6 --discord-channel 1513582425446289658
"""

import serial
import serial.tools.list_ports
import time
import json
import sys
import os
import csv
import math
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Tuple, Optional

try:
    from sensor_truth import build_rf_truth_note, classify_environment_signal, summarize_weather_indicators
except Exception:
    build_rf_truth_note = None
    classify_environment_signal = None
    summarize_weather_indicators = None

# ── Configuration ──────────────────────────────────────────────────────────
KAI_STORE_URL = "http://127.0.0.1:3334/api/rshl/store"
KAI_BULK_URL = "http://127.0.0.1:3334/api/bulk-ingest"
DISCORD_API_BASE = "https://discord.com/api/v10"
DISCORD_CHANNEL_ID = "1513582425446289658"
TARGET_BAUD = 115200

SWEEP_LOG_DIR = Path("C:/KAI/logs/tinysa")
SWEEP_LOG_DIR.mkdir(parents=True, exist_ok=True)

# ── Expanded Frequency Database ─────────────────────────────────────────────
# Covers military, aviation, maritime, space, emergency services, IoT, and more
FREQUENCY_DATABASE = [
    # HF / Shortwave
    {"start": 0.003,  "stop": 0.030, "name": "VLF Submarine / ELF Earth", "category": "military", "power_dbm": 80},
    {"start": 0.1357, "stop": 0.1378, "name": "LF Aircraft Navigation (NON-Beacons)", "category": "aviation", "power_dbm": 40},
    {"start": 1.8,    "stop": 2.0,   "name": "160m Ham Radio", "category": "amateur", "power_dbm": 30},
    {"start": 3.5,    "stop": 4.0,   "name": "80m Ham Radio", "category": "amateur", "power_dbm": 30},
    {"start": 5.0,    "stop": 5.5,   "name": "60m Ham Radio / Govt Emergency", "category": "emergency", "power_dbm": 35},
    {"start": 7.0,    "stop": 7.3,   "name": "40m Ham Radio", "category": "amateur", "power_dbm": 30},
    {"start": 10.0,   "stop": 10.5,  "name": "30m Ham Radio", "category": "amateur", "power_dbm": 25},
    {"start": 14.0,   "stop": 14.35, "name": "20m Ham Radio", "category": "amateur", "power_dbm": 30},
    {"start": 18.0,   "stop": 18.17, "name": "17m Ham Radio", "category": "amateur", "power_dbm": 25},
    {"start": 21.0,   "stop": 21.45, "name": "15m Ham Radio", "category": "amateur", "power_dbm": 30},
    {"start": 24.8,   "stop": 25.0,  "name": "12m Ham Radio", "category": "amateur", "power_dbm": 25},
    {"start": 26.9,   "stop": 27.5,  "name": "CB Radio / 11m", "category": "citizen", "power_dbm": 20},
    {"start": 28.0,   "stop": 29.7,  "name": "10m Ham Radio", "category": "amateur", "power_dbm": 30},
    {"start": 30.0,   "stop": 50.0,  "name": "VHF Low / TV Ch 2-6", "category": "broadcast", "power_dbm": 50},
    {"start": 50.0,   "stop": 54.0,  "name": "6m Ham Radio", "category": "amateur", "power_dbm": 30},
    {"start": 54.0,   "stop": 72.0,  "name": "TV Broadcast VHF", "category": "broadcast", "power_dbm": 50},
    {"start": 72.0,   "stop": 76.0,  "name": "Radio Astronomy / Weather", "category": "science", "power_dbm": 60},
    {"start": 76.0,   "stop": 88.0,  "name": "Aircraft VHF Comms", "category": "aviation", "power_dbm": 20},
    {"start": 88.0,   "stop": 108.0, "name": "FM Radio Broadcast", "category": "broadcast", "power_dbm": 80},
    {"start": 108.0,  "stop": 137.0, "name": "Aircraft/Aviation Band", "category": "aviation", "power_dbm": 15},
    {"start": 121.5,  "stop": 121.5, "name": "Emergency Distress (Guard)", "category": "emergency", "power_dbm": 20},
    {"start": 137.0,  "stop": 144.0, "name": "Weather Satellites / Space", "category": "space", "power_dbm": 10},
    {"start": 144.0,  "stop": 148.0, "name": "2m Ham Radio / VHF", "category": "amateur", "power_dbm": 30},
    {"start": 148.0,  "stop": 150.8, "name": "Military VHF / Land Mobile", "category": "military", "power_dbm": 35},
    {"start": 150.8,  "stop": 156.0, "name": "VHF Business / Public Safety", "category": "public", "power_dbm": 30},
    {"start": 156.0,  "stop": 162.0, "name": "Marine VHF / Coast Guard", "category": "maritime", "power_dbm": 25},
    {"start": 156.8,  "stop": 156.8, "name": "Marine Distress Ch 16", "category": "emergency", "power_dbm": 25},
    {"start": 162.35, "stop": 162.575, "name": "NOAA Weather Radio", "category": "weather", "power_dbm": 50},
    {"start": 162.0,  "stop": 174.0, "name": "Govt / Police / Fire", "category": "emergency", "power_dbm": 35},
    {"start": 174.0,  "stop": 216.0, "name": "TV Broadcast VHF", "category": "broadcast", "power_dbm": 50},
    {"start": 216.0,  "stop": 220.0, "name": "Land Mobile / Govt", "category": "public", "power_dbm": 30},
    {"start": 220.0,  "stop": 225.0, "name": "220m Ham Radio", "category": "amateur", "power_dbm": 25},
    {"start": 225.0,  "stop": 400.0, "name": "Military UHF / Gov", "category": "military", "power_dbm": 35},
    {"start": 300.0,  "stop": 300.0, "name": "NASA Space-Ground Link", "category": "space", "power_dbm": 50},
    {"start": 315.0,  "stop": 316.0, "name": "Car Key Fob / Garage Door", "category": "iot", "power_dbm": 0},
    {"start": 380.0,  "stop": 400.0, "name": "UHF Military Land Mobile", "category": "military", "power_dbm": 35},
    {"start": 400.0,  "stop": 420.0, "name": "UHF Federal / Public Safety", "category": "public", "power_dbm": 35},
    {"start": 420.0,  "stop": 450.0, "name": "70cm Ham Radio / UHF", "category": "amateur", "power_dbm": 30},
    {"start": 433.0,  "stop": 434.0, "name": "ISM Smart Home / Temp Sensors", "category": "iot", "power_dbm": 10},
    {"start": 450.0,  "stop": 470.0, "name": "UHF Business / Land Mobile", "category": "public", "power_dbm": 30},
    {"start": 462.0,  "stop": 467.0, "name": "GMRS/FRS Walkie Talkies", "category": "citizen", "power_dbm": 20},
    {"start": 470.0,  "stop": 512.0, "name": "TV Broadcast UHF", "category": "broadcast", "power_dbm": 50},
    {"start": 512.0,  "stop": 608.0, "name": "Medical / Government UHF", "category": "medical", "power_dbm": 30},
    {"start": 608.0,  "stop": 614.0, "name": "Radio Astronomy", "category": "science", "power_dbm": 60},
    {"start": 614.0,  "stop": 698.0, "name": "TV Broadcast UHF", "category": "broadcast", "power_dbm": 50},
    {"start": 698.0,  "stop": 960.0, "name": "Cellular / LTE Band (Sub-1GHz)", "category": "cellular", "power_dbm": 46},
    {"start": 775.0,  "stop": 795.0, "name": "Public Safety / Trunking", "category": "emergency", "power_dbm": 35},
    {"start": 851.0,  "stop": 869.0, "name": "Cellular / SMR", "category": "cellular", "power_dbm": 40},
    {"start": 902.0,  "stop": 928.0, "name": "ISM 900MHz / LoRa / Zigbee", "category": "iot", "power_dbm": 20},
    {"start": 935.0,  "stop": 960.0, "name": "GSM / Cellular Uplink", "category": "cellular", "power_dbm": 30},
    {"start": 960.0,  "stop": 1090.0, "name": "UHF Aero / Air Navigation", "category": "aviation", "power_dbm": 25},
    {"start": 1090.0, "stop": 1091.0, "name": "ADS-B Aircraft Transponders", "category": "aviation", "power_dbm": 15},
    {"start": 1176.0, "stop": 1177.0, "name": "GPS L5 Signal", "category": "space", "power_dbm": -155},
    {"start": 1227.0, "stop": 1228.0, "name": "GPS L2 Signal", "category": "space", "power_dbm": -155},
    {"start": 1575.0, "stop": 1576.0, "name": "GPS L1 Signal", "category": "space", "power_dbm": -155},
    {"start": 1602.0, "stop": 1616.0, "name": "GLONASS / Iridium", "category": "space", "power_dbm": -150},
    {"start": 1710.0, "stop": 2200.0, "name": "Cellular 4G/5G Mid-Band", "category": "cellular", "power_dbm": 46},
    {"start": 2300.0, "stop": 2400.0, "name": "2.3GHz ISM / Amateur", "category": "amateur", "power_dbm": 30},
    {"start": 2400.0, "stop": 2500.0, "name": "Wi-Fi 2.4GHz / Bluetooth / Microwave", "category": "wifi", "power_dbm": 20},
    {"start": 2500.0, "stop": 2690.0, "name": "4G/5G TDD / BRS", "category": "cellular", "power_dbm": 46},
    {"start": 2700.0, "stop": 3500.0, "name": "Aero Radar / Satellite", "category": "aviation", "power_dbm": 60},
    {"start": 3300.0, "stop": 3800.0, "name": "5G NR C-Band", "category": "cellular", "power_dbm": 46},
    {"start": 3500.0, "stop": 3700.0, "name": "5G C-Band / Radar", "category": "cellular", "power_dbm": 46},
    {"start": 4200.0, "stop": 4500.0, "name": "5G C-Band Upper", "category": "cellular", "power_dbm": 46},
    {"start": 5150.0, "stop": 5350.0, "name": "5GHz UNII-1 / Wi-Fi", "category": "wifi", "power_dbm": 23},
    {"start": 5470.0, "stop": 5725.0, "name": "5GHz UNII-2 / Radar", "category": "wifi", "power_dbm": 23},
    {"start": 5725.0, "stop": 5875.0, "name": "Wi-Fi 5GHz / Drone Video", "category": "wifi", "power_dbm": 30},
    {"start": 5875.0, "stop": 5925.0, "name": "5GHz UNII-4 / Wi-Fi 6E", "category": "wifi", "power_dbm": 23},
    {"start": 5925.0, "stop": 7125.0, "name": "Wi-Fi 6E / 6GHz", "category": "wifi", "power_dbm": 23},
    {"start": 10.0,   "stop": 10.7,  "name": "Radio Astronomy (Hydrogen Line)", "category": "science", "power_dbm": 60},
]

CATEGORY_COLORS = {
    "military": "#FF0000",
    "aviation": "#00FFFF",
    "maritime": "#0000FF",
    "emergency": "#FF4500",
    "space": "#800080",
    "broadcast": "#FFA500",
    "amateur": "#00FF00",
    "cellular": "#FF69B4",
    "wifi": "#1E90FF",
    "iot": "#32CD32",
    "public": "#FFD700",
    "citizen": "#A52A2A",
    "medical": "#FF1493",
    "science": "#9400D3",
    "weather": "#00BFFF",
    "unknown": "#808080",
}

# ── Sweep Bands ─────────────────────────────────────────────────────────────
# Multi-band sweeps so we don't miss anything
SWEEP_BANDS = [
    {"name": "HF / Shortwave", "start": 3000000,   "stop": 30000000,   "priority": 2},
    {"name": "VHF Low",        "start": 30000000,  "stop": 88000000,   "priority": 3},
    {"name": "FM Broadcast",   "start": 88000000,  "stop": 108000000,  "priority": 1},
    {"name": "Aviation",       "start": 108000000, "stop": 137000000,  "priority": 1},
    {"name": "VHF High",       "start": 137000000, "stop": 174000000,  "priority": 2},
    {"name": "NOAA Weather Radio", "start": 162350000, "stop": 162575000, "priority": 1},
    {"name": "Marine / Gov",   "start": 174000000, "stop": 230000000,  "priority": 2},
    {"name": "UHF / Military", "start": 230000000, "stop": 450000000,  "priority": 3},
    {"name": "ISM / IoT",      "start": 450000000, "stop": 600000000,  "priority": 1},
    {"name": "UHF TV / Cell",  "start": 600000000, "stop": 960000000,  "priority": 2},
    {"name": "Cellular / GPS", "start": 960000000,  "stop": 1800000000, "priority": 2},
    {"name": "Mid-Band",       "start": 1800000000, "stop": 2500000000, "priority": 1},
    {"name": "Wi-Fi 2.4GHz",   "start": 2400000000, "stop": 2500000000, "priority": 1},
    {"name": "5G / C-Band",    "start": 3300000000, "stop": 4200000000, "priority": 2},
    {"name": "5GHz Wi-Fi",     "start": 5150000000, "stop": 5875000000, "priority": 1},
    {"name": "Wi-Fi 6E",        "start": 5925000000, "stop": 7125000000, "priority": 2},
]

# ── Helpers ─────────────────────────────────────────────────────────────────

def find_tinysa_port():
    ports = list(serial.tools.list_ports.comports())
    for p in ports:
        if "CH340" in p.description or "USB Serial" in p.description or "tinySA" in p.description:
            return p.device
    return "COM6"

def read_until_prompt(ser):
    result = ""
    line = ""
    while True:
        c = ser.read().decode('utf-8', errors='ignore')
        if not c:
            break
        if c == '\r':
            continue
        line += c
        if c == '\n':
            result += line
            line = ""
            continue
        if line.endswith('ch>'):
            break
    return result

def send_cmd(ser, cmd):
    ser.write((cmd + "\r").encode())
    ser.readline()

def fetch_data(ser, array=0):
    send_cmd(ser, f"data {array}")
    raw = read_until_prompt(ser)
    vals = []
    for line in raw.split('\n'):
        line = line.strip()
        if line and not line.endswith('ch>'):
            try:
                vals.append(float(line))
            except:
                pass
    return vals

def classify_signal(freq_mhz: float) -> Dict:
    """Classify a frequency and return full metadata."""
    for entry in FREQUENCY_DATABASE:
        if entry["start"] <= freq_mhz <= entry["stop"]:
            return entry
    return {"name": "Unknown RF Emission", "category": "unknown", "power_dbm": 30}

def estimate_distance(freq_mhz: float, rx_dbm: float, tx_power_dbm: float = None) -> float:
    """
    Estimate distance to transmitter using free-space path loss (FSPL).
    FSPL(dB) = 20*log10(d) + 20*log10(f) + 32.44
    Where d = km, f = MHz
    Rearranged: d = 10^((FSPL - 20*log10(f) - 32.44) / 20)
    """
    entry = classify_signal(freq_mhz)
    if tx_power_dbm is None:
        tx_power_dbm = entry.get("power_dbm", 30)
    
    # Path loss = Tx_power - Rx_power
    path_loss = tx_power_dbm - rx_dbm
    
    # FSPL formula rearranged for distance
    try:
        d_km = 10 ** ((path_loss - 20 * math.log10(freq_mhz) - 32.44) / 20)
    except:
        d_km = -1
    
    return d_km

def estimate_distance_miles(freq_mhz: float, rx_dbm: float, tx_power_dbm: float = None) -> float:
    """Estimate distance in miles."""
    km = estimate_distance(freq_mhz, rx_dbm, tx_power_dbm)
    return km * 0.621371 if km > 0 else -1

# ── CSV Logging ─────────────────────────────────────────────────────────────

def init_sweep_csv():
    """Initialize CSV log for geological mapping."""
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    csv_path = SWEEP_LOG_DIR / f"sweep_{timestamp}.csv"
    with open(csv_path, 'w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow([
            "timestamp", "band_name", "start_hz", "stop_hz", "peak_freq_hz",
            "peak_freq_mhz", "peak_amp_dbm", "classification", "category",
            "est_distance_km", "est_distance_mi", "all_signals_json"
        ])
    return csv_path

def log_sweep(csv_path: str, band: Dict, peak_freq: float, peak_amp: float, all_signals: List):
    """Log a sweep to CSV."""
    entry = classify_signal(peak_freq / 1e6)
    dist_km = estimate_distance(peak_freq / 1e6, peak_amp)
    dist_mi = estimate_distance_miles(peak_freq / 1e6, peak_amp)
    
    with open(csv_path, 'a', newline='') as f:
        writer = csv.writer(f)
        writer.writerow([
            datetime.now().isoformat(),
            band["name"],
            band["start"],
            band["stop"],
            peak_freq,
            f"{peak_freq/1e6:.3f}",
            f"{peak_amp:.2f}",
            entry["name"],
            entry["category"],
            f"{dist_km:.2f}" if dist_km > 0 else "N/A",
            f"{dist_mi:.2f}" if dist_mi > 0 else "N/A",
            json.dumps(all_signals)
        ])

# ── Discord Posting ───────────────────────────────────────────────────────

def get_discord_token() -> str:
    """Get KAI bot token from environment."""
    token = os.environ.get("ORACLE_DISCORD_TOKEN_KAI")
    if not token:
        # Fallback: try loading from config file
        config_path = Path("C:/KAI/tools/oracle-discord/.oracle-discord.local.xml")
        if config_path.exists():
            try:
                import xml.etree.ElementTree as ET
                tree = ET.parse(config_path)
                root = tree.getroot()
                # The XML is Clixml format, not simple XML
                # Try reading as text
                content = config_path.read_text()
                if "ORACLE_DISCORD_TOKEN_KAI" in content:
                    # Extract token (this is a best-effort)
                    pass
            except:
                pass
    return token

def post_discord_embed(channel_id: str, embed: Dict, token: str) -> bool:
    """Post a rich embed to Discord channel."""
    if not token:
        print("[Discord] No bot token available. Set ORACLE_DISCORD_TOKEN_KAI env var.")
        return False
    
    url = f"{DISCORD_API_BASE}/channels/{channel_id}/messages"
    headers = {
        "Authorization": f"Bot {token}",
        "Content-Type": "application/json"
    }
    payload = {
        "embeds": [embed]
    }
    
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers=headers,
            method="POST"
        )
        resp = urllib.request.urlopen(req, timeout=10)
        return resp.status == 200
    except Exception as e:
        print(f"[Discord] Error posting: {e}")
        return False

def post_discord_message(channel_id: str, content: str, token: str) -> bool:
    """Post a plain text message to Discord channel."""
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
            url,
            data=json.dumps(payload).encode(),
            headers=headers,
            method="POST"
        )
        resp = urllib.request.urlopen(req, timeout=10)
        return resp.status == 200
    except Exception as e:
        print(f"[Discord] Error posting: {e}")
        return False

# ── KAI Memory ────────────────────────────────────────────────────────────

def store_in_kai_memory(text: str, region: str = "physics", source: str = "tinysa", strength: float = 0.5):
    """Store sensory data in KAI's memory lattice."""
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
    except Exception as e:
        print(f"[KAI] Memory store failed: {e}")
        return False

def bulk_store_in_kai(entries: List[Dict]):
    """Store multiple entries in KAI memory."""
    try:
        req = urllib.request.Request(
            KAI_BULK_URL,
            data=json.dumps({"entries": entries}).encode(),
            headers={"Content-Type": "application/json"}
        )
        resp = urllib.request.urlopen(req, timeout=10)
        return resp.status == 200
    except Exception as e:
        print(f"[KAI] Bulk store failed: {e}")
        return False

# ── Main Sweep Logic ──────────────────────────────────────────────────────

def build_discord_embed(band: Dict, peak_freq: float, peak_amp: float, all_signals: List) -> Dict:
    """Build a rich Discord embed for RF sweep results."""
    freq_mhz = peak_freq / 1e6
    entry = classify_signal(freq_mhz)
    category = entry["category"]
    color = CATEGORY_COLORS.get(category, "#808080")
    
    dist_km = estimate_distance(freq_mhz, peak_amp)
    dist_mi = estimate_distance_miles(freq_mhz, peak_amp)
    
    # Build signal list for description
    signal_lines = []
    for sig in sorted(all_signals, key=lambda x: x["amp"], reverse=True)[:10]:
        sig_entry = classify_signal(sig["freq"])
        sig_cat = sig_entry["category"]
        emoji = {
            "military": "🪖", "aviation": "✈️", "maritime": "⚓",
            "emergency": "🚨", "space": "🛰️", "broadcast": "📡",
            "amateur": "📻", "cellular": "📱", "wifi": "📶",
            "iot": "🔌", "public": "🏛️", "citizen": "🗣️",
            "medical": "🏥", "science": "🔬", "unknown": "❓"
        }.get(sig_cat, "📡")
        
        dist_str = f"{estimate_distance_miles(sig['freq'], sig['amp']):.1f} mi" if estimate_distance_miles(sig['freq'], sig['amp']) > 0 else "N/A"
        signal_lines.append(
            f"{emoji} **{sig['freq']:.1f} MHz** — `{sig['amp']:.1f} dBm` "
            f"({sig_entry['name']}) ~{dist_str}"
        )
    
    description = "\n".join(signal_lines) if signal_lines else "No significant signals detected."
    truth = classify_environment_signal(freq_mhz, peak_amp) if classify_environment_signal else None
    
    embed = {
        "title": f"🔍 RF Sweep: {band['name']}",
        "description": description,
        "color": int(color.lstrip("#"), 16),
        "fields": [
            {
                "name": "📊 Peak Signal",
                "value": f"**{freq_mhz:.2f} MHz**\n`{peak_amp:.1f} dBm`\n{entry['name']}",
                "inline": True
            },
            {
                "name": "📏 Est. Distance",
                "value": f"{dist_km:.2f} km\n{dist_mi:.2f} mi" if dist_km > 0 else "N/A",
                "inline": True
            },
            {
                "name": "📁 Category",
                "value": f"{category.upper()}\nConfidence: {min(1.0, (peak_amp + 100) / 80):.0%}",
                "inline": True
            }
        ],
        "footer": {
            "text": f"TinySA Ultra • COM6 • {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
        }
    }
    
    if truth:
        embed["fields"].append({
            "name": "Interpretation Limit",
            "value": f"{truth['label']}\n{truth['limit'][:220]}",
            "inline": False
        })

    if summarize_weather_indicators:
        weather = summarize_weather_indicators(all_signals)
        if weather["nwr_detected"] or band["name"] == "NOAA Weather Radio":
            hits = ", ".join(f"{h['channel_mhz']:.3f} MHz" for h in weather["nwr_hits"][:3]) or "none"
            embed["fields"].append({
                "name": "Weather RF Check",
                "value": f"NWR channels: {hits}\n{weather['limit']}",
                "inline": False
            })

    return embed

def build_kai_message(band: Dict, peak_freq: float, peak_amp: float, all_signals: List) -> str:
    """Build a concise message for KAI's memory."""
    freq_mhz = peak_freq / 1e6
    entry = classify_signal(freq_mhz)
    dist_mi = estimate_distance_miles(freq_mhz, peak_amp)
    
    strong_signals = [s for s in all_signals if s["amp"] > -50]
    
    msg = f"RF sweep [{band['name']}]: Peak {freq_mhz:.1f} MHz ({entry['name']}) at {peak_amp:.1f} dBm."
    if dist_mi > 0:
        msg += f" Rough RF-path distance estimate: {dist_mi:.1f} miles."
    if strong_signals:
        msg += f" {len(strong_signals)} strong signals detected."
    if build_rf_truth_note:
        msg += f" {build_rf_truth_note(freq_mhz, peak_amp)}"
    
    return msg

def run_sweep(ser, band: Dict, discord_token: str, channel_id: str, csv_path: str) -> Dict:
    """Run a single sweep and report results."""
    start = band["start"]
    stop = band["stop"]
    points = 101
    
    send_cmd(ser, "pause")
    read_until_prompt(ser)
    
    send_cmd(ser, f"scan {start} {stop} {points}")
    read_until_prompt(ser)
    
    amps = fetch_data(ser, 0)
    
    send_cmd(ser, "resume")
    read_until_prompt(ser)
    
    if not amps:
        return {"peak_freq": 0, "peak_amp": -999, "signals": []}
    
    # Build signal list
    freq_step = (stop - start) / max(1, len(amps) - 1)
    signals = []
    for i, amp in enumerate(amps):
        freq = start + (i * freq_step)
        if amp > -80:  # Only report signals above noise floor
            signals.append({
                "freq": freq / 1e6,
                "amp": amp,
                "idx": i
            })
    
    # Find peak
    peak_amp = max(amps)
    peak_idx = amps.index(peak_amp)
    peak_freq = start + (peak_idx * freq_step)
    
    # Classify
    freq_mhz = peak_freq / 1e6
    entry = classify_signal(freq_mhz)
    
    # Log to CSV
    log_sweep(csv_path, band, peak_freq, peak_amp, signals)
    
    # Post to Discord
    embed = build_discord_embed(band, peak_freq, peak_amp, signals)
    post_discord_embed(channel_id, embed, discord_token)
    
    # Store in KAI memory
    kai_msg = build_kai_message(band, peak_freq, peak_amp, signals)
    strength = min(1.0, (peak_amp + 100) / 80)
    store_in_kai_memory(kai_msg, "physics", "tinysa", strength)
    
    # Print summary
    dist_mi = estimate_distance_miles(freq_mhz, peak_amp)
    print(f"\n[{band['name']}] Peak: {freq_mhz:.2f} MHz ({entry['name']}) at {peak_amp:.1f} dBm")
    if dist_mi > 0:
        print(f"  Est. distance: {dist_mi:.1f} mi")
    print(f"  Signals > -80dBm: {len(signals)}")
    
    return {
        "band": band["name"],
        "peak_freq": peak_freq,
        "peak_amp": peak_amp,
        "signals": signals,
        "classification": entry["name"],
        "category": entry["category"]
    }

# ── Main ───────────────────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Advanced RF Discord Bridge for KAI")
    parser.add_argument("--port", default="COM6", help="Serial port for TinySA")
    parser.add_argument("--headless", action="store_true", help="Run without interactive console")
    parser.add_argument("--discord-channel", default=DISCORD_CHANNEL_ID, help="Discord channel ID")
    parser.add_argument("--threshold", type=float, default=-60.0, help="Signal detection threshold (dBm)")
    parser.add_argument("--sweep-interval", type=int, default=300, help="Seconds between full sweep cycles")
    
    args = parser.parse_args()
    
    print("="*60)
    print(" KAI RF INTELLIGENCE — DISCORD BRIDGE")
    print("="*60)
    
    # Find Discord token
    discord_token = get_discord_token()
    if not discord_token:
        print("[!] WARNING: No Discord bot token found. Discord posts will be disabled.")
        print("    Set ORACLE_DISCORD_TOKEN_KAI environment variable.")
    else:
        print(f"[*] Discord token loaded (len={len(discord_token)})")
    
    # Find TinySA
    port = args.port
    if port == "auto":
        port = find_tinysa_port()
    
    print(f"[*] Connecting to TinySA on {port}...")
    
    try:
        ser = serial.Serial(port, TARGET_BAUD, timeout=2)
    except serial.SerialException as e:
        print(f"[!] Serial Error: {e}")
        print("Please ensure tinySA-App is CLOSED so KAI can access the port.")
        sys.exit(1)
    
    print("[*] Connected successfully.")
    ser.reset_input_buffer()
    ser.reset_output_buffer()
    read_until_prompt(ser)
    
    # Initialize CSV
    csv_path = init_sweep_csv()
    print(f"[*] Sweep logging to: {csv_path}")
    
    # Post startup message to Discord
    if discord_token:
        post_discord_message(
            args.discord_channel,
            f"🛰️ **KAI RF Intelligence Online**\nTinySA Ultra connected on {port}.\n"
            f"Scanning {len(SWEEP_BANDS)} bands across 10 MHz – 6 GHz.\n"
            f"Geological mapping enabled. Sweep interval: {args.sweep_interval}s.",
            discord_token
        )
    
    print("[*] Commencing wideband spectrum intelligence sweep...\n")
    
    cycle = 0
    try:
        while True:
            cycle += 1
            print(f"\n{'='*60}")
            print(f" SWEEP CYCLE #{cycle}")
            print(f"{'='*60}")
            
            # Sort bands by priority
            bands = sorted(SWEEP_BANDS, key=lambda b: b["priority"])
            
            results = []
            for band in bands:
                result = run_sweep(ser, band, discord_token, args.discord_channel, csv_path)
                results.append(result)
                time.sleep(0.5)
            
            # Build summary
            strong_count = sum(len(r["signals"]) for r in results if r["peak_amp"] > -50)
            print(f"\n{'='*60}")
            print(f" CYCLE #{cycle} COMPLETE")
            print(f"{'='*60}")
            print(f"Total bands scanned: {len(results)}")
            print(f"Strong signals (> -50dBm): {strong_count}")
            
            # Post summary to Discord
            if discord_token and cycle % 6 == 0:  # Every 6 cycles (~30 min)
                summary = f"📊 **RF Sweep Cycle #{cycle} Complete**\n"
                summary += f"Bands scanned: {len(results)}\n"
                summary += f"Strong signals: {strong_count}\n"
                summary += f"Log file: `{csv_path.name}`\n"
                post_discord_message(args.discord_channel, summary, discord_token)
            
            print(f"\nSleeping {args.sweep_interval}s until next cycle...")
            time.sleep(args.sweep_interval)
    
    except KeyboardInterrupt:
        print("\n[!] Interrupted by user.")
    finally:
        send_cmd(ser, "resume")
        ser.close()
        print("[*] TinySA disconnected. RF bridge offline.")

if __name__ == '__main__':
    main()
