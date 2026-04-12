#!/bin/bash
echo "RSHL Personal Memory Engine - Benchmark"
echo "========================================"
echo ""

if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not found. Install from https://nodejs.org"
    exit 1
fi

echo "Installing dependencies..."
npm install --ignore-scripts --silent 2>/dev/null

echo ""
echo "Detecting hardware capabilities..."
echo "(If native addon is already built, it will be used automatically)"
echo ""
node bench.js --save

echo ""
echo "Done. Check the reports/ folder for your JSON result."
