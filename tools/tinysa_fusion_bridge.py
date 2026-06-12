#!/usr/bin/env python3
"""
tinysa_fusion_bridge.py — Integrated RF Intelligence + Triangulation + Fusion

This is the enhanced version of tinysa_discord_bridge.py that adds:
  - Reference beacon triangulation (true geolocation via known transmitters)
  - Multi-sensor fusion (RF camera + visual + spectrum)
  - Noise learning and pattern recognition
  - On-demand RF vision command interface

Usage:
    python tinysa_fusion_bridge.py --headless
    python tinysa_fusion_bridge.py --port COM6 --discord-channel 1513582425446289658

Command Interface (via Discord or KAI API):
    "KAI, enable RF vision"    -> Activates RF camera + full spectrum sweeps
    "KAI, disable RF vision"   -> Deactivates, returns to normal
    "KAI, scan [band]"          -> One-shot sweep of specific band
    "KAI, where am I?"         -> Request triangulation report
"""

import sys
import os
import time
import json
import urllib.request
import threading
from pathlib import Path
from datetime import datetime

# Import existing bridge components
sys.path.insert(0, str(Path(__file__).parent))

from tinysa_discord_bridge import (
    read_until_prompt, send_cmd, fetch_data,
    classify_signal, estimate_distance_miles,
    build_discord_embed, build_kai_message,
    log_sweep, init_sweep_csv, store_in_kai_memory,
    post_discord_embed, post_discord_message,
    find_tinysa_port, TARGET_BAUD, KAI_STORE_URL, DISCORD_CHANNEL_ID
)

from triangulation_engine import TriangulationEngine
from fusion_engine import SensorFusion

# ── Configuration ──────────────────────────────────────────────────────────
DISCORD_API_BASE = "https://discord.com/api/v10"
RF_VISION_ENABLED = False  # Default: off (user must ask KAI to enable)
RF_CAMERA_BRIDGE_SCRIPT = "C:/KAI/tools/rf_camera_bridge.py"

# ── Command Interface ─────────────────────────────────────────────────────

