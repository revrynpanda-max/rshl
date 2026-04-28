# KAI Refactoring Plan: Decoupling the God Function

## 1. Objective
Refactor `App::process_input` in `src/main.rs` to improve maintainability, reduce cognitive load for developers, and prepare for multi-threaded cognitive processing.

## 2. Current State (P0 Risk)
- **File**: `src/main.rs`
- **Function**: `App::process_input`
- **Range**: L3567 - L6455 (~2,888 lines)
- **Responsibilities**:
    - TUI Command Parsing (readfile, writefile, recall, etc.)
    - Emotional Analysis (Amygdala)
    - Episodic Memory Encoding
    - Working Memory Management
    - RSHL Reasoning & Retrieval
    - 78+ Cognitive Module Updates (Limbic, Social, Executive, Sensory)
    - Natural Language Synthesis (NLS)
    - UI State Updates

## 3. Targeted Architecture

### 3.1 Extraction of Command Handler
Extract L3972-L4746 into `App::handle_command(&mut self, input: &str) -> bool`.
- If it returns `true`, the input was a command and further processing should stop.
- Move `readfile`, `writefile`, `recall`, `learn`, `spell`, `store`, `import` logic here.

### 3.2 The Cognitive Pipeline
Create a new method `App::run_cognitive_cycle(&mut self, input: &str)`.
Inside this, group module updates into logical "Phases":

1.  **Ingestion Phase**: Amygdala, LexSem, Wernicke, Hub Ingest.
2.  **Retrieval Phase**: RSHL Query, Hippocampus CA3, Predictor.
3.  **Limbic Processing Phase**: Dopamine, VTA, Serotonin, Norepinephrine, ACC, Cortisol.
4.  **Social/ToM Phase**: ToM, TPJ, STS, Mirror Neurons, Oxytocin.
5.  **Executive/Decision Phase**: PFC, Basal Ganglia, OFC, Cerebellum.
6.  **Integration Phase**: Claustrum, Global Workspace, Self-State Hub.
7.  **Synthesis Phase**: Voice Engine, NLS, Broca.

### 3.3 State Encapsulation
Move module-specific logic (e.g., the complex RPE math) into the modules themselves where possible. `process_input` should ideally just be a series of `self.module.update(...)` calls.

## 4. Implementation Steps

### Phase 1: Command Decoupling
- Create `handle_command`.
- Move file I/O and session commands.
- **Goal**: Reduce `process_input` by ~800 lines.

### Phase 2: Signal Integration
- Refine the `BrainSignals` struct and the `SelfStateHub` to be the primary data exchange.
- Modules should read from the `Hub` and write to the `Hub` rather than having `main.rs` manually pass 10+ variables between them.

### Phase 3: Function Shrinkage
- Extract the 50+ block-scoped module updates (L5089-L6400) into `App::update_cognitive_modules`.

## 5. Performance Gains
- By decoupling command handling, we avoid initializing the entire cognitive stack for simple file reads.
- Preparing for a `CognitiveStack` struct that can be processed in parallel with the UI thread.
