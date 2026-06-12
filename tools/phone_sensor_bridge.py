#!/usr/bin/env python3
"""
phone_sensor_bridge.py - phone telemetry ingress for KAI.

Default behavior is local-only. To receive data from a phone on the LAN, start
with --host 0.0.0.0 and provide a token.

Endpoints:
  GET  /health
  GET  /config
  GET  /latest
  GET  /weather?lat=40.1234&lon=-75.1234
  POST /telemetry

Telemetry example:
{
  "device_id": "phone-main",
  "timestamp": "2026-06-09T21:00:00-04:00",
  "location": {"lat": 40.1234, "lon": -75.1234, "accuracy_m": 25},
  "sensors": {
    "battery_pct": 82,
    "barometer_hpa": 1008.4,
    "accelerometer": {"x": 0.1, "y": 0.0, "z": 9.8},
    "magnetometer_ut": {"x": 12.0, "y": 4.0, "z": -42.0},
    "light_lux": 120
  }
}
"""

from __future__ import annotations

import argparse
import hmac
import ipaddress
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


KAI_STORE_URL = "http://127.0.0.1:3334/api/rshl/store"
STATE_DIR = Path("C:/KAI/state")
LOG_DIR = Path("C:/KAI/logs/phone_sensors")
LATEST_PATH = STATE_DIR / "phone_sensor_latest.json"
CONFIG_PATH = STATE_DIR / "phone_sensor_config.json"
EVENTS_PATH = LOG_DIR / "phone_sensor_events.jsonl"
PENDING_KAI_PATH = LOG_DIR / "pending_kai_memory.jsonl"
MAX_BODY_BYTES = 1024 * 1024
WEATHER_CACHE_TTL_S = 180
TAILSCALE_IPV4 = ipaddress.ip_network("100.64.0.0/10")
TAILSCALE_IPV6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")


