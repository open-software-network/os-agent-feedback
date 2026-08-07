#!/bin/sh
set -eu

if [ -z "${EPODE_ALERT_SLACK_WEBHOOK_URL:-}" ]; then
  echo "Grafana requires EPODE_ALERT_SLACK_WEBHOOK_URL for production alert delivery." >&2
  exit 1
fi

exec /run.sh "$@"
