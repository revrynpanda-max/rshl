# SRHT Corrected-Math Verification (Stress Test "In All Angles")

**Verifier stance:** rigorous applied mathematics, adversarial, no flattery. The object under
test is the **corrected** equation set from `SRHT_MATH_AUDIT.md` §4.5, not the original paper.
Where the correction holds, this says so with the algebra; where it fails or is merely cosmetic,
this says that plainly.

**Compute status (read first).** The isolated Linux sandbox (numpy/sympy) was **unavailable at
verification time** (`Workspace unavailable ... VM service not running`). Therefore:
- Every **symbolic/algebraic** result below is derived **by hand with all steps shown** and is
  labeled *analytical*.
- Every **arithmetic** value is computed by hand and labeled *computed-by-hand*.
- Every **experiment** (TSP, 3-SAT) is provided as a **complete, standalone, runnable script**
  marked `# NEEDS EXECUTION`. No numerical experimental table in this document is machine-verified;
  predicted outcomes are labeled *predicted (analytical)*.

Nothing here is reported as a machine-checked number. This is stated up front so the reader never
mistakes an analytical prediction for an empirical result.

---

## 0. The corrected equation set under test (verbatim from AUDIT §4.5)

$$
\begin{aligned}
\rho &= \frac{|A|}{d} &&\text{progress scalar (cross-depth priority only, NOT intra-layer rank)}\\
R &= 1-\frac{\lVert V\rVert - V_{\min}}{V_{\max}-V_{\min}+\epsilon} &&\text{rank/spread resonance, }\epsilon>0\\
\chi &= \operatorname{clip}_{[0,1]}\!\big(v(p)/v_{\max}\big) &&\text{continuous, constraint-bound contradiction}\\
g(R) &= \frac{R^2}{2-R} &&\text{resonance term}\\
\hat C &= g(R)\,(1-\chi)^2 &&\text{normalized commit readiness}\\
P &= \hat C = g(R)\,(1-\chi)^2 &&\text{single gate (no double-count, no "Born" label)}\\
X &= \chi\,(1-R) &&\text{contradiction pressure}\\
\text{prune}&\;\text{if}\; X>\theta\,X_{\max}\ \text{or}\ P<\varepsilon &&\theta\in[0,1],\ \varepsilon\sim10^{-12}\text{–}10^{-8}
\end{aligned}
$$

with $X_{\max}=0.99$ retained from the original gate calibration (or, consistently with the new
$R$, recomputed below).

---

## 1. WELL-FORMEDNESS (domain, range, edge cases, singularities, monotonicity)

### 1.1 Rank-based resonance $R$

Let $s = V_{\max}-V_{\min}\ge 0$ be the sibling cost spread, $\epsilon>0$. For any candidate with
norm $\lVert V\rVert\in[V_{\min},V_{\max}]$:

$$R \;=\; 1-\frac{\lVert V\rVert - V_{\min}}{s+\epsilon}.$$

**Domain.** Defined for **all** finite inputs because $s+\epsilon\ge\epsilon>0$ — the denominator
**never vanishes**. This is the central well-formedness win over the original $1-\lVert V\rVert/\mathrm{GS}$
(which is undefined at $\mathrm{GS}=0$). *Analytical, no singularity.*

**Range.** The fraction $\frac{\lVert V\rVert-V_{\min}}{s+\epsilon}$ ranges over
$\big[0,\ \frac{s}{s+\epsilon}\big]$.
- At $\lVert V\rVert=V_{\min}$: fraction $=0\Rightarrow R=1$ (best sibling).
- At $\lVert V\rVert=V_{\max}$: fraction $=\frac{s}{s+\epsilon}\Rightarrow R=\frac{\epsilon}{s+\epsilon}\in(0,1]$.

So **$R\in\big(0,\,1\big]$**: the upper end $R=1$ is attained; the lower end is bounded **strictly
above $0$** by $R_{\min}=\frac{\epsilon}{s+\epsilon}>0$. The $\epsilon$ floor thus replaces the
original hand-set $0.01$ floor and makes it *emergent and principled* (it is exactly the resonance
the worst sibling retains).

**Edge case — degenerate equal-cost set ($s=0$).** Every sibling has the same norm, so
$\lVert V\rVert-V_{\min}=0$ for all, giving $R=1$ for all. *Correct and non-singular*: when all
costs tie, resonance carries no information and the ranking falls entirely to $\chi$ — exactly the
desired behavior. Without $\epsilon$ this case would be $0/0$; **$\epsilon$ is load-bearing here**,
not cosmetic.

**Edge case — singleton candidate set ($V_{\max}=V_{\min}$, one node).** Same as $s=0$: $R=1$.
Well-defined.

**Edge case — empty candidate set.** $V_{\min},V_{\max}$ undefined. This is **outside the
operator's domain**; the *search driver* must guard it (return: dead layer). Flag: the AUDIT does
not state this guard. Minor, but it is a genuine undefined-input hole at the algorithm boundary.

**Monotonicity.** $\partial R/\partial\lVert V\rVert = -1/(s+\epsilon)<0$: $R$ strictly decreases in
own cost (good — lower cost = higher resonance). *Analytical.*

**Caveat that matters (set-dependence).** $R$ now depends on $V_{\min},V_{\max}$ of the **current
candidate set**, so adding/removing a candidate **re-scales every other candidate's $R$**. $R$ is
no longer a per-node intrinsic; it is a *within-set rank coordinate*. This is fine for intra-layer
ranking (the only place it is used) but means $R$ (hence $\hat C$, $X$) is **not comparable across
layers or instances** unless $V_{\min},V_{\max}$ are fixed reference values. The AUDIT's claim that
$\hat C$ is "instance-comparable" (§4.1) is therefore **only true if $R$ uses fixed reference
bounds**, not the rolling set min/max. *This is a real inconsistency inside the corrected set,
documented in §2(a) below.*

