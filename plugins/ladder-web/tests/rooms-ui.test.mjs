import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';

const html = readFileSync(resolve(import.meta.dirname, '../web/rooms.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'room page script exists');

test('web room list renders server types instead of repeating room names', async () => {
  const rooms = [
    {roomname: 'MATCH#Friends$private', roommode: 1, roomtype: 'match_room', istart: 'wait', users: []},
    {roomname: 'M#TT,RANDOM#123', roommode: 1, roomtype: 'match_room', istart: 'wait', users: []},
    {roomname: 'X,RANDOM#3', roommode: 1, roomtype: 'random_other', randommode: 'X', istart: 'wait', users: []},
    {roomname: 'TAG#Friends', roommode: 2, istart: 'wait', users: []}
  ];
  const rows = [];
  const nodes = new Map([['tbody', {
    set innerHTML(value) { if (value === '') rows.length = 0; },
    appendChild(row) { rows.push(row); }
  }]]);
  const document = {
    querySelectorAll() { return []; },
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, {textContent: ''});
      return nodes.get(id);
    },
    createElement(tag) {
      if (tag === 'tr') {
        const row = {innerHTML: '', dataset: {}, firstElementChild: {appendChild() {}}};
        return row;
      }
      return {setAttribute() {}};
    }
  };
  const context = {
    document,
    fetch: async () => ({ok: true, json: async () => ({rooms})}),
    SrvproWeb: {
      getLanguage: () => 'zh',
      t: (translations, key) => translations[context.lang][key],
      init() {}
    }
  };
  runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rows.length, 4);
  assert.equal(rows[0].dataset.roomName, 'MATCH#Friends');
  assert.equal(rows[0].dataset.roomState, 'wait');
  assert.equal(rows[0].dataset.roomType, 'match_room');
  assert.ok(rows[0].innerHTML.includes('<td>比赛房</td>'));
  assert.ok(rows[1].innerHTML.includes('<td>比赛房</td>'), 'the server can identify a non-ladder room despite its name');
  assert.ok(rows[2].innerHTML.includes('<td>其他随机模式 (X)</td>'));
  assert.ok(rows[3].innerHTML.includes('<td>双打房</td>'));
  for (const language of ['zh', 'ja', 'en', 'ko']) {
    for (const type of ['ladder_match', 'random_single', 'random_match', 'random_tag', 'random_other',
      'ai_battle', 'arena_room', 'tournament_room', 'single_room', 'match_room', 'tag_room', 'unknown_room']) {
      assert.ok(context.I18N[language][type], `${language} is missing ${type}`);
    }
  }
});

test('waiting non-ladder rooms join the web client; started rooms spectate', async () => {
  const rooms = [
    {roomid: 1, roomname: 'Friends', roommode: 1, roomtype: 'match_room', istart: 'wait', needpass: 'false', users: []},
    {roomid: 2, roomname: 'Secret', roommode: 1, roomtype: 'match_room', istart: 'wait', needpass: 'true', users: []},
    {roomid: 3, roomname: 'M#TT,RANDOM#9', roommode: 1, roomtype: 'ladder_match', istart: 'wait', users: []},
    {roomid: 4, roomname: 'Busy', roommode: 1, roomtype: 'match_room', istart: 'Duel:1 Turn:2', needpass: 'false', users: []}
  ];
  const rows = [];
  const makeLink = (intent, config) => ({intent, config, children: [], appendChild(c) { this.children.push(c); }});
  const document = {
    querySelectorAll() { return []; },
    getElementById() { return {textContent: '', set innerHTML(v) { if (v === '') rows.length = 0; }, appendChild(row) { rows.push(row); }}; },
    createElement(tag) {
      if (tag === 'tr') {
        const row = {innerHTML: '', dataset: {}, firstElementChild: {
          appendChild() {}, replaceChildren(link) { row.replaced = link; }}};
        return row;
      }
      return {setAttribute() {}, appendChild() {}};
    }
  };
  const context = {
    document,
    fetch: async () => ({ok: true, json: async () => ({rooms})}),
    SrvproWeb: {
      getLanguage: () => 'zh',
      t: (translations, key) => translations[context.lang][key],
      entryUrl: (intent, config) => new URL('https://web.example/?intent=' + intent + '&room=' + encodeURIComponent(config.room)),
      createClientLink: makeLink,
      init() {}
    }
  };
  runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(rows[0].replaced.intent, 'regular');
  assert.deepEqual({...rows[0].replaced.config}, {room: 'Friends'});
  assert.equal(rows[0].replaced.title, '加入');
  assert.equal(rows[1].replaced.intent, 'regular');
  assert.equal(rows[1].replaced.title, '加入·需密码');
  assert.equal(rows[2].replaced, undefined, 'ladder waiting rooms keep the TT match action');
  assert.equal(rows[3].replaced.intent, 'spectate');
  assert.equal(rows[3].replaced.title, '观战');
  for (const language of ['zh', 'ja', 'en', 'ko']) {
    for (const key of ['join_btn', 'join_password']) assert.ok(context.I18N[language][key], `${language} is missing ${key}`);
  }
});
