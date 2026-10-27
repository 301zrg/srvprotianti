'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const cp=require('node:child_process');
const crypto=require('node:crypto');
const pages=require('./desktop-pages.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t,cliGuard=false){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'release-monitor-pages-'));
  t.after(()=>{assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('release-monitor-pages-'));fs.rmSync(directory,{recursive:true,force:true});});
  const publisherRoot=path.join(directory,'publisher'),jobDir=path.join(directory,'job'),websiteRoot=path.join(directory,'website');
  for(const dir of [publisherRoot,jobDir,websiteRoot])fs.mkdirSync(dir,{recursive:true});
  const git=(...args)=>cp.execFileSync('git',['-c','core.autocrlf=false','-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-C',publisherRoot,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
  const write=(name,contents)=>{const file=path.join(publisherRoot,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,contents);};
  const key={keyId:'fixture',publicKey:Buffer.alloc(32,1).toString('base64')};
  // A harmless reviewed fixture publisher exercises the real hidden child process boundary.
  write('scripts/publish-page-package.mjs',`import {pathToFileURL} from 'node:url';
export async function publishPagePackage(o){await o.tokenProvider();}
${cliGuard?`if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  console.error('PAGE_PUBLISH_COMMIT_INVALID');process.exitCode=1;
}`:''}\n`);
  write('scripts/page-package.mjs','export const fixture=true;\n');
  write('scripts/sync-web-source.mjs','export const fixture=true;\n');
  write('web-source/source-manifest.json','{}\n');write('src-tauri/page-update-public-key.json',JSON.stringify(key));
  git('init','--template=');git('add','.');git('commit','-m','fixture');
  const desktop={repository:'301zrg/srvprotianti-desktop',tag:'v0.2.0',targetCommit:git('rev-parse','HEAD')};
  desktop.pages={publisherRoot,websiteRoot};fs.mkdirSync(path.join(jobDir,'pages'));
  const payload={version:'1.0.0',sequence:1,sourceCommits:{website:'b'.repeat(40)}};
  for(const [kind,name,bytes] of [['manifest','stable.json',Buffer.from(JSON.stringify({payload:Buffer.from(JSON.stringify(payload)).toString('base64')}))],
    ['archive','pages.zip',Buffer.from('fixture archive')],['publicKey','key.json',Buffer.from(JSON.stringify(key))]]){
    fs.writeFileSync(path.join(jobDir,'pages',name),bytes);desktop.pages[kind]={source:'pages/'+name,sha256:hash(bytes)};
  }
  return {directory,desktop,jobDir,git,write,options:{jobDir}};
}

test('artifact hash mismatch stops before any publisher process',async t=>{
  const f=fixture(t);let processes=0;fs.appendFileSync(path.join(f.jobDir,'pages/pages.zip'),'changed');
  await assert.rejects(pages.verify(f.desktop,{...f.options,pageProcess:()=>{processes++;}}),{code:'DESKTOP_PAGES_HASH_MISMATCH'});
  assert.equal(processes,0);
});

test('artifact paths cannot escape the job through a directory junction',async t=>{
  const f=fixture(t);const outside=path.join(f.directory,'outside');fs.mkdirSync(outside);
  fs.copyFileSync(path.join(f.jobDir,'pages/pages.zip'),path.join(outside,'pages.zip'));
  fs.symlinkSync(outside,path.join(f.jobDir,'linked'),'junction');f.desktop.pages.archive.source='linked/pages.zip';
  await assert.rejects(pages.verify(f.desktop,f.options),{code:'DESKTOP_PAGES_ARTIFACT_INVALID'});
});

test('source HEAD drift and modified publisher code are rejected before execution',async t=>{
  const f=fixture(t);let processes=0;const options={...f.options,pageProcess:()=>{processes++;}};
  await assert.rejects(pages.verify({...f.desktop,targetCommit:'a'.repeat(40)},options),{code:'DESKTOP_PAGES_SOURCE_INVALID'});
  f.write('scripts/publish-page-package.mjs','throw Error("do not execute");\n');
  await assert.rejects(pages.verify(f.desktop,options),{code:'DESKTOP_PAGES_SOURCE_INVALID'});
  f.git('update-index','--assume-unchanged','scripts/publish-page-package.mjs');
  assert.equal(f.git('status','--porcelain'),'');
  await assert.rejects(pages.verify(f.desktop,options),{code:'DESKTOP_PAGES_SOURCE_INVALID'});
  assert.equal(processes,0);
});

test('queue public key must match the target EXE trust anchor',async t=>{
  const f=fixture(t),bytes=Buffer.from(JSON.stringify({keyId:'another',publicKey:Buffer.alloc(32,2).toString('base64')}));
  fs.writeFileSync(path.join(f.jobDir,'pages/key.json'),bytes);f.desktop.pages.publicKey.sha256=hash(bytes);
  await assert.rejects(pages.verify(f.desktop,f.options),{code:'DESKTOP_PAGES_KEY_MISMATCH'});
});

