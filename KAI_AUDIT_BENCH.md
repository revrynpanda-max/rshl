# KAI v5.9.4 — Full System Audit & Bench Test Specification
## Antigravity Execution Document — Multi-Hour Comprehensive Inspection

---

> **ANTI-DRIFT ANCHOR — READ THIS FIRST AND RE-READ IT EVERY 30 MINUTES**
>
> You are running a full system audit of KAI v5.9.4 — a Rust-based cognitive AI using RSHL (Recursive
> Sparse Hyperdimensional Lattice). Your mission is to inspect, test, measure, experiment, and report
> on EVERYTHING: correctness, performance, architecture, algorithms, data quality, output quality,
> edge cases, and system health. You must NOT fabricate results. If a test fails or a command errors,
> report the actual error. You must NOT drift into solving problems — your job is to AUDIT and REPORT.
> If you find something that needs fixing, note it in the report as a FINDING, do not fix it yourself
> unless a specific test section instructs you to make an isolated experiment.
>
> **Working directory for all commands:** `/sessions/eloquent-bold-newton/mnt/KAI/`
> **Primary source file:** `src/main.rs` (~10,200+ lines)
> **State file:** `data/kai-state.json` (if it exists)
> **Output report:** Write your final report to `KAI_AUDIT_REPORT.md` in the KAI directory.
>
> **Parallel execution:** Where sections are marked [PARALLEL], you may spawn sub-tasks to run them
> simultaneously. Always collect all results before writing the final report.

---

## SECTION 0 — PRE-FLIGHT: Environment Verification

Before any tests begin, verify the environment. Run these checks sequentially.

### 0.1 — Directory Structure Audit
List the full directory structure of the KAI project. Identify every `.rs` source file, every config
file, every data file. Count total lines of Rust source code. Record:
- Total `.rs` files
- Total lines across all `.rs` files
- Size of `data/kai-state.json` in bytes and MB (if it exists)
- Any unexpected files or directories
- Whether `Cargo.toml` specifies release optimizations (`opt-level`, `lto`, etc.)

```bash
find /sessions/eloquent-bold-newton/mnt/KAI -type f | sort
wc -l /sessions/eloquent-bold-newton/mnt/KAI/src/**/*.rs
ls -lah /sessions/eloquent-bold-newton/mnt/KAI/data/ 2>/dev/null || echo "no data dir"
cat /sessions/eloquent-bold-newton/mnt/KAI/Cargo.toml
```

### 0.2 — Null Byte Detection
**CRITICAL:** The main.rs file has a history of null byte corruption from the editing pipeline.
Check for null bytes before attempting any build:

```bash
python3 -c "
with open('/sessions/eloquent-bold-newton/mnt/KAI/src/main.rs', 'rb') as f:
    content = f.read()
null_count = content.count(b'\x00')
print(f'Null bytes found: {null_count}')
print(f'File size: {len(content)} bytes')
print(f'File clean: {null_count == 0}')
"
```

If null bytes are found, strip them and report how many were stripped:
```bash
python3 -c "
with open('/sessions/eloquent-bold-newton/mnt/KAI/src/main.rs', 'rb') as f:
    content = f.read()
cleaned = content.replace(b'\x00', b'')
with open('/sessions/eloquent-bold-newton/mnt/KAI/src/main.rs', 'wb') as f:
    f.write(cleaned)
print(f'Stripped {content.count(chr(0).encode())} null bytes')
"
```

### 0.3 — Compilation Check
Attempt to compile in check mode. Record ALL warnings and errors:

```bash
cd /sessions/eloquent-bold-newton/mnt/KAI && cargo check 2>&1
```

Record:
- Did it compile clean? (yes/no)
- Number of warnings
- List every warning with its line number and message
- Any errors (these are critical failures)

**PASS criteria:** Zero errors, zero warnings.
**FAIL criteria:** Any error. Warning count > 0 is a partial fail — record each one.

### 0.4 — Dependency Audit
Examine all dependencies in Cargo.toml and Cargo.lock:

```bash
cat /sessions/eloquent-bold-newton/mnt/KAI/Cargo.toml
cat /sessions/eloquent-bold-newton/mnt/KAI/Cargo.lock | head -100
```

For each dependency, note: name, version, purpose. Flag any dependency that seems:
- Outdated (major version behind)
- Potentially security-relevant
- Unused or redundant

---

## SECTION 1 — SOURCE CODE STATIC ANALYSIS [PARALLEL GROUP A]

These tests examine the source code without running it. Run all sub-tests in parallel.

### 1.1 — Function Count and Complexity Census

Count every `fn`, `pub fn`, `async fn` in the codebase. For each major function in main.rs:
- Line count
- Cyclomatic complexity estimate (count if/match/loop/while branches)
- Does it have documentation comments?

```bash
grep -n "^fn \|^pub fn \|^    fn \|^    pub fn " /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | wc -l
grep -n "^fn \|^pub fn \|^    fn \|^    pub fn " /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs
```

Flag any function exceeding 200 lines as a complexity concern.

### 1.2 — Critical Function Presence Verification

Verify every expected function exists in main.rs. Check for EXACT presence of each:

```bash
python3 << 'EOF'
import subprocess

functions_to_verify = [
    "fn synthesize_to_speech",
    "fn run_calibration",
    "fn run_fid_audit",
    "fn run_train_truths",
    "fn run_main_tui",
    "struct App",
    "fn process_input",
    "fn render_messages",
    "is_thinking: bool",
    "fn ui(",
]

with open('/sessions/eloquent-bold-newton/mnt/KAI/src/main.rs', 'r', errors='replace') as f:
    content = f.read()

for func in functions_to_verify:
    found = func in content
    count = content.count(func)
    print(f"{'✓' if found else '✗'} [{count}x] {func}")
EOF
```

### 1.3 — Patch Application Verification

Verify every patch that was applied is actually present. Each patch had an "already applied" marker.
Check for all of them:

```bash
python3 << 'EOF'
markers = {
    "patch_perf.py Fix1 (Ollama guard)": "KAI_OLLAMA_URL",
    "patch_perf.py Fix2 (Turn render limit)": "Only render the last 50 turns",
    "patch_perf.py Fix3 (is_thinking)": "is_thinking: bool,",
    "patch_perf.py Fix3d (thinking render)": "thinking...",
    "patch_step1.py (blank response fix)": "My lattice isn't resolving",
    "patch_step2.py PartA (train-truths flag)": "run_train_truths()",
    "patch_step2.py PartB (train-truths fn)": "Physics-core atoms",
    "patch_step3.py PartA (NL cells)": "E=mc² is Einstein's equation",
    "patch_step3.py PartB (synthesize fn)": "fn synthesize_to_speech",
    "patch_step3b.py FixC (has-hits wire)": "let synth_text = synthesize_to_speech",
    "patch_step3b.py FixD (no-hits wire)": "let synth_text_no = synthesize_to_speech",
    "patch_fid.py (FID gate)": "FID: low resonance",
    "freeze fix (terminal.draw before process_input)": "terminal.draw(|f| ui(f, &app))?;",
}

with open('/sessions/eloquent-bold-newton/mnt/KAI/src/main.rs', 'r', errors='replace') as f:
    content = f.read()

passed = 0
failed = 0
for name, marker in markers.items():
    if marker in content:
        print(f"✓ PRESENT: {name}")
        passed += 1
    else:
        print(f"✗ MISSING: {name} (marker: '{marker}')")
        failed += 1

print(f"\nPassed: {passed}/{len(markers)}")
print(f"Failed: {failed}/{len(markers)}")
EOF
```

### 1.4 — synthesize_to_speech Logic Audit

Read the full `synthesize_to_speech` function and analyze its logic:

```bash
python3 << 'EOF'
with open('/sessions/eloquent-bold-newton/mnt/KAI/src/main.rs', 'r', errors='replace') as f:
    content = f.read()

start = content.find('fn synthesize_to_speech')
# Find the function end by tracking brace depth
depth = 0
i = start
in_fn = False
for i, ch in enumerate(content[start:], start):
    if ch == '{':
        depth += 1
        in_fn = True
    elif ch == '}':
        depth -= 1
        if in_fn and depth == 0:
            break

fn_body = content[start:i+1]
print(f"Function length: {len(fn_body.splitlines())} lines")
print()
print("=== FULL FUNCTION BODY ===")
print(fn_body)
EOF
```

Test each branch of the function against known inputs by simulating in Python:

```python
# Simulate the Rust logic in Python to verify correctness
test_cases = [
    # (input_text, expected_behavior)
    ("E equals mc squared mass energy equivalence Einstein special relativity confirmed nuclear fission fusion", "generic_fallback"),
    ("E=mc² is Einstein's equation from special relativity", "pass_through_natural"),
    ("luminiferous ether disproven Michelson Morley experiment 1887 null result light medium does not exist", "disproven_pattern"),
    ("Quasicrystals are real — Dan Shechtman discovered aperiodic atomic order", "pass_through_natural"),
    ("quasicrystals aperiodic order Dan Shechtman Nobel Prize 2011 forbidden symmetry real experimentally confirmed", "nobel_pattern"),
    ("The luminiferous ether does not exist — the Michelson-Morley experiment in 1887", "pass_through_natural"),
    ("GPS satellites require general relativity time dilation correction confirmed engineering fact", "confirmed_experiment_or_generic"),
    ("", "empty_passthrough"),
    ("[FID: low resonance — speculative territory]", "fid_passthrough"),
    ("The concept of quasicrystal connects 'aperiodic' with 'Shechtman'", "worldbridge_passthrough"),
    ("From what I understand, e=mc² is einstein's equation", "pass_through_natural"),
    ("gravity curves spacetime general relativity Einstein metric tensor geodesic confirmed", "confirmed_pattern"),
    ("Higgs boson discovered LHC CERN 2012 confirmed standard model particle physics real", "confirmed_pattern"),
    ("standard model particles quarks leptons bosons confirmed experimental particle physics", "confirmed_experiment"),
    ("Fibonacci sequence golden ratio phyllotaxis sunflower spiral botanical observation documented real", "confirmed_observation"),
]

verb_markers = [" is ", " are ", " was ", " were ", " has ", " have ",
                " shows ", " means ", " confirms ", " describes ", " proves ",
                " needs ", " requires ", " earned ", " discovered ", " appears "]

for text, expected in test_cases:
    lower = text.lower()
    
    if not text:
        result = "empty_passthrough"
    elif any(v in lower for v in verb_markers) or \
         ". " in text or \
         text.startswith("The ") or text.startswith("In ") or \
         text.startswith("I ") or text.startswith("E=") or \
         text.startswith("A ") or text.startswith("An "):
        result = "pass_through_natural"
    elif text.startswith("the concept of".lower()) or "connects '" in lower or text.lower().startswith("the concept of"):
        result = "worldbridge_passthrough"
    elif "[FID:" in text:
        result = "fid_passthrough"
    elif "disproven" in lower or "does not exist" in lower or "null result" in lower:
        result = "disproven_pattern"
    elif "nobel prize" in lower:
        result = "nobel_pattern"
    elif "confirmed" in lower and ("experiment" in lower or "observation" in lower):
        result = "confirmed_experiment"
    else:
        result = "generic_fallback"
    
    status = "✓" if result == expected or expected in result or result in expected else "?"
    print(f"{status} [{result:30s}] {text[:70]}")
```

**Note every case that hits `generic_fallback` or has unexpected behavior. These represent NLS gaps.**

### 1.5 — Physics Core Cell Text Verification

Read the current `run_train_truths()` function and extract all 21 cell texts:

```bash
python3 << 'EOF'
with open('/sessions/eloquent-bold-newton/mnt/KAI/src/main.rs', 'r', errors='replace') as f:
    content = f.read()

# Find the truths array
start = content.find('let truths: &[(&str, &str)] = &[')
end = content.find('];', start) + 2
truths_block = content[start:end]
print(truths_block)

# Count cells
count = truths_block.count('("')
print(f"\nTotal cell texts: {count}")

# Check each text for natural language markers
import re
cells = re.findall(r'\("([^"]+)", "([^"]+)"\)', truths_block)
print(f"\nParsed {len(cells)} cells:")
verb_markers = [" is ", " are ", " was ", " were ", " has ", " have ",
                " shows ", " means ", " confirms ", " describes ", " proves ",
                " needs ", " requires ", " earned ", " discovered ", " appears "]
for i, (text, region) in enumerate(cells):
    has_verbs = any(v in text for v in verb_markers)
    has_period = text.endswith('.')
    natural = has_verbs or text.startswith("The ") or text.startswith("E=") or text.startswith("A ")
    print(f"  [{i+1:2d}] {'✓NL' if natural else '✗KW'} [{region:20s}] {text[:80]}")
EOF
```

**PASS criteria:** All 21 cells should be natural language (NL). Any keyword-format (KW) cells are a finding.

### 1.6 — FID Gate Threshold Analysis

Find and analyze the FID gate thresholds in main.rs:

```bash
grep -n "0\.15\|0\.25\|FID\|fid_note\|fid_warning\|low resonance\|speculative" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | head -40
```

For each threshold found, evaluate:
- Is the confidence threshold (0.15) appropriate? Too high = too many warnings. Too low = misses real speculation.
- Is the resonance threshold (0.25) appropriate?
- Are there cases where both thresholds would pass but the answer is still wrong?
- Recommendation for threshold values.

### 1.7 — Calibration Algorithm Analysis

Read the full `run_calibration()` function:

```bash
python3 << 'EOF'
with open('/sessions/eloquent-bold-newton/mnt/KAI/src/main.rs', 'r', errors='replace') as f:
    content = f.read()

start = content.find('fn run_calibration(')
# Find brace depth
depth = 0
in_fn = False
for i, ch in enumerate(content[start:], start):
    if ch == '{':
        depth += 1
        in_fn = True
    elif ch == '}':
        depth -= 1
        if in_fn and depth == 0:
            end = i + 1
            break

print(content[start:end])
EOF
```

Analyze:
- How many base anchors? (should be 10)
- How many truth anchors? (should be 6 + 10 original)
- What is the adaptive threshold formula? (should be `max_false_phi_c * 0.70`)
- What strength values are used for truth vs false anchors?
- Is the calibration score truly measuring what it claims?

### 1.8 — Dream Pruning Safety Analysis

Find the dream pruning code and analyze:

```bash
grep -n "dream\|pruning\|prune\|strength\|3\.0\|physics-core" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | head -50
```

Verify:
- Physics-core cells have strength=3.0 (should survive pruning)
- What is the pruning threshold? (the minimum strength to survive)
- Are there any conditions where strength=3.0 cells could still be pruned?
- How many cells are pruned per dream cycle on average?

### 1.9 — VSA/HDC Dimensionality and Encoding Analysis

Read the core VSA implementation:

```bash
grep -n "16384\|16_384\|dim\|dimension\|sparse\|ternary\|encode\|SparseVec" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | head -30
grep -rn "16384\|16_384\|dim\|SparseVec" /sessions/eloquent-bold-newton/mnt/KAI/src/ | grep -v "target" | head -40
```

Analyze:
- What is the vector dimensionality? (expected: 16,384)
- Are vectors truly sparse? What is the expected density?
- How does the encoding function work? (character n-gram? word hash? positional?)
- Is the encoding deterministic? (same input always same output)
- What is the cosine similarity computation doing?

### 1.10 — Memory Region Analysis

List all memory regions in use:

```bash
python3 << 'EOF'
with open('/sessions/eloquent-bold-newton/mnt/KAI/src/main.rs', 'r', errors='replace') as f:
    content = f.read()

import re
# Find all region strings
regions = re.findall(r'"([a-z][a-z0-9_-]+)".*source', content)
# Also from status output regions
known_regions = set([
    "hlv-theory", "state", "synthesis", "fibonacci-nature", "action", "reasoning",
    "memory", "hlv-bridge", "standard-model", "language", "disproven", "quantum-mechanics",
    "quasicrystals", "mass-energy", "gr-spacetime", "physics-core", "empathy", "ryan",
    "conversation", "identity", "emotion", "world-bridge", "dream-discovery"
])

print("Expected regions:")
for r in sorted(known_regions):
    present = f'"{r}"' in content
    print(f"  {'✓' if present else '?'} {r}")
EOF
```

For each region, describe its purpose and whether it has appropriate content.

### 1.11 — Error Handling Completeness

Check for potential panic! and unwrap() calls:

```bash
grep -n "unwrap()\|panic!\|expect(" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | wc -l
grep -n "unwrap()\|panic!\|expect(" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | head -30
```

For each unwrap/panic found:
- Is it in a recoverable path? (User-facing logic should not panic)
- Is it protected by a prior check?
- Should it be replaced with proper error handling?
- Rate the risk: LOW / MEDIUM / HIGH / CRITICAL

### 1.12 — Concurrency and Thread Safety

Identify all threading code:

```bash
grep -n "thread::\|Arc<\|Mutex\|RwLock\|channel\|mpsc\|rayon\|par_iter" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | head -40
grep -rn "thread::\|Arc<\|Mutex\|rayon\|par_iter" /sessions/eloquent-bold-newton/mnt/KAI/src/ | grep -v target | head -40
```

Analyze:
- Where is rayon used? (expected: FieldState::compute())
- Are there any shared mutable state hazards?
- Is the dream cycle thread properly isolated?
- Could any of the parallel operations cause data races?

### 1.13 — Code Duplication Detection

Look for patterns that repeat more than 3 times and suggest refactoring:

```bash
python3 << 'EOF'
with open('/sessions/eloquent-bold-newton/mnt/KAI/src/main.rs', 'r', errors='replace') as f:
    lines = f.readlines()

# Find repeated blocks of 5+ lines
from collections import Counter
chunks = []
window = 5
for i in range(len(lines) - window):
    chunk = ''.join(lines[i:i+window]).strip()
    if len(chunk) > 100:  # Only meaningful chunks
        chunks.append(chunk)

counts = Counter(chunks)
for chunk, count in counts.most_common(10):
    if count > 2:
        print(f"Repeated {count}x:")
        print(chunk[:200])
        print("---")
EOF
```

### 1.14 — TODO/FIXME/HACK Comment Audit

Find all technical debt markers:

```bash
grep -n "TODO\|FIXME\|HACK\|XXX\|BUG\|TEMP\|todo!\|fixme" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs
grep -rn "TODO\|FIXME\|HACK\|XXX" /sessions/eloquent-bold-newton/mnt/KAI/src/ | grep -v target
```

Categorize each by: urgency, estimated effort, impact on functionality.

### 1.15 — Dead Code Detection

Look for unused functions, unreachable code:

```bash
cargo check 2>&1 | grep "unused\|dead_code\|never used\|unreachable"
grep -n "#\[allow(dead_code)\]\|#\[allow(unused" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs
```

---

## SECTION 2 — CLI FLAG TESTS [RUN SEQUENTIALLY]

These tests actually execute KAI's CLI modes. Run them in sequence.

