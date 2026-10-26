import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';

const desktopRoot=process.env.SRVPRO_DESKTOP_ROOT;
const root=desktopRoot?resolve(desktopRoot,'public'):resolve(import.meta.dirname,'../web');
const clientRoot=process.env.SRVPRO_CLIENT_ROOT||resolve(import.meta.dirname,'../../../../srvprotiantiweb');
const output=resolve(process.env.SRVPRO_USAGE_OUTPUT||resolve(import.meta.dirname,'../../../../.audit-tmp/deck-card-images-ui'));
const {chromium,expect}=createRequire(resolve(clientRoot,'package.json'))('@playwright/test');
mkdirSync(output,{recursive:true});
const names={zh:'测试卡组',ja:'テストデッキ',en:'Test deck',ko:'테스트 덱'};
const requests=[];
function statistics(url){
  const q=Object.fromEntries(url.searchParams),selected={id:Number(q.deckTypeId)||100,names,templateFiles:[]};
  const common={selected,period:q.period,month:q.period==='month'?q.month:null};
  if(q.view!=='card-usage')return {...common,overall:{matches:4,matchWins:2},opponents:[],usage:{count:100,usageRate:.5},topPlayers:[]};
  requests.push(q);
  return {...common,available:true,coverage:{allDecks:100,validCardDecks:90},cards:Object.fromEntries(['monster','spell','trap','extra','side'].map((zone,index)=>[zone,zone==='trap'?[]:Array.from({length:53},(_,i)=>({rank:i+1,cardId:10000000+index*1000+i,name:q.lang+' '+zone+' '+(i+1)+' <safe>',deckCount:20,usageRate:2/9,copies1:5,copies2:5,copies3:10}))]))};
}
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/fixture/api/'))url.pathname=url.pathname.slice('/fixture'.length);
  if(url.pathname.startsWith('/api/')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(statistics(url)));return;}
  const file=resolve(root,'.'+url.pathname);
  if(!file.startsWith(root+sep)||!existsSync(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':({'.js':'text/javascript','.css':'text/css','.json':'application/json'})[extname(file)]||'text/html; charset=utf-8'});res.end(readFileSync(file));
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base='http://127.0.0.1:'+server.address().port;
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="290"><rect width="200" height="290" fill="#425d7d"/></svg>';
let browser,checks=0;
try{
  browser=await chromium.launch({headless:true,channel:'msedge'});
  for(const language of ['zh','ja','en','ko']){
    const context=await browser.newContext({viewport:{width:1280,height:900}}),cdn=[],errors=[];
    const fail={zh:['sc'],ja:['jp','en'],en:['en'],ko:[]}[language];
    await context.route('https://cdn.233.momobako.com/**',route=>{
      const url=new URL(route.request().url());cdn.push(url.href);
      return route.fulfill(fail.includes(url.pathname.split('/')[2])?{status:404,body:'missing'}:{status:200,contentType:'image/svg+xml',body:svg});
    });
    if(desktopRoot)await context.addInitScript(()=>{
      window.__nativeImages=[];window.__imageCalls=[];
      window.__TAURI_INTERNALS__={transformCallback:()=>1,invoke:async(command,args={})=>{
        if(command==='get_settings')return {player:{launchName:''},server:{gameHost:'fixture',gamePort:7911,apiBaseUrl:'http://fixture'},game:{executable:'ygopro.exe'},ui:{language:new URL(location.href).searchParams.get('L')||'zh'}};
        if(command==='plugin:event|listen')return 1;
        if(command==='read_card_images'){window.__imageCalls.push(args);if(window.__holdLocal)await new Promise(done=>(window.__releaseLocal||(window.__releaseLocal=[])).push(done));return window.__nativeImages;}
        if(command==='api_request'){
          const response=await fetch('/fixture'+args.route),body=await response.text();
          return {status:200,contentType:'application/json',bodyBase64:btoa(unescape(encodeURIComponent(body)))};
        }
        return null;
      }};
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
    const start=requests.length;
    await page.goto(base+'/deck-detail.html?deckTypeId=100&period=month&month=202610&L='+language);
    await expect(page.locator('[data-card-expand]')).toBeVisible();
    assert.equal(requests.length,start);assert.equal(cdn.length,0,'collapsed section must not request images');
    await page.locator('[data-card-expand]').click();
    await expect(page.locator('[data-card-table] tbody tr')).toHaveCount(50);
    assert.equal(cdn.length,0,'list view must not request images');
    await expect(page.locator('[data-card-view="image"]')).toHaveAttribute('aria-pressed','false');
    await page.locator('[data-card-view="image"]').click();
    await expect(page.locator('[data-card-grid] .usage-card')).toHaveCount(50);
    await expect(page.locator('[data-card-table]')).toHaveCount(0);
    const first=page.locator('[data-card-grid] .usage-card').first();
    await expect(first.locator('dd')).toHaveText(['20','5','5','10']);
    await expect(first).toContainText('22.22%');
    await expect(first.locator('a')).toHaveAttribute('href','https://ygocdb.com/card/10000000');
    await first.scrollIntoViewIfNeeded();
    const failed=language==='ja'||language==='en';
    await expect(first.locator('a')).toHaveAttribute('data-image-state',failed?'failed':'loaded');
    await expect(first.locator('.card-image-fallback'))[failed?'toBeVisible':'toBeHidden']();
    if(failed)await expect(first.locator('.card-image-fallback')).toContainText(language+' monster 1 <safe>');
    const firstSources=cdn.filter(url=>url.includes('/10000000.webp')).map(url=>new URL(url).pathname.split('/')[2]);
    assert.deepEqual(firstSources,({zh:['sc','en'],ja:['jp','en'],en:['en'],ko:['jp']})[language]);
    assert.equal(requests.length,start+1,'view switch must not query statistics');
    await page.locator('[data-card-next]').click();
    await expect(page.locator('[data-card-grid] .usage-card')).toHaveCount(3);
    await expect(page.locator('[data-card-grid] .usage-card').first()).toContainText('51');
    await page.locator('[data-card-view="list"]').click();
    await expect(page.locator('[data-card-table] tbody tr')).toHaveCount(3);
    await expect(page.locator('[data-card-table] tbody tr').first()).toContainText(language+' monster 51');
    await page.locator('[data-card-view="image"]').focus();await page.locator('[data-card-view="image"]').press('Enter');
    await expect(page.locator('[data-card-view="image"]')).toBeFocused();
    await page.locator('[data-card-zone="trap"]').click();await expect(page.locator('[data-card-empty]')).toBeVisible();
    await page.locator('[data-card-zone="side"]').click();await expect(page.locator('[data-card-grid] .usage-card')).toHaveCount(50);
    assert.equal(requests.length,start+1,'zone and page changes use cached statistics');
    for(const width of [1280,390,320]){
      await page.setViewportSize({width,height:900});
      await page.locator('[data-card-grid]').scrollIntoViewIfNeeded();
      const layout=await page.locator('[data-card-grid]').evaluate(grid=>({columns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,overflow:document.documentElement.scrollWidth>innerWidth}));
      assert.equal(layout.columns,width===1280?8:3);assert.equal(layout.overflow,false,'no page overflow: '+language+' '+width);
      if(language==='zh')await page.screenshot({path:resolve(output,(desktopRoot?'desktop-':'website-')+'deck-card-'+width+'.png')});
    }
    await page.locator('[data-card-expand]').click();await expect(page.locator('[data-card-grid]')).toHaveCount(0);
    await page.reload();await page.locator('[data-card-expand]').click();
    await expect(page.locator('[data-card-view="image"]')).toHaveAttribute('aria-pressed','true');
    if(desktopRoot){
      const before=cdn.length;
      await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=200;canvas.height=290;window.__nativeImages=[{contentType:'image/png',bodyBase64:canvas.toDataURL('image/png').split(',')[1]}];});
      await page.locator('[data-card-zone="spell"]').click();await page.locator('[data-card-grid] a').first().scrollIntoViewIfNeeded();
      await expect(page.locator('[data-card-grid] a').first()).toHaveAttribute('data-image-state','loaded');
      assert.ok((await page.evaluate(()=>window.__imageCalls.length))>0);assert.equal(cdn.length,before,'native images must bypass CDN');
      await page.evaluate(()=>{window.__nativeImages=[];window.__holdLocal=true;});
      await page.locator('[data-card-zone="extra"]').click();await page.locator('[data-card-grid] a').first().scrollIntoViewIfNeeded();
      await expect.poll(()=>page.evaluate(()=>window.__releaseLocal?.length||0)).toBeGreaterThan(0);
      await page.locator('[data-card-expand]').click();
      const cancelled=cdn.length;await page.evaluate(()=>{window.__holdLocal=false;window.__releaseLocal.splice(0).forEach(done=>done());});
      await page.waitForTimeout(100);assert.equal(cdn.length,cancelled,'collapsed section cancels remote fallback');
    }
    assert.deepEqual(errors,[]);checks++;await context.close();
  }
  console.log('DECK_CARD_IMAGES_UI_OK '+JSON.stringify({platform:desktopRoot?'desktop':'website',languages:checks,screenshots:output}));
}finally{if(browser)await browser.close();await new Promise(done=>server.close(done));}
