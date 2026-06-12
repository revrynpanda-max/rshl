#!/usr/bin/env python3
"""
Test the RF anomaly detector with live monitoring.
"""

import sys
sys.path.insert(0, 'C:/KAI/tools')

from rf_anomaly_detector import RFAnomalyDetector
import time

print("="*60)
print(" KAI RF ANOMALY DETECTION — TEST")
print("="*60)
print("\nRunning 3 monitoring cycles to detect anomalies...")
print("If you have any RF devices nearby, turn them on now!")
print("\nDetecting:")
print("  - NEW signals appearing")
print("  - KNOWN signals disappearing")
print("  - SIGNALS getting stronger or weaker")
print("="*60)

detector = RFAnomalyDetector()

if not detector.baseline:
    print("[!] No baseline. Run --baseline first.")
    sys.exit(1)

print(f"\n[*] Baseline loaded: {len(detector.baseline)} known frequencies")

# Run 3 monitoring sweeps
for i in range(3):
    print(f"\n[Cycle {i+1}/3] Capturing sweep...")
    sweep = detector._capture_sweep()
    anomalies = detector.detect_anomalies(sweep)
    
    if anomalies:
        print(f"  [!] {len(anomalies)} ANOMALIES DETECTED:")
        for a in anomalies:
            severity = a["severity"]
            type_ = a["type"]
            desc = a["description"]
            print(f"    [{severity}] {type_}")
            print(f"      {desc}")
    else:
        print(f"  [OK] Environment normal")
    
    if i < 2:
        print(f"  -> Waiting 5s...")
        time.sleep(5)

print("\n" + "="*60)
print(" TEST COMPLETE")
print("="*60)
print("\nTo start continuous monitoring:")
print("  python rf_anomaly_detector.py --monitor")
print("\nTo check threat report:")
print("  python rf_anomaly_detector.py --report")
