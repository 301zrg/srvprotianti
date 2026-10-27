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
