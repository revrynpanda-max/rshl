#!/usr/bin/env python3
"""
sensor_truth.py - cautious RF/environment interpretation helpers for KAI.

This module keeps KAI honest: a spectrum analyzer can detect RF energy and
patterns, but it cannot prove "storm", "hidden camera", or "sensor" by itself.
Use these helpers to label evidence, confidence, and limits consistently.
"""

from __future__ import annotations

from typing import Dict, Iterable, List, Optional


NOAA_WEATHER_RADIO_FREQS_MHZ = [
    162.400,
    162.425,
    162.450,
    162.475,
    162.500,
    162.525,
    162.550,
]


SECURITY_RELEVANT_BANDS = [
    {
        "start": 315.0,
        "stop": 316.0,
        "name": "315 MHz short-range devices",
        "note": "Common for key fobs and remotes; security-relevant only when new, repeated, or nearby.",
    },
    {
        "start": 433.0,
        "stop": 434.8,
        "name": "433 MHz ISM sensors",
        "note": "Common for sensors, remotes, weather stations, and smart-home devices.",
    },
    {
        "start": 902.0,
        "stop": 928.0,
        "name": "900 MHz ISM / LoRa / telemetry",
        "note": "Common for telemetry, LoRa, cordless, and smart-home gear.",
    },
    {
        "start": 698.0,
        "stop": 960.0,
        "name": "sub-GHz cellular / public networks",
        "note": "Could be normal towers, phones, hotspots, or LTE cameras. RF alone cannot identify the device.",
    },
    {
        "start": 1710.0,
        "stop": 2690.0,
        "name": "cellular mid-band / Wi-Fi 2.4 vicinity",
        "note": "Common for phones, routers, Bluetooth, cameras, and normal network traffic.",
    },
    {
        "start": 2400.0,
        "stop": 2500.0,
        "name": "Wi-Fi 2.4 GHz / Bluetooth",
        "note": "Many hidden cameras use Wi-Fi, but normal routers and phones do too. Baseline and packet metadata are needed.",
    },
    {
        "start": 5150.0,
        "stop": 5925.0,
        "name": "Wi-Fi 5 GHz / video links",
        "note": "Can include Wi-Fi cameras, routers, drones, or radar coexistence events. Treat as a lead, not proof.",
    },
    {
        "start": 5925.0,
        "stop": 7125.0,
        "name": "Wi-Fi 6E / 6 GHz",
        "note": "Modern Wi-Fi band; use for occupancy and anomaly detection, not device identity by RF alone.",
    },
]


def nearest_noaa_weather_radio(freq_mhz: float, tolerance_mhz: float = 0.015) -> Optional[float]:
    """Return the nearest NOAA Weather Radio channel if freq is close enough."""
    nearest = min(NOAA_WEATHER_RADIO_FREQS_MHZ, key=lambda f: abs(f - freq_mhz))
    if abs(nearest - freq_mhz) <= tolerance_mhz:
        return nearest
    return None


def rf_level_label(amp_dbm: Optional[float]) -> str:
    """Human-readable signal level label."""
    if amp_dbm is None:
        return "unknown"
    if amp_dbm >= -35:
        return "very strong"
    if amp_dbm >= -55:
        return "strong"
    if amp_dbm >= -75:
        return "moderate"
    if amp_dbm >= -90:
        return "weak"
    return "very weak"


def bounded_rf_confidence(amp_dbm: Optional[float], base: float = 0.25, cap: float = 0.85) -> float:
    """
    Convert received power into a bounded evidence score.

    This is confidence that an RF feature is present, not confidence that the
    source has a specific identity.
    """
    if amp_dbm is None:
        return base
    scaled = (amp_dbm + 100.0) / 85.0
    return max(0.05, min(cap, base + max(0.0, scaled) * (cap - base)))


