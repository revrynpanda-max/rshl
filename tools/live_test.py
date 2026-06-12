#!/usr/bin/env python3
"""
Live test of the TinySA fusion bridge with real hardware.
This will run one full sweep cycle and report actual results.
"""

import sys
sys.path.insert(0, 'C:/KAI/tools')

from tinysa_discord_bridge import (
    read_until_prompt, send_cmd, fetch_data,
    classify_signal, estimate_distance_miles,
    build_discord_embed, build_kai_message,
    log_sweep, init_sweep_csv, store_in_kai_memory,
    find_tinysa_port, TARGET_BAUD, SWEEP_BANDS
)

from triangulation_engine import TriangulationEngine

import serial
import time

PORT = find_tinysa_port()
print(f"[*] Using port: {PORT}")

print("[*] Connecting to TinySA...")
try:
    ser = serial.Serial(PORT, TARGET_BAUD, timeout=2)
    ser.reset_input_buffer()
    ser.reset_output_buffer()
    read_until_prompt(ser)
    print("[*] Connected successfully!")
except Exception as e:
    print(f"[!] Failed: {e}")
    sys.exit(1)

# Initialize CSV
csv_path = init_sweep_csv()
print(f"[*] CSV logging to: {csv_path}")

# Run one full sweep cycle
print("\n" + "="*60)
print(" LIVE SWEEP CYCLE")
print("="*60)

bands = sorted(SWEEP_BANDS, key=lambda b: b["priority"])
sweep_results = []

for band in bands:
    name = band["name"]
    start = band["start"]
    stop = band["stop"]
    points = 101
    
    print(f"\n[{name}] {start/1e6:.1f} - {stop/1e6:.1f} MHz")
    
    send_cmd(ser, "pause")
    read_until_prompt(ser)
    
    send_cmd(ser, f"scan {start} {stop} {points}")
    read_until_prompt(ser)
    
    amps = fetch_data(ser, 0)
    
    send_cmd(ser, "resume")
    read_until_prompt(ser)
    
    if amps:
        peak_amp = max(amps)
        peak_idx = amps.index(peak_amp)
        freq_step = (stop - start) / max(1, len(amps) - 1)
        peak_freq = start + (peak_idx * freq_step)
        
        # Build signal list
        signals = []
        for i, amp in enumerate(amps):
            freq = start + (i * freq_step)
            if amp > -80:
                signals.append({"freq": freq / 1e6, "amp": amp, "idx": i})
        
        freq_mhz = peak_freq / 1e6
        entry = classify_signal(freq_mhz)
        dist_mi = estimate_distance_miles(freq_mhz, peak_amp)
        
        print(f"  Peak: {freq_mhz:.2f} MHz ({entry['name']}) at {peak_amp:.1f} dBm")
        print(f"  Distance est: {dist_mi:.1f} mi" if dist_mi > 0 else "  Distance: N/A")
        print(f"  Signals > -80dBm: {len(signals)}")
        
        # Log
        log_sweep(csv_path, band, peak_freq, peak_amp, signals)
        
        sweep_results.append({
            "band": name,
            "peak_freq": peak_freq,
            "peak_amp": peak_amp,
            "signals": signals,
            "classification": entry["name"],
            "category": entry["category"]
        })
    else:
        print(f"  No data received")
    
    time.sleep(0.5)

# Triangulate
print("\n" + "="*60)
print(" TRIANGULATION")
print("="*60)

engine = TriangulationEngine()
report = engine.build_geolocation_report(sweep_results)

print(f"Detected beacons: {report['beacon_count']}")
for b in report['detected_beacons']:
    print(f"  {b['name']:25s} @ {b['freq_mhz']:6.1f} MHz = {b['rx_dbm']:6.1f} dBm, {b['dist_mi']:5.1f} mi")

if report['position_estimate']:
    pos = report['position_estimate']
    print(f"\n[POSITION] Lat: {pos['latitude']:.6f}, Lon: {pos['longitude']:.6f}")
    print(f"Accuracy: +/-{pos['accuracy_mi']:.1f} mi")
    print(f"Confidence: {pos['confidence']:.1%}")
else:
    print("\n[!] Not enough beacons for triangulation")

# Noise profile
print(f"\nNoise profile: {len(report['noise_profile'].get('band_noise_floors', {}))} bands learned")

# Anomalies
if report['anomalies']:
    print(f"\n[!] Anomalies: {len(report['anomalies'])}")
    for a in report['anomalies'][:5]:
        print(f"  {a['band']}: {a['freq']:.1f} MHz @ {a['amp']:.1f} dBm (floor: {a['noise_floor']:.1f})")

ser.close()

print("\n" + "="*60)
print(" DONE")
print("="*60)
print(f"CSV saved: {csv_path}")
print("\nNote: KAI is not running, so memory stores were skipped.")
print("Discord posts were skipped (no bot token in this environment).")
