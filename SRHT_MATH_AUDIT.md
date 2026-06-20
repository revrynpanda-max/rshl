# SRHT Mathematical Audit and Correction

**Auditor stance:** rigorous applied mathematics, no flattery. The goal is correct,
defensible math. Where the original is right, this says so; where it is wrong,
arbitrary, or decorative, this says that too, and proposes a corrected equation.

**Compute status (read this first).** The isolated Linux sandbox (sympy/numpy) was
**unavailable** at audit time (VM service failed to start). Therefore **every symbolic
result below is derived by hand with all steps shown**, and **every numerical claim is
either (a) arithmetic done by hand and labeled "computed-by-hand" or (b) embedded in a
runnable script marked `# NEEDS EXECUTION`.** Nothing in this document is reported as a
machine-verified number unless it was reproduced by hand. The author's empirical tables
(TSP/SVP) are **not** re-run here and are treated as unverified.

---

## 0. Notation and the operator set under audit

State particle propagates through a discrete lattice; at each partial solution we have:

| Symbol | Name | Definition |
|---|---|---|
| $\rho$ | Lattice density | $\rho = \lvert A\rvert / d$ |
| $R$ | Resonance | $R = \max\!\big(0.01,\; 1 - \lVert V\rVert/\mathrm{GS}\big)$ |
| $\chi$ | Contradiction | $\chi \in [0,1]$ |
| $X$ | Contradiction pressure | $X = \chi\,(1-R)$ |
| $C$ | Commit readiness | $C = \rho\,R^2\,\dfrac{1}{2-R}\,(1-\chi)^2\,\tau$ |
| $P$ | "Born-rule" survival | $P = C\cos\!\big(\chi\tfrac{\pi}{2}\big)$ |
| prune | gate | prune if $X>0.8$ **or** $P<10^{-10}$ |

Here $\lvert A\rvert$ = number of assigned variables, $d$ = total dimension,
$\lVert V\rVert$ = current vector norm (SVP) or path cost proxy (TSP),
$\mathrm{GS}$ = Gram-Schmidt / expected bound, $\tau$ = a scale factor.

---

## 1. Operator-by-operator algebraic audit

### 1.1 Audit table

| Operator | Domain | Range (as written) | Edge cases | Singularities | Verdict |
|---|---|---|---|---|---|
| $\rho=\lvert A\rvert/d$ | $\lvert A\rvert\in\{0,\dots,d\}$, $d\ge 1$ | $[0,1]$ | $\rho\to0$ at start; $\rho=1$ when fully assigned | none ($d\ge1$) | **Sound** but see §1.3: within one beam layer $\rho$ is constant, so it does not rank siblings — it is a depth scalar, not a discriminator. |
| $R=\max(0.01,1-\lVert V\rVert/\mathrm{GS})$ | $\lVert V\rVert\ge0$, $\mathrm{GS}>0$ | clipped to $[0.01,1]$ from above; **unclipped upper side**: if $\lVert V\rVert=0$ then $R=1$ | $R\to0.01$ when $\lVert V\rVert\ge0.99\,\mathrm{GS}$; $R\to1$ when $\lVert V\rVert\to0$ | $\mathrm{GS}=0$ undefined; otherwise none | **Mostly sound, one hole:** the floor $0.01$ is enforced but there is no stated handling of $\lVert V\rVert>\mathrm{GS}$ (would give negative pre-clip, saved by the floor) and no upper clip beyond the natural $\le1$. GS must be *estimated*; misestimation rescales $R$ (see §4.3). |
| $\chi\in[0,1]$ | by definition | $[0,1]$ | $\chi\to0$: no contradiction; $\chi\to1$: full contradiction | none | **Well-posed as a primitive.** All the substance is in *how* $\chi$ is bound (§2 vs §3). |
| $X=\chi(1-R)$ | $\chi\in[0,1]$, $R\in[0.01,1]$ | $[0,\,0.99]$ (max at $\chi=1,R=0.01$) | $X=0$ if $\chi=0$ or $R=1$; $X\to0.99$ at $\chi=1,R=0.01$ | none | **Sound and bounded.** Note the gate $X>0.8$ is *reachable* only when both $\chi$ is large **and** $R$ is small; $X\in[0,0.99]$ so the threshold lives inside the range (good). |
| $C=\rho R^2\frac{1}{2-R}(1-\chi)^2\tau$ | $\rho\in[0,1]$, $R\in[0.01,1]$, $\chi\in[0,1]$, $\tau>0$ | $[0,\;\tfrac{\rho\tau}{?}]$ — **not normalized**, scales with $\rho\tau$ | $C=0$ at $\chi=1$ (factor $(1-\chi)^2$) or $\rho=0$; $C\to\rho\tau\cdot\frac{R^2}{2-R}$ at $\chi=0$ | $\frac{1}{2-R}$: $R\in[0.01,1]\Rightarrow 2-R\in[1,1.99]$, **no pole — confirmed** | **Functional but unnormalized and partly redundant** (see §1.2, §4.1). |
| $P=C\cos(\chi\pi/2)$ | $\chi\in[0,1]$ | $[0,\,C]$ | $\chi=0\Rightarrow\cos0=1\Rightarrow P=C$ ✓; $\chi=1\Rightarrow\cos(\pi/2)=0\Rightarrow P=0$ ✓ | none | **Endpoints verified exactly.** But $P$ multiplies a $(1-\chi)^2$ already in $C$ by *another* monotone-in-$\chi$ gate — double-counting $\chi$ (see §1.2). "Born rule" label is decorative (§4.4). |