DEFAULT_CONFIG = {
    "mode": "away_safety",  # changed to away_safety for your phone protection use (more sensors: gyro, mag, proximity, etc.)
    "sampling": {
        "normal_interval_s": 30,
        "home_guard_interval_s": 20,
        "away_safety_interval_s": 15,
        "storm_interval_s": 10,
        "security_sweep_interval_s": 5,
        "low_power_interval_s": 120,
    },
    "requested_sensors": [
        "location_coarse",
        "barometer",
        "accelerometer",
        "gyroscope",
        "magnetometer",
        "light",
        "proximity",
        "battery",
    ],
    "optional_sensors": [
        "wifi_scan_metadata",
        "ble_scan_metadata",
    ],
    "sensor_profiles": {
        "normal": {
            "role": "mobile_context_node",
            "requested_sensors": ["location_coarse", "battery", "barometer", "accelerometer"],
            "optional_sensors": ["magnetometer", "light"],
            "upload_policy": "periodic_summary",
        },
        "home_guard": {
            "role": "home_support_node",
            "requested_sensors": ["location_coarse", "battery", "barometer", "light"],
            "optional_sensors": ["accelerometer", "magnetometer", "wifi_scan_metadata", "ble_scan_metadata"],
            "upload_policy": "support_home_server_context",
        },
        "away_safety": {
            "role": "mobile_safety_node",
            "requested_sensors": [
                "location_coarse",
                "battery",
                "barometer",
                "accelerometer",
                "gyroscope",
                "magnetometer",
                "light",
                "proximity",
            ],
            "optional_sensors": ["wifi_scan_metadata", "ble_scan_metadata"],
            "upload_policy": "send_summary_plus_anomaly_events",  # now used for beacon snapshots + anomaly events only (no constant stream)
        },
        "weather_watch": {
            "role": "mobile_weather_node",
            "requested_sensors": ["location_coarse", "battery", "barometer", "accelerometer", "light"],
            "optional_sensors": ["magnetometer"],
            "upload_policy": "increase_pressure_and_motion_cadence",
        },
        "storm_watch": {
            "role": "mobile_storm_safety_node",
            "requested_sensors": [
                "location_coarse",
                "battery",
                "barometer",
                "accelerometer",
                "gyroscope",
                "magnetometer",
                "light",
            ],
            "optional_sensors": ["wifi_scan_metadata", "ble_scan_metadata"],
            "upload_policy": "high_cadence_until_alert_clears",
        },
    },
    "privacy": {
        "store_precise_location": False,
        "round_location_decimals": 4,
        "camera_requires_explicit_user_action": True,
        "microphone_requires_explicit_user_action": True,
    },
    "confidence_policy": {
        "weather_truth_source": "NWS API alerts/forecast",
        "rf_weather_role": "indirect correlation only",
        "security_rf_role": "lead only until baseline/correlation confirms",
    },
    "home_server": {
        "enabled": False,
        "label": "kai-home",
        "lat": None,
        "lon": None,
        "home_radius_m": 500,
        "near_home_radius_m": 2000,
        "awareness_radius_km": 80,
        "away_safety_radius_km": 40,
        "max_awareness_radius_km": 160,
    },
    "radius_policy": {
        "weather_context": "Use official NWS point alerts plus broad KAI context radius.",
        "phone_rf_context": "Wi-Fi/BLE/cell/magnetometer sensing is local, not long-radius detection.",
        "home_context": "Home geofence is presence logic; awareness radius is safety context, not sensor range.",
    },
    "phyphox": {
        "enabled": True,
        "preferred_mode": "push_json",
        "raw_value_limit": 64,
        "sensor_priority": {
            "weather_watch": ["barometer_hpa", "location", "light_lux", "accelerometer"],
            "storm_watch": ["barometer_hpa", "location", "accelerometer", "gyroscope", "magnetometer_ut", "light_lux"],
            "home_guard": ["barometer_hpa", "light_lux", "location", "accelerometer", "magnetometer_ut"],
            "away_safety": ["location", "accelerometer", "gyroscope", "magnetometer_ut", "light_lux", "proximity", "battery_pct"],
            "normal": ["location", "battery_pct", "barometer_hpa", "accelerometer"],
        },
    },
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dirs() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def read_json(path: Path, default: Dict) -> Dict:
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return dict(default)


def write_json(path: Path, data: Dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def append_jsonl(path: Path, data: Dict) -> None:
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(data, sort_keys=True) + "\n")


def round_location(location: Dict, decimals: int) -> Optional[Dict]:
    try:
        lat = float(location.get("lat"))
        lon = float(location.get("lon"))
    except (TypeError, ValueError, AttributeError):
        return None

    result = {
        "lat": round(lat, decimals),
        "lon": round(lon, decimals),
    }
    if "accuracy_m" in location:
        try:
            result["accuracy_m"] = float(location["accuracy_m"])
        except (TypeError, ValueError):
            pass
    return result


def last_scalar(value: Any) -> Optional[float]:
    """Return the newest numeric value from a scalar or phyphox-style array."""
    if isinstance(value, list):
        for item in reversed(value):
            result = last_scalar(item)
            if result is not None:
                return result
        return None
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def first_text(*values: Any) -> Optional[str]:
    for value in values:
        if isinstance(value, list):
            if value:
                value = value[-1]
            else:
                continue
        if value is not None and str(value).strip():
            return str(value).strip()
    return None


def pick_value(payload: Dict, *names: str) -> Optional[float]:
    lower = {str(k).lower(): v for k, v in payload.items()}
    for name in names:
        if name in payload:
            value = last_scalar(payload[name])
            if value is not None:
                return value
        lname = name.lower()
        if lname in lower:
            value = last_scalar(lower[lname])
            if value is not None:
                return value
    return None


def axis_object(payload: Dict, aliases: Tuple[Tuple[str, ...], Tuple[str, ...], Tuple[str, ...]]) -> Optional[Dict]:
    x = pick_value(payload, *aliases[0])
    y = pick_value(payload, *aliases[1])
    z = pick_value(payload, *aliases[2])
    if x is None and y is None and z is None:
        return None
    return {"x": x, "y": y, "z": z}


def clamp_float(value: Any, default: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in meters."""
    radius_m = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lam = math.radians(lon2 - lon1)
    a = (
        math.sin(d_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lam / 2.0) ** 2
    )
    return radius_m * 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


def source_allowed(address: str, mode: str) -> bool:
    """Check whether a client source is allowed for this bridge."""
    if mode == "any":
        return True
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if ip.is_loopback:
        return True
    if mode == "local":
        return ip.is_private and not (ip in TAILSCALE_IPV4 or ip in TAILSCALE_IPV6)
    if mode == "tailnet":
        return (ip in TAILSCALE_IPV4) or (ip in TAILSCALE_IPV6)
    return False


def build_location_context(location: Optional[Dict], cfg: Dict) -> Dict:
    """Build KAI's home/away/radius context for the latest phone position."""
    home = cfg.get("home_server", {}) if isinstance(cfg.get("home_server"), dict) else {}
    max_radius = clamp_float(home.get("max_awareness_radius_km"), 160, 1, 300)
    awareness_radius = clamp_float(home.get("awareness_radius_km"), 80, 1, max_radius)
    away_radius = clamp_float(home.get("away_safety_radius_km"), 40, 1, max_radius)

    context = {
        "home_configured": bool(home.get("enabled") and home.get("lat") is not None and home.get("lon") is not None),
        "label": home.get("label", "kai-home"),
        "relation": "unknown",
        "at_home": False,
        "near_home": False,
        "distance_from_home_m": None,
        "home_radius_m": clamp_float(home.get("home_radius_m"), 500, 25, 10000),
        "near_home_radius_m": clamp_float(home.get("near_home_radius_m"), 2000, 100, 25000),
        "active_awareness_radius_km": awareness_radius,
        "home_awareness_radius_km": awareness_radius,
        "away_safety_radius_km": away_radius,
        "limits": {
            "wide_radius": "Wide radius is contextual awareness, not physical phone sensor reach.",
            "local_sensors": "RF/BLE/Wi-Fi/magnetometer detections remain local to the phone/device.",
        },
    }

    if not location:
        context["relation"] = "no_location"
        return context
    if not context["home_configured"]:
        context["relation"] = "home_not_configured"
        return context

    try:
        lat = float(location["lat"])
        lon = float(location["lon"])
        home_lat = float(home["lat"])
        home_lon = float(home["lon"])
    except (TypeError, ValueError, KeyError):
        context["relation"] = "invalid_location"
        return context

    distance_m = haversine_m(lat, lon, home_lat, home_lon)
    context["distance_from_home_m"] = round(distance_m, 1)
    context["at_home"] = distance_m <= context["home_radius_m"]
    context["near_home"] = distance_m <= context["near_home_radius_m"]

    if context["at_home"]:
        context["relation"] = "at_home"
        context["active_awareness_radius_km"] = awareness_radius
    elif context["near_home"]:
        context["relation"] = "near_home"
        context["active_awareness_radius_km"] = awareness_radius
    else:
        context["relation"] = "away"
        context["active_awareness_radius_km"] = away_radius
    return context


def nws_get_json(url: str) -> Dict:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "KAI-Phone-Sensor-Bridge/1.0 (local user-owned sensor bridge)",
            "Accept": "application/geo+json, application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


class WeatherCache:
    def __init__(self):
        self._cache: Dict[Tuple[float, float], Tuple[float, Dict]] = {}

    def active_alerts(self, lat: float, lon: float) -> Dict:
        key = (round(lat, 4), round(lon, 4))
        now = time.time()
        cached = self._cache.get(key)
        if cached and now - cached[0] < WEATHER_CACHE_TTL_S:
            return cached[1]

        url = f"https://api.weather.gov/alerts/active?point={key[0]},{key[1]}"
        try:
            data = nws_get_json(url)
            features = data.get("features", [])
            alerts = []
            for item in features[:10]:
                props = item.get("properties", {})
                alerts.append({
                    "event": props.get("event"),
                    "severity": props.get("severity"),
                    "certainty": props.get("certainty"),
                    "urgency": props.get("urgency"),
                    "headline": props.get("headline"),
                    "effective": props.get("effective"),
                    "expires": props.get("expires"),
                })
            result = {
                "ok": True,
                "checked_at": utc_now(),
                "source": url,
                "alert_count": len(features),
                "alerts": alerts,
            }
        except Exception as exc:
            result = {
                "ok": False,
                "checked_at": utc_now(),
                "source": url,
                "error": str(exc),
                "alert_count": 0,
                "alerts": [],
            }

        self._cache[key] = (now, result)
        return result


def load_config() -> Dict:
    cfg = read_json(CONFIG_PATH, DEFAULT_CONFIG)
    merged = dict(DEFAULT_CONFIG)
    merged.update(cfg)
    return merged


def save_config(cfg: Dict) -> None:
    ensure_dirs()
    write_json(CONFIG_PATH, cfg)


def configure_home_server(payload: Dict) -> Dict:
    cfg = load_config()
    home = dict(DEFAULT_CONFIG["home_server"])
    if isinstance(cfg.get("home_server"), dict):
        home.update(cfg["home_server"])

    if "enabled" in payload:
        home["enabled"] = bool(payload.get("enabled"))
    else:
        home["enabled"] = True

    if payload.get("label"):
        home["label"] = str(payload["label"])[:80]

    if "lat" in payload and "lon" in payload:
        home["lat"] = round(clamp_float(payload.get("lat"), 0, -90, 90), 6)
        home["lon"] = round(clamp_float(payload.get("lon"), 0, -180, 180), 6)

    max_radius = clamp_float(payload.get("max_awareness_radius_km", home.get("max_awareness_radius_km")), 160, 1, 300)
    home["max_awareness_radius_km"] = max_radius
    home["home_radius_m"] = round(clamp_float(payload.get("home_radius_m", home.get("home_radius_m")), 500, 25, 10000), 1)
    home["near_home_radius_m"] = round(clamp_float(payload.get("near_home_radius_m", home.get("near_home_radius_m")), 2000, 100, 25000), 1)
    home["awareness_radius_km"] = round(clamp_float(payload.get("awareness_radius_km", home.get("awareness_radius_km")), 80, 1, max_radius), 1)
    home["away_safety_radius_km"] = round(clamp_float(payload.get("away_safety_radius_km", home.get("away_safety_radius_km")), 40, 1, max_radius), 1)

    cfg["home_server"] = home
    save_config(cfg)
    return home


def build_phone_sensor_profile(mode: str, cfg: Dict, context: Dict) -> Dict:
    profiles = cfg.get("sensor_profiles", {})
    profile = dict(profiles.get(mode) or profiles.get("normal") or {})
    role = profile.get("role", "mobile_context_node")
    requested = list(profile.get("requested_sensors") or cfg.get("requested_sensors", []))
    optional = list(profile.get("optional_sensors") or cfg.get("optional_sensors", []))

    actions = []
    if mode in ("away_safety", "storm_watch"):
        actions.extend([
            "watch_motion_state",
            "watch_pressure_change",
            "watch_magnetic_anomaly",
            "report_location_context",
        ])
    elif mode == "home_guard":
        actions.extend([
            "support_home_weather_context",
            "support_home_presence_context",
        ])
    elif mode == "weather_watch":
        actions.extend([
            "watch_pressure_change",
            "report_weather_context",
        ])
    else:
        actions.append("send_periodic_context")

    return {
        "role": role,
        "mode": mode,
        "requested_sensors": requested,
        "optional_sensors": optional,
        "requested_actions": actions,
        "upload_policy": profile.get("upload_policy", "periodic_summary"),
        "local_sensor_limits": {
            "phone": "Phone sensors describe the phone's local environment and motion.",
            "tinysa": "tinySA remains the home server RF sensor unless another analyzer is attached elsewhere.",
            "wide_radius": "Wide radius is for weather/safety context and alert lookup, not physical sensing range.",
        },
        "context": {
            "relation": context.get("relation"),
            "active_awareness_radius_km": context.get("active_awareness_radius_km"),
            "distance_from_home_m": context.get("distance_from_home_m"),
        },
    }


def normalize_phyphox_payload(payload: Dict, cfg: Dict) -> Dict:
    """Normalize Phyphox HTTP/POST JSON into the bridge telemetry shape.
    Now supports beacon + anomaly mode: low-duty snapshots or triggered full snapshots.
    Detects elevated patterns for safety (sudden motion stop, gravity/gyro anomaly, velocity/height change).
    """
    # Defensive: recover from shell-quoted/stringified payloads user sometimes pastes (e.g. "{'lat':0}" instead of object)
    for k in ("location", "sensors", "battery"):
        if isinstance(payload.get(k), str):
            try:
                payload[k] = json.loads(payload[k])
            except Exception:
                pass

    phy_cfg = cfg.get("phyphox", {}) if isinstance(cfg.get("phyphox"), dict) else {}
    raw_limit = int(phy_cfg.get("raw_value_limit", 64))

    device_id = first_text(
        payload.get("device_id"),
        payload.get("device"),
        payload.get("uniqueID"),
        payload.get("deviceModel"),
        payload.get("deviceBrand"),
    ) or "phyphox-phone"

    lat = pick_value(payload, "lat", "latitude", "gps_lat", "location_lat", "locationLatitude")
    lon = pick_value(payload, "lon", "lng", "longitude", "gps_lon", "gps_lng", "location_lon", "locationLongitude")
    acc = pick_value(payload, "accuracy", "accuracy_m", "gps_accuracy", "location_accuracy")
    location = None
    if lat is not None and lon is not None:
        location = {"lat": lat, "lon": lon}
        if acc is not None:
            location["accuracy_m"] = acc
        location["source"] = "phyphox"

    sensors: Dict[str, Any] = {}
    accel = axis_object(payload, (
        ("ax", "acc_x", "acceleration_x", "accelerometer_x", "x"),
        ("ay", "acc_y", "acceleration_y", "accelerometer_y", "y"),
        ("az", "acc_z", "acceleration_z", "accelerometer_z", "z"),
    ))
    if accel:
        sensors["accelerometer"] = accel

    gyro = axis_object(payload, (
        ("gx", "gyro_x", "gyroscope_x", "rotation_x"),
        ("gy", "gyro_y", "gyroscope_y", "rotation_y"),
        ("gz", "gyro_z", "gyroscope_z", "rotation_z"),
    ))
    if gyro:
        sensors["gyroscope"] = gyro

    mag = axis_object(payload, (
        ("mx", "mag_x", "magnetic_x", "magnetometer_x"),
        ("my", "mag_y", "magnetic_y", "magnetometer_y"),
        ("mz", "mag_z", "magnetic_z", "magnetometer_z"),
    ))
    if mag:
        sensors["magnetometer_ut"] = mag

    pressure = pick_value(payload, "pressure", "pressure_hpa", "barometer", "barometer_hpa", "p")
    if pressure is not None:
        sensors["barometer_hpa"] = pressure

    light = pick_value(payload, "light", "lux", "illuminance", "light_lux")
    if light is not None:
        sensors["light_lux"] = light

    prox = pick_value(payload, "proximity", "prox")
    if prox is not None:
        sensors["proximity"] = prox

    temp = pick_value(payload, "temperature", "temp", "temperature_c")
    if temp is not None:
        sensors["temperature_c"] = temp

    humidity = pick_value(payload, "humidity", "relative_humidity")
    if humidity is not None:
        sensors["humidity_pct"] = humidity

    battery = pick_value(payload, "battery", "battery_pct")
    if battery is not None:
        sensors["battery_pct"] = battery

    # --- Beacon + Anomaly Detection (new for user's "when needed / safety beacon" request) ---
    anomaly_score = 0.0
    anomaly_reasons = []

    # Sudden high accel + weird gravity/gyro (possible throw, fall, impact)
    if accel:
        a_mag = (accel.get('x',0)**2 + accel.get('y',0)**2 + accel.get('z',0)**2) ** 0.5
        if a_mag > 25:  # g-force spike (rough threshold, will be learned)
            anomaly_score += 0.4
            anomaly_reasons.append("high_acceleration_spike")
    if gyro:
        g_mag = (gyro.get('x',0)**2 + gyro.get('y',0)**2 + gyro.get('z',0)**2) ** 0.5
        if g_mag > 8:
            anomaly_score += 0.3
            anomaly_reasons.append("high_gyro_rotation")

    # Location/velocity/height change (car accident, fast move then stop)
    if location and 'prev_location' in payload:  # simple delta if phone sends previous
        # In practice Tasker/Phyphox can include delta_v or we compute on lattice side
        pass

    raw = {}
    for key, value in payload.items():
        if len(raw) >= raw_limit:
            break
        if isinstance(value, list):
            raw[key] = value[-3:]
        elif isinstance(value, (int, float, str, bool)) or value is None:
            raw[key] = value
        else:
            raw[key] = str(value)[:200]

    telemetry = {
        "device_id": device_id,
        "timestamp": first_text(payload.get("timestamp"), payload.get("time")) or utc_now(),
        "source": "phyphox",
        "sensors": sensors,
        "anomaly": {
            "score": round(anomaly_score, 3),
            "reasons": anomaly_reasons,
            "is_elevated": anomaly_score > 0.5,
            "beacon_mode": True,   # signals this was a triggered or scheduled low-duty snapshot
        },
        "phyphox": {
            "available_keys": sorted(str(k) for k in payload.keys()),
            "raw_sample": raw,
            "selection_note": "Beacon + anomaly mode. Kai learns patterns for protection (accident, fall, thrown phone, etc.).",
        },
    }
    if location:
        telemetry["location"] = location

    # Store anomaly events directly for lattice learning / escalation
    if anomaly_reasons:
        try:
            events_path = Path("C:/KAI/logs/phone_sensory_anomalies.jsonl")
            events_path.parent.mkdir(parents=True, exist_ok=True)
            with events_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "ts": telemetry["timestamp"],
                    "device_id": device_id,
                    "anomaly_score": telemetry["anomaly"]["score"],
                    "reasons": anomaly_reasons,
                    "location": location,
                    "sensors_summary": {k: sensors.get(k) for k in ["accelerometer","gyroscope","location"] if k in sensors}
                }) + "\n")
        except Exception:
            pass

    return telemetry


