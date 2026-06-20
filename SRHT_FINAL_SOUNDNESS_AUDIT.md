# SRHT — FINAL INDEPENDENT SOUNDNESS AUDIT

**Auditor stance:** independent, adversarial. Goal = try to BREAK the patched canonical
formalism, not rubber-stamp it. Every claim below was re-derived from the operator
definitions by hand; the document's own assertions were not trusted. Where the math holds, it
says so with the derivation; where it is wrong, overstated, or vacuous, it says that plainly
and shows the counterexample.

**Date:** 2026-06-19
**Primary object:** `SRHT_MASTER_PAPER.md` (patched: rank-based R∈(0,1], continuous χ∈[0,1],
X=χ(1-R) diagnostic-only, g(R)=R²/(2-R), normalized Ĉ=g(R)(1-χ)²∈[0,1], single gate
"prune iff Ĉ<θ").
**Supporting:** `SRHT_MATH_AUDIT.md`, `SRHT_MATH_VERIFICATION.md`.

**Compute status (read first).** The isolated Linux sandbox (numpy/sympy) was **UNAVAILABLE**
at audit time (`Workspace unavailable … VM service not running`). Therefore **no experiment
in §6 was executed and no numerical benchmark table is reported.** Every symbolic/algebraic
result below is derived by hand with all steps shown and labeled accordingly. Experiments
remain **[NEEDS EXECUTION]**. **No numbers are fabricated.**

---

## 1. OPERATOR WELL-FORMEDNESS — independently verified

### 1.1 g(R)=R²/(2-R): domain → range  [PROVEN]

- **No pole on the domain.** Only pole at R=2. On R∈(0,1], 2-R∈[1,2), so 2-R≥1>0. No
  singularity anywhere in the operating range. (The paper says "2-R∈[1,1.99)"; the exact
  closed interval is [1,2), and on (0,1] specifically 2-R∈[1,2). Trivial wording slip, not a
  math error: at R→0⁺, 2-R→2⁻; at R=1, 2-R=1. So 2-R∈[1,2) on (0,1]. **Confirmed no pole.**)
- **Maps (0,1] into (0,1].** g(0⁺)=0⁺/2→0⁺ (>0, never attained at 0 since R>0); g(1)=1/1=1.
  g is continuous and (see below) strictly increasing, so its image on (0,1] is (0,1].
  **Confirmed g(R)∈(0,1].**
- **g'(R) re-derived (quotient rule):**
  g'(R) = [2R(2-R) − R²(−1)]/(2-R)² = [4R − 2R² + R²]/(2-R)² = (4R − R²)/(2-R)² =
  **R(4−R)/(2−R)²**. On (0,1]: R>0, (4−R)≥3>0, (2−R)²>0 ⟹ **g'(R)>0 strictly.** g is
  injective and order-preserving in R. **Confirmed — matches the document.**

### 1.2 Ĉ = g(R)(1−χ)² ∈ [0,1]  — re-proven from scratch  [PROVEN]

g(R)∈(0,1] (§1.1). χ∈[0,1] ⟹ (1−χ)∈[0,1] ⟹ (1−χ)²∈[0,1]. The product of a value in
(0,1] and a value in [0,1] lies in [0,1]. **Ĉ∈[0,1] confirmed.**
- Ĉ=1 iff g(R)=1 and (1−χ)²=1 ⟺ R=1 and χ=0. Attained. ✓
- Ĉ=0 **exactly** iff (1−χ)²=0 ⟺ χ=1 (because g(R)>0 strictly for all R∈(0,1] — R never
  equals 0, so the "Ĉ→0 as R→0⁺" path is a limit, not an attained zero). The document's
  phrasing "Ĉ=0 iff χ=1" is correct as an *attained* statement; "Ĉ→0 as R→0⁺" is correctly
  flagged as a limit. **No error.**
- Partials: ∂Ĉ/∂R = g'(R)(1−χ)² ≥ 0 (rises with resonance); ∂Ĉ/∂χ = −2(1−χ)g(R) ≤ 0
  (falls with contradiction). No sign reversals. **Confirmed.**

### 1.3 Rank-based R ∈ (0,1]  [PROVEN]

