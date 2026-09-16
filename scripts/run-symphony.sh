#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
logs_root="$HOME/.local/state/symphony/stepstone/logs"

mkdir -p "$logs_root"
export LINEAR_API_KEY
LINEAR_API_KEY="$(op read 'op://Personal/Linear - Stepstone Symphony/credential')"

# Keep 1Password authentication out of the service and agent environments.
for variable in ${!OP_SESSION_@}; do
  unset "$variable"
done
unset OP_SERVICE_ACCOUNT_TOKEN OP_CONNECT_TOKEN

exec symphony \
  --i-understand-that-this-will-be-running-without-the-usual-guardrails \
  --logs-root "$logs_root" \
  --port 4000 \
  "$repo_root/WORKFLOW.md"
