#!/usr/bin/env bash
# In-place-only admission for the Explorer QA deployment.
# Usage: qa-in-place-guard.sh <workspace-path> <in_place_only: true|false>
# Exit 0: continue (in_place_only is false, or the workspace exists).
# Exit 43: in_place_only is true and the workspace is absent.
# Exit 1: malformed arguments (fail closed).
# Runs inside the locked section before any probe or provisioning command,
# so it uses only shell builtins and test.
set -euo pipefail
if [ "$#" -ne 2 ] || [ -z "$1" ]; then
  echo 'Usage: qa-in-place-guard.sh <workspace-path> <true|false>' >&2
  exit 1
fi
workspace="$1"
case "$2" in
  true|false) in_place_only="$2" ;;
  *)
    echo "::error::in_place_only must be exactly 'true' or 'false'" >&2
    exit 1
    ;;
esac
if [ "$in_place_only" = 'true' ] && [ ! -e "$workspace" ] && [ ! -L "$workspace" ]; then
  echo 'in_place_only is true and the QA workspace is absent; refusing to bootstrap or provision a fresh installation.' >&2
  exit 43
fi
exit 0