R = 1 − (‖V‖−V_min)/(V_max−V_min+ε), ε>0. Let s = V_max−V_min ≥ 0.
- Denominator s+ε ≥ ε > 0 — **never vanishes.** Removes the original GS=0 singularity. ✓
- At ‖V‖=V_min: fraction 0 → R=1 (attained). At ‖V‖=V_max: fraction s/(s+ε) →
  R = ε/(s+ε) ∈ (0,1]. So **R∈(0,1]**, with emergent floor R_min = ε/(s+ε) > 0. ✓
- **ε is load-bearing (verified).** Degenerate equal-cost set s=0: every sibling has
  ‖V‖−V_min=0 ⟹ R=1 for all (ranking correctly defers to χ). Without ε this is 0/0.
  Confirmed: ε is not cosmetic. ✓
- **Edge case I checked that the doc only half-covers:** if a candidate has ‖V‖ **outside**
  [V_min,V_max] (impossible if V_min,V_max are the true set extremes, but possible if they are
  stale/fixed reference bounds, see §5), R can exceed 1 or go ≤0. With *rolling* set min/max
  this cannot happen (V_min,V_max are by construction the extremes). With *fixed reference
  bounds* (the optional §2.3.3 upgrade) it CAN, and R would need an explicit clip to (0,1].
  **The doc's range proof silently assumes rolling bounds; the fixed-bound upgrade needs a
  clip the doc does not state.** Minor but real — see §5.

### 1.4 X = χ(1−R) ∈ [0,1)  [PROVEN]

χ∈[0,1], R∈(0,1] ⟹ (1−R)∈[0,1). Product ∈[0,1). Sup→1 as χ→1, R→0⁺, **not attained**
(R>0 strictly). **Confirmed X∈[0,1) always, independent of any X_max constant.** The retirement
of the stale X_max=0.99 is therefore justified — that value was inherited from the *old*
hand-set floor R=0.01, where X_max=1−0.01=0.99. Under rank-R there is no 0.01 floor.
**The patch correctly drops it; X is diagnostic-only. Confirmed.**

### 1.5 χ = clip_{[0,1]}(v/v_max)  [PROVEN, with one driver guard]

v≥0, v_max>0 ⟹ v/v_max∈[0,∞), clipped to [0,1]. Well-formed **iff v_max>0** — the driver
must enforce v_max≥1 (the doc states this hygiene guard). Saturation above v_max loses
resolution among the already-pruned tail (acceptable). **Confirmed.**

**§1 verdict: operators are well-formed. One unstated edge case (fixed-bound R needs a clip);
otherwise sound. Ĉ∈[0,1], g'(R)>0, X∈[0,1), no singularities — all independently reproduced.**

---

## 2. THEOREM 1 (REDUNDANCY, Bucket B) — independently re-derived  [PROVEN]

**Setup.** R(d) strictly decreasing, χ(d) non-decreasing, ρ,τ constant across siblings.
Ĉ(d) = g(R(d))·(1−χ(d))².

**Within a χ-plateau** (χ constant): by the chain rule,
dĈ/dd = g'(R)·R'(d)·(1−χ)².
- g'(R) > 0 (§1.1),
- R'(d) < 0 (R decreasing in cost),
- (1−χ)² ≥ 0.
⟹ **dĈ/dd ≤ 0**, strict where χ<1. (I re-did this product of signs myself: (+)(−)(+) = (−).) ✓

**At a χ jump-up:** χ increases ⟹ (1−χ)² decreases ⟹ Ĉ jumps **down** (g(R) continuous in
d). So Ĉ has no rising segment anywhere on [0,∞).

**Conclusion.** Ĉ is weakly decreasing in d, strictly where alive ⟹ order-reversing:
d(p₁)<d(p₂) ⟺ Ĉ(p₁)>Ĉ(p₂). Top-k by Ĉ = top-k by ascending d. **sort-by-Ĉ ≡ sort-by-cost.**
The prune gate (Ĉ<θ) kills only the high-d tail the beam slice discards anyway. **Confirmed
as a correct theorem.**

**Adversarial check — boundary/step cases.** I specifically checked the only way this could
fail: a *downward* χ step (χ decreasing in d) would make (1−χ)² jump UP and could create a
rising segment, breaking monotonicity. But the hypothesis explicitly requires χ **non-
decreasing** in d. As long as that holds, no rising segment. **The theorem is correctly
conditioned; the conclusion is a genuine theorem (Bucket B), not an error.** It is also
inherent: any strictly monotone reparametrization of a single scalar preserves its order. ✓

