# ANTIGRAVITY TASK — drive the web sim-lab live (read/observe only)

ROLE: You may open and interact with WEB pages in the browser and write ONE report
file. Do NOT edit any project source code. Do NOT install software. Do NOT touch the
KAI fleet. Evidence, not guesses. Quote what you actually see on screen. Stay on task.

CONTEXT: These are simulation sandboxes chosen to mirror KAI's lattice brain. For each,
open it, configure as specified, run it, and report what happens — so Ryan can compare
the behavior to KAI's own design.

=== 1. TENSORFLOW PLAYGROUND (3 presets) ===
Open each URL, press the run/play button, let it train ~30 seconds, then report the
final test loss and describe the decision boundary that formed.

  Preset A (deep net, spiral):
  https://playground.tensorflow.org/#activation=relu&batchSize=10&dataset=spiral&regularization=none&learningRate=0.03&regularizationRate=0&noise=0&networkShape=8,8,8,8&seed=0.123&showTestData=false&discretize=false&percTrainData=50&x=true&y=true&xTimesY=false&xSquared=false&ySquared=false&cosX=false&sinX=false&cosY=false&sinY=false&collectStats=false&problem=classification&initZero=false&hideText=false

  Preset B (engineered features, circle):
  https://playground.tensorflow.org/#activation=tanh&batchSize=10&dataset=circle&regularization=none&learningRate=0.03&regularizationRate=0&noise=0&networkShape=3&seed=0.123&showTestData=false&discretize=false&percTrainData=50&x=true&y=true&xTimesY=true&xSquared=true&ySquared=true&cosX=false&sinX=false&cosY=false&sinY=false&collectStats=false&problem=classification&initZero=false&hideText=false

  Preset C (noise + L2 regularization, xor):
  https://playground.tensorflow.org/#activation=tanh&batchSize=10&dataset=xor&regularization=L2&learningRate=0.03&regularizationRate=0.01&noise=35&networkShape=4,2&seed=0.123&showTestData=true&discretize=false&percTrainData=50&x=true&y=true&xTimesY=false&xSquared=false&ySquared=false&cosX=false&sinX=false&cosY=false&sinY=false&collectStats=false&problem=classification&initZero=false&hideText=false

  REPORT per preset: final training loss, final test loss, how many epochs to converge,
  and one sentence on the boundary shape. For B specifically, note how fast it solved
  the circle compared to A solving the spiral.

=== 2. CONVNETJS — Deep Q-Learning RL agent ===
  https://cs.stanford.edu/people/karpathy/convnetjs/demo/rldemo.html
  Let it run ~1 minute. Report: does the agent's average reward visibly improve over
  time? Describe its behavior at start vs after a minute (random vs goal-seeking).

=== 3. GAME OF LIFE ===
  https://playgameoflife.com/
  Load the "Gosper Glider Gun" pattern from the site's pattern library (or build/paste
  it), run it, and report: does it continuously emit gliders? Roughly how often a new
  glider is produced. (This is the "ripple source" analog.)

=== OUTPUT ===
Write ONE report: C:\KAI\anti-sim-lab-report.md
Sections 1/2/3 as above, each with quoted on-screen values and a one-line takeaway of
how the behavior relates to KAI (depth->emergence, RL->reinforcement, gliders->ripples).
Do NOT install anything. Do NOT edit source. ALIEN is a desktop app and is OUT OF SCOPE
for this browser task.
```
