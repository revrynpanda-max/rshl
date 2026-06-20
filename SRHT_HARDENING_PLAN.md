# SRHT Research-Hardening Plan

**Purpose:** Turn Sparse Resonance Hyperlattice Theory (SRHT) from a hyped draft into a credible, peer-reviewable contribution. The plan keeps what is genuinely novel, retires what is unsupported, and specifies experiments a researcher could execute to settle the open questions honestly.

**Authoring stance:** Every recommendation below is written to make SRHT *survive* scrutiny rather than impress on first read. Where a claim cannot yet be supported, the plan says so plainly and defines the evidence that would be required to make it.

---

## 1. Keep and Lead With the Proven Result

The defensible core of SRHT is established by the author's own audit (`SRHT_CRITIQUE_AND_PROOF.md`): when contradiction $\chi$ is bound to constraints that are **independent of the cost being optimized**, the SRHT selection rule does real, non-trivial work that a same-width greedy beam search cannot replicate. This — not the physics vocabulary — is the contribution worth leading with.

**The mechanism, stated cleanly.** In a beam/best-first search, the selection score is $C(p) = \rho \cdot R(p)^2 \cdot \frac{1}{2-R(p)} \cdot (1-\chi(p))^2 \cdot \tau$. The audit proves that if $R$ and $\chi$ are both monotone functions of the accumulated cost $d(p)$, then sorting by $C$ is order-equivalent to sorting by $d$, and the entire physics layer is a redundant re-encoding of the cost. The framework becomes interesting precisely when $\chi$ is decoupled from $d$ — for example, $\chi = 0.9$ when a partial TSP tour self-intersects, a structural defect that raw path length does not see. Then $C$ is non-monotone in $d$: the search can rationally prefer a slightly longer-but-valid partial solution over a shorter-but-structurally-doomed one, escaping the local trap that greedily-shortest-segment selection walks into. The $N=20$ self-intersection experiment over 20 seeds (SRHT beating plain beam by up to 22.42 units on the reported seeds) is the seed of real evidence for this.

**Reframing.** SRHT should be presented as a **constraint-aware best-first search framework**: a single scalar score that fuses (i) progress toward the objective and (ii) satisfaction of validity constraints that are not reducible to the objective, with a tunable gate that prunes branches whose constraint violation is high regardless of their objective value. This framing is honest, testable, and connects SRHT to a well-understood literature (constrained search, soft/hard constraint penalties, beam search with feasibility scoring) rather than isolating it behind invented physics. The novelty claim narrows but becomes *defensible*: a particular, smooth, multiplicative fusion of progress and independent-constraint scores, plus a pruning gate, that empirically improves beam search on constraint-structured problems.

**Action.** Restructure the paper so Section 1 is this result. Lead with the proof of when the method is non-redundant, then the controlled experiment that demonstrates it. Everything currently in the abstract about "waves," "Born-rule interference," and "cracking cryptography" moves out of the lead and is either cut or demoted to clearly-labeled speculation (Sections 2 and 4 below).

---

## 2. Cut or Qualify the Overclaims

Three claims in the current draft are not supported by the evidence presented and will sink the paper in review. Each is handled below.

### 2.1 The "exponential → polynomial / O(d)" complexity collapse

Section 4.2 of the paper argues that under high constraint density the survival probability drives expected nodes visited to $O((b(1-p))^d)$ and, if $p \to 1 - 1/b$, the search "collapses from exponential to polynomial time $O(d)$." This is a **conditional asymptotic claim with an unproven and likely false premise.** It assumes a *constant per-node* pruning probability $p$ that is independent across depth and uniformly close to $1-1/b$ — an assumption that has no proof and that, for NP-hard problems, would imply P = NP if it held adversarially. The TSP and SVP timing tables show fast runtimes on *small, specific, randomly generated instances*; they say nothing about worst-case scaling.

**Restatement (required).** Replace the complexity-collapse claim with: *"On the random instances tested, SRHT pruning reduces the number of expanded nodes relative to unpruned search, yielding empirical speedups at the sizes shown. We make no worst-case complexity claim; the per-node pruning rate is instance-dependent and is not guaranteed to remain bounded away from 1/b as dimension grows."* If the author wishes to retain any asymptotic statement, it must be accompanied by (a) a measured pruning-rate-versus-depth curve across a sweep of sizes, and (b) an explicit statement that the favorable regime is an empirical observation, not a theorem.

### 2.2 The "crack Kyber/Dilithium in polynomial time" claim

Section 4.3's suggestion that an analog SRHT implementation "could crack lattice cryptography in polynomial time" is **unsupported and should be cut entirely** from any peer-facing version. The SVP results are at dimensions 8, 10, and 12 against a *random-coefficient baseline* (2,000 random combinations) — not against LLL or BKZ, and not at cryptographically relevant dimensions (Kyber/Dilithium operate at module ranks corresponding to lattice dimensions of several hundred to ~1000+). Beating random search in dimension 12 is many orders of magnitude away from beating BKZ in dimension 500+. The claim also conflates finding *a* short vector below the Minkowski bound with solving exact-SVP at scale, which is the actual cryptanalytic requirement.

