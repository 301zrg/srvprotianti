#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'Use install.sh\n' >&2; exit 1; }
# Manual L1385-1404; preserve the old SSH connection until the new one is tested.
n61_firewall() {
    local port listeners cidr target
    listeners=$(runtime ssh-ports)
    say "Actual sshd listeners: $listeners" >/dev/tty
    port=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("sshPort"))' "$PARAMS")
    if [[ $port == None ]]; then
        port=$(python3 -c 'import json,sys; p=json.loads(sys.argv[1]); print(p[0] if len(p)==1 else "")' "$listeners")
        if [[ -n $port ]]; then
            ask_yes "Use discovered in-machine sshd port $port (not a host NAT forwarding port)"
        else
            ask_text port 'Confirm one actual in-machine sshd port above (not the host NAT forwarding port)'
        fi
    fi
    python3 -c 'import json,sys; assert sys.argv[1].isascii() and sys.argv[1].isdigit() and int(sys.argv[1]) in json.loads(sys.argv[2])' "$port" "$listeners"
    cidr=$(param testCidr)
    ufw allow "$port/tcp"
    while IFS= read -r target; do ufw allow from "$cidr" to any port "$target" proto tcp; done < <(python3 -c 'import json,sys; [print(v) for v in json.load(open(sys.argv[1]))["ports"].values()]' "$PARAMS")
    ufw --force enable
    runtime firewall "$port"
    ask_yes 'Keep this SSH connection open; open ANOTHER SSH connection and confirm login succeeded'
    BLOCK_EVIDENCE=$(python3 -c 'import json,sys; print(json.dumps(dict(sshPort=int(sys.argv[1]),newConnectionConfirmed=True)))' "$port")
}
verify_n61_firewall() { runtime verify-firewall "$STATE_FILE" || return 10; }
register_block N61-FIREWALL 61 idempotent yes 1385-1404 n61_firewall verify_n61_firewall
register_block CP1-CLIENT CP1 readonly no 1417-1434 client_accept verify_client_accept 1
stage_main() { stage_blocks 61; }
register_stage 61
stage_main() { stage_blocks CP1; }
register_stage CP1
