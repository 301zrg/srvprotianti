#!/usr/bin/env bash
[[ ${BASH_SOURCE[0]} != "$0" ]] || { printf 'FAIL: source this stage through install.sh\n' >&2; exit 1; }
pg_scalar() {
    local sql=$1 quoted
    printf -v quoted '%q' "$sql"
    as_postgres "/usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -At -d postgres -c $quoted"
}

# Manual L406-413, R31-DIRECTORIES. Interactive psql is replaced by R31-ROLES.
r31_directories() {
    cd -- / || return
    test ! -e /etc/srvprotianti
    install -d -m 0700 /etc/srvprotianti /etc/srvprotianti/reports /private-restores /private-backups
}
verify_r31_directories() {
    local target
    local -a targets=(/etc/srvprotianti /etc/srvprotianti/reports /private-restores /private-backups)
    if targets_absent "${targets[@]}"; then return 10; fi
    for target in "${targets[@]}"; do
        [[ -d $target && ! -L $target && $(stat -c '%u:%g:%a' "$target") == 0:0:700 ]] || return 20
    done
}

# Manual L417-423, R31-ROLES; same SQL under postgres peer identity.
r31_roles() {
    as_postgres '/usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -d postgres <<'\''SQL'\''
CREATE ROLE srvpro_schema NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE srvpro_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE srvpro_operator LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT srvpro_schema TO srvpro_operator;
SQL'
}
verify_r31_roles() {
    local count
    count=$(pg_scalar "SELECT count(*) FROM pg_roles WHERE rolname IN ('srvpro_schema','srvpro_runtime','srvpro_operator')") || return 20
    if [[ $count == 0 ]]; then return 10; fi
    [[ $count == 3 ]] || return 20
    [[ $(pg_scalar "SELECT count(*) FROM pg_roles WHERE rolname IN ('srvpro_schema','srvpro_runtime','srvpro_operator') AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND rolcanlogin=(rolname<>'srvpro_schema')") == 3 ]] || return 20
    [[ $(pg_scalar "SELECT pg_has_role('srvpro_operator','srvpro_schema','MEMBER')") == t ]] || return 20
    [[ $(pg_scalar "SELECT rolinherit FROM pg_roles WHERE rolname='srvpro_operator'") == t ]] || return 20
}

# Manual L428-444, R31-PASSWORDS; secrets go only to the SQL producer environment.
r31_passwords() {
    ask_password RUNTIME_PASSWORD 'New PostgreSQL runtime password'
    ask_password OPERATOR_PASSWORD 'New PostgreSQL operator password'
    RUNTIME_PASSWORD=$RUNTIME_PASSWORD OPERATOR_PASSWORD=$OPERATOR_PASSWORD python3 - <<'PY' | runuser -u postgres -- env -i HOME=/var/lib/postgresql USER=postgres LOGNAME=postgres PATH="$SAFE_PATH" LANG=C.UTF-8 /usr/lib/postgresql/17/bin/psql -X -v ON_ERROR_STOP=1 -d postgres
import os
print('SET standard_conforming_strings = on;')
for role, key in [('srvpro_runtime', 'RUNTIME_PASSWORD'), ('srvpro_operator', 'OPERATOR_PASSWORD')]:
    value = os.environ[key]
    assert value and not any(c in value for c in '\r\n\x00'), 'Invalid password'
    print("ALTER ROLE " + role + " PASSWORD '" + value.replace("'", "''") + "';")
PY
    # Passfile is part of the same sensitive block, so no secret survives it.
    OPERATOR_PASSWORD=$OPERATOR_PASSWORD python3 - <<'PY'
import os
value = os.environ['OPERATOR_PASSWORD'].replace('\\', '\\\\').replace(':', '\\:')
with open('/etc/srvprotianti/ops.pgpass', 'x', encoding='utf-8') as f:
    f.write('127.0.0.1:5432:*:srvpro_operator:' + value + '\n')
os.chmod('/etc/srvprotianti/ops.pgpass', 0o600)
PY
    unset RUNTIME_PASSWORD OPERATOR_PASSWORD
}
verify_r31_passwords() {
    [[ -f /etc/srvprotianti/ops.pgpass && ! -L /etc/srvprotianti/ops.pgpass && $(stat -c '%u:%g:%a' /etc/srvprotianti/ops.pgpass) == 0:0:600 ]] || return 20
    # The private passfile proves operator authentication. Runtime must be challenged
    # rather than inferred from a stored hash after an interrupted password block.
    PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_operator PGPASSFILE=/etc/srvprotianti/ops.pgpass \
        "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -d postgres -Atc 'SELECT 1' >/dev/null 2>/dev/null || return 20
    local result=0
    read_secret PGPASSWORD 'Verify the chosen runtime password'
    PGHOST=127.0.0.1 PGPORT=5432 PGUSER=srvpro_runtime PGPASSWORD=$PGPASSWORD \
        "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -d postgres -Atc 'SELECT 1' >/dev/null 2>/dev/null || result=20
    unset PGPASSWORD
    return "$result"
}

register_block R31-DIRECTORIES 31 first no 406-413 r31_directories verify_r31_directories
register_block R31-ROLES 31 first no 417-423 r31_roles verify_r31_roles
register_block R31-PASSWORDS 31 first no 428-453 r31_passwords verify_r31_passwords 1

# Entry for stage 31; registered before the next sourced stage replaces it.
stage_main() { stage_blocks 31; }
register_stage 31
