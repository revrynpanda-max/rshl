# GOAL (for Claude Code CLI): KAIVERSE 3rd-person camera + controls fix (browser `kaiverse.js`)

**Status:** OPEN. Owner-reported while flying. Browser `kaiverse.js` only (Tier 1.5 player ship + controls). Surgical, reversible, flag-gated; **do NOT alter `nsUpdateCamera` first-person movement math** — the 3rd-person view is an additive, render-only layer (see `CLAUDE-CODE-HANDOFF.md` SCOPE box). Hard-refresh to apply.

**Workflow:** the owner is the tester (he flies + reports), the architect writes these specs, you (CLI) implement. Eyeball-iterate: ship one small change, owner flies + reports, tune. Don't guess the feel — that's his call.

---

## 1. Controller B button = BACK / CANCEL (not "return to core")
B is hardwired to "return to core" — wrong. Make it context-dependent **back/cancel**:
- **Any mode, if a menu / overlay / star-chart is open → B closes it** (back out one level).
- **If nothing is open → B does nothing** (no surprise teleport-to-core).
- Leave the rest as-is: **A** = select nearest (fly) / jump (walk); **Y** = land (fly) / take off (walk); **X** = unused for now.
- (Return-to-core stays on the keyboard **H**.)

## 2. Throttle — make it DYNAMIC + analog + controller-driven (it feels "unreal")
The owner says the throttle speed is "way too unreal." Two fixes:

**(a) Analog throttle from the controller.** The throttle should be a smooth 0→1 driven by an analog control — **right trigger (RT)** as the primary throttle (light press = slow cruise, full press = full speed), and/or left-stick magnitude as it already half-does. Map it into `NS.throttleT` continuously, not in coarse D-pad steps. Keyboard/no-pad behavior stays as-is.

**(b) Kill the "unreal" feel.** Right now top speed / acceleration reads teleporty. Make world-speed **dynamic and believable**:
- The effective top speed should EASE in/out smoothly (no instant jump to max) — keep/strengthen the existing acceleration ramp + damping.
- It must scale with context: **fast in open space, genuinely slow as you near a body's surface** (the NMS scale illusion — this is already the proximity-deceleration block; tune it so the crawl near a surface feels real, the cruise in deep space feels fast-but-not-teleporty).
- Lower the raw max cruise speed if open-space flight still feels "unreal." Expose it as `window.KAIVERSE_MAX_SPEED` (and the analog curve) so the owner can A/B in the console.
- **Do not** change how thrust direction is derived — only the speed magnitude / smoothing / analog mapping.

## 3. 3rd-person camera — fix the GTA "reverse-cam" flip (the main issue)
**Bug (owner's words):** "when I move it makes me view forward, but then the camera view shows in front of where I'm going — like GTA when it looks at you moving toward the camera, then back to 3rd person, then back. It's not great." → The camera is oscillating between **behind** the ship and **in front of** it.

**Cause:** the chase camera is anchoring/recentering on the **velocity vector** (or flipping the offset sign), so when velocity and look-direction disagree, the camera swings to the front and snaps back. Classic velocity-based-recenter glitch.

**Fix — anchor the camera to the LOOK/HEADING direction, never to velocity:**
- Chase target position = `shipPos − fwd * chaseDist + up * chaseHeight`, where `fwd` is the **look/flight forward** (the same basis `nsUpdateCamera` already builds), `up` is the camera up. The camera **always** sits behind where the nose points — it can never cross to the front.
- **Remove any "recenter behind velocity" logic.** Do not use `c.vel` direction to place or orient the camera. Velocity only feeds the *pull-back distance* (faster = farther + slightly wider FOV), never the *angle*.
- **Spring-damper LAG on the camera POSITION only** (lerp `NS._chasePos` toward the target each frame) so it swings smoothly when you turn — but the target is always behind `fwd`, so it can't flip.
- `cam.lookAt(shipPos)` (look at the ship), camera up = the flight up. No sign flips.
- **Render-only, restored each frame:** apply the offset between a `pre()`/`post()` wrap around the render call; after render restore `cam.position` to the real ship position so next frame's movement starts from the ship, not the chase point. `nsUpdateCamera` movement stays byte-for-byte unchanged.
- **Toggle, default first-person.** Flag-gated (`window.KAIVERSE_THIRDPERSON` / a key).

**Guardrails (verify after):**
- **Click-to-fly picking** must raycast from the REAL ship position, not the pulled-back chase position (else clicks select the wrong body).
- **Proximity bloom / atmosphere** distance must sample the REAL ship position, not the chase camera (else effects fade from the wrong spot / the atmosphere wall returns).
- First-person feel unchanged when the toggle is OFF.

### Acceptance (owner look-test)
1. B backs out of menus, never teleports to core.
2. Throttle responds analog to the trigger; open-space cruise feels fast-but-real, the approach to a surface slows to a believable crawl — no teleporty jumps.
3. In 3rd-person the camera **stays smoothly behind the ship at all times** — no flip to the front, no GTA reverse-cam, no snapping. Turning swings the camera around smoothly.
4. First-person (toggle off) is identical to before. Picking + proximity effects still correct.
