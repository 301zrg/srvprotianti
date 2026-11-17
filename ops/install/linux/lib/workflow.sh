#!/usr/bin/env bash
# Shared stage 4-6 glue; all human input remains in common.sh.
config() { python3 "$INSTALL_ROOT/lib/configuration.py" "$1" "$PARAMS" "$SHARED" "$APP" "${@:2}"; }
lifecycle() { python3 "$INSTALL_ROOT/lib/lifecycle.py" "$1" "$PARAMS" "$SHARED" "$DATABASE" "$ROUTE" "$STATE_FILE" "${@:2}"; }
runtime() { python3 "$INSTALL_ROOT/lib/runtime.py" "$1" "$PARAMS" "$SHARED" "$APP" "${@:2}"; }
param() { python3 -c 'import json,sys; x=json.load(open(sys.argv[1])); print(x[sys.argv[2]])' "$PARAMS" "$1"; }
not_proven() { return 20; }
repeat_readonly() { return 10; }

maintenance_call() {
    local action=$1
    if [[ -z ${MAINTENANCE_PASSWORD-} ]]; then read_secret MAINTENANCE_PASSWORD 'HTTP management password'; fi
    MAINTENANCE_PASSWORD=$MAINTENANCE_PASSWORD python3 /etc/srvprotianti/maintenance.py "$action" \
        --port "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ports"]["http"])' "$PARAMS")" \
        --username "$(param managementUsername)" --message "$(param maintenanceMessage)"
}

maintenance_drain() {
    local response
    response=$(maintenance_call on)
    python3 -c 'import json,sys; x=json.loads(sys.argv[1]); assert x["maintenanceEnabled"] is True and x["readyToStop"] is True' "$response" \
        || die 'Waiting for natural drain: readyToStop is not true; run again after games/persistence finish'
    BLOCK_EVIDENCE='{"maintenanceEnabled":true,"readyToStop":true}'
    unset MAINTENANCE_PASSWORD
}

config_equivalence() {
    local rows key reason inspector approvals='[]' signature
    rows=$(config diff /srv/srvpro-input/expected-config.json)
    signature=$(runtime config-signature)
    if [[ $rows != '[]' ]]; then
        ask_text inspector 'Configuration difference approver'
        while IFS= read -r key; do
            say "Configuration difference (values withheld): $key" >/dev/tty
            ask_text reason 'Reason for accepting this key (no credentials)'
            ask_yes 'Approve this explained difference'
            approvals=$(python3 -c 'import json,sys; a=json.loads(sys.argv[1]); a.append(dict(key=json.loads(sys.argv[2]),reason=sys.argv[3])); print(json.dumps(a,ensure_ascii=False))' "$approvals" "$key" "$reason")
        done < <(python3 -c 'import json,sys; [print(json.dumps(k,ensure_ascii=False)) for k in json.loads(sys.argv[1])]' "$rows")
    else inspector=$DEPLOY_USER; fi
    BLOCK_EVIDENCE=$(python3 -c 'import json,sys,datetime; print(json.dumps(dict(signature=sys.argv[1],approver=sys.argv[2],differences=json.loads(sys.argv[3]),at=datetime.datetime.now(datetime.timezone.utc).isoformat()),ensure_ascii=False))' "$signature" "$inspector" "$approvals")
}
verify_equivalence() { runtime verify-equivalence "$STATE_FILE" "$CURRENT_BLOCK" || return 10; }

client_accept() {
    local inspector
    maintenance_call off >/dev/null
    say 'Client checks: plugins/four languages; registration; B old account/score/history; normal game; TT Match/side/one settlement/usage; reconnect/spectate; old and NEW replay download; room/card restrictions.' >/dev/tty
    say 'Record engine SHA/Core/Lua/build flags/resource digests. CP2 MUST test NEW registration/settlement/replay writes after reboot.' >/dev/tty
    ask_text inspector 'Actual client inspector'
    ask_yes 'All required real client checks passed and evidence recorded'
    maintenance_call on >/dev/null
    BLOCK_EVIDENCE=$(python3 -c 'import json,sys,datetime; print(json.dumps(dict(inspector=sys.argv[1],accepted=True,at=datetime.datetime.now(datetime.timezone.utc).isoformat()),ensure_ascii=False))' "$inspector")
    unset MAINTENANCE_PASSWORD
}

verify_client_accept() {
    runtime accepted "$STATE_FILE" "$CURRENT_BLOCK" || return 10
}

order_blocks() {
    local stage id
    local -a ordered=()
    STAGES=(10 12 21 22 23 31)
    if [[ $ROUTE == A ]]; then STAGES+=(32); else STAGES+=(33); fi
    STAGES+=(34 41)
    if [[ $ROUTE == A ]]; then STAGES+=(42); else STAGES+=(43); fi
    STAGES+=(44 45 46 51 52a 61 CP1 52b 52c 52d 53a 53b CP2)
    for stage in "${STAGES[@]}"; do
        for id in "${BLOCKS[@]}"; do
            if [[ ${BLOCK_STAGE[$id]} == "$stage" ]]; then ordered+=("$id"); fi
        done
    done
    BLOCKS=("${ordered[@]}")
}
