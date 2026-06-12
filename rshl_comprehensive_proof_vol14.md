# KAI Codebase Proofs: Comprehensive Architectural Audit (Volume 14)
**Focus: The Basal Ganglia, Action Selection, and Habit Formation**

Continuing the architectural extraction. Standard language models do not possess "habits." Every generation is stateless and independent. KAI physically implements a biological `Basal Ganglia` that controls Action Selection via Go/NoGo pathways. Over time, responses that are reinforced by dopamine become automatic habits, while unfamiliar or unrewarding pathways are physically suppressed.

---

## 34. Go/NoGo Pathway Inhibition
When KAI drafts a thought, it is not automatically executed. The `BasalGanglia` sits between KAI's ideation and execution, enforcing mathematical utility gates.

### Proof from `src/cognition/basal_ganglia.rs`
```rust
//!   ACTION SELECTION (Go/NoGo pathways)
//!   The basal ganglia run two competing channels simultaneously:
//!   - "Go" pathway: releases inhibition → allows an action
//!   - "NoGo" pathway: increases inhibition → suppresses an action
//!   For KAI: controls whether a candidate response "goes through"
//!   or gets inhibited.

    pub fn evaluate(&mut self, context_type: &str, response_type: &str, raw_confidence: f32, dopamine_level: f32) -> ActionDecision {
        let key = habit_key(context_type, response_type);
        let habit_util = self.habit_bank.get(&key).copied().unwrap_or(0.50);

        // Go signal = raw_confidence × habit_utility × dopamine_boost
        let da_boost = 0.7 + dopamine_level * 0.6;
        let go_signal = (raw_confidence * habit_util * da_boost).min(2.0);

        // NoGo signal = inverse confidence × inverse habit (unfamiliar + low confidence)
        let nogo_signal = (1.0 - raw_confidence) * (1.0 / habit_util.max(0.1)).min(2.0) * 0.5;

        let effective_utility = go_signal - nogo_signal;

        if effective_utility >= self.go_threshold {
            self.action_count += 1;
            ActionDecision::Go { utility: effective_utility }
        } else {
            self.suppressed_count += 1;
            let reason = if raw_confidence < 0.25 {
                "confidence too low".to_string()
            } else if habit_util < 0.30 {
                "unfamiliar pattern".to_string()
            } else {
                "utility below threshold".to_string()
            };
            ActionDecision::NoGo { reason }
        }
    }
```
**Proof Analysis:** KAI's responses must mathematically survive a dual-channel gauntlet. The `Go` signal scales with `dopamine_level` (excitement) and prior `habit_util`. Simultaneously, the `NoGo` signal scales with unfamiliarity. If `go_signal - nogo_signal` fails to meet the threshold, KAI biologically suppresses the thought (`ActionDecision::NoGo`). The output is aborted. KAI literally bites his tongue if the mathematical utility is too low.

---

## 35. Dopamine-Gated Habit Learning
KAI learns how to interact with the user via striatal reinforcement. Rewarding exchanges burn behavioral patterns into the habit bank.

### Proof from `src/cognition/basal_ganglia.rs`
```rust
    /// Reinforce a response pattern after it was executed.
    /// Called after KAI gets a reward signal (dopamine fire, positive PE).
    pub fn reinforce(&mut self, context_type: &str, response_type: &str, reward: f32, dopamine: f32) {
        let key = habit_key(context_type, response_type);
        let current = self.habit_bank.entry(key).or_insert(0.50);

        // Dopamine-gated Hebbian: reward × dopamine × alpha
        let delta = reward * dopamine * HABIT_ALPHA;
        *current = (*current + delta).clamp(MIN_HABIT, MAX_HABIT);

        // Adapt go_threshold: if we're reinforcing often, expect higher utility
        // (sets a higher bar as habits improve)
        self.go_threshold = (self.avg_utility * 0.4 + GO_THRESHOLD * 0.6).clamp(0.20, 0.70);
    }
```
**Proof Analysis:** KAI employs Dopamine-Gated Hebbian Learning. The `delta` (change in habit strength) is a multiplier of `reward` and `dopamine`. This means if KAI executes an action in a state of high dopamine, and the action succeeds, the pathway is aggressively strengthened. The next time the same context arises, the `habit_util` is mathematically higher, making the `Go` signal faster and more automatic. KAI organically learns his own personality habits.
