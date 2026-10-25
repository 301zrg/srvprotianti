import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';

const serverRoot=resolve(import.meta.dirname,'../../..');
const workspace=resolve(serverRoot,'..');
const webRoot=resolve(serverRoot,'plugins/ladder-web/web');
const desktopRoot=resolve(workspace,'srvprotianti-desktop/public');
const output=resolve(workspace,'.audit-tmp/ui-batch-20261019/visual');
mkdirSync(output,{recursive:true});
const names={zh:'测试卡组A',ja:'テストデッキA',en:'Test deck A',ko:'테스트 덱 A'};
const otherNames={zh:'测试卡组B',ja:'テストデッキB',en:'Test deck B',ko:'테스트 덱 B'};
const month='202610',requests=[],assetLoads=[];
let legacy=false;
function stat(){return {matches:4,matchWins:2,firstMatches:2,firstWins:1,secondMatches:2,secondWins:1,
  games:8,gameWins:4,firstGames:4,firstGameWins:2,secondGames:4,secondGameWins:2,
  mainGames:4,mainGameWins:2,mainFirstGames:2,mainFirstGameWins:1,mainSecondGames:2,mainSecondGameWins:1,
  sideGames:4,sideGameWins:2,sideFirstGames:2,sideFirstGameWins:1,sideSecondGames:2,sideSecondGameWins:1};}
