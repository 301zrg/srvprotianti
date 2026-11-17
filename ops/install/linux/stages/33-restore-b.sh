#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'FAIL: source this stage through install.sh\n' >&2; exit 1; }
# Manual L507-523, B33-VERIFY; verify before any restore target action.
b33_verify() {
    cd /
    python3 /srv/srvprotianti-ops/scripts/ops.py verify --batch /srv/srvpro-input/joint-batch
    python3 - /srv/srvpro-input/joint-batch/manifest.json "$DATABASE" <<'PY'
import json, sys
m = json.load(open(sys.argv[1], encoding='utf-8'))
print('batch:', m['batchId'], 'source:', m['sourceDatabase'], 'dump major:', m['pgDumpMajor'])
assert m['pgDumpMajor'] == 17, 'This route needs a PG17 dump'
assert m['sourceDatabase']['serverVersionNum'] // 10000 == 17, 'This route needs a PG17 source'
assert m['sourceDatabase']['database'] != sys.argv[2], 'Choose another NEW target name'
PY
}
verify_b33_verify() { b33_verify >/dev/null 2>/dev/null; }

# Manual L531-540, B33-DATABASE; 10.7 allows the explicitly retargeted name.
b33_database() {
    [[ $DATABASE =~ ^[a-z_][a-z0-9_]*$ && ${#DATABASE} -le 63 ]] || die 'Invalid target name'
    local body
    printf -v body '/usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -d postgres <<'\''SQL'\''\nCREATE DATABASE %s OWNER srvpro_schema\n  LOCALE_PROVIDER builtin BUILTIN_LOCALE '\''C.UTF-8'\''\n  ENCODING '\''UTF8'\'' TEMPLATE template0;\n\\connect %s\nALTER SCHEMA public OWNER TO srvpro_schema;\nREVOKE CREATE ON SCHEMA public FROM PUBLIC;\nGRANT CONNECT ON DATABASE %s TO srvpro_runtime, srvpro_operator;\nSQL' "$DATABASE" "$DATABASE" "$DATABASE"
    as_postgres "$body"
}
verify_b33_database() {
    [[ $(pg_scalar "SELECT count(*) FROM pg_database WHERE datname='$DATABASE'") != 0 ]] || return 10
    [[ $(pg_scalar "SELECT count(*) FROM pg_database WHERE datname='$DATABASE' AND pg_get_userbyid(datdba)='srvpro_schema' AND datlocprovider='b' AND datlocale='C.UTF-8' AND pg_encoding_to_char(encoding)='UTF8'") == 1 ]] || return 20
    local body quoted
    printf -v quoted '%q' "SELECT pg_get_userbyid(nspowner)='srvpro_schema' AND NOT EXISTS (SELECT FROM aclexplode(nspacl) WHERE grantee=0 AND privilege_type='CREATE') FROM pg_namespace WHERE nspname='public'"
    printf -v body '/usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -At -d %q -c %s' "$DATABASE" "$quoted"
    [[ $(as_postgres "$body") == t ]] || return 20
    [[ $(pg_scalar "SELECT count(DISTINCT a.grantee) FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a JOIN pg_roles r ON r.oid=a.grantee WHERE d.datname='$DATABASE' AND r.rolname IN ('srvpro_runtime','srvpro_operator') AND a.privilege_type='CONNECT'") == 2 ]] || return 20
}

# Manual L549-576, B33-RESTORE; retain failed database/directory, never reuse them.
b33_restore() {
    cd /srv/srvprotianti/releases/linux-r4-1/application
    PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator PGPASSFILE=/etc/srvprotianti/ops.pgpass \
        python3 /srv/srvprotianti-ops/scripts/ops.py restore --batch /srv/srvpro-input/joint-batch \
        --destination "$RESTORE" --database "$DATABASE" --confirm-new-database "$DATABASE" \
        --owner-role srvpro_schema --runtime-role srvpro_runtime \
        --schema-tool "$APP/plugins/postgres-compat/deployment/schema.js" --pg-bin /usr/lib/postgresql/17/bin
    printf '%s\n' "$DATABASE" > /etc/srvprotianti/database-name
    python3 "$INSTALL_ROOT/lib/checks.py" restore "$RESTORE" "$DATABASE"
    BLOCK_EVIDENCE=$(python3 - "$RESTORE/restore-result.json" <<'PY'
import hashlib, json, pathlib, sys
p = pathlib.Path(sys.argv[1])
r = json.loads(p.read_text('utf-8'))
print(json.dumps({'restoreResultSha256': hashlib.sha256(p.read_bytes()).hexdigest(),
                  'batchId': r['batchId'], 'databaseStateVerification': r['databaseStateVerification']}))
PY
)
}
verify_b33_restore() {
    [[ -e $RESTORE ]] || return 10
    python3 "$INSTALL_ROOT/lib/checks.py" restore "$RESTORE" "$DATABASE" >/dev/null 2>/dev/null || return 20
    [[ -f /etc/srvprotianti/database-name && $(cat /etc/srvprotianti/database-name) == "$DATABASE" ]] || return 20
    cd "$APP" || return 20
    PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator PGPASSFILE=/etc/srvprotianti/ops.pgpass \
        node plugins/postgres-compat/deployment/schema.js verify --database "$DATABASE" --runtime-role srvpro_runtime >/dev/null 2>/dev/null || return 20
}

# Manual L615-622, B33-LOCALE-CONNECT; no interactive psql left waiting for stdin.
b33_locale_connect() {
    PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator PGPASSFILE=/etc/srvprotianti/ops.pgpass \
        PGOPTIONS='-c default_transaction_read_only=on' /usr/lib/postgresql/17/bin/psql -X \
        -v ON_ERROR_STOP=1 -d "$DATABASE" -c 'SELECT current_database();'
}
verify_b33_locale_connect() { b33_locale_connect >/dev/null 2>/dev/null; }

# Manual L626-635, B33-LOCALE; these five queries are preserved verbatim.
b33_locale() {
    cd /
    PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator PGPASSFILE=/etc/srvprotianti/ops.pgpass \
        PGOPTIONS='-c default_transaction_read_only=on' /usr/lib/postgresql/17/bin/psql -X \
        -v ON_ERROR_STOP=1 -d "$DATABASE" -o /etc/srvprotianti/reports/locale-check.txt <<'SQL'
BEGIN READ ONLY;
SELECT datname, datlocprovider, datlocale, pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database();
SELECT (SELECT count(*) FROM public."user") AS accounts, (SELECT count(*) FROM public.ladder_user) AS ladder_users, (SELECT count(*) FROM public.ladder_match) AS matches, (SELECT count(*) FROM public.duel_log) AS duels;
SELECT name, "displayName" FROM public.ladder_user ORDER BY name LIMIT 20;
SELECT value FROM (VALUES ('中文'), ('阿'), ('中'), ('A'), ('a'), ('é'), (' e'), ('e ')) AS samples(value) ORDER BY value;
SELECT name, count(*) FROM public.ladder_user GROUP BY name HAVING count(*) > 1;
COMMIT;
SQL
    chmod 0600 /etc/srvprotianti/reports/locale-check.txt
    b33_locale_guard
}

# Manual L637-640 success predicates, shared read-only guard.
b33_locale_guard() {
    verify_b33_database || return 20
    PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator PGPASSFILE=/etc/srvprotianti/ops.pgpass \
        python3 - "$DATABASE" <<'PY'
import json, os, subprocess, sys
m = json.load(open('/srv/srvpro-input/joint-batch/manifest.json', encoding='utf-8'))
rows = {row['table']: row['rows'] for row in m['databaseState']['tables'] if row['schema'] == 'public'}
base = ['/usr/lib/postgresql/17/bin/psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-d', sys.argv[1], '-c']
env = dict(os.environ, PGOPTIONS='-c default_transaction_read_only=on')
for name in ('user', 'ladder_user', 'ladder_match', 'duel_log'):
    count = subprocess.check_output(base + ['SELECT count(*) FROM public."' + name + '"'], env=env, text=True).strip()
    assert int(count) == rows[name], 'Row count differs from batch'
duplicates = subprocess.check_output(base + ['SELECT count(*) FROM (SELECT name FROM public.ladder_user GROUP BY name HAVING count(*) > 1) x'], env=env, text=True).strip()
assert duplicates == '0', 'Duplicate ladder names'
PY
}
verify_b33_locale() {
    [[ -s /etc/srvprotianti/reports/locale-check.txt ]] || return 10
    b33_locale_guard || return 20
}

# Manual L637-640, B33-ACCEPT; explicit acceptance with inspector, batch and target.
b33_accept() {
    local accepted inspector report_sha batch
    cat /etc/srvprotianti/reports/locale-check.txt >/dev/tty
    ask_text accepted 'Review the five locale queries; type 排序差异已接受'
    [[ $accepted == '排序差异已接受' ]] || die 'Locale differences have not been accepted'
    ask_text inspector 'Inspector name'
    report_sha=$(state sha /etc/srvprotianti/reports/locale-check.txt)
    batch=$(python3 -c 'import json; print(json.load(open("/srv/srvpro-input/joint-batch/manifest.json"))["batchId"])')
    BLOCK_EVIDENCE=$(python3 - "$inspector" "$DATABASE" "$batch" "$report_sha" <<'PY'
import datetime, json, sys
print(json.dumps(dict(zip(('inspector','database','batchId','localeReportSha256'), sys.argv[1:])) |
                 {'accepted': '排序差异已接受', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}, ensure_ascii=False))
PY
)
}
verify_b33_accept() {
    # No durable approval means repeat the checkpoint, never infer acceptance.
    if block_done B33-ACCEPT; then return 0; fi
    return 10
}

if [[ $ROUTE == B ]]; then
    register_block B33-VERIFY 33 readonly yes 507-523 b33_verify verify_b33_verify 1
    register_block B33-DATABASE 33 first no 531-540 b33_database verify_b33_database
    register_block B33-RESTORE 33 first no 549-576 b33_restore verify_b33_restore 1
    register_block B33-LOCALE-CONNECT 33 readonly yes 615-622 b33_locale_connect verify_b33_locale_connect
    register_block B33-LOCALE 33 readonly yes 626-635 b33_locale verify_b33_locale
    register_block B33-ACCEPT 33 readonly yes 637-640 b33_accept verify_b33_accept
fi

# Entry for stage 33; registered before the next sourced stage replaces it.
stage_main() { stage_blocks 33; }
register_stage 33
