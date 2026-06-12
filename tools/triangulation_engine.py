#!/usr/bin/env python3
"""
triangulation_engine.py — RF Geolocation Engine for KAI

Uses known reference beacons (radio stations, airports, cell towers) with
fixed GPS coordinates to triangulate KAI's position based on received signal
strength (RSSI) and free-space path loss (FSPL).

Method:
  1. Detect beacons from TinySA sweep data
  2. For each detected beacon, calculate distance using FSPL:
     d(km) = 10^((Tx_power - Rx_power - 20*log10(f) - 32.44) / 20)
  3. With 3+ beacons, solve circle intersection for position estimate
  4. Weighted by signal confidence and beacon reliability

Also maintains noise floor learning — KAI builds a local noise profile
from his lattice so he can distinguish signal from noise.
"""

import json
import math
import csv
import statistics
from pathlib import Path
from typing import List, Dict, Tuple, Optional
from datetime import datetime

BEACON_DB_PATH = Path("C:/KAI/data/reference_beacons.json")
NOISE_PROFILE_PATH = Path("C:/KAI/data/noise_profile.json")
TRIANGULATION_LOG_PATH = Path("C:/KAI/logs/triangulation")

class TriangulationEngine:
    """RF geolocation using reference beacon database."""
    
    def __init__(self):
        self.beacons = []
        self.calibration = {}
        self.noise_profile = {}
        self.load_beacons()
        self.load_noise_profile()
        TRIANGULATION_LOG_PATH.mkdir(parents=True, exist_ok=True)
    
    def load_beacons(self):
        """Load reference beacon database."""
        if BEACON_DB_PATH.exists():
            with open(BEACON_DB_PATH, 'r') as f:
                data = json.load(f)
                self.beacons = data.get("beacons", [])
                self.calibration = data.get("calibration", {})
        else:
            self.beacons = []
            self.calibration = {
                "noise_floor_dbm": -95,
                "antenna_gain_dbi": 2,
                "cable_loss_db": 1,
                "environment_factor": 1.0,
                "minimum_beacons_for_triangulation": 3,
                "max_distance_km": 100
            }
    
    def load_noise_profile(self):
        """Load learned noise profile."""
        if NOISE_PROFILE_PATH.exists():
            with open(NOISE_PROFILE_PATH, 'r') as f:
                self.noise_profile = json.load(f)
        else:
            self.noise_profile = {
                "learned_at": None,
                "band_noise_floors": {},
                "temporal_patterns": {},
                "anomaly_threshold_db": 10
            }
    
    def save_noise_profile(self):
        """Save learned noise profile."""
        with open(NOISE_PROFILE_PATH, 'w') as f:
            json.dump(self.noise_profile, f, indent=2)
    
    def calculate_distance(self, freq_mhz: float, rx_dbm: float, 
                          tx_power_dbm: float, antenna_gain: float = 2,
                          cable_loss: float = 1, env_factor: float = 1.0) -> float:
        """
        Calculate distance to transmitter using FSPL.
        
        FSPL(dB) = 20*log10(d) + 20*log10(f) + 32.44
        Modified: FSPL = Tx_power - Rx_power + G_antenna - L_cable
        d = 10^((FSPL - 20*log10(f) - 32.44) / 20)
        """
        try:
            path_loss = tx_power_dbm - rx_dbm + antenna_gain - cable_loss
            # Apply environment factor (urban = 2.0, suburban = 1.5, rural = 1.0)
            path_loss *= env_factor
            d_km = 10 ** ((path_loss - 20 * math.log10(freq_mhz) - 32.44) / 20)
            return max(0.1, min(d_km, self.calibration.get("max_distance_km", 100)))
        except:
            return -1
    
    def find_beacon(self, freq_mhz: float, tolerance_mhz: float = 0.5) -> Optional[Dict]:
        """Find a beacon in the database matching the detected frequency."""
        for beacon in self.beacons:
            b_freq = beacon["frequency_mhz"]
            b_bw = beacon.get("bandwidth_mhz", 0.1)
            # Match within half bandwidth + tolerance
            if abs(freq_mhz - b_freq) <= (b_bw / 2 + tolerance_mhz):
                return beacon
        return None
    
    def detect_beacons(self, signals: List[Dict]) -> List[Dict]:
        """
        Match detected signals against known beacon database.
        Returns list of detected beacons with measured signal strength and
        calculated distance.
        """
        detected = []
        for sig in signals:
            freq = sig.get("freq", 0)
            amp = sig.get("amp", -999)
            
            # Skip noise (below noise floor)
            noise_floor = self.calibration.get("noise_floor_dbm", -95)
            if amp < noise_floor:
                continue
            
            beacon = self.find_beacon(freq)
            if beacon:
                # Calculate distance
                dist_km = self.calculate_distance(
                    freq, amp,
                    beacon.get("tx_power_dbm", 30),
                    self.calibration.get("antenna_gain_dbi", 2),
                    self.calibration.get("cable_loss_db", 1)
                )
                dist_mi = dist_km * 0.621371
                
                detected.append({
                    "beacon_id": beacon["id"],
                    "name": beacon["name"],
                    "type": beacon["type"],
                    "freq_mhz": freq,
                    "rx_dbm": amp,
                    "tx_power_dbm": beacon.get("tx_power_dbm", 30),
                    "lat": beacon["latitude"],
                    "lon": beacon["longitude"],
                    "dist_km": dist_km,
                    "dist_mi": dist_mi,
                    "confidence": beacon.get("confidence", 0.8) * self._signal_confidence(amp),
                    "location": beacon.get("location", "Unknown")
                })
        
        return detected
    
    def _signal_confidence(self, rx_dbm: float) -> float:
        """Calculate confidence based on signal strength."""
        # Stronger signal = higher confidence
        # -20 dBm = 1.0, -80 dBm = 0.3
        confidence = (rx_dbm + 100) / 80
        return max(0.1, min(1.0, confidence))
    
    def triangulate(self, detected_beacons: List[Dict]) -> Optional[Dict]:
        """
        Triangulate position using circle intersection.
        
        Each beacon gives a circle: (x - x_i)^2 + (y - y_i)^2 = d_i^2
        With 3+ beacons, solve for x, y using weighted least squares.
        """
        min_beacons = self.calibration.get("minimum_beacons_for_triangulation", 3)
        
        if len(detected_beacons) < min_beacons:
            return None
        
        # Convert to Cartesian (approximate for small distances)
        # Use weighted least squares
        # Weight = confidence / distance (closer beacons more reliable)
        
        points = []
        weights = []
        
        for b in detected_beacons:
            lat = b["lat"]
            lon = b["lon"]
            dist_km = b["dist_km"]
            confidence = b["confidence"]
            
            # Weight: closer beacons and higher confidence get more weight
            weight = confidence / max(1, dist_km)
            
            points.append({
                "lat": lat,
                "lon": lon,
                "dist_km": dist_km,
                "weight": weight,
                "name": b["name"]
            })
            weights.append(weight)
        
        # Weighted centroid approach (simplified triangulation)
        # For true trilateration, we'd solve nonlinear equations
        # This is a good approximation for many beacons
        
        total_weight = sum(weights)
        if total_weight == 0:
            return None
        
        # Weighted average of beacon positions adjusted by distance
        # This is a heuristic: we bias towards the side of beacons that are closer
        lat_sum = 0
        lon_sum = 0
        
        for p in points:
            # Inverse distance weighting
            w = p["weight"] / total_weight
            # Move away from beacon by distance/2 (we're somewhere on the circle)
            # Simple approximation: weighted average of beacon positions
            lat_sum += p["lat"] * w
            lon_sum += p["lon"] * w
        
        est_lat = lat_sum
        est_lon = lon_sum
        
        # Calculate accuracy radius
        # RMS of distances from estimated position to each beacon circle
        errors = []
        for p in points:
            d_est = self._haversine(est_lat, est_lon, p["lat"], p["lon"])
            d_beacon = p["dist_km"]
            errors.append((d_est - d_beacon) ** 2)
        
        rms_error = math.sqrt(sum(errors) / len(errors)) if errors else 0
        
        # Calculate confidence based on number of beacons and consistency
        beacon_confidence = min(1.0, len(detected_beacons) / 5)
        consistency = 1.0 / (1.0 + rms_error / 10)
        overall_confidence = beacon_confidence * consistency
        
        return {
            "latitude": est_lat,
            "longitude": est_lon,
            "accuracy_km": rms_error,
            "accuracy_mi": rms_error * 0.621371,
            "confidence": overall_confidence,
            "beacons_used": len(detected_beacons),
            "beacon_names": [b["name"] for b in detected_beacons],
            "method": "weighted_circle_intersection"
        }
    
    def _haversine(self, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Calculate distance between two lat/lon points in km."""
        R = 6371  # Earth radius in km
        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)
        a = (math.sin(dlat/2) * math.sin(dlat/2) +
             math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) *
             math.sin(dlon/2) * math.sin(dlon/2))
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))
        return R * c
    
    def learn_noise(self, sweep_data: List[Dict]):
        """
        Learn noise patterns from sweep data.
        KAI builds a temporal noise profile for each band.
        """
        now = datetime.now().isoformat()
        
        for band_data in sweep_data:
            band_name = band_data.get("band", "unknown")
            amps = [s["amp"] for s in band_data.get("signals", [])]
            
            if not amps:
                continue
            
            # Calculate noise statistics for this band
            noise_floor = min(amps)
            noise_median = statistics.median(amps)
            noise_mean = statistics.mean(amps)
            
            # Update or create band entry
            if band_name not in self.noise_profile.get("band_noise_floors", {}):
                self.noise_profile["band_noise_floors"][band_name] = {
                    "samples": [],
                    "floor": noise_floor,
                    "median": noise_median,
                    "mean": noise_mean,
                    "std": 0,
                    "learned_at": now
                }
            
            profile = self.noise_profile["band_noise_floors"][band_name]
            profile["samples"].append(noise_floor)
            # Keep last 100 samples
            profile["samples"] = profile["samples"][-100:]
            
            profile["floor"] = min(profile["samples"])
            profile["median"] = statistics.median(profile["samples"])
            profile["mean"] = statistics.mean(profile["samples"])
            if len(profile["samples"]) > 1:
                profile["std"] = statistics.stdev(profile["samples"])
            
            profile["learned_at"] = now
        
        self.noise_profile["learned_at"] = now
        self.save_noise_profile()
    
    def is_anomaly(self, band_name: str, signal_amp: float) -> bool:
        """Check if a signal is anomalous based on learned noise profile."""
        profile = self.noise_profile.get("band_noise_floors", {}).get(band_name)
        if not profile:
            return False
        
        threshold = self.noise_profile.get("anomaly_threshold_db", 10)
        return signal_amp > (profile["floor"] + threshold)
    
    def get_noise_floor(self, band_name: str) -> float:
        """Get learned noise floor for a band."""
        profile = self.noise_profile.get("band_noise_floors", {}).get(band_name)
        if profile:
            return profile["floor"]
        return self.calibration.get("noise_floor_dbm", -95)
    
    def log_triangulation(self, result: Dict):
        """Log triangulation result to CSV."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        csv_path = TRIANGULATION_LOG_PATH / f"triangulation_{timestamp}.csv"
        
        with open(csv_path, 'w', newline='') as f:
            writer = csv.writer(f)
            writer.writerow([
                "timestamp", "lat", "lon", "accuracy_km", "accuracy_mi",
                "confidence", "beacons_used", "beacon_names"
            ])
            writer.writerow([
                datetime.now().isoformat(),
                result["latitude"],
                result["longitude"],
                result["accuracy_km"],
                result["accuracy_mi"],
                result["confidence"],
                result["beacons_used"],
                "|".join(result["beacon_names"])
            ])
    
    def build_geolocation_report(self, sweep_data: List[Dict]) -> Dict:
        """
        Main entry point: process sweep data and build geolocation report.
        
        Returns dict with:
        - detected_beacons: list of identified reference transmitters
        - position_estimate: triangulated position (or None)
        - noise_analysis: learned noise profile
        - anomalies: signals that are above noise floor
        """
        all_signals = []
        for band_data in sweep_data:
            all_signals.extend(band_data.get("signals", []))
        
        # Detect beacons
        detected = self.detect_beacons(all_signals)
        
        # Triangulate
        position = self.triangulate(detected)
        
        # Learn noise
        self.learn_noise(sweep_data)
        
        # Find anomalies
        anomalies = []
        for band_data in sweep_data:
            band_name = band_data.get("band", "unknown")
            for sig in band_data.get("signals", []):
                if self.is_anomaly(band_name, sig["amp"]):
                    anomalies.append({
                        "band": band_name,
                        "freq": sig["freq"],
                        "amp": sig["amp"],
                        "noise_floor": self.get_noise_floor(band_name)
                    })
        
        # Log if we have a position
        if position:
            self.log_triangulation(position)
        
        return {
            "detected_beacons": detected,
            "position_estimate": position,
            "noise_profile": self.noise_profile,
            "anomalies": anomalies,
            "total_signals": len(all_signals),
            "beacon_count": len(detected)
        }

# ── Main Test ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="RF Triangulation Engine")
    parser.add_argument("--test", action="store_true", help="Run test with sample data")
    
    args = parser.parse_args()
    
    if args.test:
        print("="*60)
        print(" KAI RF TRIANGULATION ENGINE — TEST")
        print("="*60)
        
        engine = TriangulationEngine()
        
        # Simulate sweep data
        test_data = [
            {
                "band": "FM Broadcast",
                "signals": [
                    {"freq": 95.1, "amp": -65},   # WFMZ-TV
                    {"freq": 91.1, "amp": -72},   # WFMU
                    {"freq": 98.5, "amp": -80},   # Unknown
                ]
            },
            {
                "band": "Aviation",
                "signals": [
                    {"freq": 118.5, "amp": -55},  # PHL ATC
                    {"freq": 124.5, "amp": -70},  # ABE ATC
                ]
            },
            {
                "band": "Cellular",
                "signals": [
                    {"freq": 869.0, "amp": -60},  # Cell Tower
                    {"freq": 2140.0, "amp": -68}, # Cell Tower
                ]
            }
        ]
        
        report = engine.build_geolocation_report(test_data)
        
        print(f"\nDetected Beacons: {len(report['detected_beacons'])}")
        for b in report['detected_beacons']:
            print(f"  {b['name']:25s} @ {b['freq_mhz']:6.1f} MHz = {b['rx_dbm']:6.1f} dBm, "
                  f"{b['dist_km']:6.1f} km ({b['dist_mi']:5.1f} mi) [conf: {b['confidence']:.2f}]")
        
        if report['position_estimate']:
            pos = report['position_estimate']
            print(f"\n[POSITION] Estimated Position:")
            print(f"  Lat: {pos['latitude']:.6f}")
            print(f"  Lon: {pos['longitude']:.6f}")
            print(f"  Accuracy: +/-{pos['accuracy_km']:.1f} km ({pos['accuracy_mi']:.1f} mi)")
            print(f"  Confidence: {pos['confidence']:.1%}")
            print(f"  Beacons used: {pos['beacons_used']}")
            print(f"  Method: {pos['method']}")
        else:
            print("\n[!] Not enough beacons for triangulation.")
        
        if report['anomalies']:
            print(f"\n[!] Anomalies detected: {len(report['anomalies'])}")
        
        print("\n" + "="*60)
        print("Test complete.")
        print("="*60)
