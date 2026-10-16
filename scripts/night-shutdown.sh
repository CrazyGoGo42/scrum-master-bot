#!/bin/bash
# Nachtabschaltung mit Rückfrage. Als root per cron jede Minute ab 22:51 aufrufen (siehe README).
# Fährt herunter, wenn der Bot sagt, dass niemand mehr arbeitet, spätestens um 04:00. Weckt um 08:00.

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="${NODE:-node}"
LATEST_HOUR=4

HOUR=$(date +%-H)
if [ "$HOUR" -lt "$LATEST_HOUR" ] || [ "$HOUR" -ge 22 ]; then
    RESULT=$("$NODE" "$REPO_DIR/scripts/night-shutdown-check.mjs" "$REPO_DIR/data" 2>/dev/null || echo "shutdown Prüfung fehlgeschlagen")
    case "$RESULT" in
        wait*) logger -t night-shutdown "$RESULT"; exit 0 ;;
    esac
    logger -t night-shutdown "$RESULT"
fi

NOW=$(date +%s)
TODAY_8=$(date -d "today 08:00" +%s)
if [ "$NOW" -lt "$TODAY_8" ]; then
    WAKE_TIME="$TODAY_8"
else
    WAKE_TIME=$(date -d "tomorrow 08:00" +%s)
fi

logger -t night-shutdown "Herunterfahren bis $(date -d @"$WAKE_TIME")"
/usr/sbin/rtcwake -m off -t "$WAKE_TIME"