### 1.2 Role of each factor in $C$ — what does real work, what is redundant

Write $C = \underbrace{\rho}_{\text{depth}}\cdot\underbrace{\tau}_{\text{scale}}\cdot\underbrace{\frac{R^2}{2-R}}_{g(R)}\cdot\underbrace{(1-\chi)^2}_{h(\chi)}.$

- **$\rho$ (density).** Constant across all siblings at a fixed search depth (same $\lvert A\rvert$, same $d$). It therefore **cannot change the ranking within a beam layer** — it only rescales every sibling equally. It is a per-layer constant, not a discriminator. *Effect on ranking: none within a layer.*

- **$\tau$ (scale).** A pure positive multiplicative constant. **Zero effect on any ranking; nonzero effect on the absolute value of $P$ and hence on whether the $P<10^{-10}$ gate fires.** This is the only thing $\tau$ does, and it does it *arbitrarily* — see §4.1.

- **$g(R)=R^2/(2-R)$.** This is the genuine resonance term. Two sub-factors:
  - $R^2$ rewards high resonance **super-linearly** (convex in $R$ for the dominant part), sharpening the preference for low-cost / low-norm states.
  - $\dfrac{1}{2-R}$ is a *mild* amplifier: at $R=1$ it equals $1$; at $R=0.01$ it equals $1/1.99\approx0.5025$. So over the whole domain it varies only in $[0.5025,1]$ — **a factor of ~2 at most.** It slightly steepens $g$ near $R=1$. Its marginal contribution is small relative to $R^2$ (which varies by a factor of $10^4$ over $[0.01,1]$). **Assessment: $1/(2-R)$ is nearly cosmetic** — it changes $g$ by at most $2\times$ while $R^2$ changes it by $10^4\times$. It is not wrong, but it is close to redundant and is not derived from anything.

    *Hand check of $g$ at endpoints:* $g(1)=1/1=1$; $g(0.01)=0.0001/1.99=5.0251\times10^{-5}$. Ratio $\approx1.99\times10^4$.

- **$h(\chi)=(1-\chi)^2$.** This is the contradiction penalty inside $C$. It is $1$ at $\chi=0$ and $0$ at $\chi=1$, quadratic. **This is where constraint information enters $C$.**

- **$\cos(\chi\pi/2)$ in $P$.** A *second* gate on $\chi$, applied on top of $(1-\chi)^2$. So $P=\rho\tau\,g(R)\,(1-\chi)^2\cos(\chi\pi/2)$. The contradiction $\chi$ is thereby penalized **three** times if you count $X$'s use of it, and **twice** inside $P$ alone. This is **double-counting** (see §4.1, §4.4) — defensible as "extra suppression near $\chi=1$" but not principled.

**Summary of §1.2.** The factors that actually rank siblings are $g(R)$ and the $\chi$-gates. $\rho$ and $\tau$ do not affect intra-layer ranking; $\tau$ only moves the absolute pruning floor. $1/(2-R)$ is near-cosmetic. The $\chi$ dependence is duplicated between $C$ and $P$.

### 1.3 Dimensional / scaling consistency

- $\rho,R,\chi,X$ are dimensionless ✓.
- $C$ is dimensionless **iff $\tau$ is dimensionless.** $\tau$ is never defined dimensionally; if it carries units (e.g. inverse cost), $C$ acquires units and the $P<10^{-10}$ comparison becomes scale-dependent. **Flag: $\tau$ must be declared dimensionless and its magnitude justified** (§4.1).
- $R$ depends on $\lVert V\rVert/\mathrm{GS}$, a ratio — dimensionless ✓ — **provided GS is in the same units as $\lVert V\rVert$.** For TSP the paper uses "path efficiency vs local expectations," which is a different physical quantity than an SVP norm; the *same* symbol $R$ is overloaded across two problem types with different scaling. Not fatal, but the calibration of GS/$d_{\mathrm{avg}}$ is problem-specific and must be stated per problem.

### 1.4 Exact endpoint confirmations (hand-verified)

