#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="/Library/Frameworks/Python.framework/Versions/3.14/bin/python3"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/whatsapp_scraper.log"
LOCK_DIR="/tmp/whatsapp_scraper.lock"

mkdir -p "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "WhatsApp scraper is already running."
  exit 0
fi

cleanup() {
  rmdir "$LOCK_DIR"
}
trap cleanup EXIT

cd "$PROJECT_DIR"

{
  echo "== $(date -u '+%Y-%m-%dT%H:%M:%SZ') Starting WhatsApp scraper =="
  "$PYTHON" -u scraper.py
  echo "== $(date -u '+%Y-%m-%dT%H:%M:%SZ') Finished WhatsApp scraper =="
} 2>&1 | tee -a "$LOG_FILE"
