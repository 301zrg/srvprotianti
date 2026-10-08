import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {createRequire} from 'node:module';
import {dirname, resolve, sep, extname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const clientRoot = resolve(process.env.REPLAY_WEB_CLIENT_ROOT || resolve(root, '../srvprotiantiweb'));
const require = createRequire(import.meta.url);
const {chromium, expect} = createRequire(resolve(clientRoot, 'package.json'))('@playwright/test');
const plugin = require('../index.js');
const dist = resolve(clientRoot, 'dist');
const certRoot = resolve(process.env.REPLAY_TEST_CERT_ROOT || resolve(root, '../srvprotiantiweb/.audit-tmp/deck-import-cert'));
const small = readFileSync(resolve(clientRoot, 'tests/fixtures/replay/native-deckout.yrp'));
// Valid, explicitly unsupported YRP1. It exercises a large transfer without
// pretending that an invented response stream is a native playable match.
const large = Buffer.alloc(32 + 25000, 0);
large.writeUInt32LE(0x31707279, 0); large.writeUInt32LE(0x1362, 4); large.writeUInt32LE(25000, 16);
const names = ['2026-10-08 12-00-00 公开样本 & "测试" VS Opponent.yrp', 'Large public fixture.yrp'];
const faults = {missing: false, oversized: false, streamed: false};
const downloads = [], errors = [], reports = [];
let hook, browser, client, source;
plugin.init({rootDir: resolve(root, 'plugins/ladder-web'), config: {routesFile: 'routes.json', exampleDecksFile: 'example-decks.json'},
  get: () => ({}), hook: (name, handler) => { assert.equal(name, 'http_request'); hook = handler; }, log: {warn() {}}});
function json(res, value) { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify(value)); }
async function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/public/replays') {
    json(res, {replays: names.map((name, i) => ({name, size: i ? large.length : small.length, duelCount: i + 1, players: []})), total: 2}); return;
  }
  if (url.pathname.startsWith('/api/public/replay/')) {
    const name = decodeURIComponent(url.pathname.slice('/api/public/replay/'.length));
    downloads.push(name);
    if (faults.missing || !names.includes(name)) { res.writeHead(404); res.end('Not found'); return; }
    if (faults.oversized) { res.writeHead(200, {'Content-Length': String(8 * 1024 * 1024 + 1)}); res.end('x'); return; }
    if (faults.streamed) {
      res.writeHead(200, {'Content-Type': 'application/octet-stream'});
      for (let i = 0; i < 129; i++) res.write(Buffer.alloc(65536, 1));
      res.end(); return;
    }
    res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="fixture.yrp"'});
    res.end(name === names[0] ? small : large); return;
  }
  if (url.pathname === '/bridge-test') { res.writeHead(200, {'Content-Type': 'text/html'}); res.end('<!doctype html><title>Owned handoff test</title>'); return; }
  if (await hook(req, res, {pathname: url.pathname, query: Object.fromEntries(url.searchParams)})) return;
  res.writeHead(404); res.end('Not found');
}
async function contents(page) {
  return page.evaluate(async () => {
    const db = await new Promise((ok, fail) => { const r = indexedDB.open('srvpro-replays'); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
    try { return await new Promise((ok, fail) => { const r = db.transaction('entries').objectStore('entries').getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); }); }
    finally { db.close(); }
  });
}
try {
  client = createHttpsServer({cert: readFileSync(resolve(certRoot, 'cert.pem')), key: readFileSync(resolve(certRoot, 'key.pem'))}, (req, res) => {
    try {
      let name = decodeURIComponent(new URL(req.url, 'https://127.0.0.1').pathname);
      if (name === '/' || name === '/nested/index.html') name = '/index.html';
      const target = resolve(dist, '.' + name);
      if (!target.startsWith(dist + sep)) { res.writeHead(403); res.end(); return; }
      const type = {'.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json'}[extname(target)] || 'application/octet-stream';
      res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-store'}); res.end(readFileSync(target));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(ok => client.listen(0, '127.0.0.1', ok));
  const clientEntry = 'https://127.0.0.1:' + client.address().port + '/';
  source = createServer((req, res) => { void route(req, res).catch(() => { res.writeHead(500); res.end('Synthetic route failure'); }); });
  await new Promise(ok => source.listen(0, '127.0.0.1', ok));
  const sourceOrigin = 'http://127.0.0.1:' + source.address().port;
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_BROWSER_EXECUTABLE || (existsSync(edge) ? edge : undefined), ignoreDefaultArgs: ['--disable-popup-blocking']});
  const screenshots = resolve(root, '../.audit-tmp/website-replay-open'); mkdirSync(screenshots, {recursive: true});
  for (const [name, viewport, mobile] of [['desktop', {width: 1280, height: 800}, false], ['portrait', {width: 390, height: 844}, true], ['landscape', {width: 844, height: 390}, true]]) {
    const context = await browser.newContext({ignoreHTTPSErrors: true, viewport, isMobile: mobile, hasTouch: mobile});
    let ws = 0, loadedCore = 0;
    context.on('page', page => { page.on('pageerror', error => errors.push(error.message)); page.on('websocket', () => ws++); });
    context.on('request', request => { if (request.url().includes('/replay/706-v1/')) loadedCore++; });
    await context.route('**/*', route => route.request().url().startsWith(clientEntry) || route.request().url().startsWith(sourceOrigin) ? route.continue() : route.abort());
    await context.route('**/duel-config.js', route => route.fulfill({contentType: 'application/javascript', body: 'window.__SRVPRO_DUEL_CONFIG__=' + JSON.stringify({duelWebSocketUrl: 'wss://must-not-connect.invalid/neos', deckImportOrigins: [sourceOrigin]}) + ';'}));
    const configuredEntry = name === 'portrait' ? clientEntry + 'nested/index.html' : clientEntry;
    await context.addInitScript(({clientEntry}) => { window.SRVPRO_WEB_CLIENT_URL = clientEntry; if (location.protocol === 'https:') localStorage.setItem('language', 'cn'); }, {clientEntry: configuredEntry});
    const page = await context.newPage();
    for (const [lang, text] of [['zh', '网页播放'], ['ja', 'Web再生'], ['en', 'Play in web'], ['ko', '웹 재생']]) {
      await page.goto(sourceOrigin + '/replays.html?L=' + lang);
      await expect(page.locator('.replay-web-open')).toHaveCount(2);
      await expect(page.locator('.replay-web-open').first()).toHaveText(text);
      const measurements = await page.locator('#tbody tr').first().evaluate(row => {
        const buttons = [...row.querySelectorAll('.replay-actions > a,.replay-actions > button')].map(b => b.getBoundingClientRect());
        return {height: row.getBoundingClientRect().height, font: getComputedStyle(row.firstElementChild).fontSize, sameLine: Math.abs(buttons[0].y - buttons[1].y) < 1};
      });
      assert.ok(measurements.height <= (viewport.width <= 640 ? 34 : 38), name + ' compact row height: ' + measurements.height);
      assert.equal(measurements.font, '13px'); assert.ok(measurements.sameLine);
      assert.equal(await page.locator('a[download]').count(), 2);
      reports.push({name, lang, ...measurements});
    }
    await page.goto(sourceOrigin + '/replays.html');
    await page.locator('.replay-web-open').first().waitFor();
    await page.screenshot({path: resolve(screenshots, name + '.png'), fullPage: true});
    const originalDownload = page.waitForEvent('download'); await page.locator('a[download]').first().click();
    assert.deepEqual(readFileSync(await (await originalDownload).path()), small);
    const pagesBeforeInline = context.pages().length;
    let inlinePopups = 0; const countInlinePopup = () => inlinePopups++;
    page.on('popup', countInlinePopup);
    await page.locator('.replay-web-open').first().click();
    await expect(page.locator('.replay-board')).toBeVisible({timeout: 60000});
    page.off('popup', countInlinePopup);
    assert.equal(inlinePopups, 0, 'Small public replay must not create a popup');
    assert.equal(context.pages().length, pagesBeforeInline, 'Small public replay must use the same tab');
    assert.equal(new URL(page.url()).pathname, new URL(configuredEntry).pathname, 'Configured static subpath must survive the handoff');
    assert.ok(page.url().startsWith(clientEntry)); assert.ok(!page.url().includes('data=') && !page.url().includes('request='));
    assert.equal((await contents(page)).length, 1);
    const replayDownload = page.waitForEvent('download'); await page.getByRole('button', {name: '下载', exact: true}).click();
    assert.deepEqual(readFileSync(await (await replayDownload).path()), small);
    await page.goto(sourceOrigin + '/replays.html');
    const pagesBeforePrefetch = context.pages().length;
    const coreBeforeBig = loadedCore;
    await page.locator('.replay-web-open').nth(1).click();
    await expect(page.locator('.replay-web-open').nth(1)).toHaveText('继续网页播放');
    assert.equal(context.pages().length, pagesBeforePrefetch, 'Prefetch must finish before creating a new tab');
    const popupPromise = page.waitForEvent('popup'); await page.locator('.replay-web-open').nth(1).click();
    const popup = await popupPromise;
    await expect(popup.locator('.replay-entry')).toHaveCount(2, {timeout: 45000});
    await expect(page.locator('.replay-open-status')).toContainText('已接收');
    assert.equal(loadedCore, coreBeforeBig, 'Unsupported large file must save without loading Core');
    assert.equal(await popup.evaluate(() => window.opener), null);
    const imported = popup.locator('.replay-entry').filter({hasText: 'Large public fixture'});
    await expect(imported.getByRole('button', {name: '播放', exact: true})).toBeDisabled();
    const bigDownload = popup.waitForEvent('download'); await imported.getByRole('button', {name: '下载', exact: true}).click();
    assert.deepEqual(readFileSync(await (await bigDownload).path()), large);
    assert.equal(ws, 0); assert.ok(loadedCore > 0, 'Actual small replay playback should initialize Core');
    await popup.close();
    if (name === 'desktop') {
      for (const key of ['missing', 'oversized', 'streamed']) {
        faults[key] = true; await page.goto(sourceOrigin + '/replays.html');
        await page.locator('.replay-web-open').first().click();
        await expect(page.locator('.replay-open-error')).toBeVisible();
        await expect(page.locator('.replay-web-open').first()).toBeEnabled(); faults[key] = false;
      }
      await page.goto(sourceOrigin + '/replays.html'); await page.locator('.replay-web-open').nth(1).click();
      await expect(page.locator('.replay-web-open').nth(1)).toHaveText('继续网页播放');
      await page.evaluate(() => { window.open = () => null; });
      await page.locator('.replay-web-open').nth(1).click();
      await expect(page.locator('.replay-open-error')).toContainText('被阻止');
      await expect(page.locator('.replay-web-open').nth(1)).toBeEnabled();
      await page.goto(clientEntry + '#/replay-import?v=1&kind=replay&bridge=1&origin=https%3A%2F%2Fevil.invalid&request=aaaaaaaaaaaaaaaa');
      await expect(page.getByTestId('replay-import-error')).toContainText('来源');
      assert.equal((await contents(page)).length, 2);
      await page.goto(clientEntry + '#/replay-import?v=1&kind=replay&format=yrp-base64url&file=bad.yrp&data=AAAA');
      await expect(page.getByTestId('replay-import-error')).toBeVisible();
      assert.equal((await contents(page)).length, 2);
      assert.equal(new URL(page.url()).hash, '#/replay-import');
      // Hold a genuine opener handoff. Wrong request/kind/window/origin must not
      // save anything; then a real cross-window payload proves it can progress.
      await page.goto(sourceOrigin + '/bridge-test');
      const bridgeUrl = clientEntry + '#/replay-import?' + new URLSearchParams({v: '1', kind: 'replay', bridge: '1', origin: sourceOrigin, request: 'bbbbbbbbbbbbbbbb'});
      const held = page.waitForEvent('popup'); await page.evaluate(url => { window.peer = window.open(url, '_blank'); }, bridgeUrl);
      const receiver = await held; await expect(receiver.getByTestId('replay-import-page')).toBeVisible({timeout: 45000});
      const payload = {channel: 'srvprotiantiweb:replay-import', version: 1, kind: 'replay', request: 'bbbbbbbbbbbbbbbb', type: 'payload', format: 'yrp', filename: names[0]};
      for (const patch of [{request: 'cccccccccccccccc'}, {kind: 'deck'}, {channel: 'srvprotiantiweb:deck-import'}]) {
        await page.evaluate(({payload, bytes, origin}) => window.peer.postMessage({...payload, bytes: Uint8Array.from(bytes).buffer}, origin), {payload: {...payload, ...patch}, bytes: [...small], origin: new URL(clientEntry).origin});
      }
      await receiver.evaluate(({payload, bytes}) => window.postMessage({...payload, bytes: Uint8Array.from(bytes).buffer}, location.origin), {payload, bytes: [...small]});
      const strangerPromise = page.waitForEvent('popup');
      await page.evaluate(() => window.open('/bridge-test', '_blank'));
      const stranger = await strangerPromise;
      await stranger.waitForLoadState('domcontentloaded');
      // Correct allowed origin and envelope, but a different source window.
      await stranger.evaluate(({payload, bytes, origin}) => window.opener.peer.postMessage({...payload, bytes: Uint8Array.from(bytes).buffer}, origin), {payload, bytes: [...small], origin: new URL(clientEntry).origin});
      await expect(receiver.getByTestId('replay-import-page')).toBeVisible();
      assert.equal((await contents(receiver)).length, 2);
      await stranger.close();
      await page.evaluate(({payload, bytes, origin}) => window.peer.postMessage({...payload, bytes: Uint8Array.from(bytes).buffer}, origin), {payload, bytes: [...small], origin: new URL(clientEntry).origin});
      await expect(receiver.locator('.replay-board')).toBeVisible({timeout: 60000});
      assert.equal((await contents(receiver)).length, 2, 'Repeated original is deduplicated'); await receiver.close();
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({passed: true, downloads: downloads.length, layout: reports}));
  console.log('Replay website integration passed: HTTP source / HTTPS client, same-tab public content, prepared binary handoff, original bytes, dedup, compact four-language layout, no WSS, faults and untrusted messages.');
} finally {
  await browser?.close();
  await Promise.all([source, client].filter(Boolean).map(server => new Promise(ok => { server.closeAllConnections(); server.close(ok); })));
}
