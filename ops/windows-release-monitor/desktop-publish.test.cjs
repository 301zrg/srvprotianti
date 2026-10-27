'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {preflightDesktop,publishDesktop,validate,localCredential}=require('./desktop-publish.cjs');
const commit='a'.repeat(40),bytes=Buffer.from('synthetic windows zip'),hash=crypto.createHash('sha256').update(bytes).digest('hex');
const job={repository:'example/desktop',tag:'v0.1.4',targetCommit:commit,workflow:'windows-desktop.yml',asset:{name:'desktop-windows-x64.zip'}};
function fixture(change={}){
  const calls=[];
  let tag=change.tagExists!==false,release=change.published!==false,created=false;
  const fetchImpl=async(url,init={})=>{
    const u=new URL(url),p=u.pathname.replace('/repos/'+(change.repository||job.repository),'');calls.push({path:p,method:init.method||'GET',body:init.body});
    let value,status=200;
    if(p==='/git/refs'){
      tag=true;created=true;value={ref:'refs/tags/v0.1.4',object:{type:'commit',sha:commit}};
      if(change.uncertainPost)throw Error('connection reset');
    }else if(p==='/git/ref/tags/v0.1.4'){
      if(created&&change.disappearingTag)tag=false;
      value=tag?{object:{type:'commit',sha:change.wrongTag?'b'.repeat(40):commit}}:{};if(!tag)status=404;
    }
    else if(p===`/commits/${commit}`)value={sha:commit};
    else if(p==='/actions/workflows/windows-desktop.yml')value={state:'active'};
    else if(p==='/actions/workflows/windows-desktop.yml/runs'){
      const failure=!!change.ciFailure;
      value={workflow_runs:[{id:55,head_sha:commit,head_branch:'v0.1.4',event:'push',status:'completed',conclusion:failure?'failure':'success',html_url:'https://github.com/example/desktop/actions/runs/55'}]};
      if(created&&!failure)release=true;
    }else if(p==='/releases/tags/v0.1.4'){
      if(!release){status=404;value={};}else value={id:7,tag_name:'v0.1.4',draft:false,prerelease:false,html_url:'https://github.com/example/desktop/releases/tag/v0.1.4',assets:[{id:9,name:job.asset.name,state:'uploaded',size:bytes.length,digest:'sha256:'+hash}]};
    }else if(p==='/releases/assets/9')return new Response(change.badAsset?Buffer.from('corrupt'):bytes);
    else if(p.startsWith('/contents/')){
      const file=p.slice('/contents/'.length);
      const version=change.wrongVersion?'0.1.3':'0.1.4';
      const contents=file==='src-tauri/Cargo.toml'?`[package]\nversion = "${version}"\n`:JSON.stringify({version});
      value={type:'file',encoding:'base64',content:Buffer.from(contents).toString('base64')};
    }else throw Error('Unexpected request '+p);
    return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
  };
  return {calls,options:{fetchImpl,credentialProvider:async()=>change.noCredential?null:'synthetic-token',sleep:async()=>{},maxPolls:3}};
}
test('no desktop task needs no credential or network',async()=>{
  const options={credentialProvider:()=>{throw Error('must skip');},fetchImpl:()=>{throw Error('must skip');}};
  assert.equal((await preflightDesktop(null,options)).skipped,true);
  assert.equal((await publishDesktop(null,options)).skipped,true);
});

test('transient read failures retry finitely without exposing private error messages',async()=>{
  const f=fixture(),request=f.options.fetchImpl,delays=[],logs=[];let attempts=0;
  f.options.sleep=async ms=>delays.push(ms);f.options.log=value=>logs.push(value);
  f.options.fetchImpl=async(url,init)=>{
    if(url.endsWith('/commits/'+commit)&&++attempts<3)throw Object.assign(Error('private-token-message'),{cause:{code:'ECONNRESET'}});
    return request(url,init);
  };
  assert.equal((await preflightDesktop(job,f.options)).status,'ALREADY_PUBLISHED');
  assert.equal(attempts,3);assert.deepEqual(delays,[1000,2000]);
  assert.ok(logs.every(value=>!value.includes('private-token-message')));assert.ok(logs.some(value=>value.includes('ECONNRESET')));
  assert.ok(f.calls.every(call=>call.method==='GET'));
});

test('persistent read failure stops after three attempts with a safe reason code',async()=>{
  const f=fixture();let calls=0;
  f.options.fetchImpl=async()=>{calls++;throw Object.assign(Error('private-token-message'),{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});};
  await assert.rejects(preflightDesktop(job,f.options),error=>error.code==='DESKTOP_REQUEST_FAILED'&&error.message.includes('UND_ERR_CONNECT_TIMEOUT')&&!error.message.includes('private-token-message'));
  assert.equal(calls,3);
});