def classify_environment_signal(freq_mhz: float, amp_dbm: Optional[float] = None) -> Dict:
    """
    Classify RF observations with explicit limits.

    Returned confidence is evidence confidence, not identity certainty.
    """
    nwr = nearest_noaa_weather_radio(freq_mhz)
    if nwr is not None:
        return {
            "label": "NOAA Weather Radio carrier",
            "category": "weather_reference",
            "confidence": bounded_rf_confidence(amp_dbm, base=0.45, cap=0.9),
            "confidence_label": rf_level_label(amp_dbm),
            "evidence": f"Near official NWR channel {nwr:.3f} MHz.",
            "limit": "This can confirm a weather-radio signal is present, but storm truth should come from NWS alerts or decoded weather audio.",
            "recommended_action": "Correlate with NWS API alerts and optional receiver audio/SAME decoding.",
        }

    if 0.003 <= freq_mhz <= 30.0:
        return {
            "label": "HF/VLF environmental RF",
            "category": "weather_indirect",
            "confidence": bounded_rf_confidence(amp_dbm, base=0.15, cap=0.55),
            "confidence_label": rf_level_label(amp_dbm),
            "evidence": "Lightning can create broadband low-frequency RF bursts, but a single sweep is not enough.",
            "limit": "Use burst rate over time plus official weather data. Do not treat this as storm detection by itself.",
            "recommended_action": "Track time-series noise-floor changes and compare against NWS alerts.",
        }

    for band in SECURITY_RELEVANT_BANDS:
        if band["start"] <= freq_mhz <= band["stop"]:
            return {
                "label": band["name"],
                "category": "security_rf_lead",
                "confidence": bounded_rf_confidence(amp_dbm, base=0.2, cap=0.65),
                "confidence_label": rf_level_label(amp_dbm),
                "evidence": f"Signal lies in {band['name']}.",
                "limit": band["note"],
                "recommended_action": "Compare with home baseline, persistence, direction, and known device inventory before alerting.",
            }

    return {
        "label": "general RF observation",
        "category": "rf_observation",
        "confidence": bounded_rf_confidence(amp_dbm, base=0.1, cap=0.45),
        "confidence_label": rf_level_label(amp_dbm),
        "evidence": "RF energy detected in a broad sweep.",
        "limit": "Frequency and power alone rarely identify a source. Baseline and correlation are required.",
        "recommended_action": "Log it, compare against baseline, and only escalate persistent or changing features.",
    }


def summarize_weather_indicators(signals: Iterable[Dict]) -> Dict:
    """Summarize weather-relevant RF indicators from a sweep result list."""
    nwr_hits: List[Dict] = []
    hf_hits = 0

    for sig in signals or []:
        try:
            freq_mhz = float(sig.get("freq"))
            amp_dbm = float(sig.get("amp"))
        except (TypeError, ValueError):
            continue

        nwr = nearest_noaa_weather_radio(freq_mhz)
        if nwr is not None:
            nwr_hits.append({"freq_mhz": freq_mhz, "channel_mhz": nwr, "amp_dbm": amp_dbm})
        if 0.003 <= freq_mhz <= 30.0 and amp_dbm > -80:
            hf_hits += 1

    confidence = "none"
    if nwr_hits:
        confidence = "reference-signal-present"
    if hf_hits >= 3:
        confidence = "indirect-rf-weather-watch"

    return {
        "nwr_detected": bool(nwr_hits),
        "nwr_hits": sorted(nwr_hits, key=lambda s: s["amp_dbm"], reverse=True)[:5],
        "hf_burst_like_hits": hf_hits,
        "weather_rf_confidence": confidence,
        "limit": "RF indicators are indirect. Use official NWS alerts/forecast as the source of truth.",
    }


def build_rf_truth_note(freq_mhz: float, amp_dbm: Optional[float] = None) -> str:
    """Compact one-line note for Discord or KAI memory."""
    truth = classify_environment_signal(freq_mhz, amp_dbm)
    return (
        f"{truth['label']} | evidence={truth['confidence_label']} | "
        f"limit={truth['limit']}"
    )