- $1/(2-R)$ pole check: $R\in[0.01,1]\Rightarrow 2-R\in[1.0,1.99]\Rightarrow 1/(2-R)\in[0.5025,1.0]$. **No pole. Confirmed.**
- $P(\chi{=}0)=C\cos0=C\cdot1=C$. **Confirmed $P=C$ at $\chi=0$.**
- $P(\chi{=}1)=C\cos(\pi/2)=C\cdot0=0$, and independently $C(\chi{=}1)=\dots(1-1)^2\dots=0$, so $P=0$ **twice over**. **Confirmed $P=0$ at $\chi=1$.**
- $X$ range: $\max_{\chi,R}X = 1\cdot(1-0.01)=0.99$; $\min = 0$. **Threshold $0.8$ is interior to $[0,0.99]$.**

### 1.5 Things flagged ill-defined / arbitrary

1. $\tau$ undefined in dimension and magnitude; only affects the absolute $P$ floor (arbitrary).
2. $\rho$ does not discriminate within a layer (it is depth, not score).
3. $1/(2-R)$ near-cosmetic (varies $\le2\times$).
4. $\chi$ double/triple-counted across $C$, $P$, $X$.
5. Thresholds $0.8$, $10^{-10}$ and steps $\{1.0,0.6,0.1\}$, $\alpha$ are magic numbers (§4.2).
6. GS / $d_{\mathrm{avg}}$ must be estimated; $R$ inherits that estimation error (§4.3).
7. "Born rule / quantum / amplitude" language is not backed by any Hilbert-space object (§4.4).

---

## 2. The monotonic-redundancy proof — verified symbolically (by hand)

**Claim (critique §2).** Under the naive formulation
$$R(d)=1-\frac{d}{\alpha\,d_{\mathrm{avg}}},\qquad
\chi(d)=\begin{cases}1.0 & d>d_{\text{best}}\\ 0.6 & d>1.3\,d_{\mathrm{avg}}\\ 0.1 & \text{otherwise}\end{cases}$$
the commit readiness $C(d)$ is **strictly decreasing in cumulative cost $d$**, hence
$d(p_1)<d(p_2)\iff C(p_1)>C(p_2)$, hence sort-by-$C$ $\equiv$ sort-by-$d$ and the physics
layer is redundant. **Verdict: the claim is CORRECT, with one precise condition stated below.**

### 2.1 Setup

Hold $\rho,\tau>0$ constant (constant within a beam layer). $\chi(d)$ is a **step function**:
piecewise constant, jumping **upward** at the two boundaries $d=1.3\,d_{\mathrm{avg}}$ and
$d=d_{\text{best}}$. So $C(d)$ is differentiable **within each plateau** and has downward
jumps **at** the boundaries. We prove strict decrease in two parts.

### 2.2 Within a plateau ($\chi$ constant): the derivative

On a plateau, $(1-\chi)^2$ is constant. Write
$$C(d)=\underbrace{\rho\,\tau\,(1-\chi)^2}_{K\;>\;0}\cdot f\big(R(d)\big),\qquad f(R)=\frac{R^2}{2-R}.$$

**Step 1 — compute $f'(R)$** (quotient rule):
$$f'(R)=\frac{(2R)(2-R)-R^2(-1)}{(2-R)^2}
=\frac{4R-2R^2+R^2}{(2-R)^2}
=\frac{4R-R^2}{(2-R)^2}
=\frac{R(4-R)}{(2-R)^2}.$$

**Step 2 — sign of $f'(R)$ on the domain.** For $R\in[0.01,1]$:
$R>0$, $(4-R)>0$, $(2-R)^2>0$ $\Rightarrow$ $f'(R)>0$ **strictly**. So $f$ is strictly increasing in $R$.

**Step 3 — $dR/dd$.** $R(d)=1-\dfrac{d}{\alpha d_{\mathrm{avg}}}\Rightarrow \dfrac{dR}{dd}=-\dfrac{1}{\alpha d_{\mathrm{avg}}}<0$ (for $\alpha,d_{\mathrm{avg}}>0$).

**Step 4 — chain rule.**
$$\frac{dC}{dd}=K\,f'(R)\,\frac{dR}{dd}
=\underbrace{K}_{>0}\cdot\underbrace{\frac{R(4-R)}{(2-R)^2}}_{>0}\cdot\underbrace{\Big(-\frac{1}{\alpha d_{\mathrm{avg}}}\Big)}_{<0}\;<\;0.$$

Hence **within every plateau, $C$ is strictly decreasing in $d$.** $\;\blacksquare$ (plateau case)

This is exactly the critique's claim $\frac{\partial C}{\partial d}=\frac{\partial C}{\partial R}\frac{\partial R}{\partial d}+\frac{\partial C}{\partial\chi}\frac{\partial\chi}{\partial d}<0$, with the first term made explicit; on a plateau $\frac{\partial\chi}{\partial d}=0$ so only the $R$-term survives, and it is $<0$.