### 1.2 Resonance term $g(R)=R^2/(2-R)$

**Domain/Range.** On $R\in(0,1]$: $2-R\in[1,2)$, so $g$ is defined and finite; **no pole** (the
pole at $R=2$ is outside the domain). $g(0^+)\to 0^+$, $g(1)=1/1=1$. Hence $g\in(0,1]$.
*Computed-by-hand:* $g(1)=1$; at the emergent floor with $\epsilon=10^{-9}, s=1$,
$R_{\min}=10^{-9}$, $g\approx(10^{-9})^2/2\approx5\times10^{-19}$ — vanishingly small but positive.

**Monotonicity (re-derived independently).** Quotient rule:
$$g'(R)=\frac{2R(2-R)-R^2(-1)}{(2-R)^2}=\frac{4R-2R^2+R^2}{(2-R)^2}=\frac{4R-R^2}{(2-R)^2}=\frac{R(4-R)}{(2-R)^2}.$$
On $R\in(0,1]$: $R>0$, $(4-R)>0$, $(2-R)^2>0\Rightarrow g'(R)>0$ **strictly**. $g$ is strictly
increasing, hence injective, on the domain. *Analytical — confirms AUDIT §2.2.*

**Continuity.** $g$ is rational with nonzero denominator on the domain → $C^\infty$. No jumps.

**On the $1/(2-R)$ factor.** Over $(0,1]$, $1/(2-R)\in(0.5,1]$ — varies by $\le 2\times$, while
$R^2$ varies by $\to 0\dots1$. The AUDIT's "near-cosmetic" verdict is **confirmed**: dropping it
(using $g=R^2$) changes the *magnitude* of $g$ by at most a factor of 2 and, crucially, **does not
change the sign of $g'$** ($\frac{d}{dR}R^2=2R>0$), so it **cannot change any ranking**. It is a
free, harmless shaping term. *Analytical.*

### 1.3 Contradiction $\chi=\operatorname{clip}_{[0,1]}(v/v_{\max})$

**Domain/Range.** $v\ge 0$ (a count/severity), $v_{\max}>0$. Raw $v/v_{\max}\in[0,\infty)$; the clip
forces $\chi\in[0,1]$. **No singularity** provided $v_{\max}>0$ (must be guaranteed — if $v_{\max}=0$
the map is $0/0$; the driver must set $v_{\max}\ge1$). Flag: AUDIT does not state $v_{\max}>0$ guard.

**Edge cases.** $v=0\Rightarrow\chi=0$ (fully valid). $v\ge v_{\max}\Rightarrow\chi=1$ (saturated
violation). Continuous and monotone non-decreasing in $v$ on the unclipped region; flat (=1) past
saturation. **Loss of resolution above $v_{\max}$**: two branches with $v=v_{\max}$ and $v=3v_{\max}$
both get $\chi=1$ — the gate cannot distinguish "bad" from "much worse." For pruning this is
acceptable (both are killed); for *ranking among survivors* it is a mild blind spot. *Analytical.*

### 1.4 Normalized commit readiness $\hat C=g(R)(1-\chi)^2$ — proof that $\hat C\in[0,1]$

Both factors are bounded:
$$g(R)\in(0,1]\quad(\S1.2),\qquad (1-\chi)^2\in[0,1]\ \text{since}\ \chi\in[0,1]\Rightarrow(1-\chi)\in[0,1].$$
Product of a value in $(0,1]$ and a value in $[0,1]$ lies in $[0,1]$. Therefore
$$\boxed{\hat C\in[0,1].}$$
- **Maximum $\hat C=1$** iff $g(R)=1$ **and** $(1-\chi)^2=1$, i.e. $R=1$ **and** $\chi=0$
  (best-cost, fully-valid). *Computed-by-hand:* $1\cdot1=1$.
- **Minimum $\hat C=0$** iff $\chi=1$ (any $R$) — the gate zeroes the score at full violation.
  Also $\hat C\to 0$ as $R\to 0^+$. Both attained/approached correctly.

**Continuity/monotonicity of $\hat C$.** $\hat C$ is $C^\infty$ in $(R,\chi)$ on $(0,1]\times[0,1]$.
$\partial\hat C/\partial R=g'(R)(1-\chi)^2\ge0$ (>0 unless $\chi=1$); $\partial\hat C/\partial\chi=
-2(1-\chi)g(R)\le0$ (<0 unless $\chi=1$ or $R\to0$). So $\hat C$ rises with resonance, falls with
contradiction — the intended shape, with no reversals. *Analytical.*

### 1.5 Contradiction pressure $X=\chi(1-R)$ and the prune gates

**Range with the new $R$.** $\chi\in[0,1]$, and $R\in(0,1]\Rightarrow(1-R)\in[0,1)$. So
$X\in[0,1)$. The supremum $X\to 1$ is approached as $\chi\to1,R\to0^+$ but **not attained** (since
$R>0$). With the emergent floor $R_{\min}=\epsilon/(s+\epsilon)$, the actual max is
$X_{\max}=1\cdot(1-R_{\min})=\frac{s}{s+\epsilon}<1$.

> **Inconsistency flag.** The AUDIT §4.5 keeps "$X_{\max}=0.99$," which was derived from the *old*
> floor $R=0.01$ giving $X_{\max}=1\cdot(1-0.01)=0.99$. Under the **new** rank-based $R$ the floor
> is $\epsilon/(s+\epsilon)$, not $0.01$, so $X_{\max}=s/(s+\epsilon)$, which $\to1$ as
> $\epsilon\to0$. **Carrying the old $0.99$ into the new formulation is an internal mismatch.** The
> correct, self-consistent gate is $X>\theta\cdot X_{\max}$ with $X_{\max}=\max_{\text{set}}X$
> computed live, or simply $X>\theta$ with $\theta\in[0,1)$ since $X$ is already in $[0,1)$.
> *This is a genuine residual hole the "correction" introduced by mixing old and new pieces.*

