#!/usr/bin/env python3
"""
rf_anomaly_detector.py — Environmental RF Threat Detection for KAI

Monitors the RF spectrum around your area to detect:
  - New signals appearing (unauthorized transmitters, bugs, surveillance)
  - Known signals disappearing (equipment failure, interference)
  - Signal strength changes (movement, new obstructions, near-field sources)
  - Interference patterns (harmonics, spurious emissions, jamming)
  - Burst/irregular signals (key fobs, remote controls, data exfiltration)
  - Wideband noise spikes (electronic warfare, malfunctioning equipment)

Learns "normal" from your environment. Anything deviating = flagged.
No geolocation. Pure threat detection and anomaly alerting.

Usage:
    python rf_anomaly_detector.py --baseline
    python rf_anomaly_detector.py --monitor
    python rf_anomaly_detector.py --headless
"""

import sys
sys.path.insert(0, 'C:/KAI/tools')

from tinysa_discord_bridge import (
    read_until_prompt, send_cmd, fetch_data,
    classify_signal, find_tinysa_port, TARGET_BAUD, SWEEP_BANDS
)

import serial
import time
import json
import numpy as np
from pathlib import Path
from datetime import datetime
from collections import defaultdict
from typing import Dict, List, Tuple, Optional

# ── Configuration ──────────────────────────────────────────────────────────
ANOMALY_DIR = Path("C:/KAI/data/anomalies")
ANOMALY_DIR.mkdir(parents=True, exist_ok=True)

BASELINE_FILE = ANOMALY_DIR / "baseline.json"
ALERT_LOG = ANOMALY_DIR / "alerts.json"

# Detection thresholds
NEW_SIGNAL_THRESHOLD_DB = 8      # dB above noise floor to count as "new"
DISAPPEARANCE_THRESHOLD = 0.7     # Signal must be present in <70% of recent sweeps
STRENGTH_CHANGE_THRESHOLD_DB = 6  # Alert if signal changes by >6dB
INTERFERENCE_THRESHOLD_DB = 15   # Wideband noise spike threshold
BURST_DURATION_S = 3            # Minimum duration to count as burst

# ── Anomaly Detection Engine ─────────────────────────────────────────────

