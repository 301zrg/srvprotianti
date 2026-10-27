import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';

const webRoot=resolve(import.meta.dirname,'../web'),workspace=resolve(webRoot,'../../../..');
const desktopRoot=resolve(workspace,'srvprotianti-desktop/web-source');
const stars='******',mixed='Player***<&',shortStars='***';
const ladder=[{rank:1,name:stars},{rank:2,name:mixed},{rank:69,name:shortStars},{rank:70,name:'Private70'},{rank:99,name:stars}];
const rooms=[
  {roomname:'Visible room',roomtype:'match_room',roommode:1,istart:'wait',users:[{name:stars},{name:mixed},{name:shortStars}]},
  {roomname:'Started TT',roomtype:'ladder_match',roommode:1,istart:'Duel:1 Turn:3',users:[{name:stars},{name:mixed}]},
  {roomname:'Waiting TT',roomtype:'ladder_match',roommode:1,istart:'wait',users:[{name:stars},{name:'NeverExposeThisName'}]},
  {roomname:'M#TT,RANDOM#123',roommode:1,istart:'wait',users:[{name:stars},{name:'NeverExposeLegacyName'}]},
  {roomname:'M#TT,RANDOM#456',roomtype:'match_room',roommode:1,istart:'wait',users:[{name:stars}]}
];
const replays=[
  {name:'2026-10-25 12-00-00 Fixture VS Other.yrp',players:[{id:stars+'$private'},{id:mixed}],winner:stars},
  {name:'2026-10-25 11-00-00 ****** VS ***.yrp',players:[],winner:shortStars},
  {name:'unidentified-history.yrp',players:[],winner:null}
];
async function serve(root,desktop){
  const server=createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')){
      const body=url.pathname==='/api/ladder'?{total:100,ladder,rankingBasis:'points'}:
        url.pathname==='/api/public/rooms'?{rooms}:url.pathname==='/api/public/replays'?{replays,total:replays.length}:{};
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(body));return;
    }
    const relative=desktop&&url.pathname.startsWith('/assets/')?url.pathname.slice('/assets'.length):url.pathname;
    const file=resolve(root,'.'+relative);
    if(!file.startsWith(root)||!existsSync(file)){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':extname(file)==='.js'?'application/javascript':extname(file)==='.css'?'text/css':'text/html; charset=utf-8'});res.end(readFileSync(file));
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));return server;
}
const require=createRequire(resolve(workspace,'srvprotiantiweb/package.json'));
const {chromium,expect}=require('@playwright/test');
const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser=await chromium.launch({headless:true,executablePath:existsSync(edge)?edge:undefined});
const servers=[],errors=[];let checks=0;
try{
  for(const [root,desktop] of [[webRoot,false],[desktopRoot,true]]){
    const server=await serve(root,desktop);servers.push(server);const base='http://127.0.0.1:'+server.address().port;
    const page=await browser.newPage();page.on('pageerror',error=>errors.push(String(error)));
    // Desktop source runs directly against fixture HTTP; no native app or game launch is involved.
    await page.addInitScript(()=>{window.SrvproDesktop={ladder(){},joinRoom(){},watchRoom(){},replay(){},saveReplay(){},saveDeck(){}};});
    async function linked(locator,name,lang,month){
      await expect(locator).toHaveCount(1);await expect(locator).toHaveText(name);
      const url=new URL(await locator.getAttribute('href'),base);assert.equal(url.pathname,'/player-stats.html');assert.equal(url.searchParams.get('player'),name);assert.equal(url.searchParams.get('L'),lang==='zh'?null:lang);
      if(month)assert.equal(url.searchParams.get('month'),month);assert.ok(!url.href.includes('private'));checks++;
    }
    for(const lang of ['zh','ja','en','ko']){
      await page.goto(base+'/ladder.html?type=month&month=202610&L='+lang);await expect(page.locator('#tbody tr')).toHaveCount(5);
      for(const [index,name] of [stars,mixed,shortStars,'Private70',stars].entries())await linked(page.locator('#tbody tr').nth(index).locator('td').nth(1).locator('a'),name,lang,'202610');
      await page.goto(base+'/ladder.html?type=total&month=202610&L='+lang);await expect(page.locator('#tbody tr')).toHaveCount(5);
      for(const [index,name] of [stars,mixed,shortStars].entries())await linked(page.locator('#tbody tr').nth(index).locator('td').nth(1).locator('a'),name,lang,'202610');
      for(const index of [3,4]){const cell=page.locator('#tbody tr').nth(index).locator('td').nth(1);await expect(cell).toHaveText(stars);await expect(cell.locator('a')).toHaveCount(0);checks++;}
      assert.ok(!(await page.locator('#tbody').innerHTML()).includes('Private70'),'hidden name must not survive in DOM');
      await page.goto(base+'/ladder.html?type=total&month=202610&search=******&L='+lang);await expect(page.locator('#tbody tr')).toHaveCount(5);
      await linked(page.locator('#tbody tr').nth(4).locator('td').nth(1).locator('a'),stars,lang,'202610');
      await page.goto(base+'/rooms.html?L='+lang);await expect(page.locator('#tbody tr')).toHaveCount(5);
      const playerCell=index=>page.locator('#tbody tr').nth(index).locator('td').nth(3);
      for(const [index,name] of [stars,mixed,shortStars].entries())await linked(playerCell(0).locator('a').nth(index),name,lang);
      await linked(playerCell(1).locator('a').first(),stars,lang);
      for(const index of [2,3]){await expect(playerCell(index).locator('a')).toHaveCount(0);assert.ok(!(await playerCell(index).textContent()).includes(stars));checks++;}
      assert.ok(!(await page.locator('#tbody').innerHTML()).includes('NeverExpose'),'waiting ladder identities must not survive in DOM');
      await linked(playerCell(4).locator('a'),stars,lang);
      await page.goto(base+'/replays.html?L='+lang);await expect(page.locator('#tbody tr')).toHaveCount(3);
      const replayCell=(row,col)=>page.locator('#tbody tr').nth(row).locator('td').nth(col);
      await linked(replayCell(0,1).locator('a').first(),stars,lang);await linked(replayCell(0,1).locator('a').nth(1),mixed,lang);await linked(replayCell(0,3).locator('a'),stars,lang);
      await linked(replayCell(1,1).locator('a').first(),stars,lang);await linked(replayCell(1,1).locator('a').nth(1),shortStars,lang);await linked(replayCell(1,3).locator('a'),shortStars,lang);
      await expect(replayCell(2,1).locator('a')).toHaveCount(0);await expect(replayCell(2,3).locator('a')).toHaveCount(0);
    }
    await page.close();
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({checks,errors,scope:'Website and desktop source, four languages; literal star nicknames link while ranking and waiting-room privacy remain hidden.'}));
}finally{await browser.close();await Promise.all(servers.map(server=>new Promise(done=>server.close(done))));}