**Prune gate well-formedness.** With $\hat C=P\in[0,1]$, the floor $P<\varepsilon$ with
$\varepsilon\sim10^{-12}$–$10^{-8}$ is interpretable as "effectively zero survival" — sound.
The $X$-gate is sound once $X_{\max}$ is made consistent (above).

**Redundancy of the two gates (new observation).** Because $P=\hat C=g(R)(1-\chi)^2$ and
$X=\chi(1-R)$, **both gates are functions of the same $(R,\chi)$.** A branch with $\chi\to1$ has
$P\to0$ (caught by the $\varepsilon$ floor) *and* $X\to(1-R)$ (caught by the $\theta$ gate). The two
gates therefore **overlap heavily** near $\chi=1$. They are not identical (the $X$ gate also fires
for moderate $\chi$ + low $R$, where $P$ may still exceed $\varepsilon$), but the AUDIT's stated aim
of a *"single honest gate"* is only **partially** achieved: there are still **two** gates with
correlated firing regions. Not wrong, but not the clean single gate the summary advertises.
*Analytical.*

### 1.6 Well-formedness verdict

| Operator | Domain OK? | Range | Singularity | Monotone | Verdict |
|---|---|---|---|---|---|
| $R$ (rank) | yes ($\epsilon>0$) except empty set | $(0,1]$ | none | $\downarrow$ in own cost | **Sound**; set-dependent (see §2a) |
| $g(R)$ | yes | $(0,1]$ | none (pole at $R{=}2$ outside) | $\uparrow$ strict | **Sound**; $1/(2{-}R)$ cosmetic |
| $\chi$ | yes if $v_{\max}>0$ | $[0,1]$ | none | $\uparrow$ then flat | **Sound**; saturates above $v_{\max}$ |
| $\hat C=P$ | yes | $[0,1]$ proven | none | $\uparrow R$, $\downarrow\chi$ | **Sound and normalized** |
| $X$ | yes | $[0,1)$ | none | — | **Sound but $X_{\max}=0.99$ stale** |
| prune | — | — | — | — | **Two overlapping gates, not one** |

**Net:** the corrected set is well-formed and $\hat C\in[0,1]$ is **proven**. Two residual defects:
(i) $X_{\max}=0.99$ is inconsistent with the new $R$ floor; (ii) the "single gate" claim is
overstated (two correlated gates remain). Both are minor and fixable.

---

## 2. DOES THE CORRECTION ACTUALLY FIX THE HOLES?

### (a) Does normalization remove arbitrary $\tau/\rho$ scaling without losing ranking power?

**Yes for ranking power; partially for cross-comparability.**
- $\tau$ was a pure positive multiplicative constant: $\arg\!\operatorname{sort}$ is invariant to it,
  so removing it from the *score* changes **no intra-layer ranking** — zero loss. It only ever moved
  the absolute $P<10^{-10}$ floor; with normalized $\hat C\in[0,1]$ the floor is now a stated numeric
  $\varepsilon$. **Hole genuinely fixed.** *Analytical (invariance of sort under positive scaling).*
- $\rho$ is constant across siblings at fixed depth, so it never discriminated within a layer;
  moving it out of the sort is **lossless** for intra-layer ranking. Keeping it as a cross-depth
  priority is the right home. **Fixed.**
- **But** §1.1 showed the rolling-set $R$ makes $\hat C$ **not** cross-layer/instance comparable.
  So "normalized and instance-comparable" is only half-true: it is *bounded* in $[0,1]$ (true) but
  not *calibrated* across sets (false, with rolling min/max). **Partial fix.** To get true
  comparability one must use fixed reference bounds in $R$ — at which point the old GS-misestimation
  fragility returns in a milder form. There is an honest tension here, not a free lunch.

### (b) Is $\chi$ still double-counted, or now single-gated?

**Single-gated in $P$; partially single-gated overall.** The original double/triple-count was:
$(1-\chi)^2$ inside $C$, **times** $\cos(\chi\pi/2)$ in $P$, **plus** $\chi$ inside $X$. The
correction sets $P=\hat C=g(R)(1-\chi)^2$ — the $\cos$ factor is **gone**, so the
$(1-\chi)^2\cdot\cos$ double-count **in the score is genuinely eliminated.** *Confirmed.*
However $\chi$ still appears in **both** $P$ (via $(1-\chi)^2$) **and** $X$ (the prune gate). That is
defensible — a score term and a hard gate are different objects — but it means $\chi$ still drives
**two** mechanisms. Per §1.5 their firing regions overlap. So: **double-count in the score: fixed;
"single honest gate" overall: overstated.** *Analytical.*

### (c) Under MONOTONIC cost ($R,\chi$ functions of cost only): is corrected $\hat C$ STILL redundant with sort-by-cost?

**YES. The correction does not and cannot remove this — and that is mathematically inherent. State
it honestly.**

Suppose $R=R(d)$ strictly decreasing and $\chi=\chi(d)$ non-decreasing, both functions of the single
scalar cost $d$ (no independent constraint). Then
$$\hat C(d)=g\!\big(R(d)\big)\,\big(1-\chi(d)\big)^2.$$
On any interval where $\chi$ is constant: $\frac{d\hat C}{dd}=g'(R)\,R'(d)\,(1-\chi)^2$. We have
$g'(R)>0$ (§1.2), $(1-\chi)^2\ge0$, and $R'(d)<0$, so $\frac{d\hat C}{dd}\le0$, strict where
$\chi<1$. Where $\chi$ jumps up, $(1-\chi)^2$ jumps **down**, so $\hat C$ jumps down. Hence
$\hat C(d)$ is **(weakly, and strictly where alive) decreasing in $d$** — exactly as in AUDIT §2.
Therefore
$$d(p_1)<d(p_2)\ \Longrightarrow\ \hat C(p_1)\ge \hat C(p_2),$$
and the top-$k$ beam slice by $\hat C$ equals the top-$k$ slice by ascending $d$. **The corrected
score is still order-equivalent to sort-by-cost in the monotonic regime.** *Analytical.*

