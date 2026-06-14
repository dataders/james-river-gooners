#!/usr/bin/env bash
# ty type-check ratchet for a Python package.
#
#   Usage: ty-ratchet.sh <package-dir> [baseline]   (baseline defaults to 0)
#
# Every Python package is ty-clean (baseline 0); this gate keeps them that way —
# any new ty diagnostic fails CI. Each package has a ty.toml ignoring
# environment-artifact rules (unresolved-import / possibly-missing-submodule),
# i.e. third-party deps the type-check job doesn't install (import sanity is
# covered by ruff's pyflakes F-codes), so what's left is real type errors.
#
# The ty version AND target python version are pinned so the count is identical
# in dev and CI (it drifts between python versions otherwise). If a future ty/
# typeshed bump surfaces unavoidable findings, raise that package's baseline
# (the CI invocation's second argument) deliberately.
set -uo pipefail

PKG="${1:?usage: ty-ratchet.sh <package-dir> [baseline]}"
BASELINE="${2:-0}"
TY_VERSION="0.0.44"
PYTHON_VERSION="3.13"

cd "$(dirname "$0")/../$PKG"
out=$(uvx "ty@${TY_VERSION}" check . --python-version "$PYTHON_VERSION" 2>&1)

if printf '%s\n' "$out" | grep -qE 'Found [0-9]+ diagnostic'; then
  count=$(printf '%s\n' "$out" | grep -oE 'Found [0-9]+ diagnostic' | grep -oE '[0-9]+' | tail -1)
elif printf '%s\n' "$out" | grep -q 'All checks passed'; then
  count=0
else
  printf '%s\n' "$out" | tail -20
  echo "❌ ty-ratchet[$PKG]: could not parse ty output (did ty fail to run?)."
  exit 1
fi

echo "[$PKG] ty diagnostics: $count (ceiling $BASELINE)"
if [ "$count" -gt "$BASELINE" ]; then
  printf '%s\n' "$out" | grep -oE '^(error|warning)\[[a-z-]+\]' | sort | uniq -c | sort -rn
  echo "❌ [$PKG] ty diagnostics rose to $count (ceiling $BASELINE). Fix the new finding(s), or raise the baseline if intentional."
  exit 1
fi
if [ "$count" -lt "$BASELINE" ]; then
  echo "❌ [$PKG] ty diagnostics improved to $count (was $BASELINE). Lower the baseline arg to $count to lock in the gain."
  exit 1
fi
echo "✅ [$PKG] at ceiling $BASELINE — ty-clean."
