@echo off
echo Starting KAI Server in the background...
start "KAI Oracle Server" cmd /c "cargo run --release --bin kai -- --oracle-server"

echo Waiting 120 seconds for server to compile and start...
ping 127.0.0.1 -n 120 > nul

echo Starting 3-hour experiential lattice training...
python tools\experiential_ingest.py

echo Training complete.
