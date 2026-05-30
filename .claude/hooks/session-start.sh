#!/usr/bin/env bash
# SessionStart hook: ensure the GitHub CLI (gh) is installed and authenticated.
#
# Claude Code on the web runs in an ephemeral container, so gh and any auth
# state are lost between sessions. This restores them each session:
#   1. installs gh from Ubuntu's apt repo if it is missing
#   2. lets gh pick up credentials from the GH_TOKEN env var (set in the
#      Claude Code on the web UI) — no interactive login required
#
# Fail-soft by design: a missing token or a failed install logs a warning and
# returns 0 so the session still starts.

set -uo pipefail

log() { echo "[session-start] $*"; }

# 1. Install gh if not already present (idempotent).
if command -v gh >/dev/null 2>&1; then
  log "gh already installed ($(gh --version | head -1))"
else
  log "gh not found — installing via apt-get..."
  if command -v apt-get >/dev/null 2>&1; then
    SUDO=""
    [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"
    if $SUDO apt-get install -y gh >/tmp/gh-install.log 2>&1; then
      log "gh installed ($(gh --version | head -1))"
    else
      # Package index may be stale in a fresh container; refresh once and retry.
      $SUDO apt-get update >/tmp/gh-apt-update.log 2>&1 || true
      if $SUDO apt-get install -y gh >>/tmp/gh-install.log 2>&1; then
        log "gh installed after apt-get update ($(gh --version | head -1))"
      else
        log "WARNING: failed to install gh — see /tmp/gh-install.log"
      fi
    fi
  else
    log "WARNING: apt-get unavailable; cannot install gh automatically"
  fi
fi

# 2. Verify authentication. gh reads GH_TOKEN/GITHUB_TOKEN automatically, so no
#    interactive login is needed — we just report status for the session log.
if command -v gh >/dev/null 2>&1; then
  if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ]; then
    if gh auth status >/dev/null 2>&1; then
      log "gh authenticated as $(gh api user --jq .login 2>/dev/null || echo '?')"
    else
      log "WARNING: GH_TOKEN/GITHUB_TOKEN is set but gh auth status failed"
    fi
  else
    log "NOTE: no GH_TOKEN/GITHUB_TOKEN in env — set it in the web UI to enable gh"
  fi
fi

exit 0
