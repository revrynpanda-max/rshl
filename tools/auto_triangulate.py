#!/usr/bin/env python3
"""
auto_triangulate.py — Self-Calibrating Triangulation with Real TinySA Data

Uses auto_calibration_engine.py to learn the environment from actual sweeps.
No hardcoded beacon locations. No internet. No cheating.

How it works:
1. Collects multiple sweep samples over time
2. Identifies stable signals as anchors (always present, consistent)
3. Builds propagation model from relative signal strengths
4. Estimates position using anchor signal strength ratios
5. Continuously refines as more data is collected
"""

import sys
sys.path.insert(0, 'C:/KAI/tools')

from tinysa_discord_bridge import (
    read_until_prompt, send_cmd, fetch_data,
    classify_signal, find_tinysa_port, TARGET_BAUD, SWEEP_BANDS
)

from auto_calibration_engine import AutoCalibrationEngine

import serial
import time
import json
import math

PORT = find_tinysa_port()
print(f"[*] Using port: {PORT}")

print("[*] Connecting to TinySA...")
try:
    ser = serial.Serial(PORT, TARGET_BAUD, timeout=2)
    ser.reset_input_buffer()
    ser.reset_output_buffer()
    read_until_prompt(ser)
    print("[*] Connected!")
except Exception as e:
    print(f"[!] Failed: {e}")
    sys.exit(1)

# Initialize auto-calibration
engine = AutoCalibrationEngine()
print(f"[*] Calibration engine ready. Samples so far: {len(engine.samples)}")

# Run sweeps and collect data
print("\n" + "="*60)
print(" COLLECTING SWEEP SAMPLES")
print("="*60)
print("Running 5 sweep cycles to build calibration...")

all_results = []

for cycle in range(5):
    print(f"\n[Cycle {cycle+1}/5]")
    
    cycle_results = []
    bands = sorted(SWEEP_BANDS, key=lambda b: b["priority"])
    
    for band in bands:
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
        
        if amps:
            freq_step = (stop - start) / max(1, len(amps) - 1)
            signals = []
            for i, amp in enumerate(amps):
                freq = start + (i * freq_step)
                if amp > -80:
                    signals.append({"freq": freq / 1e6, "amp": amp, "idx": i})
            
            peak_amp = max(amps)
            peak_idx = amps.index(peak_amp)
            peak_freq = start + (peak_idx * freq_step)
            
            cycle_results.append({
                "band": band["name"],
                "peak_freq": peak_freq,
                "peak_amp": peak_amp,
                "signals": signals
            })
            
            if signals:
                print(f"  {band['name']:20s}: {len(signals):3d} signals, peak {peak_freq/1e6:8.2f} MHz @ {peak_amp:6.1f} dBm")
        
        time.sleep(0.3)
    
    all_results.append(cycle_results)
    
    # Feed to calibration engine
    engine.ingest_sweep(cycle_results)
    
    print(f"  -> Calibration samples: {len(engine.samples)}")
    
    if cycle < 4:
        print(f"  -> Waiting 5s before next cycle...")
        time.sleep(5)

ser.close()

print("\n" + "="*60)
print(" CALIBRATION RESULTS")
print("="*60)

report = engine.get_calibration_report()
print(f"Total samples: {report['samples']}")
print(f"Anchor signals: {report['anchors']}")
print(f"Noise bands: {report['noise_bands']}")
print(f"Calibrated: {report['calibrated']}")

print("\nAnchor signals (stable transmitters):")
for freq, anchor in sorted(engine.anchor_signals.items(), 
                            key=lambda x: x[1]['mean_dbm'], reverse=True):
    print(f"  {freq:>6s} MHz: {anchor['mean_dbm']:6.1f} dBm "
          f"(±{anchor['std_dbm']:4.1f}) "
          f"presence={anchor['presence']:.1%} "
          f"conf={anchor['confidence']:.2f}")

print("\nNoise floors:")
for band, noise in engine.noise_floors.items():
    print(f"  {band:20s}: floor={noise['floor']:6.1f} dBm, "
          f"threshold={noise['threshold']:6.1f} dBm")

print("\nPropagation model:")
if engine.propagation_model:
    pm = engine.propagation_model
    print(f"  Path loss exponent (n): {pm['path_loss_exponent']:.2f}")
    print(f"  Reference power: {pm['reference_power']:.1f} dBm")
    print(f"  Reference distance: {pm['reference_distance_km']} km")

print("\n" + "="*60)
print(" POSITION ESTIMATE")
print("="*60)

pos = engine.get_position_estimate()
if pos:
    print(f"Local coordinates:")
    print(f"  X: {pos['x_km']:.2f} km")
    print(f"  Y: {pos['y_km']:.2f} km")
    print(f"  Accuracy: ±{pos['accuracy_mi']:.1f} mi")
    print(f"  Confidence: {pos['confidence']:.1%}")
    print(f"  Anchors used: {pos['anchors']}")
    print(f"\nNote: This is relative positioning, not absolute GPS.")
    print(f"      The strongest anchor is at (0,0).")
    print(f"      Distances are estimated from signal strength.")
else:
    print("[!] Not enough anchor signals for positioning.")
    print("    Need more sweep cycles or more stable signals.")

print("\n" + "="*60)
print(" TEST COMPLETE")
print("="*60)
print("\nTo improve accuracy:")
print("1. Run more sweep cycles (the system learns over time)")
print("2. The system will automatically recalibrate every 10 samples")
print("3. Noise floor will adapt to your environment")
print("4. Position estimate will improve as more anchors are detected")
