'use strict';

const assert = require('assert');
const fs = require('fs');
const {checkedContract} = require('./contract');
const {argumentsFor, compatibleType, normalDefault, checkMatches} = require('./schema');

assert.throws(() => argumentsFor(['init', '--database', 'a', '--runtime-role', 'r']), /confirm-empty/);
assert.throws(() => argumentsFor(['init', '--database', 'a', '--runtime-role', 'r', '--confirm-empty', 'b']), /confirm-empty/);
assert.throws(() => argumentsFor(['verify', '--database', 'a']), /runtime-role/);
assert.throws(() => argumentsFor(['verify', '--database', 'a', '--database', 'b']), /repeated/);
assert.throws(() => argumentsFor(['grant', '--database', 'a', '--runtime-role', 'r', '--confirm-empty', 'a']), /only valid/);
assert.strictEqual(argumentsFor(['verify', '--database', 'a', '--runtime-role', 'r']).database, 'a');
assert(compatibleType({type: 'integer'}, 'bigint'));
assert(!compatibleType({type: 'bigint'}, 'integer'));
assert(!compatibleType({type: 'timestamp without time zone'}, 'timestamp with time zone'));
assert(!compatibleType({type: 'character varying', length: '64'}, 'character varying(20)'));
assert.strictEqual(normalDefault("'0'::integer"), normalDefault('0'));
assert(!checkMatches('ck_ladder_game_is_first', 'CHECK (("isFirst" = ANY (ARRAY[0, 1, 2])))'));
assert(checkMatches('ck_ladder_game_is_first', 'CHECK (("isFirst" = ANY (ARRAY[0, 1])))'));
assert.strictEqual(checkedContract().length, 20);
const readFile = fs.readFileSync;
try {
  fs.readFileSync = function(filename, ...args) {
    const value = readFile.call(this, filename, ...args);
    return String(filename).endsWith('bootstrap.sql') ? value.replace(/\r?\n/g, '\r\n') : value;
  };
  assert.strictEqual(checkedContract().length, 20, 'A Windows checkout must retain the same reviewed SQL contract');
  fs.readFileSync = function(filename, ...args) {
    const value = readFile.call(this, filename, ...args);
    return String(filename).endsWith('bootstrap.sql') ? value + '\nSELECT 1;\n' : value;
  };
  assert.throws(() => checkedContract(), /bootstrap.sql differs/, 'SQL modifications still require review');
} finally { fs.readFileSync = readFile; }
console.log('PostgreSQL deployment argument, compatibility, CHECK, and entity/DDL contract tests passed.');