---

## 3. THEOREM 2 (GUIDANCE, Bucket A) — independently re-derived  [PROVEN]

**Setup.** χ bound to a cost-independent predicate. p_A valid (χ_A=0, (1−χ_A)²=1), cost d_A;
p_B violating (χ_B>0), cost d_B<d_A ⟹ R_B>R_A ⟹ g(R_B)>g(R_A).

**Crossover, solved from scratch.** Set Ĉ_A = Ĉ_B:
g(R_A)·1 = g(R_B)·(1−χ_B)² ⟹ (1−χ_B)² = g(R_A)/g(R_B) ⟹ 1−χ_B = √(g(R_A)/g(R_B))
⟹ **χ* = 1 − √(g(R_A)/g(R_B)).**
Because R_A<R_B ⟹ g(R_A)/g(R_B)∈(0,1) ⟹ √(·)∈(0,1) ⟹ **χ*∈(0,1).** ✓ **The stated formula is
algebraically correct** (I re-solved it independently and got the identical expression).

**Non-reproducibility by cost-only sort.** For χ_B>χ*, Ĉ_A>Ĉ_B while d_A>d_B: a LONGER branch
outranks a SHORTER one. Any pure-cost ranking sorts strictly by d and would always place the
shorter p_B first. Hence this ordering is **provably unreproducible by any same-width cost-only
beam.** ✓ This is the one genuine, non-redundant contribution.

**Hidden-assumption hunt.** Three assumptions are real and should be named (the doc names them
but I confirm they are load-bearing):
1. **χ_B>0 must be attainable for a comparison "at comparable depth."** The crossover is only
   *useful* when χ* is small, which requires g(R_A)/g(R_B)≈1, i.e. siblings of comparable cost.
   For a very large cost gap, g(R_A)/g(R_B)→0 and χ*→1, so only near-total violation flips the
   order — the guidance weakens smoothly with the cost gap. This is correct behavior, not a
   bug, but it means the "even a mild violation flips the order" claim holds **only for
   comparable-cost siblings.** The doc states this ("g(R_A)/g(R_B)≈1, so χ* is small"). ✓
2. **The valid branch must survive the prune gate.** Checked in §4: with χ_A=0, Ĉ_A=g(R_A)>0,
   so any θ small enough not to over-prune retains p_A. Holds. ✓
3. **χ must genuinely be cost-independent.** If corr(χ,d)→1 it slides into Bucket B (Theorem
   1) and the contribution vanishes. Correctly documented as the governing dichotomy. ✓

**§3 verdict: Theorem 2 is correct; crossover formula verified; contribution is real and
non-redundant within its stated scope.**

---

## 4. THE SINGLE-GATE PATCH — is the consolidation actually lossless?

**Claim under test.** "prune iff Ĉ<θ" subsumes BOTH old gates {P<ε OR X>θ_X·X_max} losslessly.

### 4.1 The easy direction (both old failure modes ARE low-Ĉ)  [PROVEN]

- **High contradiction:** χ→1 ⟹ (1−χ)²→0 ⟹ Ĉ→0 regardless of R. The old P<ε limb is
  *identical* to Ĉ<ε since P≡Ĉ — trivially captured by Ĉ<θ for θ≥ε. ✓
- **Low resonance:** R→0⁺ ⟹ g(R)→0 ⟹ Ĉ→0 for any χ<1. Captured by a θ>ε. ✓

So every branch with very low P or with R near 0 has low Ĉ. **This part is genuinely true.**

### 4.2 The HARD direction — and where the §2.4 "proof" is vacuous (adversarial)  [ANALYTICAL]

The §2.4 argument defines **θ := sup{ Ĉ(R,χ) : χ(1−R) > θ_X·X_max }** and then declares: by
construction every X-pruned branch has Ĉ≤θ, so the single floor catches them. **This is true
but circular/vacuous as a "losslessness" claim** — it *defines* θ to be exactly large enough.
The real question an adversary must ask is the CONVERSE:

> Does that θ also prune branches the old gates would have KEPT? If yes, the single gate is
> **not order-equivalent** to the old pair — it is *strictly more aggressive*, i.e. NOT lossless
> in the "same surviving set" sense; it only guarantees "superset of what the old gates pruned."

