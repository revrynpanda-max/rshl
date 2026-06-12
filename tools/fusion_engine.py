#!/usr/bin/env python3
"""
fusion_engine.py — Multi-Sensor Fusion for KAI

Correlates data from multiple sensory inputs:
  1. TinySA Ultra (RF spectrum)
  2. RF Camera (thermal/RF vision)
  3. Visual Camera (normal vision)
  4. Triangulation Engine (geolocation)

Fusion Logic:
  - Cross-reference RF hotspots with visual detection
  - Correlate RF spectrum peaks with thermal signatures
  - Build environmental awareness map
  - Detect anomalies across sensor modalities
  - Generate KAI's "situational awareness" report

Output: Discord embeds and KAI memory entries showing the fused view.
"""

import json
import urllib.request
import os
from datetime import datetime
from typing import Dict, List, Optional
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────────
KAI_STORE_URL = "http://127.0.0.1:3334/api/rshl/store"
DISCORD_API_BASE = "https://discord.com/api/v10"
DISCORD_CHANNEL_ID = "1513582425446289658"

# ── Sensor Fusion Core ───────────────────────────────────────────────────

class SensorFusion:
    """Fuses data from multiple sensors into a unified awareness report."""
    
    def __init__(self):
        self.discord_token = os.environ.get("ORACLE_DISCORD_TOKEN_KAI", "")
        self.last_rf_spectrum = None
        self.last_rf_camera = None
        self.last_visual_camera = None
        self.last_position = None
        
    def ingest_rf_spectrum(self, spectrum_data: Dict):
        """Ingest TinySA spectrum sweep data."""
        self.last_rf_spectrum = {
            "timestamp": datetime.now().isoformat(),
            "peak_freq": spectrum_data.get("peak_freq", 0),
            "peak_amp": spectrum_data.get("peak_amp", -999),
            "signals": spectrum_data.get("signals", []),
            "classification": spectrum_data.get("classification", "Unknown"),
            "category": spectrum_data.get("category", "unknown")
        }
    
    def ingest_rf_camera(self, camera_data: Dict):
        """Ingest RF/thermal camera analysis."""
        self.last_rf_camera = {
            "timestamp": datetime.now().isoformat(),
            "hotspot_count": camera_data.get("hotspot_count", 0),
            "hotspots": camera_data.get("hotspots", []),
            "mean_temp": camera_data.get("mean_temp", 0),
            "motion_score": camera_data.get("motion_score", 0),
            "frame_path": camera_data.get("frame_path", "")
        }
    
    def ingest_visual_camera(self, visual_data: Dict):
        """Ingest visual camera data."""
        self.last_visual_camera = {
            "timestamp": datetime.now().isoformat(),
            "brightness": visual_data.get("brightness", 0),
            "motion": visual_data.get("motion", False),
            "objects": visual_data.get("objects", []),
            "presence": visual_data.get("presence", False)
        }
    
    def ingest_position(self, position_data: Dict):
        """Ingest triangulation position estimate."""
        self.last_position = position_data
    
    def correlate_sensors(self) -> Dict:
        """
        Cross-reference all sensors to find correlations.
        
        Examples:
        - RF hotspot + visual motion = likely person/device
        - Spectrum peak + thermal signature = active transmitter
        - Multiple hotspots + no RF = passive heat source
        """
        correlations = []
        
        if not self.last_rf_camera or not self.last_rf_spectrum:
            return {"correlations": [], "confidence": 0}
        
        # Correlation 1: RF spectrum + thermal.
        # This is a powered-device lead, not an identity claim.
        if (self.last_rf_spectrum["peak_amp"] > -50 and 
            self.last_rf_camera["hotspot_count"] > 0):
            correlations.append({
                "type": "possible_powered_rf_source",
                "confidence": 0.55,
                "description": f"Strong RF signal ({self.last_rf_spectrum['peak_freq']/1e6:.1f} MHz, "
                              f"{self.last_rf_spectrum['peak_amp']:.1f} dBm) "
                              f"correlated with {self.last_rf_camera['hotspot_count']} thermal hotspots. "
                              f"Possible powered RF source. Verify against baseline and known devices.",
                "sensors": ["tinysa", "rf_camera"]
            })
        
        # Correlation 2: Thermal + motion + no RF = passive heat source
        if (self.last_rf_camera["hotspot_count"] > 0 and 
            self.last_rf_camera["motion_score"] > 0.1 and
            self.last_rf_spectrum["peak_amp"] < -60):
            correlations.append({
                "type": "passive_heat_source",
                "confidence": 0.6,
                "description": f"Thermal motion detected ({self.last_rf_camera['hotspot_count']} hotspots, "
                              f"motion {self.last_rf_camera['motion_score']:.2f}) with weak RF background. "
                              f"Possible person or passive heat source.",
                "sensors": ["rf_camera"]
            })
        
        # Correlation 3: Visual + RF = security-relevant correlation.
        if (self.last_visual_camera and 
            self.last_visual_camera.get("presence") and
            self.last_rf_spectrum["peak_amp"] > -40):
            correlations.append({
                "type": "security_correlated_rf",
                "confidence": 0.6,
                "description": f"Visual presence detected with strong RF signal "
                              f"({self.last_rf_spectrum['peak_freq']/1e6:.1f} MHz, "
                              f"{self.last_rf_spectrum['peak_amp']:.1f} dBm). "
                              f"Security-relevant RF correlation; not proof of a camera or transmitter.",
                "sensors": ["visual_camera", "tinysa"]
            })
        
        # Correlation 4: No thermal + strong RF = unclassified RF anomaly.
        if (self.last_rf_camera["hotspot_count"] == 0 and 
            self.last_rf_spectrum["peak_amp"] > -50):
            correlations.append({
                "type": "unclassified_strong_rf",
                "confidence": 0.35,
                "description": f"Strong RF signal detected ({self.last_rf_spectrum['peak_freq']/1e6:.1f} MHz) "
                              f"but no thermal signature. Could be external broadcast, normal network traffic, "
                              f"or an unknown emitter. Baseline is required before escalation.",
                "sensors": ["tinysa", "rf_camera"]
            })
        
        return {
            "correlations": correlations,
            "confidence": max([c["confidence"] for c in correlations], default=0),
            "timestamp": datetime.now().isoformat()
        }
    
    def build_awareness_report(self) -> Dict:
        """
        Build KAI's situational awareness report.
        
        This is the main output — a comprehensive view of KAI's environment
        based on all available sensors.
        """
        report = {
            "timestamp": datetime.now().isoformat(),
            "sensors_active": [],
            "rf_spectrum": self.last_rf_spectrum,
            "rf_camera": self.last_rf_camera,
            "visual_camera": self.last_visual_camera,
            "position": self.last_position,
            "correlations": [],
            "anomalies": [],
            "environment_summary": ""
        }
        
        # Track active sensors
        if self.last_rf_spectrum:
            report["sensors_active"].append("tinysa")
        if self.last_rf_camera:
            report["sensors_active"].append("rf_camera")
        if self.last_visual_camera:
            report["sensors_active"].append("visual_camera")
        if self.last_position:
            report["sensors_active"].append("triangulation")
        
        # Correlate
        correlations = self.correlate_sensors()
        report["correlations"] = correlations["correlations"]
        
        # Build summary
        summary_parts = []
        
        if self.last_rf_spectrum:
            peak_mhz = self.last_rf_spectrum["peak_freq"] / 1e6
            summary_parts.append(
                f"RF spectrum peak: {peak_mhz:.1f} MHz at {self.last_rf_spectrum['peak_amp']:.1f} dBm "
                f"({self.last_rf_spectrum['classification']})"
            )
        
        if self.last_rf_camera:
            summary_parts.append(
                f"RF camera: {self.last_rf_camera['hotspot_count']} hotspots, "
                f"motion {self.last_rf_camera['motion_score']:.2f}"
            )
        
        if self.last_position:
            pos = self.last_position
            summary_parts.append(
                f"Position estimate: {pos['latitude']:.4f}, {pos['longitude']:.4f} "
                f"(+/-{pos['accuracy_mi']:.1f} mi confidence)"
            )
        
        if correlations["correlations"]:
            best = max(correlations["correlations"], key=lambda x: x["confidence"])
            summary_parts.append(f"Primary correlation: {best['type']} ({best['confidence']:.0%})")
        
        report["environment_summary"] = " | ".join(summary_parts)
        
        return report
    
    def build_discord_hud(self, report: Dict) -> Dict:
        """
        Build a Discord embed showing KAI's HUD (Head-Up Display).
        
        This is KAI's 'view' of the world — what he sees through all sensors.
        """
        # Determine overall status color
        if any(c["type"] == "security_correlated_rf" for c in report["correlations"]):
            color = 0xFF0000  # Red
            status = "SECURITY RF CORRELATION"
        elif any(c["type"] == "possible_powered_rf_source" for c in report["correlations"]):
            color = 0xFFA500  # Orange
            status = "POWERED RF LEAD"
        elif report["correlations"]:
            color = 0xFFFF00  # Yellow
            status = "CORRELATIONS FOUND"
        else:
            color = 0x00FF00  # Green
            status = "NOMINAL"
        
        fields = []
        
        # RF Spectrum
        if report["rf_spectrum"]:
            rf = report["rf_spectrum"]
            fields.append({
                "name": "RF Spectrum",
                "value": f"Peak: {rf['peak_freq']/1e6:.1f} MHz\n"
                        f"Strength: {rf['peak_amp']:.1f} dBm\n"
                        f"Class: {rf['classification']}",
                "inline": True
            })
        
        # RF Camera
        if report["rf_camera"]:
            rc = report["rf_camera"]
            fields.append({
                "name": "RF Camera (Thermal)",
                "value": f"Hotspots: {rc['hotspot_count']}\n"
                        f"Mean temp: {rc['mean_temp']:.2f}\n"
                        f"Motion: {rc['motion_score']:.2f}",
                "inline": True
            })
        
        # Position
        if report["position"]:
            pos = report["position"]
            fields.append({
                "name": "Position Estimate",
                "value": f"Lat: {pos['latitude']:.4f}\n"
                        f"Lon: {pos['longitude']:.4f}\n"
                        f"Accuracy: +/-{pos['accuracy_mi']:.1f} mi",
                "inline": True
            })
        
        # Correlations
        if report["correlations"]:
            corr_text = []
            for c in report["correlations"][:3]:
                emoji = {
                    "active_transmitter": "📡",
                    "passive_heat_source": "🌡️",
                    "surveillance_anomaly": "⚠️",
                    "hidden_transmitter": "👻"
                }.get(c["type"], "🔍")
                corr_text.append(f"{emoji} {c['type']}: {c['confidence']:.0%}")
            
            fields.append({
                "name": "Sensor Correlations",
                "value": "\n".join(corr_text) if corr_text else "None",
                "inline": False
            })
        
        embed = {
            "title": f"KAI SENSORY HUD — {status}",
            "description": report["environment_summary"],
            "color": color,
            "fields": fields,
            "footer": {
                "text": f"Sensors: {', '.join(report['sensors_active'])} | "
                       f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
            }
        }
        
        return embed
    
    def post_to_discord(self, report: Dict):
        """Post the HUD to Discord."""
        if not self.discord_token:
            return
        
        embed = self.build_discord_hud(report)
        
        url = f"{DISCORD_API_BASE}/channels/{DISCORD_CHANNEL_ID}/messages"
        headers = {
            "Authorization": f"Bot {self.discord_token}",
            "Content-Type": "application/json"
        }
        payload = {"embeds": [embed]}
        
        try:
            req = urllib.request.Request(
                url, data=json.dumps(payload).encode(),
                headers=headers, method="POST"
            )
            urllib.request.urlopen(req, timeout=10)
        except Exception as e:
            print(f"[Fusion] Discord post failed: {e}")
    
    def store_in_kai(self, report: Dict):
        """Store the awareness report in KAI's memory."""
        try:
            text = f"SENSORY FUSION: {report['environment_summary']}"
            req = urllib.request.Request(
                KAI_STORE_URL,
                data=json.dumps({
                    "text": text,
                    "region": "perception",
                    "source": "fusion_engine",
                    "strength": min(1.0, len(report['correlations']) * 0.3 + 0.2)
                }).encode(),
                headers={"Content-Type": "application/json"}
            )
            urllib.request.urlopen(req, timeout=5)
        except Exception as e:
            print(f"[Fusion] KAI store failed: {e}")
    
    def process_and_report(self, spectrum_data: Dict = None, 
                          rf_camera_data: Dict = None,
                          visual_data: Dict = None,
                          position_data: Dict = None):
        """
        Main entry point: ingest all available data and generate report.
        
        Args:
            spectrum_data: TinySA sweep results
            rf_camera_data: RF camera analysis
            visual_data: Visual camera data
            position_data: Triangulation position estimate
        
        Returns:
            Awareness report dict
        """
        if spectrum_data:
            self.ingest_rf_spectrum(spectrum_data)
        if rf_camera_data:
            self.ingest_rf_camera(rf_camera_data)
        if visual_data:
            self.ingest_visual_camera(visual_data)
        if position_data:
            self.ingest_position(position_data)
        
        # Build report
        report = self.build_awareness_report()
        
        # Store and post
        self.store_in_kai(report)
        self.post_to_discord(report)
        
        return report

