#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'FAIL: source this stage through install.sh\n' >&2; exit 1; }
# Manual L463-468, A32-CONNECT; noninteractive read-only peer connection.
a32_connect() { as_postgres '/usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -d postgres -c "SELECT current_database();"'; }
verify_a32_connect() { a32_connect; }

# Manual L472-479, A32-DATABASE; SQL unchanged, no DROP or takeover.
a32_database() {
    as_postgres '/usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -d postgres <<'\''SQL'\''
CREATE DATABASE srvpro_1103 OWNER srvpro_schema TEMPLATE template0 ENCODING '\''UTF8'\'' LOCALE_PROVIDER libc LC_COLLATE '\''C'\'' LC_CTYPE '\''C'\'';
\connect srvpro_1103
ALTER SCHEMA public OWNER TO srvpro_schema;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE srvpro_1103 TO srvpro_runtime, srvpro_operator;
SQL'
}
verify_a32_database() {
    [[ $(pg_scalar "SELECT count(*) FROM pg_database WHERE datname='srvpro_1103'") != 0 ]] || return 10
    [[ $(pg_scalar "SELECT count(*) FROM pg_database WHERE datname='srvpro_1103' AND pg_get_userbyid(datdba)='srvpro_schema' AND datlocprovider='c' AND datcollate='C' AND datctype='C' AND pg_encoding_to_char(encoding)='UTF8'") == 1 ]] || return 20
    as_postgres '/usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -At -d srvpro_1103 -c "SELECT pg_get_userbyid(nspowner)='\''srvpro_schema'\'' AND NOT EXISTS (SELECT FROM aclexplode(nspacl) WHERE grantee=0 AND privilege_type='\''CREATE'\'') FROM pg_namespace WHERE nspname='\''public'\''"' | grep -qx t || return 20
    [[ $(pg_scalar "SELECT count(DISTINCT a.grantee) FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a JOIN pg_roles r ON r.oid=a.grantee WHERE d.datname='srvpro_1103' AND r.rolname IN ('srvpro_runtime','srvpro_operator') AND a.privilege_type='CONNECT'") == 2 ]] || return 20
}

# Manual L483-495, A32-INIT; same root identity and schema-owner PGOPTIONS.
a32_init() {
    cd -- /srv/srvprotianti/releases/linux-r4-1/application || return
    node plugins/postgres-compat/deployment/schema.js check-contract
    PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator PGPASSFILE=/etc/srvprotianti/ops.pgpass \
        PGOPTIONS='-c role=srvpro_schema' node plugins/postgres-compat/deployment/schema.js init \
        --database srvpro_1103 --runtime-role srvpro_runtime --confirm-empty srvpro_1103 \
        --report /etc/srvprotianti/reports/schema-init.json
    printf 'srvpro_1103\n' > /etc/srvprotianti/database-name
    python3 "$INSTALL_ROOT/lib/checks.py" report /etc/srvprotianti/reports/schema-init.json
}
verify_a32_init() {
    # verify has no --report: it cannot repair schema, grants or a missing selector.
    cd -- /srv/srvprotianti/releases/linux-r4-1/application || return 20
    PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator PGPASSFILE=/etc/srvprotianti/ops.pgpass \
        node plugins/postgres-compat/deployment/schema.js verify --database srvpro_1103 --runtime-role srvpro_runtime >/dev/null 2>/dev/null || return 20
    [[ -f /etc/srvprotianti/database-name && $(cat /etc/srvprotianti/database-name) == srvpro_1103 ]] || return 20
}

if [[ $ROUTE == A ]]; then
    register_block A32-CONNECT 32 readonly yes 463-468 a32_connect verify_a32_connect
    register_block A32-DATABASE 32 first no 472-479 a32_database verify_a32_database
    register_block A32-INIT 32 first no 483-495 a32_init verify_a32_init
fi

# Entry for stage 32; registered before the next sourced stage replaces it.
stage_main() { stage_blocks 32; }
register_stage 32