**Action.** Remove the cryptography-breaking claim. Replace Section 4.3 with a sober statement: *"Whether SRHT-style constraint-gated search can match or accelerate BKZ's SVP oracle at cryptographically relevant block sizes is an open empirical question. Nothing in our small-dimension experiments bears on the security of deployed lattice schemes."* The BKZ-acceleration idea (Section 4.1) may be retained only as an explicitly-labeled *hypothesis to be tested* (see Section 3 below), never as a result.

### 2.3 "Born-Rule Quantum Phase Interference"

The operator $P = C \cdot \cos(\chi \frac{\pi}{2})$ is presented with quantum-mechanical language (Born rule, probability amplitude, phase interference). This is **decorative, not physical.** There is no Hilbert space, no complex amplitude, no superposition, no measurement; $\chi \in [0,1]$ is a real scalar and $\cos(\chi\pi/2)$ is just a smooth real-valued gate that equals 1 at $\chi=0$ and 0 at $\chi=1$. The quantum framing invites — and will not survive — a referee who knows quantum mechanics.

**Restatement (required).** Describe $P$ honestly as a **classical cosine constraint-gate**: a monotone soft penalty that multiplicatively suppresses a candidate's score as its constraint violation $\chi$ rises, reaching exactly zero at full violation. State plainly that the cosine shape is a *design choice* for a smooth, bounded gate with zero gradient at the endpoints, and that alternatives (linear $1-\chi$, $(1-\chi)^2$, sigmoid) should be compared (see Section 4). Remove "Born rule," "quantum," "amplitude," and "interference" from the operator's definition. The same applies to the abstract's "destructive interference" language — call it pruning.

---

## 3. Benchmarking Upgrade

The current baselines (instant greedy nearest-neighbor for TSP; 2,000 random combinations for SVP) are too weak to support any claim of practical value. A method that beats a deliberately weak baseline has demonstrated nothing about its standing against the methods practitioners actually use. The benchmarking must be rebuilt around **strong, standard solvers, larger instances, and statistics over many seeds.**

### 3.1 TSP

**Strong baselines.** Compare SRHT against (i) **LKH** (Lin–Kernighan–Helsgaun, the de facto state-of-the-art heuristic) and (ii) **Concorde** (exact optimal, where tractable) on standard instances. Include a same-width plain beam search as the *ablation* baseline (to isolate the value of the $\chi$-gate), not as the headline competitor.

**Instances and sizes.** Use TSPLIB instances and randomly generated Euclidean instances at $N \in \{50, 100, 200, 500\}$ — well beyond the $N \le 20$ currently reported. Report results as **mean ± standard deviation of tour length over $\ge 30$ independent seeds/instances per size**, plus the optimality gap to Concorde (or best-known) where available.

**Success criterion.** SRHT is credible on TSP if, *at a matched or lower compute budget* (wall-clock and node-expansions both reported), it achieves tour-length gaps to optimal that are **statistically indistinguishable from or better than** the same-width beam baseline, with the gap improvement significant at $p < 0.05$ under a paired test (e.g., Wilcoxon signed-rank across seeds). Matching or beating LKH is *not* expected and should not be the bar; the honest, achievable claim is "the constraint-gate improves constraint-structured beam search at equal compute." If SRHT *also* narrows the gap to LKH relative to plain beam, report it — but do not promise it.

### 3.2 SVP

**Strong baselines.** Replace random-coefficient search with **LLL** and **BKZ** (e.g., via fpylll / the FPLLL library) as baselines, plus an exact enumeration oracle at small dimension for ground truth. Random search must be dropped as the comparison point.

**Instances and sizes.** Use standard SVP-challenge-style random lattices at dimensions $D \in \{40, 60, 80, 100\}$ at minimum, reporting the achieved norm as a ratio to the Gaussian-heuristic / Minkowski bound, averaged over $\ge 20$ random bases per dimension with variance reported. Dimensions 8–12 are not informative.

**Success criterion.** The honest claim to test is whether SRHT, used *as the per-block SVP oracle inside BKZ*, can match BKZ-with-enumeration's output quality (Hermite factor) at **lower wall-clock or fewer oracle operations**, at a fixed block size $\beta$, with significance over seeds. Any cryptographic relevance requires demonstrating this at $\beta \ge 40$ and showing the advantage does *not* vanish as $\beta$ grows. Until that curve is produced, no statement about lattice cryptography may be made.

### 3.3 Reporting discipline

Every table reports: instance set and size, seed count, mean and variance, compute budget (wall-clock *and* node-expansions/oracle-calls), and the significance test used. Pin solver versions and random seeds; release the harness so results are reproducible. Speedups quoted without a matched-quality and matched-compute comparison are not admissible.

---

## 4. Principled Parameters

