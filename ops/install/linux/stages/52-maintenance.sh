#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'Use install.sh\n' >&2; exit 1; }
# Manual L1093-1180, design 10.10/10.16/10.17; module replaces source extraction.
m52_tool() {
    test ! -e /etc/srvprotianti/maintenance.py
    test ! -L /etc/srvprotianti/maintenance.py
    install -m 0600 /srv/srvprotianti-ops/scripts/maintenance.py /etc/srvprotianti/maintenance.py
}
verify_m52_tool() {
    [[ -e /etc/srvprotianti/maintenance.py ]] || return 10
    [[ ! -L /etc/srvprotianti/maintenance.py && $(stat -c '%u:%a' /etc/srvprotianti/maintenance.py) == 0:600 ]] || return 20
    cmp -- /srv/srvprotianti-ops/scripts/maintenance.py /etc/srvprotianti/maintenance.py || return 20
}
m52_writers() {
    lifecycle create-writers
    lifecycle list-writers >/dev/tty
    ask_yes 'All writer units exist and are loaded; this is the complete writer list, including extra assets'
    maintenance_call status >/dev/tty
    BLOCK_EVIDENCE='{"confirmed":true}'
    unset MAINTENANCE_PASSWORD
}
verify_m52_writers() {
    lifecycle writers || return 20
    block_done M52-WRITERS || return 10
}
m52_stop() {
    # Never rely on a stale completed drain when starting/recovering this block.
    maintenance_drain
    local list name
    list=$(lifecycle list-writers)
    while IFS= read -r name; do systemctl stop "$name"; done <<< "$list"
    lifecycle inactive
    runtime ports-closed
}
verify_m52_stop() { lifecycle inactive || return 10; runtime ports-closed || return 10; }
m52_release_input() {
    if [[ $ROUTE == A ]]; then return 0; fi
    test ! -e /private-backups/release-input1
    test ! -L /private-backups/release-input1
    install -d -m 0700 /private-backups/release-input1
    cp -- /srv/srvpro-input/joint-batch/release.tar.gz /private-backups/release-input1/release.tar.gz
    cp -- /srv/srvpro-input/joint-batch/release.manifest.json /private-backups/release-input1/release.tar.gz.manifest.json
    chmod 0600 /private-backups/release-input1/release.tar.gz /private-backups/release-input1/release.tar.gz.manifest.json
    verify_m52_release_input
}
verify_m52_release_input() {
    [[ $ROUTE == A ]] && return 0
    [[ -e /private-backups/release-input1 ]] || return 10
    [[ ! -L /private-backups/release-input1 && $(stat -c '%u:%a' /private-backups/release-input1) == 0:700 ]] || return 20
    local name source
    for name in release.tar.gz release.tar.gz.manifest.json; do
        source=$name
        if [[ $name == release.tar.gz.manifest.json ]]; then source=release.manifest.json; fi
        [[ ! -L /private-backups/release-input1/$name && $(stat -c '%u:%a' "/private-backups/release-input1/$name") == 0:600 ]] || return 20
        cmp -- "/srv/srvpro-input/joint-batch/$source" "/private-backups/release-input1/$name" || return 20
    done
}
m52_plan() {
    lifecycle plan >/dev/tty
    ask_yes 'Complete backup plan: DB, release, new ELF/runtime, all shared/config/logs/assets and writers reviewed'
    BLOCK_EVIDENCE='{"confirmed":true}'
}
verify_m52_plan() { lifecycle verify-plan >/dev/null || return 20; block_done M52-PLAN || return 10; }
m52_backup() {
    local answer batch
    lifecycle inactive
    lifecycle verify-plan >/dev/null
    ask_text answer 'Create joint backup? (yes or skip; skip records NOT_BACKED_UP)'
    if [[ $answer == skip ]]; then BLOCK_EVIDENCE='{"backup":"NOT_BACKED_UP"}'; return 0; fi
    [[ $answer == yes ]] || die 'Expected yes or skip'
    batch=/private-backups/1103-$(date -u +%Y%m%dT%H%M%SZ)
    [[ ! -e $batch && ! -L $batch ]] || die 'Backup output must be new'
    # Persist destination BEFORE the first backup action so pending recovery can verify it.
    state backup-intent "$STATE_FILE" "$CURRENT_BLOCK" "$batch"
    PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator PGPASSFILE=/etc/srvprotianti/ops.pgpass \
        python3 /srv/srvprotianti-ops/scripts/ops.py backup --plan /etc/srvprotianti/backup-plan.json --output "$batch" --pg-bin "$PG_BIN"
    python3 /srv/srvprotianti-ops/scripts/ops.py verify --batch "$batch"
    [[ ! -e $batch/FAILED.json ]] || die 'Backup failed; preserve output'
    lifecycle inactive
    BLOCK_EVIDENCE=$(python3 -c 'import json,sys; print(json.dumps(dict(backup="verified",batch=sys.argv[1])))' "$batch")
}
verify_m52_backup() { BLOCK_EVIDENCE=$(runtime verify-backup "$STATE_FILE") || return 20; }

register_block M52-TOOL 52a first no 1093-1107 m52_tool verify_m52_tool
register_block M52-WRITERS 52a readonly yes 1093-1107 m52_writers verify_m52_writers 1
register_block M52-MAINTENANCE 52b idempotent yes 1113-1126 maintenance_drain repeat_readonly 1
register_block M52-STOP 52c idempotent yes 1133-1142 m52_stop verify_m52_stop 1
register_block M52-RELEASE-INPUT 52d first no 1151-1165 m52_release_input verify_m52_release_input
register_block M52-PLAN 52d readonly yes 1148-1167 m52_plan verify_m52_plan
register_block M52-BACKUP 52d first no 1169-1180 m52_backup verify_m52_backup
stage_main() { stage_blocks 52a; }
register_stage 52a
stage_main() { stage_blocks 52b; }
register_stage 52b
stage_main() { stage_blocks 52c; }
register_stage 52c
stage_main() { stage_blocks 52d; }
register_stage 52d