### 2.3 At the plateau boundaries ($\chi$ jumps up)

At $d=1.3\,d_{\mathrm{avg}}$, $\chi:0.1\to0.6$, so $(1-\chi)^2:0.81\to0.16$ — a downward jump of $C$ by factor $0.16/0.81\approx0.198$ (other factors continuous). At $d=d_{\text{best}}$, $\chi:0.6\to1.0$, so $(1-\chi)^2:0.16\to0$ — $C$ drops to $0$. Both jumps are **downward**. Combined with strict decrease inside each plateau, $C(d)$ is **strictly decreasing on all of $[0,\infty)$** (no flat or rising segment). $\;\blacksquare$

### 2.4 Order-equivalence corollary and the exact redundancy condition

A strictly decreasing function is injective and order-reversing:
$$d(p_1)<d(p_2)\iff C(p_1)>C(p_2).$$
Sorting ascending by $d$ = sorting descending by $C$ = identical beam slice. Any node killed
by $X>0.8$ or $P<10^{-10}$ sits at the high-$d$ tail and would be dropped by the beam slice
anyway. **The physics layer is a strictly-monotone re-encoding of $d$ — provably redundant.**

**Exact condition for redundancy (stated precisely).** Redundancy holds **iff both $R$ and
$\chi$ are (weakly) monotone functions of the single scalar being optimized, $d$, with at
least one strictly monotone**, *and* $\rho,\tau$ are constant across the compared siblings.
Formally: redundancy $\iff$ there exist monotone $R(d)$ (decreasing) and $\chi(d)$
(non-decreasing) such that $C=K\,f(R(d))(1-\chi(d))^2$ is strictly monotone in $d$. The proof
above shows this holds for the naive forms. **It fails the instant $\chi$ depends on a variable
not expressible as a monotone function of $d$** — which is exactly §3.

> **Caveat (computed-by-hand, NOT machine-checked):** the derivative algebra above is
> elementary and I am confident in it; the sympy cross-check is provided in §6.1 marked
> `# NEEDS EXECUTION` because the sandbox was down.

---

## 3. The non-monotonic claim (constraint-bound $\chi$) — verified analytically

**Claim (critique §3).** When $\chi$ is bound to a constraint **independent of cost** — e.g.
$\chi=0.9$ if the partial TSP tour self-intersects, else small — $C$ becomes **non-monotone**
in $d$, and this lets SRHT escape local minima that greedy beam search falls into.
**Verdict: ANALYTICALLY CORRECT.** Here is the mechanism made rigorous.

### 3.1 Why $C$ becomes non-monotone

Now $\chi=\chi_{\text{struct}}(p)$ depends on a structural predicate
$\mathbb{1}[\text{self-intersect}(p)]$ that is **not** a function of $d(p)$ alone: two partial
tours can have the *same* $d$ with different intersection status, and a *longer* tour can be
non-intersecting while a *shorter* one intersects. Consider two siblings:

- $p_A$: cost $d_A$, **non-intersecting** $\Rightarrow \chi_A=0.1\Rightarrow(1-\chi_A)^2=0.81$.
- $p_B$: cost $d_B<d_A$, **self-intersecting** $\Rightarrow \chi_B=0.9\Rightarrow(1-\chi_B)^2=0.01$.

Even though $d_B<d_A$ (so $R_B>R_A$, $f(R_B)>f(R_A)$), the contradiction gate can reverse the order:
$$C_A>C_B \iff f(R_A)\cdot0.81 > f(R_B)\cdot0.01 \iff \frac{f(R_B)}{f(R_A)} < 81.$$
Since $f(R_B)/f(R_A)$ is bounded (over the whole domain $f$ spans only $\approx1.99\times10^4$,
but for siblings at comparable depth the ratio is near $1$), the inequality $<81$ holds easily.
**So the shorter-but-intersecting branch $p_B$ is correctly ranked *below* the longer-but-valid
branch $p_A$.** $C$ is therefore **not** a monotone function of $d$ — it is monotone in $d$ only
*within a fixed $\chi$ class*, and jumps between classes by the constraint predicate. $\blacksquare$

### 3.2 Why this escapes the beam-search local minimum

Plain beam search ranks **only by $d$** (or by $C$ when $C$ is monotone in $d$, which §2 showed
is the same thing). It therefore *always* prefers $p_B$ (shorter) early, greedily committing to
segments that look cheap now but **force a self-crossing later** to close the tour — the classic
local trap. The constraint-gated $C$ instead demotes $p_B$ below the $81{:}1$ threshold, so the
beam retains $p_A$, the slightly-longer-but-structurally-viable partial tour, avoiding the
forced late crossover. This is a genuine, non-replicable-by-pure-$d$-ranking behavior. It is the
**one defensible contribution** of SRHT and must be kept (consistent with the Hardening Plan §1).

