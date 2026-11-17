#!/usr/bin/env bash
# Approved design baseline; an exported delivery must declare its ops Git commit.
set -Eeuo pipefail
# shellcheck source=lib/common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib/common.sh"
install_traps
clean_secrets
unset PGHOST PGPORT PGUSER PGPASSFILE PGOPTIONS PGDATABASE PGSERVICE PGSERVICEFILE
export PYTHONDONTWRITEBYTECODE=1

help() {
    printf '%s\n' 'Linux installer; manual: ops/docs/linux-install.md (baseline main 8fb0645)' \
        'sudo bash install.sh run [--staging /home/USER/NEW-HANDOVER]' \
        'sudo bash install.sh resume | status | stage ID [--redo]' \
        'sudo bash install.sh verify-block ID' \
        'sudo bash install.sh retarget --database NEW --restore-dir NEW [--shared NEW]' \
        'sudo bash install.sh maintenance on|off|status' \
        'sudo bash install.sh check-config | diagnose' \
        'sudo bash install.sh stage 51 --restart-only' \
        'CP1 and CP2 require real client tests; 53a waits for a manual reboot.'
    printf 'Script SHA-256: '
    sha256sum "$INSTALL_ROOT/install.sh"
    if [[ -n ${SCRIPT_COMMIT-} ]]; then printf 'Delivered script commit: %s\n' "$SCRIPT_COMMIT"; fi
}

COMMAND=${1:-help}
if [[ $COMMAND == help || $COMMAND == --help ]]; then help; exit 0; fi
shift
require_identity
CURRENT_STAGE=$COMMAND
case $COMMAND in run|resume|stage|verify-block|retarget|status|maintenance|check-config|diagnose) ;; *) die 'Unknown command' ;; esac
MAINTENANCE_ACTION=''
if [[ $COMMAND == maintenance ]]; then
    [[ $# -gt 0 ]] || die 'Missing maintenance action'
    MAINTENANCE_ACTION=$1; shift
    case $MAINTENANCE_ACTION in on|off|status) ;; *) die 'Use maintenance on|off|status' ;; esac
fi
if [[ $COMMAND != status && $COMMAND != check-config && $COMMAND != diagnose && ! ( $COMMAND == maintenance && $MAINTENANCE_ACTION == status ) ]]; then lock_state; fi