### 2.1 — --calibrate Test (FULL RUN)

Run the calibration suite and capture every line of output:

```bash
cd /sessions/eloquent-bold-newton/mnt/KAI && cargo run --release -- --calibrate 2>&1 | tee /tmp/kai_calibrate_output.txt
```

From the output, extract and verify:
- What is the adaptive threshold value? (phi_truth_threshold)
- How many base anchors passed? Failed?
- How many truth anchors passed? Failed?
- What is the calibration SCORE out of 10?
- Are any TRUE claims scoring as DISSONANCE? (false negatives — bad)
- Are any FALSE claims scoring as RESONANCE? (false positives — catastrophic)
- Is E=mc² scoring as RESONANCE?
- Is "luminiferous ether" scoring correctly?
- What is the chi (χ) value at calibration time?

**PASS criteria:** 10/10 calibration, zero false positives.
**FAIL criteria:** Any false positive (false claim marked as resonant), or score < 8/10.

### 2.2 — --fid-audit Test (FULL RUN)

Run the FID audit and capture output:

```bash
cd /sessions/eloquent-bold-newton/mnt/KAI && cargo run --release -- --fid-audit 2>&1 | tee /tmp/kai_fid_output.txt
```

Extract:
- Total cells audited
- Number flagged
- Percentage flagged
- Which sources have the most flagged cells?
- Which regions are entirely flagged (e.g., world-bridge 100%)?
- Are any physics-core cells flagged? (they should NOT be — strength=3.0 and source="physics-core")
- What is the convergence_score threshold for flagging?
- Are the audit results written to `data/fid_audit.json`?

**PASS criteria:** Physics-core cells NOT flagged, flagging rate 10-20% (represents appropriate skepticism).
**CONCERN criteria:** Flagging rate > 40% (too aggressive) or < 5% (too permissive).
**CRITICAL FAIL:** Any physics-core cell flagged.

### 2.3 — --train-truths Test (FULL RUN)

Run train-truths and capture output:

```bash
cd /sessions/eloquent-bold-newton/mnt/KAI && cargo run --release -- --train-truths 2>&1 | tee /tmp/kai_train_output.txt
```

Extract:
- How many cells before training?
- How many stored/reinforced?
- How many NEW cells added vs. reinforced?
- Was save successful? How many bytes? How many cells in saved state?
- Are physics-core cells now at strength=3.0?

**Then verify the state file:**

```bash
python3 << 'EOF'
import json, os

state_file = '/sessions/eloquent-bold-newton/mnt/KAI/data/kai-state.json'
if not os.path.exists(state_file):
    print("CRITICAL: kai-state.json does not exist!")
    exit()

with open(state_file, 'r') as f:
    state = json.load(f)

print(f"State file size: {os.path.getsize(state_file):,} bytes")
print(f"State file keys: {list(state.keys())}")

# Try to find cells array
if 'cells' in state:
    cells = state['cells']
elif 'universe' in state and 'cells' in state['universe']:
    cells = state['universe']['cells']
else:
    print(f"State structure: {json.dumps(state, default=str)[:500]}")
    cells = []

print(f"Total cells: {len(cells)}")

if cells:
    # Find physics-core cells
    pc_cells = [c for c in cells if isinstance(c, dict) and c.get('source') == 'physics-core']
    print(f"\nPhysics-core cells: {len(pc_cells)}")
    
    for cell in pc_cells:
        text = cell.get('text', cell.get('content', ''))[:80]
        strength = cell.get('strength', cell.get('weight', 'unknown'))
        region = cell.get('region', 'unknown')
        print(f"  [str={strength}] [{region}] {text}")
    
    # Strength analysis
    strengths = [c.get('strength', c.get('weight', 0)) for c in cells if isinstance(c, dict)]
    if strengths:
        import statistics
        print(f"\nStrength statistics:")
        print(f"  Min: {min(strengths):.3f}")
        print(f"  Max: {max(strengths):.3f}")
        print(f"  Mean: {statistics.mean(strengths):.3f}")
        print(f"  Median: {statistics.median(strengths):.3f}")
        print(f"  Cells with strength >= 3.0: {sum(1 for s in strengths if s >= 3.0)}")
        print(f"  Cells with strength < 0.5: {sum(1 for s in strengths if s < 0.5)}")

    # Region distribution
    from collections import Counter
    regions = Counter(c.get('region', 'unknown') for c in cells if isinstance(c, dict))
    print(f"\nRegion distribution:")
    for region, count in sorted(regions.items(), key=lambda x: -x[1]):
        print(f"  {region:30s}: {count:5d} cells")
    
    # Source distribution
    sources = Counter(c.get('source', 'unknown') for c in cells if isinstance(c, dict))
    print(f"\nSource distribution:")
    for source, count in sorted(sources.items(), key=lambda x: -x[1]):
        print(f"  {source:30s}: {count:5d} cells")
EOF
```

**PASS criteria:** 21 physics-core cells present, all at strength=3.0, all with natural language text.

---

## SECTION 3 — STATE FILE DEEP ANALYSIS [PARALLEL GROUP B]

Perform comprehensive analysis of the kai-state.json file. Run all sub-tests in parallel.

### 3.1 — Cell Text Quality Audit

Sample cells from each region and analyze text quality:

```bash
python3 << 'EOF'
import json, os, random, re

state_file = '/sessions/eloquent-bold-newton/mnt/KAI/data/kai-state.json'
if not os.path.exists(state_file):
    print("No state file found")
    exit()

with open(state_file, 'r') as f:
    state = json.load(f)

# Try to get cells
def get_cells(state):
    if 'cells' in state:
        return state['cells']
    elif 'universe' in state:
        u = state['universe']
        if 'cells' in u:
            return u['cells']
    # Try flat list
    if isinstance(state, list):
        return state
    return []

cells = get_cells(state)
if not cells:
    print(f"Could not find cells. State keys: {list(state.keys())}")
    exit()

# Group by region
from collections import defaultdict
by_region = defaultdict(list)
for cell in cells:
    if isinstance(cell, dict):
        region = cell.get('region', 'unknown')
        by_region[region].append(cell)

verb_markers = [" is ", " are ", " was ", " were ", " has ", " have ",
                " shows ", " means ", " confirms ", " describes ", " proves ",
                " needs ", " requires ", " earned ", " discovered ", " appears "]

print("=== Cell Text Quality by Region ===\n")
total_natural = 0
total_keyword = 0
total_cells = 0

for region in sorted(by_region.keys()):
    region_cells = by_region[region]
    sample = random.sample(region_cells, min(3, len(region_cells)))
    natural_count = 0
    
    for cell in region_cells:
        text = cell.get('text', cell.get('content', ''))
        lower = text.lower()
        is_natural = (any(v in lower for v in verb_markers) or 
                     ". " in text or
                     text.startswith("The ") or text.startswith("A ") or
                     text.startswith("E="))
        if is_natural:
            natural_count += 1
            total_natural += 1
        else:
            total_keyword += 1
        total_cells += 1
    
    pct = natural_count / len(region_cells) * 100 if region_cells else 0
    print(f"\n[{region}] {len(region_cells)} cells | {natural_count}/{len(region_cells)} natural ({pct:.0f}%)")
    
    for cell in sample:
        text = cell.get('text', cell.get('content', ''))[:100]
        strength = cell.get('strength', '?')
        source = cell.get('source', '?')
        print(f"  str={strength} src={source}: {text}")

print(f"\n=== TOTALS ===")
print(f"Total cells analyzed: {total_cells}")
print(f"Natural language: {total_natural} ({total_natural/total_cells*100:.1f}%)")
print(f"Keyword format:   {total_keyword} ({total_keyword/total_cells*100:.1f}%)")
EOF
```

### 3.2 — Duplicate Cell Detection

Check for duplicate or near-duplicate cells:

```bash
python3 << 'EOF'
import json, os
from collections import Counter

state_file = '/sessions/eloquent-bold-newton/mnt/KAI/data/kai-state.json'
if not os.path.exists(state_file):
    print("No state file")
    exit()

with open(state_file, 'r') as f:
    state = json.load(f)

def get_cells(state):
    if 'cells' in state:
        return state['cells']
    elif 'universe' in state and 'cells' in state['universe']:
        return state['universe']['cells']
    return []

cells = get_cells(state)
texts = [c.get('text', c.get('content', ''))[:100] for c in cells if isinstance(c, dict)]
counts = Counter(texts)

exact_dups = {t: c for t, c in counts.items() if c > 1}
if exact_dups:
    print(f"EXACT DUPLICATES FOUND: {len(exact_dups)}")
    for text, count in exact_dups.items():
        print(f"  [{count}x] {text[:80]}")
else:
    print("No exact duplicate cell texts found")

# Near-duplicate check (first 50 chars)
short_texts = [c.get('text', c.get('content', ''))[:50] for c in cells if isinstance(c, dict)]
short_counts = Counter(short_texts)
near_dups = {t: c for t, c in short_counts.items() if c > 1 and len(t) > 10}
if near_dups:
    print(f"\nPOTENTIAL NEAR-DUPLICATES (first 50 chars): {len(near_dups)}")
    for text, count in list(near_dups.items())[:10]:
        print(f"  [{count}x] {text}")
EOF
```

### 3.3 — Strength Distribution Detailed Analysis