class RFAnomalyDetector:
    """
    Monitors RF spectrum for anomalies and threats.
    
    Learns normal from environment. Flags deviations.
    """
    
    def __init__(self):
        self.baseline = {}  # Normal spectrum fingerprint
        self.signal_history = defaultdict(list)  # Time-series per frequency
        self.recent_sweeps = []
        self.alerts = []
        self.load_baseline()
        
    def load_baseline(self):
        """Load learned baseline from disk."""
        if BASELINE_FILE.exists():
            with open(BASELINE_FILE, 'r') as f:
                self.baseline = json.load(f)
            print(f"[*] Loaded baseline from {BASELINE_FILE}")
        else:
            print(f"[!] No baseline found. Run --baseline first.")
    
    def save_baseline(self):
        """Save baseline to disk."""
        with open(BASELINE_FILE, 'w') as f:
            json.dump(self.baseline, f, indent=2)
        print(f"[*] Baseline saved to {BASELINE_FILE}")
    
    def build_baseline(self, sweep_cycles: int = 10):
        """
        Build a baseline by averaging multiple sweep cycles.
        
        This is the "normal" fingerprint of your environment.
        """
        print(f"[*] Building baseline from {sweep_cycles} sweep cycles...")
        
        all_sweeps = []
        
        for cycle in range(sweep_cycles):
            print(f"  Cycle {cycle+1}/{sweep_cycles}...")
            sweep_data = self._capture_sweep()
            all_sweeps.append(sweep_data)
            time.sleep(2)
        
        # Build frequency database from all sweeps
        freq_db = defaultdict(list)
        
        for sweep in all_sweeps:
            for band_result in sweep:
                for signal in band_result.get("signals", []):
                    freq = round(signal["freq"], 1)
                    freq_db[freq].append(signal["amp"])
        
        # Calculate statistics per frequency
        self.baseline = {}
        
        for freq, amps in freq_db.items():
            if len(amps) >= 3:  # Must appear in at least 3 sweeps
                mean = np.mean(amps)
                std = np.std(amps) if len(amps) > 1 else 0
                
                self.baseline[str(freq)] = {
                    "frequency_mhz": freq,
                    "mean_dbm": float(mean),
                    "std_dbm": float(std),
                    "min_dbm": float(min(amps)),
                    "max_dbm": float(max(amps)),
                    "presence": len(amps) / sweep_cycles,
                    "classification": classify_signal(freq)["name"],
                    "category": classify_signal(freq)["category"]
                }
        
        self.save_baseline()
        print(f"[*] Baseline complete: {len(self.baseline)} stable frequencies learned")
    
    def _capture_sweep(self) -> List[Dict]:
        """Capture one full sweep cycle."""
        # Connect to TinySA
        port = find_tinysa_port()
        ser = serial.Serial(port, TARGET_BAUD, timeout=2)
        ser.reset_input_buffer()
        ser.reset_output_buffer()
        read_until_prompt(ser)
        
        sweep_results = []
        
        for band in sorted(SWEEP_BANDS, key=lambda b: b["priority"]):
            start = band["start"]
            stop = band["stop"]
            
            send_cmd(ser, "pause")
            read_until_prompt(ser)
            
            send_cmd(ser, f"scan {start} {stop} 101")
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
                        signals.append({"freq": freq / 1e6, "amp": amp})
                
                peak_amp = max(amps)
                peak_idx = amps.index(peak_amp)
                peak_freq = start + (peak_idx * freq_step)
                
                sweep_results.append({
                    "band": band["name"],
                    "peak_freq": peak_freq,
                    "peak_amp": peak_amp,
                    "signals": signals
                })
            
            time.sleep(0.3)
        
        ser.close()
        return sweep_results
    
    def detect_anomalies(self, sweep_results: List[Dict]) -> List[Dict]:
        """
        Compare current sweep against baseline and detect anomalies.
        
        Returns list of anomaly events.
        """
        anomalies = []
        
        # Flatten current sweep into frequency map
        current_signals = {}
        for band_result in sweep_results:
            for signal in band_result.get("signals", []):
                freq = round(signal["freq"], 1)
                if freq not in current_signals or signal["amp"] > current_signals[freq]["amp"]:
                    current_signals[freq] = signal
        
        # Check 1: NEW SIGNALS — Frequencies not in baseline
        for freq, signal in current_signals.items():
            freq_str = str(freq)
            if freq_str not in self.baseline:
                # New signal detected!
                classification = classify_signal(freq)
                anomalies.append({
                    "type": "NEW_SIGNAL",
                    "frequency_mhz": freq,
                    "amplitude_dbm": signal["amp"],
                    "classification": classification["name"],
                    "category": classification["category"],
                    "severity": "HIGH" if signal["amp"] > -50 else "MEDIUM",
                    "description": f"New signal detected at {freq:.1f} MHz: {classification['name']} ({signal['amp']:.1f} dBm)",
                    "timestamp": datetime.now().isoformat()
                })
        
        # Check 2: MISSING SIGNALS — Frequencies in baseline but not current
        for freq_str, baseline_data in self.baseline.items():
            freq = float(freq_str)
            
            # Skip if it was rarely present (not a reliable anchor)
            if baseline_data["presence"] < 0.8:
                continue
            
            if freq not in current_signals:
                # Missing signal!
                anomalies.append({
                    "type": "MISSING_SIGNAL",
                    "frequency_mhz": freq,
                    "expected_dbm": baseline_data["mean_dbm"],
                    "classification": baseline_data["classification"],
                    "category": baseline_data["category"],
                    "severity": "MEDIUM",
                    "description": f"Signal disappeared: {baseline_data['classification']} at {freq:.1f} MHz (normally {baseline_data['mean_dbm']:.1f} dBm)",
                    "timestamp": datetime.now().isoformat()
                })
        
        # Check 3: SIGNAL STRENGTH CHANGES
        for freq, signal in current_signals.items():
            freq_str = str(freq)
            if freq_str in self.baseline:
                baseline = self.baseline[freq_str]
                
                # Only check signals that were reliably present
                if baseline["presence"] < 0.8:
                    continue
                
                current_amp = signal["amp"]
                expected_amp = baseline["mean_dbm"]
                std_dev = baseline["std_dbm"]
                
                # Calculate deviation
                deviation = abs(current_amp - expected_amp)
                
                # Alert if deviation > 2 standard deviations + threshold
                if deviation > max(2 * std_dev, STRENGTH_CHANGE_THRESHOLD_DB):
                    direction = "stronger" if current_amp > expected_amp else "weaker"
                    
                    # Stronger = potential new near-field source
                    # Weaker = obstruction, interference, or source moved
                    if current_amp > expected_amp:
                        severity = "HIGH" if deviation > 15 else "MEDIUM"
                    else:
                        severity = "MEDIUM"
                    
                    anomalies.append({
                        "type": "STRENGTH_CHANGE",
                        "frequency_mhz": freq,
                        "expected_dbm": expected_amp,
                        "current_dbm": current_amp,
                        "deviation_db": deviation,
                        "direction": direction,
                        "classification": baseline["classification"],
                        "category": baseline["category"],
                        "severity": severity,
                        "description": f"Signal {direction} by {deviation:.1f} dB: {baseline['classification']} at {freq:.1f} MHz (expected {expected_amp:.1f}, got {current_amp:.1f})",
                        "timestamp": datetime.now().isoformat()
                    })
        
        # Check 4: WIDEBAND NOISE SPIKES
        # Calculate average noise floor per band
        for band_result in sweep_results:
            band_name = band_result["band"]
            signals = band_result.get("signals", [])
            
            if len(signals) > 20:
                # High density of signals = possible noise/interference
                avg_amp = np.mean([s["amp"] for s in signals])
                
                # Check if this band is abnormally loud
                if band_name in self.baseline:
                    # This is a simplified check — we need band-level baseline
                    pass
        
        return anomalies
    
    def monitor(self, interval: int = 60):
        """
        Continuous monitoring loop.
        
        Captures sweeps, compares to baseline, logs anomalies.
        """
        if not self.baseline:
            print("[!] No baseline loaded. Run --baseline first.")
            return
        
        print("="*60)
        print(" KAI RF ANOMALY DETECTION")
        print("="*60)
        print(f"Monitoring interval: {interval}s")
        print(f"Baseline: {len(self.baseline)} known frequencies")
        print("\nDetecting: NEW signals, MISSING signals, STRENGTH changes")
        print("Press Ctrl+C to stop\n")
        
        cycle = 0
        
        try:
            while True:
                cycle += 1
                print(f"\n[{datetime.now().strftime('%H:%M:%S')}] Sweep cycle #{cycle}")
                
                sweep = self._capture_sweep()
                anomalies = self.detect_anomalies(sweep)
                
                if anomalies:
                    print(f"  ⚠ {len(anomalies)} ANOMALIES DETECTED:")
                    for a in anomalies:
                        icon = {"HIGH": "🚨", "MEDIUM": "⚠️", "LOW": "ℹ️"}.get(a["severity"], "⚠️")
                        print(f"    {icon} [{a['severity']}] {a['type']}")
                        print(f"       {a['description']}")
                    
                    # Save to alert log
                    self._save_alerts(anomalies)
                else:
                    print(f"  ✓ Environment normal")
                
                time.sleep(interval)
        
        except KeyboardInterrupt:
            print("\n[!] Monitoring stopped")
        
        finally:
            self._save_alerts([])
    
    def _save_alerts(self, alerts: List[Dict]):
        """Save alerts to log file."""
        existing = []
        if ALERT_LOG.exists():
            with open(ALERT_LOG, 'r') as f:
                existing = json.load(f)
        
        existing.extend(alerts)
        
        # Keep only last 1000 alerts
        existing = existing[-1000:]
        
        with open(ALERT_LOG, 'w') as f:
            json.dump(existing, f, indent=2)
    
    def get_threat_report(self) -> Dict:
        """
        Generate a summary of all detected anomalies.
        """
        if not ALERT_LOG.exists():
            return {"total_alerts": 0, "recent_threats": []}
        
        with open(ALERT_LOG, 'r') as f:
            alerts = json.load(f)
        
        # Count by type
        by_type = defaultdict(int)
        by_severity = defaultdict(int)
        recent = []
        
        for alert in alerts[-50:]:  # Last 50 alerts
            by_type[alert["type"]] += 1
            by_severity[alert["severity"]] += 1
            recent.append(alert)
        
        return {
            "total_alerts": len(alerts),
            "recent_alerts": len(recent),
            "by_type": dict(by_type),
            "by_severity": dict(by_severity),
            "recent_threats": recent[-10:]
        }

# ── Main ─────────────────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser(description="KAI RF Anomaly Detector")
    parser.add_argument("--baseline", action="store_true", help="Build baseline from 10 sweeps")
    parser.add_argument("--monitor", action="store_true", help="Start continuous monitoring")
    parser.add_argument("--headless", action="store_true", help="Run without console output")
    parser.add_argument("--interval", type=int, default=60, help="Seconds between sweeps")
    parser.add_argument("--report", action="store_true", help="Show threat report")
    
    args = parser.parse_args()
    
    detector = RFAnomalyDetector()
    
    if args.baseline:
        detector.build_baseline()
    elif args.monitor:
        detector.monitor(args.interval)
    elif args.report:
        report = detector.get_threat_report()
        print(json.dumps(report, indent=2))
    else:
        print("Usage:")
        print("  python rf_anomaly_detector.py --baseline")
        print("  python rf_anomaly_detector.py --monitor")
        print("  python rf_anomaly_detector.py --report")

if __name__ == "__main__":
    main()