def selected_sensor_names(kai_mode: Dict, telemetry: Dict) -> Dict:
    """Explain which normalized phone sensors matter for the active mode."""
    profile = kai_mode.get("phone_sensor_profile") or {}
    aliases = {
        "location_coarse": {"location"},
        "location": {"location_coarse"},
        "barometer": {"barometer_hpa", "pressure"},
        "barometer_hpa": {"barometer", "pressure"},
        "light": {"light_lux", "illuminance"},
        "light_lux": {"light", "illuminance"},
        "magnetometer": {"magnetometer_ut", "magnetic_field"},
        "magnetometer_ut": {"magnetometer", "magnetic_field"},
        "battery": {"battery_pct"},
        "battery_pct": {"battery"},
    }

    requested = set(profile.get("requested_sensors") or [])
    optional = set(profile.get("optional_sensors") or [])
    useful = set(requested).union(optional)
    for name in list(useful):
        useful.update(aliases.get(name, set()))

    sensors = telemetry.get("sensors") or {}

    available = set(sensors.keys())
    if telemetry.get("location"):
        available.add("location")

    selected = sorted(available.intersection(useful))
    ignored = sorted(available.difference(useful))

    missing_requested = []
    for name in sorted(requested):
        equivalents = {name}.union(aliases.get(name, set()))
        if not available.intersection(equivalents):
            missing_requested.append(name)

    # If phone actually delivered data, surface it even if profile was narrow (bootstrap / direct beacon)
    if not selected and available:
        selected = sorted(available)
        reason_extra = " (promoted available sensors)"
    else:
        reason_extra = ""

    return {
        "selected": selected,
        "ignored_available": ignored,
        "missing_requested": missing_requested,
        "reason": f"mode={kai_mode.get('mode')} role={(profile or {}).get('role')}{reason_extra}",
    }