> The exact threshold "$81$" is an artifact of the magic steps $\{0.1,0.9\}$:
> $(1-0.1)^2/(1-0.9)^2 = 0.81/0.01 = 81$. With a *continuous* $\chi$ (recommended, §4.2) this
> becomes a smooth trade-off rather than a hard $81{:}1$ cliff.

### 3.3 Runnable reproduction — `# NEEDS EXECUTION`

The N=20 / width=20 / multi-seed TSP-with-intersection experiment from critique §3 could not be
run here (no Python sandbox). A clean, self-contained reproduction script is embedded in **§6.2**,
written in the `hlv_pellis_equations.py` style (pure functions + a results table + honesty caveat),
and marked `# NEEDS EXECUTION`. Until it is run, the critique's table (seeds 7/9/13, SRHT ahead by
up to 22.42) is **unverified** and should be treated as a claim, not a result.

---

## 4. Genuine holes and corrected equations

Each item: **the hole**, **the corrected equation**, **why**, **what it fixes**. Items proven to
work (constraint-bound $\chi$, §3) are **kept unchanged**.

### 4.1 $C$ is not normalized; $\tau$ and $\rho$ scale it arbitrarily

**Hole.** $C\in[0,\rho\tau]$ with $\tau$ undefined; the absolute value of $P$ (and thus whether
the $P<10^{-10}$ gate fires) depends on an arbitrary scale. $\rho$ doesn't rank siblings; $\tau$
only moves the floor. Cross-instance comparison of $C$ is meaningless.

**Corrected equation.** Drop $\tau$ from the *score*, separate ranking from gating, and normalize:
$$\boxed{\;\hat C \;=\; \underbrace{\frac{R^2}{2-R}}_{g(R)\in[g(0.01),\,1]}\cdot\;(1-\chi)^2\;\in[0,1]\;}$$
with $g$ optionally renormalized to $[0,1]$ via $\tilde g(R)=\dfrac{g(R)-g(0.01)}{1-g(0.01)}$ if a
true $[0,1]$ score is required. Keep $\rho$ **only** as an explicit depth/progress term **outside**
the sibling ranking (e.g. for best-first priority across depths), not inside the per-layer sort.

**Why / what it fixes.** $\hat C\in[0,1]$ is scale-free and instance-comparable; the gate is no
longer hostage to an arbitrary $\tau$; ranking semantics ($g(R)$ and $\chi$) are isolated from
progress semantics ($\rho$). Nothing that does real work is lost — $\rho,\tau$ never ranked siblings.

### 4.2 Magic numbers: $0.8$, $10^{-10}$, $\{1.0,0.6,0.1\}$, $\alpha$

**Hole.** All hand-tuned; each is a quietly fitted degree of freedom.

**Corrected formulation.**

- **Pruning gate $X>0.8$.** Re-express as *"prune when constraint violation exceeds a fraction
  $\theta$ of its attainable maximum."* Since $\max X = \chi(1-R)\le 0.99$, set the gate as
  $$\boxed{\text{prune if } X > \theta\cdot X_{\max},\quad X_{\max}=0.99,\ \theta\in[0,1]\text{ swept.}}$$
  $\theta=0.8/0.99\approx0.808$ recovers the original. Report a sweep; a robust method shows a
  plateau in performance vs $\theta$, not a peak at $0.8$.

- **Collapse cutoff $P<10^{-10}$.** This is a **numerical/budget floor**, not physics. State it as
  such: prune when $P$ is within machine/round-off of zero, e.g.
  $\boxed{P<\varepsilon,\ \varepsilon\sim10^{-12}\!-\!10^{-8}}$, and *demonstrate insensitivity*
  across those orders of magnitude (a real result, not a tuned constant). With normalized $\hat C\in[0,1]$,
  the floor becomes interpretable as "effectively zero survival probability."

- **$\chi$ steps $\{1.0,0.6,0.1\}$.** Replace the discrete cherry-pickable steps with a **continuous
  violation measure** in $[0,1]$:
  $$\boxed{\chi = \operatorname{clip}_{[0,1]}\!\Big(\frac{v(p)}{v_{\max}}\Big)}$$
  where $v(p)$ is a count/severity of violated constraints (e.g. number of self-intersections, or
  number of unsatisfied clauses) and $v_{\max}$ a normalizer. This removes three magic numbers and
  the arbitrary $81{:}1$ cliff (§3.2), and turns the gate into a smooth penalty.

- **$\alpha$ in $R=1-d/(\alpha d_{\mathrm{avg}})$.** Replace the ad-hoc linear bound with a
  calibration-robust $R$ (next item, §4.3), eliminating $\alpha$ entirely.

**Why / what it fixes.** Removes the four most obvious "fitted to the benchmark" surfaces; converts
two of them (gate fraction, numeric floor) into swept, insensitivity-demonstrated quantities; turns
$\chi$ into a principled continuous measure that *also* smooths the §3 escape mechanism.

