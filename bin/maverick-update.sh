#!/usr/bin/env bash
# Maverick self-updater (HOST-side). Pulls the latest from the private GitHub repo and rebuilds the
# container if anything changed. Safe to run repeatedly / on a cron — it no-ops when already current.
#
#   - Runs on the host (the host's `gh`/git is authenticated for the private repo, so no token lives
#     in the container). Fast-forward only — never rewrites local history, never force-pulls.
#   - Skips the rebuild when there's nothing new, so it's cheap to schedule.
#   - Notifies via ntfy on update/failure.
#
# Usage:
#   bin/maverick-update.sh                # pull + rebuild if changed
#   bin/maverick-update.sh --force        # rebuild even if no new commits
#
# Cron (nightly 03:10), if you want auto-update:
#   10 3 * * * /gisiserver/infra/docker/maverick/bin/maverick-update.sh >> /gisiserver/logs/maverick-update.log 2>&1
set -euo pipefail

REPO="/gisiserver/infra/docker/maverick"
BRANCH="main"
cd "$REPO"

ntfy() { # $1=title $2=body  (best-effort, internal ntfy)
  local tok; tok="$(grep -m1 '^NTFY_TOKEN=' "$REPO/.env" 2>/dev/null | cut -d= -f2- || true)"
  local topic; topic="$(grep -m1 '^NTFY_TOPIC=' "$REPO/.env" 2>/dev/null | cut -d= -f2- || echo maverick)"
  [ -n "${tok:-}" ] || return 0
  docker exec maverick node -e "
    fetch('http://ntfy:80/${topic}',{method:'POST',headers:{Title:'$1',Authorization:'Bearer ${tok}','Content-Type':'text/plain'},body:\`$2\`}).catch(()=>{})
  " >/dev/null 2>&1 || true
}

echo "[maverick-update] $(date -Is) fetching..."
git fetch --quiet origin "$BRANCH"

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
FORCE="${1:-}"

if [ "$LOCAL" = "$REMOTE" ] && [ "$FORCE" != "--force" ]; then
  echo "[maverick-update] already up to date ($(git rev-parse --short HEAD))."
  exit 0
fi

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "[maverick-update] updating $(git rev-parse --short HEAD) -> $(git rev-parse --short "origin/$BRANCH")"
  git merge --ff-only "origin/$BRANCH"   # fail rather than create a merge / lose local edits
fi

echo "[maverick-update] rebuilding container..."
if docker compose up -d --build; then
  NEW="$(git rev-parse --short HEAD)"
  echo "[maverick-update] done ($NEW)."
  ntfy "Maverick updated" "Now on ${NEW}. $(git log -1 --pretty=%s | tr -d '\`')"
else
  echo "[maverick-update] BUILD FAILED" >&2
  ntfy "Maverick update FAILED" "Build error on $(git rev-parse --short HEAD) — check logs."
  exit 1
fi
