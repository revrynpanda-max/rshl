@echo off
:: ══════════════════════════════════════════════════════════════
::   RSHL + KAI — Full Benchmark Suite
::   Run cold from C:\KAI — tests speed, accuracy, lattice, Rust
:: ══════════════════════════════════════════════════════════════
echo.
echo ╔══════════════════════════════════════════════════════════════╗
echo ║   RSHL + KAI — Full Benchmark Suite                        ║
echo ║   Speed · Accuracy · Lattice · Rust Engine · All Tests     ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.

:: ── 1. RSHL Speed Benchmark ──────────────────────────────────
echo ════════════════════════════════════════════════════════════
echo  1/4  RSHL Speed Benchmark (bench.js)
echo ════════════════════════════════════════════════════════════
echo.
node bench.js --save
echo.

:: ── 2. Recall Accuracy ───────────────────────────────────────
echo ════════════════════════════════════════════════════════════
echo  2/4  Recall Accuracy (eval/recall-accuracy.js)
echo ════════════════════════════════════════════════════════════
echo.
node eval/recall-accuracy.js
echo.

:: ── 3. Lattice Eval ──────────────────────────────────────────
echo ════════════════════════════════════════════════════════════
echo  3/4  Lattice Eval (eval/lattice-eval.js)
echo ════════════════════════════════════════════════════════════
echo.
node eval/lattice-eval.js
echo.

:: ── 4. Rust Engine Tests ─────────────────────────────────────
echo ════════════════════════════════════════════════════════════
echo  4/4  Rust Engine Tests (cargo test)
echo ════════════════════════════════════════════════════════════
echo.
cd kai-rust
cargo test
echo.

echo ╔══════════════════════════════════════════════════════════════╗
echo ║   ALL BENCHMARKS COMPLETE                                   ║
echo ╚══════════════════════════════════════════════════════════════╝
echo.
pause