def derive_kai_mode(telemetry: Dict, weather: Optional[Dict], previous: Optional[Dict], context: Optional[Dict] = None) -> Dict:
    mode = "away_safety"  # default to away_safety for phone protection use ("protect me", anomaly on motion/gyro/pressure)
    reasons = ["phone_protection_default"]
    context = context or {}

    if context.get("relation") in ("at_home", "near_home"):
        mode = "home_guard"
        reasons = [context.get("relation")]
    elif context.get("relation") == "away":
        mode = "away_safety"
        reasons = ["away_from_home"]

    alerts = (weather or {}).get("alerts", [])
    severe_terms = ("Thunderstorm", "Tornado", "Flash Flood", "Flood", "High Wind", "Hurricane")
    if any(any(term in str(alert.get("event", "")) for term in severe_terms) for alert in alerts):
        mode = "storm_watch"
        reasons.append("official_nws_active_alert")

    sensors = telemetry.get("sensors", {}) if isinstance(telemetry.get("sensors"), dict) else {}
    try:
        pressure = float(sensors.get("barometer_hpa"))
    except (TypeError, ValueError):
        pressure = None

    if pressure is not None and previous:
        prev_pressure = previous.get("sensors", {}).get("barometer_hpa")
        prev_ts = previous.get("received_epoch")
        try:
            prev_pressure = float(prev_pressure)
            elapsed_h = max((time.time() - float(prev_ts)) / 3600.0, 0.01)
            drop_per_h = (prev_pressure - pressure) / elapsed_h
            if drop_per_h >= 2.0 and mode == "normal":
                mode = "weather_watch"
                reasons.append(f"pressure_drop_{drop_per_h:.1f}_hpa_per_h")
        except (TypeError, ValueError):
            pass

    cfg = load_config()
    sampling = cfg.get("sampling", {})
    interval = sampling.get("normal_interval_s", 30)
    if mode == "home_guard":
        interval = sampling.get("home_guard_interval_s", 20)
    elif mode == "away_safety":
        interval = sampling.get("away_safety_interval_s", 15)
    if mode == "storm_watch":
        interval = sampling.get("storm_interval_s", 10)
    elif mode == "weather_watch":
        interval = min(sampling.get("normal_interval_s", 30), 15)

    phone_profile = build_phone_sensor_profile(mode, cfg, context)

    return {
        "mode": mode,
        "reasons": reasons,
        "next_interval_s": interval,
        "location_context": context,
        "phone_sensor_profile": phone_profile,
        "requested_sensors": phone_profile.get("requested_sensors", cfg.get("requested_sensors", [])),
        "optional_sensors": phone_profile.get("optional_sensors", cfg.get("optional_sensors", [])),
        "privacy": cfg.get("privacy", {}),
    }