class RFCommandInterface:
    """
    Handles on-demand commands from KAI or Discord.
    
    Commands:
    - enable_rf_vision: Start RF camera + full spectrum sweeps
    - disable_rf_vision: Stop RF camera
    - scan_band: One-shot sweep
    - triangulate: Report position estimate
    """
    
    def __init__(self, bridge):
        self.bridge = bridge
        self.rf_vision_enabled = False
        self.rf_camera_process = None
    
    def handle_command(self, command: str, user_id: str = None) -> str:
        """Handle a command string. Returns response text."""
        cmd = command.lower().strip()
        
        if "enable rf" in cmd or "enable vision" in cmd or "turn on rf" in cmd:
            return self.enable_rf_vision()
        
        elif "disable rf" in cmd or "disable vision" in cmd or "turn off rf" in cmd:
            return self.disable_rf_vision()
        
        elif "where am i" in cmd or "triangulate" in cmd or "position" in cmd:
            return self.get_triangulation_report()
        
        elif "scan" in cmd:
            # Extract band name if specified
            band = None
            for b in self.bridge.SWEEP_BANDS:
                if b["name"].lower() in cmd:
                    band = b
                    break
            return self.scan_band(band)
        
        elif "status" in cmd or "what do you see" in cmd:
            return self.get_status_report()
        
        else:
            return "Available commands: enable RF vision, disable RF vision, scan [band], where am I, status"
    
    def enable_rf_vision(self) -> str:
        """Enable RF camera and full sensory fusion."""
        if self.rf_vision_enabled:
            return "RF vision is already enabled."
        
        self.rf_vision_enabled = True
        
        # Start RF camera bridge in background
        try:
            import subprocess
            self.rf_camera_process = subprocess.Popen(
                ["python", RF_CAMERA_BRIDGE_SCRIPT, "--headless", "--interval", "5"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW
            )
            return "RF vision ENABLED. RF camera + thermal + spectrum fusion active."
        except Exception as e:
            return f"RF vision enabled but camera failed: {e}"
    
    def disable_rf_vision(self) -> str:
        """Disable RF camera."""
        if not self.rf_vision_enabled:
            return "RF vision is already disabled."
        
        self.rf_vision_enabled = False
        
        if self.rf_camera_process:
            try:
                self.rf_camera_process.terminate()
                self.rf_camera_process = None
            except:
                pass
        
        return "RF vision DISABLED. Returning to normal spectrum monitoring."
    
    def get_triangulation_report(self) -> str:
        """Generate triangulation report from latest sweep data."""
        if not self.bridge.last_sweep_data:
            return "No sweep data available. Run a scan first."
        
        # Use triangulation engine
        engine = TriangulationEngine()
        report = engine.build_geolocation_report(self.bridge.last_sweep_data)
        
        if report["position_estimate"]:
            pos = report["position_estimate"]
            return (
                f"POSITION ESTIMATE:\n"
                f"  Lat: {pos['latitude']:.6f}, Lon: {pos['longitude']:.6f}\n"
                f"  Accuracy: +/-{pos['accuracy_mi']:.1f} mi\n"
                f"  Confidence: {pos['confidence']:.1%}\n"
                f"  Beacons: {pos['beacons_used']}\n"
                f"  Detected: {', '.join(pos['beacon_names'][:5])}"
            )
        else:
            return (
                f"Triangulation failed. Detected {report['beacon_count']} beacons, "
                f"but need {engine.calibration.get('minimum_beacons_for_triangulation', 3)}+ "
                f"for position estimation."
            )
    
    def scan_band(self, band=None) -> str:
        """Perform one-shot sweep of a band."""
        if band is None:
            # Default to FM broadcast
            band = {"name": "FM Broadcast", "start": 88000000, "stop": 108000000, "priority": 1}
        
        # Run sweep
        result = self.bridge.run_single_sweep(band)
        
        if result:
            return (
                f"Scan complete: {band['name']}\n"
                f"  Peak: {result['peak_freq']/1e6:.1f} MHz at {result['peak_amp']:.1f} dBm\n"
                f"  Signals: {len(result['signals'])}\n"
                f"  Classification: {result['classification']}"
            )
        else:
            return "Scan failed. Check TinySA connection."
    
    def get_status_report(self) -> str:
        """Get current status of all sensors."""
        status = "KAI SENSORY STATUS:\n"
        status += f"  RF Spectrum: {'Active' if self.bridge.ser else 'Offline'}\n"
        status += f"  RF Camera: {'Active' if self.rf_vision_enabled else 'Standby'}\n"
        status += f"  RF Vision: {'ENABLED' if self.rf_vision_enabled else 'Disabled'}\n"
        
        if self.bridge.last_sweep_data:
            status += f"  Last sweep: {len(self.bridge.last_sweep_data)} bands\n"
        
        return status


# ── Enhanced Bridge Class ─────────────────────────────────────────────────

class FusionBridge:
    """Enhanced TinySA bridge with triangulation and fusion."""
    
    def __init__(self, port="COM6", discord_channel=DISCORD_CHANNEL_ID,
                 sweep_interval=300, threshold=0.1):
        self.port = port
        self.discord_channel = discord_channel
        self.sweep_interval = sweep_interval
        self.threshold = threshold
        self.discord_token = self._get_discord_token()
        self.ser = None
        self.csv_path = None
        self.last_sweep_data = []
        self.triangulation_engine = TriangulationEngine()
        self.fusion_engine = SensorFusion()
        self.command_interface = RFCommandInterface(self)
        self.SWEEP_BANDS = None  # Will be loaded from tinysa_discord_bridge
        
    def _get_discord_token(self):
        return os.environ.get("ORACLE_DISCORD_TOKEN_KAI", "")
    
    def connect(self):
        """Connect to TinySA."""
        import serial
        try:
            self.ser = serial.Serial(self.port, TARGET_BAUD, timeout=2)
            self.ser.reset_input_buffer()
            self.ser.reset_output_buffer()
            read_until_prompt(self.ser)
            return True
        except Exception as e:
            print(f"[!] Cannot connect to TinySA: {e}")
            return False
    
    def run_single_sweep(self, band):
        """Run a single sweep and return results."""
        if not self.ser:
            return None
        
        start = band["start"]
        stop = band["stop"]
        points = 101
        
        send_cmd(self.ser, "pause")
        read_until_prompt(self.ser)
        
        send_cmd(self.ser, f"scan {start} {stop} {points}")
        read_until_prompt(self.ser)
        
        amps = fetch_data(self.ser, 0)
        
        send_cmd(self.ser, "resume")
        read_until_prompt(self.ser)
        
        if not amps:
            return None
        
        freq_step = (stop - start) / max(1, len(amps) - 1)
        signals = []
        for i, amp in enumerate(amps):
            freq = start + (i * freq_step)
            if amp > -80:
                signals.append({"freq": freq / 1e6, "amp": amp, "idx": i})
        
        peak_amp = max(amps)
        peak_idx = amps.index(peak_amp)
        peak_freq = start + (peak_idx * freq_step)
        
        freq_mhz = peak_freq / 1e6
        entry = classify_signal(freq_mhz)
        
        return {
            "band": band["name"],
            "peak_freq": peak_freq,
            "peak_amp": peak_amp,
            "signals": signals,
            "classification": entry["name"],
            "category": entry["category"]
        }
    
    def run_sweep_cycle(self):
        """Run a full sweep cycle with triangulation and fusion."""
        # Import sweep bands from original bridge
        from tinysa_discord_bridge import SWEEP_BANDS
        
        bands = sorted(SWEEP_BANDS, key=lambda b: b["priority"])
        sweep_results = []
        
        for band in bands:
            result = self.run_single_sweep(band)
            if result:
                sweep_results.append(result)
                
                # Log to CSV
                if self.csv_path:
                    log_sweep(self.csv_path, band, result["peak_freq"], 
                             result["peak_amp"], result["signals"])
                
                # Post to Discord
                embed = build_discord_embed(band, result["peak_freq"], 
                                           result["peak_amp"], result["signals"])
                post_discord_embed(self.discord_channel, embed, self.discord_token)
                
                # Store in KAI memory
                kai_msg = build_kai_message(band, result["peak_freq"], 
                                           result["peak_amp"], result["signals"])
                strength = min(1.0, (result["peak_amp"] + 100) / 80)
                store_in_kai_memory(kai_msg, "physics", "tinysa", strength)
                
                time.sleep(0.5)
        
        self.last_sweep_data = sweep_results
        
        # Run triangulation
        if sweep_results:
            triangulation_report = self.triangulation_engine.build_geolocation_report(sweep_results)
            
            # Run fusion
            # Build spectrum data for fusion
            if sweep_results:
                best = max(sweep_results, key=lambda x: x["peak_amp"])
                self.fusion_engine.process_and_report(
                    spectrum_data=best,
                    position_data=triangulation_report.get("position_estimate")
                )
            
            # Post triangulation summary to Discord
            if triangulation_report["position_estimate"]:
                pos = triangulation_report["position_estimate"]
                summary = (
                    f"📍 TRIANGULATION: Position estimate {pos['latitude']:.4f}, {pos['longitude']:.4f} "
                    f"(+/-{pos['accuracy_mi']:.1f} mi, {pos['confidence']:.1%} confidence)"
                )
                post_discord_message(self.discord_channel, summary, self.discord_token)
        
        return sweep_results
    
    def run(self):
        """Main loop."""
        print("="*60)
        print(" KAI RF FUSION BRIDGE")
        print("="*60)
        
        if not self.connect():
            print("[!] Failed to connect to TinySA. Exiting.")
            return
        
        self.csv_path = init_sweep_csv()
        print(f"[*] Sweep logging to: {self.csv_path}")
        
        # Post startup message
        if self.discord_token:
            post_discord_message(
                self.discord_channel,
                "🛰️ **KAI RF Fusion Bridge Online**\n"
                "Triangulation + multi-sensor fusion active.\n"
                "Commands: 'enable RF vision', 'where am I?', 'scan [band]'",
                self.discord_token
            )
        
        print("[*] Starting sweep cycles...")
        cycle = 0
        
        try:
            while True:
                cycle += 1
                print(f"\n[{'='*60}")
                print(f" SWEEP CYCLE #{cycle}")
                print(f"{'='*60}")
                
                self.run_sweep_cycle()
                
                print(f"\nSleeping {self.sweep_interval}s...")
                time.sleep(self.sweep_interval)
        
        except KeyboardInterrupt:
            print("\n[!] Stopped by user.")
        finally:
            if self.ser:
                send_cmd(self.ser, "resume")
                self.ser.close()
            print("[*] RF Fusion Bridge offline.")


# ── Main ─────────────────────────────────────────────────────────────────

def main():
    import argparse
    parser = argparse.ArgumentParser(description="KAI RF Fusion Bridge")
    parser.add_argument("--port", default="COM6", help="Serial port")
    parser.add_argument("--headless", action="store_true", help="Headless mode")
    parser.add_argument("--discord-channel", default=DISCORD_CHANNEL_ID, help="Discord channel")
    parser.add_argument("--sweep-interval", type=int, default=300, help="Seconds between cycles")
    
    args = parser.parse_args()
    
    bridge = FusionBridge(
        port=args.port,
        discord_channel=args.discord_channel,
        sweep_interval=args.sweep_interval
    )
    
    bridge.run()

if __name__ == "__main__":
    main()
