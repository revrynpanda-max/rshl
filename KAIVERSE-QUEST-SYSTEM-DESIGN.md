# KAIVERSE Quest System — design spec ("errors are quests, fixes are real hotfixes")

**Status:** FOUNDING DESIGN. The spine of the playable KAIVERSE. Graphics are a separate track — this is the *mechanic*.
**Core idea:** the KAIVERSE is a live system visualized as an explorable universe. Real system errors become **quests**; the digital beings (KAI, Leo, the agents) are the **quest-givers**; completing a quest triggers a **real remediation** on the live system (a gamified hotfix). Playable in-browser now, wrappable for **Steam (Tauri/Electron)** and **phone (PWA)** later, with `command-center-server` as the world authority.

---

## 1. The core loop

```
REAL ERROR  →  TRANSLATE (LLM)  →  QUEST (story + objective + target planet/character)
            →  PLAYER ACTS (go to planet, talk to being, do the task)
            →  REMEDIATION (real fix, gated by permission tier)
            →  REWARD (rep / progression / cosmetics)  →  universe updates (live hotfix)
```

The innovation is this loop. Everything else (planets, ships, nebulae) is set dressing that can improve over time. Build the loop first, even ugly.

---

## 2. The translation layer — raw error → readable quest (THE most important piece)

Today the player sees developer-speak they can't action:

> `Oracle → OraclePipeline` · `SELF-CONSULT skipped: Analyst would route to itself (Analyst). Handling locally. Q="[Break down the Cellular Directive problem…]"`

No "average joe" reads that and knows what to do. So each error is run through an **LLM translator** (use the agents / Kai Coder — they already generate text) that emits a structured quest:

```json
{
  "questId": "oraclepipeline-self-consult-2026-06-24T17:32",
  "sourceError": "OraclePipeline: SELF-CONSULT skipped: Analyst would route to itself…",
  "title": "The Analyst's Echo",
  "giver": "Analyst",                 // which digital being asks for help
  "planet": "Analyst",                // where to fly
  "story": "Analyst tried to ask for a second opinion — but the only voice that answered was its own. Its thoughts are looping back instead of reaching the council. Fly to Analyst's world and break the echo so its questions reach the others.",
  "objective": "Go to Analyst. Re-route its self-consult to the council instead of itself.",   // the bottom-screen subtitle
  "difficulty": "advanced",
  "tier": "operator",                 // who can see/do it (see §4)
  "remediation": "route_self_consult_to_peer",   // the REAL fix this maps to (see §3)
  "reward": { "rep": 40, "tag": "Loop-Breaker" }
}
```

- **Title + story + objective** are AI-generated, procedural per error, in the voice of the giver (Grok unhinged, Leo road, KAI thoughtful…). Subtitles at the bottom, NMS-style.
- **One translator prompt, reused** for every error type. Cache the translation so the same recurring error reuses its quest text.
- Keep a human-readable + a "view raw logs →" toggle (you already have the raw/full view) for the technical players who *want* the developer detail.

---

## 3. The fix → real-change bridge (this already half-exists)

A quest's `remediation` maps to a **concrete, pre-defined action** on the live system — NOT arbitrary code. Reuse what's already in the stack:
- **Propose-a-change** quests → Leo's existing `request_code_change` tool (goes to owner DM for approval) or a Kai-Coder-drafted patch. Completing the quest = submitting the proposal; it deploys only on approval. **Gamified PR review.**
- **Safe-action** quests → a whitelisted remediation the server can apply within guardrails: failover a cooled provider, clear a cache, restart a single bot (you already have the gated restart endpoint + control token), re-queue a training topic, prune disk.
- **Report/explore** quests → no system change; the player surfaces/confirms an issue (cheap, safe, good for public players).

Every remediation is a **named entry in a whitelist** with: what it touches, which tier may trigger it, and whether it auto-applies or needs owner approval. Nothing else can be triggered from the game. (See §5 — this is the safety core.)

---

## 4. Role-tiered quests (you raised this exactly)

The same error feed, filtered by who's looking:
- **Owner / Admin (you):** sees everything — critical Sentinel triggers, engine errors, pipeline failures, security. Can approve/deploy real changes.
- **Operator (trusted):** sees fixable ops issues — provider cooldowns, voice-pipeline hiccups, basic engine errors. Can trigger whitelisted safe actions + submit proposals.
- **Explorer / Public:** sees *story* quests and report-only tasks; can explore, talk to beings, surface issues, earn rep — but **cannot execute system changes.** They make the world feel alive without being an attack surface.

The error catalog gets a `minTier` per error TYPE (e.g. `Sentinel EMERGENCY` = admin; `provider cooldown` = operator; `lore/ambient` = explorer).

---

## 5. SAFETY — the real hard problem (not graphics)

A game where players cause real changes on your machine is powerful AND a live attack surface. Non-negotiable rules:
1. **Whitelist only.** Quests can only trigger *named, pre-approved* remediations (§3). No free-form code execution from the game, ever.
2. **Approval gates by tier.** Anything that writes code/config or restarts: owner approves (or a narrow trusted tier). Public players never execute.
3. **Sandboxed + reversible.** Auto-applied safe actions run within the existing guardrails (control token, sandbox dir, `.kai-backups`), and are reversible.
4. **Rate-limit + audit.** Every quest-triggered action is logged (who, what, when, which remediation) — a real audit trail (this also fixes the "who did what" provenance problem from earlier).
5. **Fail safe.** If a remediation errors, it rolls back and the quest stays open; it never half-applies.

Get this right and you've invented "ops-as-play." Get it wrong and a stranger can brick your machine. This layer is built FIRST, before any public access.

---

## 6. Procedural storyline + characters

- Each being is a **quest-giver with personality** (reuse the existing bot personas + voices). Grok narrates unhinged, Leo road, KAI thoughtful.
- The LLM strings related errors into **arcs** (e.g. recurring provider failures → a "supply lines are failing" storyline) so it's not just one-off chores.
- Ambient/lore quests (no system change) keep explorers engaged between real issues.

---

## 7. Build order (mechanic first, graphics parallel/later)

1. **Translator + quest object** — turn the live error feed into structured quests with AI title/story/objective. (Pure data + one LLM prompt. Highest value, lowest risk.)
2. **Quest UI** — readable quest cards + bottom-screen subtitle objectives + "view raw logs" toggle, replacing the raw error wall.
3. **Remediation whitelist + safety tiers** (§3/§5) — wire 3–5 safe remediations + the propose-for-approval path. Audit log.
4. **Role tiers** (§4) — filter quests by viewer.
5. **Rewards/progression** — rep, tags, leaderboard (you already have a leaderboard).
6. **Distribution** — Tauri/Electron wrap for Steam; PWA for phone; server stays authority.
7. Graphics polish (bloom/terrain/ships) runs as a *separate* track — never block the loop on it.

**Done = a player sees "The Analyst's Echo," flies to Analyst, completes it, and a real (gated) fix lands on the live system, logged and reversible.** That's the whole product in one vertical slice — build that slice first.