**This is the crux, and the honest answer is: the single gate is a SUPERSET pruner, not an
exact reproduction of the old pair.** I show it with a concrete construction.

**Counterexample to exact equivalence (constructed and hand-checked).** Take the old X-gate
threshold high, as originally specified (X>0.8). 
- *Branch U (old-X-pruned, highest-Ĉ leaker):* I maximize Ĉ subject to X=χ(1−R)=0.8. The
  X-pruned set's sup-Ĉ defines θ. Try χ=0.8, R=0 is illegal (R>0); try χ=0.9, R=1−0.8/0.9=
  0.1111. Then Ĉ = g(0.1111)(1−0.9)² = (0.012346/1.8889)(0.01) = 0.006536·0.01 = **6.54e-5.**
  Try χ=1, R=0.2 (X=0.8): Ĉ = g(0.2)·0 = 0 (χ=1 zeroes it). Try χ=0.85, R=1−0.8/0.85=0.0588:
  Ĉ=g(0.0588)(0.15)² = (0.003460/1.9412)(0.0225)=0.001782·0.0225=**4.01e-5.** The sup over the
  X-pruned set is on the order of ~1e-4. So θ must be ≳1e-4 to subsume the X-gate.
- *Branch W (old-KEPT, but low Ĉ):* χ=0, R=0.04 ⟹ X=0·0.96=0 (NOT X-pruned), P=g(0.04)=
  0.0016/1.96=8.16e-4 > ε (NOT P-pruned). **Old gates KEEP W.** But Ĉ_W = g(0.04)·1 = **8.16e-4.**

Here Ĉ_W=8.16e-4 > θ≈1e-4, so in THIS pair the single gate happens to spare W. So far so good.
But now drive R_W lower: χ=0, R=0.01 ⟹ X=0 (kept), P=g(0.01)=1e-4/1.99=**5.03e-5** > ε (kept).
Old gates KEEP this branch. Its Ĉ = 5.03e-5 < θ≈1e-4. **The single gate Ĉ<θ PRUNES it.**

**Result: I found a branch (perfectly valid, χ=0, merely worst-cost R≈0.01) that the OLD gates
KEEP but the single Ĉ<θ gate PRUNES.** Therefore the consolidation is **NOT lossless in the
strict "identical survivor set" sense.** It is a **superset-pruning consolidation**: it prunes
everything the old pair did, PLUS some additional low-Ĉ branches (the worst-cost valid tail).

### 4.3 Does this break SRHT? No — but the doc overstates "lossless."  [ANALYTICAL]

The extra-pruned branches are exactly the **lowest-Ĉ, worst-cost valid branches at the bottom
of the beam** — branches the top-k beam slice would discard anyway (the same "high-d tail"
remark used in Theorems 1 and 2). So:
- **Operationally harmless:** for any sensible θ (a small fixed floor or β·beam-best), the
  extra branches killed are bottom-of-beam and would be sliced off regardless. The valid-but-
  longer branch p_A of Theorem 2 has Ĉ_A=g(R_A) with R_A a *mid-rank* (not worst) resonance,
  so it is retained. Guidance is preserved (confirmed §3, assumption 2).
- **But the literal claim "loses nothing / every branch the old gates KEEP is also kept" is
  FALSE.** What is true is the weaker, still-useful statement:
  **{old-pruned} ⊆ {Ĉ<θ}** (subsumption holds) but **{Ĉ<θ} ⊋ {old-pruned}** (strict superset)
  — the single gate prunes the union of the old gates AND the worst-cost valid tail.

**§4 verdict.** The patch's *subsumption* direction is correct: a single Ĉ-floor does prune
everything the old dual gate pruned (§4.1, easy direction). But the document's stronger
framing — "loses nothing," "introduces no spurious failure mode," "single floor introduces no
spurious pruning" — is **OVERSTATED.** The single gate is strictly MORE aggressive: it also
prunes worst-cost-but-valid (χ=0, low-R) branches that the old gates would have retained
(§4.2 counterexample). This is **operationally benign** (those branches are bottom-of-beam) but
the §2.4 "lossless" / "no spurious pruning" wording is not literally true and should be
restated as: *"the single Ĉ-floor subsumes both old gates (superset pruning); the extra pruned
branches are the worst-cost tail the beam slice discards anyway, so guidance and boundedness are
preserved."* This is a **wording/over-claim defect, not a mechanism defect.**

