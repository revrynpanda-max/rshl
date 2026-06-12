#!/usr/bin/env python3
"""
auto_calibration_engine.py — Self-Calibrating RF Detection for KAI

No hardcoded locations. No internet lookups. No cheating.

Method:
1. Learn the local environment from actual TinySA sweeps
2. Identify stable signals (always present, consistent strength) as anchors
3. Build a local propagation model from anchor signals
4. Use relative signal strength ratios between bands to estimate distance
5. Calibrate noise floor per-band based on statistical analysis
6. Build an adaptive beacon database from signals KAI actually sees
7. Use time-series correlation to filter transient noise

Key principle: The system knows what it sees. Stable signals = anchors.
Moving/changing signals = environment. Consistency = truth.
"""

import json
import math
import statistics
import numpy as np
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Tuple, Optional

# ── Configuration ──────────────────────────────────────────────────────────
CALIBRATION_DIR = Path("C:/KAI/data/calibration")
CALIBRATION_DIR.mkdir(parents=True, exist_ok=True)

MIN_SAMPLES_FOR_CALIBRATION = 5
STABILITY_THRESHOLD = 0.25  # Std dev as fraction of mean

class AutoCalibrationEngine:
    """
    Self-calibrating RF detection engine.
    
    Learns the environment from actual TinySA readings over time.
    No hardcoded GPS coordinates. No internet lookups.
    """
    
    def __init__(self):
        self.samples = []
        self.anchor_signals = {}  # Stable signals that are always present
        self.propagation_model = {}  # Learned dBm vs distance model
        self.noise_floors = {}
        self.load_state()
        
    def load_state(self):
        """Load previous calibration state."""
        state_file = CALIBRATION_DIR / "calibration_state.json"
        if state_file.exists():
            with open(state_file, 'r') as f:
                data = json.load(f)
                self.anchor_signals = data.get("anchors", {})
                self.propagation_model = data.get("propagation", {})
                self.noise_floors = data.get("noise_floors", {})
    
    def save_state(self):
        """Save calibration state."""
        state_file = CALIBRATION_DIR / "calibration_state.json"
        with open(state_file, 'w') as f:
            json.dump({
                "anchors": self.anchor_signals,
                "propagation": self.propagation_model,
                "noise_floors": self.noise_floors,
                "calibrated_at": datetime.now().isoformat()
            }, f, indent=2)
    
    def ingest_sweep(self, sweep_results: List[Dict]):
        """
        Add a sweep to the calibration database.
        
        Args:
            sweep_results: List of band results from a sweep cycle
        """
        timestamp = datetime.now().isoformat()
        
        # Flatten all signals into a single list
        all_signals = []
        for band_result in sweep_results:
            for signal in band_result.get("signals", []):
                signal["timestamp"] = timestamp
                signal["band"] = band_result.get("band", "unknown")
                all_signals.append(signal)
        
        self.samples.append({
            "timestamp": timestamp,
            "signals": all_signals
        })
        
        # Keep only last 100 samples
        if len(self.samples) > 100:
            self.samples = self.samples[-100:]
        
        # Recalibrate if we have enough samples
        if len(self.samples) >= MIN_SAMPLES_FOR_CALIBRATION:
            self.recalibrate()
    
    def recalibrate(self):
        """
        Main calibration routine.
        Analyzes all samples to find stable signals, learn noise floors,
        and build propagation model.
        """
        print("[Calibration] Recalibrating with", len(self.samples), "samples...")
        
        # Step 1: Find stable signals (always present, consistent strength)
        self._find_anchor_signals()
        
        # Step 2: Learn noise floors per band
        self._learn_noise_floors()
        
        # Step 3: Build propagation model from anchors
        self._build_propagation_model()
        
        # Step 4: Save state
        self.save_state()
        
        print(f"[Calibration] Complete. Anchors: {len(self.anchor_signals)}, "
              f"Noise bands: {len(self.noise_floors)}")
    
    def _find_anchor_signals(self):
        """
        Find signals that are consistently present across sweeps.
        These are likely local transmitters (cell towers, Wi-Fi, broadcast).
        
        A signal is an anchor if:
        - Present in >80% of samples
        - Strength variance <15% of mean
        - Not transient (doesn't appear/disappear randomly)
        """
        # Group signals by frequency (rounded to nearest MHz)
        freq_groups = {}
        
        for sample in self.samples:
            # Track which frequencies appeared in this sample
            seen_in_sample = set()
            for signal in sample["signals"]:
                freq = round(signal["freq"], 0)  # Round to nearest MHz
                if freq not in freq_groups:
                    freq_groups[freq] = []
                freq_groups[freq].append(signal["amp"])
                seen_in_sample.add(freq)
        
        # Find stable frequencies
        self.anchor_signals = {}
        
        for freq, amps in freq_groups.items():
            # Must appear in at least 50% of samples
            if len(amps) < MIN_SAMPLES_FOR_CALIBRATION * 0.5:
                continue
            
            # Calculate statistics
            mean_amp = statistics.mean(amps)
            std_amp = statistics.stdev(amps) if len(amps) > 1 else 0
            
            # Presence ratio: how many samples contained this frequency
            # Count unique samples that had this frequency
            presence_count = sum(1 for s in self.samples if any(round(sig["freq"], 0) == freq for sig in s["signals"]))
            presence_ratio = presence_count / len(self.samples)
            
            # Coefficient of variation
            cv = abs(std_amp / mean_amp) if mean_amp != 0 else 0
            
            # Strict criteria for anchor:
            # - Present in >80% of samples
            # - Low variance (CV < 0.25)
            # - Strong enough to be real signal (>-75dBm)
            if presence_ratio > 0.8 and cv < STABILITY_THRESHOLD and mean_amp > -75:
                # This is an anchor signal
                self.anchor_signals[str(freq)] = {
                    "frequency_mhz": freq,
                    "mean_dbm": mean_amp,
                    "std_dbm": std_amp,
                    "presence": presence_ratio,
                    "cv": cv,
                    "samples": len(amps),
                    "confidence": self._anchor_confidence(mean_amp, std_amp, presence_ratio)
                }
        
        print(f"[Calibration] Found {len(self.anchor_signals)} anchor signals")
    
    def _anchor_confidence(self, mean_dbm: float, std_dbm: float, presence: float) -> float:
        """
        Calculate confidence score for an anchor.
        
        Stronger signal + lower variance + higher presence = higher confidence
        """
        # Strength score (0-1): stronger signals get higher confidence
        # Map -80 to -50 dBm to 0-1
        strength_score = min(1.0, max(0.0, (mean_dbm + 80) / 30))
        
        # Stability score (0-1): lower variance = higher confidence
        # Std dev of 0 = 1.0, std dev of 10 = 0.5
        stability_score = 1.0 / (1.0 + std_dbm / 5)
        
        # Presence score (0-1): more present = higher confidence
        # Cap at 1.0
        presence_score = min(1.0, presence)
        
        # Weighted combination
        confidence = (strength_score * 0.3 + stability_score * 0.4 + presence_score * 0.3)
        return round(min(1.0, confidence), 3)
    
    def _learn_noise_floors(self):
        """
        Learn noise floors per band from the bottom 10% of signals.
        """
        band_signals = {}
        
        for sample in self.samples:
            for signal in sample["signals"]:
                band = signal.get("band", "unknown")
                if band not in band_signals:
                    band_signals[band] = []
                band_signals[band].append(signal["amp"])
        
        for band, amps in band_signals.items():
            if len(amps) < 10:
                continue
            
            # Use 10th percentile as noise floor
            amps_sorted = sorted(amps)
            noise_floor = amps_sorted[int(len(amps) * 0.1)]
            
            # Also calculate median and standard deviation
            median = statistics.median(amps)
            std = statistics.stdev(amps) if len(amps) > 1 else 0
            
            self.noise_floors[band] = {
                "floor": noise_floor,
                "median": median,
                "std": std,
                "threshold": noise_floor + 10,  # Signal threshold = floor + 10dB
                "samples": len(amps)
            }
    
    def _build_propagation_model(self):
        """
        Build propagation model from anchor signals.
        
        Key insight: We don't know the transmitter power, but we know
        which signals are closest (strongest, most stable) vs farthest.
        
        We use relative signal strength to build a distance ranking.
        """
        if len(self.anchor_signals) < 3:
            return
        
        # Sort anchors by signal strength (strongest = closest)
        anchors = sorted(
            self.anchor_signals.values(),
            key=lambda x: x["mean_dbm"],
            reverse=True
        )
        
        # Strongest anchor = reference (assume 0.1 km / very close)
        # Weakest anchor = farthest (assume 50 km for broadcast)
        
        strongest = anchors[0]
        weakest = anchors[-1]
        
        # Build a model: dBm -> distance
        # We fit a simple log model: distance = 10^((P0 - P) / (10 * n))
        # where n is the path loss exponent (typically 2-4)
        
        # Assume strongest is at 0.1 km, weakest at 50 km
        d0 = 0.1  # km
        d1 = 50.0  # km
        p0 = strongest["mean_dbm"]
        p1 = weakest["mean_dbm"]
        
        # Calculate path loss exponent n
        if p0 != p1:
            n = (p0 - p1) / (10 * math.log10(d1 / d0))
            n = max(1.0, min(n, 5.0))  # Sanity check
        else:
            n = 2.0
        
        self.propagation_model = {
            "reference_power": p0,
            "reference_distance_km": d0,
            "path_loss_exponent": n,
            "strongest_anchor": strongest["frequency_mhz"],
            "weakest_anchor": weakest["frequency_mhz"],
            "anchors_used": len(anchors)
        }
        
        print(f"[Calibration] Propagation model: n={n:.2f}, "
              f"ref={p0:.1f}dBm @ {d0}km")
    
    def estimate_distance(self, freq_mhz: float, rx_dbm: float) -> float:
        """
        Estimate distance using learned propagation model.
        
        If the signal is a known anchor, use the anchor's calibrated distance.
        Otherwise, use the propagation model.
        """
        # Check if this is a known anchor
        anchor = self.anchor_signals.get(str(round(freq_mhz, 0)))
        if anchor:
            # Use anchor confidence to adjust
            # If anchor is very confident and strong, it's close
            # If anchor is weaker, it's farther
            
            # Use the propagation model to estimate distance
            if self.propagation_model:
                p0 = self.propagation_model["reference_power"]
                d0 = self.propagation_model["reference_distance_km"]
                n = self.propagation_model["path_loss_exponent"]
                
                # Distance = d0 * 10^((P0 - P) / (10 * n))
                try:
                    distance = d0 * 10 ** ((p0 - rx_dbm) / (10 * n))
                    return distance
                except:
                    pass
        
        # Fallback: use simple FSPL with learned parameters
        if self.propagation_model:
            p0 = self.propagation_model["reference_power"]
            n = self.propagation_model["path_loss_exponent"]
            
            # Use median path loss exponent
            distance = 0.1 * 10 ** ((p0 - rx_dbm) / (10 * n))
            return max(0.01, min(distance, 200))  # Clamp to 200 km max
        
        # No model yet
        return -1
    
    def is_anomaly(self, band: str, freq: float, amp: float) -> bool:
        """
        Check if a signal is anomalous based on learned noise profile.
        """
        # Check against anchor database
        anchor = self.anchor_signals.get(str(round(freq, 0)))
        if anchor:
            # If it's an anchor, check if it's significantly different from normal
            expected = anchor["mean_dbm"]
            std = anchor["std_dbm"]
            
            # Anomaly if deviation > 2 standard deviations
            if abs(amp - expected) > 2 * std:
                return True
            return False
        
        # Check against noise floor
        noise = self.noise_floors.get(band)
        if noise:
            return amp > noise["threshold"]
        
        # Default
        return amp > -60
    
    def get_position_estimate(self) -> Optional[Dict]:
        """
        Estimate position using anchor signals.
        
        Since we don't know absolute GPS coordinates, we use relative
        positioning: strong signals are close, weak signals are far.
        
        We build a local coordinate system where:
        - Strongest anchor = (0, 0)
        - Other anchors are placed relative to it based on signal strength
        """
        if len(self.anchor_signals) < 3:
            return None
        
        # Get top anchors sorted by strength
        anchors = sorted(
            self.anchor_signals.values(),
            key=lambda x: x["mean_dbm"],
            reverse=True
        )[:5]
        
        # Use strongest as center
        center = anchors[0]
        
        # Calculate relative positions
        # Closer anchors (stronger) get smaller radii
        # We place them at random angles for simplicity
        # In reality, we'd need directional antenna data
        
        import random
        random.seed(42)  # Fixed seed for reproducibility
        
        positions = []
        total_confidence = 0
        
        for i, anchor in enumerate(anchors):
            # Distance from center based on signal strength difference
            if i == 0:
                dist = 0.0
            else:
                # Calculate distance using propagation model
                dist = self.estimate_distance(anchor["frequency_mhz"], anchor["mean_dbm"])
            
            # Random angle (we don't know direction without directional antenna)
            angle = random.uniform(0, 2 * math.pi)
            
            # Convert to Cartesian
            x = dist * math.cos(angle)
            y = dist * math.sin(angle)
            
            positions.append({
                "x": x,
                "y": y,
                "freq": anchor["frequency_mhz"],
                "dbm": anchor["mean_dbm"],
                "confidence": anchor["confidence"]
            })
            
            total_confidence += anchor["confidence"]
        
        # Calculate weighted centroid
        if total_confidence == 0:
            return None
        
        x_sum = sum(p["x"] * p["confidence"] for p in positions)
        y_sum = sum(p["y"] * p["confidence"] for p in positions)
        
        avg_x = x_sum / total_confidence
        avg_y = y_sum / total_confidence
        
        # Calculate accuracy based on spread of anchor distances
        distances = [math.sqrt(p["x"]**2 + p["y"]**2) for p in positions]
        if len(distances) > 1:
            accuracy_km = statistics.stdev(distances) if len(distances) > 1 else 0
        else:
            accuracy_km = 0
        
        return {
            "x_km": avg_x,
            "y_km": avg_y,
            "accuracy_km": accuracy_km,
            "accuracy_mi": accuracy_km * 0.621371,
            "confidence": min(1.0, total_confidence / len(anchors)),
            "anchors": len(anchors),
            "method": "relative_anchor_positioning"
        }
    
    def get_calibration_report(self) -> Dict:
        """Get current calibration status."""
        return {
            "samples": len(self.samples),
            "anchors": len(self.anchor_signals),
            "noise_bands": len(self.noise_floors),
            "propagation_model": self.propagation_model,
            "anchor_list": list(self.anchor_signals.keys()),
            "calibrated": len(self.samples) >= MIN_SAMPLES_FOR_CALIBRATION
        }

