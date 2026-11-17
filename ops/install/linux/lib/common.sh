#!/usr/bin/env bash
# The entry point owns strict mode. Stage functions must be called directly.
umask 077
set +x
INSTALL_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
STATE_DIR=/var/lib/srvprotianti-install
STATE_FILE=$STATE_DIR/state.json
CURRENT_STAGE=bootstrap CURRENT_BLOCK=bootstrap MANUAL_LINES=none SENSITIVE=0
exec {REPORT_FD}>&2
SECRET_NAMES=(RUNTIME_PASSWORD OPERATOR_PASSWORD PGPASSWORD MAINTENANCE_PASSWORD)
SAFE_PATH=/opt/node24/bin:/usr/local/bin:/usr/bin:/bin
export PATH=/opt/node24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

state() { python3 "$INSTALL_ROOT/lib/state.py" "$@"; }

clean_secrets() {
    local key
    for key in "${SECRET_NAMES[@]}"; do unset "$key"; done
}

say() {
    local message=$* key value
    for key in "${SECRET_NAMES[@]}"; do
        value=${!key-}
        if [[ -n $value ]]; then message=${message//"$value"/***}; fi
    done
    printf '%s\n' "$message"
    if [[ -n ${LOG_FILE-} ]]; then printf '%s\n' "$message" >> "$LOG_FILE"; fi
}

die() { say "FAIL $CURRENT_STAGE/$CURRENT_BLOCK: $*; preserve evidence, use status and verify-block" >&"$REPORT_FD"; exit 1; }

on_error() {
    local code=$1 command=$2 function=$3
    trap - ERR
    if (( SENSITIVE )); then
        say "FAIL $CURRENT_STAGE/$CURRENT_BLOCK exit=$code (sensitive block)" >&"$REPORT_FD"
    else
        say "FAIL $CURRENT_STAGE/$CURRENT_BLOCK function=$function manual=$MANUAL_LINES exit=$code command=$command" >&"$REPORT_FD"
    fi
    exit "$code"
}

on_exit() {
    local code=$?
    clean_secrets
    if (( code != 0 )); then say "FAIL $CURRENT_STAGE: stopped ($code); pending retained; inspect status" >&"$REPORT_FD"; fi
}

install_traps() {
    trap 'on_error "$?" "$BASH_COMMAND" "${FUNCNAME[0]:-main}"' ERR
    trap on_exit EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    trap 'exit 129' HUP
}

# All interaction is through a controlling terminal, never inherited stdin.
ask_text() {
    local name=$1 prompt=$2 value
    printf '%s: ' "$prompt" >/dev/tty
    IFS= read -r value </dev/tty
    [[ -n $value && $value != *$'\r'* ]] || die 'Invalid checkpoint input'
    printf -v "$name" '%s' "$value"
}

ask_yes() {
    local answer
    ask_text answer "$* (type yes)"
    [[ $answer == yes ]] || die 'Checkpoint not accepted'
}

read_secret() {
    local destination=$1 prompt=$2 value='' character
    printf '%s: ' "$prompt" >/dev/tty
    # -d NUL + one character distinguishes NUL from Enter (plain read drops NUL).
    while true; do
        character=''
        IFS= read -r -s -n 1 -d '' character </dev/tty
        if [[ $character == $'\n' ]]; then break; fi
        [[ -n $character && $character != $'\r' ]] || die 'Invalid password character'
        value+=$character
    done
    printf '\n' >/dev/tty
    [[ -n $value ]] || die 'Empty password'
    printf -v "$destination" '%s' "$value"
}

ask_password() {
    local destination=$1 prompt=$2 first second
    read_secret first "$prompt"
    read_secret second 'Repeat password'
    [[ $first == "$second" ]] || die 'Passwords differ'
    printf -v "$destination" '%s' "$first"
    unset first second
}

require_identity() {
    [[ $EUID == 0 && -n ${SUDO_USER-} && $SUDO_USER != root ]] || die 'Run with sudo from the deployment account'
    [[ $SUDO_USER =~ ^[a-zA-Z_][a-zA-Z0-9_.-]*\$?$ ]] || die 'Invalid sudo account name'
    local record account ignored gid gecos shell
    record=$(getent passwd "$SUDO_USER")
    IFS=: read -r account ignored DEPLOY_UID gid gecos DEPLOY_HOME shell <<< "$record"
    [[ $account == "$SUDO_USER" && $DEPLOY_UID =~ ^[0-9]+$ && $DEPLOY_UID != 0 && $DEPLOY_HOME == /* ]] || die 'Invalid deployment account'
    DEPLOY_USER=$account
    [[ -d $DEPLOY_HOME && $(realpath -e -- "$DEPLOY_HOME") == "$DEPLOY_HOME" ]] || die 'Deployment HOME must be a canonical existing directory'
    hostnamectl </dev/null
    # shellcheck disable=SC1091
    . /etc/os-release
    [[ $ID == ubuntu && $VERSION_ID == 24.04 && $(uname -m) == x86_64 ]] || die 'Requires Ubuntu 24.04 x86_64'
}

lock_state() {
    [[ ! -L $STATE_DIR ]] || die 'State directory is a link'
    if [[ ! -e $STATE_DIR ]]; then install -d -m 0700 -o root -g root "$STATE_DIR"; fi
    [[ $(stat -c '%u:%a' "$STATE_DIR") == 0:700 ]] || die 'Invalid state directory ownership or mode'
    [[ ! -L $STATE_DIR/lock ]] || die 'Lock is a link'
    if [[ -e $STATE_DIR/lock ]]; then [[ -f $STATE_DIR/lock && $(stat -c '%u:%a' "$STATE_DIR/lock") == 0:600 ]] || die 'Invalid lock file'; fi
    exec {LOCK_FD}>"$STATE_DIR/lock"
    chmod 0600 "$STATE_DIR/lock"
    flock -n "$LOCK_FD" || die 'Another installer holds the lock'
    install -d -m 0700 "$STATE_DIR/logs"
    LOG_FILE=$(mktemp "$STATE_DIR/logs/$(date -u +%Y%m%dT%H%M%SZ)-${CURRENT_STAGE}-XXXXXX.log")
    chmod 0600 "$LOG_FILE"
}

stage_log() {
    if [[ -d $STATE_DIR/logs ]]; then
        LOG_FILE=$(mktemp "$STATE_DIR/logs/$(date -u +%Y%m%dT%H%M%SZ)-$CURRENT_STAGE-XXXXXX.log")
        chmod 0600 "$LOG_FILE"
    fi
}

# The body is never an argument containing a password. Secrets are inherited only
# by the immediate consuming process, not by a runuser command line.
as_user() {
    local user=$1 home=$2 directory=$3 body=$4
    shift 4
    local preamble item
    for item in "$@"; do
        [[ $item =~ ^MIN_FREE_GIB=[0-9]+$ ]] || die 'Environment variable is outside the child whitelist'
    done
    printf -v preamble 'set -Eeuo pipefail\ntrap '\''printf "FAIL block=%%s manual=%%s exit=%%s\\n" %q %q "$?" >&2'\'' ERR\ncd -- %q\n' "$CURRENT_BLOCK" "$MANUAL_LINES" "$directory"
    runuser -u "$user" -- env -i HOME="$home" USER="$user" LOGNAME="$user" \
        PATH="$SAFE_PATH" LANG=C.UTF-8 "$@" bash --noprofile --norc -c "$preamble$body" </dev/null
}

as_deploy() { as_user "$DEPLOY_USER" "$DEPLOY_HOME" "$@"; }
as_postgres() { as_user postgres /var/lib/postgresql / "$@"; }
as_srvpro() { as_user srvpro /srv/srvprotianti "$@"; }

declare -a BLOCKS=()
declare -A BLOCK_STAGE=() BLOCK_KIND=() BLOCK_REDO=() BLOCK_LINES=() BLOCK_ACTION=() BLOCK_VERIFY=() BLOCK_SECRET=() STAGE_MAIN=()

register_block() {
    local id=$1
    BLOCKS+=("$id")
    BLOCK_STAGE[$id]=$2 BLOCK_KIND[$id]=$3 BLOCK_REDO[$id]=$4 BLOCK_LINES[$id]=$5
    BLOCK_ACTION[$id]=$6 BLOCK_VERIFY[$id]=$7 BLOCK_SECRET[$id]=${8:-0}
}

block_done() { state 'done' "$STATE_FILE" "$1"; }

# A verifier returns 0=complete, 10=not started, 20=partial/unknown.
# It may not repair anything or persist reports.
probe_block() {
    local id=$1 result=0
    "${BLOCK_VERIFY[$id]}" || result=$?
    case $result in 0|10|20) ;; *) result=20 ;; esac
    return "$result"
}

complete_block() {
    local id=$1
    local evidence=${BLOCK_EVIDENCE:-'{}'}
    state complete "$STATE_FILE" "$id" "$evidence"
    say "PASS $id"
}

recover_pending() {
    local pending result=0
    pending=$(state pending "$STATE_FILE")
    [[ -n $pending ]] || return 0
    [[ -n ${BLOCK_ACTION[$pending]-} ]] || die 'Unknown pending block'
    CURRENT_BLOCK=$pending CURRENT_STAGE=${BLOCK_STAGE[$pending]} MANUAL_LINES=${BLOCK_LINES[$pending]}
    SENSITIVE=${BLOCK_SECRET[$pending]}
    stage_log
    BLOCK_EVIDENCE='{}'
    probe_block "$pending" || result=$?
    if (( result == 0 )); then
        complete_block "$pending"
    elif (( result == 10 )) && [[ ${BLOCK_KIND[$pending]} != first ]]; then
        state clear-pending "$STATE_FILE" "$pending"
    else
        die 'Pending action is partial or uncertain; use read-only verify-block after manual recovery; B uses retarget with fresh targets'
    fi
}

run_block() {
    local id=$1
    CURRENT_STAGE=${BLOCK_STAGE[$id]} CURRENT_BLOCK=$id MANUAL_LINES=${BLOCK_LINES[$id]}
    if block_done "$id"; then say "SKIP $id"; return 0; fi
    SENSITIVE=${BLOCK_SECRET[$id]}
    BLOCK_EVIDENCE='{}'
    state begin "$STATE_FILE" "$id"
    # Do not put this invocation in a conditional, pipeline, || or && list.
    if (( SENSITIVE )); then
        "${BLOCK_ACTION[$id]}" </dev/null >/dev/null 2>/dev/null
    else
        "${BLOCK_ACTION[$id]}" </dev/null >>"$LOG_FILE" 2>&1
    fi
    complete_block "$id"
    clean_secrets
    SENSITIVE=0
}

run_stage() {
    local stage=$1 id previous
    CURRENT_STAGE=$stage
    stage_log
    for id in "${BLOCKS[@]}"; do
        previous=${BLOCK_STAGE[$id]}
        [[ $previous == "$stage" ]] && break
        block_done "$id" || die "Prerequisite $id is incomplete"
    done
    "${STAGE_MAIN[$stage]}"
    say "PASS $stage"
}

# Called from each stage's stage_main; keeps the state machine at one boundary.
stage_blocks() {
    local stage=$1 id
    for id in "${BLOCKS[@]}"; do
        if [[ ${BLOCK_STAGE[$id]} == "$stage" ]]; then run_block "$id"; fi
    done
}

register_stage() {
    local stage=$1 definition
    definition=$(declare -f stage_main)
    definition=${definition/stage_main/installer_stage_$stage}
    eval "$definition"
    STAGE_MAIN[$stage]=installer_stage_$stage
}

redo_stage() {
    local stage=$1 id found=0
    local -a invalidated=()
    for id in "${BLOCKS[@]}"; do
        if [[ ${BLOCK_STAGE[$id]} == "$stage" ]]; then
            [[ ${BLOCK_REDO[$id]} == yes ]] || die "$id cannot be redone; preserve targets and follow the manual"
            found=1
        fi
        if (( found )); then invalidated+=("$id"); fi
    done
    (( found )) || die 'Unknown stage'
    say "Invalidating downstream: ${invalidated[*]}"
    state invalidate "$STATE_FILE" "${invalidated[@]}"
}

selected_stage() {
    local request=$1 redo=$2 id prerequisite block found=0
    local -a invalidated=()
    if [[ -n ${BLOCK_STAGE[$request]-} ]]; then
        id=$request
        for prerequisite in "${BLOCKS[@]}"; do
            [[ $prerequisite == "$id" ]] && break
            block_done "$prerequisite" || die "Prerequisite $prerequisite incomplete"
        done
        if block_done "$id" && [[ ${BLOCK_KIND[$id]} == first ]]; then die 'Cannot replay a completed first action; verify-block after manual correction, or B retarget with fresh targets'; fi
        if (( redo )); then
            [[ ${BLOCK_REDO[$id]} == yes ]] || die 'Block is not redoable'
            for block in "${BLOCKS[@]}"; do
                if [[ $block == "$id" ]]; then found=1; fi
                if (( found )); then invalidated+=("$block"); fi
            done
            say "Invalidating downstream: ${invalidated[*]}"
            state invalidate "$STATE_FILE" "${invalidated[@]}"
        fi
        run_block "$id"
        return 0
    fi
    [[ -n ${STAGE_MAIN[$request]-} ]] || die 'Unknown stage'
    [[ ! ( $request == 32 && $ROUTE == B ) && ! ( $request == 33 && $ROUTE == A ) ]] || die 'Stage is on the other route'
    if (( redo )); then redo_stage "$request"; fi
    if (( ! redo )); then
        for id in "${BLOCKS[@]}"; do
            if [[ ${BLOCK_STAGE[$id]} == "$request" && ${BLOCK_KIND[$id]} == first ]] && block_done "$id"; then
                die 'Completed first action cannot be rerun; use verify-block after manual correction'
            fi
        done
    fi
    run_stage "$request"
}
