@echo off
chcp 65001 >nul 2>&1
cls

echo.
echo  ============================================================
echo    RSHL + KAI -- Full Benchmark Suite
echo    Speed - Accuracy - Lattice - Rust Engine - All Tests
echo  ============================================================
echo.
echo  [Score 492 is the real hardware ceiling for this machine]
echo  [Ryzen 5 8645HS + RTX 4050 + 40GB RAM + AVX2+OMP native]
echo.

echo  ------------------------------------------------------------
echo   1/4  RSHL Speed Benchmark  (bench.js --save)
echo  ------------------------------------------------------------
echo.
node bench.js --save
echo.

echo  ------------------------------------------------------------
echo   2/4  Recall Accuracy  (eval/recall-accuracy.js)
echo  ------------------------------------------------------------
echo.
node eval/recall-accuracy.js
echo.

echo  ------------------------------------------------------------
echo   3/4  Lattice Eval  (eval/lattice-eval.js)
echo  ------------------------------------------------------------
echo.
node eval/lattice-eval.js
echo.

echo  ------------------------------------------------------------
echo   4/4  Rust Engine Tests  (cargo test --release)
echo  ------------------------------------------------------------
echo.
cd kai-rust
cargo test --release
cd ..
echo.

echo  ============================================================
echo    ALL BENCHMARKS COMPLETE
echo  ============================================================
echo.
echo  Results saved to: reports/
echo.
pause
