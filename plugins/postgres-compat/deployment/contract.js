'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../../..');
const quote = value => '"' + String(value).replace(/"/g, '""') + '"';
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Build metadata without connecting to any database or loading local config.
// Keep this separate from DataManager: a deployment must never run synchronize.
function currentEntities() {
  require('reflect-metadata');
  global.PrimaryKeyType = 'bigint';
  global.DbDateType = 'timestamp';
  const {Connection} = require('typeorm');
  const connection = new Connection({
    type: 'postgres', database: 'offline_contract', username: 'offline_contract',
    synchronize: false,
    entities: [path.join(root, 'data-manager/entities/*.js').replace(/\\/g, '/'),
      ...Object.values(require('../../ladder-core/entities')),
      ...Object.values(require('../../ladder-usage-analytics/entities'))]
  });
  connection.buildMetadatas();
  return connection.entityMetadatas.map(entity => ({
    table: entity.tableName,
    columns: entity.columns.map(column => ({
      name: column.databaseName, type: connection.driver.normalizeType(column),
      length: column.length || '', nullable: column.isNullable,
      primary: column.isPrimary, generated: column.isGenerated,
      ...(column.default === undefined ? {} : {default: connection.driver.normalizeDefault(column)})
    })),
    indices: entity.indices.map(index => ({name: index.name,
      columns: index.columns.map(column => column.databaseName), unique: !!index.isUnique})),
    uniques: entity.uniques.map(index => ({name: index.name,
      columns: index.columns.map(column => column.databaseName)})),
    foreignKeys: entity.foreignKeys.map(key => ({name: key.name,
      columns: key.columns.map(column => column.databaseName),
      referencedTable: key.referencedEntityMetadata.tableName,
      referencedColumns: key.referencedColumns.map(column => column.databaseName),
      onDelete: key.onDelete || 'NO ACTION', onUpdate: key.onUpdate || 'NO ACTION'}))
  })).sort((left, right) => left.table.localeCompare(right.table, 'en'));
}

function deploymentContract(entities) {
  const tables = JSON.parse(JSON.stringify(entities));
  const table = name => tables.find(item => item.table === name);
  const widen = (tableName, names) => table(tableName).columns.filter(column => names.includes(column.name))
    .forEach(column => { column.type = 'bigint'; });
  // Reviewed PostgreSQL migration contracts intentionally widen Number-backed
  // EntitySchema columns. Ordinary startup cannot safely reconcile this drift.
  widen('ladder_match', ['duelLogId']);
  widen('ladder_match_game', ['id', 'matchId', 'duelLogId']);
  widen('ladder_usage_sample', ['id', 'matchId']);
  widen('ladder_deck_card_fact', ['id', 'sampleId']);
  ['ladder_usage_daily_deck', 'ladder_usage_daily_card', 'ladder_usage_total_card']
    .forEach(name => widen(name, ['id']));
  table('ladder_deck_card_fact').foreignKeys.push({name: 'fk_ladder_card_fact_sample',
    columns: ['sampleId'], referencedTable: 'ladder_usage_sample', referencedColumns: ['id'],
    onDelete: 'CASCADE', onUpdate: 'NO ACTION'});
  table('ladder_match_game').indices.push({name: 'ix_ladder_game_duel_log', columns: ['duelLogId'], unique: false});
  table('ladder_match').indices.push(
    {name: 'ix_ladder_match_player_a_time', columns: ['playerAName', 'createTime'], unique: false, descending: ['createTime']},
    {name: 'ix_ladder_match_player_b_time', columns: ['playerBName', 'createTime'], unique: false, descending: ['createTime']});
  table('ladder_match_game').checks = [
    {name: 'ck_ladder_game_duel_count', expression: '"duelCount" BETWEEN 1 AND 3'},
    {name: 'ck_ladder_game_is_first', expression: '"isFirst" IN (0, 1)'},
    {name: 'ck_ladder_game_is_main', expression: '"isMain" IN (0, 1)'},
    {name: 'ck_ladder_game_main_count', expression: '"isMain" = CASE WHEN "duelCount" = 1 THEN 1 ELSE 0 END'}
  ];
  return tables;
}

function renderBootstrap(tables) {
  const lines = [
    '-- srvprotianti PostgreSQL fresh-install schema, reviewed 2026-10-10.',
    '-- Run through deployment/schema.js init, which adds a transaction, target',
    '-- database confirmation, maintenance advisory lock, and runtime grants.',
    '-- Never apply this file to a restored database or as a history migration.',
    'SET LOCAL search_path = public, pg_catalog;',
    "DO $empty$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') OR EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') THEN RAISE EXCEPTION 'Bootstrap requires an empty database; restore/upgrade must use verify instead'; END IF; END $empty$;",
    ''
  ];
  for (const table of tables) {
    const columns = table.columns.map(column => {
      let type = column.generated ? (column.type === 'bigint' ? 'bigserial' : 'serial') : column.type;
      if (column.length) type += '(' + column.length + ')';
      return '  ' + quote(column.name) + ' ' + type + (column.nullable ? '' : ' NOT NULL') +
        (column.default === undefined || column.generated ? '' : ' DEFAULT ' + column.default);
    });
    columns.push('  PRIMARY KEY (' + table.columns.filter(column => column.primary).map(column => quote(column.name)).join(', ') + ')');
    for (const unique of table.uniques) columns.push('  CONSTRAINT ' + quote(unique.name) + ' UNIQUE (' + unique.columns.map(quote).join(', ') + ')');
    for (const check of table.checks || []) columns.push('  CONSTRAINT ' + quote(check.name) + ' CHECK (' + check.expression + ')');
    lines.push('CREATE TABLE public.' + quote(table.table) + ' (', columns.join(',\n'), ');', '');
  }
  for (const table of tables) {
    for (const index of table.indices) lines.push('CREATE ' + (index.unique ? 'UNIQUE ' : '') + 'INDEX ' + quote(index.name) +
      ' ON public.' + quote(table.table) + ' (' + index.columns.map(column => quote(column) +
        ((index.descending || []).includes(column) ? ' DESC' : '')).join(', ') + ');');
    for (const key of table.foreignKeys) lines.push('ALTER TABLE public.' + quote(table.table) + ' ADD CONSTRAINT ' + quote(key.name) +
      ' FOREIGN KEY (' + key.columns.map(quote).join(', ') + ') REFERENCES public.' + quote(key.referencedTable) +
      ' (' + key.referencedColumns.map(quote).join(', ') + ') ON DELETE ' + key.onDelete + ' ON UPDATE ' + key.onUpdate + ';');
  }
  return lines.join('\n') + '\n';
}

function checkedContract() {
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'entity-contract.json'), 'utf8'));
  if (!equal(snapshot, currentEntities())) throw new Error('Entity metadata changed; review and update deployment DDL and entity-contract.json before deploying.');
  const tables = deploymentContract(snapshot);
  if (fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8') !== renderBootstrap(tables)) {
    throw new Error('bootstrap.sql differs from the reviewed deployment contract.');
  }
  return tables;
}

module.exports = {root, quote, equal, currentEntities, deploymentContract, renderBootstrap, checkedContract};
