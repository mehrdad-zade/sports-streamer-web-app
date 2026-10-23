#!/usr/bin/env bash
# Starts Sports Streamer and opens it in your browser.
# Close the terminal or press Ctrl+C to stop it.
cd "$(dirname "$0")" || exit 1

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if ! command -v node >/dev/null 2>&1 && [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Sports Streamer needs Node.js 20 or newer: https://nodejs.org"
  exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Sports Streamer needs Node.js 20 or newer (found $(node -v)): https://nodejs.org"
  exit 1
fi

if [ ! -d node_modules/puppeteer-core ] || [ ! -d node_modules/hls.js ] || [ package.json -nt node_modules/.package-lock.json ]; then
  echo "Installing Sports Streamer's components (first run only)…"
  npm install --omit=dev --no-audit --no-fund || exit 1
fi

exec node server/index.js --open
