import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,extname} from 'node:path';

const root=resolve(import.meta.dirname,'../web'),workspace=resolve(root,'../../../..');
const output=resolve(workspace,'.audit-tmp/deck-card-implementation-20261025/ui');
mkdirSync(output,{recursive:true});
const names={zh:'测试卡组',ja:'テストデッキ',en:'Test deck',ko:'테스트 덱'};
const requests=[];let failure=0,valid=90;
function cards(url){
  const q=Object.fromEntries(url.searchParams),lang=q.lang||'zh';
  return {available:true,selected:{id:Number(q.deckTypeId),names},period:q.period,month:q.period==='month'?q.month:null,startDay:'20261001',endDay:'20261101',coverage:{allDecks:100,validCardDecks:valid},cardLimit:200,pageSize:50,
    cards:Object.fromEntries(['monster','spell','trap','extra','side'].map((zone,z)=>[zone,zone==='trap'||!valid?[]:Array.from({length:z===0?205:53},(_,i)=>({rank:i+1,cardId:10000000+i,name:(i===0?'=danger, "name"':lang+' '+zone+' '+(i+1)),deckCount:20,usageRate:2/9,copies1:5,copies2:5,copies3:10}))])),generatedAt:new Date().toISOString()};
}
const server=createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
    let body={};
    if(url.pathname==='/api/ladder/deck-detail'&&url.searchParams.get('view')!=='card-usage')body={selected:{id:Number(url.searchParams.get('deckTypeId'))||100,names,templateFiles:[]},period:url.searchParams.get('period'),month:url.searchParams.get('period')==='month'?url.searchParams.get('month'):null,overall:{matches:4,matchWins:2},opponents:[],usage:{count:100,usageRate:.5},topPlayers:[]};
    else if(url.pathname==='/api/ladder/deck-detail'&&url.searchParams.get('view')==='card-usage'){requests.push(Object.fromEntries(url.searchParams));body=failure?{error:'unavailable'}:cards(url);}
    res.writeHead(url.searchParams.get('view')==='card-usage'?failure||200:200,{'Content-Type':'application/json'});res.end(JSON.stringify(body));return;
  }
  const file=resolve(root,'.'+url.pathname);
  if(!file.startsWith(root)||!existsSync(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':extname(file)==='.js'?'application/javascript':extname(file)==='.css'?'text/css':'text/html; charset=utf-8'});res.end(readFileSync(file));
});
await new Promise(done=>server.listen(process.argv.includes('--serve')?14825:0,'127.0.0.1',done));
const base='http://127.0.0.1:'+server.address().port;
if(process.argv.includes('--serve'))console.log('Preview: '+base+'/deck-detail.html?deckTypeId=100&period=month&month=202610');
else{
  const require=createRequire(resolve(workspace,'srvprotiantiweb/package.json'));
  const {chromium,expect}=require('@playwright/test');
  const ExcelJS=createRequire(resolve(workspace,'srvprotianti-desktop/package.json'))('exceljs');
  const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser=await chromium.launch({headless:true,executablePath:existsSync(edge)?edge:undefined});
  const page=await browser.newPage({acceptDownloads:true}),errors=[];page.on('pageerror',e=>errors.push(String(e)));
  try{
    for(const lang of ['zh','ja','en','ko']){
      const before=requests.length;
      await page.goto(base+'/deck-detail.html?deckTypeId=100&period=month&month=202610&L='+lang);
      await expect(page.locator('[data-card-expand]')).toBeVisible();
      await expect(page.locator('[data-deck-card-usage] h2')).toHaveText(({zh:'单卡投入率',ja:'カード採用率',en:'Card adoption',ko:'카드 투입률'})[lang]);
      assert.equal(requests.length,before,'collapsed section must never query card statistics');
      await expect(page.locator('[data-card-expand]')).toHaveAttribute('aria-expanded','false');
      await page.locator('[data-card-expand]').focus();await page.locator('[data-card-expand]').press('Enter');await expect(page.locator('[data-card-table] tbody tr')).toHaveCount(50);
      await expect(page.locator('[data-card-expand]')).toBeFocused();
      await page.locator('[data-card-expand]').press('Space');await expect(page.locator('[data-card-expand]')).toHaveAttribute('aria-expanded','false');
      await page.locator('[data-card-expand]').press('Enter');await expect(page.locator('[data-card-table] tbody tr')).toHaveCount(50);
      await expect(page.locator('[data-card-table] tbody tr').first().locator('a')).toHaveCount(2);
      await expect(page.locator('[data-card-table] tbody tr').first().locator('a').first()).toHaveAttribute('href','https://ygocdb.com/card/10000000');
      assert.equal(requests.length,before+1);assert.equal(requests.at(-1).lang,lang);
      await page.locator('[data-card-next]').click();await expect(page.locator('[data-card-table] tbody tr').first()).toContainText(lang+' monster 51');
      await page.locator('[data-tab="1"]').click();await expect(page.locator('[data-card-expand]')).toHaveAttribute('aria-expanded','true');
      await expect(page.locator('[data-card-table] tbody tr').first()).toContainText(lang+' monster 51');assert.equal(requests.length,before+1);
      await page.locator('[data-card-zone="trap"]').click();await expect(page.locator('[data-card-empty]')).toBeVisible();
      await page.locator('[data-card-zone="side"]').click();await expect(page.locator('[data-card-table] tbody tr')).toHaveCount(50);assert.equal(requests.length,before+1);
      const downloadPromise=page.waitForEvent('download');await page.locator('[data-card-export]').click();const download=await downloadPromise;
      assert.match(download.suggestedFilename(),/100.*202610.*90.*100.*\.xlsx$/);
      const filename=resolve(output,'cards-'+lang+'.xlsx');await download.saveAs(filename);
      const wb=await new ExcelJS.Workbook().xlsx.load(readFileSync(filename));assert.equal(wb.worksheets.length,5);
      assert.equal(wb.worksheets[0].rowCount,204);assert.equal(wb.worksheets[4].rowCount,57);
      assert.equal(wb.worksheets[0].getCell('C5').value,'=danger, "name"');assert.equal(wb.worksheets[0].getCell('F5').value,2/9);
      await page.locator('[data-deck-card-usage] [data-export-format]').selectOption('csv');
      const csvPromise=page.waitForEvent('download');await page.locator('[data-card-export]').click();const csvDownload=await csvPromise;const csvFile=resolve(output,'cards-'+lang+'.csv');await csvDownload.saveAs(csvFile);
      const csv=readFileSync(csvFile,'utf8');assert.equal(csv.trim().split('\r\n').length,360);assert.ok(csv.includes('"\'=danger, ""name"""'));assert.ok(csv.includes('monster'));assert.ok(csv.includes(names[lang]));
      if(lang==='zh')await page.screenshot({path:resolve(output,'desktop-zh.png'),fullPage:true});
    }
    const refreshBefore=requests.length;
    await page.locator('#refresh').click();
    await expect.poll(()=>requests.length).toBe(refreshBefore+1);
    await expect(page.locator('[data-card-table] tbody tr')).toHaveCount(50);
    await expect(page.locator('[data-card-zone="side"]')).toHaveAttribute('aria-pressed','true');
    await page.locator('[data-card-expand]').click();const collapsedRefreshBefore=requests.length;
    const detailRefresh=page.waitForResponse(response=>response.url().includes('/api/ladder/deck-detail?'));
    await page.locator('#refresh').click();await detailRefresh;
    await expect(page.locator('[data-card-expand]')).toHaveAttribute('aria-expanded','false');assert.equal(requests.length,collapsedRefreshBefore);
    await page.locator('[data-card-expand]').click();await expect.poll(()=>requests.length).toBe(collapsedRefreshBefore+1);await expect(page.locator('[data-card-table] tbody tr')).toHaveCount(50);
    await page.locator('[data-card-expand]').click();const expiryBefore=requests.length;
    await page.evaluate(()=>{const clock=Date.now;Date.now=()=>clock()+31001;});
    assert.equal(requests.length,expiryBefore,'expired data must not query while collapsed');
    await page.locator('[data-card-expand]').click();await expect.poll(()=>requests.length).toBe(expiryBefore+1);await expect(page.locator('[data-card-table] tbody tr')).toHaveCount(50);
    const languageBefore=requests.length;
    await page.locator('.lbtn-main').click();await page.locator('.lang-menu .lbtn').nth(2).click();
    await expect(page.locator('[data-card-table] tbody tr').nth(1)).toContainText('en monster 2');
    assert.equal(requests.length,languageBefore+1);assert.equal(requests.at(-1).lang,'en');
    await page.locator('[data-card-expand]').click();const collapsedBefore=requests.length;
    await page.locator('[data-p="week"]').click();await expect(page.locator('[data-card-expand]')).toHaveAttribute('aria-expanded','false');assert.equal(requests.length,collapsedBefore);
    await page.locator('[data-card-expand]').click();await expect(page.locator('[data-card-context]')).toContainText('This week');
    await page.setViewportSize({width:360,height:780});await page.screenshot({path:resolve(output,'mobile.png'),fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.goto(base+'/deck-detail.html?deckTypeId=100&period=month&month=202610');
    failure=503;await page.locator('[data-card-expand]').click();await expect(page.locator('[data-card-retry]')).toBeVisible();
    failure=0;await page.locator('[data-card-retry]').click();await expect(page.locator('[data-card-table] tbody tr')).toHaveCount(50);
    const pending=new Map();await page.route('**/api/ladder/deck-detail?view=card-usage&**',route=>{pending.set(new URL(route.request().url()).searchParams.get('period'),route);});
    await page.locator('[data-p="week"]').click();await expect.poll(()=>pending.has('week')).toBe(true);
    await page.locator('[data-p="all"]').click();await expect.poll(()=>pending.has('all')).toBe(true);
    await pending.get('all').fulfill({json:cards(new URL(base+'/api/ladder/deck-detail?view=card-usage&deckTypeId=100&period=all&lang=zh'))});
    await expect(page.locator('[data-card-table] tbody tr')).toHaveCount(50);
    await pending.get('week').fulfill({json:cards(new URL(base+'/api/ladder/deck-detail?view=card-usage&deckTypeId=999&period=week&lang=en'))});
    await expect(page.locator('[data-card-context]')).toContainText('全部');
    await expect(page.locator('[data-card-table] tbody tr').nth(1)).toContainText('zh monster 2');
    await page.unroute('**/api/ladder/deck-detail?view=card-usage&**');
    for(const code of [400,404,429]){
      failure=code;await page.locator('[data-p="month"]').click();await expect(page.locator('[data-card-retry]')).toBeVisible();
      await expect(page.locator('#content > section').first()).toContainText(names.zh);
      failure=0;await page.locator('[data-card-retry]').click();await expect(page.locator('[data-card-table] tbody tr')).toHaveCount(50);
      await page.locator('[data-p="all"]').click();await expect(page.locator('[data-card-table] tbody tr')).toHaveCount(50);
    }
    await page.goto(base+'/deck-detail.html?deckTypeId=100&period=month&month=202610&L=zh');await page.locator('[data-card-expand]').click();await expect(page.locator('[data-card-table] tbody tr')).toHaveCount(50);
    let workbookRoute;await page.route('**/assets/stats-workbook.js?**',route=>{workbookRoute=route;});
    const snapshotDownload=page.waitForEvent('download');await page.locator('[data-card-export]').click();await expect.poll(()=>!!workbookRoute).toBe(true);
    await page.locator('[data-p="all"]').click();await expect(page.locator('[data-card-context]')).toContainText('全部');
    await workbookRoute.fulfill({body:readFileSync(resolve(root,'assets/stats-workbook.js')),contentType:'application/javascript'});
    const capturedDownload=await snapshotDownload;assert.match(capturedDownload.suggestedFilename(),/202610/);
    const capturedFile=resolve(output,'captured-scope.xlsx');await capturedDownload.saveAs(capturedFile);
    const capturedBook=await new ExcelJS.Workbook().xlsx.load(readFileSync(capturedFile));assert.equal(capturedBook.worksheets[0].getCell('B2').value,'month');
    await page.unroute('**/assets/stats-workbook.js?**');
    valid=0;await page.locator('[data-p="today"]').click();await expect(page.locator('[data-card-no-samples]')).toBeVisible();await expect(page.locator('[data-card-export]')).toBeDisabled();
    assert.deepEqual(errors,[]);console.log('PASS deck card UI: four languages and language switch, lazy load, zones, pagination, keyboard focus, full XLSX/CSV, captured export scope, 400/404/429/503 retry, stale responses, zero samples, mobile');
  }finally{await browser.close();server.close();}
}
