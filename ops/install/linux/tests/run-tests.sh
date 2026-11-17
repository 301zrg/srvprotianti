#!/usr/bin/env bash
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
mapfile -t scripts < <(find "$ROOT" -name '*.sh' -type f | sort)
for script in "${scripts[@]}"; do bash -n "$script"; done
# Stage globals are consumed by common.sh; deferred single-quoted bodies are
# intentionally expanded only inside the clean deployment-user shell.
shellcheck -x -P SCRIPTDIR -e SC2034,SC2016 "${scripts[@]}"
python3 "$ROOT/tests/test_contracts.py"
bats "$ROOT/tests/glue.bats"
