#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "===================================================="
echo "  Naver Monitor starting"
echo "  http://localhost:5001"
echo "===================================================="
echo

PYTHON_BIN="${PYTHON_BIN:-}"
if [ -z "$PYTHON_BIN" ]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
  else
    echo "[ERROR] Python was not found. Install Python 3 first."
    read -r -p "Press Enter to close..."
    exit 1
  fi
fi

if ! "$PYTHON_BIN" -c "import flask" >/dev/null 2>&1; then
  echo "Installing required Python packages..."
  "$PYTHON_BIN" -m pip install -r requirements.txt
  echo
fi

if ! "$PYTHON_BIN" -c "from playwright.sync_api import sync_playwright; sync_playwright().__enter__().chromium.executable_path" >/dev/null 2>&1; then
  echo "Installing Playwright Chromium..."
  "$PYTHON_BIN" -m playwright install chromium
  echo
fi

if [ ! -f ".env.sh" ]; then
  echo "[ERROR] .env.sh was not found."
  echo "Copy .env.sh.example to .env.sh and fill in the Supabase values."
  read -r -p "Press Enter to close..."
  exit 1
fi

# shellcheck disable=SC1091
source ".env.sh"

echo "Coupang stock helper does not start automatically."
echo "For fast Coupang stock lookup, run run_coupang_stock_helper.command separately."
echo

open "http://localhost:5001" >/dev/null 2>&1 || true
export PORT="${PORT:-5001}"
"$PYTHON_BIN" app.py
