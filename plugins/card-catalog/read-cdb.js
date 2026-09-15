'use strict';

const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

(async () => {
  const filename = process.argv[2];
  const mode = process.argv[3];
  if (!filename || !['metadata', 'names'].includes(mode)) throw new Error('Usage: read-cdb.js <file> <metadata|names>');
  const SQL = await initSqlJs();
  const buffer = await fs.promises.readFile(filename);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const database = new SQL.Database(buffer);
  try {
    const sql = mode === 'metadata'
      ? 'SELECT d.id, d.type, d.alias, t.name FROM datas d LEFT JOIN texts t ON t.id = d.id'
      : 'SELECT t.id, t.name FROM texts t';
    process.stdout.write(JSON.stringify({sha256, rows: database.exec(sql)[0]?.values || []}));
  } finally {
    database.close();
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
