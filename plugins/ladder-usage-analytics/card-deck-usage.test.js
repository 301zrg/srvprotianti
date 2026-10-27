'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {createCardDeckUsage} = require('./card-deck-usage');
const {periodBounds} = require('./index')._test;

const metadata = [578, 258, 4095].map(id => ({id, names: {zh: `卡组${id}`, ja: `デッキ${id}`}}));
const classifier = {listDeckMetadata: () => metadata};
const catalog = {get: (id, lang) => ({name: `${lang}:${id}`})};

async function fixture() {
  const SQL = await require('sql.js')();
  const db = new SQL.Database();
  db.run('CREATE TABLE ladder_usage_sample (id INTEGER PRIMARY KEY,"deckTypeId" INTEGER,"dayKey" TEXT,"cardValid" INTEGER); CREATE TABLE ladder_deck_card_fact ("sampleId" INTEGER,"cardId" INTEGER,zone TEXT,copies INTEGER)');
  // Sample 5 is invalid and must not count; sample 6 is outside October; deck 999 has no metadata.
  for (const row of [[1,578,'20261001',1],[2,578,'20261002',1],[3,258,'20261003',1],[4,4095,'20261004',1],[5,578,'20261005',0],[6,258,'20260930',1],[7,999,'20261010',1],[8,258,'20261011',1]]) db.run('INSERT INTO ladder_usage_sample VALUES (?,?,?,?)', row);
  for (const row of [[1,100,'monster',3],[2,100,'monster',2],[3,100,'monster',1],[4,100,'monster',1],[5,100,'monster',3],[6,100,'monster',1],[7,100,'monster',1],[1,100,'side',1],[8,200,'monster',1]]) db.run('INSERT INTO ladder_deck_card_fact VALUES (?,?,?,?)', row);
  const calls = {connections:0};
  const dataManager = {getConnection: () => ({options:{type:'sqljs'},createQueryRunner() {
    calls.connections++;
    return {async connect() {},async release() {},async query(sql,params) {
      const statement = db.prepare(sql);
      try { statement.bind(params); const rows=[]; while (statement.step()) rows.push(statement.getAsObject()); return rows; }
      finally { statement.free(); }
    }};
  }})};
  return {db,calls,service:createCardDeckUsage({dataManager,classifier,catalog,periodBounds})};
}

test('deck shares split one card\'s valid decks, sum to one and keep Others last without a link', async () => {
  const {db,service} = await fixture();
  try {
    const result = await service.query({metric:'monster',cardId:'100',period:'month',month:'202610',lang:'ja'});
    assert.equal(result.available,true);
    assert.deepEqual(result.card,{cardId:100,zone:'monster',name:'ja:100'});
    assert.equal(result.month,'202610');
    assert.deepEqual(result.coverage,{validCardDecks:6});
    assert.equal(result.deckCount,5);
    assert.equal(result.usageRate,5/6);
    assert.deepEqual(result.decks.map(deck => [deck.rank,deck.deckTypeId,deck.deckCount,deck.share,deck.validDecks,deck.adoptionRate,deck.linkable]),[
      [1,578,2,0.4,2,1,true],
      [2,258,1,0.2,2,0.5,true],
      [3,999,1,0.2,1,1,false],
      [4,4095,1,0.2,1,1,false]
    ]);
    assert.equal(result.decks.reduce((sum, deck) => sum + deck.share, 0),1);
    assert.deepEqual(result.decks[0].names,{zh:'卡组578',ja:'デッキ578'});
    assert.deepEqual(result.decks[2].names,{zh:'999'});
    const all = await service.query({metric:'monster',cardId:100,period:'all'});
    assert.deepEqual(all.coverage,{validCardDecks:7});
    assert.equal(all.deckCount,6);
    assert.deepEqual(all.decks.find(deck => deck.deckTypeId === 258),{rank:1,deckTypeId:258,names:{zh:'卡组258',ja:'デッキ258'},deckCount:2,share:2/6,validDecks:3,adoptionRate:2/3,linkable:true});
    const side = await service.query({metric:'side',cardId:100,period:'month',month:'202610'});
    assert.deepEqual(side.decks.map(deck => [deck.deckTypeId,deck.share]),[[578,1]]);
    const unused = await service.query({metric:'trap',cardId:100,period:'month',month:'202610'});
    assert.equal(unused.deckCount,0);
    assert.equal(unused.usageRate,0);
    assert.deepEqual(unused.decks,[]);
    assert.deepEqual(unused.coverage,{validCardDecks:6});
  } finally { db.close(); }
});

