import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';

const desktopRoot=process.env.SRVPRO_DESKTOP_ROOT;
const root=desktopRoot?resolve(desktopRoot,'public'):resolve(import.meta.dirname,'../web');
const clientRoot=process.env.SRVPRO_CLIENT_ROOT||resolve(import.meta.dirname,'../../../../srvprotiantiweb');
const {chromium,expect}=createRequire(resolve(clientRoot,'package.json'))('@playwright/test');
const output=resolve(process.env.SRVPRO_USAGE_OUTPUT||resolve(import.meta.dirname,'../../../../.audit-tmp/card-deck-split-ui'));
mkdirSync(output,{recursive:true});
const NAMES={578:{zh:'代行天使',ja:'代行天使',en:'Agents',ko:'대행천사'},258:{zh:'雷王英雄',ja:'雷王HERO',en:'Thunder HERO',ko:'뇌왕 히어로'},4095:{zh:'其他',ja:'その他',en:'Others',ko:'기타'}};
const requests=[];let failNext=0,holdNext=null;
function split(q){
  const id=Number(q.cardId);
  return {available:true,card:{cardId:id,zone:q.metric,name:q.lang+' card '+id},period:q.period,month:q.period==='month'?q.month:null,
    coverage:{validCardDecks:90},deckCount:20,usageRate:2/9,decks:[
      {rank:1,deckTypeId:578,names:NAMES[578],deckCount:12,share:.6,validDecks:13,adoptionRate:12/13,linkable:true},
      {rank:2,deckTypeId:258,names:NAMES[258],deckCount:6,share:.3,validDecks:12,adoptionRate:.5,linkable:true},
      {rank:3,deckTypeId:4095,names:NAMES[4095],deckCount:2,share:.1,validDecks:30,adoptionRate:1/15,linkable:false}]};
}
function api(url){
  const q=Object.fromEntries(url.searchParams);
  if(q.view==='deck-distribution')return split(q);
  return {coverage:{allDecks:100,validCardDecks:90},total:3,pageSize:50,cards:[1,2,3].map(i=>({rank:i,cardId:10000000+i,name:(q.lang||'zh')+' card '+i+' <safe>',deckCount:20,usageRate:2/9,copies1:5,copies2:5,copies3:10}))};
}
async function answer(url,respond){
  requests.push(url.href);
  if(url.searchParams.get('view')==='deck-distribution'){
    if(holdNext){const wait=holdNext;holdNext=null;await wait;}
    if(failNext){failNext--;return respond(503,{error:'statistics_unavailable'});}
  }
  respond(200,api(url));
}
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/'))return answer(url,(status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));});
  const file=resolve(root,'.'+url.pathname);
  if(!file.startsWith(root+sep)||!existsSync(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json'})[extname(file)]||'application/octet-stream'});res.end(readFileSync(file));
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base='http://127.0.0.1:'+server.address().port;
let browser,checks=0;
try{
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.route('https://cdn.233.momobako.com/**',route=>route.fulfill({status:404,body:'missing'}));
  if(desktopRoot){
    await context.addInitScript(()=>{
      window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(command,args={})=>{
        if(command==='get_settings')return {player:{launchName:''},server:{gameHost:'fixture',gamePort:7911,apiBaseUrl:'http://fixture'},game:{executable:'ygopro.exe'},ui:{language:new URL(location.href).searchParams.get('L')||'zh'}};
        if(command==='plugin:event|listen')return 1;
        if(command==='read_card_images')return [];
        if(command==='api_request'){
          const response=await fetch('/fixture'+args.route);
          const body=JSON.stringify(await response.json());
          return {status:response.status,contentType:'application/json',bodyBase64:btoa(unescape(encodeURIComponent(body)))};
        }
        return null;
      }};
    });
    await context.route(base+'/fixture/**',async route=>{
      const url=new URL(route.request().url().replace('/fixture/','/'));
      await answer(url,(status,body)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}));
    });
  }
  const errors=[];const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
  const panel=page.locator('#usageSplit'),toggle=index=>page.locator('#body [data-split]').nth(index);
  for(const language of ['zh','ja','en','ko']){
    await page.goto(base+'/usage-stats.html?period=month&month=202609&L='+language);
    await page.locator('[data-usage-view="list"]').click();
    await expect(page.locator('#body tr')).toHaveCount(3);
    await expect(page.locator('#head th')).toHaveCount(9);
    await expect(toggle(0)).toHaveAttribute('aria-expanded','false');
    await toggle(0).click();
    await expect(panel.locator('tbody tr')).toHaveCount(3);
    await expect(toggle(0)).toHaveAttribute('aria-expanded','true');
    assert.equal(await page.locator('#body tr').nth(1).getAttribute('data-split-panel'),'','panel row follows the clicked card');
    const links=panel.locator('a.inline-link');await expect(links).toHaveCount(2);
    const href=new URL(await links.first().getAttribute('href'),base);
    assert.equal(href.pathname,'/deck-detail.html');
    assert.deepEqual([href.searchParams.get('deckTypeId'),href.searchParams.get('period'),href.searchParams.get('month'),href.searchParams.get('L')],['578','month','202609',language==='zh'?null:language]);
    const others=panel.locator('tbody tr').nth(2);
    assert.equal(await others.locator('a').count(),0,'Others must not link to a deck detail page');
    assert.equal((await others.locator('td').nth(1).textContent()).trim(),NAMES[4095][language]);
    assert.deepEqual(await panel.locator('tbody tr td:nth-child(3)').allTextContents(),['60.00%','30.00%','10.00%']);
    assert.ok((await panel.textContent()).includes('100'),'summary states the shares add up to 100%');
    const request=new URL(requests.filter(url=>url.includes('deck-distribution')).at(-1));
    assert.deepEqual(['metric','cardId','period','month','lang'].map(key=>request.searchParams.get(key)),['monster','10000001','month','202609',language]);
    await toggle(1).click();
    await expect(page.locator('[data-split-panel]')).toHaveCount(1);
    await expect(toggle(0)).toHaveAttribute('aria-expanded','false');
    assert.equal(await page.locator('#body tr').nth(2).getAttribute('data-split-panel'),'','only the newest card stays open');
    await toggle(1).click();await expect(panel).toHaveCount(0);
    const before=requests.length;await toggle(0).click();await expect(panel.locator('tbody tr')).toHaveCount(3);
    assert.equal(requests.length,before,'reopening a loaded card reuses its response');
    checks++;
  }
  // Image mode keeps the same open card and places the panel across the full grid row.
  await page.locator('[data-usage-view="image"]').click();
  await expect(page.locator('#usageGrid > .usage-split')).toHaveCount(1);
  const [gridBox,panelBox]=await Promise.all([page.locator('#usageGrid').boundingBox(),panel.boundingBox()]);
  assert.ok(Math.abs(gridBox.width-panelBox.width)<2,'image-mode panel spans the grid');
  await page.locator('#usageGrid [data-split]').nth(2).click();
  await expect(page.locator('#usageGrid > .usage-card').nth(2).locator('xpath=following-sibling::*[1]')).toHaveAttribute('id','usageSplit');
  await page.locator('[data-usage-view="list"]').click();
  await expect(page.locator('#body tr').nth(3)).toHaveAttribute('data-split-panel','');
  checks++;
  // A failed load explains itself and recovers through retry.
  await page.goto(base+'/usage-stats.html?period=all&L=zh');await expect(page.locator('#body tr')).toHaveCount(3);
  failNext=1;await toggle(0).click();
  await expect(panel.locator('[data-split-retry]')).toBeVisible();
  assert.ok((await panel.textContent()).includes('统计超时'));
  await panel.locator('[data-split-retry]').click();
  await expect(panel.locator('tbody tr')).toHaveCount(3);checks++;
  // A response that arrives after the scope changed must not reopen a stale panel.
  let release;holdNext=new Promise(done=>{release=done;});
  await toggle(1).click();await expect(panel.locator('[role="status"]')).toBeVisible();
  await page.locator('[data-p="week"]').click();await expect(page.locator('#body tr')).toHaveCount(3);
  release();await page.waitForTimeout(200);
  await expect(page.locator('[data-split-panel]')).toHaveCount(0);
  await expect(page.locator('#body [data-split][aria-expanded="true"]')).toHaveCount(0);checks++;
  // The deck tab keeps its original table.
  await page.locator('[data-m="deck"]').click();await expect(page.locator('#body [data-split]')).toHaveCount(0);checks++;
  for(const width of [320,390,1280]){
    await page.setViewportSize({width,height:820});
    await page.goto(base+'/usage-stats.html?period=all&L=ja');await page.locator('[data-usage-view="list"]').click();
    await toggle(0).click();await expect(panel.locator('tbody tr')).toHaveCount(3);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal page overflow at '+width);
    await page.locator('#usageTable').evaluate(wrap=>{wrap.scrollLeft=wrap.scrollWidth;});await page.waitForTimeout(50);
    const [wrapBox,listPanel]=await Promise.all([page.locator('#usageTable').boundingBox(),panel.boundingBox()]);
    assert.ok(listPanel.x>=wrapBox.x-1&&listPanel.x+listPanel.width<=wrapBox.x+wrapBox.width+1,'list panel stays inside the visible table area at '+width);
    await page.locator('#usageTable').evaluate(wrap=>{wrap.scrollLeft=0;});
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({path:resolve(output,(desktopRoot?'desktop-':'website-')+'list-'+width+'.png')});
    await page.locator('[data-usage-view="image"]').click();await expect(page.locator('#usageGrid > .usage-split')).toHaveCount(1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal image-mode overflow at '+width);
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({path:resolve(output,(desktopRoot?'desktop-':'website-')+'image-'+width+'.png')});checks++;
  }
  assert.deepEqual(errors,[]);
  console.log('CARD_DECK_SPLIT_UI_OK '+JSON.stringify({platform:desktopRoot?'desktop':'website',checks,screenshots:output}));
}finally{if(browser)await browser.close();await new Promise(done=>server.close(done));}
