# Sparse Resonance Hyperlattice Theory (SRHT): The Canonical Master Paper

**Author:** Ryan (Inventor, Independent Researcher)
**Collaborator & Editor:** KAI Engine Mathematics Group
**Status:** Living canonical reference — supersedes all prior SRHT documents
**Date:** June 19, 2026

> **This document supersedes and consolidates five prior documents:**
> `SRHT_UNIVERSAL_SOLVER_PAPER.md`, `SRHT_CRITIQUE_AND_PROOF.md`,
> `SRHT_HARDENING_PLAN.md`, `SRHT_MATH_AUDIT.md`, `SRHT_MATH_VERIFICATION.md`.
> Where those documents disagree, **the corrected and verified math (Audit §4.5 +
> Verification) is canonical**; the original "universal solver" formulation is retained
> only as historical context and for the explicitly-retracted claims in §5. All future
> SRHT work folds into THIS file.

> **Provenance convention used throughout.** Each result is tagged:
> **[PROVEN]** = derived rigorously (hand-derived algebra, elementary and checked);
> **[ANALYTICAL]** = sound analytical prediction, not yet machine-confirmed;
> **[NEEDS EXECUTION]** = a claim that requires running code/benchmarks to confirm;
> **[RETRACTED]** = a prior claim withdrawn, with the reason given.
> The original empirical tables (TSP/SVP timings) were never independently re-run and are
> treated as **unverified** unless re-tagged here.

---

## 1. Abstract & Honest Positioning

**SRHT is a constraint-aware best-first (beam) search framework.** It fuses, into a single
bounded scalar score, (i) progress toward an objective and (ii) satisfaction of validity
constraints, then prunes branches whose constraint violation is high. Its one rigorously
defensible property is conditional and sharp:

> **SRHT provably helps when validity (constraint violation) is INDEPENDENT of the cost
> being optimized, and is provably REDUNDANT — order-equivalent to plain sort-by-cost —
> when validity is a (monotone) function of that cost.**

This single dichotomy organizes the entire paper. SRHT is **not a universal solver.** It
does **not** collapse worst-case exponential complexity to polynomial. It does **not** break
lattice cryptography; the original SVP/crypto claims are **retracted** (§5) because, as
specified, the SVP constraint is a function of the very norm being minimized, placing it in
the redundant regime. The "Born-rule / quantum interference" vocabulary of the original
draft is restated honestly as a **classical cosine constraint-gate** with no Hilbert-space
content. What remains after this pruning is modest but real and testable: a particular smooth,
multiplicative fusion of progress and *independent* constraint scores, plus a pruning gate,
that can rank a valid-but-costlier branch above an invalid-but-cheaper one — behavior no
same-width cost-only beam can reproduce.

---

## 2. The Canonical Formalism (Corrected, Verified Operators)

A state particle propagates through a discrete lattice. At each partial solution we evaluate
the operators below. **These are the corrected forms (Audit §4.5, stress-tested in
Verification), not the original paper's forms.** The original operators ($\tau$-scaled $C$,
the GS-dependent $R$, the discrete $\chi$ steps, the $\cos$ "Born-rule" gate) are deprecated.

### 2.1 Operator definitions (domain → range)

| Symbol | Name | Definition | Domain | Range |
|---|---|---|---|---|
| $\rho$ | Lattice density / progress | $\rho = \lvert A\rvert / d$ | $\lvert A\rvert\in\{0,\dots,d\}$, $d\ge1$ | $[0,1]$ |
| $R$ | Resonance (rank-based) | $R = 1-\dfrac{\lVert V\rVert - V_{\min}}{V_{\max}-V_{\min}+\epsilon}$ | finite costs, $\epsilon>0$ | $(0,1]$ |
| $\chi$ | Contradiction (constraint-bound, continuous) | $\chi = \operatorname{clip}_{[0,1]}\!\big(v(p)/v_{\max}\big)$ | $v\ge0$, $v_{\max}>0$ | $[0,1]$ |
| $g(R)$ | Resonance term | $g(R) = \dfrac{R^2}{2-R}$ | $R\in(0,1]$ | $(0,1]$ |
| $\hat C$ | Normalized commit score | $\hat C = g(R)\,(1-\chi)^2$ | $R\in(0,1],\chi\in[0,1]$ | $[0,1]$ |
| $P$ | Survival score (single gate) | $P = \hat C = g(R)\,(1-\chi)^2$ | as $\hat C$ | $[0,1]$ |
| $X$ | Contradiction pressure (diagnostic) | $X = \chi\,(1-R)$ | as above | $[0,1)$ |
| prune | Gate / prune rule (**single, consolidated**) | prune iff $\hat C<\theta$ | $\theta\in[0,1)$ a single score floor | — |