---

## 5. CROSS-SECTION CONSISTENCY SCAN

I scanned the full master paper for stale X_max usage, contradictions with the retractions, and
mislabeled provenance.

- **Stale X_max=0.99:** In the master paper it appears ONLY inside §2.3.1 and §2.4 as the
  *retired* quantity being explained, and inside §2.4's definitional θ=sup{…X>θ_X·X_max…}. The
  live gate everywhere is "prune iff Ĉ<θ." **No live use of the stale constant remains in the
  master paper.** ✓ (Note: the *supporting* `SRHT_MATH_AUDIT.md` §4.5 and
  `SRHT_MATH_VERIFICATION.md` §0 still print the OLD dual-gate equation set with X_max=0.99 —
  but those are explicitly the pre-patch documents, and `VERIFICATION.md` §7 records the patch.
  So no contradiction *within the canonical doc*; the supporting docs are correctly marked as
  superseded.)
- **Retraction consistency (SVP/crypto/complexity/quantum):** §5 retracts (1) complexity
  collapse, (2) crypto/SVP, (3) Born-rule physics, (4) weak baselines. I checked the body for
  leftover contradicting claims: the abstract (§1) explicitly disclaims universality, crypto-
  breaking, and Hilbert-space content; §4.B.2 and §4.C list SVP as Bucket B / REDUNDANT /
  RETRACTED; no surviving sentence asserts a complexity collapse or a crypto break.
  **Consistent.** ✓
- **Provenance tags:** I spot-checked each. [PROVEN] tags on Ĉ∈[0,1], g'(R)>0, no singularity,
  Theorem 1, Theorem 2 crossover, τ/ρ scaling invariance, X∈[0,1) — all are pure algebra I
  re-derived and confirm (§§1–3 here). **Correctly [PROVEN].** The §2.4 consolidation is tagged
  [PROVEN] but, per §4 above, only the *subsumption* direction is proven; the "lossless / no
  spurious pruning" part is **NOT** proven and is in fact false as stated — this tag should be
  **downgraded to [PROVEN (subsumption only)] + correction**. The TSP/KAI/parameter-plateau
  items are [NEEDS EXECUTION]/[ANALYTICAL] — correct, since nothing was run. SVP-Bucket-B is
  [PROVEN] (mechanism) + [NEEDS EXECUTION] (vs LLL/BKZ) — correct. **One mislabel found: the
  §2.4 losslessness [PROVEN] tag is too strong.**
- **Bucket A / Bucket B classification — independently re-checked each row of §4.C:**
  - TSP+self-intersection: crossings independent of length → χ carries info length doesn't →
    **Bucket A.** ✓
  - Scheduling: precedence/resource violations independent of makespan → **A.** ✓
  - Graph coloring: monochromatic edges independent of #colors → **A** (cost weak). ✓
  - Bin packing: overflow often hard-infeasible, partly cost-implied → **partial A.** ✓
  - 3-SAT: if R and χ both come from the same conflict count → collapses to **B**; only A if a
    *distinct* cost exists, which pure SAT lacks → **degenerate A / ≈ min-conflicts.** ✓
  - KAI decoding: grammar violations independent of token improbability → **A.** ✓
  - Plain TSP: χ="too long" is a function of length → **B.** ✓
  - **SVP as written: χ from Minkowski/GS bound, and that bound is a monotone function of the
    very norm ‖V‖ being minimized.** So χ(‖V‖) is monotone in the cost → Theorem 1 applies →
    Ĉ order-equivalent to sort-by-norm → **Bucket B, REDUNDANT.** I confirm this independently:
    the GS/Minkowski gate provides NO information beyond the norm itself, so it cannot reorder
    siblings relative to a norm sort. **Correctly Bucket B; the SVP/crypto retraction is sound.**
    ✓
  - Pure-likelihood decoding: χ from log-prob, monotone in cost → **B.** ✓
  **All bucket classifications are correct.**

**§5 verdict: internally consistent. One provenance mislabel (§2.4 "lossless" over-tagged
[PROVEN]). No stale X_max in the live formalism; retractions fully consistent; every
Bucket A/B assignment correct, including SVP-as-Bucket-B.**

---

