#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ -f "tools/coupang_stock_helper.js" ]; then
  echo "Coupang stock helper restarting..."
  echo "Starting helper from this extension package."
  echo "Keep this window open while testing Coupang stock lookup."

  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: Node.js was not found. Install Node.js first."
    read -r -p "Press Enter to close..."
    exit 1
  fi

  curl -fsS -X POST "http://127.0.0.1:8765/shutdown" >/dev/null 2>&1 || true
  sleep 1
  node tools/coupang_stock_helper.js
  exit $?
fi

if [ -f "../tools/coupang_stock_helper.js" ]; then
  cd ..
  exec ./run_coupang_stock_helper.command
fi

echo "ERROR: Cannot find tools/coupang_stock_helper.js."
echo "Use the full naver-monitor-extension package, not the chrome_extension files alone."
echo "Current folder: $(pwd)"
read -r -p "Press Enter to close..."
exit 1