```bash
python3 << 'EOF'
import json, os

state_file = '/sessions/eloquent-bold-newton/mnt/KAI/data/kai-state.json'
if not os.path.exists(state_file):
    print("No state file")
    exit()

with open(state_file, 'r') as f:
    state = json.load(f)

def get_cells(state):
    if 'cells' in state:
        return state['cells']
    elif 'universe' in state and 'cells' in state['universe']:
        return state['universe']['cells']
    return []

cells = get_cells(state)
strengths = []
for c in cells:
    if isinstance(c, dict):
        s = c.get('strength', c.get('weight'))
        if s is not None:
            try:
                strengths.append(float(s))
            except:
                pass

if not strengths:
    print("No strength values found")
    exit()

# Build histogram
buckets = {
    "0.0-0.1": 0, "0.1-0.5": 0, "0.5-1.0": 0, "1.0-1.5": 0,
    "1.5-2.0": 0, "2.0-2.5": 0, "2.5-3.0": 0, "3.0+": 0
}
for s in strengths:
    if s < 0.1: buckets["0.0-0.1"] += 1
    elif s < 0.5: buckets["0.1-0.5"] += 1
    elif s < 1.0: buckets["0.5-1.0"] += 1
    elif s < 1.5: buckets["1.0-1.5"] += 1
    elif s < 2.0: buckets["1.5-2.0"] += 1
    elif s < 2.5: buckets["2.0-2.5"] += 1
    elif s < 3.0: buckets["2.5-3.0"] += 1
    else: buckets["3.0+"] += 1

print("Strength distribution histogram:")
max_count = max(buckets.values()) or 1
for bucket, count in buckets.items():
    bar = "█" * int(count / max_count * 40)
    print(f"  {bucket:12s} | {bar:40s} | {count:5d} cells")

print(f"\nMin:    {min(strengths):.4f}")
print(f"Max:    {max(strengths):.4f}")
print(f"Mean:   {sum(strengths)/len(strengths):.4f}")
sorted_s = sorted(strengths)
mid = len(sorted_s) // 2
print(f"Median: {sorted_s[mid]:.4f}")
print(f"Total:  {len(strengths)} cells")

# Concern: cells near 0 may be zombie cells
zombie_risk = sum(1 for s in strengths if s < 0.1)
print(f"\nZombie-risk cells (strength < 0.1): {zombie_risk}")
print(f"These should be pruned by dream cycles")
EOF
```

### 3.4 — State File Growth Rate Analysis

Analyze the state file size and project growth:

```bash
python3 << 'EOF'
import json, os, datetime

state_file = '/sessions/eloquent-bold-newton/mnt/KAI/data/kai-state.json'
if not os.path.exists(state_file):
    print("No state file")
    exit()

size_bytes = os.path.getsize(state_file)
size_mb = size_bytes / (1024 * 1024)
mtime = datetime.datetime.fromtimestamp(os.path.getmtime(state_file))

print(f"State file size: {size_bytes:,} bytes ({size_mb:.2f} MB)")
print(f"Last modified: {mtime}")

with open(state_file, 'r') as f:
    state = json.load(f)

def get_cells(state):
    if 'cells' in state:
        return state['cells']
    elif 'universe' in state and 'cells' in state['universe']:
        return state['universe']['cells']
    return []

cells = get_cells(state)
cell_count = len(cells)
bytes_per_cell = size_bytes / cell_count if cell_count else 0

print(f"Cell count: {cell_count}")
print(f"Avg bytes per cell: {bytes_per_cell:.0f}")

# Project growth
print("\nGrowth projections:")
for future_cells in [5000, 10000, 25000, 50000, 100000]:
    projected_mb = (future_cells * bytes_per_cell) / (1024 * 1024)
    print(f"  At {future_cells:,} cells: ~{projected_mb:.1f} MB")

# Estimated growth rate based on tick count
if 'tick' in state:
    tick = state['tick']
    print(f"\nCurrent tick: {tick}")
    if tick > 0:
        cells_per_tick = cell_count / tick
        print(f"Cells per tick (approx): {cells_per_tick:.4f}")
        ticks_to_50k = (50000 - cell_count) / cells_per_tick if cells_per_tick > 0 else float('inf')
        print(f"Ticks to reach 50k cells: {ticks_to_50k:.0f}")
EOF
```

### 3.5 — Dream Cycle Effectiveness

Analyze whether dream pruning is keeping the state healthy:

```bash
python3 << 'EOF'
import json, os

state_file = '/sessions/eloquent-bold-newton/mnt/KAI/data/kai-state.json'
if not os.path.exists(state_file):
    exit()

with open(state_file, 'r') as f:
    state = json.load(f)

dream_count = state.get('dream_count', state.get('dreams', 'unknown'))
print(f"Dream cycles completed: {dream_count}")

def get_cells(state):
    if 'cells' in state:
        return state['cells']
    elif 'universe' in state and 'cells' in state['universe']:
        return state['universe']['cells']
    return []

cells = get_cells(state)
cell_count = len(cells)
print(f"Current cell count: {cell_count}")

if isinstance(dream_count, int) and dream_count > 0:
    # From user's status: 636 dreams, 2367 cells at one point, 640 dreams, 2416 cells now
    cells_per_dream = cell_count / dream_count
    print(f"Cells per dream (net): {cells_per_dream:.2f}")
    
    # At this rate, when would state become unmanageable?
    if cells_per_dream > 0:
        dreams_to_100k = (100000 - cell_count) / cells_per_dream
        print(f"Dreams until 100k cells: {dreams_to_100k:.0f}")
        print("NOTE: If dream pruning is working, this number should be very large")
        print("      or cells_per_dream should be near 0 or negative")

# What's the lowest-strength cell? (shouldn't exist if pruning is aggressive)
if cells:
    strengths = [(c.get('strength', 1.0), c.get('text', '')[:50]) for c in cells if isinstance(c, dict)]
    sorted_by_strength = sorted(strengths)
    print(f"\nLowest-strength cells (should be pruned if below threshold):")
    for s, t in sorted_by_strength[:10]:
        print(f"  str={s:.4f}: {t}")
EOF
```

---

## SECTION 4 — ALGORITHM ANALYSIS [PARALLEL GROUP C]

Deep analysis of the core algorithms. Run all in parallel.

### 4.1 — VSA Cosine Similarity Implementation Audit

Find and analyze the cosine similarity function:

```bash
grep -n "cosine\|dot_product\|similarity\|score" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | head -20
find /sessions/eloquent-bold-newton/mnt/KAI/src -name "*.rs" | xargs grep -l "cosine\|similarity" | grep -v target
```

For the similarity function, verify:
- Is it normalized correctly? (division by vector magnitudes)
- What is the range of output values? (should be -1 to 1 for cosine, 0 to 1 after clamping)
- Is there any numerical stability protection? (avoid division by zero)
- What is the computational complexity? O(n) where n = dimensionality?

### 4.2 — Predictive Query Algorithm Analysis

Find `predictive_query` and analyze:

```bash
grep -n "predictive_query\|DEFAULT_ITER_STEPS\|iter_steps" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | head -20
find /sessions/eloquent-bold-newton/mnt/KAI/src -name "*.rs" | xargs grep -ln "predictive_query" | grep -v target
```

For the predictive query:
- How many iteration steps? (DEFAULT_ITER_STEPS)
- What is the convergence criterion?
- Is there a circuit breaker if it doesn't converge?
- What happens with 2416 cells and N iterations? What's the computational cost?

### 4.3 — FieldState Compute Analysis

Find `FieldState::compute()` and analyze:

```bash
grep -n "FieldState\|phi_g\|phi_c\|chi\|field_state\|Phi\|heartbeat" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | head -30
```

Analyze:
- How many cells are sampled? (expected: 50)
- Is it truly parallel (rayon)?
- How often does it run? (every heartbeat at 5 seconds?)
- What do Φg, Φc, and χ actually measure geometrically?
- Is the chi > 0.85 threshold for ACC (retrieval inhibition) appropriate?

### 4.4 — store_or_reinforce Logic Analysis

Find `store_or_reinforce` and verify its behavior:

```bash
grep -n "store_or_reinforce\|fn store\|fn reinforce" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | head -10
find /sessions/eloquent-bold-newton/mnt/KAI/src -name "*.rs" | xargs grep -ln "store_or_reinforce" | grep -v target
```

Verify:
- What is the similarity threshold for "same cell" detection? (e.g., cosine > 0.9?)
- If a cell is reinforced, how does its strength change? (additive? multiplicative? capped?)
- Could physics-core cells be inadvertently weakened by reinforce?
- How does the function handle the case where the universe is at capacity?

### 4.5 — Retrieval Ranking Analysis

How are results ranked and how is the final answer chosen?

```bash
grep -n "sort\|ranking\|order_by\|hits\|top_k\|threshold\|RESONANCE_THRESHOLD" /sessions/eloquent-bold-newton/mnt/KAI/src/cognition/voice.rs | head -30
```

Analyze:
- Is retrieval by cosine similarity only, or also by strength?
- Does source matter in ranking? (physics-core should rank above dream-discovery)
- What is RESONANCE_THRESHOLD (0.45)? How was this value chosen?
- Is there any recency bias? (recent cells ranked higher?)
- Are there any anti-repetition mechanisms? (avoid returning same cell twice)

### 4.6 — encode() Function Experimental Tests

Write a Python simulation of the VSA encoding to understand its properties:

```bash
python3 << 'EOF'
# Simulate character-level sparse ternary encoding
# This is a simplified model — actual encoding may differ
# Goal: understand how similar queries map to similar vectors

import hashlib
import random
random.seed(42)

DIM = 16384

def simple_hash_encode(text, dim=DIM):
    """Simulate sparse ternary VSA encoding"""
    vector = [0] * dim
    words = text.lower().split()
    for word in words:
        for i in range(3):  # multiple projections per word
            h = int(hashlib.md5(f"{word}_{i}".encode()).hexdigest(), 16)
            idx = h % dim
            sign = 1 if (h >> 16) & 1 else -1
            vector[idx] = sign
    return vector

def cosine_sim(a, b):
    dot = sum(x*y for x,y in zip(a,b))
    mag_a = sum(x*x for x in a) ** 0.5
    mag_b = sum(x*x for x in b) ** 0.5
    if mag_a == 0 or mag_b == 0:
        return 0
    return dot / (mag_a * mag_b)

# Test semantic similarity preservation
test_pairs = [
    ("E=mc² energy mass equivalence", "E equals mc squared energy mass"),
    ("What is E equals mc squared", "E=mc² is Einstein's equation"),
    ("luminiferous ether disproven", "ether was shown not to exist"),
    ("quasicrystals aperiodic Dan Shechtman Nobel Prize", "quasicrystal icosahedral symmetry Shechtman"),
    ("gravity curves spacetime general relativity", "spacetime curvature Einstein"),
    ("completely unrelated topic astronomy", "E=mc² energy mass equivalence"),
    ("quantum mechanics electron probability cloud", "atomic orbitals electron shells quantum"),
]

print("Simulated VSA Cosine Similarity (simplified model):\n")
for q1, q2 in test_pairs:
    v1 = simple_hash_encode(q1)
    v2 = simple_hash_encode(q2)
    sim = cosine_sim(v1, v2)
    print(f"  {sim:.4f}  '{q1[:40]}' vs '{q2[:40]}'")

print("\nNote: actual KAI encoding will differ but semantic properties should be similar")
print("HIGH similarity (>0.3) for related concepts = good encoding")
print("LOW similarity (<0.1) for unrelated = good discrimination")
EOF
```

---

## SECTION 5 — PERFORMANCE ANALYSIS [PARALLEL GROUP D]

Measure and analyze performance characteristics.

### 5.1 — Build Time Benchmark

```bash
cd /sessions/eloquent-bold-newton/mnt/KAI && time cargo build --release 2>&1 | tail -5
```

Record: total build time. Is it within acceptable range? (< 3 minutes for full rebuild acceptable)

### 5.2 — Binary Size Analysis

```bash
ls -lah /sessions/eloquent-bold-newton/mnt/KAI/target/release/kai* 2>/dev/null || \
ls -lah /sessions/eloquent-bold-newton/mnt/KAI/target/release/ 2>/dev/null | head -20
```

Record binary size. Analyze if LTO (Link Time Optimization) is enabled in Cargo.toml.

### 5.3 — Algorithmic Complexity Analysis

For each major operation, estimate Big-O complexity:

```bash
python3 << 'EOF'
# Analyze complexity based on code inspection
operations = {
    "VSA encode(text)": {
        "complexity": "O(W * P)",
        "W": "words in text",
        "P": "projections per word (~3)",
        "note": "Should be O(words) effectively"
    },
    "cosine_similarity(a, b)": {
        "complexity": "O(D)",
        "D": "vector dimensionality (16,384)",
        "note": "With sparse vectors, actual cost is O(nonzero elements)"
    },
    "retrieve_top_k(query, universe, k)": {
        "complexity": "O(N * D)",
        "N": "cells in universe (~2416)",
        "D": "dimensionality (16,384)",
        "note": "2416 * 16384 = 39.6M operations per query — EXPENSIVE"
    },
    "predictive_query(query, steps)": {
        "complexity": "O(N * D * steps)",
        "N": "cells (~2416)",
        "D": "dimensionality (16,384)",
        "steps": "DEFAULT_ITER_STEPS (unknown, needs verification)",
        "note": "Could be very expensive if steps > 1"
    },
    "FieldState::compute(sample=50)": {
        "complexity": "O(50 * D)",
        "D": "dimensionality (16,384)",
        "note": "50 cells sampled, parallel with rayon — should be fast"
    },
    "dream_prune(universe)": {
        "complexity": "O(N)",
        "N": "cells (~2416)",
        "note": "Linear scan of all cells — acceptable"
    }
}

print("=== Algorithmic Complexity Analysis ===\n")
for op, info in operations.items():
    print(f"Operation: {op}")
    print(f"  Complexity: {info['complexity']}")
    for k, v in info.items():
        if k not in ('complexity', 'note'):
            print(f"  {k} = {v}")
    print(f"  Note: {info.get('note', '')}")
    print()

print("=== ESTIMATED COST OF SINGLE QUERY ===")
N = 2416
D = 16384
print(f"N (cells) = {N}")
print(f"D (dims)  = {D}")
print(f"N * D     = {N * D:,} float multiply-adds")
print(f"At 1GFlop/s: {N * D / 1e9:.3f} seconds")
print(f"At 10GFlop/s: {N * D / 1e10:.3f} seconds")
print(f"NOTE: With sparse ternary ({'{-1,0,+1}'}), many multiplies are free")
print(f"Effective ops may be 10-50x fewer depending on density")
EOF
```

### 5.4 — Memory Usage Estimation

```bash
python3 << 'EOF'
N = 2416  # cells
D = 16384  # dimensions

# VSA vector memory
bits_per_dim = 2  # ternary {-1,0,+1} needs 2 bits
vector_bytes = D * bits_per_dim / 8
total_vector_mb = N * vector_bytes / (1024*1024)

print("=== Memory Estimation ===")
print(f"Cells: {N}")
print(f"Dimensions: {D}")
print(f"Bytes per vector (2-bit ternary): {vector_bytes:.0f}")
print(f"Total vector memory: {total_vector_mb:.2f} MB")

# Text memory
avg_text_bytes = 150  # estimate
total_text_mb = N * avg_text_bytes / (1024*1024)
print(f"Avg text bytes per cell: {avg_text_bytes}")
print(f"Total text memory: {total_text_mb:.2f} MB")

# Metadata per cell
metadata_bytes = 100  # source, region, strength, etc.
total_meta_mb = N * metadata_bytes / (1024*1024)
print(f"Total metadata memory: {total_meta_mb:.2f} MB")

total_mb = total_vector_mb + total_text_mb + total_meta_mb
print(f"\nEstimated total RAM: {total_mb:.2f} MB")
print(f"At 10k cells: {total_mb * 10000/N:.1f} MB")
print(f"At 50k cells: {total_mb * 50000/N:.1f} MB")
EOF
```

### 5.5 — Response Time Bottleneck Analysis

The user reports ~4682ms response time. Analyze what's causing it:

```bash
python3 << 'EOF'
# Break down the 4682ms into estimated component costs
print("=== Response Time Breakdown Analysis ===")
print("Observed: ~4682ms per response\n")

components = [
    ("Input encoding", "~1ms", "SparseVec::encode() — fast, O(words)"),
    ("Predictive query retrieval", "~50-500ms", "O(N*D*steps) — main suspect"),
    ("FieldState::compute()", "~10-50ms", "50-cell rayon sample — moderate"),
    ("Voice synthesis", "~5-50ms", "Pattern matching on retrieved text — fast"),
    ("synthesize_to_speech()", "~0.1ms", "Pattern matching — trivial"),
    ("FID gate check", "~0.1ms", "Threshold comparison — trivial"),
    ("Transcript append + UI push", "~0.1ms", "Memory operation — trivial"),
    ("TUI redraw", "~5-20ms", "Terminal rendering — moderate"),
    ("World-bridge query?", "~50-200ms", "If world-bridge is queried per response"),
    ("Embedding operations?", "~100-1000ms", "If embedding happens synchronously"),
    ("State save frequency?", "~10-100ms", "If state is saved per response"),
]

print(f"{'Component':40s} {'Estimate':15s} {'Notes'}")
print("-" * 100)
for comp, estimate, notes in components:
    print(f"{comp:40s} {estimate:15s} {notes}")

print("\nACTION: Add timing instrumentation to process_input() to identify the actual bottleneck")
print("APPROACH: Wrap each major step in std::time::Instant::now() + .elapsed() and log to stderr")
print("\nSuspected primary bottleneck: predictive_query() across 2416 cells with multiple iteration steps")
EOF
```

---

## SECTION 6 — NLS (Natural Language Synthesis) EXPERIMENTS [PARALLEL GROUP E]

Test and analyze the NLS pipeline with various inputs. Create a test harness.

### 6.1 — NLS Function Complete Test Suite