test('temporary HTTP server failures retry reads while authentication failures do not',async()=>{
  const f=fixture(),request=f.options.fetchImpl;let attempts=0;
  f.options.fetchImpl=async(url,init)=>url.endsWith('/commits/'+commit)&&++attempts===1?new Response('',{status:503}):request(url,init);
  assert.equal((await preflightDesktop(job,f.options)).status,'ALREADY_PUBLISHED');assert.equal(attempts,2);
  let calls=0;const denied=fixture();denied.options.fetchImpl=async()=>{calls++;return new Response('',{status:403});};
  await assert.rejects(preflightDesktop(job,denied.options),{code:'DESKTOP_AUTH_REQUIRED'});assert.equal(calls,1);
});
test('preflight never creates a tag and requires auth for a new one',async()=>{
  const f=fixture({tagExists:false,published:false});
  assert.equal((await preflightDesktop(job,f.options)).status,'READY_TO_TAG');
  assert.ok(f.calls.every(x=>x.method==='GET'));
  const missing=fixture({tagExists:false,published:false,noCredential:true});
  await assert.rejects(preflightDesktop(job,missing.options),{code:'DESKTOP_AUTH_REQUIRED'});
});
test('new tag triggers existing CI and downloaded release is hashed',async()=>{
  const f=fixture({tagExists:false,published:false});
  const result=await publishDesktop(job,f.options);
  assert.equal(result.assetSHA256,hash);assert.equal(result.targetCommit,commit);
  const posts=f.calls.filter(x=>x.method==='POST');assert.equal(posts.length,1);
  assert.deepEqual(JSON.parse(posts[0].body),{ref:'refs/tags/v0.1.4',sha:commit});
  assert.ok(f.calls.every(x=>x.method!=='PATCH'&&!x.path.endsWith('/releases')));
});
test('existing published matching version is idempotent and may be public-read-only',async()=>{
  const f=fixture({noCredential:true});
  assert.equal((await publishDesktop(job,f.options)).assetSHA256,hash);
  assert.ok(f.calls.every(x=>x.method==='GET'));
});
test('same tag pointing elsewhere stops without tag mutation',async()=>{
  const f=fixture({wrongTag:true});
  await assert.rejects(publishDesktop(job,f.options),{code:'DESKTOP_TAG_CONFLICT'});
  assert.ok(f.calls.every(x=>x.method==='GET'));
});
test('uncertain tag POST reconciles ref instead of repeating publication',async()=>{
  const f=fixture({tagExists:false,published:false,uncertainPost:true});
  assert.equal((await publishDesktop(job,f.options)).assetSHA256,hash);
  assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
});
test('CI failure blocks publication completion',async()=>{
  const f=fixture({tagExists:false,published:false,ciFailure:true});
  await assert.rejects(publishDesktop(job,f.options),{code:'DESKTOP_CI_FAILED'});
});
test('version mismatch and corrupted asset cannot be reported successful',async()=>{
  await assert.rejects(publishDesktop(job,fixture({wrongVersion:true}).options),{code:'DESKTOP_VERSION_MISMATCH'});
  await assert.rejects(publishDesktop(job,fixture({badAsset:true}).options),{code:'DESKTOP_ASSET_MISMATCH'});
});
test('malformed job fails before credentials or external requests',async()=>{
  const f=fixture();
  await assert.rejects(publishDesktop({...job,tag:'v1;calc.exe'},f.options),{code:'DESKTOP_MANIFEST_INVALID'});
  assert.equal(f.calls.length,0);
});
test('a disappearing tag after creation cannot authorize a completed release',async()=>{
  const f=fixture({tagExists:false,published:false,disappearingTag:true});
  await assert.rejects(publishDesktop(job,f.options),{code:'DESKTOP_TAG_CREATION_UNCERTAIN'});
  assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
});
test('cancelling during preflight prevents the later tag mutation',async()=>{
  const f=fixture({tagExists:false,published:false}),abort=new AbortController();
  f.options.signal=abort.signal;
  f.options.credentialProvider=async()=>{abort.abort();return 'synthetic-token';};
  await assert.rejects(publishDesktop(job,f.options),{code:'DESKTOP_INTERRUPTED'});
  assert.equal(f.calls.filter(x=>x.method==='POST').length,0);
});

test('optional pages manifest rejects unknown fields and unsafe artifact paths before credentials',async()=>{
  const pages={publisherRoot:'F:/reviewed/desktop',websiteRoot:'F:/reviewed/server/plugins/ladder-web/web',
    manifest:{source:'pages/stable.json',sha256:'a'.repeat(64)},
    archive:{source:'pages/srvprotianti-desktop-pages.zip',sha256:'b'.repeat(64)},
    publicKey:{source:'pages/public-key.json',sha256:'c'.repeat(64)}};
  assert.equal(validate({...job,repository:'301zrg/srvprotianti-desktop',pages}).pages,pages);
  for(const bad of [null,{}, {...pages,command:'publish'}, {...pages,publisherRoot:'../desktop'},
    {...pages,websiteRoot:'https://example.test'}, {...pages,manifest:{...pages.manifest,source:'../stable.json'}},
    {...pages,archive:{...pages.archive,source:'pages/archive.zip:stream'}},
    {...pages,publicKey:{...pages.publicKey,sha256:'bad'}},
    {...pages,manifest:{...pages.manifest,extra:true}}]){
    const f=fixture();let credentials=0;f.options.credentialProvider=()=>{credentials++;return 'secret';};
    await assert.rejects(preflightDesktop({...job,pages:bad},f.options),{code:'DESKTOP_MANIFEST_INVALID'});
    assert.equal(credentials,0);assert.equal(f.calls.length,0);
  }
});

