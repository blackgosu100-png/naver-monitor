#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "Coupang stock helper restarting..."
echo "This launcher always runs the helper from the current app folder."

if [ ! -f "tools/coupang_stock_helper.js" ] && [ -f "../tools/coupang_stock_helper.js" ]; then
  cd ..
fi

if [ ! -f "tools/coupang_stock_helper.js" ]; then
  echo
  echo "ERROR: tools/coupang_stock_helper.js was not found."
  echo "Run this file from the Naver monitor app root folder, not from chrome_extension only."
  echo "Current folder: $(pwd)"
  echo
  read -r -p "Press Enter to close..."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js was not found. Install Node.js first."
  read -r -p "Press Enter to close..."
  exit 1
fi

echo "Closing any old helper on port 8765 first."
curl -fsS -X POST "http://127.0.0.1:8765/shutdown" >/dev/null 2>&1 || true
sleep 1

echo "Starting fresh helper. Keep this window open while testing Coupang stock lookup."
node tools/coupang_stock_helper.js
