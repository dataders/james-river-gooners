#!/usr/bin/env bash
# SessionStart hook — runs at the start of every remote Claude Code session.
#
# Installs tools that the ephemeral container loses between sessions:
#   gh         — GitHub CLI (auth via GH_TOKEN env var)
#   uv         — Python package runner (used by the scraper)
#   gcloud     — Google Cloud CLI (OAuth setup, GCP ops)
#   supabase   — Supabase CLI (migrations, config)
#
# Also runs `npm install` so JS deps are always current.
#
# ASYNC mode: the JSON directive below tells Claude Code to start the session
# immediately and run this in the background. Tools are ready within ~60s;
# gcloud takes longest (~350 MB).
#
# Fail-soft: every install logs a warning on failure and returns 0 so the
# session still starts.

set -uo pipefail

echo '{"async": true, "asyncTimeout": 300000}'

log()  { echo "[session-start] $*"; }
warn() { echo "[session-start] WARNING: $*"; }

# Only run the heavy installs in the remote (web) container.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  log "Not a remote session — skipping container tool setup"
  exit 0
fi

SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

# ---------------------------------------------------------------------------
# npm install — keep JS deps current
# ---------------------------------------------------------------------------
log "npm install..."
if npm install --prefix "${CLAUDE_PROJECT_DIR:-.}" >/tmp/npm-install.log 2>&1; then
  log "npm install done"
else
  warn "npm install failed — see /tmp/npm-install.log"
fi

# ---------------------------------------------------------------------------
# gh — GitHub CLI
# ---------------------------------------------------------------------------
if command -v gh >/dev/null 2>&1; then
  log "gh already installed ($(gh --version | head -1))"
else
  log "Installing gh..."
  if $SUDO apt-get install -y gh >/tmp/gh-install.log 2>&1 || \
     { $SUDO apt-get update -qq >/tmp/gh-apt-update.log 2>&1 && \
       $SUDO apt-get install -y gh >>/tmp/gh-install.log 2>&1; }; then
    log "gh installed ($(gh --version | head -1))"
  else
    warn "gh install failed — see /tmp/gh-install.log"
  fi
fi

# Verify gh auth (reads GH_TOKEN / GITHUB_TOKEN automatically).
if command -v gh >/dev/null 2>&1; then
  if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ]; then
    if gh auth status >/dev/null 2>&1; then
      log "gh authenticated as $(gh api user --jq .login 2>/dev/null || echo '?')"
    else
      warn "GH_TOKEN is set but gh auth status failed"
    fi
  else
    log "NOTE: no GH_TOKEN in env — set it in the web UI to enable gh"
  fi
fi

# ---------------------------------------------------------------------------
# uv — Python package runner (used by scraper/)
# ---------------------------------------------------------------------------
if command -v uv >/dev/null 2>&1; then
  log "uv already installed ($(uv --version))"
else
  log "Installing uv..."
  if curl -LsSf https://astral.sh/uv/install.sh | sh >/tmp/uv-install.log 2>&1; then
    export PATH="$HOME/.local/bin:$PATH"
    log "uv installed ($(uv --version 2>/dev/null || echo 'restart shell to activate PATH'))"
  else
    warn "uv install failed — see /tmp/uv-install.log"
  fi
fi

# ---------------------------------------------------------------------------
# gcloud — Google Cloud CLI
# ---------------------------------------------------------------------------
if command -v gcloud >/dev/null 2>&1; then
  log "gcloud already installed ($(gcloud --version 2>/dev/null | head -1))"
else
  log "Installing gcloud (this takes ~60s)..."
  if [ ! -f /usr/share/keyrings/cloud.google.gpg ]; then
    curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
      | $SUDO gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg 2>/tmp/gcloud-install.log \
      || true
  fi
  if [ ! -f /etc/apt/sources.list.d/google-cloud-sdk.list ]; then
    echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] \
https://packages.cloud.google.com/apt cloud-sdk main" \
      | $SUDO tee /etc/apt/sources.list.d/google-cloud-sdk.list >/dev/null
  fi
  if $SUDO apt-get update -qq >>/tmp/gcloud-install.log 2>&1 && \
     $SUDO apt-get install -y google-cloud-cli >>/tmp/gcloud-install.log 2>&1; then
    log "gcloud installed ($(gcloud --version 2>/dev/null | head -1))"
  else
    warn "gcloud install failed — see /tmp/gcloud-install.log"
  fi
fi

# ---------------------------------------------------------------------------
# supabase CLI
# ---------------------------------------------------------------------------
if command -v supabase >/dev/null 2>&1; then
  log "supabase already installed ($(supabase --version 2>/dev/null))"
else
  log "Installing supabase CLI..."
  if npm install -g supabase >/tmp/supabase-install.log 2>&1; then
    log "supabase installed ($(supabase --version 2>/dev/null))"
  else
    warn "supabase install failed — see /tmp/supabase-install.log"
  fi
fi

exit 0
