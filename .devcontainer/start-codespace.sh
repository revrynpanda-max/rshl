#!/bin/bash
# KAI Codespaces Startup Script

echo "========================================================"
echo "    KAI | Sovereign Autonomous Intelligence             "
echo "    Initializing Codespace Environment...               "
echo "========================================================"

# Check if KAI is built
if [ ! -f "./target/release/kai" ]; then
    echo ">> Compiling KAI (CPU-only mode for cloud)..."
    cargo build --release --no-default-features
fi

echo ">> Booting KAI Oracle Server (Port 3334)..."
# Start KAI in headless mode in the background
nohup ./target/release/kai --oracle-server > kai-oracle.log 2>&1 &

echo ">> Booting Web Chat Interface (Port 8080)..."
# Start a simple web server proxying /api to KAI
nohup npx http-server -p 8080 -P http://127.0.0.1:3334 -c-1 > web-chat.log 2>&1 &

echo "========================================================"
echo "  KAI is now running! "
echo ""
echo "  Option 1 (Terminal TUI):"
echo "  Run this command to talk to KAI in this terminal:"
echo "  ./target/release/kai"
echo ""
echo "  Option 2 (Web Browser):"
echo "  Go to the 'PORTS' tab below and open port 8080."
echo "  To share with visitors, change port 8080 visibility"
echo "  to 'Public' and share the link."
echo "========================================================"

# Keep script running so Codespace stays active
tail -f kai-oracle.log