```python
# Run this as: python3 /tmp/nls_test.py
test_code = '''
import subprocess, sys

# The synthesize_to_speech logic in Python (mirroring Rust exactly)
def synthesize_to_speech(raw, query):
    if not raw:
        return raw
    
    lower = raw.lower()
    
    verb_markers = [" is ", " are ", " was ", " were ", " has ", " have ",
                    " shows ", " means ", " confirms ", " describes ", " proves ",
                    " needs ", " requires ", " earned ", " discovered ", " appears "]
    
    looks_natural = (any(v in lower for v in verb_markers) or
                    ". " in raw or
                    raw.startswith("The ") or raw.startswith("In ") or
                    raw.startswith("I ") or raw.startswith("E=") or
                    raw.startswith("A ") or raw.startswith("An "))
    
    if looks_natural:
        return raw
    
    if lower.startswith("the concept of") or "connects '" in lower:
        return raw
    
    if "[FID:" in raw:
        return raw
    
    if "disproven" in lower or "does not exist" in lower or "null result" in lower:
        idx = lower.find("disproven")
        if idx >= 0:
            subject = raw[:idx].strip().rstrip("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
            subject = subject.strip()
            if subject:
                return f"The {subject} concept was experimentally disproven — the evidence shows it does not hold up."
        return f"That concept has been experimentally disproven. {raw}"
    
    if "nobel prize" in lower:
        return f"{raw.rstrip('.')}. This was confirmed to the level of earning a Nobel Prize."
    
    if "confirmed" in lower and ("experiment" in lower or "observation" in lower):
        return f"{raw.rstrip('.')}."
    
    return f"From what I understand: {raw.rstrip('.')}."

# === 100 TEST CASES ===
tests = [
    # (input, expected_type, description)
    # Category 1: Already natural language (should pass through)
    ("E=mc² is Einstein's equation from special relativity showing mass and energy are equivalent.", "passthrough", "NL cell: E=mc²"),
    ("The luminiferous ether does not exist — the Michelson-Morley experiment disproved it in 1887.", "passthrough", "NL cell: ether"),
    ("Quasicrystals are real — Dan Shechtman discovered aperiodic atomic order.", "passthrough", "NL cell: quasicrystals"),
    ("GPS satellites must apply corrections from both special and general relativity.", "passthrough", "NL cell: GPS relativity"),
    ("The Higgs boson was discovered at CERN in 2012, completing the Standard Model.", "passthrough", "NL cell: Higgs"),
    ("Gravitational waves were directly detected by LIGO in 2015.", "passthrough", "NL cell: LIGO"),
    ("The Fibonacci sequence appears throughout nature — sunflower spirals, pinecone scales.", "passthrough", "NL cell: Fibonacci"),
    ("Electrons occupy probability clouds called atomic orbitals rather than fixed orbits.", "passthrough", "NL cell: orbitals"),
    ("The geocentric model is wrong — Earth orbits the Sun.", "passthrough", "NL cell: geocentric"),
    ("Faster-than-light communication is impossible — special relativity's causality constraint.", "passthrough", "NL cell: FTL"),
    
    # Category 2: Voice-engine framed text (should pass through)
    ("From what I understand, e=mc² is einstein's equation.", "passthrough", "Voice-framed NL"),
    ("I recall that quasicrystals are real.", "passthrough", "I-recall framing"),
    ("There's the idea that gravity curves spacetime.", "passthrough", "There's the idea framing"),
    ("It seems that the Higgs boson confirms the standard model.", "passthrough", "It seems framing"),
    ("In physics, the standard model describes quarks and leptons.", "passthrough", "In physics opener"),
    
    # Category 3: FID warnings (should pass through)
    ("Some claim about SUSY.\n\n⚠ [FID: low resonance — speculative territory]", "passthrough", "FID-tagged text"),
    ("My lattice isn't resolving that clearly.\n\n⚠ [FID: retrieval inhibited]", "passthrough", "Inhibited FID text"),
    
    # Category 4: World-bridge text (should pass through)
    ("The concept of crystal, diffraction, and lattice connects 'Shechtman' with 'quasicrystal'.", "passthrough", "World-bridge text"),
    
    # Category 5: Old keyword cells - disproven pattern
    ("luminiferous ether disproven Michelson Morley experiment 1887 null result light medium does not exist", "disproven", "Old KW: ether"),
    ("geocentric model disproven Earth orbits Sun Copernicus Kepler Galileo confirmed heliocentric", "disproven", "Old KW: geocentric"),
    ("faster than light communication impossible special relativity causality confirmed physics", "generic", "Old KW: FTL (no disproven marker)"),
    
    # Category 6: Old keyword cells - Nobel pattern
    ("quasicrystals aperiodic order Dan Shechtman Nobel Prize 2011 forbidden symmetry real experimentally confirmed", "nobel", "Old KW: quasicrystals Nobel"),
    ("photoelectric effect Einstein photons quantum light energy confirmed Nobel Prize 1921", "nobel", "Old KW: photoelectric Nobel"),
    ("aperiodic order quasicrystals exist real Nobel Prize chemistry 2011 Shechtman", "nobel", "Old KW: aperiodic Nobel"),
    
    # Category 7: Old keyword cells - confirmed+experiment pattern
    ("standard model particles quarks leptons bosons confirmed experimental particle physics", "confirmed_exp", "Old KW: standard model exp"),
    ("quantum mechanics describes atomic molecular behavior confirmed experimental physics foundation", "confirmed_exp", "Old KW: QM exp"),
    ("atomic orbitals electron probability shells confirmed quantum mechanics chemistry foundation", "confirmed_exp", "Old KW: orbitals exp (no exp word)"),
    ("GPS satellites require general relativity time dilation correction confirmed engineering fact", "generic", "Old KW: GPS (no exp/obs)"),
    
    # Category 8: Old keyword cells - generic fallback
    ("E equals mc squared mass energy equivalence Einstein special relativity confirmed nuclear fission fusion", "generic", "Old KW: E=mc² generic"),
    ("mass and energy are interchangeable E equals mc squared nuclear physics confirmed fact", "passthrough", "Old KW: has 'are'"),
    ("gravity curves spacetime general relativity Einstein metric tensor geodesic confirmed", "generic", "Old KW: gravity generic"),
    ("Eddington 1919 solar eclipse light bending confirms general relativity spacetime curvature", "passthrough", "Old KW: has 'confirms'"),
    ("black hole event horizon EHT image 2019 confirms general relativity extreme gravity", "passthrough", "Old KW: has 'confirms'"),
    ("Fibonacci sequence golden ratio phyllotaxis sunflower spiral botanical observation documented real", "confirmed_exp", "Old KW: Fibonacci observation"),
    ("golden angle 137.5 degrees plant growth spiral Fibonacci nature documented botany real", "generic", "Old KW: golden angle generic"),
    
    # Category 9: Edge cases
    ("", "empty", "Empty string"),
    (".", "passthrough", "Just a period (has '. '? No. But...)"),
    ("a", "passthrough", "Single letter (starts with 'a'... no, lowercase)"),
    ("A quasicrystal defies crystallographic rules.", "passthrough", "Starts with A"),
    ("An aperiodic structure was discovered.", "passthrough", "Starts with An"),
    ("  E=mc² is real  ", "passthrough_or_generic", "Whitespace-padded"),
    ("GRAVITY CURVES SPACETIME GENERAL RELATIVITY CONFIRMED", "generic", "ALL CAPS keyword"),
    ("gravity curves spacetime\ngeneral relativity\nconfirmed", "passthrough", "Multiline with 'curves' (not a verb marker)"),
    
    # Category 10: Stress tests for verb marker detection
    ("spacetime curvature gravitational waves LIGO detection 2015 confirmed experimental proof", "confirmed_exp", "KW with experiment"),
    ("Shechtman quasicrystal diffraction icosahedral symmetry fivefold forbidden crystallography real confirmed", "generic", "KW Shechtman (no exp/Nobel)"),
    ("E mc2 energy mass conversion Einstein 1905 special relativity experimental verification", "confirmed_exp", "KW mc2 experimental"),
    ("Higgs boson discovered LHC CERN 2012 confirmed standard model particle physics real", "generic", "KW Higgs (discovered not a marker, no exp)"),
]

print(f"=== NLS Test Suite: {len(tests)} tests ===\\n")
passed = 0
failed = 0
uncertain = 0

for text, expected, desc in tests:
    result = synthesize_to_speech(text, "test query")
    
    # Determine actual category
    if result == text:
        actual = "passthrough"
    elif result.startswith("The ") and "disproven" in result:
        actual = "disproven"
    elif "Nobel Prize" in result:
        actual = "nobel"
    elif result.endswith(".") and result == text.rstrip(".") + ".":
        actual = "confirmed_exp"
    elif result.startswith("From what I understand:"):
        actual = "generic"
    elif not text:
        actual = "empty"
    else:
        actual = "unknown"
    
    match = expected in actual or actual in expected or expected == actual
    if expected == "passthrough_or_generic":
        match = actual in ("passthrough", "generic")
    
    symbol = "✓" if match else "✗"
    if match:
        passed += 1
    else:
        failed += 1
    
    if not match:
        print(f"{symbol} FAIL [{desc}]")
        print(f"     Expected: {expected}")
        print(f"     Got:      {actual}")
        print(f"     Input:    {text[:60]}")
        print(f"     Output:   {result[:80]}")
        print()

print(f"\\n=== RESULTS: {passed} passed, {failed} failed out of {len(tests)} tests ===")
print(f"NLS Accuracy: {passed/len(tests)*100:.1f}%")
'''

with open('/tmp/nls_test.py', 'w') as f:
    f.write(test_code)

import subprocess
result = subprocess.run(['python3', '/tmp/nls_test.py'], capture_output=True, text=True)
print(result.stdout)
if result.returncode != 0:
    print("STDERR:", result.stderr)
```

Write the full test to /tmp/nls_test.py and run it.

### 6.2 — synthesize_from_cells Interaction Analysis

The NLS function in main.rs receives text AFTER `synthesize_from_cells` in voice.rs has processed it.
This means the input to `synthesize_to_speech` is already partially processed. Analyze the full pipeline:

