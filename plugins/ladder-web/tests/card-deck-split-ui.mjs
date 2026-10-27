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
const requests=[];let failNext=0,holdNext=null,variant='normal';
function split(q){
  const id=Number(q.cardId);
  if(variant!=='normal'){
    const samples=variant==='crowded'?[[578,400],[258,250],[100,100],[101,80],[102,60],[103,40],[104,10],[105,9],[106,1],[4095,50]]:variant==='dominant'?[[578,9998],[258,1],[4095,1]]:variant==='single'?[[578,1000]]:[];
    const total=samples.reduce((sum,[,count])=>sum+count,0);
    return {available:true,card:{cardId:id,zone:q.metric,name:'Fixture'},period:q.period,month:q.month,coverage:{validCardDecks:10000},deckCount:total,usageRate:total/10000,decks:samples.map(([deckTypeId,deckCount],i)=>({rank:i+1,deckTypeId,deckCount,share:deckCount/total,validDecks:10000,adoptionRate:deckCount/10000,names:NAMES[deckTypeId]||{zh:'类型 '+deckTypeId+' <safe>',ja:'分類 '+deckTypeId,en:'Type '+deckTypeId,ko:'분류 '+deckTypeId},linkable:deckTypeId!==4095}))};
  }
  return {available:true,card:{cardId:id,zone:q.metric,name:q.lang+' card '+id},period:q.period,month:q.period==='month'?q.month:null,
    coverage:{validCardDecks:90},deckCount:20,usageRate:2/9,decks:[
      {rank:1,deckTypeId:578,names:NAMES[578],deckCount:12,share:.6,validDecks:13,adoptionRate:12/13,linkable:true},
      {rank:2,deckTypeId:258,names:NAMES[258],deckCount:6,share:.3,validDecks:12,adoptionRate:.5,linkable:true},
      {rank:3,deckTypeId:4095,names:NAMES[4095],deckCount:2,share:.1,validDecks:30,adoptionRate:1/15,linkable:false}]};
}
function api(url){
  const q=Object.fromEntries(url.searchParams);
  if(q.view==='deck-distribution')return split(q);
  return {coverage:{allDecks:100,validCardDecks:90},total:12,pageSize:50,cards:Array.from({length:12},(_,n)=>n+1).map(i=>({rank:i,cardId:10000000+i,name:q.lang==='zh'&&i===1?'冥府的使者 格斯（示例）':(q.lang||'zh')+' card '+i+' <safe>',deckCount:20,usageRate:2/9,copies1:5,copies2:5,copies3:10}))};
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
  if(url.pathname==='/deck-detail.html'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Detail</title><p>Detail fixture</p>');return;}
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
  const context=await browser.newContext({viewport:{width:1280,height:900},hasTouch:true});
  await context.route('https://cdn.233.momobako.com/**',route=>route.fulfill({status:404,body:'missing'}));
  await context.route(base+'/deck-detail.html**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Deck detail</title><p>Deck detail fixture</p>'}));
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
  const errors=[],page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
  const panel=page.locator('dialog#usageSplit'),toggle=index=>page.locator('#body [data-split]').nth(index);
  const distributionCount=()=>requests.filter(url=>url.includes('deck-distribution')).length;
  const mode=value=>panel.locator('[data-split-view="'+value+'"]');
  async function open(index=0){await toggle(index).click();await expect(panel.locator('[data-split-view="pie"]')).toBeVisible();}
  async function close(){await panel.locator('[data-split-close]').click();await expect(panel).toHaveCount(0);}
  async function fresh(kind='normal',language='zh'){
    variant=kind;
    await page.goto(base+'/usage-stats.html?period=month&month=202609&L='+language);
    await page.locator('[data-usage-view="list"]').click();
    await expect(page.locator('#body tr')).toHaveCount(12);
    await page.evaluate(()=>localStorage.removeItem('srvpro.usage.splitView'));
    await page.reload();await expect(page.locator('#body tr')).toHaveCount(12);
  }
  // Real chart interactions in all languages: a sector selects; only the explicit link navigates.
  for(const language of ['zh','ja','en','ko']){
    await fresh('normal',language);await open();
    await expect(mode('pie')).toHaveAttribute('aria-pressed','true');
    await expect(panel.locator('[data-split-sector]')).toHaveCount(3);
    assert.equal(await panel.locator('a').count(),0,'nothing navigates until a type is selected');
    const before=distributionCount(),url=page.url(),box=await panel.locator('svg').boundingBox();
    await page.mouse.click(box.x+box.width*.86,box.y+box.height*.5);
    await expect(panel.locator('[data-split-sector="578"]')).toHaveAttribute('aria-pressed','true');
    await expect(panel.locator('[data-split-selection]')).toContainText('60.00%');
    assert.equal(page.url(),url,'sector click never navigates');
    const href=new URL(await panel.locator('[data-split-detail]').getAttribute('href'),base);
    assert.deepEqual([href.pathname,href.searchParams.get('deckTypeId'),href.searchParams.get('period'),href.searchParams.get('month'),href.searchParams.get('L')],['/deck-detail.html','578','month','202609',language==='zh'?null:language]);
    if(language==='zh'){
      await page.setViewportSize({width:390,height:820});
      await page.screenshot({path:resolve(output,(desktopRoot?'desktop':'website')+'-donut-zh-390.png')});
      await page.setViewportSize({width:1280,height:900});
    }
    await panel.locator('[data-split-select="4095"]').click();await expect(panel.locator('[data-split-detail]')).toHaveCount(0);
    await mode('list').click();await expect(panel.locator('tbody tr')).toHaveCount(3);
    assert.deepEqual(await panel.locator('tbody tr td:nth-child(3)').allTextContents(),['60.00%','30.00%','10.00%']);
    await expect(panel.locator('a.inline-link')).toHaveCount(2);
    assert.equal(await panel.locator('tbody tr').last().locator('a').count(),0);
    await mode('pie').click();assert.equal(distributionCount(),before,'mode switching reuses the same response');
    await page.keyboard.press('Escape');await expect(panel).toHaveCount(0);await expect(toggle(0)).toBeFocused();
    await open();assert.equal(distributionCount(),before,'reopening reuses the cached response');
    await mode('list').click();await close();await open();await expect(mode('list')).toHaveAttribute('aria-pressed','true');
    await mode('pie').click();await close();
    const request=new URL(requests.filter(url=>url.includes('deck-distribution')).at(-1));
    assert.deepEqual(['metric','cardId','period','month','lang'].map(key=>request.searchParams.get(key)),['monster','10000001','month','202609',language]);checks++;
  }
  // Grouping keeps the true total, every small type, and a large text selection target.
  await fresh('crowded');await open();
  await expect(panel.locator('[data-split-sector]')).toHaveCount(8);
  await expect(panel.locator('[data-split-sector="rest"]')).toHaveAttribute('aria-disabled','true');
  await panel.locator('[data-split-select="rest"]').click();
  await expect(panel.locator('[data-split-members] [data-split-select]')).toHaveCount(3);
  await expect(panel.locator('[data-split-detail]')).toHaveCount(0);
  await panel.locator('[data-split-members] [data-split-select="106"]').click();
  await expect(panel.locator('[data-split-detail]')).toHaveAttribute('href',/deckTypeId=106&/);
  assert.equal(await panel.locator('img').count(),0,'names remain plain text');
  await mode('list').click();await expect(panel.locator('tbody tr')).toHaveCount(10);
  assert.equal((await panel.locator('tbody tr td:nth-child(4)').allTextContents()).reduce((sum,x)=>sum+Number(x),0),1000);
  await close();checks++;
  // One complete 100% ring, almost invisible tails, and zero samples have distinct states.
  await fresh('single');await open();await expect(panel.locator('[data-split-sector]')).toHaveCount(1);
  await panel.locator('[data-split-sector="578"]').focus();await page.keyboard.press('Enter');
  await expect(panel.locator('[data-split-selection]')).toContainText('100.00%');await close();
  await fresh('dominant');await open();await expect(panel.locator('[data-split-sector]')).toHaveCount(3);
  await expect(panel.locator('[data-split-sector="rest"]')).toHaveAttribute('aria-disabled','true');
  await panel.locator('[data-split-select="258"]').click();await expect(panel.locator('[data-split-selection]')).toContainText('0.01%');
  await expect(panel.locator('[data-split-detail]')).toHaveAttribute('href',/deckTypeId=258&/);await close();
  await fresh('empty');await toggle(0).click();await expect(panel.locator('.empty-state')).toBeVisible();
  await expect(panel.locator('svg')).toHaveCount(0);await close();checks++;
  // Failed requests can retry; closed requests and old scopes never reopen a dialog.
  await fresh();failNext=1;await toggle(0).click();await expect(panel.locator('[data-split-retry]')).toBeVisible();
  await panel.locator('[data-split-retry]').click();await expect(panel.locator('svg')).toBeVisible();
  await expect(panel.locator('[data-split-close]')).toBeFocused();await close();
  let release;holdNext=new Promise(done=>{release=done;});await toggle(1).click();await expect(panel.locator('[role="status"]')).toBeVisible();
  await close();await page.locator('[data-p="week"]').click();await expect(page.locator('#body tr')).toHaveCount(12);
  release();await page.waitForTimeout(100);await expect(panel).toHaveCount(0);checks++;
  // Small screens retain large text controls and the same explicit touch navigation.
  for(const [width,height] of [[320,820],[390,820],[640,360],[1280,900]]){
    await page.setViewportSize({width,height});await fresh('crowded','ja');
    await page.locator('[data-usage-view="image"]').click();
    const beforeImages=await page.locator('#usageGrid > .usage-card').count();
    await page.locator('#usageGrid [data-split]').first().click();await expect(panel.locator('svg')).toBeVisible();
    assert.equal(await page.locator('#usageGrid > .usage-card').count(),beforeImages,'opening never tears down the image grid');
    const controls=await panel.locator('.usage-split-legend button').evaluateAll(items=>items.map(x=>({width:x.getBoundingClientRect().width,height:x.getBoundingClientRect().height})));
    assert.ok(controls.every(x=>x.width>=44&&x.height>=44),'legend hit targets are at least 44px');
    const small=panel.locator('.usage-split-legend [data-split-select="106"]');await small.scrollIntoViewIfNeeded();await small.tap();
    await expect(panel.locator('[data-split-detail]')).toHaveAttribute('href',/deckTypeId=106&/);
    const detailBox=await panel.locator('[data-split-detail]').boundingBox();
    assert.ok(detailBox.y>=0&&detailBox.y+detailBox.height<=height,'selected detail button stays visible after tapping a low category');
    assert.equal(await panel.evaluate(x=>x.scrollWidth>x.clientWidth),false,'dialog does not overflow at '+width);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'page does not overflow at '+width);
    await panel.locator('.usage-split-content').evaluate(x=>{x.scrollTop=0;});
    if(width===640){
      const ring=await panel.locator('svg').boundingBox(),dock=await panel.locator('[data-split-selection]').boundingBox();
      assert.ok(ring.y+ring.height<=dock.y+1,'landscape shows the whole ring above the fixed detail bar');
    }
    await page.screenshot({path:resolve(output,(desktopRoot?'desktop':'website')+'-donut-'+width+'x'+height+'.png')});
    await mode('list').click();await expect(panel.locator('tbody tr')).toHaveCount(10);
    assert.equal(await panel.locator('.usage-split-table').evaluate(x=>x.scrollWidth>x.clientWidth),false,'list has no sideways scrolling at '+width);
    await close();checks++;
  }
  // Returning from a selected deck restores the dialog and original ranking scope.
  await page.setViewportSize({width:1280,height:900});await fresh();await open();
  await panel.locator('[data-split-select="578"]').click();
  await panel.locator('[data-split-detail]').click();await page.waitForURL('**/deck-detail.html?**');
  const savedSnapshot=await page.evaluate(()=>sessionStorage.getItem('srvpro.usage.splitReturn'));
  assert.ok(savedSnapshot,'navigation stores a real snapshot before leaving');
  await page.goBack({waitUntil:'commit'});await expect(panel.locator('[data-split-detail]')).toHaveAttribute('href',/deckTypeId=578&/);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('srvpro.usage.splitReturn')),null,'normal return consumes the saved navigation snapshot');
  await expect(mode('pie')).toHaveAttribute('aria-pressed','true');await close();checks++;
  await page.reload();await expect(page.locator('#body tr')).toHaveCount(12);await expect(panel).toHaveCount(0);
  // Exercise the persisted pageshow boundary deterministically: browsers may decline BFCache.
  // Reuse the actual navigation snapshot, rather than inventing a different state shape.
  await page.evaluate(snapshot=>{
    sessionStorage.setItem('srvpro.usage.splitReturn',snapshot);
    window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
  },savedSnapshot);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('srvpro.usage.splitReturn')),null,'persisted pageshow consumes the matching navigation snapshot');
  await page.reload();await expect(page.locator('#body tr')).toHaveCount(12);await expect(panel).toHaveCount(0);checks++;
  // Storage failure changes only persistence, never the interaction itself.
  await page.addInitScript(()=>{Object.defineProperty(Storage.prototype,'getItem',{value(){throw Error('storage disabled')}});Object.defineProperty(Storage.prototype,'setItem',{value(){throw Error('storage disabled')}});});
  await page.reload();await expect(page.locator('#body tr')).toHaveCount(12);await open();
  await expect(mode('pie')).toHaveAttribute('aria-pressed','true');await mode('list').click();await expect(panel.locator('tbody tr')).toHaveCount(3);await close();checks++;
  await page.locator('[data-m="deck"]').click();await expect(page.locator('#body [data-split]')).toHaveCount(0);
  assert.deepEqual(errors,[]);
  console.log('CARD_DECK_SPLIT_UI_OK '+JSON.stringify({platform:desktopRoot?'desktop':'website',checks,screenshots:output}));
}finally{if(browser)await browser.close();await new Promise(done=>server.close(done));}
