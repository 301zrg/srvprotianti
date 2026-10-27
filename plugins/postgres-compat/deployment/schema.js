#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {Client} = require('pg');
const {quote, equal, checkedContract} = require('./contract');

function argumentsFor(argv) {
  const args = {command: argv[0] || 'help'};
  const allowed = new Set(['database', 'runtime-role', 'confirm-empty', 'report']);
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index].replace(/^--/, '');
    if (!argv[index].startsWith('--') || !allowed.has(key) || !argv[index + 1] || argv[index + 1].startsWith('--') || args[key]) {
      throw new Error('Invalid or repeated argument: ' + argv[index]);
    }
    args[key] = argv[index + 1];
  }
  if (!['help', 'check-contract', 'init', 'grant', 'verify'].includes(args.command)) throw new Error('Unknown command.');
  if (['init', 'grant', 'verify'].includes(args.command) && (!args.database || !args['runtime-role'])) {
    throw new Error('--database and --runtime-role are required; database selection is never implicit.');
  }
  if (args.command === 'init' && args['confirm-empty'] !== args.database) throw new Error('init requires --confirm-empty equal to --database.');
  if (args.command !== 'init' && args['confirm-empty']) throw new Error('--confirm-empty is only valid for init.');
  return args;
}

function normalDefault(value) {
  if (value == null) return null;
  return String(value).replace(/::(?:character varying|text|integer|bigint|smallint|numeric)/g, '')
    .replace(/[()\s']/g, '').toLowerCase();
}

function compatibleType(expected, actual) {
  const required = expected.type + (expected.length ? '(' + expected.length + ')' : '');
  if (required === actual) return true;
  if (expected.type === 'integer' && actual === 'bigint') return true;
  if (expected.type === 'character varying') {
    const match = /^character varying\((\d+)\)$/.exec(actual);
    return !!match && Number(match[1]) >= Number(expected.length || 0);
  }
  return false;
}

function checkMatches(name, definition) {
  const value = definition.replace(/\s|[()"']/g, '').toLowerCase();
  const patterns = {
    ck_ladder_game_duel_count: /^checkduelcount>=1andduelcount<=3$/,
    ck_ladder_game_is_first: /^checkisfirst=anyarray\[0,1\]$/,
    ck_ladder_game_is_main: /^checkismain=anyarray\[0,1\]$/,
    ck_ladder_game_main_count: /^checkismain=casewhenduelcount=1then1else0end$/
  };
  return !!patterns[name] && patterns[name].test(value);
}

async function databaseIdentity(client, args) {
  const {rows: [identity]} = await client.query('SELECT current_database() AS database, current_user AS operator, current_setting(\'server_version\') AS version');
  if (identity.database !== args.database) throw new Error('Connected database does not match --database.');
  const {rows: [role]} = await client.query('SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1', [args['runtime-role']]);
  if (!role) throw new Error('Runtime role does not exist; create a dedicated LOGIN role first.');
  return {identity, role};
}

async function verify(client, tables, args) {
  const {identity, role} = await databaseIdentity(client, args);
  const errors = [], warnings = [], summaries = [];
  if (!role.rolcanlogin) errors.push('Runtime role must allow LOGIN.');
  if (['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'].some(key => role[key])) {
    errors.push('Runtime role has administrator capabilities; use a dedicated unprivileged role.');
  }
  const {rows: [permissions]} = await client.query(`SELECT
    has_schema_privilege($1, 'public', 'USAGE') AS schema_usage,
    has_schema_privilege($1, 'public', 'CREATE') AS schema_create,
    has_database_privilege($1, current_database(), 'CREATE') AS database_create,
    has_database_privilege($1, current_database(), 'CONNECT') AS database_connect`, [role.rolname]);
  if (!permissions.schema_usage) errors.push('Runtime role lacks public schema USAGE.');
  if (!permissions.database_connect) errors.push('Runtime role lacks database CONNECT.');
  if (permissions.schema_create || permissions.database_create) errors.push('Runtime role can create persistent schema objects; remove CREATE/ownership before production.');

  for (const table of tables) {
    const relation = 'public.' + quote(table.table);
    const {rows: [state]} = await client.query(`SELECT c.relkind, c.relrowsecurity, c.relforcerowsecurity,
      pg_has_role($2, c.relowner, 'MEMBER') AS owns_table,
      has_table_privilege($2, c.oid, 'SELECT') AS can_select,
      has_table_privilege($2, c.oid, 'INSERT') AS can_insert,
      has_table_privilege($2, c.oid, 'UPDATE') AS can_update,
      has_table_privilege($2, c.oid, 'DELETE') AS can_delete
      FROM pg_class c WHERE c.oid = to_regclass($1)`, [relation, role.rolname]);
    if (!state) { errors.push(table.table + ': missing table'); continue; }
    if (state.relkind !== 'r') errors.push(table.table + ': expected an ordinary table');
    if (state.relrowsecurity || state.relforcerowsecurity) errors.push(table.table + ': unexpected row-level security');
    if (state.owns_table) errors.push(table.table + ': runtime role owns or can assume ownership of the table');
    if (!state.can_select || !state.can_insert || !state.can_update || !state.can_delete) errors.push(table.table + ': runtime CRUD permissions incomplete');
    const {rows: columns} = await client.query(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
      NOT a.attnotnull AS nullable, a.attidentity AS identity, pg_get_expr(d.adbin, d.adrelid) AS default
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`, [relation]);
    for (const extra of columns.filter(column => !table.columns.some(required => required.name === column.name))) {
      if (!extra.nullable && extra.default == null && !extra.identity) errors.push(table.table + '.' + extra.name + ': additional NOT NULL column has no default and may block runtime inserts');
      else warnings.push(table.table + '.' + extra.name + ': additional historical column retained');
    }
    for (const required of table.columns) {
      const actual = columns.find(column => column.name === required.name);
      const label = table.table + '.' + required.name;
      if (!actual) { errors.push(label + ': missing column'); continue; }
      if (!compatibleType(required, actual.type)) errors.push(label + ': expected ' + required.type + (required.length ? '(' + required.length + ')' : '') + ', found ' + actual.type);
      if (!required.nullable && actual.nullable) errors.push(label + ': NOT NULL required');
      if (required.nullable && !actual.nullable) warnings.push(label + ': historical NOT NULL retained; bootstrap permits NULL');
      if (!required.generated && required.default !== undefined && normalDefault(actual.default) !== normalDefault(required.default)) {
        if (table.table === 'ladder_match_game' && ['duelCount', 'isFirst', 'isMain'].includes(required.name) && actual.default == null) {
          warnings.push(label + ': historical repair omitted the default; runtime supplies this value explicitly');
        } else errors.push(label + ': default differs from the current contract');
      }
      if (required.generated) {
        const {rows: [sequence]} = await client.query(`SELECT n.nspname AS schema, c.relname AS name, s.seqincrement AS increment,
          has_sequence_privilege($2, c.oid, 'USAGE') AS can_use,
          has_sequence_privilege($2, c.oid, 'SELECT') AS can_read
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_sequence s ON s.seqrelid = c.oid
          WHERE c.oid = to_regclass(pg_get_serial_sequence($1, $3))`, [relation, role.rolname, required.name]);
        if (!sequence) { errors.push(label + ': generated column has no owned sequence'); continue; }
        if (!sequence.can_use || !sequence.can_read) errors.push(label + ': runtime sequence permissions incomplete');
        const {rows: [position]} = await client.query('SELECT last_value::text, is_called FROM ' + quote(sequence.schema) + '.' + quote(sequence.name));
        const {rows: [maximum]} = await client.query('SELECT MAX(' + quote(required.name) + ')::text AS value FROM ' + relation);
        const increment = BigInt(sequence.increment);
        const next = BigInt(position.last_value) + (position.is_called ? increment : 0n);
        if (increment <= 0n || (maximum.value != null && next <= BigInt(maximum.value))) errors.push(label + ': sequence next value is not above the maximum stored ID');
      }
    }
    const {rows: indices} = await client.query(`SELECT i.indisunique AS unique, i.indisprimary AS primary,
      i.indisvalid AS valid, i.indisready AS ready, i.indpred IS NOT NULL AS partial,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num ORDER BY k.pos) AS columns
      FROM pg_index i WHERE i.indrelid = to_regclass($1)`, [relation]);
    const validIndex = (columns, unique, primary) => indices.some(index => index.valid && index.ready && !index.partial &&
      (!unique || index.unique) && (!primary || index.primary) && equal(index.columns, columns));
    if (!validIndex(table.columns.filter(column => column.primary).map(column => column.name), true, true)) errors.push(table.table + ': primary key missing or changed');
    for (const index of [...table.indices, ...table.uniques.map(item => ({...item, unique: true}))]) {
      if (!validIndex(index.columns, index.unique, false)) errors.push(table.table + ': index/unique contract missing: ' + index.columns.join(','));
    }
    const {rows: constraints} = await client.query(`SELECT c.conname AS name, c.contype AS type, c.convalidated AS validated,
      c.confdeltype AS on_delete, c.confupdtype AS on_update, rt.relname AS referenced_table, rn.nspname AS referenced_schema,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.pos) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, pos)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.pos) AS referenced_columns,
      pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
      LEFT JOIN pg_class rt ON rt.oid = c.confrelid LEFT JOIN pg_namespace rn ON rn.oid = rt.relnamespace WHERE c.conrelid = to_regclass($1)`, [relation]);
    const actions = {'NO ACTION': 'a', RESTRICT: 'r', CASCADE: 'c', 'SET NULL': 'n', 'SET DEFAULT': 'd'};
    for (const required of table.foreignKeys) {
      if (!constraints.some(actual => actual.type === 'f' && actual.validated && equal(actual.columns, required.columns) &&
        actual.referenced_table === required.referencedTable && actual.referenced_schema === 'public' && equal(actual.referenced_columns, required.referencedColumns) &&
        actual.on_delete === actions[required.onDelete] && actual.on_update === actions[required.onUpdate])) {
        errors.push(table.table + ': foreign key contract missing: ' + required.columns.join(','));
      }
    }
    for (const required of table.checks || []) {
      if (!constraints.some(actual => actual.type === 'c' && actual.validated && actual.name === required.name && checkMatches(required.name, actual.definition))) {
        errors.push(table.table + ': check constraint missing/changed: ' + required.name);
      }
    }
    const {rows: [count]} = await client.query('SELECT COUNT(*)::text AS rows FROM ' + relation);
    summaries.push({table: table.table, rows: count.rows});
  }
  return {formatVersion: 1, checkedAt: new Date().toISOString(), database: identity.database,
    postgresVersion: identity.version, runtimeRole: role.rolname, ok: !errors.length,
    tables: summaries, errors, warnings};
}

async function grant(client, tables, role) {
  // A dedicated application database should not inherit PostgreSQL <=14's
  // PUBLIC CREATE default. No password or global role attribute is modified.
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await client.query('REVOKE CREATE ON SCHEMA public FROM ' + quote(role));
  await client.query('REVOKE CREATE ON DATABASE ' + quote((await client.query('SELECT current_database() AS name')).rows[0].name) + ' FROM ' + quote(role));
  await client.query('GRANT USAGE ON SCHEMA public TO ' + quote(role));
  await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ' + tables.map(table => 'public.' + quote(table.table)).join(', ') + ' TO ' + quote(role));
  for (const table of tables) for (const column of table.columns.filter(item => item.generated)) {
    const {rows: [sequence]} = await client.query('SELECT pg_get_serial_sequence($1, $2) AS name', ['public.' + quote(table.table), column.name]);
    if (!sequence.name) throw new Error(table.table + '.' + column.name + ': missing generated sequence');
    // pg_get_serial_sequence returns a server-quoted SQL qualified identifier.
    await client.query('GRANT USAGE, SELECT ON SEQUENCE ' + sequence.name + ' TO ' + quote(role));
  }
}

async function main(argv) {
  const args = argumentsFor(argv);
  if (args.command === 'help') {
    console.log('schema.js check-contract | init --database DB --runtime-role ROLE --confirm-empty DB | grant/verify --database DB --runtime-role ROLE [--report FILE]\nUses standard PGHOST, PGPORT, PGUSER, PGPASSWORD/PGPASSFILE environment; never reads local config.json.');
    return;
  }
  const tables = checkedContract();
  if (args.command === 'check-contract') { console.log('Reviewed contract: ' + tables.length + ' tables; entity metadata and explicit SQL agree.'); return; }
  const client = new Client({database: args.database, application_name: 'srvprotianti-schema-tools', connectionTimeoutMillis: 10000});
  let transaction = false;
  try {
    await client.connect();
    const {identity} = await databaseIdentity(client, args);
    if (args.command !== 'verify') {
      if (identity.operator === args['runtime-role']) throw new Error('DDL/grants must run as a separate schema owner, not as the runtime role.');
      await client.query('BEGIN'); transaction = true;
      await client.query('SELECT pg_advisory_xact_lock(918271, hashtext(current_database()))');
      if (args.command === 'init') await client.query(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));
      await grant(client, tables, args['runtime-role']);
    } else {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    }
    const report = await verify(client, tables, args);
    if (!report.ok) {
      if (transaction) { await client.query('ROLLBACK'); transaction = false; }
      if (args.report) fs.writeFileSync(args.report, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
      console.log(JSON.stringify(report, null, 2));
      throw new Error('Schema verification failed; no initialization/grant transaction committed.');
    }
    if (transaction) { await client.query('COMMIT'); transaction = false; }
    if (args.report) fs.writeFileSync(args.report, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    await client.end();
  }
}

module.exports = {argumentsFor, compatibleType, normalDefault, checkMatches, verify, grant, main};
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  // Authentication errors can echo a username, but never print connection
  // options, environment variables, passwords, or a complete connection URL.
  console.error('schema tool failed: ' + error.message); process.exitCode = 1;
});