```bash
python3 << 'EOF'
# Model the full pipeline for a score < 0.60 response
test_inputs = [
    "E equals mc squared mass energy equivalence Einstein special relativity confirmed nuclear fission fusion",
    "quasicrystals aperiodic order Dan Shechtman Nobel Prize 2011 forbidden symmetry real experimentally confirmed",
    "luminiferous ether disproven Michelson Morley experiment 1887 null result light medium does not exist",
]

voice_frames = ["From what I understand,", "I recall that", "There's the idea that", "It seems that"]

print("=== Full Pipeline Simulation (voice.rs → main.rs NLS) ===\n")
print("For scores 0.45-0.60 (voice.rs adds a frame + lowercase + period):")
print()

verb_markers = [" is ", " are ", " was ", " were ", " has ", " have ",
                " shows ", " means ", " confirms ", " describes ", " proves ",
                " needs ", " requires ", " earned ", " discovered ", " appears "]

for cell_text in test_inputs:
    print(f"Cell: {cell_text[:70]}")
    
    for frame_idx, frame in enumerate(voice_frames):
        # voice.rs: lowercase_first(core) + frame
        first_char = cell_text[0].lower()
        voice_output = frame + " " + first_char + cell_text[1:] + "."
        
        # Now check looks_natural on voice_output
        lower = voice_output.lower()
        looks_natural = (any(v in lower for v in verb_markers) or
                        ". " in voice_output or
                        voice_output.startswith("The ") or voice_output.startswith("I ") or
                        voice_output.startswith("In "))
        
        fate = "PASS-THROUGH" if looks_natural else "WOULD TRANSFORM"
        print(f"  [{frame:30s}] → {fate} → {voice_output[:60]}")
    
    print()

print("For scores >= 0.60 (voice.rs outputs raw cell text + period):")
for cell_text in test_inputs:
    voice_output = cell_text + "."
    lower = voice_output.lower()
    looks_natural = (any(v in lower for v in verb_markers) or
                    ". " in voice_output)
    fate = "PASS-THROUGH" if looks_natural else "WOULD TRANSFORM"
    print(f"  [{fate}] {voice_output[:80]}")
EOF
```

### 6.3 — NLS Gap Analysis and Recommendations

Based on all NLS tests, compile a gap analysis:

For each gap found:
- What input triggers incorrect behavior?
- What is the expected output?
- What change to `synthesize_to_speech` would fix it?
- Priority: CRITICAL / HIGH / MEDIUM / LOW

---

## SECTION 7 — FID SYSTEM ANALYSIS [PARALLEL GROUP F]

### 7.1 — FID Threshold Calibration Experiment

```bash
python3 << 'EOF'
# Analyze what FID flagging looks like at different threshold settings
# Current thresholds: confidence < 0.15 AND resonance < 0.25

known_cases = [
    # (topic, expected_confidence_range, should_flag, description)
    ("E=mc²", (0.45, 0.75), False, "Established physics — should NOT flag"),
    ("quasicrystals Nobel Prize", (0.40, 0.70), False, "Established fact — should NOT flag"),
    ("luminiferous ether disproven", (0.40, 0.70), False, "Disproven but well-established — NOT flag"),
    ("supersymmetry dark matter", (0.10, 0.30), True, "Speculative — SHOULD flag"),
    ("string theory M-theory", (0.05, 0.20), True, "Highly speculative — SHOULD flag"),
    ("dark energy cosmological constant", (0.05, 0.25), True, "Unknown — SHOULD flag"),
    ("consciousness quantum mind", (0.02, 0.15), True, "Fringe — SHOULD flag"),
    ("Fibonacci nature golden ratio", (0.35, 0.65), False, "Documented — NOT flag"),
    ("general relativity GPS satellites", (0.40, 0.70), False, "Confirmed — NOT flag"),
    ("multiverse many worlds", (0.02, 0.15), True, "Speculative — SHOULD flag"),
]

current_conf_threshold = 0.15
current_res_threshold = 0.25

print("=== FID Threshold Analysis ===")
print(f"Current: confidence < {current_conf_threshold} AND resonance < {current_res_threshold}\n")

print(f"{'Topic':40s} {'Conf Range':15s} {'Expected':12s} {'At Current':12s}")
print("-" * 80)

for topic, (conf_lo, conf_hi), should_flag, desc in known_cases:
    conf_mid = (conf_lo + conf_hi) / 2
    res_mid = conf_mid * 0.8  # resonance typically correlates with confidence
    
    would_flag = conf_mid < current_conf_threshold and res_mid < current_res_threshold
    
    if should_flag == would_flag:
        status = "✓ CORRECT"
    else:
        status = "✗ WRONG" if should_flag != would_flag else "? UNCERTAIN"
    
    print(f"{topic:40s} {str((conf_lo, conf_hi)):15s} {'FLAG' if should_flag else 'NO FLAG':12s} {status}")

print("\nConclusion: At 0.45+ resonance for established physics, current FID threshold is unlikely")
print("to trigger for physics-core cells. This is correct behavior.")
print("\nConcern: Speculative topics at 0.10-0.30 confidence may NOT trigger FID if resonance > 0.25")
print("This means some speculative responses may get through without warning.")
EOF
```

### 7.2 — FID Audit File Analysis

Analyze the fid_audit.json output from Section 2.2:

```bash
python3 << 'EOF'
import json, os

audit_file = '/sessions/eloquent-bold-newton/mnt/KAI/data/fid_audit.json'
if not os.path.exists(audit_file):
    print("FID audit file not found — run --fid-audit first (Section 2.2)")
    exit()

with open(audit_file, 'r') as f:
    audit = json.load(f)

print(f"FID Audit file keys: {list(audit.keys())}")
print(json.dumps(audit, indent=2, default=str)[:3000])
EOF
```

---

## SECTION 8 — EXPERIMENTAL TESTS [PARALLEL GROUP G]

These tests make isolated, reversible modifications to understand behavior.
**IMPORTANT:** Back up main.rs before each experiment. Restore after.

### 8.1 — EXPERIMENT: NLS Verb Marker Extension

**Hypothesis:** Adding more verb markers to `synthesize_to_speech` will correctly pass through
more natural-language text without needing the disproven/noble patterns.

Test by expanding the verb_markers list and re-running the NLS test suite:

```python
# Extended verb markers to test
extended_markers = [
    " is ", " are ", " was ", " were ", " has ", " have ",
    " shows ", " means ", " confirms ", " describes ", " proves ",
    " needs ", " requires ", " earned ", " discovered ", " appears ",
    # New additions to test:
    " curves ", " bends ", " detected ", " established ", " founded ",
    " verified ", " observed ", " measured ", " calculated ", " derived ",
    " orbits ", " rotates ", " spins ", " flows ", " behaves ",
    " cannot ", " does not ", " did not ", " could not ", " would not ",
    " contains ", " consists ", " comprises ", " represents ", " indicates ",
]

# Re-run the NLS simulation with extended markers
# Count how many of the "generic fallback" cases are now correctly handled
```

Report: which additional verb markers would most improve NLS accuracy, and for which test cases.

### 8.2 — EXPERIMENT: FID Threshold Sensitivity

**Hypothesis:** Adjusting the FID threshold from (confidence < 0.15 AND resonance < 0.25)
to (confidence < 0.20 AND resonance < 0.30) would catch more speculative responses
without incorrectly flagging established physics.

Analyze: what would change at each threshold setting?

```python
thresholds_to_test = [
    (0.10, 0.20, "Current - too tight?"),
    (0.15, 0.25, "Current setting"),
    (0.20, 0.30, "Slightly looser"),
    (0.25, 0.35, "More lenient"),
    (0.30, 0.40, "Liberal"),
]

# For each threshold, estimate how many of the 2416 cells would be flagged
# based on the distribution of confidence scores seen in testing
```

### 8.3 — EXPERIMENT: Physics-Core Strength Sensitivity

**Hypothesis:** The strength=3.0 for physics-core cells may not be high enough if dream pruning
is aggressive, OR it may be overkill. What is the minimum strength needed?

Analyze the pruning threshold to determine the minimum safe strength:

```bash
grep -n "prune\|threshold\|strength\|0\.5\|decay\|forget\|dream" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | grep -i "prune\|decay\|forget\|threshold" | head -30
```

Report: minimum safe strength for physics-core cells, and whether 3.0 is appropriate.

### 8.4 — EXPERIMENT: RESONANCE_THRESHOLD Sensitivity

The voice.rs RESONANCE_THRESHOLD is 0.45. What happens if this is lowered to 0.35 or raised to 0.55?

Analyze what the user reported scores were:
- E=mc²: 47% resonance
- Luminiferous ether: 76%
- Quasicrystal: 45%

At RESONANCE_THRESHOLD = 0.45, the E=mc² response at 47% barely passes. At 0.55 it would fail.
At RESONANCE_THRESHOLD = 0.35, all three would pass.

Recommendation: Should the threshold be adjusted? Document the tradeoff.

### 8.5 — EXPERIMENT: Calibration Multiplier Impact

Current calibration multiplier: `phi_truth_threshold = max_false_phi_c * 0.70`

What would happen with different multipliers?

```python
# Simulate calibration results at different multipliers
# The user reported 10/10 at 0.70
# What was the margin? (how close was E=mc² to the threshold?)

multipliers = [0.50, 0.60, 0.70, 0.75, 0.80, 0.85, 0.90]
# For each, estimate which truth anchors would pass/fail
# based on the known calibration run data
```

Report: optimal multiplier range and safety margin.

### 8.6 — EXPERIMENT: Turn Render Limit Impact

Current render limit: last 50 turns.
The concern: what happens at 51+ turns? Is there a visual discontinuity?

Analyze the render_messages code for any edge cases at the boundary:

```bash
grep -n "50\|render_turns\|last 50\|len.*turns" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | head -20
```

Recommend: Is 50 the right number? Would 30 be better? Would 100 cause performance issues?

### 8.7 — EXPERIMENT: Dream Cycle Frequency

What is the current dream cycle interval (heartbeat)?