This is **inherent, not a defect of the correction**: *any* score that is a monotone function of a
single optimized scalar is order-equivalent to that scalar (a strictly monotone reparametrization
preserves order — elementary). No amount of normalization changes order. The rank-based $R$ actually
makes this **even more transparent**: with $R=1-\text{rank-fraction}(d)$, $g(R)$ is literally a
monotone function of the cost-rank, so sorting by $g(R)$ *is* sorting by cost. **Redundancy in the
monotonic regime is a theorem, and the correction correctly leaves it intact rather than hiding it.**

### (d) Under CONSTRAINT-BOUND $\chi$ (independent of cost): does the corrected form PRESERVE the non-monotone guidance that beats greedy beam?

**YES — proven below. This is the one regime where SRHT does real work, and the correction keeps it.**

Let $\chi=\chi_{\text{struct}}(p)$ depend on a structural predicate independent of $d$. Take two
siblings at comparable depth:
- $p_A$: cost $d_A$, **valid** → $v_A=0$ → $\chi_A=0$ → $(1-\chi_A)^2=1$.
- $p_B$: cost $d_B<d_A$ (so $R_B>R_A$, $g(R_B)>g(R_A)$), **violating** → $v_B>0$ → $\chi_B>0$.

The corrected score prefers the **valid, longer** $p_A$ over the **shorter, invalid** $p_B$ iff
$$\hat C_A>\hat C_B \iff g(R_A)\cdot 1 > g(R_B)\,(1-\chi_B)^2 \iff (1-\chi_B)^2 < \frac{g(R_A)}{g(R_B)}.$$
Since $g(R_A)/g(R_B)\in(0,1)$ (because $R_A<R_B$), there is a **finite contradiction threshold**
$$\chi_B^\star = 1-\sqrt{\frac{g(R_A)}{g(R_B)}}\in(0,1)$$
above which the valid-but-longer branch wins. For siblings at comparable depth $g(R_A)/g(R_B)$ is
near $1$, so $\chi_B^\star$ is **small** — even a mild continuous violation flips the order. With the
**continuous** $\chi$ this is a *smooth* trade-off (no $81{:}1$ cliff): the more $p_B$ violates, the
more cost penalty it must overcome. **This is strictly non-monotone in $d$** (a shorter branch ranked
below a longer one), which **pure-$d$ sorting cannot reproduce**, hence **cannot be replicated by any
same-width beam ranking on cost alone.** *Analytical — preserves AUDIT §3 and CRITIQUE §3.*

**The correction improves §3, it does not weaken it:** the original used hard steps giving a fixed
$81{:}1$ cliff; the continuous $\chi$ yields a *graded* threshold $\chi_B^\star$ that adapts to the
cost gap $g(R_A)/g(R_B)$. That is a genuine refinement (smoother, fewer magic numbers) of a
mechanism that was already correct.

**Verdict on §2:** Holes (a)$\tau/\rho$ and (b)$\chi$-double-count-in-score are **genuinely fixed**.
The monotonic redundancy (c) is **correctly left intact as inherent and now more transparent**. The
constraint-bound contribution (d) is **preserved and refined**. Residual: cross-instance
comparability is only partial (a), and "single gate" is overstated (b).

---

## 3. APPLICABILITY ACROSS EVERY PROBLEM IT IS EQUATED TO / COULD EQUATE TO

**Governing principle (the one rule that decides everything):**
> SRHT's $\chi$-gate does work **iff validity/constraint-violation is NOT a monotone function of the
> optimized cost** (it carries information the cost ranking does not). When validity ≡ cost (or a
> monotone function of it), SRHT collapses to sort-by-cost (§2c) and is **redundant**.

Bucket A = "validity independent of cost" → **SRHT can help**.
Bucket B = "validity ≡ cost / monotone in cost" → **SRHT redundant**.

| Problem | cost | constraint $\chi$ | Independent of cost? | SRHT mechanism | Verdict |
|---|---|---|---|---|---|
| **TSP, plain** (min tour length only) | tour length | none / "too long" | No — only signal is length | collapses to sort-by-length | **Redundant (B)** |
| **TSP + self-intersection** (claimed) | length | # segment crossings | **Yes** — a short tour can cross; a long one needn't | demotes short-but-crossing below long-but-clean | **Works (A)** — the canonical demo, §2d |
| **SVP / lattice** (claimed) | $\lVert V\rVert$ | "norm vs GS/Minkowski bound" | **No** as written — the bound is a monotone function of the norm itself | $\chi(\lVert V\rVert)$ monotone → redundant | **Mostly redundant (B).** *Partial (A)* only if $\chi$ is bound to a norm-independent structural defect (e.g. GS-coefficient / size-reduction condition not implied by current norm). As written in the paper, **redundant.** |
| **3-SAT / boolean SAT** | weak/none | # unsatisfied clauses | **Yes** — there is essentially no "cost," validity is everything | $\chi$ = unsat fraction is the *entire* signal; $g(R)$ near-flat | **Natural fit, but degenerate (A).** SRHT *reduces to a clause-violation-guided beam*; the $g(R)$ machinery adds little because there is no meaningful cost. It works, but it is "SRHT with the resonance term switched off" = standard min-conflicts/penalty search. |
| **Graph coloring** | #colors (weak) | # monochromatic edges | **Yes** | $\chi$ = conflict count independent of color-count objective | **Works (A)**, same caveat as SAT (cost weak). |
| **Bin packing** | #bins | capacity overflow (hard) | overflow is hard-infeasible, not graded vs cost | $\chi$ as overflow severity is somewhat independent | **Partial (A).** Helps if overflow severity is graded and not implied by bin count; otherwise the feasibility constraint is better handled by a hard filter. |
| **Job scheduling** | makespan | precedence/resource violations | **Yes** — a short schedule can violate precedence | $\chi$ = violation count independent of makespan | **Works (A).** Good fit; classic constrained search. |
| **KAI language decoding** (intended) | token improbability | grammar/logic-rule violations | **Yes** — a high-prob token can be ungrammatical | $\chi$ bound to parser rules; $R$ = likelihood progress | **Works (A) — the strongest legitimate fit.** A locally likely token can be globally invalid, exactly like a short-but-crossing segment. This is the on-mission, decisive, cheap test (HARDENING §5). |
| **Pure likelihood decoding** (no rule check) | token improbability | "low prob = contradiction" | **No** — $\chi$ from log-prob is monotone in cost | reproduces the redundancy bug | **Redundant (B).** Explicitly the failure mode HARDENING §5 warns against. |