> **Single consolidated gate (resolves former defects #3 and #4).** Pruning is now **one
> criterion on the normalized score**: a branch is pruned iff $\hat C<\theta$, where $\theta$
> is a single floor (a fixed small constant, e.g. $\theta=10^{-3}$, or a fraction of the
> current beam-best, $\theta=\beta\cdot\max_{\text{set}}\hat C$ with $\beta\in[0,1)$). The old
> dual rule (`$X>\theta X_{\max}$` **or** `$P<\varepsilon$`) is retired. $X$ is retained only
> as a **diagnostic** quantity, not a gate. The stale $X_{\max}=0.99$ scaling is therefore
> dropped entirely (see §2.4 for the proof that one $\hat C$-floor subsumes both old gates).

Here $\lvert A\rvert$ = number of assigned variables; $d$ = total dimension;
$\lVert V\rVert$ = current cost (path length for TSP, vector norm for SVP, token improbability
for decoding); $V_{\min},V_{\max}$ = min/max cost over the **current candidate (sibling)
set**; $v(p)$ = count/severity of violated constraints; $v_{\max}$ = a normalizer.

**Key design decisions encoded above (and why):**
- **$R$ is rank/spread-based, not GS/$\alpha$-based.** It needs no fragile absolute bound; the
  denominator $V_{\max}-V_{\min}+\epsilon\ge\epsilon>0$ never vanishes, removing the
  original's $\mathrm{GS}=0$ singularity. The old hand-set floor $0.01$ is replaced by the
  *emergent* floor $R_{\min}=\epsilon/(s+\epsilon)$ (where $s=V_{\max}-V_{\min}$).
- **$\chi$ is continuous and constraint-bound.** It replaces the cherry-pickable discrete
  steps $\{1.0,0.6,0.1\}$ and the resulting $81{:}1$ cliff with a smooth, swept measure.
  **The binding of $\chi$ to constraints INDEPENDENT of cost is the entire contribution
  (§3, §4).**
- **$\hat C$ drops $\tau$ and $\rho$ from the per-layer ranking.** $\tau$ was a pure positive
  constant (no effect on sort); $\rho$ is constant across siblings at fixed depth (no
  intra-layer discrimination). Both are lossless to remove from the sort. $\rho$ is retained
  only as a cross-depth best-first priority; $\tau$ is removed entirely.
- **One gate shape, no "Born rule."** $P=\hat C$ uses a single $(1-\chi)^2$ gate. The old
  second $\cos(\chi\pi/2)$ factor is removed (it double-counted $\chi$).
- **One genuine prune criterion (RESOLVED).** Pruning fires on a single floor $\hat C<\theta$.
  A low $\hat C$ already captures *both* historical failure modes — high contradiction
  ($\chi\to1\Rightarrow(1-\chi)^2\to0$) and low resonance ($R\to0^+\Rightarrow g(R)\to0$) —
  so the separate $X$-gate is provably subsumed (§2.4). The old $X_{\max}$ scaling is gone.

### 2.2 Proven properties [PROVEN]

> **Full step-by-step derivations of every property below appear in Appendix A** (A.1 range of
> $\hat C$; A.2 monotonicity of $g$; A.3 bound on $X$; A.4 the $\epsilon$ floor).

1. **$\hat C\in[0,1]$.** $g(R)\in(0,1]$ and $(1-\chi)^2\in[0,1]$; the product of a value in
   $(0,1]$ and a value in $[0,1]$ lies in $[0,1]$. Maximum $\hat C=1$ iff $R=1$ and $\chi=0$
   (best-cost, fully valid); $\hat C=0$ iff $\chi=1$ (full violation), and $\hat C\to0$ as
   $R\to0^+$.
2. **$g$ strictly increasing: $g'(R)>0$.** By the quotient rule,
   $$g'(R)=\frac{2R(2-R)-R^2(-1)}{(2-R)^2}=\frac{4R-R^2}{(2-R)^2}=\frac{R(4-R)}{(2-R)^2}.$$
   On $R\in(0,1]$: $R>0$, $(4-R)>0$, $(2-R)^2>0\Rightarrow g'(R)>0$ strictly. So $g$ is
   injective and order-preserving in $R$.
3. **No singularity.** The only pole of $g$ is at $R=2$, outside the domain $(0,1]$, where
   $2-R\in[1,2)$. The rank-based $R$ has no singularity because its denominator is
   $\ge\epsilon>0$. **Confirmed: no pole anywhere in the operating range.**
4. **Gate endpoints exact.** $P=g(R)$ at $\chi=0$ (full survival); $P=0$ at $\chi=1$ (total
   suppression). Monotonicity of $\hat C$: $\partial\hat C/\partial R=g'(R)(1-\chi)^2\ge0$
   (rises with resonance); $\partial\hat C/\partial\chi=-2(1-\chi)g(R)\le0$ (falls with
   contradiction). No reversals — the intended shape.
5. **$\epsilon$ is load-bearing, not cosmetic.** In the degenerate equal-cost case ($s=0$),
   $R=1$ for all siblings (correct: resonance carries no information, ranking falls to
   $\chi$); without $\epsilon$ this would be $0/0$.

### 2.3 Residual defects — now RESOLVED [PROVEN] / honestly downgraded [ANALYTICAL]

The consolidation previously left three real, minor defects (#3 two correlated gates, #4 stale
$X_{\max}$, #5 over-claimed instance comparability). All three are patched below. The two
inherent theorems (monotonic redundancy, SVP-redundancy) are **not** defects and remain
untouched (§3, §4.B).

1. **[RESOLVED — defect #4] Stale $X_{\max}$ dropped.** The old gate used $X>\theta X_{\max}$
   with $X_{\max}=0.99$, a value inherited from the *old* hand-set floor $R=0.01$. Under
   rank-based $R$ this is simply wrong, and the scaling is unnecessary: since
   $X=\chi(1-R)$ with $\chi\in[0,1]$ and $R\in(0,1]$, we have $X\in[0,1)$ **always**,
   independent of $R$. **Fix:** the $X$-gate (and its $X_{\max}$ scaling) is **removed
   entirely**; $X$ is kept only as a diagnostic. Pruning is now the single $\hat C$-floor.
   *(For completeness: had we retained a relative $X$-gate, the self-consistent bound would be
   $X_{\max}=1-R_{\min}=s/(s+\epsilon)$ from the emergent floor $R_{\min}=\epsilon/(s+\epsilon)$
   — but the single-gate consolidation makes even that moot.)*
2. **[RESOLVED — defect #3] One honest gate, not two.** The former dual rule
   (`$P<\varepsilon$` **or** `$X>\theta X_{\max}$`) is collapsed into the single criterion
   **prune iff $\hat C<\theta$.** §2.4 proves this single floor *subsumes both* old gates: any
   branch the old pair would prune is also pruned by $\hat C<\theta$ for an appropriately
   chosen $\theta$ ($\{\text{old-pruned}\}\subseteq\{\hat C<\theta\}$). The consolidation is a
   **subsumption / superset prune**, not a survivor-set-identical equivalence: the single floor
   is strictly more aggressive, additionally pruning some worst-cost-but-valid ($\chi=0$, low-$R$)
   bottom-of-beam branches the old gates kept. This is operationally benign (those branches are
   sliced off anyway) and does not affect Theorem 2 guidance; the "single honest gate" is now one
   criterion, with its scope stated accurately (subsumption, not strict equivalence).
3. **[RESOLVED — defect #5, honestly downgraded] $\hat C$ is rank-comparable WITHIN a
   layer, NOT calibrated across instances.** We state this plainly rather than over-claim:
   $\hat C$ is **bounded** in $[0,1]$ (true) and is a valid **within-layer/within-beam rank
   coordinate** (the only place it is used for sorting/pruning). It is **NOT calibrated across
   different layers or instances**, because $R$ uses rolling set min/max — adding/removing a
   candidate rescales every sibling's $R$. The earlier "instance-comparable" phrasing is
   **retracted**. *Optional upgrade for true cross-instance comparability:* replace the rolling
   $V_{\min},V_{\max}$ with **fixed reference bounds** $V_{\min}^{\text{ref}},V_{\max}^{\text{ref}}$
   in $R$. **Required clip (do not omit):** with fixed bounds a candidate cost can fall *outside*
   the reference window ($\lVert V\rVert<V_{\min}^{\text{ref}}$ or $>V_{\max}^{\text{ref}}$), which
   would push $R$ outside $(0,1]$; therefore clamp after computing $R$:
   $R := \operatorname{clip}_{[\epsilon,1]}(R)$ (equivalently $R:=\min(1,\max(\epsilon,R))$) so that
   $R\in(0,1]$ is preserved for out-of-window inputs. (Rolling set min/max are immune to this — the
   bounds are by construction the extremes — so the clip is needed *only* for the fixed-reference
   option.) **Trade-off (stated, not hidden):** fixed bounds make $\hat C$ comparable across
   instances but partially reintroduce the old GS/normalizer-misestimation fragility (a
   mis-set reference rescales or saturates $R$). Use rolling bounds for robust intra-layer
   ranking; switch to fixed reference bounds only when cross-instance comparison is required
   and report sensitivity to the reference values. There is no free lunch here.

Remaining minor (non-defect) hygiene flags, carried forward unchanged: $\chi$ saturates above
$v_{\max}$ (cannot distinguish "bad" from "much worse" among the pruned — acceptable since both
are killed); the driver must guard the empty candidate set and ensure $v_{\max}\ge1$.

### 2.4 Consolidation proof: one $\hat C$-floor subsumes both old gates [PROVEN — subsumption only; strict equivalence is false]

> **The full subsumption proof plus the explicit superset counterexample (with hand arithmetic)
> is worked step by step in Appendix A.7.**

**Claim (corrected — subsumption, not equivalence).** Replacing the dual rule
{prune if $P<\varepsilon$ **or** $X>\theta_X X_{\max}$} by the single rule
{prune iff $\hat C<\theta$} is a **subsumption / superset prune**, *not* a lossless,
survivor-set-identical reproduction of the old pair. For an appropriate $\theta$, every branch
pruned by the old pair is also pruned by the single floor ($\{\text{old-pruned}\}\subseteq\{\hat C<\theta\}$),
so nothing the old gates killed survives. The single floor is, however, **strictly more
aggressive**: $\{\hat C<\theta\}\supsetneq\{\text{old-pruned}\}$, because it additionally prunes
some **worst-cost-but-valid** branches ($\chi=0$, low $R$) that the old gates would have *kept*.
This is **operationally benign** — those extra-pruned branches sit at the bottom of the beam (the
worst-cost valid tail) and are discarded by the top-$k$ slice anyway, so guidance (Theorem 2) and
boundedness are preserved — but the consolidation is a strict superset prune, **not** an
equivalence. The earlier "lossless / loses nothing / no spurious failure mode" framing is
**corrected to this subsumption statement.**

**Both old failure modes are already low-$\hat C$.** Recall $\hat C=g(R)(1-\chi)^2$ with
$g$ strictly increasing, $g(0^+)\to0$, $g(1)=1$.
- *High contradiction.* As $\chi\to1$, $(1-\chi)^2\to0$, so $\hat C\to0$ **regardless of $R$**.
  The old $P<\varepsilon$ floor fired exactly here; it is identical to $\hat C<\varepsilon$
  (since $P\equiv\hat C$), hence trivially captured by $\hat C<\theta$ for any $\theta\ge\varepsilon$.
- *Low resonance.* As $R\to0^+$, $g(R)\to0$, so $\hat C\to0$ for any $\chi<1$. This is the only
  region the old $X$-gate caught that $P<\varepsilon$ might miss (moderate $\chi$, low $R$, with
  $P$ still above $\varepsilon$). But there $\hat C=g(R)(1-\chi)^2$ is small precisely because
  $g(R)$ is small, so a single floor $\theta>\varepsilon$ catches it too.

**Subsumption (old $X$-gate $\Rightarrow$ $\hat C$-floor).** Suppose the old gate fires:
$X=\chi(1-R)>\theta_X X_{\max}$, i.e. the branch has simultaneously high $\chi$ and/or low $R$.
Write $X$ large $\Rightarrow$ either $\chi$ is near $1$ (then $(1-\chi)^2$ is near $0$) or $R$ is
near $0$ (then $g(R)$ is near $0$); in either limb $\hat C=g(R)(1-\chi)^2$ is small. Formally,
$(1-\chi)\le(1-\chi)\,$ and $1-R<1$ give $X=\chi(1-R)$, while
$\hat C\le g(R)(1-\chi)^2$; one can always pick a floor
$$\theta \;=\; \sup\{\hat C(R,\chi)\;:\;\chi(1-R)>\theta_X X_{\max}\}$$
(the largest score any old-$X$-pruned branch can have). By construction every branch with
$X>\theta_X X_{\max}$ has $\hat C\le\theta$, hence is pruned by the single floor. The
$P<\varepsilon$ limb is subsumed by taking $\theta\ge\varepsilon$. Therefore the union of the
two old gates is contained in $\{\hat C<\theta\}$ for $\theta=\max(\varepsilon,\theta\text{ above})$.

**Strict superset, not equivalence (the honest converse).** The single floor $\hat C<\theta$
prunes *more* than the old pair, not the same set. Concretely, a perfectly **valid** branch
($\chi=0$, so $X=0$ and $P=g(R)$) with merely worst-case cost ($R\approx0.01$) is **kept** by both
old gates ($X$ not high, $P>\varepsilon$) yet has $\hat C=g(R)\approx5\times10^{-5}<\theta$ and is
therefore **pruned** by the single floor. So $\{\hat C<\theta\}\supsetneq\{\text{old-pruned}\}$:
the consolidation is a **superset prune**, removing everything the old gates removed plus some
worst-cost-but-valid bottom-of-beam branches. These extra removals are genuinely low-score
branches (low resonance and/or high contradiction) at the high-cost / high-violation tail that any
beam slice would discard regardless (cf. Theorem 1 remark); in particular the mid-rank valid-but-
longer branch $p_A$ of Theorem 2 is **retained**, so guidance is unaffected. Thus the
consolidation is **subsumption-correct and operationally benign, but strictly more aggressive —
not lossless.** In practice $\theta$ is set directly (a fixed small floor or a fraction of the
beam-best) without ever computing $X$. $\blacksquare$

### 2.5 The patches preserve every good property [PROVEN]

The three fixes touch only the **prune rule** and the **comparability claim**; they do not
alter the operators $g,R,\chi,\hat C$ themselves. Hence:

- **$\hat C\in[0,1]$ — unchanged.** The score $\hat C=g(R)(1-\chi)^2$ is untouched; §2.2(1) and
  the Verification §1.4 proof carry over verbatim. Dropping the $X$-gate and renaming the floor
  to $\theta$ changes which branches are *removed*, not the *values* the survivors carry.
- **Theorem 2 (guidance) holds unchanged.** The crossover
  $\chi^\star=1-\sqrt{g(R_A)/g(R_B)}\in(0,1)$ derives purely from comparing two scores
  $\hat C_A>\hat C_B$; it never used $X$ or $X_{\max}$. The new single gate only prunes the
  high-cost/high-violation tail and, for any sensible $\theta$, the valid-but-longer branch
  $p_A$ (with $\chi_A=0$, $\hat C_A=g(R_A)>0$) is **retained** exactly as before, so the
  non-monotone ordering is fully preserved.
- **Theorem 1 (monotonic redundancy) unaffected.** The redundancy proof rests on
  $d\hat C/dd\le0$ under monotone $R(d),\chi(d)$ — a property of the score, not the gate. Any
  branch the new $\hat C$-floor prunes sits at the high-$d$ tail and would be dropped by the
  beam slice anyway, identical to the old remark in Theorem 1.

In short: the patches are confined to the gate and to one honesty downgrade; the score's
boundedness, the guidance crossover, and the redundancy theorem are all carried through intact.

### 2.6 Implementation Mapping (live KAI Rust engine ↔ this paper)

*(Additive note — paper and code as one source of truth. June 2026 reconciliation.)*

The live KAI engine (`src/core/field_state.rs`) now implements the **canonical ranking core
verbatim** and layers its engine-specific extensions on top as explicit positive modulators:

$$\underbrace{\hat C_{\text{core}} = g(R)\,(1-\chi)^2}_{\text{canonical, }[0,1]\text{, proofs hold}}
\qquad
\text{Commit} = \hat C_{\text{core}}\cdot \underbrace{\rho\cdot\gamma\cdot f(\sigma)\cdot g_{\text{goal}}\cdot \tau}_{\text{engine modulators (extensions)}}$$

- **Canonical core** `c_hat_core = g_kernel * contradiction_sq` with
  `g_kernel = R²/(2−R)` (R clamped to `[1e-3, 1]`) and `contradiction_sq = (1−χ)²`
  using the **continuous** χ (the engine's sigmoid-smoothed `chi_dynamic`). This is exactly
  $\hat C=g(R)(1-\chi)^2\in[0,1]$ — the score on which §2.2, Theorem 1, and Theorem 2 hold.
- **Engine modulators** $\rho$ (density), $\gamma$ (source vitality), $f(\sigma)$ (layer scale),
  $g_{\text{goal}}$ (goal-vector alignment), and $\tau$ (temporal recurrence) are **engine
  extensions OUTSIDE the proven ranking core.** They are strictly positive scalars, so within a
  fixed layer they **do not change the ranking** induced by $\hat C_{\text{core}}$ (a positive
  rescaling preserves order — cf. §2.2 note on $\tau,\rho$). They are honest engineering knobs,
  not part of the master-paper proofs.
- **Diagnostics.** $X=\chi(1-R)$ is computed and stored but is **diagnostic-only**; it gates
  nothing (verified: no `.x`-based prune anywhere in core). Pruning (`universe.rs`) uses a single
  soft floor on the normalized-commit proxy (`convergence_score`, the authoritative gate); there
  is **no** $X>0.8$, $P<10^{-10}$, or $\cos(\chi\pi/2)$ "Born-rule" gate in the core operators.
  *(Caveat: a legacy cosine/Born-style modulation still exists in the higher-level cognition
  layer — `cognition/language_warehouse.rs`, `cognition/polychora.rs` — outside the core SRHT
  operators; flagged for separate cleanup, not part of the canonical ranking core.)*

Thus the paper's proven core and the engine's score are now **one source of truth**: the proofs
apply to $\hat C_{\text{core}}$ as implemented, and the modulators are documented as extensions.

---

## 3. The Two Regimes (Central Organizing Principle)

Everything SRHT can or cannot do follows from one fact: whether $\chi$ carries information
the cost ranking does not. Two theorems make this precise.

### Theorem 1 (Redundancy — defines Bucket B). [PROVEN]

> **Fully worked product+chain-rule proof, with the step-function jump points handled explicitly,
> is in Appendix A.5.**

**Statement.** If $R$ and $\chi$ are both monotone functions of a single scalar cost $d$
($R(d)$ strictly decreasing, $\chi(d)$ non-decreasing), with $\rho,\tau$ constant across
compared siblings, then $\hat C(d)$ is monotone (weakly decreasing, strictly where alive) in
$d$, hence **sort-by-$\hat C$ $\equiv$ sort-by-cost.** The physics layer adds nothing.

**Proof.** Write $\hat C(d)=g(R(d))\,(1-\chi(d))^2$. On any interval where $\chi$ is constant,
$$\frac{d\hat C}{dd}=g'(R)\,R'(d)\,(1-\chi)^2,$$
with $g'(R)=\dfrac{R(4-R)}{(2-R)^2}>0$ (§2.2), $R'(d)<0$ (since $R$ decreases in cost), and
$(1-\chi)^2\ge0$. Therefore $d\hat C/dd\le0$, strict where $\chi<1$. At a point where $\chi$
jumps up, $(1-\chi)^2$ jumps **down**, so $\hat C$ jumps down. Hence $\hat C$ is decreasing on
all of $[0,\infty)$ with no rising segment. A (strictly, where alive) decreasing function is
order-reversing:
$$d(p_1)<d(p_2)\iff \hat C(p_1)>\hat C(p_2),$$
so the top-$k$ beam slice by $\hat C$ equals the top-$k$ slice by ascending $d$. Any branch
killed by the prune gate ($\hat C<\theta$) sits at the high-$d$ tail and would be dropped by
the beam slice anyway. $\blacksquare$

**Remark (inherent, not a defect).** *Any* score that is a monotone function of a single
optimized scalar is order-equivalent to that scalar — a strictly monotone reparametrization
preserves order. No amount of normalization can change this. The rank-based $R$ makes it
*more* transparent: $R=1-\text{rank-fraction}(d)$, so $g(R)$ is literally a monotone function
of cost-rank, and sorting by $g(R)$ *is* sorting by cost. **Redundancy in the monotonic regime
is a theorem; the correction correctly leaves it intact rather than hiding it.** This defines
**Bucket B**.

### Theorem 2 (Guidance — defines Bucket A). [PROVEN]

> **Complete crossover algebra (every step) plus the impossibility argument for cost-only scores
> is in Appendix A.6; numeric micro-examples are in Appendix A.8.**

**Statement.** If $\chi$ is bound to constraints **independent of cost** (e.g. structural
validity), then $\hat C$ is **non-monotone** in cost: a valid-but-costlier branch can be
ranked above an invalid-but-cheaper one — behavior unreproducible by any cost-only sort.

**Proof / crossover derivation.** Let $\chi=\chi_{\text{struct}}(p)$ depend on a predicate
independent of $d$. Take two siblings at comparable depth:
- $p_A$: cost $d_A$, **valid** $\Rightarrow v_A=0\Rightarrow\chi_A=0\Rightarrow(1-\chi_A)^2=1$;
- $p_B$: cost $d_B<d_A$ (so $R_B>R_A$, hence $g(R_B)>g(R_A)$), **violating**
  $\Rightarrow\chi_B>0$.

The score prefers the valid-but-longer $p_A$ over the shorter-but-invalid $p_B$ iff
$$\hat C_A>\hat C_B\iff g(R_A)\cdot1>g(R_B)(1-\chi_B)^2\iff (1-\chi_B)^2<\frac{g(R_A)}{g(R_B)}.$$
Since $R_A<R_B$ gives $g(R_A)/g(R_B)\in(0,1)$, there is a finite **contradiction crossover**
$$\boxed{\;\chi^\star \;=\; 1-\sqrt{\dfrac{g(R_A)}{g(R_B)}}\in(0,1)\;}$$
above which the valid-but-longer branch wins. For siblings at comparable depth,
$g(R_A)/g(R_B)\approx1$, so $\chi^\star$ is **small** — even a mild violation flips the order.
This ordering is strictly non-monotone in $d$ (a shorter branch ranked below a longer one),
which **pure-$d$ sorting cannot reproduce**, hence cannot be replicated by any same-width
cost-only beam. $\blacksquare$

**Why this escapes the greedy beam trap.** Plain beam search ranks only by $d$, so it always
prefers the shorter $p_B$ early, greedily committing to cheap-now segments that **force a
self-crossing (or other violation) later**. The constraint-gated $\hat C$ demotes $p_B$ below
$\chi^\star$, retaining the slightly-longer-but-viable $p_A$, avoiding the forced late defect.
With the **continuous** $\chi$ this is a *graded, smooth* trade-off (no hard $81{:}1$ cliff):
the more $p_B$ violates, the more cost advantage it must have to survive. This defines
**Bucket A** and is the one provably non-redundant contribution of SRHT.

> **Historical note.** The original used discrete steps $\{0.1,0.9\}$ giving a fixed cliff
> $(1-0.1)^2/(1-0.9)^2=0.81/0.01=81{:}1$. The continuous $\chi$ replaces this with the graded
> $\chi^\star$ above — a genuine refinement of a mechanism that was already correct.

---

## 4. Capability Catalog

The heart of the paper. **The one rule that decides every entry:** SRHT's $\chi$-gate does
real work **iff constraint-violation is NOT a monotone function of the optimized cost.** Below,
each capability gives (i) domain, (ii) how $\chi$ and $R$ are concretely defined, (iii) bucket
and why, (iv) worked example / expected result, (v) verdict.

### 4.A Bucket A — SRHT genuinely computes / guides

#### 4.A.1 Routing with structural constraints (TSP + no self-intersection) — the canonical demo

- **Domain.** Euclidean TSP: order $N$ cities to minimize tour length, with the structural
  requirement that the (partial) tour not self-intersect.
- **Operator binding.** $\lVert V\rVert=$ partial tour length; $R=1-\frac{d-V_{\min}}{V_{\max}-V_{\min}+\epsilon}$
  over the sibling set. $v(p)=$ number of segment crossings in the partial tour;
  $\chi=\min(1,\,v(p)/v_{\max})$. Crucially, **crossings are independent of length**: a short
  tour can cross, a long one need not.
- **Bucket & why.** **Bucket A.** $\chi$ (crossings) carries information length does not, so
  Theorem 2 applies; $\hat C$ is non-monotone in length.
- **Worked example / expected.** Two siblings: $p_B$ shorter but crossing
  ($\chi_B$ high $\Rightarrow(1-\chi_B)^2$ small), $p_A$ longer but clean ($\chi_A=0$). By the
  crossover, $p_A$ is retained and $p_B$ demoted, preventing a forced late crossover. The
  original critique reported SRHT beating plain beam by up to 22.42 units on $N=20$, width 20
  (seeds 7/9/13) — but **that was a 3-seed cherry-picked table; the honest claim is a
  significant NET edge over many seeds with a paired test**, with the edge expected to *shrink
  at large beam width* (plain beam then keeps the valid branch anyway). [NEEDS EXECUTION]
- **Verdict: WORKS.** The strongest demonstrated optimization case.

#### 4.A.2 Scheduling / resource-constraint problems

- **Domain.** Job/task scheduling minimizing makespan subject to precedence and resource
  constraints.
- **Operator binding.** $\lVert V\rVert=$ partial makespan; $R$ rank-based as above.
  $v(p)=$ count of precedence/resource violations; $\chi=\min(1,v/v_{\max})$.
- **Bucket & why.** **Bucket A.** A short schedule can violate precedence; violation count is
  independent of makespan. Classic constrained search — strong fit.
- **Expected.** SRHT retains feasible-but-slower partial schedules over infeasible-but-faster
  ones, escaping makespan-greedy traps. [NEEDS EXECUTION]
- **Verdict: WORKS.**

#### 4.A.3 Graph coloring / bin-packing / general CSP

- **Domain.** Graph coloring (minimize colors), bin packing (minimize bins), general CSP.
- **Operator binding.** Coloring: $v(p)=$ monochromatic edges, cost = #colors (weak).
  Bin-packing: $v(p)=$ capacity-overflow severity, cost = #bins.
- **Bucket & why.** **Coloring: Bucket A** (conflict count independent of color-count
  objective), with the caveat that cost is weak so $g(R)$ contributes little.
  **Bin-packing: PARTIAL Bucket A** — overflow is often a *hard* infeasibility better handled
  by a hard filter; SRHT helps only if overflow severity is graded and not implied by bin
  count.
- **Verdict: graph coloring WORKS (cost weak); bin-packing PARTIAL.**

#### 4.A.4 Boolean satisfiability (3-SAT)

- **Domain.** Satisfy a CNF formula; no meaningful cost, validity is everything.
- **Operator binding.** $v(p)=$ number of clauses violated by the partial assignment;
  $\chi=\min(1,v/v_{\max})$. There is essentially no independent cost, so $R$ is driven by a
  weak progress proxy and $g(R)$ is near-flat.
- **Bucket & why.** **Bucket A, but degenerate.** $\chi$ (unsat fraction) is the *entire*
  signal. **Warning:** if both $R$ and $\chi$ are derived from the *same* conflict count, the
  problem collapses into **Bucket B** (Theorem 1) — SRHT $\approx$ min-conflicts/penalty beam,
  results roughly equal. A genuine SRHT advantage on SAT requires a cost signal *distinct*
  from the constraint signal, which pure SAT lacks.
- **Verdict: PARTIAL.** Works as a clause-violation-guided beam, but reduces to standard
  min-conflicts search ("SRHT with the resonance term switched off"). Strong *fit* for the
  $\chi$-binding philosophy; little added by the $g(R)$ machinery.

#### 4.A.5 Constraint-aware sequence generation / KAI language decoding — the strongest legitimate fit

- **Domain.** Token-by-token decoding in the KAI engine, where grammatical/logical validity
  is a constraint *independent of* a token's raw probability.
- **Operator binding (the binding that matters).** $R$ = likelihood/progress
  ($\lVert V\rVert=$ token improbability, rank-based over candidate continuations).
  **$\chi$ must NOT be computed from sequence length or raw log-probability** (that reproduces
  the redundancy bug, Bucket B). Instead, bind $\chi$ to **explicit grammar/logic rule
  violations** evaluated on the partial generation — e.g. a parse-rule check in KAI's
  `algebra.rs` that sets $\chi$ high when a continuation violates the grammatical template
  (noun-after-noun where forbidden), breaks bracket/quote balance, or contradicts an asserted
  fact in the working context. The gate $P=g(R)(1-\chi)^2$ then performs constraint-aware
  decoding during top-k / nucleus sampling.
- **Bucket & why.** **Bucket A.** A locally high-probability token can be globally invalid —
  exactly analogous to a short-but-crossing segment. The constraint (parser/checker) is exact
  and independent of likelihood.
- **Expected test (on-mission, cheap, decisive).** On held-out prompts with machine-checkable
  constraints (balanced delimiters / valid JSON; a decidable grammar; a checkable factual KB),
  compare (i) standard top-k/nucleus, (ii) the same with a naive length/prob penalty (the
  redundant control), (iii) SRHT constraint-gated decoding. **Primary metric:** valid-output
  rate; **secondary:** fluency of valid outputs, compute overhead. Success = significant
  increase in valid-output rate over both baselines (paired test, $p<0.05$) with no meaningful
  fluency drop. [NEEDS EXECUTION]
- **Verdict: WORKS** (the strongest legitimate application; run this first).

> **Robustness note for all Bucket A uses.** The benefit is proportional to how
> *cost-independent* and *noise-free* the constraint is. If $\operatorname{corr}(\chi,d)\to1$,
> SRHT slides into Bucket B and gracefully degrades to plain beam (no harm, no benefit). If
> $v(p)$ is a *noisy* estimator, $\chi$ can misrank and SRHT can do **worse** than plain beam
> — hence exact checkers (a real parser, a real intersection test) are the safest, and noisy
> heuristic constraints the most dangerous. Benefit is also **non-monotone in beam width**:
> it peaks at moderate width (where plain beam is forced to discard the valid-but-longer
> branch) and vanishes at width 1 (no room to retain it) and at very large width (plain beam
> retains it anyway).

### 4.B Bucket B — SRHT is provably redundant (stated explicitly so no effort is wasted)

#### 4.B.1 Plain cost-minimization (TSP by distance alone)

- **Domain.** TSP minimizing tour length with no structural constraint.
- **Operator binding.** $R$ from length; $\chi$ from "too long" (a function of length). Both
  monotone in the single cost $d$.
- **Bucket & why.** **Bucket B** by Theorem 1: $\hat C$ is order-equivalent to sort-by-length.
  SRHT collapses exactly to plain beam search of the same width.
- **Verdict: REDUNDANT.** Use a plain beam / standard heuristic; the SRHT layer adds nothing.

#### 4.B.2 SVP / lattice reduction as written — **claim retracted**

- **Domain.** Shortest Vector Problem: find a short non-zero lattice vector; minimize
  $\lVert V\rVert$.
- **Operator binding (as in the original paper).** $\chi$ derived from the
  Minkowski/Gram-Schmidt bound, i.e. "norm vs GS bound." **The bound is a monotone function of
  the very norm being minimized.**
- **Bucket & why.** **Bucket B.** Because $\chi(\lVert V\rVert)$ is monotone in the cost,
  Theorem 1 applies and $\hat C$ is order-equivalent to sort-by-norm — **redundant.** Only if
  $\chi$ were re-bound to a *norm-independent* structural defect (e.g. a size-reduction /
  GS-coefficient condition not implied by the current norm) would SVP enter Bucket A; as
  written, it does not.
- **Consequence.** This **invalidates the SVP and lattice-crypto claims of the original
  paper.** The SRHT mechanism does **not** support the SVP results as specified. [RETRACTED]
  See §5.
- **Verdict: REDUNDANT (as written).** The honest experiment is to *confirm* this redundancy
  against LLL/BKZ, not to claim a speedup.

#### 4.B.3 Pure-likelihood / unconstrained decoding

- **Domain.** Token decoding ranked by raw likelihood, with $\chi$ taken from log-probability
  ("low prob = contradiction").
- **Bucket & why.** **Bucket B.** $\chi$ from log-prob is monotone in cost; SRHT reproduces
  ordinary likelihood ranking. This is exactly the failure mode the KAI binding (§4.A.5) is
  designed to avoid.
- **Verdict: REDUNDANT.**

### 4.C Capability summary table

| Capability | cost | $\chi$ bound to | Independent of cost? | Bucket | Verdict |
|---|---|---|---|---|---|
| TSP + self-intersection | tour length | # crossings | **Yes** | A | **WORKS** (canonical demo) |
| Scheduling / resources | makespan | precedence/resource violations | **Yes** | A | **WORKS** |
| Graph coloring | #colors (weak) | monochromatic edges | **Yes** | A | **WORKS** (cost weak) |
| Bin packing | #bins | overflow severity | partial | A* | **PARTIAL** |
| 3-SAT / CSP | none/weak | # unsat clauses | yes (degenerate) | A* | **PARTIAL** (≈ min-conflicts) |
| KAI grammar-constrained decoding | token improbability | grammar/logic rule violations | **Yes** | A | **WORKS** (strongest fit) |
| Plain TSP (distance only) | tour length | "too long" | No | B | **REDUNDANT** |
| SVP as written | $\lVert V\rVert$ | Minkowski/GS bound | **No** | B | **REDUNDANT** (claim retracted) |
| Pure-likelihood decoding | token improbability | log-prob | No | B | **REDUNDANT** |

---

## 5. Scope, Limits & Retracted Claims

**SRHT is not universal.** Its benefit is confined to Bucket A (validity independent of cost).
The following original claims are corrected or retracted.

1. **"Exponential → polynomial / $O(d)$ complexity collapse."** [RETRACTED as stated;
   restated as conditional.] The original argument (survival probability $q=1-p$ drives nodes
   to $O((b(1-p))^d)$; if $p\to1-1/b$, search "collapses to $O(d)$") is an **unproven
   conditional with a likely-false premise** — it assumes a constant, depth-independent
   per-node pruning probability uniformly near $1-1/b$, which for NP-hard problems would imply
   P = NP if it held adversarially. The fast timings were on small, specific random instances
   and say nothing about worst-case scaling. **Honest restatement:** "On the random instances
   tested, pruning reduces expanded nodes relative to unpruned search, yielding empirical
   speedups at the sizes shown. No worst-case complexity claim is made; the per-node pruning
   rate is instance-dependent and not guaranteed bounded away from $1/b$ as dimension grows."

2. **"Crack Kyber/Dilithium / lattice crypto in polynomial time."** [RETRACTED — cut
   entirely.] The SVP experiments were at dimensions 8–12 against a *random-coefficient*
   baseline (2,000 combinations), not against LLL/BKZ, and not at cryptographically relevant
   dimensions (several hundred to 1000+). Beating random search in dimension 12 is many orders
   of magnitude from beating BKZ in dimension 500+, and finding *a* vector below the Minkowski
   bound is not exact-SVP at scale. Moreover, **as specified the SVP constraint is in Bucket B
   (§4.B.2), so the SRHT mechanism gives no edge there at all.** Replacement statement:
   "Nothing in our small-dimension experiments bears on the security of deployed lattice
   schemes." Whether an SRHT-style oracle could ever help inside BKZ is an open empirical
   question, never a result.

3. **"Born-Rule Quantum Phase Interference."** [RETRACTED as physics; restated as classical.]
   There is no Hilbert space, complex amplitude, superposition, or measurement;
   $\chi\in[0,1]$ is a real scalar and $\cos(\chi\pi/2)$ is just a smooth real gate equal to 1
   at $\chi=0$ and 0 at $\chi=1$. The operator is a **classical cosine constraint-gate**, and
   in the canonical formalism it is replaced outright by the single $(1-\chi)^2$ gate (the
   cosine shape was a design choice, retained only as an ablation). "Destructive interference"
   in the original abstract is just **pruning**. Likewise the gate family $G_k(\chi)=(1-\chi)^k$
   (linear / quadratic / cubic / cosine) is a hyperparameter to compare, not asserted physics.

4. **Weak baselines.** The original greedy nearest-neighbor (TSP) and 2,000-random-combination
   (SVP) baselines are too weak to support any claim of practical value (§6).

**What survives.** A particular smooth, multiplicative fusion of progress ($g(R)$) and
*independent*-constraint satisfaction ($(1-\chi)^2$), plus a pruning gate, that provably ranks
valid-costlier above invalid-cheaper (Theorem 2) in Bucket A — and is provably redundant in
Bucket B (Theorem 1). That is the whole, honest contribution.

---

## 6. Validation Status & Roadmap

### 6.1 Status ledger

| Result | Status |
|---|---|
| $\hat C\in[0,1]$; $g'(R)>0$; no singularity; gate endpoints exact | **[PROVEN]** (hand-derived) |
| Theorem 1 (redundancy in monotonic regime) | **[PROVEN]** |
| Theorem 2 (non-monotone guidance; crossover $\chi^\star=1-\sqrt{g(R_A)/g(R_B)}$) | **[PROVEN]** |
| SVP-as-written is Bucket B (redundant) | **[PROVEN]** (mechanism), **[NEEDS EXECUTION]** (confirm vs LLL/BKZ) |
| Corrected normalization fixes $\tau/\rho$ scaling losslessly | **[PROVEN]** (invariance of sort under positive scaling) |
| Single $\hat C$-floor gate **subsumes** both old gates — superset prune, NOT strict equivalence (defect #3 fixed; audit D1 RESOLVED) | **[PROVEN — subsumption only]** (§2.4); "lossless"/strict-equivalence is **false** and has been corrected |
| Fixed-reference-bound $R$ clipped to $(0,1]$ for out-of-window costs (audit D2 RESOLVED) | **[PROVEN]** (§2.3.3; $R:=\operatorname{clip}_{[\epsilon,1]}(R)$) |
| Stale $X_{\max}$ dropped; raw $X\in[0,1)$, $X$ diagnostic only (defect #4 fixed) | **[PROVEN]** (§2.3.1) |
| $\hat C$ rank-comparable within layer, NOT cross-instance (defect #5 downgraded honestly) | **[PROVEN]** (§2.3.3; fixed-bound upgrade is [ANALYTICAL]) |
| Patches preserve $\hat C\in[0,1]$, Theorem 2, Theorem 1 | **[PROVEN]** (§2.5) |
| TSP+intersection net edge over many seeds | **[NEEDS EXECUTION]** (3-seed table is unverified/cherry-picked) |
| KAI constraint-gated decoding beats baselines | **[NEEDS EXECUTION]** |
| Parameter insensitivity (single prune floor $\theta$ plateau) | **[ANALYTICAL]** → [NEEDS EXECUTION] |
| Original TSP/SVP timing tables | **Unverified** (never independently re-run) |

### 6.2 Benchmark plan

- **TSP.** Strong baselines: **LKH** (state-of-the-art heuristic) and **Concorde** (exact,
  where tractable). Use TSPLIB + random Euclidean at $N\in\{50,100,200,500\}$ (well beyond
  $N\le20$). Same-width plain beam is the **ablation** baseline (isolates the $\chi$-gate), not
  the headline competitor. Report mean ± std over $\ge30$ seeds, optimality gap, wall-clock
  *and* node-expansions. **Honest bar:** the $\chi$-gate improves constraint-structured beam at
  equal compute (significant under a paired Wilcoxon test, $p<0.05$); matching LKH is *not*
  expected.
- **SVP.** Replace random search with **LLL** and **BKZ** (fpylll / FPLLL), plus exact
  enumeration at small dimension for ground truth. Dimensions $D\in\{40,60,80,100\}$+. **The
  goal here is to CONFIRM the predicted redundancy** of SVP-as-written, not to claim a
  speedup; any future Bucket-A re-specification (norm-independent constraint) would be a
  separate experiment.
- **Multi-seed variance & reporting discipline.** Every table: instance set/size, seed count,
  mean and variance, compute budget (wall-clock and node/oracle counts), and the significance
  test. Pin solver versions and seeds; release the harness. Speedups without matched-quality
  *and* matched-compute comparison are inadmissible.

### 6.3 Residual-defect fixes (from §2.3) — RESOLVED

1. **[RESOLVED — defect #4]** Stale $X_{\max}=0.99$ **removed entirely**. Since $X\in[0,1)$
   always, the $X$-gate and its scaling are dropped; $X$ is now diagnostic only. Pruning is the
   single $\hat C$-floor. (See §2.3.1, §2.4.)
2. **[RESOLVED — defect #3 / audit D1]** Two gates collapsed to **one** criterion: prune iff
   $\hat C<\theta$. §2.4 proves the single floor **subsumes** both old gates
   ($\{\text{old-pruned}\}\subseteq\{\hat C<\theta\}$). **Corrected (audit D1):** this is a
   **subsumption / superset prune, NOT a lossless strict equivalence** — the single floor is
   strictly more aggressive, additionally pruning worst-cost-but-valid ($\chi=0$, low-$R$)
   bottom-of-beam branches the old gates kept. Operationally benign (bottom-of-beam; does not
   affect Theorem 2 guidance), but the prior "lossless" wording was an overclaim and is now
   corrected; the §2.4 tag is downgraded to **[PROVEN — subsumption only]**. (See §2.3.2, §2.4.)
3. **[RESOLVED — defect #5]** Claim **honestly downgraded**: $\hat C$ is bounded and
   rank-comparable *within a layer/beam*, **not** calibrated across instances. Optional fixed
   reference bounds in $R$ buy cross-instance comparability at the cost of partial
   GS-misestimation fragility — stated as an explicit trade-off, not a free lunch. (See §2.3.3.)
4. **[RESOLVED — audit D2]** The optional fixed-reference-bound $R$ now carries the required
   **clip** $R:=\operatorname{clip}_{[\epsilon,1]}(R)$, keeping $R\in(0,1]$ when a candidate cost
   falls outside the reference window. Rolling bounds are immune and need no clip. (See §2.3.3.)
5. (Hygiene, carried forward) Guard the empty candidate set and enforce $v_{\max}\ge1$ in the
   driver.

**Not defects (do not "fix"):** Theorem 1 (monotonic redundancy) and the SVP-redundancy result
are **correct theorems** — they are inherent and deliberately left intact. Signal fragility
(constraint–cost correlation, noisy $\chi$, beam-width non-monotonicity) is a **real inherent
limitation** to document (§4.A robustness note, §4.4 of Verification), not a math defect.
Experiments remain **[NEEDS EXECUTION]** (sandbox was unavailable at verification time).

### 6.4 Parameter sensitivity protocol

For each constant, one-at-a-time sweep across $\ge1$ order of magnitude (or full $[0,1]$ for
thresholds) on a **held-out dev split**, reporting the performance curve with variance; a
robust method shows **broad plateaus**, not sharp peaks at the chosen value. Then a small
randomized joint search (Latin-hypercube) for interactions. **All headline results in §6.2 are
reported on a separate, untouched test split.** Predicted (analytical): with the consolidated
single gate, the prune floor $\theta$ (a small fraction of beam-best $\hat C$, or a fixed small
constant) shows a plateau over a wide low range with degradation only at extremes (too high a
$\theta$ over-prunes the valid-but-longer branch); the obsolete $\varepsilon$/$X_{\max}$
constants are gone. The method's **real fragility is not in this constant** but in the
cost-independence and noise-freeness of the constraint signal and in beam width (§4.A
robustness note).

### 6.5 Living-document note

This master paper is the **canonical, living SRHT reference.** All five prior documents are
superseded. Future SRHT work — executed benchmarks, new capability bindings, defect fixes,
re-specified SVP constraints — updates *this* file, re-tagging claims from [NEEDS EXECUTION] /
[ANALYTICAL] to [PROVEN] (or [RETRACTED]) as evidence arrives. Honesty contract: no result is
promoted to empirical without a matched-compute, matched-quality, multi-seed, paired-test
comparison; cherry-picked seed tables are not admissible evidence.

---

## Appendix A: Complete Worked Derivations [PROVEN] (analytical)

> **Purpose.** This appendix shows **every** SRHT result worked step by step, with a one-line
> justification between consecutive steps. It is **additive**: it does not modify or supersede
> any earlier section; it expands the proofs that §2.2, §2.4, §3 (Theorems 1–2), and §4.A state
> in compressed form. Each derivation is cross-referenced from the result it expands. All algebra
> is elementary, hand-derived, and independently reproduced (consistent with `SRHT_MATH_AUDIT.md`,
> `SRHT_MATH_VERIFICATION.md`, and `SRHT_FINAL_SOUNDNESS_AUDIT.md`). Provenance for every item:
> **[PROVEN]** (analytical — closed-form algebra, no execution required).
>
> **Standing notation (used throughout the appendix).**
> $R\in(0,1]$ rank-based resonance; $\chi\in[0,1]$ continuous contradiction;
> $g(R)=\dfrac{R^2}{2-R}$ resonance term; $\hat C=g(R)(1-\chi)^2$ normalized commit score;
> $X=\chi(1-R)$ diagnostic contradiction pressure; $s=V_{\max}-V_{\min}\ge0$ sibling cost spread;
> $\epsilon>0$ floor constant; $R_{\min}=\epsilon/(s+\epsilon)$ emergent resonance floor.

### A.1 Range of $\hat C$: proof that $\hat C\in[0,1]$  [PROVEN]
*(Expands §2.2(1) and the §1.4 boundedness proof of Verification.)*

**Goal.** Show $\hat C=g(R)(1-\chi)^2\in[0,1]$ for all $R\in(0,1]$, $\chi\in[0,1]$, and identify
the exact endpoints.

**(i) $g$ maps $(0,1]$ into $(0,1]$.**

- *Step 1 (lower endpoint, limit).* $\displaystyle\lim_{R\to0^+}g(R)=\lim_{R\to0^+}\frac{R^2}{2-R}=\frac{0}{2}=0.$
  *Justification:* numerator $R^2\to0$, denominator $2-R\to2\ne0$, so the quotient $\to0/2=0$.
  Hence $g(0^+)\to0^+$; the value $0$ is approached but **never attained** because $R>0$ strictly
  on the domain.
- *Step 2 (upper endpoint, attained).* $g(1)=\dfrac{1^2}{2-1}=\dfrac{1}{1}=1.$
  *Justification:* direct substitution $R=1$. So $1$ **is attained**.
- *Step 3 ($g$ strictly increasing).* By A.2 below, $g'(R)>0$ on $(0,1]$.
  *Justification:* a function with positive derivative on an interval is strictly increasing there.
- *Step 4 (image).* A continuous, strictly increasing function maps $(0,1]$ onto
  $\big(g(0^+),\,g(1)\big]=(0,1]$.
  *Justification:* monotone-continuous image of a half-open interval is the corresponding
  half-open interval of endpoint values. **Therefore $g(R)\in(0,1]$.**

**(ii) $(1-\chi)^2\in[0,1]$ for $\chi\in[0,1]$.**

- *Step 1.* $\chi\in[0,1]\Rightarrow 1-\chi\in[0,1]$. *Justification:* subtracting from $1$
  reverses and shifts the interval $[0,1]$ onto $[0,1]$.
- *Step 2.* Squaring the interval $[0,1]$: for $t\in[0,1]$, $t^2\in[0,1]$ (with $0^2=0$, $1^2=1$,
  and $t^2\le t\le1$ in between). *Justification:* $x\mapsto x^2$ is increasing on $[0,\infty)$.
  **Therefore $(1-\chi)^2\in[0,1]$.**

**(iii) Product of a $(0,1]$ term and a $[0,1]$ term lies in $[0,1]$.**

- *Step 1.* Let $a=g(R)\in(0,1]$ and $b=(1-\chi)^2\in[0,1]$. Then $a>0$ and $0\le b\le1$.
- *Step 2 (lower bound).* $ab\ge a\cdot0=0$. *Justification:* $a>0$ and $b\ge0$.
- *Step 3 (upper bound).* $ab\le a\cdot1=a\le1$. *Justification:* $b\le1$ then $a\le1$.
  **Therefore $\hat C=ab\in[0,1]$.** $\qquad\blacksquare$

**Exact endpoints.**
- $\hat C=1$ **iff** $g(R)=1$ **and** $(1-\chi)^2=1$, i.e. $R=1$ **and** $\chi=0$ (best-cost,
  fully valid). Computed: $1\cdot1=1$. **Attained.**
- $\hat C=0$ (attained) **iff** $\chi=1$ (full violation): then $(1-\chi)^2=0$ and $\hat C=g(R)\cdot0=0$
  for any $R$, because $g(R)>0$ strictly. Separately, $\hat C\to0$ as $R\to0^+$ — a **limit**, not an
  attained zero (since $R>0$). These two statements are consistent with §2.2(1).

### A.2 Monotonicity of $g$: full quotient-rule derivation, $g'(R)=\dfrac{R(4-R)}{(2-R)^2}>0$  [PROVEN]
*(Expands §2.2(2); identical to Audit §2.2 Step 1–2 and Verification §1.2.)*

**Goal.** Differentiate $g(R)=\dfrac{R^2}{2-R}$ and prove $g'(R)>0$ on $(0,1]$.

Write $g=u/w$ with $u=R^2$, $w=2-R$. Then $u'=2R$ and $w'=-1$.

- *Step 1 (quotient rule).* $g'(R)=\dfrac{u'w-uw'}{w^2}=\dfrac{(2R)(2-R)-(R^2)(-1)}{(2-R)^2}.$
  *Justification:* $(u/w)'=(u'w-uw')/w^2$, the quotient rule.
- *Step 2 (expand numerator).* $(2R)(2-R)=4R-2R^2$; and $-(R^2)(-1)=+R^2$. So the numerator is
  $4R-2R^2+R^2$. *Justification:* distributive expansion and sign of the second term.
- *Step 3 (collect).* $4R-2R^2+R^2=4R-R^2$. *Justification:* $-2R^2+R^2=-R^2$.
- *Step 4 (factor).* $4R-R^2=R(4-R)$. *Justification:* factor out $R$.
  $$\boxed{\,g'(R)=\frac{R(4-R)}{(2-R)^2}\,}$$
- *Step 5 (sign on $(0,1]$).* On $R\in(0,1]$: $R>0$ (domain); $4-R\ge4-1=3>0$ (since $R\le1$);
  $(2-R)^2>0$ (a square of a nonzero real, since $2-R\ge1$). A product of three positive
  quantities is positive: $g'(R)>0$ **strictly**. *Justification:* sign of a product.
  **Hence $g$ is strictly increasing — injective and order-preserving — on $(0,1]$.** $\;\blacksquare$

**No singularity in $g'$.** The only zero of the denominator $(2-R)^2$ is at $R=2$, outside the
domain. On $(0,1]$, $2-R\in[1,2)$, so $(2-R)^2\in[1,4)\ge1>0$. There is **no pole** of $g$ or $g'$
anywhere in the operating range. *(Consistent with §2.2(3) and the Audit §1.4 pole check.)*

### A.3 Bound on $X$: proof that $X=\chi(1-R)\in[0,1)$, and why $X$ is diagnostic-only  [PROVEN]
*(Expands §2.3.1 and the table entry for $X$; matches Verification §1.5 / Soundness §1.4.)*

**Goal.** Show $X\in[0,1)$ for $\chi\in[0,1]$, $R\in(0,1]$, locate the supremum, and explain the
demotion of $X$ to a diagnostic.

- *Step 1 (factor ranges).* $\chi\in[0,1]$, and $R\in(0,1]\Rightarrow 1-R\in[0,1)$.
  *Justification:* $R\le1\Rightarrow1-R\ge0$; $R>0\Rightarrow1-R<1$. The upper end $1-R=1$ would
  require $R=0$, excluded.
- *Step 2 (lower bound).* $X=\chi(1-R)\ge0$. *Justification:* product of two nonnegatives.
  Attained: $X=0$ if $\chi=0$ (valid branch) **or** $R=1$ (best-cost branch).
- *Step 3 (upper bound, strict).* $X=\chi(1-R)\le 1\cdot(1-R)<1$. *Justification:* $\chi\le1$ gives
  the first inequality; $1-R<1$ (from Step 1, since $R>0$) gives the strict second.
  **Therefore $X\in[0,1)$.**
- *Step 4 (supremum, not attained).* $\sup X = 1$, approached as $\chi\to1$ and $R\to0^+$
  simultaneously, but never reached because $R>0$ strictly. With the emergent floor
  $R_{\min}=\epsilon/(s+\epsilon)$, the actual attained max is
  $X_{\max}^{\text{live}}=1\cdot(1-R_{\min})=\dfrac{s}{s+\epsilon}<1$. *Justification:* substitute the
  worst-cost sibling $R=R_{\min}$ with $\chi=1$. $\;\blacksquare$

**Why $X$ is diagnostic-only now.** Because $X\in[0,1)$ **always**, independent of any constant,
the old gate $X>\theta_X X_{\max}$ with the stale $X_{\max}=0.99$ (inherited from the obsolete
hand-set floor $R=0.01$, where $1-0.01=0.99$) has no self-consistent calibration under rank-based
$R$. The single consolidated gate "prune iff $\hat C<\theta$" subsumes the information $X$ carried
(A.7), so $X$ is retained purely as a **report-only** quantity (a readable measure of "high $\chi$
and/or low $R$"), never as a prune criterion. *(Consistent with §2.3.1.)*

### A.4 The $\epsilon$ floor: avoids degeneracy, preserves $R\in(0,1]$, and the fixed-reference clip  [PROVEN]
*(Expands §2.2(5) and §2.3.3; matches Verification §1.1 and Soundness §1.3.)*

Recall $R = 1-\dfrac{\lVert V\rVert-V_{\min}}{s+\epsilon}$, $s=V_{\max}-V_{\min}\ge0$, $\epsilon>0$.

**(a) The denominator never vanishes.** $s+\epsilon\ge\epsilon>0$. *Justification:* $s\ge0$ and
$\epsilon>0$. Hence $R$ is **defined for all finite inputs** — removing the original $\mathrm{GS}=0$
singularity of $R=1-\lVert V\rVert/\mathrm{GS}$.

**(b) Range $R\in(0,1]$ (rolling bounds).** For an in-window candidate $\lVert V\rVert\in[V_{\min},V_{\max}]$:
- *Step 1.* The fraction $f=\dfrac{\lVert V\rVert-V_{\min}}{s+\epsilon}$ ranges over
  $\Big[\,0,\ \dfrac{s}{s+\epsilon}\,\Big]$. *Justification:* numerator runs over $[0,s]$; divide by the
  fixed positive $s+\epsilon$.
- *Step 2 (best sibling).* $\lVert V\rVert=V_{\min}\Rightarrow f=0\Rightarrow R=1$ (attained).
- *Step 3 (worst sibling).* $\lVert V\rVert=V_{\max}\Rightarrow f=\dfrac{s}{s+\epsilon}\Rightarrow
  R=1-\dfrac{s}{s+\epsilon}=\dfrac{(s+\epsilon)-s}{s+\epsilon}=\dfrac{\epsilon}{s+\epsilon}=R_{\min}>0.$
  *Justification:* common denominator; cancel $s$. **Therefore $R\in(0,1]$** with emergent floor
  $R_{\min}=\epsilon/(s+\epsilon)$, which *replaces* the old hand-set $0.01$ floor by a principled
  value (the resonance the worst sibling retains).

**(c) The degenerate equal-cost case ($s=0$) is handled — this is where $\epsilon$ is load-bearing.**
If all siblings tie ($V_{\max}=V_{\min}$), then $\lVert V\rVert-V_{\min}=0$ for every candidate, so
$R=1-\dfrac{0}{0+\epsilon}=1-0=1$ for all. *Justification:* numerator is exactly $0$; denominator is
$\epsilon>0$, so the quotient is a well-defined $0$, **not** the indeterminate $0/0$ that would arise
without $\epsilon$. Operationally correct: when costs carry no spread, resonance carries no
information and ranking falls entirely to $\chi$ (the $g(R)=g(1)=1$ factor is constant across
siblings). The singleton candidate set ($V_{\max}=V_{\min}$, one node) is the same case: $R=1$.

**(d) Optional fixed-reference $R$ requires a clip.** For cross-instance comparability one replaces
the rolling $V_{\min},V_{\max}$ by fixed references $V_{\min}^{\text{ref}},V_{\max}^{\text{ref}}$.
Then a candidate cost can fall **outside** the reference window:
- *Case $\lVert V\rVert<V_{\min}^{\text{ref}}$:* numerator $<0\Rightarrow f<0\Rightarrow R>1$.
- *Case $\lVert V\rVert>V_{\max}^{\text{ref}}$:* numerator $>s_{\text{ref}}\Rightarrow f>\dfrac{s_{\text{ref}}}{s_{\text{ref}}+\epsilon}\Rightarrow R<R_{\min}$, possibly $R\le0$.
*Justification:* the in-window bounds of (b) no longer hold once $\lVert V\rVert$ leaves
$[V_{\min}^{\text{ref}},V_{\max}^{\text{ref}}]$. **Fix (required, do not omit):** clamp after
computing $R$:
$$R:=\operatorname{clip}_{[\epsilon,1]}(R)=\min\!\big(1,\ \max(\epsilon,R)\big)\in(0,1].$$
*Justification:* the clip projects any out-of-window $R$ back into $[\epsilon,1]\subset(0,1]$,
restoring the domain $g$ requires. **Rolling bounds are immune** (by construction $V_{\min},V_{\max}$
are the set extremes, so $\lVert V\rVert\in[V_{\min},V_{\max}]$ always and $f\in[0,s/(s+\epsilon)]$),
so the clip is needed **only** for the fixed-reference option. *(Consistent with §2.3.3 and the
status-ledger D2 entry.)*

### A.5 Theorem 1 (Redundancy, Bucket B): full derivative proof  [PROVEN]
*(Expands the §3 Theorem 1 proof; matches Audit §2.2–§2.4, Verification §2(c), Soundness §2.)*

**Hypotheses (stated exactly).** Along a single scalar cost $d$: (H1) $R=R(d)$ strictly decreasing,
$R'(d)<0$; (H2) $\chi=\chi(d)$ non-decreasing, $\chi'(d)\ge0$ on each differentiable piece and
non-decreasing across any jumps; (H3) $\rho,\tau$ constant across the compared siblings.
**Claim.** $\hat C(d)=g(R(d))(1-\chi(d))^2$ is weakly decreasing in $d$ (strictly where alive),
hence sort-by-$\hat C\equiv$ sort-by-cost.

**Full product + chain rule (where both factors are differentiable).** Let $a(d)=g(R(d))$ and
$b(d)=(1-\chi(d))^2$, so $\hat C=ab$.
- *Step 1 (product rule).* $\dfrac{d\hat C}{dd}=a'(d)\,b(d)+a(d)\,b'(d).$ *Justification:* $(ab)'=a'b+ab'$.
- *Step 2 (chain rule on $a$).* $a'(d)=\dfrac{d}{dd}g(R(d))=g'(R)\,R'(d).$ *Justification:* chain rule.
- *Step 3 (chain rule on $b$).* $b'(d)=\dfrac{d}{dd}(1-\chi)^2=2(1-\chi)\cdot\dfrac{d}{dd}(1-\chi)
  =2(1-\chi)\,(-\chi'(d))=-2(1-\chi)\chi'(d).$ *Justification:* power rule then chain rule, with
  $\frac{d}{dd}(1-\chi)=-\chi'(d)$.
- *Step 4 (assemble).*
  $$\frac{d\hat C}{dd}=\underbrace{(1-\chi)^2\,g'(R)\,R'(d)}_{\text{term }T_1}
  \;+\;\underbrace{g(R)\cdot 2(1-\chi)\cdot\big(-\chi'(d)\big)}_{\text{term }T_2}.$$
  *Justification:* substitute Steps 2–3 into Step 1 and group.

**Sign of each term.**
- *Term $T_1$.* $(1-\chi)^2\ge0$; $g'(R)>0$ (A.2); $R'(d)<0$ (H1). Product: $(\ge0)(+)(-)\le0$.
  **$T_1\le0$**, strict where $\chi<1$ (so $(1-\chi)^2>0$).
- *Term $T_2$.* $g(R)>0$ (A.1); $2(1-\chi)\ge0$; $-\chi'(d)\le0$ (H2, $\chi'\ge0$). Product:
  $(+)(\ge0)(\le0)\le0$. **$T_2\le0$.**
- *Sum.* $\dfrac{d\hat C}{dd}=T_1+T_2\le0.$ *Justification:* sum of two non-positive terms.
  Strict ($<0$) wherever $\chi<1$ (then $T_1<0$).

**Step-function jump points (where $\chi$ is not differentiable).** At a cost $d_0$ where $\chi$
jumps **up** from $\chi^-$ to $\chi^+>\chi^-$ (H2), the factor $(1-\chi)^2$ jumps from $(1-\chi^-)^2$
**down** to $(1-\chi^+)^2$, since $\chi^+>\chi^-\Rightarrow(1-\chi^+)<(1-\chi^-)\Rightarrow(1-\chi^+)^2<(1-\chi^-)^2$.
The other factor $g(R(d))$ is continuous in $d$. *Justification:* a strictly larger $\chi$ gives a
strictly smaller nonnegative $(1-\chi)$, and squaring preserves that order. Hence $\hat C$ has a
**downward** jump at $d_0$: $\hat C(d_0^+)\le\hat C(d_0^-)$. Combined with $\frac{d\hat C}{dd}\le0$
on every plateau, $\hat C$ has **no rising segment anywhere** on $[0,\infty)$.

**Order-equivalence conclusion.** A function that is weakly decreasing everywhere and strictly
decreasing where alive is order-reversing on the live region:
$$d(p_1)<d(p_2)\ \Longleftrightarrow\ \hat C(p_1)>\hat C(p_2).$$
*Justification:* strict monotone decrease is injective and reverses order. Therefore the top-$k$
beam slice by descending $\hat C$ equals the top-$k$ slice by ascending $d$ — **sort-by-$\hat C\equiv$
sort-by-cost; the physics layer is redundant (Bucket B).** Any branch killed by "prune iff
$\hat C<\theta$" sits at the high-$d$ tail and would be dropped by the beam slice regardless.
$\;\blacksquare$

**Exact monotonicity conditions required (named).** Redundancy holds **iff** (H1) $R$ is monotone
decreasing in $d$, (H2) $\chi$ is monotone **non-decreasing** in $d$, and (H3) $\rho,\tau$ are
constant across siblings. The single failure route is a **downward** $\chi$-step ($\chi$ decreasing
in $d$): then $(1-\chi)^2$ would jump **up**, possibly creating a rising segment and breaking
order-equivalence — which is exactly the cost-independent regime of Theorem 2 (A.6).

### A.6 Theorem 2 (Guidance, Bucket A): full crossover algebra  [PROVEN]
*(Expands the §3 Theorem 2 proof; matches Audit §3.1, Verification §2(d), Soundness §3.)*

**Setup.** Two siblings at comparable depth, with $\chi$ bound to a predicate **independent of cost**:
- Branch $A$ (valid-but-longer): cost $d_A$, valid $\Rightarrow v_A=0\Rightarrow\chi_A=0\Rightarrow
  (1-\chi_A)^2=1$; resonance $R_A$.
- Branch $B$ (invalid-shorter): cost $d_B<d_A$ $\Rightarrow R_B>R_A$ $\Rightarrow g(R_B)>g(R_A)$
  (by A.2, $g$ increasing); violating $\Rightarrow\chi_B=\chi>0$; resonance $R_B$.

**Solve for the crossover $\chi^\star$ (set the scores equal).**
- *Step 1 (write the two scores).* $\hat C_A=g(R_A)\cdot(1-\chi_A)^2=g(R_A)\cdot1=g(R_A)$;
  $\hat C_B=g(R_B)\,(1-\chi)^2$. *Justification:* substitute $\chi_A=0$.
- *Step 2 (equate).* $g(R_A)=g(R_B)(1-\chi)^2$. *Justification:* set $\hat C_A=\hat C_B$ to find the
  indifference point.
- *Step 3 (isolate the square).* $(1-\chi)^2=\dfrac{g(R_A)}{g(R_B)}$. *Justification:* divide both
  sides by $g(R_B)>0$.
- *Step 4 (take the root).* $1-\chi=\sqrt{\dfrac{g(R_A)}{g(R_B)}}$. *Justification:* both sides are
  nonnegative ($1-\chi\ge0$ since $\chi\le1$; the ratio $>0$), so the principal square root is valid.
- *Step 5 (solve).*
  $$\boxed{\ \chi^\star=1-\sqrt{\dfrac{g(R_A)}{g(R_B)}}\ }.$$
  *Justification:* rearrange Step 4.

**Domain of $\chi^\star$.** Since $R_A<R_B\Rightarrow g(R_A)<g(R_B)\Rightarrow
\dfrac{g(R_A)}{g(R_B)}\in(0,1)\Rightarrow\sqrt{\cdot}\in(0,1)\Rightarrow\chi^\star\in(0,1)$.
*Justification:* monotone $g$ and the square root preserve the open interval. So a genuine interior
crossover always exists.

**Ordering above the crossover.** For $\chi>\chi^\star$:
- *Step 1.* $\chi>\chi^\star\Rightarrow1-\chi<1-\chi^\star=\sqrt{g(R_A)/g(R_B)}$.
- *Step 2.* Square (both sides nonnegative): $(1-\chi)^2<\dfrac{g(R_A)}{g(R_B)}$.
- *Step 3.* Multiply by $g(R_B)>0$: $g(R_B)(1-\chi)^2<g(R_A)$, i.e. $\hat C_B<\hat C_A$.
  *Justification:* chained inequalities. **So for $\chi>\chi^\star$ the valid-but-longer $A$
  outranks the invalid-shorter $B$**, even though $d_A>d_B$. For comparable-depth siblings
  $g(R_A)/g(R_B)\approx1$, so $\chi^\star$ is **small** — a mild violation suffices to flip the order.

**Impossibility for any cost-only monotone score.** Let $\Phi$ be any score that is a (strictly)
monotone function of cost $d$ alone, $\Phi=\Phi(d)$. Since $d_B<d_A$, monotonicity forces a **fixed**
ordering of $A,B$ determined entirely by $d$: either $\Phi(d_B)>\Phi(d_A)$ for all such pairs (if
$\Phi$ decreasing in $d$) or the reverse — in **neither** case can the ranking depend on $\chi$,
because $\chi$ is, by hypothesis, **independent of $d$** and does not enter $\Phi$. *Justification:*
$\Phi$ is a function of $d$ only, so two branches with the same costs but different validity receive
identical $\Phi$, and the $A$-over-$B$ flip at $\chi>\chi^\star$ (which keeps $d_A>d_B$ fixed while
varying $\chi$) is unrepresentable. Hence the non-monotone ordering "longer-valid above
shorter-invalid" **cannot be reproduced by any same-width cost-only beam.** $\;\blacksquare$

**Continuity refinement (vs the old cliff).** The continuous $\chi$ makes the trade-off graded: the
more $B$ violates, the larger the cost advantage it needs to survive — replacing the old discrete
$\{0.1,0.9\}$ cliff $(1-0.1)^2/(1-0.9)^2=0.81/0.01=81{:}1$ with the smooth $\chi^\star$.

### A.7 Single-gate subsumption: proof + counterexample (superset, not lossless)  [PROVEN — subsumption only]
*(Expands §2.4; matches Verification §7-D3 and Soundness §4.)*

**Claim (corrected).** Replacing the old dual rule {prune if $P<\varepsilon$ **or**
$X>\theta_X X_{\max}$} by the single rule {prune iff $\hat C<\theta$} is a **subsumption / superset**
prune: $\{\text{old-pruned}\}\subseteq\{\hat C<\theta\}$ (nothing the old gates killed survives), and
the single floor is **strictly more aggressive** ($\{\hat C<\theta\}\supsetneq\{\text{old-pruned}\}$),
hence **not** a survivor-set-identical (lossless) equivalence.

**Part 1 — Subsumption (both old failure modes are low-$\hat C$).** Recall $\hat C=g(R)(1-\chi)^2$.
- *High-contradiction limb.* $\chi\to1\Rightarrow(1-\chi)^2\to0\Rightarrow\hat C\to0$ for any $R$.
  *Justification:* the gate factor vanishes. The old $P<\varepsilon$ limb is **identical** to
  $\hat C<\varepsilon$ since $P\equiv\hat C$; captured by $\hat C<\theta$ for any $\theta\ge\varepsilon$.
- *Low-resonance limb.* $R\to0^+\Rightarrow g(R)\to0$ (A.1) $\Rightarrow\hat C\to0$ for any $\chi<1$.
  *Justification:* the resonance factor vanishes. This is the region the old $X$-gate caught.
- *Formal subsumption of the $X$-gate.* If $X=\chi(1-R)>\theta_X X_{\max}$, the branch has high $\chi$
  and/or low $R$; in either limb $\hat C=g(R)(1-\chi)^2$ is small. Define
  $$\theta=\max\!\Big(\varepsilon,\ \sup\{\hat C(R,\chi):\chi(1-R)>\theta_X X_{\max}\}\Big).$$
  *Justification:* $\theta$ is set to the largest score any old-pruned branch can carry. By
  construction every old-$X$-pruned branch has $\hat C\le\theta$ and the $P<\varepsilon$ limb is
  covered by $\theta\ge\varepsilon$. **Therefore $\{\text{old-pruned}\}\subseteq\{\hat C<\theta\}$.**

**Part 2 — Counterexample (strict superset, with hand arithmetic).** Take a perfectly **valid**
branch with worst-case cost: $\chi=0$, $R\approx0.01$.
- *Old gates KEEP it.* $X=\chi(1-R)=0\cdot0.99=0$, so the $X$-gate does not fire. $P=g(R)$ with
  $g(0.01)=\dfrac{0.01^2}{2-0.01}=\dfrac{10^{-4}}{1.99}=5.03\times10^{-5}>\varepsilon$ (for
  $\varepsilon\sim10^{-8}\text{–}10^{-12}$), so the $P<\varepsilon$ gate does not fire either.
  *Justification:* both old criteria evaluate false. **The old pair retains the branch.**
- *Single floor PRUNES it.* $\hat C=g(R)(1-\chi)^2=5.03\times10^{-5}\cdot1=5.03\times10^{-5}<\theta$
  for the usual operating floor (e.g. $\theta=10^{-3}$, or any $\theta\gtrsim10^{-4}$).
  *Justification:* $\hat C$ falls below $\theta$. **The single gate removes a branch the old gates
  kept.** Hence $\{\hat C<\theta\}\supsetneq\{\text{old-pruned}\}$. $\;\blacksquare$

**Why it is operationally benign and does not affect Theorem 2.** The extra-pruned branches are
exactly the **worst-cost-but-valid bottom-of-beam** branches ($\chi=0$, $R\approx R_{\min}$) that the
top-$k$ slice would discard anyway. By contrast the Theorem 2 winner $p_A$ has $\chi_A=0$ and a
**mid-rank** resonance $R_A$ (not the worst), so $\hat C_A=g(R_A)$ comfortably exceeds any sensible
$\theta$ and is **retained** — the guidance crossover $\chi^\star$ (A.6) is untouched. **Conclusion:
subsumption-correct, strictly more aggressive, operationally benign — not lossless.** The §2.4 tag is
correspondingly **[PROVEN — subsumption only]**, and "lossless / no spurious pruning" is corrected.

### A.8 Worked micro-examples (concrete numbers, computed by hand)  [PROVEN] (arithmetic)
*(Illustrates §4.A.1 and §4.A.4 numerically; mechanism = Theorem 2 / A.6.)*

**Useful $g$-values (computed by hand from $g(R)=R^2/(2-R)$).**
$g(0.90)=\dfrac{0.81}{1.10}=0.7364$; $g(0.95)=\dfrac{0.9025}{1.05}=0.8595$;
$g(0.80)=\dfrac{0.64}{1.20}=0.5333$; $g(0.70)=\dfrac{0.49}{1.30}=0.3769$; $g(1.0)=1$.

**Example 1 — TSP with self-intersection (Bucket A, canonical demo).**
Cost = partial tour length; $v(p)=$ number of segment crossings; $\chi=\min(1,v/v_{\max})$ with
$v_{\max}=3$. Two siblings at comparable depth, rank-based $R$ over the sibling set:
- $p_B$ — **shorter but crossing**: best-ish cost $\Rightarrow R_B=0.95$, $v_B=2$ crossings
  $\Rightarrow\chi_B=\min(1,2/3)=0.6667$, so $(1-\chi_B)^2=(0.3333)^2=0.1111$.
- $p_A$ — **slightly longer but clean**: $R_A=0.90$, $v_A=0\Rightarrow\chi_A=0$, $(1-\chi_A)^2=1$.

Scores:
- $\hat C_A=g(0.90)\cdot1=0.7364.$
- $\hat C_B=g(0.95)\cdot0.1111=0.8595\cdot0.1111=0.0955.$

Since $\hat C_A=0.7364>0.0955=\hat C_B$, **the valid longer branch $p_A$ wins** despite $p_B$ being
shorter (higher $R$). *Cross-check with the crossover (A.6):*
$\chi^\star=1-\sqrt{g(R_A)/g(R_B)}=1-\sqrt{0.7364/0.8595}=1-\sqrt{0.8568}=1-0.9257=0.0743.$
Since $\chi_B=0.6667>\chi^\star=0.0743$, the order flips to favor $p_A$ — exactly as the scores show.
A plain length-only beam would instead rank the shorter $p_B$ first and be forced into the late
self-crossing. **Mechanism demonstrated numerically.**

**Example 2 — 3-SAT (Bucket A, degenerate-cost).**
No meaningful independent cost; $v(p)=$ number of clauses violated by the partial assignment;
$\chi=\min(1,v/v_{\max})$ with $v_{\max}=5$. Because cost is weak, $R$ comes from a near-flat progress
proxy; take both branches at $R\approx0.80$ so $g(R)=0.5333$ for each (the $g$ machinery contributes
almost nothing — the warning of §4.A.4).
- $p_A$ — assignment with **$0$ violated clauses**: $\chi_A=0$, $(1-\chi_A)^2=1\Rightarrow
  \hat C_A=0.5333\cdot1=0.5333.$
- $p_B$ — assignment with **$2$ violated clauses**: $\chi_B=2/5=0.4$, $(1-\chi_B)^2=0.36\Rightarrow
  \hat C_B=0.5333\cdot0.36=0.1920.$

$\hat C_A=0.5333>0.1920=\hat C_B$, so the **lower-violation assignment wins** — i.e. SRHT here is
exactly a clause-violation-guided (min-conflicts) beam, with the $g(R)$ factor cancelling because it
is equal across siblings. This confirms the §4.A.4 verdict: SRHT *works* on SAT as a constraint-gated
search, but reduces to min-conflicts because there is no cost signal distinct from the constraint
signal; if instead $R$ were derived from the **same** conflict count, both $R$ and $\chi$ would be
monotone in one scalar and the problem would collapse into **Bucket B** (Theorem 1, A.5).

---

> **Appendix A provenance summary.** A.1–A.7 are closed-form algebra, hand-derived and independently
> reproduced across the three supporting audits — tagged **[PROVEN]** (analytical). A.7 carries the
> sharpened tag **[PROVEN — subsumption only]** (strict equivalence is false; superset pruning is
> proven). A.8 is hand arithmetic illustrating the proven mechanism — tagged **[PROVEN] (arithmetic)**.
> Nothing in this appendix is an empirical result; all empirical items remain **[NEEDS EXECUTION]** as
> tabulated in §6.1. No earlier section is altered by this appendix; it only expands existing proofs.