```bash
grep -n "heartbeat\|dream.*interval\|sleep.*5\|Duration::from_secs\|dream_timer" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | head -20
```

Analyze: Is the current interval appropriate? Too frequent (CPU waste)? Too infrequent (pruning lag)?

---

## SECTION 9 — ARCHITECTURE ANALYSIS [PARALLEL GROUP H]

Deep analysis of the overall system architecture.

### 9.1 — Module Dependency Graph

List all modules and their dependencies:

```bash
find /sessions/eloquent-bold-newton/mnt/KAI/src -name "*.rs" | grep -v target | sort
grep -rn "mod \|use \|pub mod " /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | head -40
grep -rn "^mod \|^pub mod " /sessions/eloquent-bold-newton/mnt/KAI/src/ | grep -v target | head -40
```

Draw a textual module dependency graph. Identify:
- Which modules are most depended upon? (high coupling risk)
- Are there circular dependencies? (Rust won't allow these, but identify near-circular)
- Which modules have the most public surface area?

### 9.2 — State Machine Analysis

KAI appears to have several state machines embedded. Identify and document them:

```bash
grep -n "enum.*State\|State::.*=>\|state_machine\|transition\|Phase\|Mood\|QueryType" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | head -40
```

For each state machine found, document:
- States (all variants)
- Transitions (when/how state changes)
- Is the state machine complete? (all transitions handled)
- Are there unreachable states?

### 9.3 — Data Flow Analysis

Trace the complete data flow from user input to KAI response:

```
Input → [encode] → SparseVec → [predictive_query] → hits → [generate_response_predictive] 
→ [synthesize_from_cells] → voice_text → [FID gate] → [synthesize_to_speech] → synth_text
→ [transcript::append] → [turns.push] → [render_messages] → display
```

Verify each step by finding the corresponding code:

```bash
grep -n "reasoning_input\|predictive_query\|generate_response_predictive\|synthesize_from_cells\|fid_note\|synth_text\|transcript::append\|turns.push\|render_messages" /sessions/eloquent-bold-newton/mnt/KAI/src/main.rs | head -50
```

Document any missing steps or potential data corruption points in the pipeline.

### 9.4 — Persistence Architecture Analysis

How is state saved and loaded?

```bash
grep -rn "fn save\|fn load\|fn state_exists\|persistence\|serialize\|deserialize" /sessions/eloquent-bold-newton/mnt/KAI/src/ | grep -v target | head -30
```

Analyze:
- What serialization format is used? (JSON, bincode, etc.)
- Is it versioned? (can old state files be loaded after code updates?)
- Is there any data migration logic?
- What happens if the state file is corrupted?
- Is there a backup mechanism?

### 9.5 — Transcript System Analysis

```bash
grep -rn "fn append\|fn load_transcript\|transcript\|session_id" /sessions/eloquent-bold-newton/mnt/KAI/src/ | grep -v target | head -20
```

Analyze:
- Where are transcripts stored?
- Are they bounded in size? (could grow unboundedly)
- Are they loaded at startup? (cold start = no context = bad responses initially)
- Is there any summarization of long transcripts?

### 9.6 — Ollama Voice Integration Analysis

```bash
grep -rn "OllamaVoice\|ollama\|KAI_OLLAMA" /sessions/eloquent-bold-newton/mnt/KAI/src/ | grep -v target | head -20
cat /sessions/eloquent-bold-newton/mnt/KAI/src/cognition/ollama_voice.rs 2>/dev/null | head -100
```

Analyze:
- When is Ollama used vs. native voice? (what triggers Ollama?)
- Is there graceful degradation if Ollama fails mid-response?
- What model is expected? What prompt template?

---

## SECTION 10 — COMPREHENSIVE ISSUE CATALOG

After all previous sections, compile a complete issue catalog:

### 10.1 — Critical Issues (P0 — Must Fix)

List any issue that:
- Causes data loss or corruption
- Causes KAI to crash
- Produces incorrect output on established physics facts
- Makes the system unusable

### 10.2 — High Priority Issues (P1 — Fix Soon)

List any issue that:
- Significantly degrades response quality
- Causes user-visible incorrect behavior on documented topics
- Performance issues making the TUI feel broken
- Memory leaks or unbounded growth

### 10.3 — Medium Priority Issues (P2 — Backlog)

List any issue that:
- Causes occasional incorrect behavior
- Code quality concerns
- Minor performance inefficiencies
- Missing error handling

### 10.4 — Low Priority Issues (P3 — Nice to Have)

List any issue that:
- Technical debt
- Code style concerns
- Potential future improvements
- Documentation gaps

---

## SECTION 11 — QUANTITATIVE SCORING

Score KAI v5.9.4 on each dimension:

### 11.1 — Scoring Matrix

```
Score each dimension 0-10. Provide specific justification.

DIMENSION                      | SCORE | JUSTIFICATION
-------------------------------|-------|---------------------------------------------------
Calibration Accuracy           |  /10  | How accurately does KAI know what it knows?
Physics Core Retrieval         |  /10  | Does E=mc², ether, quasicrystals come back correctly?
Natural Language Quality       |  /10  | Are responses fluent natural English?
FID False Positive Rate        |  /10  | Does FID flag correctly without over-triggering?
FID False Negative Rate        |  /10  | Does FID catch genuinely speculative content?
Response Time (UX)             |  /10  | Is 4682ms acceptable? (0 = never, 10 = instant)
TUI Responsiveness             |  /10  | Does the thinking indicator work? Does freeze happen?
State Persistence Quality      |  /10  | Are physics-core cells persisted correctly?
Code Quality                   |  /10  | Warnings, panics, dead code, complexity
Architecture Soundness         |  /10  | Are the design decisions appropriate?
Algorithm Correctness          |  /10  | VSA, HDC, cosine similarity — mathematically sound?
Dream Pruning Effectiveness    |  /10  | Is the state growing uncontrollably?
NLS Pipeline Correctness       |  /10  | Is the full synthesize chain working end-to-end?
Error Handling                 |  /10  | Are errors handled gracefully or do panics lurk?
Documentation Quality          |  /10  | Is the code well-documented and maintainable?

TOTAL                          |  /150
```

---

## SECTION 12 — PARALLEL EXECUTION PLAN

When running this audit, execute the following groups simultaneously:

**Wave 1 (Run all at once):**
- Section 0 (pre-flight) — SEQUENTIAL first
- Then launch in parallel:
  - Group A: Section 1.1-1.15 (Static Analysis)
  - Group B: Section 3.1-3.5 (State File Analysis)

**Wave 2 (After Wave 1 completes):**
- Section 2 (CLI Tests) — SEQUENTIAL
- While CLI tests run, also run in parallel:
  - Group C: Section 4 (Algorithm Analysis)
  - Group D: Section 5 (Performance Analysis)
  - Group E: Section 6 (NLS Experiments)

**Wave 3 (After Wave 2 completes):**
- Group F: Section 7 (FID Analysis)
- Group G: Section 8 (Experimental Tests) — isolated, parallel
- Group H: Section 9 (Architecture Analysis)

**Wave 4 (Synthesis):**
- Section 10: Issue Catalog (requires all previous data)
- Section 11: Scoring (requires all previous data)
- Section 12: Report writing

---

## SECTION 13 — REPORT FORMAT

Write the final report to:
`/sessions/eloquent-bold-newton/mnt/KAI/KAI_AUDIT_REPORT.md`

The report MUST contain:

```markdown
# KAI v5.9.4 — Full System Audit Report
## Date: [date]
## Duration: [how long the audit took]
## Auditor: Antigravity

---

## Executive Summary
[3-5 sentences: what is KAI, what was tested, what is the overall verdict]

## Critical Findings
[P0 issues that need immediate attention]

## Score Summary
[The 15-dimension scoring matrix from Section 11]

## Section-by-Section Findings

### Pre-Flight Results
[compilation status, null bytes, warnings]

### Calibration Audit Results
[score, threshold value, any failures]

### FID Audit Results
[flagging rate, physics-core cell status]

### Train-Truths Results
[cell count, strength values, natural language quality]

### State File Analysis
[size, growth rate, region distribution, duplicates, health]

### Algorithm Analysis
[complexity, correctness, concerns]

### Performance Analysis
[response time breakdown, bottleneck identification, memory estimate]

### NLS Analysis
[test suite results, accuracy %, gap analysis]

### Architecture Analysis
[module graph, data flow, concerns]

### Experimental Results
[what experiments were run, what was learned]

## Prioritized Recommendations

### Immediate (P0)
[numbered list]

### Short Term (P1)
[numbered list]

### Medium Term (P2)
[numbered list]

### Long Term (P3/Vision)
[numbered list]

## Raw Test Output Appendix
[all raw outputs from CLI tests]
```

---

## FINAL ANTI-DRIFT REMINDER

You are Antigravity. You are running a full audit of KAI v5.9.4. 
You have been given hundreds of specific tests to run.
Your job is to EXECUTE them, RECORD the results honestly, ANALYZE what they mean, and REPORT.
Do not skip sections. Do not fabricate results. If a command fails, log the failure.
If you find something alarming, note it prominently. If something works perfectly, note that too.
The goal is a COMPLETE picture of KAI's health — good, bad, and uncertain.

**Working directory:** `/sessions/eloquent-bold-newton/mnt/KAI/`
**Output file:** `KAI_AUDIT_REPORT.md` in the KAI directory.
**Do not modify KAI's source code** except for isolated experiments clearly marked as such,
and always restore main.rs after each experiment.

Begin with Section 0 (Pre-Flight) immediately.
