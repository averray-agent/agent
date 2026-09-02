#!/usr/bin/env bash
set -euo pipefail

# Install a per-user launchd agent that keeps local main synced after successful
# production deploys. This is macOS-only and writes to ~/Library/LaunchAgents.

LABEL=${LABEL:-com.averray.agent.production-sync}
INTERVAL=${INTERVAL:-60}
REMOTE=${REMOTE:-origin}
BASE_BRANCH=${BASE_BRANCH:-main}
WORKFLOW=${WORKFLOW:-deploy-production.yml}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

plist_escape() {
  sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

require_command launchctl
require_command git
require_command gh

repo_root="$(git rev-parse --show-toplevel)"
script_path="$repo_root/scripts/ops/watch-production-sync.sh"

if [[ ! -x "$script_path" ]]; then
  echo "Missing executable watcher: $script_path" >&2
  exit 1
fi

launch_agents_dir="$HOME/Library/LaunchAgents"
log_dir="$repo_root/.codex/logs"
state_dir="$repo_root/.codex/state"
plist_path="$launch_agents_dir/$LABEL.plist"

mkdir -p "$launch_agents_dir" "$log_dir" "$state_dir"

repo_root_xml="$(printf '%s' "$repo_root" | plist_escape)"
script_path_xml="$(printf '%s' "$script_path" | plist_escape)"
path_xml="$(printf '%s' "$PATH" | plist_escape)"
remote_xml="$(printf '%s' "$REMOTE" | plist_escape)"
base_branch_xml="$(printf '%s' "$BASE_BRANCH" | plist_escape)"
workflow_xml="$(printf '%s' "$WORKFLOW" | plist_escape)"
interval_xml="$(printf '%s' "$INTERVAL" | plist_escape)"
log_out_xml="$(printf '%s' "$log_dir/production-sync.out.log" | plist_escape)"
log_err_xml="$(printf '%s' "$log_dir/production-sync.err.log" | plist_escape)"
state_dir_xml="$(printf '%s' "$state_dir" | plist_escape)"

cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$script_path_xml</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$repo_root_xml</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$path_xml</string>
    <key>REMOTE</key>
    <string>$remote_xml</string>
    <key>BASE_BRANCH</key>
    <string>$base_branch_xml</string>
    <key>WORKFLOW</key>
    <string>$workflow_xml</string>
    <key>INTERVAL</key>
    <string>$interval_xml</string>
    <key>STATE_DIR</key>
    <string>$state_dir_xml</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$log_out_xml</string>
  <key>StandardErrorPath</key>
  <string>$log_err_xml</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$plist_path" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$plist_path"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed launchd agent: $LABEL"
echo "Plist: $plist_path"
echo "Logs:"
echo "  $log_dir/production-sync.out.log"
echo "  $log_dir/production-sync.err.log"