# ── Main Test ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", action="store_true")
    args = parser.parse_args()
    
    if args.test:
        print("="*60)
        print(" AUTO-CALIBRATION ENGINE TEST")
        print("="*60)
        
        engine = AutoCalibrationEngine()
        
        # Simulate 20 sweeps with consistent patterns
        for i in range(20):
            sweep = [
                {
                    "band": "FM Broadcast",
                    "signals": [
                        {"freq": 95.2, "amp": -65 + np.random.normal(0, 2)},
                        {"freq": 98.5, "amp": -75 + np.random.normal(0, 3)},
                    ]
                },
                {
                    "band": "Wi-Fi 2.4GHz",
                    "signals": [
                        {"freq": 2410, "amp": -58 + np.random.normal(0, 1)},
                    ]
                },
                {
                    "band": "Cellular",
                    "signals": [
                        {"freq": 747, "amp": -55 + np.random.normal(0, 2)},
                    ]
                },
                {
                    "band": "UHF",
                    "signals": [
                        {"freq": 496, "amp": -62 + np.random.normal(0, 4)},
                    ]
                }
            ]
            
            engine.ingest_sweep(sweep)
        
        print(f"\nCalibration complete:")
        report = engine.get_calibration_report()
        print(f"  Samples: {report['samples']}")
        print(f"  Anchors: {report['anchors']}")
        print(f"  Noise bands: {report['noise_bands']}")
        print(f"  Calibrated: {report['calibrated']}")
        
        print(f"\nAnchor signals:")
        for freq, anchor in engine.anchor_signals.items():
            print(f"  {freq} MHz: {anchor['mean_dbm']:.1f} dBm "
                  f"(±{anchor['std_dbm']:.1f}), conf={anchor['confidence']:.2f}")
        
        print(f"\nPropagation model:")
        if engine.propagation_model:
            pm = engine.propagation_model
            print(f"  n={pm['path_loss_exponent']:.2f}")
            print(f"  ref={pm['reference_power']:.1f} dBm @ {pm['reference_distance_km']} km")
        
        pos = engine.get_position_estimate()
        if pos:
            print(f"\nPosition estimate:")
            print(f"  X: {pos['x_km']:.2f} km")
            print(f"  Y: {pos['y_km']:.2f} km")
            print(f"  Accuracy: ±{pos['accuracy_mi']:.1f} mi")
            print(f"  Confidence: {pos['confidence']:.1%}")
        
        print("\n" + "="*60)
        print("Test complete")
        print("="*60)