**Classification summary.**
- **Bucket A (SRHT genuinely helps):** TSP+intersection, scheduling, graph coloring, KAI grammar-
  constrained decoding, (degenerately) 3-SAT/CSP where cost is weak and validity is everything.
- **Bucket B (SRHT redundant):** plain TSP, SVP-as-written (constraint monotone in norm), pure-
  likelihood decoding, any setup where $\chi$ is computed from the cost.
- **The paper's two headline claims split:** TSP+intersection is in A (defensible); **SVP as
  presented is in B** (the Minkowski/GS gate is a function of the norm being minimized, so $\chi$ is
  monotone in cost → redundant). The SVP claim is therefore **not** supported by the SRHT mechanism
  unless re-specified with a norm-independent structural constraint.

---

## 4. ROBUSTNESS / SENSITIVITY

### 4.1 $\theta$ (prune fraction)
- $\theta$ controls **only which branches are killed**, not the ranking of survivors. Within a wide
  beam, raising $\theta$ (more permissive) keeps more branches and **monotonically weakens** pruning
  toward "plain wide beam"; lowering $\theta$ risks killing the valid-but-longer branch that is the
  whole point. **Predicted (analytical):** a *plateau* of performance for moderate $\theta$
  (roughly $0.5$–$0.9$ of $X_{\max}$) with degradation only at extremes. A sharp peak at $\theta=0.8$
  would be a red flag for overfitting. **Sensitivity: low in the interior, high near $\theta\to0$.**
- **Caveat:** because $X_{\max}=0.99$ is stale under the new $R$ (§1.5), $\theta\cdot0.99$ may
  mis-scale; use live $X_{\max}$ or gate on raw $X>\theta$.

### 4.2 $\varepsilon$ (numeric floor)
- With normalized $\hat C\in[0,1]$, $\varepsilon\in[10^{-12},10^{-8}]$ kills only branches with
  essentially zero survival. **Predicted: results invariant across these orders of magnitude** —
  any branch with $\hat C$ in that range is already last in the beam and dropped by the slice anyway
  (same argument as AUDIT §2.4). **Sensitivity: negligible** if the beam width is the binding
  constraint. It becomes load-bearing only when the beam is so wide it never fills — rare.

### 4.3 What BREAKS the method
1. **Constraints that correlate with cost.** If $\operatorname{corr}(\chi, d)\to 1$, SRHT slides
   from Bucket A into Bucket B and **gracefully degrades to plain beam** (no harm, no benefit). This
   is the most important sensitivity: *the benefit is proportional to how cost-independent the
   constraint is.* A partially correlated constraint gives partial benefit. **This is the single
   axis that determines whether SRHT is worth running.**
2. **Noisy constraint signal.** If $v(p)$ is a noisy estimator of true violation, $\chi$ misranks
   and can **demote good branches** — SRHT can then do **worse** than plain beam. The cosine/quadratic
   gate's steepness amplifies noise near $\chi=1$. Robustness requires $v(p)$ to be an *exact* or
   low-variance checker (e.g., a real parser, a real intersection test) — which is why the KAI
   grammar-rule binding (exact checker) is the safest application and noisy heuristic constraints are
   the most dangerous.
3. **Very narrow beam.** With width $1$ (greedy), SRHT still picks one branch by $\hat C$; the
   anti-trap benefit needs width $\ge 2$ to *retain* the longer-valid branch alongside others. Too
   narrow → benefit vanishes. **Wide beam** → benefit also shrinks because plain beam already keeps
   many branches and may retain the valid one anyway. **Predicted sweet spot: moderate width** where
   plain beam is forced to discard the valid-but-longer branch but SRHT rescues it. Sensitivity to
   width is therefore **non-monotone** (peaks at intermediate widths).
4. **$v_{\max}$ saturation (§1.3).** If $v_{\max}$ is set too low, many branches saturate at $\chi=1$
   and become indistinguishable (all pruned), over-pruning the layer; too high, and even bad branches
   get small $\chi$, under-pruning. **Moderate sensitivity** — $v_{\max}$ is a real tuning surface the
   AUDIT introduced and should itself be swept.
5. **Stale $X_{\max}=0.99$** (§1.5) interacts with $\theta$ and can shift the effective gate; fix by
   using a consistent $X_{\max}$.

### 4.4 Sensitivity verdict
The two *new* corrected thresholds ($\theta$, $\varepsilon$) are **low-sensitivity** (broad
plateaus predicted). The method's real fragility is **not** in those constants — it is in the
**cost-independence and noise-freeness of the constraint signal** and in **beam width**. Small
changes to $\theta,\varepsilon$ should **not** flip results; changes to *what $\chi$ measures* will.

---

## 5. EXECUTION

**Status: NOT EXECUTED.** The numpy/sympy sandbox was unavailable (`VM service not running`). The
three scripts below are complete and standalone; run with `python <file>.py` (needs `numpy`,
`sympy`). Expected outcomes are stated as *predicted (analytical)*, not results.