def build_kai_memory_payload(telemetry: Dict, weather: Optional[Dict], kai_mode: Dict) -> Dict:
    loc = telemetry.get("location") or {}
    sensors = telemetry.get("sensors") or {}
    parts = [
        f"PHONE SENSOR: device={telemetry.get('device_id', 'unknown')}",
        f"mode={kai_mode.get('mode')}",
    ]
    context = kai_mode.get("location_context") or {}
    if context:
        parts.append(f"relation={context.get('relation')}")
        parts.append(f"radius_km={context.get('active_awareness_radius_km')}")
        if context.get("distance_from_home_m") is not None:
            parts.append(f"home_distance_m={context.get('distance_from_home_m')}")
    profile = kai_mode.get("phone_sensor_profile") or {}
    if profile:
        parts.append(f"phone_role={profile.get('role')}")
    if loc:
        parts.append(f"location~{loc.get('lat')},{loc.get('lon')} acc={loc.get('accuracy_m', 'unknown')}m")
    if "battery_pct" in sensors:
        parts.append(f"battery={sensors.get('battery_pct')}%")
    if "barometer_hpa" in sensors:
        parts.append(f"pressure={sensors.get('barometer_hpa')}hPa")
    if weather is not None:
        parts.append(f"nws_alerts={weather.get('alert_count', 0)}")

    return {
        "text": " | ".join(parts),
        "region": "perception",
        "source": "phone-sensor",
        "strength": 0.35 if kai_mode.get("mode") == "normal" else 0.55,
    }