# ── Main ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("="*60)
    print(" KAI SENSOR FUSION ENGINE")
    print("="*60)
    
    fusion = SensorFusion()
    
    # Test with sample data
    test_spectrum = {
        "peak_freq": 95000000,
        "peak_amp": -55,
        "signals": [{"freq": 95.0, "amp": -55}],
        "classification": "FM Radio Broadcast",
        "category": "broadcast"
    }
    
    test_rf_camera = {
        "hotspot_count": 3,
        "hotspots": [{"x": 50, "y": 50, "w": 20, "h": 20, "intensity": 0.8}],
        "mean_temp": 0.65,
        "motion_score": 0.15,
        "frame_path": ""
    }
    
    test_visual = {
        "brightness": 0.5,
        "motion": True,
        "objects": ["person"],
        "presence": True
    }
    
    test_position = {
        "latitude": 40.6782,
        "longitude": -75.4101,
        "accuracy_km": 5.0,
        "accuracy_mi": 3.1,
        "confidence": 0.7,
        "beacons_used": 4,
        "beacon_names": ["WFMZ-TV", "Cell Tower", "ATC"],
        "method": "weighted_circle_intersection"
    }
    
    report = fusion.process_and_report(
        spectrum_data=test_spectrum,
        rf_camera_data=test_rf_camera,
        visual_data=test_visual,
        position_data=test_position
    )
    
    print(f"\nGenerated report:")
    print(f"  Active sensors: {report['sensors_active']}")
    print(f"  Correlations: {len(report['correlations'])}")
    print(f"  Summary: {report['environment_summary']}")
    
    print("\n" + "="*60)
    print("Test complete.")
    print("="*60)
