import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {existsSync,readFileSync,mkdirSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';

const desktopRoot=process.env.SRVPRO_DESKTOP_ROOT;
const root=desktopRoot?resolve(desktopRoot,'public'):resolve(import.meta.dirname,'../web');
const clientRoot=process.env.SRVPRO_CLIENT_ROOT||resolve(import.meta.dirname,'../../../../srvprotiantiweb');
const {chromium,expect}=createRequire(resolve(clientRoot,'package.json'))('@playwright/test');
const output=resolve(process.env.SRVPRO_USAGE_OUTPUT||resolve(import.meta.dirname,'../../../../.audit-tmp/usage-images-ui'));
mkdirSync(output,{recursive:true});
const image='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="290"><rect width="200" height="290" fill="#425d7d"/><rect x="12" y="12" width="176" height="266" fill="#28394f" stroke="#91b5d8"/><text x="100" y="145" text-anchor="middle" fill="white" font-size="20">TEST CARD</text></svg>';
const imageData='data:image/svg+xml;base64,'+Buffer.from(image).toString('base64');
const statistics=[];
function api(url){
  const q=Object.fromEntries(url.searchParams),page=Number(q.page)||1;
  const coverage={allDecks:100,validCardDecks:90};
  if(url.pathname.endsWith('/decks'))return {decks:[{rank:1,deckTypeId:100,names:{zh:'测试卡组',en:'Test deck'},count:50,usageRate:.5}],coverage,total:1};
  const start=(page-1)*50;
  return {coverage,total:53,pageSize:50,cards:Array.from({length:Math.max(0,Math.min(50,53-start))},(_,i)=>({rank:start+i+1,cardId:10000000+start+i,name:(q.lang||'zh')+' card '+(start+i+1)+' <safe>',deckCount:20,usageRate:2/9,copies1:5,copies2:5,copies3:10}))};
}
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){statistics.push(url.href);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(api(url)));return;}
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
  const cdn=[],errors=[];let failLanguages=[],releaseImage;
  await context.route('https://cdn.233.momobako.com/**',async route=>{
    const url=route.request().url();cdn.push(url);
    if(releaseImage){const wait=releaseImage;releaseImage=null;await wait;}
    const language=new URL(url).pathname.split('/')[2];
    if(failLanguages.includes(language))await route.fulfill({status:404,body:'missing'});
    else await route.fulfill({status:200,contentType:'image/svg+xml',body:image});
  });
  if(desktopRoot)await context.addInitScript(({imageData})=>{
    window.__nativeCalls=[];window.__localImages=[];
    window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(command,args={})=>{
      window.__nativeCalls.push({command,args});
      if(command==='get_settings')return {player:{launchName:''},server:{gameHost:'fixture',gamePort:7911,apiBaseUrl:'http://fixture'},game:{executable:'ygopro.exe'},ui:{language:new URL(location.href).searchParams.get('L')||'zh'}};
      if(command==='plugin:event|listen')return 1;
      if(command==='read_card_images'){
        if(window.__localDelay)await new Promise(done=>setTimeout(done,window.__localDelay));
        if(window.__holdLocal)await new Promise(done=>{
          (window.__heldLocal||(window.__heldLocal=[])).push(done);
          window.__releaseLocal=()=>window.__heldLocal.splice(0).forEach(release=>release());
        });
        return window.__localImages;
      }
      if(command==='api_request'){
        const response=await fetch('/fixture-statistics'+args.route.slice(args.route.indexOf('?')));
        const body=JSON.stringify(await response.json());
        return {status:200,contentType:'application/json',bodyBase64:btoa(unescape(encodeURIComponent(body)))};
      }
      return null;
    }};
    const canvas=document.createElement('canvas');canvas.width=200;canvas.height=290;
    canvas.getContext('2d').fillRect(0,0,200,290);
    window.__validLocal={contentType:'image/png',bodyBase64:canvas.toDataURL('image/png').split(',')[1]};
  },{imageData});
  if(desktopRoot)await context.route(base+'/fixture-statistics**',async route=>{
    const url=new URL(route.request().url());statistics.push(url.href);
    await route.fulfill({contentType:'application/json',body:JSON.stringify(api(new URL('/api/ladder/usage/'+(url.searchParams.get('metric')==='deck'?'decks':'cards')+url.search,base)))});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
  for(const language of ['zh','ja','en','ko']){
    await page.setViewportSize({width:1280,height:900});
    await page.goto(base+'/usage-stats.html?period=all&page=2&L='+language);
    await expect(page.locator('#body tr')).toHaveCount(3);
    // Each fresh language test starts in list mode; other tests check persistence.
    const list=page.locator('[data-usage-view="list"]');
    await expect(list).toBeVisible();await list.click();
    if(language==='zh')assert.equal(cdn.length,0,'initial list mode must never load card images');
    const before=statistics.length,imagesBefore=cdn.length;
    await expect(page.locator('[data-usage-view="image"]')).toHaveAttribute('aria-pressed','false');
    await page.locator('[data-usage-view="image"]').click();
    await expect(page.locator('#usageGrid')).toBeVisible();
    await expect(page.locator('.usage-card')).toHaveCount(3);
    await expect(page.locator('.usage-card').first()).toContainText('22.22%');
    await expect(page.locator('.usage-card').first().locator('dd')).toHaveText(['20','5','5','10']);
    await expect(page.locator('.usage-card').first().locator('.card-image-link')).toHaveAttribute('href','https://ygocdb.com/card/10000050');
    await expect(page.locator('.usage-card').first().locator('img')).toBeVisible();
    assert.equal(statistics.length,before,'view switch must not query statistics');
    assert.equal(new URL(page.url()).searchParams.get('page'),'2');
    assert.ok(cdn.slice(imagesBefore).every(url=>url.includes('/'+({zh:'sc',ja:'jp',en:'en',ko:'jp'})[language]+'/')&&url.endsWith('.webp!half')));
    await page.setViewportSize({width:320,height:820});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'four-language narrow layout: '+language);
    await page.reload();await expect(page.locator('#usageGrid')).toBeVisible();
    await page.locator('[data-m="deck"]').click();await expect(page.locator('#body tr')).toHaveCount(1);
    await expect(page.locator('#usageViews')).toBeHidden();await expect(page.locator('#usageGrid')).toBeHidden();
    checks++;
  }
  await page.setViewportSize({width:1280,height:900});
  // Keep text available during a delayed image and hide it only after decoding.
  await page.evaluate(()=>localStorage.clear());
  await page.goto(base+'/usage-stats.html?period=all&page=2&L=ja');await expect(page.locator('#body tr')).toHaveCount(3);
  let release;releaseImage=new Promise(done=>{release=done;});
  await page.locator('[data-usage-view="image"]').click();
  await expect(page.locator('.card-image-fallback').first()).toBeVisible();release();
  await expect(page.locator('.usage-card img').first()).toBeVisible();
  await expect(page.locator('.card-image-fallback').first()).toBeHidden();checks++;

  for(const language of ['zh','ja','en','ko']){
    failLanguages=language==='en'?['en']:[({zh:'sc',ja:'jp',ko:'jp'})[language]];
    // New page contexts clear decoded image caches and prevent previous successes hiding failures.
    await page.evaluate(()=>localStorage.clear());
    await page.goto(base+'/usage-stats.html?period=all&page=2&L='+language);
    await expect(page.locator('#body tr')).toHaveCount(3);
    const before=cdn.length;
    await page.locator('[data-usage-view="image"]').click();
    if(language==='en')await expect(page.locator('.card-image-fallback').first()).toBeVisible();
    else await expect(page.locator('.usage-card img').first()).toBeVisible();
    await expect.poll(()=>cdn.slice(before).filter(url=>url.includes('/10000050.')).length).toBe(language==='en'?1:2);
    const attempts=cdn.slice(before).filter(url=>url.includes('/10000050.')).map(url=>new URL(url).pathname.split('/')[2]);
    assert.deepEqual(attempts,language==='en'?['en']:[({zh:'sc',ja:'jp',ko:'jp'})[language],'en']);checks++;
  }
  failLanguages=['jp','en'];
  await page.goto(base+'/usage-stats.html?period=all&page=2&L=ko');
  await expect.poll(()=>page.locator('.card-image-link').first().getAttribute('data-image-state')).toBe('failed');
  await expect(page.locator('.card-image-fallback').first()).toBeVisible();
  await expect(page.locator('.card-image-fallback').first()).toContainText('ko card 51 <safe>');
  assert.equal(await page.locator('.usage-card script').count(),0);checks++;
  if(desktopRoot){
    failLanguages=[];
    await page.evaluate(()=>localStorage.clear());
    await page.goto(base+'/usage-stats.html?period=all&page=2&L=zh');await expect(page.locator('#body tr')).toHaveCount(3);
    await page.evaluate(()=>{window.__localImages=[window.__validLocal];window.__localDelay=3300;});
    const delayedBefore=cdn.length;await page.locator('[data-usage-view="image"]').click();
    await page.waitForTimeout(3100);assert.equal(cdn.length,delayedBefore,'a slow pending local lookup must never start CDN requests');
    await expect(page.locator('.usage-card img').first()).toBeVisible();assert.equal(cdn.length,delayedBefore);
    await page.evaluate(()=>{window.__localDelay=0;});checks++;
    await page.evaluate(()=>localStorage.clear());
    await page.goto(base+'/usage-stats.html?period=all&page=2&L=ko');await expect(page.locator('#body tr')).toHaveCount(3);
    await page.locator('[data-usage-view="list"]').click();
    await page.evaluate(()=>{window.__localImages=[{contentType:'image/png',bodyBase64:'invalid'},window.__validLocal];});
    const before=cdn.length;await page.locator('[data-usage-view="image"]').click();
    await expect(page.locator('.usage-card img').first()).toBeVisible();assert.equal(cdn.length,before,'valid local images must prevent all CDN requests');checks++;
    await page.evaluate(()=>localStorage.clear());
    await page.goto(base+'/usage-stats.html?period=all&page=2&L=zh');
    await expect(page.locator('#body tr')).toHaveCount(3);
    await page.evaluate(()=>{window.__localImages=[];window.__holdLocal=true;});
    await page.locator('[data-usage-view="image"]').click();
    await expect.poll(()=>page.evaluate(()=>typeof window.__releaseLocal)).toBe('function');
    await page.locator('[data-usage-view="list"]').click();
    await page.locator('[data-usage-view="image"]').click();
    await expect.poll(()=>page.evaluate(()=>window.__nativeCalls.filter(call=>call.command==='read_card_images').length)).toBe(4);
    await page.locator('[data-usage-view="list"]').click();
    const cancelledBefore=cdn.length;await page.evaluate(()=>{window.__holdLocal=false;window.__releaseLocal();});
    await page.waitForTimeout(100);assert.equal(cdn.length,cancelledBefore,'cancelled local lookup must not start network requests');checks++;
  }
  failLanguages=[];
  await page.goto(base+'/usage-stats.html?period=all&L=zh');await expect(page.locator('#body tr')).toHaveCount(50);
  await page.locator('[data-usage-view="image"]').click();await expect(page.locator('.usage-card')).toHaveCount(50);
  const loaded=cdn.length;await page.waitForTimeout(100);assert.ok(cdn.length-loaded<50,'offscreen images must remain lazy');
  await page.screenshot({path:resolve(output,(desktopRoot?'desktop-':'website-')+'wide.png'),fullPage:false});
  for(const [width,expectedColumns] of [[320,3],[390,3],[640,3],[900,5],[1280,8]]){
    await page.setViewportSize({width,height:820});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal page overflow at '+width);
    const columns=await page.locator('#usageGrid').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length);assert.equal(columns,expectedColumns,'compact grid columns at '+width);
    await page.locator('.usage-card').first().scrollIntoViewIfNeeded();
    await page.screenshot({path:resolve(output,(desktopRoot?'desktop-':'website-')+width+'.png'),fullPage:false});checks++;
  }
  const blocked=await context.newPage();await blocked.addInitScript(()=>{Storage.prototype.setItem=function(){throw Error('blocked storage');};});
  await blocked.goto(base+'/usage-stats.html?period=all&page=2');await blocked.locator('[data-usage-view="image"]').click();await expect(blocked.locator('#usageGrid')).toBeVisible();await blocked.close();checks++;
  assert.deepEqual(errors,[]);
  console.log('USAGE_IMAGES_UI_OK '+JSON.stringify({platform:desktopRoot?'desktop':'website',checks,screenshots:output}));
}finally{if(browser)await browser.close();await new Promise(done=>server.close(done));}
