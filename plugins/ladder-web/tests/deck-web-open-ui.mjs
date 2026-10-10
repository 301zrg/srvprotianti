import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Both projects participate: real website routes/assets and the built receiver.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const webRoot = resolve(root, '../srvprotiantiweb');
const require = createRequire(import.meta.url);
const webRequire = createRequire(resolve(webRoot, 'package.json'));
const {chromium, expect} = webRequire('@playwright/test');
const {preview} = webRequire('vite');
const plugin = require('../index.js');
const visualOnly = process.argv.includes('--visual-only');
// Room links are delivered by the separate room-list PR.
const includeRooms = process.argv.includes('--rooms');
const baselineHtml = visualOnly && process.env.WEBSITE_BASELINE_HTML;
const mine = {main: [89631139, 89631139], extra: [23995346, 44508094], side: [44508094, 89631139]};
const opponent = {main: [43711255], extra: [84013237], side: [89631139]};
const current = {...mine, main: [89631139]};
const ydk = deck => '#main\n' + deck.main.join('\n') + '\n#extra\n' + deck.extra.join('\n') + '\n!side\n' + deck.side.join('\n') + '\n';
function buffer(deck) {
  const cards = [...deck.main, ...deck.extra, ...deck.side], bytes = Buffer.alloc(8 + cards.length * 4);
  bytes.writeUInt32LE(deck.main.length + deck.extra.length, 0); bytes.writeUInt32LE(deck.side.length, 4);
  cards.forEach((id, index) => bytes.writeUInt32LE(id, 8 + index * 4)); return bytes.toString('base64');
}
const names = {zh: '公开样本 <长名称> & "测试"', ja: '公開デッキの長いテスト名', en: 'A public fixture with a long deck name & quotes', ko: '공개 덱의 긴 테스트 이름'};
const filename = '公开样本 & quoted.ydk';
const record = {matchId: 123, opponent: 'OpponentFixture', playerDeckAvailable: true, opponentDeckAvailable: true, pointsDelta: 5, opponentPointsDelta: -5, pointsAfter: 1005, opponentPointsAfter: 995, won: true, score: '2-1', settledAt: '2026-10-07T08:00:00Z'};
const summary = {rank: 1, points: 1005, wins: 1, losses: 0, diff: 1, winRate: 1, decks: []};
const apiRequests = [], faults = {file: false, privateDeck: false, largeDeck: false};
let hook, browser, client, source;
const reports = [], errors = [];
const services = {
  ladderAnalytics: {
    rankingBasis: () => 'points',
    profile: async (query, password) => ({found: true, authenticated: password === 'synthetic-password', player: query.player, month: query.month, summary: {total: summary, month: summary}, chart: [], recentMatchLimit: 10, matches: [record, {...record, matchId: 124, playerDeckAvailable: false, opponentDeckAvailable: false}], total: 2, pageSize: 10}),
    profileDeck: async (query, password) => {
      apiRequests.push({query, password});
      if (faults.privateDeck || !['FixtureUser', 'ChangedUser'].includes(query.player) || query.matchId !== 123) return null;
      return {filename: 'fixture.ydk', contents: faults.largeDeck ? 'x'.repeat(65537) : ydk(query.side === 'player' ? mine : opponent)};
    }
  },
  ladderUsageAnalytics: {deckDetail: async () => ({selected: {id: 27, names, templateFiles: [filename]}, usage: {count: 1, usageRate: 1}, overall: {}, opponents: [], topPlayers: [], minPlayerMatches: 25})},
  deckClassifier: {getTemplate: () => faults.file ? null : {filename: 'fixture.ydk', contents: ydk(mine)}}
};
plugin.init({
  rootDir: resolve(root, 'plugins/ladder-web'),
  config: {routesFile: 'routes.json', exampleDecksFile: 'example-decks.json'},
  get: name => services[name], hook: (name, handler) => { assert.equal(name, 'http_request'); hook = handler; },
  log: {warn() {}}
});
function json(res, value) { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(value)); }
async function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (baselineHtml && /^\/(replays|intro|deck-detail|player-stats|rooms)\.html$/.test(url.pathname)) {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(readFileSync(resolve(baselineHtml, url.pathname.slice(1)))); return;
  }
  if (url.pathname === '/api/public/rooms') {
    json(res, {rooms: [
      {roomid: 1, roomname: 'M#TT,RANDOM#123456', roommode: 1, istart: 'Duel:1 Turn:5', users: [{name: 'FixtureUser'}, {name: 'OpponentFixture'}]},
      {roomid: 2, roomname: 'Locked & <room>$private-fixture', roommode: 1, istart: 'Duel:2 Siding', needpass: true, users: [{name: 'PlayerOne'}, {name: 'PlayerTwo'}]},
      {roomid: 3, roomname: 'T#TagRoom', roommode: 2, istart: 'Duel:1 Turn:2', users: ['A', 'B', 'C', 'D'].map(name => ({name}))},
      {roomid: 4, roomname: 'TT,RANDOM#654321', roommode: 1, istart: 'wait', users: [{name: 'WaitingPlayer'}]}
    ]}); return;
  }
  if (url.pathname === '/api/public/replays') {
    json(res, {replays: [{name: '2026-10-07 16-00-00 Fixture VS Opponent.yrp', size: 100, duelCount: 2, players: [{id: 'FixtureUser', deckbuffer: buffer(current)}, {id: 'OpponentFixture', deckbuffer: buffer(opponent)}]}, {name: 'No metadata.yrp', size: 50}], total: 2}); return;
  }
  if (url.pathname === '/api/example-decks') { json(res, {groups: [{id: 'fixtures', name: names, decks: [{file: filename, name: names}]}]}); return; }
  if (url.pathname.startsWith('/example_decks/')) {
    res.writeHead(faults.file ? 404 : 200, {'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="fixture.ydk"'});
    res.end(faults.file ? 'Deck not found' : ydk(mine)); return;
  }
  if (await hook(req, res, {pathname: url.pathname, query: Object.fromEntries(url.searchParams)})) return;
  res.writeHead(404); res.end('Not found');
}
async function saved(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('decks'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise((resolve, reject) => { const r = db.transaction('decks').objectStore('decks').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
    finally { db.close(); }
  });
}
async function editor(page, deck) {
  await expect(page.getByTestId('deck-name')).toBeVisible({timeout: 45000});
  for (const zone of ['main', 'extra', 'side']) await expect(page.getByTestId('deck-zone-' + zone)).toHaveAttribute('data-card-count', String(deck[zone].length));
  const match = (await saved(page)).find(d => ['main', 'extra', 'side'].every(zone => JSON.stringify(d[zone]) === JSON.stringify(deck[zone])));
  assert.ok(match, 'Imported lists must match all IDs, duplicates, order and Side');
  assert.equal(await page.evaluate(() => window.__duelConnections.length), 0);
  assert.equal(await page.evaluate(() => location.hash), '#/build');
}
try {
  client = await preview({root: webRoot, configFile: resolve(webRoot, 'vite.config.ts'), preview: {host: '127.0.0.1', port: 0, https: {cert: readFileSync(resolve(webRoot, '.audit-tmp/deck-import-cert/cert.pem')), key: readFileSync(resolve(webRoot, '.audit-tmp/deck-import-cert/key.pem'))}}});
  const clientEntry = client.resolvedUrls.local[0], clientOrigin = new URL(clientEntry).origin;
  source = createServer((req, res) => { void route(req, res).catch(() => { res.writeHead(500); res.end('Synthetic route failure'); }); });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  const sourceOrigin = 'http://127.0.0.1:' + source.address().port;
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_BROWSER_EXECUTABLE || (existsSync(edge) ? edge : undefined), ignoreDefaultArgs: ['--disable-popup-blocking']});
  const screenshots = resolve(process.env.WEBSITE_SCREENSHOT_DIR || resolve(root, '../.audit-tmp/website-deck-open')); mkdirSync(screenshots, {recursive: true});
  const measurements = [];
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ignoreHTTPSErrors: true, viewport: mobile ? {width: 320, height: 640} : {width: 1280, height: 800}, isMobile: mobile, hasTouch: mobile});
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.route('**/*', route => route.request().url().startsWith(clientEntry) || route.request().url().startsWith(sourceOrigin) ? route.continue() : route.abort());
    await context.route('**/duel-config.js', route => route.fulfill({contentType: 'application/javascript', body: 'window.__SRVPRO_DUEL_CONFIG__=' + JSON.stringify({duelWebSocketUrl: 'wss://must-not-connect.invalid/neos', deckImportOrigins: [sourceOrigin]}) + ';'}));
    await context.addInitScript(({clientEntry}) => {
      window.SRVPRO_WEB_CLIENT_URL = clientEntry;
      window.__duelConnections = []; window.__handoffPayloads = [];
      addEventListener('message', event => { if (event.data?.channel === 'srvprotiantiweb:deck-import' && event.data.type === 'payload') window.__handoffPayloads.push(event.data); });
      const Native = WebSocket;
      window.WebSocket = class extends Native { constructor(url, protocols) { if (String(url).includes('must-not-connect.invalid')) { window.__duelConnections.push(String(url)); throw new Error('Deck opening must not connect'); } super(url, protocols); } };
    }, {clientEntry});
    const page = await context.newPage();
    for (const language of ['zh', 'ja', 'en', 'ko']) {
      const pages = [['replays', '', 2], ['intro', '', 1], ['deck-detail', '&deckTypeId=27', 1], ['player-stats', '&player=FixtureUser', 2]];
      if (includeRooms) pages.push(['rooms', '', 0]);
      for (const [name, query, count] of pages) {
        await page.goto(sourceOrigin + '/' + name + '.html?L=' + language + query);
        if (name === 'rooms') await expect(page.locator('#tbody tr')).toHaveCount(4);
        if (baselineHtml) {
          if (name !== 'rooms') await expect(page.locator(name === 'intro' ? '.deck-list a' : 'table tbody tr').first()).toBeVisible();
        } else {
          await expect(page.locator('.deck-web-open')).toHaveCount(count);
          for (const button of await page.locator('.deck-web-open').all()) {
            await expect(button).not.toBeEmpty();
            const box = await button.boundingBox(); assert.ok(box.height >= 28 && box.width >= 44);
            if (name === 'intro' || name === 'deck-detail') assert.ok(box.height >= (mobile ? 40 : 32));
            if (name === 'player-stats' || name === 'replays') {
              assert.ok(await button.evaluate(b => getComputedStyle(b).fontSize === getComputedStyle(b.closest('table')).fontSize), 'Table action text keeps the table font size');
            }
            assert.ok(await button.evaluate(b => b.previousElementSibling?.matches('a[download],button[data-download]') || !!b.previousElementSibling?.matches('button')));
          }
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ' must contain scrolling within its table');
          if (mobile && name === 'intro') {
            for (const button of await page.locator('.deck-web-open').all()) { const b = await button.boundingBox(); assert.ok(b.x >= 0 && b.x + b.width <= 320); }
          }
          if (name === 'rooms') {
            await expect(page.locator('.spectate-link')).toHaveCount(3);
            const links = await page.locator('.spectate-link').evaluateAll(nodes => nodes.map(a => ({href: a.href, text: a.textContent, target: a.target, rel: a.rel})));
            for (const a of links) {
              const params = new URLSearchParams(new URL(a.href).hash.split('?')[1]);
              assert.equal(params.get('spectate'), '1'); assert.equal(a.target, '_blank'); assert.ok(a.rel.includes('noopener'));
              assert.ok(!a.href.includes('private-fixture') && !a.text.includes('private-fixture'));
              if (params.get('room') === 'Locked & <room>') assert.equal(params.get('autojoin'), '0');
            }
          }
        }
        const rowHeight = await page.locator(name === 'player-stats' ? '.web-card:last-child tbody tr:first-child' : 'tbody tr:first-child').evaluateAll(nodes => nodes[0]?.getBoundingClientRect().height);
        if (!baselineHtml && ['replays', 'player-stats', 'rooms'].includes(name)) {
          assert.ok(rowHeight <= (mobile ? 34 : 38), name + ' records must stay compact: ' + rowHeight);
          const cell = page.locator(name === 'rooms' ? '#tbody tr:first-child .room-name' : '.deck-action-cell').first();
          const buttons = await cell.locator('button').evaluateAll(nodes => nodes.map(b => b.getBoundingClientRect().y));
          assert.ok(buttons.every(y => Math.abs(y - buttons[0]) < 1), name + ' record actions must share one line');
        }
        measurements.push({name, language, mobile, rowHeight});
        if (language === 'zh') {
          await page.screenshot({path: resolve(screenshots, `${name}-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true});
          if (name === 'player-stats' || name === 'replays') {
            await page.locator('.table-wrap').last().evaluate(el => { el.scrollLeft = el.scrollWidth; });
            await page.screenshot({path: resolve(screenshots, `${name}-actions-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true});
          }
        }
      }
    }
    reports.push({mobile, languages: 4, pages: includeRooms ? 5 : 4, compactTargets: true, noBodyOverflow: true});
    if (visualOnly) { await context.close(); continue; }
    for (const [name, query, deck, index] of [['replays', '', current, 0], ['replays', '', opponent, 1], ['intro', '', mine, 0], ['deck-detail', '&deckTypeId=27', mine, 0]]) {
      await page.goto(sourceOrigin + '/' + name + '.html?L=zh' + query);
      await page.locator('.deck-web-open').nth(index).click();
      await editor(page, deck).catch(async error => {
        console.log(JSON.stringify({failedCase: name, body: await page.locator('body').innerText(), errors})); throw error;
      });
      reports.push({mobile, page: name, publicContentLink: true, deckValidated: true});
    }
    await page.goto(sourceOrigin + '/player-stats.html?L=zh&player=FixtureUser');
    await expect(page.locator('[data-open-deck]')).toHaveCount(2);
    await page.locator('#playerInput').fill('FixtureUser$synthetic-password'); await page.locator('#searchButton').click();
    await expect(page.locator('#toast')).toBeHidden();
    for (const [side, deck] of [['player', mine], ['opponent', opponent]]) {
      const popupPromise = page.waitForEvent('popup');
      const button = page.locator('[data-open-deck][data-side="' + side + '"]');
      await button.click(); const popup = await popupPromise;
      await editor(popup, deck); await expect(button.locator('..').locator('.deck-open-status')).toContainText('已在网页版打开');
      assert.equal(await popup.evaluate(() => window.opener), null);
      const messages = await popup.evaluate(() => window.__handoffPayloads);
      assert.equal(messages.length, 1); assert.equal(messages[0].format, 'ydk');
      assert.ok(!JSON.stringify(messages).includes('synthetic-password'));
      assert.ok(!popup.url().includes('synthetic-password'));
      assert.equal(apiRequests.at(-1).password, 'synthetic-password'); assert.equal(apiRequests.at(-1).query.side, side);
      await popup.close(); reports.push({mobile, side, authorizedBridge: true, noPasswordTransfer: true});
    }
    // Original downloads still work and do not trigger any web-client navigation.
    const downloadPromise = page.waitForEvent('download'); await page.locator('[data-download][data-side="player"]').click();
    const download = await downloadPromise; assert.equal(readFileSync(await download.path(), 'utf8'), ydk(mine));
    assert.ok(page.url().startsWith(sourceOrigin));
    if (mobile) {
      faults.privateDeck = true;
      const deniedPopup = page.waitForEvent('popup'); await page.locator('[data-open-deck][data-side="opponent"]').click();
      const denied = await deniedPopup; await expect(page.locator('.deck-open-error')).toContainText('无权访问');
      await expect.poll(() => denied.isClosed()).toBe(true); faults.privateDeck = false;
      const before = apiRequests.length;
      await page.evaluate(() => { window.open = () => null; });
      await page.locator('[data-open-deck][data-side="player"]').click();
      await expect(page.locator('.deck-open-error').first()).toContainText('被阻止'); assert.equal(apiRequests.length, before);
      faults.file = true;
      await page.goto(sourceOrigin + '/intro.html'); await page.locator('.deck-web-open').click();
      await expect(page.locator('.deck-open-error')).toContainText('不可用'); await expect(page.locator('.deck-web-open')).toBeEnabled();
      assert.ok(page.url().startsWith(sourceOrigin)); faults.file = false;
      await page.goto(sourceOrigin + '/player-stats.html?player=FixtureUser'); faults.largeDeck = true;
      const largePopup = page.waitForEvent('popup'); await page.locator('[data-open-deck][data-side="player"]').click();
      const large = await largePopup; await expect(page.locator('.deck-open-error')).toContainText('超过');
      await expect.poll(() => large.isClosed()).toBe(true); faults.largeDeck = false;
      reports.push({missingFiles: true, deniedDecks: true, blockedPopupNoFetch: true, oversizedDeck: true, originalDownloads: true});
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  writeFileSync(resolve(screenshots, 'measurements.json'), JSON.stringify(measurements, null, 2));
  console.log(JSON.stringify({reports, productionAccessed: false, realIosTested: false}));
} finally {
  if (browser) await browser.close();
  if (source) await new Promise(resolve => source.close(resolve));
  if (client) await new Promise(resolve => client.httpServer.close(resolve));
}
