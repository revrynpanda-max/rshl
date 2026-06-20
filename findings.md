# KAI Fleet Diagnostics Report

## TOP PROBLEMS, RANKED
1. **Engine Deadlock under Load**: `kai.exe` handles single `POST /api/rshl/query` requests fine (~7.4s), but when concurrency ramps up, the endpoint completely deadlocks and hangs indefinitely, preventing the stress test from finishing.
2. **Engine /api/status Failure**: `GET /api/status` breaks at `concurrency=50` with large payloads, returning a 100% error rate.
3. **Bot Storm Quota Burn**: The autonomous bots run rapid `consult_oracle` loops, which instantly exhaust API quotas, leading to `429` Gateway Errors and forcing the `CircuitBreaker` to trip a 2-minute cooldown across the ecosystem.
4. **Sandbox Instability**: `context-sandbox.mjs` slices chunks mid-word if they exceed length limits, and silently evicts the oldest draft when `MAX_SANDBOXES` is reached.

---

## TASK 1: Clean Slate
- Searched for stuck `kai.exe` processes (none found).
- Searched for stuck `Start-KAI.ps1` PowerShell launchers and forcefully killed PID `14936`.

## TASK 2: Pin the TTS Model
- Checked `C:\KAI\tools\oracle-discord\.env`. The `LEO_TTS_MODEL` property was missing.
- Appended `LEO_TTS_MODEL=gemini-2.5-flash-preview-tts` to the end of the file.

## TASK 3: Boot the Fleet
- Executed `.\Start-KAI.ps1 -FullFleet`. 
- Observed the launcher progress successfully:
  - `[0/4] Detected 40207 MB RAM -> engine ceiling 23320 MB (~58%).`
  - `[1/4] Ollama already serving on :11434.`
  - `[2/4] Waiting up to 300s for the engine to answer on :3334`
  - `[2/4] Engine READY on :3334.`
  - `[3/4] Supervisor up...`
  - `[4/4] Starting the fleet`
- *Outcome: The launcher's console allocation fix worked! Direct fallback was NOT needed.*

## TASK 4: Verify Online Services
Polled the core endpoints before running the stress test:
- **KAI Engine 3334 (/api/session)**: `UP` (Status: 200)
- **Ollama 11434 (/api/tags)**: `UP` (Status: 200)
- **OpenJarvis 8080 (/health)**: Initially returned `DOWN - Unable to connect`. Checked `openjarvis.out.log` and found it just takes time to warm up. ~60s later it printed `"GET /health HTTP/1.1" 200 OK` (`UP`).
- **Dashboard 3001**: Initially `DOWN`, eventually `UP`.
- **Bot Processes**: Found 13 `node.exe` processes running the fleet ecosystem.

## TASK 5: Full Stress Test
Started `node C:\KAI\tools\oracle-discord\stress-test.mjs --include-heavy --include-writes` against the live system.
- **KAI Engine `GET /api/session`**: Handled perfectly up to `c=50`. (p50=103ms, err=0%).
- **KAI Engine `GET /api/status`**: Broke at `c=50` (payload=100000B), giving a 100% error rate.
- **KAI Engine `POST /api/rshl/query`**: Handled normal payload safely (`status=200 7457ms`). However, once the concurrency ramp hit, the endpoint **deadlocked the script completely**. It produced no further output and hung indefinitely, preventing the test script from finishing and writing `stress-report.md`. 

## TASK 6: Live Deep Probes
1. **Work-bot storm**:
   - `ecosystem.log` shows bursts of `Groq Executing Autonomous turn...` and `Kai Coder executing consult_oracle`.
   - **Errors Hit**: Within seconds, the bots hit rate limits: `Attempt 1 Gateway Error: 429`. 
   - **Circuit Breaker**: Followed immediately by `Provider gemini_CC9Q STREAK 1. COOLDOWN for 2m due to error 429`.
2. **Resource Ceilings**:
   - `kai.exe` memory was dynamically observed around `~1.48GB` after the boot cycle/stress test began.
   - `python` (supervisor) hit `~181MB`.
   - The primary breaking limits are the **API Quota Providers** (Moonshot/Gemini instantly 429ing) and the **Rust Thread Lock** (deadlocking on heavy `/api/rshl/query` hits).
3. **Leo Voice (TTS)**:
   - Captured the newly pinned fallback model working beautifully!
   - `[Leo] [Leo/TTS] loadSandbox routing: book=true ... → DEDICATED TTS`
   - `[Leo] [Leo/TTS] Starting dedicated TTS audiobook read ("KAIVERSE") in voice "Charon".`
   - `[Leo] [Leo/Speech] AudioPlayer: idle -> buffering -> playing`
   - *No HTTP 404 errors observed. The pinned TTS model succeeds.*

## TASK 7: Sandbox Review
- Chunking splits cleanly on sentences, but violently cuts words in half if they exceed the `HARD_MAX` of 2000.
- When reaching `MAX_SANDBOXES` (50), the RAMP logic just silently drops the oldest draft, deleting a user's session without warning.
- The TTS stream overwrites the standard lane. If the TTS engine faults, it may not restore the `AudioPlayerStatus.Idle` event listener properly, muting the AI.

---
## NOTED FOR LATER
- The KAI Engine `WorkingSet` dropped significantly during the stress-test deadlock, suggesting heavy internal memory reclamation or a supervisor cycle that happened silently.
- OpenJarvis is entirely fire-and-forget but delays dashboard health endpoints by up to 2 minutes on a cold boot.