### 4.3 $R$ depends on a GS / $d_{\mathrm{avg}}$ bound that must be estimated

**Hole.** $R=\max(0.01,1-\lVert V\rVert/\mathrm{GS})$ requires a good estimate of GS (SVP) or
$d_{\mathrm{avg}}$ (TSP). If GS is misestimated by a factor $\gamma$, $R$ shifts and the whole score
rescales; the $0.01$ floor masks but does not fix this.

**Corrected equation (calibration-robust, rank-based).** Make $R$ depend only on the **relative
ordering / spread** of sibling costs, which needs no absolute bound:
$$\boxed{\;R = 1 - \frac{\lVert V\rVert - V_{\min}}{V_{\max}-V_{\min}+\epsilon}\;\in[0,1]\;}$$
(min/max taken over the current candidate set; $\epsilon>0$ guards the degenerate equal-cost case).
Alternatively a robust z-score / quantile map. If an *absolute* bound is genuinely available and
trusted (e.g. Gaussian-heuristic for SVP), use $R=1-\lVert V\rVert/\mathrm{GH}$ but **report the
sensitivity of results to a $\pm$ mis-scaling of GH**.

**Why / what it fixes.** The rank/spread form is invariant to any monotone rescaling of cost and
needs no fragile constant; it cannot be silently mis-calibrated. The $0.01$ floor can be retained or
dropped (now unnecessary since the form is already in $[0,1]$).

> **Note:** the rank-based $R$ makes the *naive* (cost-bound) regime even more transparently
> redundant — which is fine: it makes the §3 constraint-bound contribution stand out cleanly.

### 4.4 "Born-rule" $P=C\cos(\chi\pi/2)$ — restate honestly, compare gate shapes

**Hole.** No Hilbert space, no complex amplitude, no superposition, no measurement. $\chi\in[0,1]$
is a real scalar; $\cos(\chi\pi/2)$ is a smooth real gate equal to $1$ at $\chi=0$ and $0$ at
$\chi=1$. The "Born rule / probability amplitude / phase interference" framing is **decorative** and
will not survive a referee who knows QM. Additionally, $P$ applies a **second** $\chi$-gate on top of
$(1-\chi)^2$ already inside $C$ — double-counting.

**Honest restatement.** $P$ is a **classical cosine constraint-gate**: a smooth, bounded, monotone
penalty that multiplicatively suppresses a candidate's score as constraint violation rises, hitting
exactly zero at full violation. The cosine shape is a *design choice* (smooth, zero-derivative at both
endpoints).

**Corrected equation — single, explicit gate family.** Avoid double-counting by applying **one** gate:
$$\boxed{\;P \;=\; g(R)\cdot G_k(\chi),\qquad G_k(\chi)=(1-\chi)^k,\ k>0\;}$$
and treat the gate shape as a hyperparameter to be *compared*, not asserted. Candidate shapes, all
$=1$ at $\chi=0$ and $=0$ at $\chi=1$:

| Gate $G(\chi)$ | $G(0)$ | $G(1)$ | $G'(0)$ | $G'(1)$ | Behavior |
|---|---|---|---|---|---|
| linear $1-\chi$ | 1 | 0 | $-1$ | $-1$ | constant slope; cheapest |
| quadratic $(1-\chi)^2$ | 1 | 0 | $-2$ | $0$ | flat near full violation |
| cubic $(1-\chi)^3$ | 1 | 0 | $-3$ | $0$ | very tolerant of large $\chi$ before zeroing |
| cosine $\cos(\chi\pi/2)$ | 1 | 0 | $0$ | $-\pi/2$ | flat near $\chi=0$, steep near $\chi=1$ |

**Hand-computed comparison values** (mid-range $\chi=0.5$):
$1-\chi=0.5$; $(1-\chi)^2=0.25$; $(1-\chi)^3=0.125$; $\cos(\pi/4)=0.7071$.
So at moderate violation the **cosine is the most permissive** of the four ($0.707$ vs $0.25$ for the
quadratic currently *also* sitting inside $C$). Using cosine **and** $(1-\chi)^2$ together (the original
$P$) yields $0.25\times0.707=0.1768$ at $\chi=0.5$ — a strong, but arbitrary, compound suppression.

**Recommendation.** Pick **one** gate. The cosine's zero-derivative at $\chi=0$ is desirable (small
violations are nearly free, matching "soft" constraints); the quadratic's zero-derivative at $\chi=1$
is desirable (graceful approach to pruning). $(1-\chi)^2$ is the simplest with a flat top *near
pruning*. **Default recommendation: a single $(1-\chi)^2$ gate** (cheapest, already in $C$, smooth at
the pruning end), with cosine and linear reported as ablations. This removes the double-count and the
quantum mislabeling while preserving the smooth-suppression behavior the method actually relies on.

