'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {createDeckCardUsage} = require('./deck-card-usage');
const {periodBounds} = require('./index')._test;

const metadata = [578, 258, 581, 777].map(id => ({id, names: {zh: `卡组${id}`, ja: `デッキ${id}`}}));
const classifier = {listDeckMetadata: () => metadata};
const catalog = {get: (id, lang) => ({name: `${lang}:${id}`})};

async function fixture() {
  const SQL = await require('sql.js')();
  const db = new SQL.Database();
  db.run('CREATE TABLE ladder_usage_sample (id INTEGER PRIMARY KEY,"deckTypeId" INTEGER,"dayKey" TEXT,"cardValid" INTEGER); CREATE TABLE ladder_deck_card_fact ("sampleId" INTEGER,"cardId" INTEGER,zone TEXT,copies INTEGER)');
  for (const row of [[1,578,'20261001',1],[2,578,'20261002',1],[3,578,'20261003',0],[4,258,'20261001',1],[5,578,'20260930',1],[6,578,'20261031',1],[7,578,'20261101',1]]) db.run('INSERT INTO ladder_usage_sample VALUES (?,?,?,?)', row);
  for (const row of [[1,100,'monster',1],[2,100,'monster',2],[6,100,'monster',3],[1,200,'monster',1],[3,999,'monster',1],[4,999,'monster',1],[5,100,'monster',3],[7,100,'monster',1],[1,100,'side',1],[2,100,'side',2],[6,300,'extra',3],[2,400,'spell',2]]) db.run('INSERT INTO ladder_deck_card_fact VALUES (?,?,?,?)',row);
  const calls = {connections:0,released:0};
  const dataManager = {getConnection: () => ({options:{type:'sqljs'},createQueryRunner() {
    calls.connections++;
    return {async connect() {},async release() { calls.released++; },async query(sql,params) {
      const statement = db.prepare(sql);
      try { statement.bind(params); const rows=[]; while (statement.step()) rows.push(statement.getAsObject()); return rows; }
      finally { statement.free(); }
    }};
  }})};
  return {db,calls,service:createDeckCardUsage({dataManager,classifier,catalog,periodBounds})};
}

test('card adoption uses only the selected type, period and valid samples, preserving zones and copy counts', async () => {
  const {db,service} = await fixture();
  try {
    const result = await service.query({deckTypeId:578,period:'month',month:'202610',lang:'ja'});
    assert.deepEqual(result.coverage,{allDecks:4,validCardDecks:3});
    assert.equal(result.selected.id,578);
    assert.equal(result.month,'202610');
    assert.equal(result.cards.monster.length,2);
    assert.deepEqual(result.cards.monster[0],{rank:1,cardId:100,name:'ja:100',deckCount:3,usageRate:1,copies1:1,copies2:1,copies3:1});
    assert.equal(result.cards.monster[1].usageRate,1/3);
    assert.equal(result.cards.side[0].deckCount,2);
    assert.equal(result.cards.side[0].usageRate,2/3);
    assert.equal(result.cards.extra[0].copies3,1);
    assert.deepEqual(result.cards.trap,[]);
    const all = await service.query({deckTypeId:578,period:'all'});
    assert.deepEqual(all.coverage,{allDecks:6,validCardDecks:5});
    assert.equal(all.cards.monster[0].deckCount,5);
    const empty = await service.query({deckTypeId:777,period:'all'});
    assert.deepEqual(empty.coverage,{allDecks:0,validCardDecks:0});
    assert.ok(Object.values(empty.cards).every(rows=>rows.length===0));
  } finally { db.close(); }
});

test('ranked results cap each zone independently and callers cannot mutate cached aggregates', async () => {
  const {db,service,calls} = await fixture();
  try {
    for (let i=0;i<205;i++) db.run('INSERT INTO ladder_deck_card_fact VALUES (1,?,\'spell\',1)',[1000+i]);
    const input = {deckTypeId:578,period:'month',month:'202610'};
    const first = await service.query(input);
    assert.equal(first.cards.spell.length,200);
    assert.equal(first.cards.spell[0].cardId,400);
    assert.equal(first.cards.spell[199].cardId,1198);
    assert.equal(first.cards.monster.length,2);
    first.cards.monster[0].deckCount=999;
    const cached = await service.query({...input,lang:'ja'});
    assert.equal(cached.cards.monster[0].deckCount,3);
    assert.equal(cached.cards.monster[0].name,'ja:100');
    assert.equal(calls.connections,1,'language changes reuse numeric aggregates');
    service.invalidate();
    db.run('UPDATE ladder_usage_sample SET "cardValid"=0 WHERE id=1');
    const changed = await service.query(input);
    assert.equal(changed.coverage.validCardDecks,2);
    assert.equal(changed.cards.monster[0].deckCount,2);
    assert.equal(calls.connections,2);
    assert.equal(calls.released,2);
  } finally { db.close(); }
});