### 5.1 Symbolic range + monotonicity check `# NEEDS EXECUTION`
```python
# srht_v_symbolic.py   # NEEDS EXECUTION (sandbox unavailable)
"""Verify: (1) g'(R)=R(4-R)/(2-R)^2>0 on (0,1]; (2) Chat in [0,1]; (3) rank-R range."""
import sympy as sp

R, chi, V, Vmin, Vmax, eps = sp.symbols('R chi V Vmin Vmax eps', positive=True)

# (1) g and g'
g  = R**2/(2-R)
gp = sp.simplify(sp.diff(g, R))
print("g'(R) simplified =", gp)                 # expect R*(4 - R)/(2 - R)**2
print("g'(R) factored   =", sp.factor(gp))
print("g'(0.5) =", float(gp.subs(R, sp.Rational(1,2))))  # >0
print("g(1)=", float(g.subs(R,1)), " g(0.01)=", float(g.subs(R,sp.Rational(1,100))))

# (2) Chat range: maximize/minimize g(R)*(1-chi)^2 over R in (0,1], chi in [0,1]
Chat = g*(1-chi)**2
print("Chat at R=1,chi=0 =", float(Chat.subs({R:1, chi:0})))   # expect 1
print("Chat at chi=1     =", sp.simplify(Chat.subs(chi,1)))     # expect 0
# monotone signs
print("dChat/dR sign factor =", sp.factor(sp.diff(Chat,R)))    # g'(R)*(1-chi)^2 >=0
print("dChat/dchi          =", sp.simplify(sp.diff(Chat,chi))) # -2(1-chi)g(R) <=0

# (3) rank-based R range
Rexpr = 1 - (V - Vmin)/(Vmax - Vmin + eps)
print("R at V=Vmin =", sp.simplify(Rexpr.subs(V,Vmin)))                 # 1
print("R at V=Vmax =", sp.simplify(Rexpr.subs(V,Vmax)))                 # eps/(Vmax-Vmin+eps)
# PREDICTED: g'(R)>0 everywhere on domain; Chat in [0,1]; R in (0,1].
```
**Predicted (analytical):** `g'(R) = R*(4 - R)/(2 - R)**2`; positive on $(0,1]$; `Chat`=1 at
$(R{=}1,\chi{=}0)$, $=0$ at $\chi{=}1$; `R`=1 at $V_{\min}$, $=\epsilon/(V_{\max}-V_{\min}+\epsilon)$
at $V_{\max}$. Matches §1.

