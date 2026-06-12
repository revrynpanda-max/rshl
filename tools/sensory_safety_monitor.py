#!/usr/bin/env python3
"""
sensory_safety_monitor.py
Watches phone sensory anomalies (from bridge) and lattice.
- Low-duty beacon mode (snapshots on schedule or on-demand).
- Detects elevated risk patterns (accident, fall, thrown phone, etc.).
- Logs to lattice for Kai learning (Hebbian / bone healing style).
- If high risk: writes pending emergency for Oracle to DM Taz.
Run alongside the phone bridge (e.g. via sensor_watchdog or keep-alive).
"""
import json
import time
from pathlib import Path
from datetime import datetime, timezone

ANOMALY_LOG = Path("C:/KAI/logs/phone_sensory_anomalies.jsonl")
LATTICE_STORE = "http://127.0.0.1:3334/api/rshl/store"  # if main server up
PENDING_EMERGENCY = Path("C:/KAI/state/pending_taz_emergency.json")
TAZ_DISCORD_ID = None  # set in state or env; e.g. from user_registry or manual

def load_config():
    cfg_path = Path("C:/KAI/state/phone_sensor_connection.json")
    if cfg_path.exists():
        return json.loads(cfg_path.read_text())
    return {}

def utc_now():
    return datetime.now(timezone.utc).isoformat()

def store_to_lattice(event: dict):
    """Store anomaly/safety event so Kai learns patterns over time."""
    try:
        import urllib.request
        body = json.dumps({
            "texts": [json.dumps(event)],
            "region": "phone_sensory_safety",
            "source": "sensory_safety_monitor",
            "strength": 2.0 if event.get("is_elevated") else 1.0
        }).encode()
        req = urllib.request.Request(LATTICE_STORE, data=body, headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        print(f"[SafetyMonitor] Lattice store skipped: {e}")

def check_anomalies():
    if not ANOMALY_LOG.exists():
        return []
    events = []
    try:
        with ANOMALY_LOG.open() as f:
            for line in f:
                if line.strip():
                    events.append(json.loads(line))
    except Exception:
        pass
    return events[-50:]  # recent window

def compute_risk(events):
    if not events:
        return 0.0, []
    score = 0.0
    reasons = []
    for e in events:
        s = e.get("anomaly_score", 0)
        score += s
        if e.get("reasons"):
            reasons.extend(e["reasons"])
    # Simple aggregation + decay for "elevated"
    avg = score / max(1, len(events))
    elevated = avg > 0.4 or len([r for r in reasons if "spike" in r or "rotation" in r]) >= 2
    return round(avg, 3), list(set(reasons)) if elevated else []

def escalate_if_needed(risk_score, reasons, latest_telemetry):
    if risk_score < 0.5:
        return
    emergency = {
        "ts": utc_now(),
        "risk_score": risk_score,
        "reasons": reasons,
        "latest_telemetry": latest_telemetry,
        "action": "DM_Taz_with_context_and_ask_user_status",
        "status": "pending"
    }
    PENDING_EMERGENCY.parent.mkdir(parents=True, exist_ok=True)
    PENDING_EMERGENCY.write_text(json.dumps(emergency, indent=2))
    print(f"[SafetyMonitor] HIGH RISK ({risk_score}) — wrote pending emergency for Taz. Reasons: {reasons}")

def main_loop():
    print("[SafetyMonitor] Beacon + Anomaly Safety Monitor started (low-duty, learns from patterns).")
    cfg = load_config()
    last_check = 0
    while True:
        now = time.time()
        if now - last_check > 15:  # check every 15s (cheap)
            events = check_anomalies()
            risk, reasons = compute_risk(events)
            latest = {}
            try:
                latest = json.loads(Path("C:/KAI/state/phone_sensor_latest.json").read_text())
            except:
                pass
            if reasons:
                store_to_lattice({"type": "sensory_anomaly", "risk": risk, "reasons": reasons, "ts": utc_now()})
                escalate_if_needed(risk, reasons, latest)
            last_check = now
        time.sleep(5)

if __name__ == "__main__":
    main_loop()