def send_kai_memory_payload(payload: Dict) -> bool:
    try:
        req = urllib.request.Request(
            KAI_STORE_URL,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=4) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False


def queue_kai_memory_payload(payload: Dict) -> None:
    append_jsonl(PENDING_KAI_PATH, {
        "queued_at": utc_now(),
        "payload": payload,
    })


def flush_pending_kai_memory(max_items: int = 25) -> int:
    if not PENDING_KAI_PATH.exists():
        return 0

    try:
        lines = PENDING_KAI_PATH.read_text(encoding="utf-8").splitlines()
    except Exception:
        return 0

    sent = 0
    remaining = []
    for line in lines:
        if not line.strip():
            continue
        try:
            item = json.loads(line)
            payload = item.get("payload", item)
        except json.JSONDecodeError:
            continue
        if sent < max_items and send_kai_memory_payload(payload):
            sent += 1
        else:
            remaining.append(line)

    if remaining:
        PENDING_KAI_PATH.write_text("\n".join(remaining) + "\n", encoding="utf-8")
    else:
        try:
            PENDING_KAI_PATH.unlink()
        except FileNotFoundError:
            pass
    return sent


def store_in_kai_memory(telemetry: Dict, weather: Optional[Dict], kai_mode: Dict) -> bool:
    flush_pending_kai_memory()
    payload = build_kai_memory_payload(telemetry, weather, kai_mode)
    if send_kai_memory_payload(payload):
        return True
    queue_kai_memory_payload(payload)
    return False


