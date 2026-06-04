#!/usr/bin/env bash
# Setup script for Google OAuth tooling (gcloud, Supabase CLI, gh CLI).
# Run from any directory. Safe to re-run — skips already-installed tools.
set -euo pipefail

OS="$(uname -s)"
need() { ! command -v "$1" &>/dev/null; }
info() { echo "==> $*"; }
ok()   { echo "    [ok] $*"; }

# ---------------------------------------------------------------------------
# Google Cloud CLI (gcloud)
# ---------------------------------------------------------------------------
if need gcloud; then
  info "Installing Google Cloud CLI..."
  if [[ "$OS" == "Darwin" ]]; then
    if command -v brew &>/dev/null; then
      brew install --cask google-cloud-sdk
    else
      # Fallback: interactive installer
      curl -fsSL https://sdk.cloud.google.com | bash
      exec -l "$SHELL"
    fi
  else
    # Linux — use the apt repository if available, otherwise the curl installer
    if command -v apt-get &>/dev/null; then
      sudo apt-get install -y apt-transport-https ca-certificates gnupg
      curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
        | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
      echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] \
https://packages.cloud.google.com/apt cloud-sdk main" \
        | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list
      sudo apt-get update && sudo apt-get install -y google-cloud-cli
    else
      curl -fsSL https://sdk.cloud.google.com | bash
      exec -l "$SHELL"
    fi
  fi
else
  ok "gcloud $(gcloud --version 2>/dev/null | head -1)"
fi

# ---------------------------------------------------------------------------
# Supabase CLI
# ---------------------------------------------------------------------------
if need supabase; then
  info "Installing Supabase CLI..."
  if [[ "$OS" == "Darwin" ]] && command -v brew &>/dev/null; then
    brew install supabase/tap/supabase
  else
    # Use npm as a cross-platform fallback (already present via Node)
    npm install -g supabase
  fi
else
  ok "supabase $(supabase --version 2>/dev/null)"
fi

# ---------------------------------------------------------------------------
# GitHub CLI (gh)
# ---------------------------------------------------------------------------
if need gh; then
  info "Installing GitHub CLI..."
  if [[ "$OS" == "Darwin" ]] && command -v brew &>/dev/null; then
    brew install gh
  elif command -v apt-get &>/dev/null; then
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) \
signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
https://cli.github.com/packages stable main" \
      | sudo tee /etc/apt/sources.list.d/github-cli.list
    sudo apt-get update && sudo apt-get install -y gh
  else
    echo "    [!] Install gh manually: https://cli.github.com/"
  fi
else
  ok "gh $(gh --version 2>/dev/null | head -1)"
fi

# ---------------------------------------------------------------------------
# Python / uv (already required by the scraper — just verify)
# ---------------------------------------------------------------------------
if need uv; then
  info "Installing uv (Python package runner)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
else
  ok "uv $(uv --version 2>/dev/null)"
fi

# ---------------------------------------------------------------------------
# Done — next steps
# ---------------------------------------------------------------------------
echo ""
echo "All tools ready. Next steps:"
echo ""
echo "  1. Authenticate gcloud:"
echo "       gcloud auth login"
echo ""
echo "  2. Select or create your GCP project:"
echo "       gcloud projects list"
echo "       gcloud config set project YOUR_PROJECT_ID"
echo ""
echo "  3. Enable the Google Identity API:"
echo "       gcloud services enable oauth2.googleapis.com"
echo ""
echo "  4. Follow the rest of the guide:"
echo "       docs/google-oauth-setup.md"