test('read-only preflight reuses publisher verification without requesting credentials',async t=>{
  const f=fixture(t);const result=await pages.verify(f.desktop,f.options);
  assert.equal(result.status,'VERIFIED');assert.equal(result.sequence,1);
  assert.equal(f.git('status','--porcelain'),'');
});

test('importing the real publisher CLI guard during preflight never executes its main entry',async t=>{
  const f=fixture(t,true);
  const result=await pages.verify(f.desktop,f.options);
  assert.equal(result.status,'VERIFIED');
  assert.equal(f.git('status','--porcelain'),'');
});

test('publisher errors are sanitized and transient requests remain recoverable',async t=>{
  const f=fixture(t);const options={...f.options,pageProcess:async()=>({error:{code:1},stdout:'secret-token',stderr:'PAGE_PUBLISH_REQUEST_UNCERTAIN\n'})};
  await assert.rejects(pages.publish(f.desktop,options),error=>error.code==='DESKTOP_PAGES_REQUEST_FAILED'&&!error.message.includes('secret-token'));
  options.pageProcess=async()=>({error:{killed:true,code:'ETIMEDOUT'},stderr:'credential-secret'});
  await assert.rejects(pages.publish(f.desktop,options),{code:'DESKTOP_PAGES_TIMEOUT'});
});

test('publish uses an argument array, fixed CLI paths and bounded hidden child options',async t=>{
  const f=fixture(t);let call;
  const result=await pages.publish(f.desktop,{...f.options,pageProcess:async(file,args,options)=>{
    call={file,args,options};return {stdout:JSON.stringify({release:{id:1,url:'https://github.com/301zrg/srvprotianti-desktop/releases/tag/pages-v1.0.0',latestApplication:'v0.2.0'},
      index:{commit:'c'.repeat(40)},pageVersion:'1.0.0',sequence:1,archiveSha256:f.desktop.pages.archive.sha256,manifestSha256:f.desktop.pages.manifest.sha256})};
  }});
  assert.equal(result.status,'PUBLISHED');assert.equal(call.file,process.execPath);
  assert.equal(call.args[0],path.join(f.desktop.pages.publisherRoot,'scripts/publish-page-package.mjs'));
  assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);
  assert.ok(call.options.timeout<=600000);assert.ok(call.options.maxBuffer<=131072);
  assert.equal(call.args[call.args.indexOf('--commit')+1],f.desktop.targetCommit);
});

test('page source commit can advance without changing the existing EXE identity',async t=>{
  const f=fixture(t),nativeCommit=f.desktop.targetCommit;
  f.write('web-source/card-usage.js','export const cards=[];\n');
  f.git('add','.');f.git('commit','-m','pages only');
  const sourceCommit=f.git('rev-parse','HEAD');f.desktop.pages.sourceCommit=sourceCommit;
  const verified=await pages.verify(f.desktop,f.options);
  assert.equal(verified.status,'VERIFIED');assert.equal(f.desktop.targetCommit,nativeCommit);
  let call;
  await pages.publish(f.desktop,{...f.options,pageProcess:async(file,args)=>{
    call=args;return {stdout:JSON.stringify({release:{id:1,url:'https://github.com/301zrg/srvprotianti-desktop/releases/tag/pages-v1.0.0',latestApplication:'v0.2.0'},
      index:{commit:'c'.repeat(40)},pageVersion:'1.0.0',sequence:1,archiveSha256:f.desktop.pages.archive.sha256,manifestSha256:f.desktop.pages.manifest.sha256})};
  }});
  assert.equal(call[call.indexOf('--commit')+1],sourceCommit);
  assert.equal(f.desktop.targetCommit,nativeCommit);
});

test('separate page source rejects native changes before any publisher execution',async t=>{
  const f=fixture(t);let processes=0;
  f.write('src-tauri/src/api.rs','expanded native permissions\n');
  f.git('add','.');f.git('commit','-m','native changes');
  f.desktop.pages.sourceCommit=f.git('rev-parse','HEAD');
  await assert.rejects(pages.verify(f.desktop,{...f.options,pageProcess:()=>{processes++;}}),{code:'DESKTOP_PAGES_SOURCE_INVALID'});
  assert.equal(processes,0);
});

test('optional page source commit must be an exact full lowercase Git SHA',t=>{
  const f=fixture(t);
  for(const sourceCommit of ['',null,123,'a'.repeat(39),'a'.repeat(41),'A'.repeat(40),'main']){
    assert.throws(()=>pages.validate({...f.desktop.pages,sourceCommit}),{code:'DESKTOP_MANIFEST_INVALID'});
  }
  assert.equal(pages.validate({...f.desktop.pages,sourceCommit:'a'.repeat(40)}).sourceCommit,'a'.repeat(40));
  assert.ok(pages.validate(f.desktop.pages),'existing manifests remain valid');
});