def phone_client_html() -> str:
    """Small browser client for a phone to send local sensor data to KAI."""
    return r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KAI Phone Sensor Node</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; background: #101418; color: #eef4f8; }
    main { max-width: 760px; margin: 0 auto; padding: 18px; }
    h1 { font-size: 24px; margin: 0 0 10px; }
    p { color: #aebbc4; line-height: 1.45; }
    label { display: block; font-size: 13px; color: #b9c7d0; margin: 14px 0 6px; }
    input, button, textarea { box-sizing: border-box; width: 100%; border-radius: 7px; border: 1px solid #33424d; background: #172028; color: #eef4f8; padding: 11px; font-size: 16px; }
    button { cursor: pointer; background: #2d6cdf; border-color: #477ee8; font-weight: 650; margin-top: 12px; }
    button.secondary { background: #202b34; border-color: #3d4f5d; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .panel { border: 1px solid #293743; background: #141c22; border-radius: 8px; padding: 14px; margin-top: 14px; }
    .status { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; line-height: 1.45; }
    .ok { color: #7ee787; }
    .bad { color: #ff9b9b; }
    .muted { color: #93a3ad; }
    @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<main>
  <h1>KAI Phone Sensor Node</h1>
  <p>This sends your phone's local sensor readings to KAI. Wide radius is safety/weather context; phone sensors still describe the phone's nearby environment.</p>

  <div class="panel">
    <label for="token">Bridge token</label>
    <input id="token" type="password" autocomplete="off" placeholder="KAI_PHONE_SENSOR_TOKEN">
    <div class="grid">
      <div>
        <label for="device">Device id</label>
        <input id="device" value="phone-main">
      </div>
      <div>
        <label for="interval">Interval seconds</label>
        <input id="interval" type="number" min="2" max="300" value="30">
      </div>
    </div>
    <div class="grid">
      <div>
        <label for="manualLat">Manual latitude fallback</label>
        <input id="manualLat" inputmode="decimal" placeholder="optional">
      </div>
      <div>
        <label for="manualLon">Manual longitude fallback</label>
        <input id="manualLon" inputmode="decimal" placeholder="optional">
      </div>
    </div>
    <button id="start">Start sending</button>
    <button id="stop" class="secondary" disabled>Stop</button>
    <button id="once" class="secondary">Send one reading</button>
  </div>

  <div class="panel">
    <div id="status" class="status muted">Idle.</div>
  </div>
</main>

<script>
const els = {
  token: document.getElementById('token'),
  device: document.getElementById('device'),
  interval: document.getElementById('interval'),
  manualLat: document.getElementById('manualLat'),
  manualLon: document.getElementById('manualLon'),
  start: document.getElementById('start'),
  stop: document.getElementById('stop'),
  once: document.getElementById('once'),
  status: document.getElementById('status')
};

let timer = null;
let latestMotion = null;
let latestOrientation = null;
let latestBattery = null;
let latestKaiMode = null;

els.token.value = localStorage.getItem('kai_phone_token') || '';
els.device.value = localStorage.getItem('kai_phone_device') || 'phone-main';

function log(message, cls) {
  els.status.className = 'status ' + (cls || 'muted');
  els.status.textContent = message;
}

function saveSettings() {
  localStorage.setItem('kai_phone_token', els.token.value.trim());
  localStorage.setItem('kai_phone_device', els.device.value.trim() || 'phone-main');
}

async function requestMotionPermission() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      const result = await DeviceMotionEvent.requestPermission();
      return result === 'granted';
    }
  } catch (err) {
    return false;
  }
  return true;
}

function setupSensorListeners() {
  window.addEventListener('devicemotion', ev => {
    latestMotion = {
      acceleration: ev.acceleration ? {
        x: ev.acceleration.x, y: ev.acceleration.y, z: ev.acceleration.z
      } : null,
      accelerationIncludingGravity: ev.accelerationIncludingGravity ? {
        x: ev.accelerationIncludingGravity.x,
        y: ev.accelerationIncludingGravity.y,
        z: ev.accelerationIncludingGravity.z
      } : null,
      rotationRate: ev.rotationRate ? {
        alpha: ev.rotationRate.alpha, beta: ev.rotationRate.beta, gamma: ev.rotationRate.gamma
      } : null,
      interval_ms: ev.interval || null
    };
  });

  window.addEventListener('deviceorientation', ev => {
    latestOrientation = {
      alpha: ev.alpha, beta: ev.beta, gamma: ev.gamma, absolute: ev.absolute || false
    };
  });

  if (navigator.getBattery) {
    navigator.getBattery().then(b => {
      latestBattery = b;
    }).catch(() => {});
  }
}

function manualLocation() {
  const lat = Number(els.manualLat.value);
  const lon = Number(els.manualLon.value);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return { lat, lon, accuracy_m: null, source: 'manual' };
  }
  return null;
}

function getPosition() {
  return new Promise(resolve => {
    if (!navigator.geolocation) {
      resolve(manualLocation());
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy_m: pos.coords.accuracy,
        source: 'geolocation'
      }),
      () => resolve(manualLocation()),
      { enableHighAccuracy: false, maximumAge: 30000, timeout: 8000 }
    );
  });
}

function sensorPayload(location) {
  const sensors = {};
  if (latestBattery) {
    sensors.battery_pct = Math.round(latestBattery.level * 100);
    sensors.battery_charging = latestBattery.charging;
  }
  if (latestMotion) {
    sensors.motion = latestMotion;
  }
  if (latestOrientation) {
    sensors.orientation = latestOrientation;
  }
  return {
    device_id: els.device.value.trim() || 'phone-main',
    timestamp: new Date().toISOString(),
    location: location || undefined,
    sensors
  };
}

async function sendReading() {
  saveSettings();
  const token = els.token.value.trim();
  const location = await getPosition();
  const payload = sensorPayload(location);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;

  const resp = await fetch('/telemetry', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    throw new Error(data.error || ('HTTP ' + resp.status));
  }
  latestKaiMode = data.kai_mode;
  if (data.kai_mode && data.kai_mode.next_interval_s) {
    els.interval.value = data.kai_mode.next_interval_s;
  }
  const profile = data.kai_mode && data.kai_mode.phone_sensor_profile;
  log(JSON.stringify({
    sent_at: payload.timestamp,
    mode: data.kai_mode && data.kai_mode.mode,
    role: profile && profile.role,
    relation: data.kai_mode && data.kai_mode.location_context && data.kai_mode.location_context.relation,
    radius_km: data.kai_mode && data.kai_mode.location_context && data.kai_mode.location_context.active_awareness_radius_km,
    requested_actions: profile && profile.requested_actions,
    weather_alerts: data.weather && data.weather.alert_count,
    kai_store_ok: data.kai_store_ok
  }, null, 2), 'ok');
}

async function startLoop() {
  saveSettings();
  await requestMotionPermission();
  setupSensorListeners();
  els.start.disabled = true;
  els.stop.disabled = false;
  await sendReading().catch(err => log('Send failed: ' + err.message, 'bad'));
  timer = setInterval(() => {
    sendReading().catch(err => log('Send failed: ' + err.message, 'bad'));
    const interval = Math.max(2, Math.min(300, Number(els.interval.value) || 30));
    clearInterval(timer);
    timer = setInterval(() => sendReading().catch(err => log('Send failed: ' + err.message, 'bad')), interval * 1000);
  }, Math.max(2, Number(els.interval.value) || 30) * 1000);
}

function stopLoop() {
  if (timer) clearInterval(timer);
  timer = null;
  els.start.disabled = false;
  els.stop.disabled = true;
  log('Stopped.', 'muted');
}

els.start.addEventListener('click', startLoop);
els.stop.addEventListener('click', stopLoop);
els.once.addEventListener('click', async () => {
  saveSettings();
  await requestMotionPermission();
  setupSensorListeners();
  sendReading().catch(err => log('Send failed: ' + err.message, 'bad'));
});
</script>
</body>
</html>
"""


class PhoneSensorHandler(BaseHTTPRequestHandler):
    server_version = "KAIPhoneSensorBridge/1.0"

    def _json(self, status: int, payload: Dict) -> None:
        body = json.dumps(payload, indent=2, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, status: int, html: str) -> None:
        body = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        token = self.server.token
        if not token:
            return True
        auth = self.headers.get("Authorization", "")
        if hmac.compare_digest(auth, f"Bearer {token}"):
            return True
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        query_token = (query.get("token") or query.get("access_token") or [""])[0]
        return hmac.compare_digest(query_token, token)

    def _source_allowed(self) -> bool:
        return source_allowed(self.client_address[0], self.server.allow_source)

    def _read_json_body(self) -> Optional[Dict]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            return None
        return payload if isinstance(payload, dict) else None

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if not self._source_allowed():
            self._json(403, {"ok": False, "error": "source_not_allowed", "source": self.client_address[0]})
            return

        if parsed.path in ("/", "/phone"):
            self._html(200, phone_client_html())
            return

        if not self._authorized():
            self._json(401, {"ok": False, "error": "unauthorized"})
            return

        if parsed.path == "/health":
            self._json(200, {
                "ok": True,
                "service": "phone_sensor_bridge",
                "time": utc_now(),
                "host": self.server.server_address[0],
                "port": self.server.server_address[1],
                "allow_source": self.server.allow_source,
            })
            return

        if parsed.path == "/config":
            self._json(200, {"ok": True, "config": load_config()})
            return

        if parsed.path == "/latest":
            latest = read_json(LATEST_PATH, {})
            self._json(200, {"ok": True, "latest": latest})
            return

        if parsed.path == "/home":
            cfg = load_config()
            self._json(200, {"ok": True, "home_server": cfg.get("home_server", {})})
            return

        if parsed.path == "/weather":
            query = urllib.parse.parse_qs(parsed.query)
            try:
                lat = float(query.get("lat", [None])[0])
                lon = float(query.get("lon", [None])[0])
            except (TypeError, ValueError):
                self._json(400, {"ok": False, "error": "lat and lon are required"})
                return
            self._json(200, self.server.weather.active_alerts(lat, lon))
            return

        self._json(404, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:
        if not self._source_allowed():
            self._json(403, {"ok": False, "error": "source_not_allowed", "source": self.client_address[0]})
            return

        if not self._authorized():
            self._json(401, {"ok": False, "error": "unauthorized"})
            return

        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/home":
            payload = self._read_json_body()
            if payload is None:
                self._json(400, {"ok": False, "error": "invalid_json_body"})
                return
            if payload.get("enabled", True) and ("lat" not in payload or "lon" not in payload):
                self._json(400, {"ok": False, "error": "lat and lon are required when enabling home"})
                return
            home = configure_home_server(payload)
            self._json(200, {
                "ok": True,
                "home_server": home,
                "limits": load_config().get("radius_policy", {}),
            })
            return

        if parsed.path not in ("/telemetry", "/phyphox"):
            self._json(404, {"ok": False, "error": "not_found"})
            return

        payload = self._read_json_body()
        if payload is None:
            self._json(400, {"ok": False, "error": "invalid_json_body"})
            return

        cfg = load_config()
        if parsed.path == "/phyphox":
            payload = normalize_phyphox_payload(payload, cfg)

        privacy = cfg.get("privacy", {})
        decimals = int(privacy.get("round_location_decimals", 4))
        loc = round_location(payload.get("location") or {}, decimals)
        if loc:
            payload["location"] = loc
        elif "location" in payload:
            payload.pop("location", None)

        previous = read_json(LATEST_PATH, {})
        payload["received_at"] = utc_now()
        payload["received_epoch"] = time.time()
        payload["source_ip"] = self.client_address[0]

        weather = None
        if loc:
            weather = self.server.weather.active_alerts(float(loc["lat"]), float(loc["lon"]))

        location_context = build_location_context(loc, cfg)
        previous_telemetry = previous.get("telemetry", previous) if isinstance(previous, dict) else {}
        kai_mode = derive_kai_mode(payload, weather, previous_telemetry, location_context)
        sensor_selection = selected_sensor_names(kai_mode, payload)
        kai_store_ok = store_in_kai_memory(payload, weather, kai_mode)

        state = {
            "telemetry": payload,
            "weather": weather,
            "kai_mode": kai_mode,
            "sensor_selection": sensor_selection,
            "kai_store_ok": kai_store_ok,
        }
        write_json(LATEST_PATH, state)
        append_jsonl(EVENTS_PATH, state)

        self._json(200, {
            "ok": True,
            "kai_mode": kai_mode,
            "sensor_selection": sensor_selection,
            "weather": weather,
            "kai_store_ok": kai_store_ok,
            "limits": {
                "weather": "NWS alerts are official; RF weather readings are indirect correlation only.",
                "security": "Phone/RF sensor data can flag leads but cannot identify hidden devices without baseline and corroboration.",
            },
        })

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[phone-sensor] {self.address_string()} - {fmt % args}")


class PhoneSensorServer(ThreadingHTTPServer):
    def __init__(self, server_address: Tuple[str, int], handler, token: str, allow_source: str = "any"):
        ensure_dirs()
        super().__init__(server_address, handler)
        self.token = token
        self.allow_source = allow_source
        self.weather = WeatherCache()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="KAI phone sensor telemetry bridge")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host. Use 0.0.0.0 for LAN phones.")
    parser.add_argument("--port", type=int, default=8787, help="Bind port")
    parser.add_argument("--token", default=os.environ.get("KAI_PHONE_SENSOR_TOKEN", ""), help="Bearer token")
    parser.add_argument(
        "--allow-source",
        choices=["local", "tailnet", "any"],
        default="any",
        help="Reject clients outside this source class. Use tailnet with Tailscale.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    ensure_dirs()

    if args.host not in ("127.0.0.1", "localhost", "::1") and not args.token:
        print("Refusing LAN bind without --token or KAI_PHONE_SENSOR_TOKEN.", file=sys.stderr)
        return 2

    if not CONFIG_PATH.exists():
        write_json(CONFIG_PATH, DEFAULT_CONFIG)

    server = PhoneSensorServer((args.host, args.port), PhoneSensorHandler, args.token, args.allow_source)
    auth_state = "token-required" if args.token else "local-no-token"
    print(f"KAI phone sensor bridge listening on http://{args.host}:{args.port} ({auth_state}, allow-source={args.allow_source})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping phone sensor bridge.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
