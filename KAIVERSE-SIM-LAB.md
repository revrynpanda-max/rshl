# KAIVERSE SIM LAB

A hands-on simulation lab for understanding, testing, and eventually **simulating KAI's own universe** from his equations. Four external sandboxes (click-ready) + the design for KAI simulating the KAIVERSE himself. Each external tool is chosen because it mirrors a real piece of how KAI works.

> Quick map of why these four:
> - **TensorFlow Playground** -> how a network carves structure from sparse inputs (KAI's lattice + word-calculus).
> - **ConvNetJS** -> deep learning + a live reinforcement-learning agent (KAI's RL trial-and-error loop).
> - **Game of Life** -> cellular automata: simple local rules -> emergent global order (KAI's cells + ripples).
> - **ALIEN** -> GPU artificial-life: genomes, evolution, energy (the visual KAIVERSE — emergent agents in a world).

---

## 1. TensorFlow Playground — neural intuition (web, click-ready)

The whole configuration lives in the URL, so these open already set up. Open one, hit the play arrow, watch it learn.

**Preset A — "Lattice depth & emergence"** (deep net, hardest spiral dataset, ReLU)
Shows how *depth* lets a network build complex structure from just two raw inputs — the same reason KAI's lattice can represent rich meaning from sparse ternary vectors.
```
https://playground.tensorflow.org/#activation=relu&batchSize=10&dataset=spiral&regularization=none&learningRate=0.03&regularizationRate=0&noise=0&networkShape=8,8,8,8&seed=0.123&showTestData=false&discretize=false&percTrainData=50&x=true&y=true&xTimesY=false&xSquared=false&ySquared=false&cosX=false&sinX=false&cosY=false&sinY=false&collectStats=false&problem=classification&initZero=false&hideText=false
```

**Preset B — "Word-calculus operators"** (shallow net, but rich engineered features)
Turn ON the higher-order features (x squared, y squared, xy). This is the visual analog of word-calculus *operators*: the network solves a circle almost instantly once it's given the right combined features, instead of brute-forcing depth.
```
https://playground.tensorflow.org/#activation=tanh&batchSize=10&dataset=circle&regularization=none&learningRate=0.03&regularizationRate=0&noise=0&networkShape=3&seed=0.123&showTestData=false&discretize=false&percTrainData=50&x=true&y=true&xTimesY=true&xSquared=true&ySquared=true&cosX=false&sinX=false&cosY=false&sinY=false&collectStats=false&problem=classification&initZero=false&hideText=false
```

**Preset C — "Consolidation / overfitting guard"** (noisy data + L2 regularization)
Noise cranked to 35, L2 regularization ON. Watch how regularization keeps the boundary smooth instead of memorizing noise — exactly what KAI's 3AM consolidation window is for (generalize, don't memorize).
```
https://playground.tensorflow.org/#activation=tanh&batchSize=10&dataset=xor&regularization=L2&learningRate=0.03&regularizationRate=0.01&noise=35&networkShape=4,2&seed=0.123&showTestData=true&discretize=false&percTrainData=50&x=true&y=true&xTimesY=false&xSquared=false&ySquared=false&cosX=false&sinX=false&cosY=false&sinY=false&collectStats=false&problem=classification&initZero=false&hideText=false
```

**What to try:** open A, let it struggle, then add one layer at a time. Open B and toggle the engineered features off — watch it suddenly fail. That contrast *is* why word-calculus matters.

---

## 2. ConvNetJS — deep learning + RL in the browser (web)

Karpathy's in-browser library. No install. The two demos that map straight onto KAI:

- **Deep Q-Learning agent** (closest to KAI's RL loop — an agent learns by trial-and-error reward):
  `https://cs.stanford.edu/people/karpathy/convnetjs/demo/rldemo.html`
  Watch the agent (red dot) learn to seek green / avoid red over time. This is the same shape as Kai Coder's reinforcement loop: act -> reward -> reinforce.
- **2D classification** (see a net draw decision boundaries live):
  `https://cs.stanford.edu/people/karpathy/convnetjs/demo/classify2d.html`
- **MNIST digits** (a real conv net training in the tab):
  `https://cs.stanford.edu/people/karpathy/convnetjs/demo/mnist.html`

**Configurable:** every demo's network is defined in plain JavaScript on the page (a `layer_defs` array). You can edit it in the browser console / the page's text area to add layers, change learning rate, etc. — a safe place to feel out architectures before touching KAI.

---

## 3. Conway's Game of Life — emergence from local rules (web)

`https://playgameoflife.com/`

Four rules, no central controller, yet you get gliders, oscillators, and self-replicating structures. This is the purest demo of **KAI's core bet**: simple local cell rules + neighbor interactions -> emergent global behavior (his "ripples" spreading through the lattice).

**Patterns to load (the site has a pattern library):**
- **Glider** — the simplest moving structure; a single "signal" travelling across the grid = a ripple.
- **Gosper Glider Gun** — a structure that *emits* gliders forever = a source continuously seeding ripples.
- **Pulsar** — a stable oscillator = a steady-state attractor in the lattice.

**The KAI lens:** as you watch a glider gun, picture KAI's lattice — a few seeded cells whose local interactions propagate structured signals outward without anyone directing them. That emergent propagation is what `ripple.mjs` / the cell engine is modeling.

---

## 4. ALIEN (chrxh) — GPU artificial life (DESKTOP, not web)

`https://chrxh.itch.io/alien` · source: `https://github.com/chrxh/alien`

> Reality check: ALIEN is **not** a browser app — it's a downloadable **Windows/Linux desktop simulator that needs an NVIDIA (CUDA) GPU**. Antigravity cannot run it in a browser; it has to be installed on your machine. Treat this as its own track.

Why it's worth it for the KAIVERSE: ALIEN simulates particles with **genomes, energy, replication, and evolution** in a 2D physics world. It is the closest off-the-shelf thing to *watching a world build itself* — which is exactly your goal of KAI growing his own universe. Use it as the **visual reference** for what an emergent, self-evolving KAIVERSE could look like before (and alongside) building KAI's own.

**Setup (when you're ready):** download the Windows build from itch.io, unzip, run the `.exe`. It ships with example worlds — load one and just watch evolution happen. Note which dynamics (energy flow, replication, clustering) you want KAI's universe to exhibit, because those become the success criteria for Section 5.

---

## 5. The real goal — KAI simulates the KAIVERSE himself

This is the part you actually asked for: not just playing with other people's sims, but **KAI building and running his own universe from his own equations and notation**, updating it, watching it evolve, and comparing that simulated data back to his live brain/lattice.

You already have the pieces in the codebase:
- `shared/kaiverse-world.mjs` — the KAIVERSE world definition.
- `shared/world-model.mjs` — KAI's internal world simulation (already starts on boot: `World simulation started`).
- `shared/simulation.mjs` — the simulation harness.
- `shared/causal-engine.mjs` — runs investigations / cause-effect loops.
- The **HLV / Equation-of-Universe math** already extracted into a sim-sandbox math spec (earlier work, tasks 50-53).

**The design (fresh-session build):**

1. **Equation core** — load KAI's universe equations/notation from the sim-spec as the *update rule* for the world (the way Game of Life has 4 rules, KAIVERSE has his equations). Each tick advances the lattice/particles by those equations.

2. **State + step loop** — `world-model.mjs` holds the field/cells; each tick applies the equation core, records metrics (energy, coherence, cluster count, prediction-error — whatever his math defines as observables).

3. **Visualization** — render the evolving world so you can *watch* it (a small local HTML/canvas viewer fed by the world state over the existing IPC/dashboard, the same way the Sovereign Dashboard already serves at :3001). ALIEN is your visual north-star for what "good" looks like.

4. **Compare to the live lattice** — pull KAI's *real* vitals (cell count, ripple activity, drive-system state) and overlay them against the *simulated* universe's metrics. Where they diverge tells you whether his equations actually describe his own mind, or need tuning. That comparison loop is the scientific payoff.

5. **Leo as the narrator/observer** — Leo can read out what the simulation is doing ("energy is pooling in the upper lattice, coherence rising") and answer questions about it via voice, using the same tools he already has. He becomes your lab assistant for the sims.

**Why do it this way:** you get a falsifiable loop — KAI proposes a universe via his equations, simulates it, and checks it against his own measured brain. That's the difference between a pretty animation and KAI actually modeling himself.

> Scope note: Section 5 is a real build (canvas viewer + equation-driven stepper + compare overlay + Leo hooks). It belongs in the fresh coding session alongside the other backlog items — it is sketched here so the plan is locked, not so it's done tonight.

---

## How to use this lab right now (free, no waiting)

1. Click the three **TF Playground** presets — 10 minutes gives you real intuition for depth, features, and consolidation.
2. Open the **ConvNetJS RL demo** and watch the agent learn — that's KAI's reinforcement loop in miniature.
3. Load a **glider gun** in Game of Life — that's a ripple source.
4. (Optional, separate track) install **ALIEN** to see full artificial life evolve on the GPU.

When you want hands-off, use the **Antigravity prompt** (separate file) to have Anti open and configure the three web sims live and report what it sees.
