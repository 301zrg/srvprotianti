'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const helper=fs.existsSync(path.join(__dirname,'announce-release.cjs'))?require('./announce-release.cjs'):{};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  assert.equal(typeof helper.runAnnouncement,'function');
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'release-announcement-')),batch=path.join(base,'sample');fs.mkdirSync(batch);
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const manifest={schemaVersion:2,id:'sample',enabled:true,title:'reviewed update',server:{projectRoot:base,appName:'game',pm2Home:path.join(base,'pm2'),pm2Script:path.join(base,'pm2.cjs'),httpPort:7922,gamePort:7911,minimumFreeMiB:256},health:{ladderConfig:true,privateStatsGuard:true,expectedHooks:['random_duel_zombie_penalty'],mode:'TT',countAfkPenalty:false},files:[{path:'plugins/ladder-web/web/app.js',source:'payload/app.js',phase:'website',sha256:'a'.repeat(64),beforeSha256:null}],desktop:null,releaseNotes:{zh:'已更新',ja:'更新済み',en:'Updated',ko:'업데이트 완료'}};
  const state={jobId:'sample',stage:'FINISHED',outcome:'UPDATED',websitePublished:true};
  const events=[];
  const options={appsProvider:()=>{events.push('apps');return [];},createDelivery:()=>{events.push('create');return {preflight:async()=>{events.push('preflight');return {status:'READY',guildId:'1504410444876484658',channelId:'1554786350845141002'};},notify:async phase=>{events.push(phase);return '1564156977234575450';},close:async()=>events.push('close')};}};
  function save(){const bytes=JSON.stringify(manifest);fs.writeFileSync(path.join(batch,'manifest.json'),bytes);fs.writeFileSync(path.join(batch,'state.json'),JSON.stringify(state));return {batch,manifestHash:hash(bytes)};}
  return {base,batch,manifest,state,events,options,save};
}
test('remote release announcement requires pinned manifest and a successful finished publication',async t=>{
  const f=fixture(t),result=await helper.runAnnouncement(f.save(),f.options);
  assert.equal(result.status,'CONFIRMED');assert.equal(result.messageId,'1564156977234575450');
  assert.deepEqual(f.events,['create','apps','preflight','release','close']);
  assert.equal(fs.existsSync(path.join(f.batch,'release-announcement.lock')),false);
});
test('unfinished, rolled-back, wrong-job and unpublished-website states block before bot access',async t=>{
  for(const changed of [{stage:'VERIFYING'},{outcome:'ROLLED_BACK'},{outcome:'CANCELLED'},{jobId:'other'},{websitePublished:false}]){
    const f=fixture(t);Object.assign(f.state,changed);await assert.rejects(helper.runAnnouncement(f.save(),f.options),/announcement_updates_unverified/);assert.deepEqual(f.events,[]);
  }
});
test('changed manifest bytes and missing successful state cannot authorize a message',async t=>{
  const f=fixture(t),request=f.save();fs.appendFileSync(path.join(f.batch,'manifest.json'),' ');
  await assert.rejects(helper.runAnnouncement(request,f.options),/announcement_manifest_changed/);assert.deepEqual(f.events,[]);
  const next=f.save();fs.unlinkSync(path.join(f.batch,'state.json'));
  await assert.rejects(helper.runAnnouncement(next,f.options));assert.deepEqual(f.events,[]);
});
test('explicit announcement preflight checks permissions without requiring successful state or sending',async t=>{
  const f=fixture(t),request=f.save();fs.unlinkSync(path.join(f.batch,'state.json'));
  assert.equal((await helper.runAnnouncement({...request,preflight:true},f.options)).status,'READY');
  assert.deepEqual(f.events,['create','apps','preflight','close']);assert.equal(fs.existsSync(path.join(f.batch,'release-announcement.lock')),false);
});
test('existing announcement lock blocks sends and omitted notes do not load the bot',async t=>{
  const f=fixture(t),request=f.save();fs.writeFileSync(path.join(f.batch,'release-announcement.lock'),'existing owner');
  await assert.rejects(helper.runAnnouncement(request,f.options),/global_lock_exists/);assert.deepEqual(f.events,[]);
  fs.unlinkSync(path.join(f.batch,'release-announcement.lock'));delete f.manifest.releaseNotes;
  assert.equal((await helper.runAnnouncement(f.save(),f.options)).status,'DISABLED');assert.deepEqual(f.events,[]);
});