**Why / what it fixes.** Eliminates indefensible physics vocabulary, removes $\chi$ double-counting,
and makes the gate shape an honest, swept hyperparameter with a tabulated rationale.

### 4.5 Corrected equation set (consolidated)

$$
\begin{aligned}
\rho &= \frac{\lvert A\rvert}{d} &&\text{(progress scalar; used for cross-depth priority, NOT intra-layer rank)}\\[2pt]
R &= 1-\frac{\lVert V\rVert - V_{\min}}{V_{\max}-V_{\min}+\epsilon}\in[0,1] &&\text{(rank/spread form; no fragile GS constant)}\\[2pt]
\chi &= \operatorname{clip}_{[0,1]}\!\big(v(p)/v_{\max}\big) &&\text{(continuous, constraint-bound — KEEP this binding)}\\[2pt]
g(R) &= \frac{R^2}{2-R} &&\text{(resonance term; }1/(2-R)\text{ optional, near-cosmetic)}\\[2pt]
\hat C &= g(R)\,(1-\chi)^2 \in[0,1] &&\text{(normalized commit readiness; }\tau\text{ removed)}\\[2pt]
P &= \hat C \;=\; g(R)\,(1-\chi)^2 &&\text{(single gate; no double-count, no "Born" label)}\\[2pt]
X &= \chi\,(1-R)\in[0,0.99] &&\text{(unchanged; bounded, well-posed)}\\[2pt]
\text{prune} &\;\text{if}\; X>\theta\,X_{\max}\ \text{or}\ P<\varepsilon &&\theta\in[0,1]\text{ swept},\ \varepsilon\sim10^{-12}\text{–}10^{-8}\text{, insensitivity shown}
\end{aligned}
$$

**Kept because proven (§3):** $\chi$ bound to constraints *independent of the optimized cost*. That,
not the vocabulary, is the contribution. Everything else above is normalization, de-duplication, and
de-magic-numbering.

---

## 5. Summary of findings

1. **No singularities.** $1/(2-R)$ has no pole on $[0.01,1]$ (denominator $\in[1,1.99]$) — confirmed.
2. **Endpoints correct.** $P=C$ at $\chi=0$, $P=0$ at $\chi=1$ — confirmed (twice over at $\chi=1$).
3. **Monotonic-redundancy proof is CORRECT** (full hand derivation, §2): $f'(R)=R(4-R)/(2-R)^2>0$,
   $dR/dd<0$ $\Rightarrow$ $dC/dd<0$ within plateaus, downward jumps at $\chi$-steps $\Rightarrow$
   $C$ strictly decreasing in $d$ $\Rightarrow$ sort-by-$C\equiv$ sort-by-$d$. Redundancy holds **iff**
   both $R,\chi$ are monotone in the single cost $d$ and $\rho,\tau$ constant across siblings.
4. **Non-monotone (constraint-bound) claim is CORRECT** (§3): constraint-bound $\chi$ makes $C$
   non-monotone in $d$; the $(1-\chi)^2$ gate can demote a shorter-but-invalid branch below a
   longer-but-valid one (original cliff ratio $81{:}1$), escaping the greedy beam trap. **Keep this.**
5. **Genuine holes:** $C$ unnormalized; $\tau$ undefined/arbitrary; $\rho$ doesn't rank siblings;
   $1/(2-R)$ near-cosmetic; $\chi$ double/triple-counted; magic numbers $0.8,10^{-10},\{1.0,0.6,0.1\},\alpha$;
   GS-estimation fragility in $R$; "Born-rule/quantum" label unsupported.
6. **Corrections (§4.5):** normalized $\hat C\in[0,1]$; rank-based $R$ (no $\alpha$/GS constant);
   continuous constraint-bound $\chi$; single gate $P=g(R)(1-\chi)^2$ (no double-count, honest label);
   $\theta$-fraction prune gate; $\varepsilon$ as a stated, insensitivity-demonstrated numeric floor.

**Provenance:** §2 and §4.4 numbers are computed by hand and stated as such. §3's empirical table and
§6's scripts are `# NEEDS EXECUTION` (sandbox was unavailable).

---

## 6. Verification scripts (style after `hlv_pellis_equations.py`) — `# NEEDS EXECUTION`

> These were **not run** (no sympy/numpy sandbox at audit time). They are written to run standalone.

### 6.1 Symbolic monotonicity cross-check (sympy)