function api(url,body){
  const p=url.pathname,q=Object.fromEntries(url.searchParams);
  requests.push({path:p,query:q,body});
  if(p==='/api/ladder-config')return {rankingBasis:'points',...(legacy?{}:{rating:{initialPoints:1000,useDynamic:true,totalWeight:.6,monthWeight:.4,kFactor:20,minDelta:8,maxDelta:15,fixedDelta:12,minimumPoints:0,eloScale:400}})};
  if(p==='/api/public/rooms')return {rooms:[{roomname:'Fixture Room',roomtype:'match_room',roommode:1,needpass:'false',istart:'wait',users:[{name:'Fixture'},{name:'对手 & 玩家'}]},{roomname:'M#TT,RANDOM#1',roomtype:'ladder_match',roommode:1,istart:'wait',users:[{name:'******'}]}]};
  if(p==='/api/ladder')return {type:q.type,month:q.month,rankingBasis:'points',total:1,ladder:[{rank:1,name:'Fixture',duelPoints:1234,wins:6,losses:4}]};
  if(p==='/api/example-decks')return {groups:[]};
  if(p==='/api/public/replays')return {replays:[
    {name:'2026-10-18 20-00-00 Fixture VS Other.yrp',size:1024,duelCount:1,winner:'Fixture',players:[{id:'Fixture'},{id:'对手 & 玩家$private'}]},
    {name:'2026-10-18 19-00-00 Legacy A & Legacy B VS Legacy C & Legacy D.yrp',size:1024,players:[]},
    {name:'unidentified-history.yrp',size:1024,players:[]}
  ],total:3};
  if(p==='/api/ladder-deck-stats')return {monthKey:q.month||month,decks:[{id:'a',name:names},{id:'b',name:otherNames}],stats:{'a::a':stat(),'a::b':stat(),'a::all':stat(),'b::a':stat(),'b::b':stat(),'b::all':stat()}};
  if(p==='/api/ladder/deck-detail'&&q.view!=='card-usage')return {period:q.period,month:q.period==='month'?q.month:null,selected:{id:100,names,templateFiles:[]},overall:stat(),opponents:[{deckTypeId:101,names:otherNames,values:stat()}],usage:{count:20,usageRate:.5},topPlayers:[{rank:1,name:'Fixture',accountName:'fixture',matches:30,wins:20,losses:10,winRate:2/3}],minPlayerMatches:25};
  if(p==='/api/ladder/deck-detail'&&q.view==='card-usage')return {available:true,selected:{id:100,names},period:q.period,month:q.period==='month'?q.month:null,
    startDay:'20261001',endDay:'20261101',coverage:{allDecks:12,validCardDecks:10},cardLimit:200,pageSize:50,
    cards:Object.fromEntries(['monster','spell','trap','extra','side'].map((zone,index)=>[zone,[{rank:1,cardId:14785765+index,name:'Card '+zone,deckCount:9,usageRate:.9,copies1:7,copies2:1,copies3:1}]]))};
  if(p.startsWith('/api/ladder/usage/')){
    const bounds={period:q.period,month:q.period==='month'?q.month:null,startDay:q.period==='all'?null:'20261001',endDay:q.period==='all'?null:'20261101',coverage:{allDecks:100,validCardDecks:90}};
    if(p.endsWith('/decks'))return {...bounds,decks:[{rank:1,deckTypeId:100,names,count:50,usageRate:.5}],total:1};
    const page=Number(q.page||1),start=(page-1)*50;
    return {...bounds,metric:q.metric,total:53,pageSize:50,cards:Array.from({length:Math.min(50,53-start)},(_,i)=>({rank:start+i+1,cardId:10000000+start+i,name:'Card '+(start+i+1),deckCount:20,usageRate:2/9,copies1:5,copies2:5,copies3:10}))};
  }
  if(p==='/api/ladder/player'){
    const summary={rank:1,points:1234,wins:6,losses:4,diff:2,winRate:.6,decks:[{deckTypeId:100,names,matches:10,wins:6,losses:4,winRate:.6}]};
    return {found:true,authenticated:body.password==='demo-pass',player:body.player||'Fixture',month:body.month||month,recentMatchLimit:10,summary:{month:summary,total:summary},chart:[{pointsBefore:1224,pointsAfter:1234}],page:1,pageSize:20,total:1,matches:[{matchId:1,opponent:'Opponent',won:true,score:'2-1',pointsDelta:10,pointsAfter:1234,opponentPointsDelta:-10,opponentPointsAfter:1000,rpsWon:true,g1First:true,deckTypeId:100,deckNames:names,opponentDeckTypeId:101,opponentDeckNames:otherNames,settledAt:'2026-10-18T12:00:00Z',...(legacy?{}:{replays:[{duelCount:1,filename:'fixture-g1.yrp',url:'/api/public/replay/fixture-g1.yrp'},{duelCount:3,filename:'fixture-g3.yrp',url:'/api/public/replay/fixture-g3.yrp'}]})}]};
  }
  if(p==='/api/ladder/player/stats'){
    if(legacy)return {status:404,error:'unavailable'};
    if(body.password!=='demo-pass')return {status:403,error:'authentication_required'};
    if(body.player==='OtherFixture'){
      const values=(count,wins)=>Object.fromEntries(Object.keys(stat()).map(key=>[key,/Wins$|^firstWins$|^secondWins$/.test(key)?wins:count]));
      const opponent={deckTypeId:101,names:otherNames,values:values(2,1)};
      const other={deckTypeId:4095,names:{zh:'其他',ja:'その他',en:'Other',ko:'기타'},values:values(1,0)};
      const overall=values(3,1);
      return {available:true,scope:body.scope,month:body.scope==='month'?body.month:null,overall,
        opponents:[opponent,other],decks:[{deckTypeId:100,names,overall:values(1,1),opponents:[{...opponent,values:values(1,1)}]},
          {deckTypeId:4095,names:other.names,overall:values(2,0),opponents:[{...opponent,values:values(1,0)},other]}]};
    }
    return {available:true,scope:body.scope,month:body.scope==='month'?body.month:null,overall:stat(),opponents:[{deckTypeId:101,names:otherNames,values:stat()}],decks:[{deckTypeId:100,names,overall:stat(),opponents:[{deckTypeId:101,names:otherNames,values:stat()}]}]};
  }
  return {status:404,error:'not found'};
}
function serve(desktop=false,port=0){
  const root=desktop?desktopRoot:webRoot;
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.includes('exceljs-4.4.0'))assetLoads.push(url.pathname);
    if(url.pathname.startsWith('/api/')){
      let raw='';for await(const part of req)raw+=part;
      let body={};try{body=JSON.parse(raw||'{}');}catch{}
      const data=api(url,body);res.writeHead(data.status||200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));return;
    }
    const target=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/rooms.html':url.pathname));
    if(!target.startsWith(root)||!existsSync(target)){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':extname(target)==='.js'?'application/javascript':extname(target)==='.css'?'text/css':'text/html; charset=utf-8'});res.end(readFileSync(target));
  });
  return new Promise(done=>server.listen(port,'127.0.0.1',()=>done(server)));
}
if(process.argv.includes('--serve')){
  legacy=process.argv.includes('--legacy');
  await serve(process.argv.includes('--desktop'),14820);
  console.log('Preview: http://127.0.0.1:14820/player-stats.html?player=Fixture&month='+month+'; password: demo-pass; legacy='+legacy);
}else{
  const require=createRequire(resolve(workspace,'srvprotiantiweb/package.json'));
  const {chromium,expect}=require('@playwright/test');
  const ExcelJS=createRequire(resolve(workspace,'srvprotianti-desktop/package.json'))('exceljs');
  const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser=await chromium.launch({headless:true,executablePath:existsSync(edge)?edge:undefined});
  const web=await serve(),desktop=await serve(true);
  const base='http://127.0.0.1:'+web.address().port,desktopBase='http://127.0.0.1:'+desktop.address().port;
  const errors=[];let checks=0;
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900},acceptDownloads:true});
    async function workbookDownload(selector,filename,count){
      const event=page.waitForEvent('download');await page.locator(selector).click();const download=await event;
      assert.ok(download.suggestedFilename().endsWith('.xlsx'));await download.saveAs(resolve(output,filename));
      const wb=await new ExcelJS.Workbook().xlsx.load(readFileSync(resolve(output,filename)));assert.equal(wb.worksheets.length,count);checks++;return wb;
    }
    async function privateDeckLinks(target,origin,isDesktop){
      for(const lang of ['zh','ja','en','ko']){
        await target.goto(origin+'/player-stats.html?player=OtherFixture&month='+month+'&L='+lang);
        await target.locator('#playerInput').fill('OtherFixture$demo-pass');await target.locator('#searchButton').click();
        await expect(target.locator('[data-private-expand]')).toBeVisible();await target.locator('[data-private-expand]').click();
        await expect(target.locator('[data-private-deck]')).toBeVisible();
        for(const scope of ['month','all']){
          if(scope==='all'){await target.locator('[data-private-scope="all"]').click();await expect(target.locator('[data-private-deck]')).toBeVisible();}
          const root=target.locator('#privateDuelStats');
          const link=root.locator('tbody a').first();
          await expect(link).toHaveCount(1);
          const href=new URL(await link.getAttribute('href'),origin);
          assert.equal(href.pathname,'/deck-detail.html');assert.equal(href.searchParams.get('deckTypeId'),'101');
          assert.equal(href.searchParams.get('period'),scope);assert.equal(href.searchParams.get('month'),month);
          assert.equal(href.searchParams.get('L'),lang==='zh'?null:lang);assert.ok(!href.href.includes('demo-pass'));
          await expect(root.locator('a[href*="deckTypeId=4095"]')).toHaveCount(0);
          await expect(root.locator('tbody tr').first().locator('td').first()).toContainText('33.33%');
          await target.locator('[data-private-deck]').selectOption('4095');
          await expect(root.locator('tbody tr').first().locator('td').first()).toContainText('0.00%');
          await expect(root.locator('tbody tr')).toHaveCount(3);
          await expect(root.locator('a[href*="deckTypeId=4095"]')).toHaveCount(0);
          await target.locator('[data-private-deck]').selectOption('100');
          const own=root.locator('[data-private-own-deck] a');await expect(own).toHaveCount(1);
          const ownUrl=new URL(await own.getAttribute('href'),origin);assert.equal(ownUrl.searchParams.get('deckTypeId'),'100');assert.equal(ownUrl.searchParams.get('period'),scope);
          await target.locator('[data-private-deck]').selectOption('');
          checks++;
        }
        if(lang==='zh')await target.screenshot({path:resolve(output,(isDesktop?'desktop-':'')+'private-deck-links.png'),fullPage:true});
        await target.locator('#privateDuelStats tbody a').first().click();
        await target.waitForURL('**/deck-detail.html?**');
        assert.equal(new URL(target.url()).searchParams.get('period'),'all');
      }
    }
    page.on('pageerror',error=>errors.push(String(error)));
    await page.goto(base+'/rooms.html');
    await expect(page.locator('tbody a[href*="player-stats"]')).toHaveCount(2);checks++;
    await page.locator('tbody a[href*="player-stats"]').first().click();
    await expect(page.locator('#privateDuelStats')).toHaveCount(0);checks++;
    await expect(page.locator('.stats-section h3').first()).toHaveText('所选月战绩');
    await page.locator('.summary-title a').click();
    await expect(page.locator('#searchInput')).toHaveValue('Fixture');checks++;
    for(const lang of ['zh','ja','en','ko']){
      await page.goto(base+'/replays.html?L='+lang);
      await expect(page.locator('#tbody tr')).toHaveCount(3);
      const first=page.locator('#tbody tr').nth(0);
      await expect(first.locator('td').nth(1).locator('a')).toHaveCount(2);
      await expect(first.locator('td').nth(1)).toHaveText('Fixture VS 对手 & 玩家');
      await expect(first.locator('td').nth(3).locator('a')).toHaveText('Fixture');
      const opponent=new URL(await first.locator('td').nth(1).locator('a').nth(1).getAttribute('href'),base);
      assert.equal(opponent.searchParams.get('player'),'对手 & 玩家');assert.equal(opponent.searchParams.get('L'),lang==='zh'?null:lang);
      await expect(page.locator('#tbody tr').nth(1).locator('td').nth(1)).toHaveText('Legacy A & Legacy B VS Legacy C & Legacy D');
      await expect(page.locator('#tbody tr').nth(1).locator('td').nth(1).locator('a')).toHaveCount(4);
      await expect(page.locator('#tbody tr').nth(2).locator('a[href*="player-stats"]')).toHaveCount(0);
      if(lang==='zh')await page.screenshot({path:resolve(output,'replays-player-links.png'),fullPage:true});
      await first.locator('td').nth(3).locator('a').click();await expect(page.locator('#playerInput')).toHaveValue('Fixture');checks++;
    }
    await page.goto(base+'/ladder.html');await expect(page.locator('#tabMonth')).toHaveClass('active');
    assert.equal(await page.locator('.btn-group button').first().getAttribute('id'),'tabMonth');
    await expect(page.locator('[data-rating-rules]')).toContainText('60%');checks++;
    await page.goto(base+'/deck-stats.html?month='+month);
    await expect(page.locator('#tbody tr')).toHaveCount(2);
    assert.equal(assetLoads.length,0,'XLSX library must not preload');
    await expect(page.locator('[data-export-format]')).toHaveValue('xlsx');
    const matrixCalls=requests.length;await workbookDownload('[data-csv-export]','deck-stats.xlsx',12);assert.equal(requests.length,matrixCalls);
    await page.locator('[data-export-format]').selectOption('csv');
    const downloadWait=page.waitForEvent('download');await page.locator('[data-csv-export]').click();const download=await downloadWait;
    await download.saveAs(resolve(output,'deck-stats.csv'));const csv=readFileSync(resolve(output,'deck-stats.csv'),'utf8');
    assert.equal(csv.charCodeAt(0),0xfeff);assert.equal(csv.trim().split('\r\n').length,73);assert.ok(csv.includes('备牌局后攻'));checks++;
    await page.goto(base+'/usage-stats.html?period=all');await expect(page.locator('#body tr')).toHaveCount(50);
    const usageCalls=requests.length;await workbookDownload('[data-csv-export]','usage.xlsx',6);assert.equal(requests.length-usageCalls,11);
    await page.locator('[data-export-format]').selectOption('csv');
    const usageDownload=page.waitForEvent('download');await page.locator('[data-csv-export]').click();await(await usageDownload).saveAs(resolve(output,'usage.csv'));
    assert.equal(readFileSync(resolve(output,'usage.csv'),'utf8').trim().split('\r\n').length,267);checks++;
    await page.goto(base+'/deck-detail.html?deckTypeId=100&period=all');await expect(page.locator('#content h2').first()).toHaveText(names.zh);
    const detailBook=await workbookDownload('[data-csv-export]','deck-detail.xlsx',4);assert.ok(!JSON.stringify(detailBook.model).includes('Fixture'));
    await page.locator('[data-export-format]').selectOption('csv');
    const detailDownload=page.waitForEvent('download');await page.locator('[data-csv-export]').click();await(await detailDownload).saveAs(resolve(output,'deck-detail.csv'));
    const detailCsv=readFileSync(resolve(output,'deck-detail.csv'),'utf8');assert.equal(detailCsv.trim().split('\r\n').length,25);assert.ok(!detailCsv.includes('Fixture'));checks++;
    const pendingDetails=new Map();let staleDownloads=0;
    const countStaleDownload=()=>{staleDownloads++;};page.on('download',countStaleDownload);
    await page.route('**/api/ladder/deck-detail?**',async route=>{pendingDetails.set(new URL(route.request().url()).searchParams.get('q'),route);});
    await page.locator('#query').fill('Old search');await page.locator('#search').click();
    await expect.poll(()=>pendingDetails.has('Old search')).toBe(true);
    for(const format of ['xlsx','csv']){
      await page.locator('[data-export-format]').selectOption(format);await page.locator('[data-csv-export]').click();
      await expect(page.locator('.csv-status')).toHaveText('暂无可导出的数据。');assert.equal(staleDownloads,0);checks++;
    }
    await page.locator('#query').fill('Current search');await page.locator('#search').click();
    await expect.poll(()=>pendingDetails.has('Current search')).toBe(true);
    async function finishDetail(query,id,label){const route=pendingDetails.get(query),data=api(new URL(route.request().url()),{});data.selected={id,names:{zh:label},templateFiles:[]};await route.fulfill({json:data});}
    await finishDetail('Current search',102,'Current deck');await expect(page.locator('#content h2').first()).toHaveText('Current deck');
    await finishDetail('Old search',101,'Old deck');await page.waitForTimeout(80);
    await expect(page.locator('#content h2').first()).toHaveText('Current deck');checks++;
    page.off('download',countStaleDownload);await page.unroute('**/api/ladder/deck-detail?**');
    await page.goto(base+'/player-stats.html?player=Fixture&month='+month);
    await page.locator('#playerInput').fill('Fixture$demo-pass');await page.locator('#searchButton').click();
    await expect(page.locator('#privateDuelStats')).toBeVisible();
    await expect(page.locator('[data-profile-replay]')).toHaveCount(2);
    assert.ok(!page.url().includes('demo-pass'));
    const before=requests.filter(r=>r.path.endsWith('/stats')).length;
    await page.locator('[data-private-expand]').click();await expect(page.locator('[data-private-csv]')).toBeVisible();
    assert.equal(requests.filter(r=>r.path.endsWith('/stats')).length,before+1);checks++;
    await page.locator('[data-private-scope="all"]').click();await expect(page.locator('[data-private-csv]')).toBeVisible();
    assert.equal(requests.filter(r=>r.path.endsWith('/stats')).at(-1).body.scope,'all');
    const privateCalls=requests.length;const playerBook=await workbookDownload('[data-private-csv]','player-stats.xlsx',4);assert.equal(requests.length,privateCalls);assert.ok(!JSON.stringify(playerBook.model).includes('demo-pass'));
    await page.locator('[data-export-format]').selectOption('csv');
    const playerDownload=page.waitForEvent('download');await page.locator('[data-private-csv]').click();await(await playerDownload).saveAs(resolve(output,'player-stats.csv'));
    assert.equal(readFileSync(resolve(output,'player-stats.csv'),'utf8').trim().split('\r\n').length,49);checks++;
    await page.locator('#monthSelect').selectOption('202609');await expect(page.locator('[data-private-expand]')).toBeVisible();await page.locator('[data-private-expand]').click();
    await expect(page.locator('[data-private-csv]')).toBeVisible();assert.equal(requests.filter(r=>r.path.endsWith('/stats')).at(-1).body.month,'202609');checks++;
    await page.screenshot({path:resolve(output,'player-private-zh.png'),fullPage:true});
    await privateDeckLinks(page,base,false);
    for(const lang of ['zh','ja','en','ko']){
      for(const name of ['intro','rooms','ladder','deck-stats','player-stats','usage-stats','deck-detail','replays']){
        await page.goto(base+'/'+name+'.html?L='+lang+'&month='+month+'&player=Fixture&deckTypeId=100');
        await page.waitForTimeout(60);checks++;
      }
      await page.goto(base+'/intro.html?L='+lang);
      await expect(page.locator('[data-intro-web-play]')).toHaveCount(1);
      const href=await page.locator('[data-intro-web-play]').getAttribute('href');assert.ok(new URL(href).searchParams.get('lang')===lang);
      const gaps=await page.locator('.web-client-instructions').evaluateAll(nodes=>nodes.map(node=>{
        const range=document.createRange();range.setStart(node.parentNode,0);range.setEndBefore(node);
        const last=Array.from(range.getClientRects()).at(-1);return node.getBoundingClientRect().top-last.bottom;
      }));assert.equal(gaps.length,2);assert.ok(gaps.every(gap=>gap>=12));checks++;
      await page.screenshot({path:resolve(output,'intro-'+lang+'.png'),fullPage:true});
    }
    await page.setViewportSize({width:390,height:844});
    await page.goto(base+'/deck-stats.html?month='+month);await expect(page.locator('[data-csv-export]')).toBeVisible();
    await page.screenshot({path:resolve(output,'deck-stats-mobile.png'),fullPage:true});checks++;
    await page.goto(base+'/player-stats.html?player=Fixture&month='+month);await page.locator('#playerInput').fill('Fixture$demo-pass');await page.locator('#searchButton').click();await page.locator('[data-private-expand]').click();await expect(page.locator('[data-private-csv]')).toBeVisible();await page.screenshot({path:resolve(output,'player-private-mobile.png'),fullPage:true});
    legacy=true;
    await page.goto(base+'/ladder.html');await expect(page.locator('[data-rating-rules]')).toBeHidden();
    await page.goto(base+'/player-stats.html?player=Fixture&month='+month);await expect(page.locator('.feature-placeholder')).toContainText('暂不可用');
    await page.locator('#playerInput').fill('Fixture$demo-pass');await page.locator('#searchButton').click();await page.locator('[data-private-expand]').click();
    await expect(page.locator('#privateDuelStats')).toContainText('详细统计暂不可用');await expect(page.locator('[data-private-csv]')).toHaveCount(0);checks++;
    await page.screenshot({path:resolve(output,'player-legacy-placeholder.png'),fullPage:true});
    legacy=false;
    const desktopPage=await browser.newPage({viewport:{width:1280,height:900}});desktopPage.on('pageerror',e=>errors.push(String(e)));
    await desktopPage.addInitScript(()=>{
      const nativeFetch=window.fetch.bind(window);let callback=1;window.__savedCsv=null;window.__savedXlsx=null;
      window.__TAURI_INTERNALS__={transformCallback:()=>callback++,unregisterCallback:()=>{},invoke:async(command,args)=>{
        if(command==='get_settings')return {schemaVersion:1,player:{launchName:'Fixture$demo-pass'},server:{gameHost:'127.0.0.1',gamePort:7911,apiBaseUrl:location.origin},game:{executable:'ygopro.exe'},ui:{language:'zh'}};
        if(command==='api_request'){const response=await nativeFetch(args.route,{method:args.method,headers:{'Content-Type':'application/json'},...(args.method==='POST'?{body:args.body}:{})});const data=new Uint8Array(await response.arrayBuffer());return {status:response.status,contentType:response.headers.get('content-type'),bodyBase64:btoa(Array.from(data,x=>String.fromCharCode(x)).join(''))};}
        if(command==='save_csv'){window.__savedCsv=args;return 'C:\\review\\stats.csv';}
        if(command==='save_xlsx'){window.__savedXlsx=args;return 'C:\\review\\stats.xlsx';}
        return 1;
      }};
    });
    await desktopPage.goto(desktopBase+'/ladder.html?self=1');await expect(desktopPage.locator('#searchInput')).toHaveValue('Fixture');assert.ok(!desktopPage.url().includes('demo-pass'));checks++;
    await desktopPage.goto(desktopBase+'/player-stats.html?self=1&month='+month);await expect(desktopPage.locator('#privateDuelStats')).toBeVisible();await expect(desktopPage.locator('[data-profile-replay]')).toHaveCount(0);await desktopPage.locator('[data-private-expand]').click();await expect(desktopPage.locator('[data-private-csv]')).toBeVisible();await desktopPage.locator('[data-private-csv]').click();await desktopPage.waitForFunction(()=>window.__savedXlsx!==null);
    const saved=await desktopPage.evaluate(()=>window.__savedXlsx);assert.ok(saved.filename.endsWith('.xlsx'));
    const nativeBook=await new ExcelJS.Workbook().xlsx.load(Buffer.from(saved.bytesBase64,'base64'));assert.equal(nativeBook.worksheets.length,4);checks++;
    await desktopPage.locator('[data-export-format]').selectOption('csv');await desktopPage.locator('[data-private-csv]').click();await desktopPage.waitForFunction(()=>window.__savedCsv!==null);checks++;
    await desktopPage.screenshot({path:resolve(output,'desktop-player-private.png'),fullPage:true});
    await privateDeckLinks(desktopPage,desktopBase,true);
    const cardQueries=requests.filter(item=>item.path==='/api/ladder/deck-detail'&&item.query.view==='card-usage').length;
    await desktopPage.goto(desktopBase+'/deck-detail.html?deckTypeId=100&period=month&month='+month+'&L=ja');
    await expect(desktopPage.locator('[data-card-expand]')).toBeVisible();
    assert.equal(requests.filter(item=>item.path==='/api/ladder/deck-detail'&&item.query.view==='card-usage').length,cardQueries);checks++;
    await desktopPage.locator('[data-card-expand]').click();await expect(desktopPage.locator('[data-card-table] tbody tr')).toHaveCount(1);
    assert.equal(requests.filter(item=>item.path==='/api/ladder/deck-detail'&&item.query.view==='card-usage').length,cardQueries+1);checks++;
    await desktopPage.evaluate(()=>{window.__savedXlsx=null;window.__savedCsv=null;});
    await desktopPage.locator('[data-card-export]').click();await desktopPage.waitForFunction(()=>window.__savedXlsx!==null);
    const cardSaved=await desktopPage.evaluate(()=>window.__savedXlsx);
    const cardBook=await new ExcelJS.Workbook().xlsx.load(Buffer.from(cardSaved.bytesBase64,'base64'));
    assert.equal(cardBook.worksheets.length,5);assert.equal(cardBook.worksheets[0].getCell('F5').value,.9);
    assert.equal(cardBook.worksheets[0].getCell('F2').value,10);assert.equal(cardBook.worksheets[0].getCell('H2').value,12);checks++;
    await desktopPage.locator('[data-deck-card-usage] [data-export-format]').selectOption('csv');
    await desktopPage.locator('[data-card-export]').click();await desktopPage.waitForFunction(()=>window.__savedCsv!==null);
    const cardCsv=await desktopPage.evaluate(()=>window.__savedCsv);
    assert.match(cardCsv.filename,/deck-card-100-202610-10-of-12\.csv$/);assert.ok(cardCsv.contents.includes('monster'));assert.ok(cardCsv.contents.includes('side'));checks++;
    await desktopPage.screenshot({path:resolve(output,'desktop-card-usage-native.png'),fullPage:true});
    await desktopPage.goto(desktopBase+'/settings.html');await expect(desktopPage.locator('[data-self-query="ranking"]')).toBeVisible();await expect(desktopPage.locator('[data-self-query="stats"]')).toBeVisible();
    assert.equal(await desktopPage.evaluate(()=>{const show=document.getElementById('showName'),ranking=show.nextElementSibling,stats=ranking.nextElementSibling;return ranking.dataset.selfQuery==='ranking'&&stats.dataset.selfQuery==='stats'&&stats.nextElementSibling.nextElementSibling.contains(document.getElementById('gameHost'));}),true);
    await desktopPage.screenshot({path:resolve(output,'desktop-settings.png'),fullPage:true});checks++;
    await desktopPage.goto(desktopBase+'/replays.html?L=ja');await expect(desktopPage.locator('#tbody tr')).toHaveCount(3);
    const desktopReplay=desktopPage.locator('#tbody tr').first();
    await expect(desktopReplay.locator('td').nth(1).locator('a')).toHaveCount(2);
    await expect(desktopReplay.locator('td').nth(3).locator('a')).toHaveText('Fixture');
    await desktopPage.screenshot({path:resolve(output,'desktop-replays-player-links.png'),fullPage:true});
    await desktopReplay.locator('td').nth(1).locator('a').nth(1).click();await expect(desktopPage.locator('#playerInput')).toHaveValue('对手 & 玩家');assert.ok(!desktopPage.url().includes('private'));checks++;
    assert.deepEqual(errors,[]);
    const report={checks,errors,screenshots:output,scope:'Synthetic API and native-bridge fixtures; no production or real game access.'};
    writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }catch(error){console.error(JSON.stringify({errors,requests:requests.map(r=>r.path)}));throw error;}
  finally{await browser.close();await new Promise(r=>web.close(r));await new Promise(r=>desktop.close(r));}
}
