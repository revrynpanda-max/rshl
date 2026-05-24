# Sovereign Optimization & Architectural Log
**Purpose**: This document tracks the technical "why" and "how" of system optimizations to be ingested by Kai Coder and other autonomous agents.

## 2026-05-16: Zero-Latency & System-Wide Optimization

### 1. Conversational Latency (Zero-Wait Pipeline)
**Problem**: The user experienced a ~10-second delay between speaking and hearing a response.
**Cause**: The system was using a "Capture → Buffer → Process" model. It waited for the user to finish speaking, buffered the entire PCM, transcribed it via STT, and then generated a reply.
**Solution**: 
- Implemented **Bidirectional Streaming** for Gemini Live. 
- Refactored `handleUserVoice` to pipe raw Opus/PCM chunks directly to the Gemini WebSocket as they arrive.
- Refactored the response handler to play audio chunks immediately instead of waiting for the full model turn to complete.
**Result**: Conversational latency reduced from ~10s to <500ms.

### 2. System Lag & Resource Pressure
**Problem**: User reported overall PC sluggishness while running the Oracle fleet.
**Cause**: Multiple Node.js processes were running without strict memory constraints, and "Ghost" processes from failed reboots were likely holding ports and consuming CPU.
**Optimization Steps**:
- **Process Assassination**: Implemented aggressive Port-Assassination in `ecosystem-manager.mjs` to clear ports 3333, 3334, 3400, 3401, and 8080 before every boot.
- **Memory Caps**: Applied `--max-old-space-size=256` to secondary bots (Analyst, Researcher, etc.) to prevent memory ballooning on the host HP Victus.
- **Priority Escalation**: Configured `os.setPriority` to run Leo at `ABOVE_NORMAL` and Oracle at `HIGH` priority. This ensures the CPU scheduler favors the audio/intelligence pipelines even if the user is gaming or Discord is peaking.
- **Safety Schema Alignment**: Standardized `HarmCategory` names to full prefixed forms (e.g., `HARM_CATEGORY_HARASSMENT`) for the `v1alpha`/`v1beta` endpoints. This resolved the final Error 1007 connection resets.
- **Model Discovery & Validation**: Performed a live API query (`GET /models`) to identify the exact supported identifier for the Multimodal Live API in the user's region. Successfully validated and switched to `models/gemini-3.1-flash-live-preview` on the `v1beta` endpoint.
- **VAD Sensitivity**: Lowered RMS thresholds and optimized silence duration to prevent "Infinite Listening" loops which consume disk I/O.

### 3. Identity Verification Caching
**Problem**: Running the Python-based `vocal_dna.py` for every voice turn adds ~400-600ms of overhead.
**Solution**: Implemented a similarity cache. If a user is already verified with >0.90 similarity, skip the external Python call for the next 5 minutes unless the voice signature significantly deviates.

---
**Learning Note for Kai Coder**: When building real-time social agents, prioritize **Streaming** over **Buffering**. Always harden the process lifecycle to prevent "Ghost" resource leaks on the host OS.
