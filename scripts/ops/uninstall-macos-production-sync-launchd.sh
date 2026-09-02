#!/usr/bin/env bash
set -euo pipefail

LABEL=${LABEL:-com.averray.agent.production-sync}
plist_path="$HOME/Library/LaunchAgents/$LABEL.plist"

if command -v launchctl >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)" "$plist_path" >/dev/null 2>&1 || true
fi

rm -f "$plist_path"

echo "Uninstalled launchd agent: $LABEL"