## 6. EXPERIMENTS — NOT RUN (sandbox unavailable)

The numpy/sympy Linux sandbox failed to start at audit time (`VM service not running`). Per the
honesty contract I did **not** fabricate any numbers. The following remain **[NEEDS
EXECUTION]**:
- (a) sympy confirmation that g'(R)=R(4−R)/(2−R)²>0 on (0,1] and Ĉ∈[0,1]. *(Hand-derived and
  confirmed analytically in §1; machine cross-check pending.)*
- (b) TSP-with-self-intersection, N=30, beam≈20, ≥30 seeds, paired Wilcoxon/sign test vs plain
  beam. **[NEEDS EXECUTION]** — runnable scripts exist in VERIFICATION §5.2 / AUDIT §6.2.
- (c) 3-SAT constraint-pruning demo. **[NEEDS EXECUTION]** — script in VERIFICATION §5.3;
  predicted to be Bucket-B-degenerate when R and χ share the conflict count.

**No result is upgraded to [PROVEN] on the empirical axis.** The cherry-picked 3-seed TSP table
(seeds 7/9/13, "up to 22.42") remains **unverified** and inadmissible as evidence.

---

## 7. FINAL VERDICT

**Within its stated scope — a constraint-aware best-first (beam) search that helps in Bucket A
(validity independent of cost) and is provably redundant in Bucket B (validity a monotone
function of cost) — the patched SRHT is mathematically SOUND and internally consistent.**

Independently re-derived and CONFIRMED:
1. Operator well-formedness: Ĉ∈[0,1], g(R)∈(0,1], g'(R)=R(4−R)/(2−R)²>0, R∈(0,1], X∈[0,1),
   no singularities, ε load-bearing. **[PROVEN]**
2. Theorem 1 (redundancy / Bucket B) — correct theorem, correctly conditioned. **[PROVEN]**
3. Theorem 2 (guidance / Bucket A) — χ*=1−√(g(R_A)/g(R_B))∈(0,1) algebraically correct;
   non-monotone ordering unreproducible by cost-only sort. **[PROVEN]**
4. SVP-as-written is genuinely Bucket B (GS/Minkowski gate is a function of the minimized
   norm); SVP/crypto/complexity/quantum retractions are sound. **[PROVEN]**
5. All Bucket A/B classifications correct; no stale X_max in the live formalism. **[PROVEN]**

DEFECTS / OVERCLAIMS FOUND (none fatal, all in scope):
- **D1 [real overclaim].** The §2.4 "single gate is LOSSLESS / introduces no spurious pruning"
  is **false as stated.** The single Ĉ-floor SUBSUMES both old gates ({old-pruned}⊆{Ĉ<θ}) but
  is strictly MORE aggressive: it also prunes worst-cost-but-VALID branches (χ=0, low-R) that
  the old gates kept (concrete counterexample in §4.2). This is operationally benign (those are
  bottom-of-beam branches the slice discards anyway) and does NOT harm Theorem 2 guidance, but
  the word "lossless" and the [PROVEN] tag should be downgraded to **"subsumption proven;
  superset-pruning, not survivor-set-identical."**
- **D2 [minor].** The fixed-reference-bound R upgrade (§2.3.3) can produce R∉(0,1] if a
  candidate's cost falls outside the reference window; it needs an explicit clip to (0,1] that
  the doc does not state. (Rolling bounds are immune.)
- **D3 [tracking, not math].** All experiments remain [NEEDS EXECUTION]; sandbox was down. The
  3-seed TSP win remains unverified/cherry-picked.

NOT defects (correctly left intact): Theorem 1 redundancy and SVP-Bucket-B (inherent theorems);
signal fragility (cost–constraint correlation, noisy χ, non-monotone benefit in beam width) —
real limitations, honestly documented.

**Bottom line:** The core mathematics is sound and the honest repositioning (modest,
conditional, non-universal) is correct. To be fully airtight, the paper must **(D1)** replace
"lossless single gate" with "subsumption / superset pruning" and re-tag §2.4, and **(D2)** add
a clip to the fixed-bound R variant. Fixing the wording of D1 and the clip of D2 makes the
patched formalism fully consistent with its claims. **No mathematical error invalidates SRHT
within Bucket A; the only thing wrong is one overstated word ("lossless") and one unstated
clip.**
