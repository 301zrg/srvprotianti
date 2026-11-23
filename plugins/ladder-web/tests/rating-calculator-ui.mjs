import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {extname, resolve} from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const web = resolve(root, 'plugins/ladder-web/web');
const client = process.env.SRVPRO_CLIENT_ROOT || resolve(root, '../srvprotiantiweb');
const {chromium, expect} = createRequire(resolve(client, 'package.json'))('@playwright/test');
const screenshotDir = process.env.SCREENSHOT_DIR ? resolve(process.env.SCREENSHOT_DIR) : null;
if (screenshotDir) mkdirSync(screenshotDir, {recursive: true});

let ratingConfig = {
  initialPoints: 1000,
  useDynamic: true,
  minDelta: 8,
  maxDelta: 15,
  fixedDelta: 12,
  kFactor: 20,
  totalWeight: 0.6,
  monthWeight: 0.4,
  minimumPoints: 0
};

const mockPlayers = {
  alice: {
    found: true,
    authenticated: false,
    player: 'Alice',
    month: '202611',
    summary: {
      total: {rank: 1, points: 1250, wins: 30, losses: 10, diff: 20, winRate: 0.75, decks: []},
      month: {rank: 2, points: 1120, wins: 12, losses: 4, diff: 8, winRate: 0.75, decks: []}
    },
    chart: [],
    matches: []
  },
  bob: {
    found: true,
    authenticated: false,
    player: 'Bob',
    month: '202611',
    summary: {
      total: {rank: 15, points: 960, wins: 12, losses: 16, diff: -4, winRate: 0.4286, decks: []},
      month: {rank: 18, points: 980, wins: 5, losses: 7, diff: -2, winRate: 0.4167, decks: []}
    },
    chart: [],
    matches: []
  }
};

const errors = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = value => {
    res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify(value));
  };
  if (url.pathname === '/api/ladder-config') {
    json({rankingBasis: 'points', rating: ratingConfig});
    return;
  }
  if (url.pathname === '/api/ladder') {
    json({
      type: 'month',
      month: '202611',
      rankingBasis: 'points',
      total: 3,
      ladder: [
        {rank: 1, name: 'Alice', duelPoints: 1120, wins: 12, losses: 4, diff: 8},
        {rank: 2, name: 'Charlie', duelPoints: 1050, wins: 8, losses: 5, diff: 3},
        {rank: 3, name: 'Bob', duelPoints: 980, wins: 5, losses: 7, diff: -2}
      ]
    });
    return;
  }
  if (url.pathname === '/api/ladder/player' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || '{}');
    const key = String(payload.player || '').trim().toLowerCase();
    json(mockPlayers[key] || {found: false});
    return;
  }
  const file = resolve(web, '.' + (url.pathname === '/' ? '/ladder.html' : url.pathname));
  if (!file.startsWith(web + '/') && !file.startsWith(web + '\\')) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const types = {'.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8'};
  res.writeHead(200, {'Content-Type': types[extname(file)] || 'application/octet-stream'});
  res.end(readFileSync(file));
});

await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const base = 'http://127.0.0.1:' + server.address().port;

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {channel: 'msedge'})
  });
  const context = await browser.newContext();
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();

  // 1. Desktop viewport (1280x900) - Chinese: existing player + newcomer fallback
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto(base + '/ladder.html');
  const trigger = page.locator('[data-rating-calc-open]');
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveText('等级分计算器');
  await trigger.click();

  const dialog = page.locator('#ratingCalcDialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('input[name="playerA"]').fill('Alice');
  await dialog.locator('input[name="playerB"]').fill('NewPlayer');
  await dialog.locator('.rating-calc-submit').click();

  await expect(dialog.locator('.rating-calc-result')).toBeVisible();
  await expect(dialog.locator('.rating-calc-badge')).toContainText('1000');
  // Alice combined = 0.6*1250 + 0.4*1120 = 1198; NewPlayer combined = 1000
  // Alice wins: expected = 1/(1+10^(-198/400)) ≈ 0.7576 -> round(20*(1-0.7576))=5 -> clamped minDelta=8
  // NewPlayer wins: expected ≈ 0.2424 -> round(20*(1-0.2424))=15 -> maxDelta=15
  await expect(dialog.locator('.rating-calc-outcomes')).toContainText('Alice +8');
  await expect(dialog.locator('.rating-calc-outcomes')).toContainText('NewPlayer −8');
  await expect(dialog.locator('.rating-calc-outcomes')).toContainText('NewPlayer +15');
  await expect(dialog.locator('.rating-calc-outcomes')).toContainText('Alice −15');

  if (screenshotDir) {
    await page.screenshot({path: resolve(screenshotDir, 'rating-calculator-desktop.png')});
  }

  // 2. Four-language verification
  const expectedLabels = {
    ja: {btn: 'レート計算', title: 'レート変動シミュレーター'},
    en: {btn: 'Rating Calculator', title: 'Rating Calculator'},
    ko: {btn: '점수 계산기', title: '점수 변동 계산기'}
  };
  for (const [lang, expected] of Object.entries(expectedLabels)) {
    await page.goto(base + '/ladder.html?L=' + lang);
    await expect(page.locator('[data-rating-calc-open]')).toHaveText(expected.btn);
    await page.locator('[data-rating-calc-open]').click();
    await expect(page.locator('#ratingCalcTitle')).toHaveText(expected.title);
    await page.locator('[data-calc-close]').click();
  }

  // 3. Mobile viewport (390x844) - check no horizontal overflow & capture screenshot
  await page.setViewportSize({width: 390, height: 844});
  await page.goto(base + '/ladder.html');
  await page.locator('[data-rating-calc-open]').click();
  await page.locator('input[name="playerA"]').fill('Alice');
  await page.locator('input[name="playerB"]').fill('Bob');
  await page.locator('.rating-calc-submit').click();
  await expect(page.locator('.rating-calc-result')).toBeVisible();

  const dialogBox = await page.locator('#ratingCalcDialog').boundingBox();
  assert.ok(dialogBox && dialogBox.width <= 390, `Dialog width ${dialogBox?.width} exceeds mobile viewport`);
  const overflows = await page.locator('#ratingCalcDialog').evaluate(el => el.scrollWidth > el.clientWidth + 1);
  assert.equal(overflows, false, 'Dialog should not overflow horizontally on mobile');

  if (screenshotDir) {
    await page.screenshot({path: resolve(screenshotDir, 'rating-calculator-mobile.png')});
  }

  // 4. Fixed scoring mode
  ratingConfig = {...ratingConfig, useDynamic: false, fixedDelta: 12};
  await page.goto(base + '/ladder.html');
  await page.locator('[data-rating-calc-open]').click();
  await page.locator('input[name="playerA"]').fill('Alice');
  await page.locator('input[name="playerB"]').fill('Bob');
  await page.locator('.rating-calc-submit').click();
  await expect(page.locator('.rating-calc-outcomes')).toContainText('Alice +12');
  await expect(page.locator('.rating-calc-outcomes')).toContainText('Bob −12');
  await expect(page.locator('.rating-calc-note')).toContainText('12');

  // 5. Missing rating config hides both rules and calculator button
  ratingConfig = null;
  await page.goto(base + '/ladder.html');
  await expect(page.locator('[data-rating-rules]')).toBeHidden();
  await expect(page.locator('[data-rating-calc-open]')).toBeHidden();

  assert.deepEqual(errors, [], 'No page errors expected');
  console.log('rating-calculator-ui checks passed.');
} finally {
  if (browser) await browser.close();
  server.close();
}