test('invalid identifiers and time filters are rejected before opening a database connection', async () => {
  const {db,service,calls} = await fixture();
  try {
    for (const input of [{deckTypeId:'578 OR 1=1'},{deckTypeId:4095},{deckTypeId:9999},{deckTypeId:578,period:'bad'},{deckTypeId:578,period:'month',month:'202613'}]) {
      await assert.rejects(service.query(input),error=>error.statusCode===400);
    }
    assert.equal(calls.connections,0);
  } finally { db.close(); }
});

test('expired aggregates and the oldest of more than sixteen scopes are queried again',async t=>{
  const {db,service,calls}=await fixture();
  let now=Date.now();
  t.mock.method(Date,'now',()=>now);
  try {
    await service.query({deckTypeId:578,period:'all'});
    await service.query({deckTypeId:578,period:'all'});
    assert.equal(calls.connections,1);
    now+=30001;
    await service.query({deckTypeId:578,period:'all'});
    assert.equal(calls.connections,2,'expired results must not stay resident indefinitely');
    const months=['202501','202502','202503','202504','202505','202506','202507','202508','202509','202510','202511','202512','202601','202602','202603','202604','202605'];
    for(const month of months) await service.query({deckTypeId:578,period:'month',month});
    assert.equal(calls.connections,19);
    await service.query({deckTypeId:578,period:'month',month:'202501'});
    assert.equal(calls.connections,20,'the oldest scope must be evicted when cache capacity is exceeded');
  } finally { db.close(); }
});

function blockedFixture(failure) {
  let release;
  const barrier = new Promise(resolve=>{release=resolve;});
  const calls={connections:0,released:0,rollbacks:0,commits:0,statements:[]};
  const dataManager={getConnection:()=>({options:{type:'postgres'},createQueryRunner() {
    calls.connections++;
    return {isTransactionActive:false,async connect(){},async startTransaction(level){assert.equal(level,'REPEATABLE READ');this.isTransactionActive=true;},async query(sql) {
      calls.statements.push(sql);
      if(sql.startsWith('SELECT COUNT')) { await barrier; if(failure) throw Object.assign(new Error('private details'),{code:failure}); return [{allDecks:3,validCardDecks:2}]; }
      return sql.startsWith('WITH')?[{zone:'monster',cardId:100,rank:1,deckCount:1,copies1:1,copies2:0,copies3:0}]:[];
    },async commitTransaction(){calls.commits++;this.isTransactionActive=false;},async rollbackTransaction(){calls.rollbacks++;this.isTransactionActive=false;},async release(){calls.released++;}};
  }})};
  return {calls,release,service:createDeckCardUsage({dataManager,classifier,catalog,periodBounds})};
}

test('identical requests coalesce, distinct queries are bounded and invalidation excludes old in-flight cache writes',async()=>{
  const {service,calls,release}=blockedFixture();
  const a=service.query({deckTypeId:578,period:'all'});
  const duplicate=service.query({deckTypeId:578,period:'all',lang:'ja'});
  const b=service.query({deckTypeId:258,period:'all'});
  await assert.rejects(service.query({deckTypeId:581,period:'all'}),error=>error.statusCode===429);
  assert.equal(calls.connections,2);
  service.invalidate(); release();
  const [first,translated]=await Promise.all([a,duplicate,b]);
  assert.equal(first.cards.monster[0].name,'zh:100');
  assert.equal(translated.cards.monster[0].name,'ja:100');
  await service.query({deckTypeId:578,period:'all'});
  assert.equal(calls.connections,3,'old in-flight results cannot repopulate an invalidated cache');
  assert.equal(calls.released,3);
  assert.equal(calls.commits,3);
  assert.ok(calls.statements.includes('SET TRANSACTION READ ONLY'));
  assert.ok(calls.statements.includes("SET LOCAL statement_timeout = '3s'"));
  assert.ok(calls.statements.includes('SET LOCAL max_parallel_workers_per_gather = 0'));
});

test('query timeouts roll back and release the connection, then return a retryable public error',async()=>{
  const {service,calls,release}=blockedFixture('57014');
  release();
  await assert.rejects(service.query({deckTypeId:578,period:'all'}),error=>error.statusCode===503 && error.message!=='private details');
  assert.equal(calls.rollbacks,1); assert.equal(calls.released,1); assert.equal(calls.commits,0);
  await assert.rejects(service.query({deckTypeId:578,period:'all'}),error=>error.statusCode===503);
  assert.equal(calls.connections,2,'failed work must leave neither cache nor pending requests');
});