test('numeric aggregates are cached across languages, private to callers and dropped on invalidation', async () => {
  const {db,service,calls} = await fixture();
  try {
    const input = {metric:'monster',cardId:100,period:'month',month:'202610'};
    const first = await service.query(input);
    first.decks[0].deckCount = 999;
    first.decks[0].names.zh = 'changed';
    const translated = await service.query({...input,lang:'ja'});
    assert.equal(translated.card.name,'ja:100');
    assert.equal(translated.decks[0].deckCount,2);
    assert.equal(translated.decks[0].names.zh,'卡组578');
    assert.equal(metadata[0].names.zh,'卡组578','callers must not mutate classifier metadata');
    assert.equal(calls.connections,1);
    service.invalidate();
    db.run('UPDATE ladder_usage_sample SET "cardValid"=0 WHERE id=1');
    const changed = await service.query(input);
    assert.equal(changed.deckCount,4);
    assert.equal(changed.decks[0].deckCount,1);
    assert.equal(calls.connections,2);
  } finally { db.close(); }
});

test('invalid card identifiers, zones and time filters are rejected before opening a database connection', async () => {
  const {db,service,calls} = await fixture();
  try {
    for (const input of [{metric:'monster'},{metric:'monster',cardId:'abc'},{metric:'monster',cardId:'1 OR 1=1'},{metric:'monster',cardId:0},{metric:'monster',cardId:-5},
      {metric:'monster',cardId:4294967296},{metric:'monster',cardId:'1.5'},{metric:'deck',cardId:100},{cardId:100},
      {metric:'monster',cardId:100,period:'bad'},{metric:'monster',cardId:100,period:'month',month:'202613'}]) {
      await assert.rejects(service.query(input),error=>error.statusCode===400,JSON.stringify(input));
    }
    assert.equal(calls.connections,0);
  } finally { db.close(); }
});

test('postgres queries run read-only with a timeout and map timeouts to a retryable public error', async () => {
  const calls={statements:[],rollbacks:0,released:0};
  const dataManager={getConnection:()=>({options:{type:'postgres'},createQueryRunner() {
    return {isTransactionActive:false,async connect(){},async startTransaction(level){assert.equal(level,'REPEATABLE READ');this.isTransactionActive=true;},
      async query(sql,params) {
        calls.statements.push(sql);
        if(sql.startsWith('SELECT s."deckTypeId", COUNT(*) AS "deckCount"')) {
          assert.match(sql,/\$1/); assert.deepEqual(params.slice(0,2),['monster',100]);
          throw Object.assign(new Error('private details'),{code:'57014'});
        }
        return [];
      },async commitTransaction(){this.isTransactionActive=false;},async rollbackTransaction(){calls.rollbacks++;this.isTransactionActive=false;},async release(){calls.released++;}};
  }})};
  const service=createCardDeckUsage({dataManager,classifier,catalog,periodBounds});
  await assert.rejects(service.query({metric:'monster',cardId:100,period:'all'}),error=>error.statusCode===503&&error.message!=='private details');
  assert.ok(calls.statements.includes('SET TRANSACTION READ ONLY'));
  assert.ok(calls.statements.includes("SET LOCAL statement_timeout = '3s'"));
  assert.equal(calls.rollbacks,1);
  assert.equal(calls.released,1);
});
