'use strict';

require('reflect-metadata');
const fs = require('fs');
const path = require('path');
const {PluginHost} = require('../../plugin-system');
const {LadderUsageSample} = require('./entities');

const CONFIRMATION = 'APPLY-LADDER-USAGE-BACKFILL';
const rootDir = path.resolve(__dirname, '../..');

function usage() {
  return [
    'Usage:',
    '  node plugins/ladder-usage-analytics/backfill.js audit --use-host-config',
    '  node plugins/ladder-usage-analytics/backfill.js simulate --use-host-config',
    `  node plugins/ladder-usage-analytics/backfill.js apply --use-host-config --confirm ${CONFIRMATION}`,
    '',
    'Run only after applying migrations/202609-player-usage/001-create-usage-projections.sql.'
  ].join('\n');
}

function parseArgs(argv) {
  const args = argv.slice(2), mode = args.shift() || 'audit';
  if (!['audit', 'simulate', 'apply'].includes(mode)) throw new Error(usage());
  const result = {mode, useHostConfig: false, confirm: null};
  while (args.length) {
    const value = args.shift();
    if (value === '--use-host-config') result.useHostConfig = true;
    else if (value === '--confirm') result.confirm = args.shift();
    else if (value === '--help' || value === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${value}\n${usage()}`);
  }
  if (!result.useHostConfig) throw new Error(`--use-host-config is required.\n${usage()}`);
  if (mode === 'apply' && result.confirm !== CONFIRMATION) throw new Error(`Apply requires --confirm ${CONFIRMATION}`);
  return result;
}

async function createRuntime() {
  const settings = JSON.parse(fs.readFileSync(path.join(rootDir, 'config/config.json'), 'utf8'));
  const runtime = {databaseConfig: settings.modules?.mysql?.db || {}, maintenanceTool: 'ladder-usage-backfill'};
  const log = {info() {}, warn(value, message) {
    if (message) console.error(message);
    if (value?.err) console.error(value.err.stack || value.err);
    else if (!message && value) console.error(value.stack || value.message || value);
  }};
  const host = new PluginHost(path.join(rootDir, 'plugins'), log);
  await host.register({settings, log, runtime});
  global.PrimaryKeyType = runtime.databaseConfig.type === 'sqlite' || runtime.databaseConfig.type === 'sqljs' ? 'integer' : 'bigint';
  global.DbDateType = runtime.databaseConfig.type === 'postgres' ? 'timestamp' : 'datetime';
  const {DataManager} = require('../../data-manager/DataManager');
  const dataManager = new DataManager(runtime.databaseConfig, log);
  dataManager.registerEntities(host.entities);
  await dataManager.init();
  await host.init({settings, log, dataManager, runtime});
  return {host, dataManager};
}

async function counts(dataManager, ladderCore) {
  return {
    matches: await ladderCore.getRepository('LadderMatch').count(),
    samples: await dataManager.getRepository(LadderUsageSample).count()
  };
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) return console.log(usage());
  const {host, dataManager} = await createRuntime();
  try {
    const ladderCore = host.services.get('ladderCore');
    const before = await counts(dataManager, ladderCore);
    const expectedSamples = before.matches * 2;
    console.log(JSON.stringify({mode: options.mode, before, expectedSamples, missingAtMost: Math.max(0, expectedSamples - before.samples)}, null, 2));
    if (options.mode !== 'apply') return;
    if (!host.services.get('cardCatalog')?.metadataAvailable) {
      throw new Error('The authoritative cards.zh.cdb could not be loaded; refusing to create incomplete projections.');
    }
    const service = host.services.get('ladderUsageAnalytics');
    let cursor = 0, projected = 0;
    for (;;) {
      const rows = await ladderCore.getRepository('LadderMatch').createQueryBuilder('m').select('m.id', 'id')
        .where('m.id > :cursor', {cursor}).orderBy('m.id', 'ASC').limit(100).getRawMany();
      if (!rows.length) break;
      for (const row of rows) {
        const id = Number(row.id);
        projected += Number((await service.projectOneMatch(id)).projected || 0);
        cursor = id;
      }
      console.log(`Processed through match ${cursor}; inserted ${projected} samples.`);
    }
    console.log(JSON.stringify({mode: 'verify', projected, after: await counts(dataManager, ladderCore)}, null, 2));
  } finally {
    await dataManager.getConnection().close();
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
module.exports = {parseArgs, usage, CONFIRMATION};