STAGING=''
REQUESTED_STAGE='' REDO=0 RESTART_ONLY=0
NEW_DATABASE='' NEW_RESTORE='' NEW_SHARED=''
if [[ $COMMAND == stage || $COMMAND == verify-block ]]; then
    [[ $# -gt 0 ]] || die 'Missing stage or block ID'
    REQUESTED_STAGE=$1; shift
fi
while (( $# )); do
    case $1 in
        --staging) [[ $# -ge 2 ]] || die 'Missing staging path'; STAGING=$2; shift 2 ;;
        --redo) [[ $COMMAND == stage ]] || die '--redo requires stage'; REDO=1; shift ;;
        --restart-only) [[ $COMMAND == stage && $REQUESTED_STAGE == 51 ]] || die '--restart-only requires stage 51'; RESTART_ONLY=1; shift ;;
        --database) [[ $# -ge 2 ]] || die 'Missing database'; NEW_DATABASE=$2; shift 2 ;;
        --restore-dir) [[ $# -ge 2 ]] || die 'Missing restore directory'; NEW_RESTORE=$2; shift 2 ;;
        --shared) [[ $# -ge 2 ]] || die 'Missing shared path'; NEW_SHARED=$2; shift 2 ;;
        *) die 'Unknown argument' ;;
    esac
done

PENDING_BOOT=''
if [[ -e $STATE_FILE || -L $STATE_FILE ]]; then
    PENDING_BOOT=$(state pending "$STATE_FILE")
fi
if [[ $PENDING_BOOT == H10-LAND ]]; then
    SAVED_BINDING=$(state binding "$STATE_FILE")
    SAVED_STAGING=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["stagingDirectory"])' "$SAVED_BINDING")
    [[ $SAVED_STAGING == "$DEPLOY_HOME/"* ]] || die 'Pending landing belongs to another deployment HOME'
    INPUT=$SAVED_STAGING
elif [[ -e /srv/srvpro-input ]]; then INPUT=/srv/srvpro-input
else INPUT=$STAGING; fi
[[ -n $INPUT && -d $INPUT && ! -L $INPUT ]] || die 'Supply the new handover directory using --staging'
PARAMS=$INPUT/handover-params.json
[[ -f $PARAMS && ! -L $PARAMS ]] || die 'Missing machine-readable handover parameters'
DECLARED_STAGING=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["stagingDirectory"])' "$PARAMS")
if [[ -z $STAGING ]]; then STAGING=$DECLARED_STAGING; fi
[[ $STAGING == "$DECLARED_STAGING" ]] || die 'Staging argument differs from the bound parameter page'
[[ $STAGING == "$DEPLOY_HOME/"* && $(realpath -m -- "$STAGING") == "$STAGING" ]] || die 'Staging must be a canonical subdirectory of deploy HOME'
SCRIPT_COMMIT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["opsCommit"])' "$PARAMS")
[[ $SCRIPT_COMMIT =~ ^[0-9a-f]{40}$ ]] || die 'opsCommit must identify the exported script commit'
HANDOVER_DIGEST=$(state manifest "$INPUT")
BINDING=$(python3 "$INSTALL_ROOT/lib/checks.py" binding "$PARAMS" "$DEPLOY_UID" "$DEPLOY_HOME" "$SCRIPT_COMMIT" "$HANDOVER_DIGEST" "$INSTALL_ROOT")
if [[ -e $STATE_FILE || -L $STATE_FILE ]]; then
    OLD_BINDING=$(state binding "$STATE_FILE")
    state check-binding "$STATE_FILE" "$BINDING"
    BINDING=$OLD_BINDING
else
    [[ $COMMAND == run || $COMMAND == resume ]] || die 'No state; start with run'
    for target in /srv/srvpro-input /srv/srvprotianti /srv/srvprotianti-ops /etc/srvprotianti "$DEPLOY_HOME/srvpro-linux-work" /opt/node24; do
        [[ ! -e $target && ! -L $target ]] || die 'Missing state with existing installation targets'
    done
    # A pre-existing cluster or application roles are not a blank-machine install.
    if command -v pg_lsclusters >/dev/null && [[ -n $(pg_lsclusters --no-header) ]]; then
        die 'Missing state on a machine with an existing PostgreSQL cluster'
    fi
    state create "$STATE_FILE" "$BINDING"
fi
ROUTE=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["route"])' "$BINDING")
DATABASE=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["database"])' "$BINDING")
RESTORE=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["restoreDir"])' "$BINDING")
SHARED=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("shared","/srv/srvprotianti/shared"))' "$BINDING")
WORK=$DEPLOY_HOME/srvpro-linux-work
APP=/srv/srvprotianti/releases/linux-r4-1/application
PG_BIN=/usr/lib/postgresql/17/bin
# shellcheck source=lib/workflow.sh
source "$INSTALL_ROOT/lib/workflow.sh"
for file in "$INSTALL_ROOT"/stages/*.sh; do
    # shellcheck source=/dev/null
    source "$file"
done
order_blocks
state validate-blocks "$STATE_FILE" "${BLOCKS[@]}"
if [[ $COMMAND == status ]]; then
    state show "$STATE_FILE"
    NEXT_CHECKPOINT='complete (CP2 accepted and drained)'
    for id in "${BLOCKS[@]}"; do
        if ! block_done "$id"; then NEXT_CHECKPOINT="${BLOCK_STAGE[$id]} ($id)"; break; fi
    done
    say "Current checkpoint/stage: $NEXT_CHECKPOINT"
    help
    exit 0
fi

if [[ $COMMAND == maintenance ]]; then
    block_done M52-TOOL || die 'Complete stage 52a before using maintenance'
    SENSITIVE=1
    maintenance_call "$MAINTENANCE_ACTION"
    clean_secrets
    exit 0
fi
if [[ $COMMAND == check-config ]]; then
    config params /srv/srvpro-input/expected-config.json
    config diff /srv/srvpro-input/expected-config.json
    exit 0
fi
if [[ $COMMAND == diagnose ]]; then
    # Private read-only output; no reset-failed, reload, start or state writes.
    systemctl show srvprotianti.service postgresql@17-main.service -p LoadState -p ActiveState -p MainPID -p NRestarts -p ExecMainStartTimestamp
    ss -ltnp
    df -h /srv/srvprotianti
    namei -l /srv/srvprotianti/current/ygopro/replay
    runtime diagnose-journal
    exit 0
fi
if (( RESTART_ONLY )); then restart_only; exit 0; fi

if [[ $COMMAND == retarget ]]; then
    [[ $ROUTE == B && $NEW_DATABASE =~ ^[a-z_][a-z0-9_]*$ && ${#NEW_DATABASE} -le 63 ]] || die 'Retarget needs a fresh B database name'
    [[ $NEW_RESTORE == /private-restores/* && $(realpath -m -- "$NEW_RESTORE") == "$NEW_RESTORE" ]] || die 'Use a new canonical private restore directory'
    [[ ! -e $NEW_RESTORE && ! -L $NEW_RESTORE ]] || die 'Restore target exists'
    [[ $NEW_DATABASE != "$DATABASE" && $NEW_RESTORE != "$RESTORE" ]] || die 'Both targets must be fresh'
    [[ -z $PENDING_BOOT || $PENDING_BOOT == B33-* || $PENDING_BOOT == V34-* || $PENDING_BOOT == C43-* ]] || die 'Resolve the earlier pending block before retargeting'
    for id in "${BLOCKS[@]}"; do
        [[ ${BLOCK_STAGE[$id]} == 33 ]] && break
        block_done "$id" || die "Prerequisite $id incomplete"
    done
    [[ $(pg_scalar "SELECT count(*) FROM pg_database WHERE datname='$NEW_DATABASE'") == 0 ]] || die 'Database exists'
    SOURCE_DATABASE=$(python3 -c 'import json; print(json.load(open("/srv/srvpro-input/joint-batch/manifest.json"))["sourceDatabase"]["database"])')
    [[ $NEW_DATABASE != "$SOURCE_DATABASE" ]] || die 'Target equals source'
    if [[ -n $NEW_SHARED ]]; then
        [[ $NEW_SHARED == /srv/srvprotianti/* && $(realpath -m -- "$NEW_SHARED") == "$NEW_SHARED" && ! -e $NEW_SHARED && ! -L $NEW_SHARED ]] || die 'Shared target must be a fresh canonical directory'
    fi
    if block_done L41-ACCOUNT; then [[ -n $NEW_SHARED ]] || die 'Retarget after layout requires a fresh --shared target'; fi
    invalidated=()
    for id in "${BLOCKS[@]}"; do
        if [[ $id == L41-ACCOUNT ]]; then continue; fi
        case ${BLOCK_STAGE[$id]} in 10|12|21|22|23|31) ;; *) invalidated+=("$id") ;; esac
    done
    state retarget "$STATE_FILE" "$NEW_DATABASE" "$NEW_RESTORE" "$NEW_SHARED" "${invalidated[@]}"
    say 'PASS retarget: old database and restore directory retained; stages 33 onward invalidated'
    exit 0
fi

if [[ $COMMAND == verify-block ]]; then
    [[ -n ${BLOCK_ACTION[$REQUESTED_STAGE]-} ]] || die 'Unknown block or wrong route'
    CURRENT_BLOCK=$REQUESTED_STAGE CURRENT_STAGE=${BLOCK_STAGE[$REQUESTED_STAGE]}
    MANUAL_LINES=${BLOCK_LINES[$REQUESTED_STAGE]}
    SENSITIVE=${BLOCK_SECRET[$REQUESTED_STAGE]}
    BLOCK_EVIDENCE='{}'
    for id in "${BLOCKS[@]}"; do
        [[ $id == "$REQUESTED_STAGE" ]] && break
        block_done "$id" || die "Prerequisite $id incomplete"
    done
    probe_block "$REQUESTED_STAGE"
    complete_block "$REQUESTED_STAGE"
    exit 0
fi
recover_pending
if block_done H10-LAND; then
    INPUT=/srv/srvpro-input
    PARAMS=$INPUT/handover-params.json
    INSTALL_ROOT=$INPUT/ops/install/linux
fi
if [[ $COMMAND == stage ]]; then
    selected_stage "$REQUESTED_STAGE" "$REDO"
else
    COMPLETE_BEFORE_RUN=0
    if block_done CP2-DRAIN; then COMPLETE_BEFORE_RUN=1; fi
    for stage in "${STAGES[@]}"; do
        run_stage "$stage"
        if [[ $stage == 53a ]] && runtime same-boot "$STATE_FILE"; then
            say 'WAIT 53a: manually reboot THIS machine; wait at least five minutes before FIRST SSH login, then sudo bash install.sh run'
            exit 0
        fi
    done
    if (( COMPLETE_BEFORE_RUN )); then maintenance_drain; fi
    say 'PASS: CP1 and CP2 recorded; maintenance enabled and readyToStop=true. Formal opening remains a user decision.'
fi
