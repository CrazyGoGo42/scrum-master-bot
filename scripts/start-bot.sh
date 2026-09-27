#!/usr/bin/env bash
set -u

# Resolve repository root relative to this script.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$REPO_DIR/logs"
LOG_FILE="$LOG_DIR/bot.log"
LOCK_FILE="/tmp/scrum-master-bot.lock"

mkdir -p "$LOG_DIR"
cd "$REPO_DIR" || exit 1

# Cron has a very small environment. Load a sensible PATH and NVM when available.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm use --silent default >/dev/null 2>&1 || true
fi

# Everything from here is written to logs/bot.log.
exec >>"$LOG_FILE" 2>&1

echo ""
echo "============================================================"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Scrum Master startup"
echo "Repository: $REPO_DIR"

# Prevent two bot instances from running at the same time.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bot läuft bereits. Abbruch."
  exit 0
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] FEHLER: node oder npm wurde nicht gefunden."
  exit 1
fi

echo "Node: $(node --version)"
echo "npm:  $(npm --version)"

# Install dependencies only when node_modules is missing.
if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] node_modules fehlt. Installiere Abhängigkeiten ..."
  if [ -f "$REPO_DIR/package-lock.json" ]; then
    npm ci || exit 1
  else
    npm install || exit 1
  fi
fi

# Compile once before starting. If the build is broken, do not launch stale code.
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Baue Bot ..."
npm run build || exit 1

# Keep the bot alive. If Node crashes, restart after five seconds.
while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starte Scrum Master ..."
  npm start
  EXIT_CODE=$?
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Bot beendet mit Code $EXIT_CODE. Neustart in 5 Sekunden ..."
  sleep 5
done