test('an existing EXE still publishes optional pages only after its download is verified',async()=>{
  const f=fixture({repository:'301zrg/srvprotianti-desktop'}),events=[];
  const pages={publisherRoot:'F:/reviewed/desktop',websiteRoot:'F:/reviewed/server/plugins/ladder-web/web',
    manifest:{source:'pages/stable.json',sha256:'a'.repeat(64)},archive:{source:'pages/pages.zip',sha256:'b'.repeat(64)},
    publicKey:{source:'pages/public-key.json',sha256:'c'.repeat(64)}};
  f.options.pagesAdapter={verify:async()=>{events.push('verify');return {status:'VERIFIED'};},
    publish:async()=>{events.push(f.calls.some(c=>c.path==='/releases/assets/9')?'publish-after-download':'wrong-order');return {status:'PUBLISHED',sequence:1};}};
  const result=await publishDesktop({...job,repository:'301zrg/srvprotianti-desktop',pages},f.options);
  assert.deepEqual(events,['verify','publish-after-download']);assert.equal(result.pages.sequence,1);
  assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('page preflight failure precedes credentials, tag creation and release requests',async()=>{
  const f=fixture({tagExists:false,published:false});let credentials=0;
  f.options.credentialProvider=()=>{credentials++;return 'secret';};
  f.options.pagesAdapter={verify:async()=>{throw Object.assign(Error('bad hash'),{code:'DESKTOP_PAGES_HASH_MISMATCH'});}};
  const pages={publisherRoot:'F:/desktop',websiteRoot:'F:/web',manifest:{source:'pages/stable.json',sha256:'a'.repeat(64)},
    archive:{source:'pages/pages.zip',sha256:'b'.repeat(64)},publicKey:{source:'pages/key.json',sha256:'c'.repeat(64)}};
  await assert.rejects(preflightDesktop({...job,repository:'301zrg/srvprotianti-desktop',pages},f.options),{code:'DESKTOP_PAGES_HASH_MISMATCH'});
  assert.equal(credentials,0);assert.equal(f.calls.length,0);
});

test('credential lookup selects the declared repository owner noninteractively',()=>{
  const previous={GITHUB_TOKEN:process.env.GITHUB_TOKEN,GH_TOKEN:process.env.GH_TOKEN};
  delete process.env.GITHUB_TOKEN;delete process.env.GH_TOKEN;
  try {
    let input;
    assert.equal(localCredential('301zrg/srvprotianti-desktop',(file,args,options)=>{
      assert.equal(file,'git');assert.deepEqual(args,['credential','fill']);input=options.input;
      assert.equal(options.windowsHide,true);assert.equal(options.env.GCM_INTERACTIVE,'never');
      return {status:0,stdout:'password=fixture-token\n'};
    }),'fixture-token');
    assert.equal(input,'protocol=https\nhost=github.com\nusername=301zrg\n\n');
  } finally {
    for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});

test('a page request failure preserves EXE_VERIFIED and retry checks the EXE before finishing both',async t=>{
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'release-monitor-desktop-'));
  t.after(()=>{assert.equal(path.dirname(stateDir),os.tmpdir());assert.ok(path.basename(stateDir).startsWith('release-monitor-desktop-'));fs.rmSync(stateDir,{recursive:true,force:true});});
  const f=fixture({repository:'301zrg/srvprotianti-desktop'});f.options.stateDir=stateDir;
  const pages={publisherRoot:'F:/desktop',websiteRoot:'F:/web',manifest:{source:'pages/stable.json',sha256:'a'.repeat(64)},
    archive:{source:'pages/pages.zip',sha256:'b'.repeat(64)},publicKey:{source:'pages/key.json',sha256:'c'.repeat(64)}};
  const task={...job,repository:'301zrg/srvprotianti-desktop',pages};let attempts=0;
  f.options.pagesAdapter={verify:async()=>({status:'VERIFIED'}),publish:async()=>{
    if(++attempts===1)throw Object.assign(Error('request failed'),{code:'DESKTOP_PAGES_REQUEST_FAILED'});
    return {status:'PUBLISHED',sequence:1};
  }};
  await assert.rejects(publishDesktop(task,f.options),{code:'DESKTOP_PAGES_REQUEST_FAILED'});
  const receipt=path.join(stateDir,'desktop-301zrg-srvprotianti-desktop-v0.1.4.json');
  assert.equal(JSON.parse(fs.readFileSync(receipt)).status,'EXE_VERIFIED');
  assert.equal((await publishDesktop(task,f.options)).pages.status,'PUBLISHED');
  assert.equal(JSON.parse(fs.readFileSync(receipt)).status,'PUBLISHED');
  assert.equal(f.calls.filter(c=>c.path==='/releases/assets/9').length,2);
  assert.ok(f.calls.every(c=>c.method==='GET'));
});