The thresholds and step values in SRHT are currently hand-tuned magic numbers: the pruning gate $X > 0.8$, the collapse cutoff $P < 10^{-10}$, the contradiction step function $\chi \in \{1.0, 0.6, 0.1\}$, the resonance scale $\alpha$ in $R = 1 - d/(\alpha\, d_{\text{avg}})$, the commit-readiness exponents ($R^2$, $(1-\chi)^2$), and the $\tau$ scale. None are justified or derived. A reviewer will read each as a degree of freedom quietly fitted to the reported instances.

**Sensitivity-analysis protocol (required).** For each parameter, run a one-at-a-time sweep across at least one order of magnitude (or the full $[0,1]$ range for thresholds) on a held-out instance set distinct from any used for development, and report the performance curve with variance. A robust method shows broad plateaus, not sharp peaks at the chosen value. Follow the one-at-a-time sweeps with a small randomized joint search (e.g., Latin-hypercube over the parameter box) to check for interactions, and report the best, median, and chosen configurations. **Critically: tuning is done on a development split and all headline results in Section 3 are reported on a separate, untouched test split**, to rule out the appearance of overfitting parameters to the benchmark.

**Derivation where possible.** Several parameters can be motivated rather than guessed: the $P < 10^{-10}$ cutoff is effectively a floating-point/budget pruning floor and should be stated as such (and shown to be insensitive across several orders of magnitude). The $X > 0.8$ gate should be re-expressed as "prune when constraint violation exceeds fraction $\theta$ of the maximum," with $\theta$ swept. The $\chi$ step function $\{1.0, 0.6, 0.1\}$ should be replaced by, or compared against, a continuous violation measure, since discrete steps are an obvious tuning surface; if discrete steps are kept, justify the boundaries. The cosine gate shape itself (Section 2.3) is a parameter family — compare cosine against linear and quadratic gates and report which generalizes. The goal is that every constant in the final paper is either *derived*, *shown insensitive*, or *honestly flagged as fitted on the dev split*.

---

## 5. The Legitimate KAI Application

The cleanest real-world test of the SRHT thesis lives inside KAI itself: **constraint-aware decoding for language generation.** This is exactly the regime where the contribution holds, because grammatical and logical validity are constraints *independent of* a token's raw probability — the analog of self-intersection being independent of path length. A locally high-probability token can produce a globally invalid sentence, just as a locally short segment can force a later crossing.

**The binding.** Following the audit's recommendation, $\chi$ must *not* be computed from sequence length or raw token log-probability (that path reproduces the monotonic-redundancy bug, where SRHT collapses to ordinary likelihood ranking). Instead, $\chi$ is bound to **explicit grammar/logic rule violations** evaluated on the partial generation — e.g., a parse-rule check in KAI's `algebra.rs` that sets $\chi$ high when a candidate continuation violates the grammatical template (noun-after-noun where the template forbids it), breaks a bracket/quote balance, or contradicts an asserted fact in the working context. The base score plays the role of $R$ (progress/likelihood); the cosine gate $P = C\cos(\chi\pi/2)$ then performs **constraint-aware decoding**, suppressing high-likelihood-but-invalid continuations during top-k/nucleus sampling.

**Concrete test.** Construct a held-out set of generation prompts with *machine-checkable* constraints: (a) balanced-delimiter / valid-JSON or valid-expression generation, (b) a controlled grammar where validity is decidable by a parser, and (c) a small factual-consistency task with a checkable knowledge base. For each, compare three decoders at matched compute: (i) standard top-k/nucleus sampling, (ii) the same sampler with a naive length/probability penalty (the redundant control), and (iii) SRHT constraint-gated decoding with $\chi$ bound to the rule checker. **Primary metric:** rate of constraint-valid outputs. **Secondary metrics:** fluency/likelihood of the valid outputs (to confirm the gate does not destroy quality) and compute overhead. **Success criterion:** SRHT decoding produces a statistically significant increase in valid-output rate over both baselines (paired test over prompts, $p < 0.05$) without a meaningful drop in fluency on the valid set. This directly operationalizes the paper's true claim — that constraint-bound $\chi$ does work that cost-bound ranking cannot — in KAI's actual domain, and it is the experiment most worth running first because it is cheap, decisive, and on-mission.

---

## Summary of Disposition

| Item | Disposition |
|---|---|
| Constraint-bound $\chi$ beats same-width beam (audit result) | **Keep — lead with it.** Reframe SRHT as constraint-aware best-first search. |
| Exponential → polynomial / $O(d)$ collapse | **Qualify.** Restate as instance-specific empirical speedup; no worst-case guarantee. |
| Crack Kyber/Dilithium in polynomial time | **Cut.** Unsupported; would require beating BKZ at scale, not shown. |
| Born-rule quantum phase interference | **Restate.** $P=C\cos(\chi\pi/2)$ is a classical cosine constraint-gate. |
| Weak baselines (greedy, random, plain beam) | **Replace.** LKH/Concorde (TSP), LLL/BKZ (SVP), larger sizes, stats over seeds. |
| Hand-tuned thresholds | **Justify.** Sensitivity sweeps, dev/test split, derive or flag every constant. |
| KAI language application | **Specify & test.** Bind $\chi$ to grammar/logic rules; constraint-aware decoding with checkable success criteria. |
