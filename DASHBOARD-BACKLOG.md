# Oracle Lattice OS (oracle.html) — fix & feature backlog

Owner-reported, June 25. For Claude Code. **Rules:** `oracle.html` is served statically (hard-refresh to apply); NEVER whole-file-rewrite it — surgical edits only; verify against the real file (mount can lie). Knock out the BUGS first (quick, high-value), then the FEATURES. Log each batch in the Codex.

## A. BUGS (do these first)

1. **Resize splitter is dead.** The drag-divider that splits panels (click-hold drag up/down to resize) no longer moves. It worked before — something broke it. Find the divider drag handler (likely `.rc-divider`/`.rc-split` or a resize handle) and restore the pointer drag-to-resize.

2. **Logs / Issues section is broken/incomplete.**
   - "Issues" and "Warnings" are lumped together — separate them; the filter only shows one.
   - Only ~3 logs appear when there should be many more — the feed isn't pulling the full set.
   - Wrong info shows in the wrong areas/filters. Audit the log source + the filter logic.

3. **Memory Lattice shows only ~3 of 6 numbers** (half the metrics blank/missing). Find why half the lattice metrics don't render and show the full, updated set.

4. **Login / profile session bug.** Clicking your own name (while logged in) should open YOUR profile. When **Taz** was logged in, his name showed but it routed to the **owner's** profile. The "click name → profile" must use the *logged-in* user's identity, not a hardcoded/owner one. Also: on login, the Humans/Guests list should actually load (it sits on "Loading identities…").

5. **Leo's config window overflows the screen** — it expands past the viewport and isn't scalable like the other config modals. Make the config panel fit + scroll within bounds (max-height + overflow), responsive like the rest.

6. **Radar: remove Providers + leaderboard items.** The System Radar shouldn't list Providers (or the leaderboard-type axes) — trim those axes; keep the meaningful ones.

7. **KAI provider mislabel.** KAI's settings say he uses **Ollama**, but KAI is **RSHL (the lattice), not Ollama**. Ollama is only present to optionally enable the BitNet *transformer* path — and selecting/enabling that should restart KAI (config write + restart, like other AIs). Relabel KAI's "provider" so it's honest (e.g. "RSHL lattice (native)", with the Ollama/BitNet transformer as a clearly-labeled optional toggle that restarts on change).

8. **Config area should be on-demand, not always-on.** The large center "config" area should only appear when the user clicks something that needs a settings/large-config page — right now it duplicates what's already in the right panel. Gate it behind an explicit "open settings" action.

9. **URL routing.** The app always shows `localhost:3001/` regardless of view/tab/popup — no `/` or `#` reflecting the current view. Add hash-based (or path) routing so views/popups have real URLs (deep-linkable, indexable, back/forward works).

## B. FEATURES

10. **Auth / session like Windows.**
    - Auto-logout (or lock) after a period of no movement/activity.
    - A **Sleep/Lock** button that locks the screen — log back in and **resume exactly where you left off** (preserve current view/state).
    - **Switch user** (user→user) without a full logout, so you don't lose your place. (Currently logging off + on wipes your last position.)

11. **Training view → animated classroom (replace the useless text feed).** Today the Training Activity panel is just "TRAINING + timestamp" lines — wasted space. Replace it with a **fixed-camera, back-of-classroom 8-bit scene** (reference image: top-middle view of a lecture hall) that role-plays the training pipeline in real time:
    - **Idle:** empty classroom.
    - **~Pre-3am:** teacher(s) walk in and set up.
    - **3:00–3:05am:** KAI walks in, sits in his seat, class starts.
    - **In sync with the pipeline phases:** ingest/lecture → KAI listens; when notes are needed → KAI writes notes; thinking → KAI writing/thinking animation; quiz/flashcards → matching beats.
    - **Subtitles** at the bottom (speaker name + what they said), driven by the real lecture/quiz text.
    - All animations are 8-bit and **driven by real pipeline events/phases** — so it mirrors what's actually happening.
    - **Pipeline tweak required:** `overnight_pipeline.py` should emit phase/event signals (teacher-arriving, lecture-start, KAI-listening, note-taking, quiz, etc.) the dashboard can subscribe to and animate. Slightly adjust timing so teachers arrive just before 3am and KAI at ~3:05.

## Suggested order
A1 (splitter) → A2/A3 (logs + lattice metrics) → A4 (profile/session) → A5 (Leo config overflow) → A6 (radar trim) → A7 (KAI provider label) → A8 (config on-demand) → A9 (URL routing) → B10 (auth/lock/switch) → B11 (classroom — biggest, do last; needs the pipeline signal tweak).
