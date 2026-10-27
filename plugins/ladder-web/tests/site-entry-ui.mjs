import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {resolve, extname} from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const web = resolve(root, 'plugins/ladder-web/web');
const client = process.env.SRVPRO_CLIENT_ROOT || resolve(root, '../srvprotiantiweb');
const {chromium, expect} = createRequire(resolve(client, 'package.json'))('@playwright/test');
const requests = [], errors = [];
const summary = {rank:1, points:1005, wins:1, losses:0, diff:1, winRate:1, decks:[]};
const record = {matchId:12, opponent:'Opponent', playerDeckAvailable:false, opponentDeckAvailable:false, won:true, score:'2-1', settledAt:'2026-10-23T00:00:00Z'};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  function json(value) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(value)); }
  if (url.pathname === '/api/ladder/player') {
    let body = ''; for await (const chunk of req) body += chunk;
    const query = JSON.parse(body); requests.push({path:url.pathname, query});
    json({found:true, authenticated:query.password === 'secret', player:query.player, month:query.month, summary:{month:summary,total:summary}, chart:[], matches:[record], total:25, pageSize:10}); return;
  }
  if (url.pathname.startsWith('/api/')) {
    requests.push({path:url.pathname, query:Object.fromEntries(url.searchParams)});
    if (url.pathname === '/api/ladder') json({ladder:[{rank:1,name:'Fake',duelPoints:1005,wins:1,losses:0,diff:1}],total:70,rankingBasis:'points'});
    else if (url.pathname === '/api/public/rooms') json({rooms:[
      {roomid:1,roomname:'TT,RANDOM#1',roomtype:'ladder_match',roommode:1,istart:'wait',users:[]},
      {roomid:2,roomname:'Room',roomtype:'match_room',roommode:1,istart:'Duel:1 Turn:2',users:[]},
      {roomid:3,roomname:'Locked$private',roomtype:'match_room',roommode:1,istart:'Duel:1 Siding',users:[],needpass:true}
    ]});
    else json({groups:[],decks:[],cards:[],replays:[],total:0,coverage:{},rating:{}});
    return;
  }
  if (url.pathname === '/assets/web-client-config.js') {
    res.writeHead(200, {'Content-Type':'text/javascript'}); res.end("window.SRVPRO_WEB_CLIENT_URL='https://receiver.test/sub/index.html';"); return;
  }
  const file = resolve(web, '.' + (url.pathname === '/' ? '/rooms.html' : url.pathname));
  if (!file.startsWith(web + '/') && !file.startsWith(web + '\\')) {res.writeHead(404);res.end();return;}
  if (!existsSync(file)) {res.writeHead(404);res.end();return;}
  res.writeHead(200, {'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css'})[extname(file)] || 'application/octet-stream'});
  res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const receiver = `<!doctype html><title>Fixture receiver</title><p>Fake receiver</p><script>
const p=new URLSearchParams(location.hash.split('?')[1]);window.received=[];
if(p.get('bridge')==='1') {
 const origin=p.get('origin'), request=p.get('request'), intent=p.get('intent');
 const ready=()=>opener&&opener.postMessage({channel:'srvprotiantiweb:entry',version:1,type:'ready',request,intent},origin);
 const timer=setInterval(ready,50);addEventListener('message',e=>{
  if(e.origin!==origin||e.source!==opener||e.data.request!==request||e.data.intent!==intent)return;
  received.push(e.data);clearInterval(timer);opener.postMessage({...e.data,credentials:undefined,type:'result',status:'accepted'},origin);
 });ready();
}
</script>`;
let browser;
try {
  browser = await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {channel:'msedge'})});
  const context = await browser.newContext();
  await context.route('https://receiver.test/**', route => route.fulfill({contentType:'text/html',body:receiver}));
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage();
  const labels = {zh:['一键匹配','开始游戏','卡组编辑','查看录像','设置'],ja:['クイックマッチ','ゲーム開始','デッキ編集','リプレイ一覧','設定'],en:['Quick match','Start game','Deck editor','View replays','Settings'],ko:['빠른 매칭','게임 시작','덱 편집','리플레이 보기','설정']};
  for (const lang of ['zh','ja','en','ko']) {
    for (const name of ['intro','rooms','replays','ladder','deck-stats','player-stats','usage-stats','deck-detail']) {
      await page.goto(base + '/' + name + '.html?L=' + lang);
      await expect(page.locator('.site-client-actions a')).toHaveText(labels[lang].slice(0,4));
      assert.equal(await page.locator('.site-play-caption').count(), 0);
      for (const link of await page.locator('.site-client-actions a').all()) {
        const url = new URL(await link.getAttribute('href'));
        assert.equal(url.searchParams.get('lang'), lang);
        assert.equal(url.pathname, '/sub/index.html');
      }
      await page.locator('.site-settings-button').click();
      await expect(page.locator('dialog')).toBeVisible();
      await expect(page.locator('dialog input[name=password]')).toHaveAttribute('type','password');
      await page.keyboard.press('Escape');
    }
  }
  for (const lang of ['zh','ja','en','ko']) for (const width of [320,390,844]) {
    await page.setViewportSize({width,height:width===844?390:844});
    await page.goto(base + '/rooms.html?L='+lang);
    const boxes = await page.locator('.site-client-actions a').evaluateAll(nodes => nodes.map(n => {const r=n.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right};}));
    if (width <= 640) {assert.equal(boxes[0].y,boxes[1].y);assert.equal(boxes[2].y,boxes[3].y);assert.ok(boxes[2].y>boxes[0].y);}
    assert.ok(boxes.every(b=>b.right<=width));
  }
  await page.setViewportSize({width:1280,height:900});
  await page.goto(base + '/rooms.html?L=en');
  await page.locator('.site-settings-button').click();
  await page.locator('[name=username]').fill('Fake'); await page.locator('[name=password]').fill('secret');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('secret')),false);
  await page.keyboard.press('Escape'); await page.reload();
  await page.locator('.site-settings-button').click();
  await expect(page.locator('[name=password]')).toHaveValue('secret');
  await page.keyboard.press('Escape');
  const secondTab=await context.newPage();await secondTab.goto(base+'/rooms.html?L=en');
  await secondTab.locator('.site-settings-button').click();
  await expect(secondTab.locator('[name=username]')).toHaveValue('Fake');await expect(secondTab.locator('[name=password]')).toHaveValue('');
  await secondTab.close();
  for (const intent of ['ladder','home','deck-editor','replay-list']) {
    const [popup]=await Promise.all([page.waitForEvent('popup'),page.locator('.site-client-actions [data-client-intent="'+intent+'"]').click()]);
    await popup.waitForLoadState();
    assert.equal(popup.url().includes('secret'),false); assert.equal(popup.url().includes('Fake'),false);
    if(intent==='home') {assert.equal(new URL(popup.url()).searchParams.get('intent'),null);assert.equal(await popup.evaluate(()=>!!opener),false);}
    else {await expect.poll(()=>popup.evaluate(()=>received.length)).toBe(1);assert.equal(await popup.evaluate(()=>received[0].credentials.username),'Fake');}
    await popup.close();
  }
  await expect(page.locator('tbody tr').first().locator('a.spectate-badge')).toHaveText('Join matchmaking');
  await expect(page.locator('a.spectate-link').first()).toHaveText('RoomWatch');
  assert.equal(new URL(await page.locator('a.spectate-link').last().getAttribute('href')).searchParams.get('autojoin'),'0');
  await page.goto(base+'/intro.html?L=en');
  for(const intent of ['regular','ladder']) assert.equal(new URL(await page.locator('[data-web-intent="'+intent+'"]').getAttribute('href')).searchParams.get('intent'),intent);
  await page.goto(base+'/ladder.html?L=en&type=total&month=202609&rankingBasis=wins');
  await page.locator('[data-query-self]').click();
  await expect(page.locator('#searchInput')).toHaveValue('Fake');
  assert.equal(new URL(page.url()).searchParams.get('month'),'202609');
  assert.equal(new URL(page.url()).searchParams.get('type'),'total');
  await expect.poll(()=>requests.filter(r=>r.path==='/api/ladder').at(-1)?.query.search).toBe('Fake');
  await page.locator('.lbtn-main').click();await page.getByRole('button',{name:'日本語',exact:true}).click();
  assert.equal(new URL(page.url()).searchParams.get('month'),'202609');
  assert.equal(new URL(await page.locator('.site-client-actions [data-client-intent="ladder"]').getAttribute('href')).searchParams.get('lang'),'ja');
  await page.goto(base+'/rooms.html?L=en');await page.locator('.site-settings-button').click();
  await page.getByRole('button',{name:'My ladder ranking',exact:true}).click();
  await expect(page.locator('#searchInput')).toHaveValue('Fake');assert.equal(new URL(page.url()).searchParams.has('self'),false);
  await page.goto(base+'/rooms.html?L=en');await page.locator('.site-settings-button').click();
  await page.getByRole('button',{name:'My player stats',exact:true}).click();
  await expect.poll(()=>requests.filter(r=>r.path==='/api/ladder/player').at(-1)?.query.password).toBe('secret');
  assert.equal(new URL(page.url()).searchParams.has('self'),false);
  await page.goto(base+'/player-stats.html?L=en&player=Opponent&month=202609');
  await expect.poll(()=>requests.filter(r=>r.path==='/api/ladder/player').at(-1)?.query.player).toBe('Opponent');
  assert.equal(requests.filter(r=>r.path==='/api/ladder/player').at(-1).query.password,'');
  await page.locator('[data-query-self]').click();
  await expect.poll(()=>requests.filter(r=>r.path==='/api/ladder/player').at(-1)?.query.password).toBe('secret');
  await expect(page.locator('#content h2').first()).toHaveText('Fake');
  assert.equal(new URL(page.url()).searchParams.get('month'),'202609');
  await page.locator('[data-page="2"]').click();
  await expect.poll(()=>requests.filter(r=>r.path==='/api/ladder/player').at(-1)?.query.page).toBe(2);
  await page.locator('[data-opponent]').first().click();
  await expect.poll(()=>requests.filter(r=>r.path==='/api/ladder/player').at(-1)?.query.player).toBe('Opponent');
  assert.equal(requests.filter(r=>r.path==='/api/ladder/player').at(-1).query.password,'');
  assert.equal(page.url().includes('secret'),false);
  await page.locator('#playerInput').fill('Fake');await page.locator('#searchButton').click();
  await expect.poll(()=>requests.filter(r=>r.path==='/api/ladder/player').at(-1)?.query.player).toBe('Fake');
  assert.equal(requests.filter(r=>r.path==='/api/ladder/player').at(-1).query.password,'');
  await page.evaluate(()=>{window.open=()=>null;});await page.locator('.site-client-actions [data-client-intent="ladder"]').click();
  await expect(page.locator('[data-entry-status]')).toContainText('Allow popups');
  await page.locator('.site-settings-button').click();await page.locator('[name=rememberPassword]').check();await page.getByRole('button',{name:'Save',exact:true}).click();
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('secret')),true);
  await page.getByRole('button',{name:'Clear saved account',exact:true}).click();
  await expect(page.locator('[name=username]')).toHaveValue('');await expect(page.locator('[name=password]')).toHaveValue('');
  assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('secret')||JSON.stringify(sessionStorage).includes('secret')),false);
  await page.keyboard.press('Escape');await page.reload();
  const [publicChild]=await Promise.all([page.waitForEvent('popup'),page.locator('.site-client-actions [data-client-intent="ladder"]').click()]);await publicChild.waitForLoadState();
  assert.equal(new URL(publicChild.url()).searchParams.get('intent'),'ladder');assert.equal(await publicChild.evaluate(()=>!!opener),false);await publicChild.close();
  await page.goto(base+'/deck-stats.html?L=en&month=202609');
  await page.locator('[data-metric="1"]').click();assert.equal(new URL(page.url()).searchParams.get('month'),'202609');
  await page.goto(base+'/replays.html?L=en');await page.locator('#searchInput').fill('Other');await page.locator('[data-page-action="search"]').click();
  await expect.poll(()=>requests.filter(r=>r.path==='/api/public/replays').at(-1)?.query.search).toBe('Other');
  assert.deepEqual(errors,[]);
  console.log('PASS: four languages × eight pages; 320/390/844px; settings, intents, fake receiver, self queries and password isolation');
} finally {if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