### 5.2 TSP-with-intersection: corrected-SRHT vs plain beam `# NEEDS EXECUTION`
```python
# srht_v_tsp.py   # NEEDS EXECUTION (sandbox unavailable)
"""Corrected operators (AUDIT 4.5): rank-based R, continuous chi from crossings,
Chat = g(R)*(1-chi)^2. Compare to plain beam (rank by cost). Many seeds, paired stats.
HONESTY: expect MIXED results; the claim is a statistically significant NET edge, NOT a sweep."""
import numpy as np
from itertools import combinations

def ccw(p,q,r): return (r[1]-p[1])*(q[0]-p[0]) > (q[1]-p[1])*(r[0]-p[0])
def seg_x(a,b,c,e): return ccw(a,c,e)!=ccw(b,c,e) and ccw(a,b,c)!=ccw(a,b,e)

def n_cross(path, pts):
    P=[pts[i] for i in path]; segs=list(zip(P[:-1],P[1:])); c=0
    for (i,(a,b)),(j,(cc,e)) in combinations(enumerate(segs),2):
        if j<=i+1: continue
        if seg_x(a,b,cc,e): c+=1
    return c

def cost(path, pts):
    P=np.array([pts[i] for i in path]); return float(np.sum(np.linalg.norm(np.diff(P,axis=0),axis=1)))

def g(R): return R*R/(2-R)

def beam(pts, width, use_gate, vmax=3, eps=1e-9):
    N=len(pts); beams=[[0]]
    for _ in range(N-1):
        cand=[p+[n] for p in beams for n in range(N) if n not in p]
        if not cand: break
        if not use_gate:
            cand.sort(key=lambda p: cost(p,pts))                      # plain beam
        else:
            cs=[cost(p,pts) for p in cand]; lo,hi=min(cs),max(cs)
            def score(p):
                c=cost(p,pts); R=1-(c-lo)/(hi-lo+eps)                 # rank-based R (4.3)
                chi=min(1.0, n_cross(p,pts)/vmax)                    # continuous chi (4.2)
                return g(R)*(1-chi)**2                               # Chat (4.1)
            cand.sort(key=score, reverse=True)
        beams=cand[:width]
    best=min(beams, key=lambda p: cost(p+[p[0]],pts))
    return cost(best+[best[0]],pts)

if __name__=="__main__":
    seeds=list(range(30)); rows=[]
    for W in (10,20,40):
        d=[]
        print(f"\n=== beam width {W} ===")
        print(f"{'seed':>4} {'plain':>9} {'srht':>9} {'diff':>8} win")
        for s in seeds:
            rng=np.random.default_rng(s); pts=rng.uniform(0,100,(20,2)).tolist()
            pb=beam(pts,W,False); sr=beam(pts,W,True); diff=pb-sr; d.append(diff)
            print(f"{s:>4} {pb:9.2f} {sr:9.2f} {diff:8.2f} {'SRHT' if sr<pb else 'plain' if pb<sr else 'tie'}")
        d=np.array(d)
        print(f"mean diff (plain-srht) = {d.mean():.3f} ; wins SRHT={np.sum(d>0)}/{len(d)} ; "
              f"wins plain={np.sum(d<0)}/{len(d)}")
        # paired Wilcoxon if scipy present:
        try:
            from scipy.stats import wilcoxon
            if np.any(d!=0): print("Wilcoxon p =", wilcoxon(d).pvalue)
        except Exception as e: print("scipy unavailable:", e)
    # PREDICTED: SRHT wins a MAJORITY but not all seeds at moderate width (20);
    #            edge SHRINKS at width 40 (plain beam already keeps valid branch);
    #            net mean diff > 0, ideally Wilcoxon p<0.05. A clean sweep would be suspicious.
```
**Predicted (analytical):** net positive mean (plain − srht) at width 20, mixed per-seed, edge
shrinking as width grows (§4.3 #3). A clean 30/30 sweep would indicate a bug or a rigged setup,
**not** success. Honest success = significant net edge under the paired test.

### 5.3 3-SAT / CSP: constraint-bound pruning demo `# NEEDS EXECUTION`
```python
# srht_v_sat.py   # NEEDS EXECUTION (sandbox unavailable)
"""Random 3-SAT. chi = fraction of clauses currently violated by the partial assignment
(constraint-bound, independent of any 'cost'). Compare:
  (i) plain DFS/beam by #assigned (no constraint awareness)
  (ii) SRHT-gated beam ranking partials by Chat with R from a weak progress proxy.
DEGENERATE-COST CASE: g(R) nearly flat, so SRHT ~ min-conflicts beam (expected)."""
import numpy as np

def make_3sat(n_vars, n_clauses, rng):
    cl=[]
    for _ in range(n_clauses):
        vs=rng.choice(n_vars, size=3, replace=False)
        cl.append([(int(v), bool(rng.integers(0,2))) for v in vs])
    return cl

def violated(clauses, assign):  # assign: dict var->bool (partial)
    v=0
    for c in clauses:
        decided=[ (assign[var]==val) for var,val in c if var in assign ]
        if decided and not any(decided) and len(decided)==3:  # fully assigned & all false
            v+=1
    return v

def g(R): return R*R/(2-R)

def srht_beam(clauses, n_vars, width, use_gate, eps=1e-9):
    beams=[{}]                       # list of partial assignments
    order=list(range(n_vars))
    for var in order:
        cand=[]
        for a in beams:
            for val in (False, True):
                b=dict(a); b[var]=val; cand.append(b)
        vmax=max(1,len(clauses))
        if not use_gate:
            cand.sort(key=lambda a: violated(clauses,a))             # min-conflicts
        else:
            viol=[violated(clauses,a) for a in cand]; lo,hi=min(viol),max(viol)
            def score(a):
                vv=violated(clauses,a)
                R=1-(vv-lo)/(hi-lo+eps)          # weak progress proxy (cost~conflicts: near-degenerate)
                chi=min(1.0, vv/vmax)            # constraint-bound chi
                return g(R)*(1-chi)**2
            cand.sort(key=score, reverse=True)
        beams=cand[:width]
    best=min(beams, key=lambda a: violated(clauses,a))
    return violated(clauses, best)

if __name__=="__main__":
    print(f"{'seed':>4} {'plain':>6} {'srht':>6} (violations remaining; lower=better)")
    for s in range(20):
        rng=np.random.default_rng(s)
        cl=make_3sat(20, 85, rng)     # ratio ~4.25 (hard region)
        p=srht_beam(cl,20,16,False); q=srht_beam(cl,20,16,True)
        print(f"{s:>4} {p:6d} {q:6d}")
    # PREDICTED: with cost==conflicts, R and chi are BOTH functions of the conflict count,
    # so this is the MONOTONIC-REDUNDANT regime (Bucket B): SRHT ~ min-conflicts beam,
    # results ~equal. To show a REAL SRHT win, chi must be bound to a DIFFERENT structural
    # signal than the ranked cost (Bucket A). This script HONESTLY shows the redundant case;
    # a genuine win requires decoupling chi from the cost proxy.
```
**Predicted (analytical):** because here both $R$ and $\chi$ derive from the *same* conflict count,
3-SAT-by-conflicts is the **redundant (Bucket B)** regime — SRHT $\approx$ min-conflicts beam,
roughly equal. A genuine SRHT advantage on SAT requires a cost signal **distinct** from the
constraint signal; pure SAT has none, which is exactly why SAT is a *degenerate* fit (§3). This
script is included to **demonstrate the redundancy honestly**, not to manufacture a win.

---

## 6. HONEST VERDICT

**Where the corrected SRHT genuinely holds:**
1. **Well-formedness:** $\hat C\in[0,1]$ is **proven**; $R\in(0,1]$, $g\in(0,1]$, $\chi\in[0,1]$,
   no singularities (the rank-$R$ denominator never vanishes; the $g$ pole at $R{=}2$ is outside the
   domain). Monotonicity and continuity are as desired. The $\epsilon$ floor is principled and
   load-bearing (handles the equal-cost $0/0$ case).
2. **Fixes that work:** $\tau$ and $\rho$ removal from the score is **lossless** for ranking; the
   $(1-\chi)^2\cdot\cos$ double-count **in the score is eliminated**; continuous $\chi$ removes the
   $\{1.0,0.6,0.1\}$ magic steps and the $81{:}1$ cliff, replacing it with a graded threshold
   $\chi^\star=1-\sqrt{g(R_A)/g(R_B)}$.
3. **The core contribution survives (§2d):** under cost-independent constraint-bound $\chi$, $\hat C$
   is **provably non-monotone in cost** and can rank a valid-longer branch above an invalid-shorter
   one — behavior **no same-width cost-only beam can reproduce.** This is real, and the correction
   refines rather than weakens it.

**Where it does NOT hold / remains weak:**
1. **Monotonic regime is still redundant — inherently (§2c).** When $\chi,R$ are both functions of
   cost, $\hat C$ is order-equivalent to sort-by-cost. The correction correctly leaves this intact;
   it is a theorem, not a bug, but it means SRHT adds nothing whenever the constraint is a function
   of the cost.
2. **SVP-as-written is in the redundant bucket.** The Minkowski/GS gate is a function of the norm
   being minimized → $\chi$ monotone in cost → redundant. The paper's SVP claim is **not supported
   by the SRHT mechanism** unless re-specified with a norm-*independent* structural constraint. The
   crypto-breaking claim is entirely unsupported (correctly cut by HARDENING §2.2).
3. **"Single honest gate" is overstated.** Two gates ($P<\varepsilon$ and $X>\theta X_{\max}$)
   remain, with overlapping firing regions; $\chi$ still drives both score and prune.
4. **Internal inconsistency:** $X_{\max}=0.99$ is stale under the new rank-based $R$ (true floor is
   $\epsilon/(s+\epsilon)$); the gate should use a live/consistent $X_{\max}$ or gate on raw $X$.
5. **"Instance-comparable $\hat C$" is only half-true:** $\hat C$ is *bounded* in $[0,1]$ but, with
   rolling set min/max in $R$, **not calibrated across sets/layers/instances.** True comparability
   needs fixed reference bounds, which partially reintroduces the GS-misestimation fragility.
6. **Real fragility is in the signal, not the constants:** $\theta,\varepsilon$ are low-sensitivity
   (broad plateaus predicted); the method breaks when the constraint **correlates with cost** (→
   degrades to plain beam) or is **noisy** (→ can do worse than plain beam), and its benefit is
   **non-monotone in beam width** (peaks at moderate width).
7. **Unexecuted:** all three experiments are `# NEEDS EXECUTION`; no empirical table here is
   machine-verified. The original CRITIQUE's 3-seed winning sweep remains an unverified, likely
   cherry-picked claim; the honest test is a significant **net** edge over many seeds with a paired
   test.

**Bottom line.** The corrected math is **internally sound and the normalization is correct**: it
fixes the arbitrary-scaling and double-counting holes without losing ranking power, and it preserves
the one provably non-redundant mechanism (cost-independent constraint-bound $\chi$). It does **not**
turn SRHT into a universal solver: in any regime where validity is a function of the optimized cost
— including SVP as the paper specifies it — the corrected score is provably redundant with
sort-by-cost. SRHT is best understood, exactly as the Hardening Plan reframes it, as a
**constraint-aware best-first search** that helps **only** in Bucket A (validity independent of
cost), with KAI grammar-constrained decoding as its strongest legitimate application. Residual minor
defects ($X_{\max}$ staleness, two-gate overlap, partial comparability) are real but easily patched.
```

---

## 7. RESOLUTION (2026-06-19) — the three residual defects are patched

The three residual math defects flagged above have been **resolved in the canonical master
paper** (`SRHT_MASTER_PAPER.md`, §2.1–§2.5, §6.1, §6.3, §6.4). Summary of the fixes; full
proofs live in the master paper.

- **Defect #4 — stale $X_{\max}=0.99$ (this doc §1.5, §6.4). [RESOLVED, PROVEN]** Since
  $X=\chi(1-R)$ with $\chi\in[0,1]$ and $R\in(0,1]$, $X\in[0,1)$ **always**, regardless of $R$.
  The $X$-gate and its $X_{\max}$ scaling are **dropped entirely**; $X$ is retained only as a
  diagnostic. (Had a relative gate been kept, the self-consistent value would be
  $X_{\max}=1-R_{\min}=s/(s+\epsilon)$, not $0.99$.) See master §2.3.1.

- **Defect #3 — two correlated gates / "single honest gate" overstated (this doc §1.5, §2b,
  §6 #3). [RESOLVED, PROVEN]** The dual rule {$P<\varepsilon$ **or** $X>\theta X_{\max}$} is
  collapsed into **one** criterion: **prune iff $\hat C<\theta$**. A low $\hat C$ already
  captures both failure modes (high $\chi\Rightarrow(1-\chi)^2$ small; low $R\Rightarrow g(R)$
  small), so the $X$-gate is subsumed. Master §2.4 proves the consolidation is lossless: every
  branch the old pair pruned is pruned by $\hat C<\theta$ for an appropriate $\theta$, and the
  single floor introduces no spurious pruning. The "single honest gate" claim is now literally
  true. See master §2.3.2, §2.4.

- **Defect #5 — "instance-comparable $\hat C$" only half-true (this doc §1.1, §2a, §6 #5).
  [RESOLVED, honestly downgraded]** Claim corrected: $\hat C$ is **bounded in $[0,1]$ and
  rank-comparable WITHIN a layer/beam**, but **NOT calibrated across instances** (rolling
  set min/max in $R$ rescales every sibling when candidates change). Optional upgrade for true
  cross-instance comparability: **fixed reference bounds** in $R$ — explicitly noted to
  partially reintroduce GS/normalizer-misestimation fragility (no free lunch). See master
  §2.3.3.

**Preservation check (master §2.5). [PROVEN]** The patches touch only the prune rule and one
honesty downgrade, not the operators. Therefore: $\hat C\in[0,1]$ unchanged; **Theorem 2**
guidance crossover $\chi^\star=1-\sqrt{g(R_A)/g(R_B)}$ holds unchanged (it never used
$X$/$X_{\max}$; the valid-longer branch is still retained under the single gate); **Theorem 1**
redundancy unaffected (rests on $d\hat C/dd\le0$, a property of the score, not the gate).

**Explicitly NOT math defects (left as-is):**
- **#1 / #2 — Theorem 1 (monotonic redundancy) and SVP-redundancy.** Correct theorems
  (this doc §2c, §3). Inherent, deliberately left intact.
- **#6 — signal fragility** (constraint–cost correlation, noisy $\chi$, non-monotone benefit in
  beam width; this doc §4.3–§4.4). A **real inherent limitation** to document, not a defect.
- **#7 — experiments need execution.** All three scripts remain **[NEEDS EXECUTION]**; the
  numpy/sympy sandbox was unavailable at verification time. Pending empirical run.