```python
# srht_verify_monotonic.py   # NEEDS EXECUTION (sandbox unavailable at audit time)
"""Cross-check the §2 hand derivation: dC/dd < 0 under naive R(d), chi const on a plateau.
HONESTY: this only verifies the *plateau* derivative sign; the boundary jumps are argued
analytically in §2.3 (chi is a step function, not differentiable there)."""
import sympy as sp

d, alpha, davg, rho, tau, chi = sp.symbols('d alpha davg rho tau chi', positive=True)
R = 1 - d/(alpha*davg)                      # naive resonance
f = R**2/(2 - R)                            # g(R)
C = rho * f * (1-chi)**2 * tau              # commit readiness, chi const on plateau

dCdd = sp.simplify(sp.diff(C, d))
print("dC/dd =", dCdd)

# f'(R) factored form claimed in §2: R(4-R)/(2-R)^2
Rsym = sp.symbols('R', positive=True)
fR = Rsym**2/(2-Rsym)
print("f'(R) =", sp.simplify(sp.diff(fR, Rsym)))          # expect R*(4-R)/(2-R)**2
print("f'(R) factored =", sp.factor(sp.diff(fR, Rsym)))

# sign over the domain R in [0.01, 1]: should be strictly positive
print("f'(0.01) =", float(sp.diff(fR,Rsym).subs(Rsym,0.01)))   # >0
print("f'(1.0)  =", float(sp.diff(fR,Rsym).subs(Rsym,1.0)))    # >0
# Expected: dC/dd carries the sign of f'(R)*dR/dd = (+)*(-) < 0  -> redundancy confirmed.
```

### 6.2 Numerical non-monotonicity + TSP-with-intersection experiment (numpy)

```python
# srht_verify_nonmonotone.py   # NEEDS EXECUTION (sandbox unavailable at audit time)
"""Reproduce critique §3: N=20 cities, beam width=20, multiple seeds.
Compares PLAIN BEAM (rank by cost d) vs SRHT-GATE (rank by g(R)*(1-chi)^2 with chi bound
to self-intersection, INDEPENDENT of d). Reports a results table + honesty caveat."""
import numpy as np
from itertools import combinations

def seg_intersect(a,b,c,e):
    def ccw(p,q,r): return (r[1]-p[1])*(q[0]-p[0]) > (q[1]-p[1])*(r[0]-p[0])
    return ccw(a,c,e)!=ccw(b,c,e) and ccw(a,b,c)!=ccw(a,b,e)

def n_crossings(path, pts):
    P=[pts[i] for i in path]; segs=list(zip(P[:-1],P[1:])); c=0
    for (i,(a,b)),(j,(cc,e)) in combinations(enumerate(segs),2):
        if j<=i+1: continue
        if seg_intersect(a,b,cc,e): c+=1
    return c

def cost(path, pts):
    P=np.array([pts[i] for i in path]); return float(np.sum(np.linalg.norm(np.diff(P,axis=0),axis=1)))

def g(R): return R*R/(2-R)

def beam(pts, width, use_gate, vmax=4):
    N=len(pts); beams=[[0]]
    for _ in range(N-1):
        cand=[]
        for path in beams:
            for nxt in range(N):
                if nxt in path: continue
                np_=path+[nxt]; cand.append(np_)
        # rank
        if not use_gate:
            cand.sort(key=lambda p: cost(p,pts))                      # plain beam: by distance
        else:
            costs=[cost(p,pts) for p in cand]
            cmin,cmax=min(costs),max(costs)
            def score(p):
                c=cost(p,pts); R=1-(c-cmin)/(cmax-cmin+1e-9)          # rank-based R (§4.3)
                chi=min(1.0, n_crossings(p,pts)/vmax)                 # constraint-bound chi (§4.2)
                return g(R)*(1-chi)**2                                # normalized Chat (§4.1)
            cand.sort(key=score, reverse=True)
        beams=cand[:width]
    # close tours, pick best by full length
    best=min(beams, key=lambda p: cost(p+[p[0]],pts))
    return cost(best+[best[0]],pts)

if __name__=="__main__":
    print(f"{'seed':>4} {'PlainBeam':>10} {'SRHT-gate':>10} {'diff':>8}  winner")
    for seed in [7,9,13,21,42]:
        rng=np.random.default_rng(seed); pts=rng.uniform(0,100,size=(20,2)).tolist()
        pb=beam(pts,20,False); sr=beam(pts,20,True); diff=pb-sr
        print(f"{seed:>4} {pb:10.2f} {sr:10.2f} {diff:8.2f}  {'SRHT' if sr<pb else 'PLAIN'}")
    # CAVEAT: critique reported SRHT ahead by up to 22.42 on seeds 7/9/13. This script
    # reproduces the SETUP honestly; actual win/loss must be read from real output.
    # A fair audit expects MIXED results across seeds, not a clean sweep.
```

> **Honesty contract.** When run, §6.2 is expected to show SRHT-gate *sometimes* better and
> *sometimes* not — the defensible claim is "constraint-bound $\chi$ does work pure-$d$ ranking
> cannot," demonstrated by *any* statistically significant net improvement over many seeds with a
> paired test, **not** by a cherry-picked 3-seed sweep. Reporting only winning seeds (as the original
> critique table does) is exactly the practice this audit warns against.
