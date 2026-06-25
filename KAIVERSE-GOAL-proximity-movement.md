# GOAL (for Antigravity): KAIVERSE movement — (A) proximity-scaled flight + (B) controller doesn't move the camera

**Status:** OPEN — TWO objectives below (Part A: speed/scale near planets; Part B: gamepad can't move). Do NOT mark complete until every acceptance criterion in BOTH parts passes a live test.

---

# PART A — proximity-scaled flight so huge planets FEEL huge

**Status:** OPEN — do NOT mark complete until every acceptance criterion below passes a live test.
**File:** `C:\KAI\kaiverse.js` (the WebGL KAIVERSE explorer, served inside `oracle.html` via `<script src="kaiverse.js">`).
**Owner report (verbatim intent):** "I move way too fast around planets when I'm close — looks like spectate mode. Planets are HUGE not small, but movement doesn't sell that. Slow me down near a surface so it feels proportional."

---

## 1. The problem (grounded in the real code)

Free-fly movement is the `'fly'` camera branch in the camera-update function (around **lines 2248–2414** of `kaiverse.js`). Speed is throttle-driven:

- `NS_FLY_MAX` (~1800·NS_SCALE·NS_SPREAD), `NS_FLY_MIN` (~180·…), `NS_FLY_ACCEL`, `NS_FLY_DAMP` — lines **2233–2238**.
- `nsThrottleSpeed()` (scroll throttle, quadratic) — line **2246**.
- A **PROXIMITY DECELERATION** block ALREADY exists — lines **2366–2402** — it computes `surfMin` (distance to nearest body surface), `rNear` (that body's radius), an eased `_absCap`, and clamps `effTop = min(_absCap, topSpeed*analog)`; collision is at lines **2404–2414** (`minD = r*1.09`, terrain-aware).

**Root cause of the "spectate" feel:** the near-surface speed FLOOR scales WITH planet size and distance, so the bigger the planet, the faster you're still allowed to crawl:

```
slow = max(NS_SCALE*5, rNear*0.0022, surfMin*0.09, cruise*_eased)   // line 2384
```

- `rNear*0.0022` → on a HUGE planet (`rNear` large) this floor is large, so even at the surface you keep a high absolute speed.
- `surfMin*0.09` → allows ~9%/s of your distance-to-surface, i.e. you always reach the surface in ~11 s no matter the scale — that's still a fast visual sweep across a giant body.
- The decel band `_band = rNear*16` (line 2384) starts the slowdown proportional to radius, but the floors above dominate near the surface.

Net: movement is *mathematically* scale-relative but *perceptually* still a blur past giant planets. We want it to genuinely CRAWL near a surface so the scale reads.

---

## 2. Desired behavior

When the camera is near a large body's surface, effective flight speed should drop to a slow, **scale-invariant "surface-radii per second"** feel — you should approach and skim a huge planet like it's huge (slow, weighty), not strafe it like a small prop. Far from any body, full throttle cruise is unchanged. The transition must be smooth (no snap), and it must apply in EVERY mode where the user can fly close (not just `'fly'`).

---

## 3. Acceptance criteria (ALL must pass a live test — this is the "done" gate)

1. **Crawl at the surface.** Hovering ~1–2 radii from the LARGEST planet, at full throttle (scroll maxed), the camera visibly creeps — it takes **noticeably longer than ~8–10 s** to traverse one planet-radius of arc near the surface. The surface should read as enormous.
2. **Scale-invariant feel.** The "near-surface" speed feels the SAME (in radii-per-second) on the smallest body and the largest body — a huge planet must NOT let you move faster in absolute blur just because `rNear` is big. (i.e. the `rNear*0.0022` size-coupled floor is removed or replaced with a radius-RELATIVE measure.)
3. **Full cruise preserved far away.** In open space (no body within, say, ~20 radii), throttle behaves exactly as today — long traverses are still fast. No regression to interstellar travel time.
4. **Smooth ramp, no snap.** Approaching a planet, speed eases down continuously (the existing `_absCap` smoothing is kept/tuned); there is no sudden stop or visible step.
5. **Applies in all close-range modes.** The proximity scaling is active in `'fly'` AND any follow/orbit movement where the user can get within a few radii. On-foot/`'walk'` mode is unaffected (already glued to the surface).
6. **No clipping.** Collision still holds — the camera never passes through a surface; the existing `minD` clearance (lines 2409–2412) still works and the slowdown means you ease into it instead of slamming.
7. **Throttle still meaningful near a planet.** Scroll throttle still changes speed near a body (so you can choose slow-crawl vs slightly-faster-survey), just within the new lower near-surface ceiling.
8. **Mobile + gamepad parity.** The on-screen thrust pad (touch, ~lines 4505+) and gamepad analog stick (`NS._gpMag`) get the same proximity scaling — phones/controllers also crawl near a surface.
9. **Tunable + reversible.** New numbers are constants (or `window.KAIVERSE_*` overrides like the existing `KAIVERSE_FLY_MAX/MIN`) so the owner can tune the near-surface speed without code surgery. Change is behind nothing that breaks the default boot.

---

## 4. Implementation guidance (suggested, not prescriptive)

- Reframe the near-surface cap as **radii-per-second**, not size-coupled units: e.g. `nearSpeed = clamp(surfMin, 0, _band) → map to (k_min … k_max) * rNear` where the coefficients give, say, **0.05–0.4 planet-radii/sec** at/near the surface. This makes criterion #2 fall out naturally and kills the `rNear*0.0022` absolute floor.
- Keep the smoothed `_absCap` (line 2387) and the `effTop` clamp (lines 2401–2402); you're mostly replacing the `slow = max(...)` formula on line **2384** and making sure the chosen body set + band cover follow/orbit too.
- Lower the `surfMin*0.09` coefficient (e.g. → ~0.02–0.04) so close approach truly crawls; verify against criterion #1.
- Expose `KAIVERSE_NEAR_RADII_PER_SEC` (or similar) `window` overrides for tuning.
- Sanity-check `NS_SCALE` / `NS_SPREAD` interaction so floors don't reintroduce a size coupling.

---

## 5. Hard constraints

- **Surgical edits only** — do NOT rewrite `kaiverse.js` wholesale (project history of truncation; keep diffs small and targeted).
- **`node --check kaiverse.js` must pass**, and the file must remain complete (it currently passes the pre-boot KaiScanner `node --check`).
- **Reversible:** keep the old formula in a comment or behind a flag so it can be reverted fast.
- **Verify on the Windows host** (or in-browser), not the Linux mount (the mount can serve a stale/truncated snapshot of large files and lie — confirm against the real file).
- After it's working, append a short CHANGELOG entry to **The KAI Codex** (the project's single source of truth) describing the change.

---

## 6. Definition of done

A live flight test where the owner cruises across open space at full speed, approaches the biggest planet, and the camera **eases into a slow, weighty crawl that makes the planet feel genuinely huge** — with all 9 acceptance criteria checked off. Until then, Part A stays OPEN.

---

# PART B — controller (gamepad) cannot move the camera

**Owner report:** "The controller doesn't work — I can't move around."

## B1. The problem (grounded in the real code)

Gamepad polling exists: `nsPollGamepad(dt)` at **line 3671**, called every frame from `nsTick` at **line 3874**. Left stick → WASD flags, right stick → look, RB/LB → up/down, L3 → run, D-pad → throttle (lines **3695–3704**). It reads `gp.axes[0..3]` and writes `NS.keys`. Despite this, the controller moves nothing.

`NS.active` (gate at line **3680**) is set true by `nsActivate()` (line 4373) whenever the KAIVERSE view is open and rendering, so if the scene is visibly animating that is NOT the blocker. The likely real causes:

1. **Non-standard mapping is unhandled (most likely).** The code hard-reads `gp.axes[0]/[1]` for the left stick assuming Xbox "standard" mapping and never checks `gp.mapping`. DualShock/DualSense, 8BitDo, many Bluetooth/clone pads report `mapping !== "standard"` with the sticks on DIFFERENT axis indices — so the left stick does nothing while the pad still shows as "connected."
2. **Browser hasn't exposed the pad.** The Gamepad API only surfaces a pad after a button press WHILE the page is focused (and only in a gamepad-supporting browser/visible tab). If the dashboard tab isn't focused, or no button was pressed since load, `navigator.getGamepads()` returns all-null and the poll early-returns (line 3684).
3. **No visible detection feedback in practice.** Detection only writes to `#ns-status` on the `gamepadconnected` event; if that element is offscreen or the event fired before listeners attached, the owner gets no signal about whether the pad is even seen.

## B2. Immediate diagnostic (do this FIRST, it decides the fix)

Open the KAIVERSE, **click the 3D canvas to focus it**, then **press any button on the controller** and watch the status line (`#ns-status`):
- **"Controller connected: <name>" appears** → detection works; the bug is mapping (#1) or axis layout. The `<name>` tells you the pad type. Proceed to map-fix.
- **Nothing appears** → the browser isn't exposing the pad (#2): focus/first-press/browser. Use a Chromium browser, ensure the tab is focused, press a face button, retry.

## B3. Acceptance criteria (ALL must pass a live controller test)

1. **Left stick moves the camera** (forward/back/strafe) in the KAIVERSE on the owner's actual controller, in fly mode.
2. **Right stick looks** (yaw/pitch) smoothly.
3. **Works regardless of `gp.mapping`** — handle both `"standard"` and non-standard pads (DualSense/8BitDo/Bluetooth): detect mapping and route stick axes correctly, with a sane fallback that scans axis pairs if the layout is unknown.
4. **Visible "controller detected" indicator** that updates live (name + a tiny axis/stick readout) so the owner can SEE the pad is seen and which way the stick is read — invaluable for future debugging.
5. **First-press/focus handled gracefully** — once the owner presses a button with the canvas focused, movement works for the rest of the session; if the pad drops, status reflects it.
6. **Deadzone is sane** (current `DZ=0.26`) — no drift at rest, full range usable.
7. **RB/LB up-down, L3 run, D-pad throttle** all function (or are remapped to whatever the owner's pad exposes).
8. **No regression to keyboard/mouse or touch** controls.

## B4. Implementation guidance (suggested)

- Read `gp.mapping`. If `"standard"`, keep `axes[0..3]`. If not, add a fallback: pick the first two axis-pairs with live movement, or a small per-pad remap table; expose a `window.KAIVERSE_PAD_AXES=[lx,ly,rx,ry]` override for manual fixes.
- Add an on-screen debug HUD (toggle) showing `gp.id`, `gp.mapping`, and live `axes[]` values so mapping problems are diagnosable at a glance.
- Make the "connected" status robust: also set it the first frame a non-null pad with any pressed button / non-zero axis is seen (not only on the `gamepadconnected` event).
- Keep the same `NS.keys` bridge so all downstream movement (including Part A's proximity scaling) just works.

## B5. Definition of done (Part B)

The owner picks up THEIR controller, presses a button, sees a clear "connected" indicator, and the left stick flies the camera + right stick looks — on their specific pad — with all B3 criteria checked. Until then, Part B stays OPEN.

---

## Shared constraints (both parts)

- **Surgical edits only** — no wholesale rewrite of `kaiverse.js` (truncation history); small targeted diffs.
- **`node --check kaiverse.js` must pass**; file stays complete.
- **Verify against the REAL file / in-browser**, not the Linux mount (it can serve a stale/truncated snapshot of large files).
- **Reversible** (keep old code commented or flag-guarded).
- Log both fixes in **The KAI Codex** changelog when done.
