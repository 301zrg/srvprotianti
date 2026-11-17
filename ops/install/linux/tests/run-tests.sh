#!/usr/bin/env bash
set -Eeuo pipefail
export PYTHONDONTWRITEBYTECODE=1
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
mapfile -t scripts < <(find "$ROOT" -name '*.sh' -type f | sort)
for script in "${scripts[@]}"; do bash -n "$script"; done
# Stage globals are consumed by common.sh; deferred single-quoted bodies are
# intentionally expanded only inside the clean deployment-user shell.
# Each stage's stage_main is copied under a new name by register_stage and called indirectly (SC2317).
shellcheck -x -P SCRIPTDIR -e SC2034,SC2016,SC2317 "${scripts[@]}"
python3 "$ROOT/tests/test_contracts.py"
python3 "$ROOT/tests/test_workflow.py"
python3 "$ROOT/../../tests/test_handover.py"
python3 "$ROOT/../../tests/test_maintenance.py"
bats "$ROOT/tests/glue.bats" "$ROOT/tests/workflow.bats"
