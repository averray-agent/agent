#!/usr/bin/env bash
#
# Non-destructive backup readiness check.
#
# Reads filesystem metadata only. Never restores, never deletes, never
# modifies a backup file. Confirms that the most recent Postgres and
# Redis backup files exist under the expected layout and are within a
# configurable age threshold. Exits non-zero with a clear reason when a
# component is missing or stale.
#
# Intended for the Production Checklist §2 "Data durability" evidence
# step and for the monthly restore-drill prep (see
# docs/BACKUP_RESTORE_DRILL.md).
#
# Env:
#   BACKUP_DIR             root of backups; default /srv/agent-stack/backups
#   MAX_AGE_HOURS          max age of the newest file, in hours; default 26
#                          (daily backups + slack)
#   POSTGRES_BACKUP_GLOB   glob under $BACKUP_DIR/postgres; default *.sql.gz
#   REDIS_BACKUP_GLOB      glob under $BACKUP_DIR/redis; default *.rdb.gz
#   OUTPUT_FORMAT          "text" (default) or "json"
#
# Flags:
#   --json                 shorthand for OUTPUT_FORMAT=json
#   --max-age-hours N      shorthand for MAX_AGE_HOURS=N
#   --backup-dir PATH      shorthand for BACKUP_DIR=PATH
#   -h | --help

set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-"/srv/agent-stack/backups"}
MAX_AGE_HOURS=${MAX_AGE_HOURS:-26}
POSTGRES_BACKUP_GLOB=${POSTGRES_BACKUP_GLOB:-"*.sql.gz"}
REDIS_BACKUP_GLOB=${REDIS_BACKUP_GLOB:-"*.rdb.gz"}
OUTPUT_FORMAT=${OUTPUT_FORMAT:-text}

while (($#)); do
  case "$1" in
    --json) OUTPUT_FORMAT=json ;;
    --text) OUTPUT_FORMAT=text ;;
    --max-age-hours)
      [[ $# -ge 2 ]] || { echo "--max-age-hours needs a value" >&2; exit 2; }
      MAX_AGE_HOURS="$2"; shift ;;
    --backup-dir)
      [[ $# -ge 2 ]] || { echo "--backup-dir needs a value" >&2; exit 2; }
      BACKUP_DIR="$2"; shift ;;
    -h|--help)
      sed -n '2,/^set -euo/{/^set -euo/!p;}' "$0"
      exit 0 ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2 ;;
  esac
  shift
done

if ! [[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]] || (( MAX_AGE_HOURS == 0 )); then
  echo "MAX_AGE_HOURS must be a positive integer; got '$MAX_AGE_HOURS'" >&2
  exit 2
fi

now_epoch=$(date +%s)
max_age_seconds=$(( MAX_AGE_HOURS * 3600 ))

# Portable file mtime (seconds since epoch) for both Linux and macOS.
file_mtime() {
  if stat --version >/dev/null 2>&1; then
    stat -c %Y -- "$1"
  else
    stat -f %m -- "$1"
  fi
}

newest_in() {
  local dir="$1"
  local glob="$2"
  shopt -s nullglob
  local files=( "$dir"/$glob )
  shopt -u nullglob
  if (( ${#files[@]} == 0 )); then
    return 1
  fi
  local newest=""
  local newest_mtime=-1
  for f in "${files[@]}"; do
    local m
    m=$(file_mtime "$f")
    if (( m > newest_mtime )); then
      newest_mtime=$m
      newest="$f"
    fi
  done
  printf '%s\t%s\n' "$newest" "$newest_mtime"
}

check_component() {
  local label="$1"
  local subdir="$2"
  local glob="$3"
  local path="$BACKUP_DIR/$subdir"

  if [[ ! -d "$path" ]]; then
    emit "$label" "missing_directory" "" "" "Directory does not exist: $path"
    return 1
  fi

  local newest_line
  if ! newest_line=$(newest_in "$path" "$glob"); then
    emit "$label" "no_files_match" "" "" "No files in $path match $glob"
    return 1
  fi

  local file mtime age_seconds
  IFS=$'\t' read -r file mtime <<<"$newest_line"
  age_seconds=$(( now_epoch - mtime ))

  if (( age_seconds > max_age_seconds )); then
    emit "$label" "stale" "$file" "$age_seconds" \
      "Newest backup is $(format_hours $age_seconds) old; threshold is ${MAX_AGE_HOURS}h"
    return 1
  fi

  emit "$label" "ok" "$file" "$age_seconds" "Newest backup is $(format_hours $age_seconds) old"
  return 0
}

format_hours() {
  awk -v s="$1" 'BEGIN { printf "%.1fh", s/3600 }'
}

# Result rows are accumulated as TAB-separated triples then rendered at
# the end. Keeps the JSON and text paths from diverging.
result_lines=()
emit() {
  result_lines+=( "$(printf '%s\t%s\t%s\t%s\t%s' "$1" "$2" "$3" "$4" "$5")" )
}

overall_status=0
check_component postgres postgres "$POSTGRES_BACKUP_GLOB" || overall_status=1
check_component redis redis "$REDIS_BACKUP_GLOB" || overall_status=1

if [[ "$OUTPUT_FORMAT" == "json" ]]; then
  printf '{\n'
  printf '  "checkedAt": "%s",\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf '  "backupDir": "%s",\n' "$BACKUP_DIR"
  printf '  "maxAgeHours": %d,\n' "$MAX_AGE_HOURS"
  printf '  "overallStatus": "%s",\n' "$([[ $overall_status -eq 0 ]] && echo ok || echo not_ok)"
  printf '  "components": [\n'
  local_index=0
  for line in "${result_lines[@]}"; do
    IFS=$'\t' read -r label status file age_seconds message <<<"$line"
    if (( local_index > 0 )); then printf ',\n'; fi
    printf '    {"name":"%s","status":"%s","file":"%s","ageSeconds":%s,"message":"%s"}' \
      "$label" "$status" "${file//\"/\\\"}" "${age_seconds:-null}" "${message//\"/\\\"}"
    local_index=$(( local_index + 1 ))
  done
  printf '\n  ]\n}\n'
else
  echo "Backup readiness check"
  echo "  backupDir:     $BACKUP_DIR"
  echo "  maxAgeHours:   $MAX_AGE_HOURS"
  echo
  for line in "${result_lines[@]}"; do
    IFS=$'\t' read -r label status file age_seconds message <<<"$line"
    printf '  %-9s %-18s %s\n' "$label" "$status" "$message"
    if [[ -n "$file" ]]; then
      printf '            file: %s\n' "$file"
    fi
  done
  echo
  if (( overall_status == 0 )); then
    echo "Overall: ok"
  else
    echo "Overall: not_ok"
  fi
fi

exit "$overall_status"
