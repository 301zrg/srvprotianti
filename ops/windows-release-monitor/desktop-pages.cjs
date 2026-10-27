'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const repository = '301zrg/srvprotianti-desktop';
const sourceFiles = ['scripts/publish-page-package.mjs', 'scripts/page-package.mjs',
  'scripts/sync-web-source.mjs', 'web-source/source-manifest.json', 'src-tauri/page-update-public-key.json'];
const fail = code => Object.assign(new Error(code), {code});
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const relative = value => typeof value === 'string' && value.length < 241 &&
  value.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && !part.endsWith('.'));
const absolute = value => typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value) &&
  value.length < 241 && !/[\x00-\x1f<>"|?*]/.test(value) && !value.slice(2).includes(':') &&
  value.slice(3).split(/[\\/]/).every(part => part && part !== '.' && part !== '..' && !/[ .]$/.test(part));

function validate(pages) {
  const fields = ['publisherRoot', 'websiteRoot', 'manifest', 'archive', 'publicKey'];
  if (pages && Object.hasOwn(pages, 'sourceCommit')) fields.push('sourceCommit');
  if (!exact(pages, fields) ||
      (Object.hasOwn(pages, 'sourceCommit') && !/^[a-f0-9]{40}$/.test(pages.sourceCommit || '')) ||
      !absolute(pages.publisherRoot) || !absolute(pages.websiteRoot) ||
      !['manifest', 'archive', 'publicKey'].every(kind => exact(pages[kind], ['source', 'sha256']) &&
        relative(pages[kind].source) && /^[a-f0-9]{64}$/.test(pages[kind].sha256 || '')) ||
      new Set(['manifest', 'archive', 'publicKey'].map(kind => pages[kind].source.toLowerCase())).size !== 3) {
    throw fail('DESKTOP_MANIFEST_INVALID');
  }
  return pages;
}

function beneath(root, file) {
  const relativePath = path.relative(root, file);
  return relativePath && !relativePath.startsWith('..' + path.sep) && relativePath !== '..' && !path.isAbsolute(relativePath);
}

function localInputs(desktop, options) {
  if (options.signal?.aborted) throw fail('DESKTOP_INTERRUPTED');
  const p = desktop.pages, sourceCommit = p.sourceCommit || desktop.targetCommit, files = {};
  try {
    if (!options.jobDir) throw Error();
    const jobRoot = fs.realpathSync(options.jobDir);
    for (const kind of ['manifest', 'archive', 'publicKey']) {
      const file = path.resolve(jobRoot, p[kind].source);
      const info = fs.lstatSync(file), maximum = {manifest: 1048576, archive: 20971520, publicKey: 16384}[kind];
      if (!beneath(jobRoot, file) || !info.isFile() || info.size <= 0 || info.size > maximum) throw Error();
      const resolved = fs.realpathSync(file);
      if (!beneath(jobRoot, resolved)) throw Error();
      const bytes = fs.readFileSync(resolved);
      if (hash(bytes) !== p[kind].sha256) throw fail('DESKTOP_PAGES_HASH_MISMATCH');
      files[kind] = resolved;
    }
  } catch (error) { throw error.code === 'DESKTOP_PAGES_HASH_MISMATCH' ? error : fail('DESKTOP_PAGES_ARTIFACT_INVALID'); }
  try {
    const publisherRoot = fs.realpathSync(p.publisherRoot);
    const git = (args, binary = false) => {
      const output = cp.execFileSync('git', ['-C', publisherRoot, ...args], {
        encoding: binary ? undefined : 'utf8', windowsHide: true, shell: false, timeout: 15000, maxBuffer: 131072,
        stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never'}
      });
      return binary ? output : output.trim();
    };
    if (!/^[a-f0-9]{40}$/.test(sourceCommit) || git(['rev-parse', 'HEAD']) !== sourceCommit ||
        fs.realpathSync(git(['rev-parse', '--show-toplevel'])) !== publisherRoot ||
        git(['status', '--porcelain', '--untracked-files=all', '--', ...sourceFiles, 'web-source'])) throw Error();
    // Page packages cannot change the native bridge, API permissions or trust
    // anchor of the already released EXE, even when page source advances.
    if (sourceCommit !== desktop.targetCommit &&
        git(['diff', '--name-only', '--no-ext-diff', desktop.targetCommit, sourceCommit, '--', 'src-tauri'])) throw Error();
    for (const file of sourceFiles) {
      git(['cat-file', '-e', sourceCommit + ':' + file]);
      const resolved = fs.realpathSync(path.join(publisherRoot, file));
      if (!beneath(publisherRoot, resolved) || !fs.lstatSync(path.join(publisherRoot, file)).isFile()) throw Error();
      const committed = git(['show', sourceCommit + ':' + file], true), working = fs.readFileSync(resolved);
      const normalized = bytes => bytes.toString('latin1').replaceAll('\r\n', '\n');
      if (!committed.equals(working) && normalized(committed) !== normalized(working)) throw Error();
    }
    const publicKey = JSON.parse(fs.readFileSync(files.publicKey, 'utf8'));
    const trusted = JSON.parse(git(['show', desktop.targetCommit + ':src-tauri/page-update-public-key.json']));
    if (!exact(publicKey, ['keyId', 'publicKey']) || publicKey.keyId !== trusted.keyId || publicKey.publicKey !== trusted.publicKey) {
      throw fail('DESKTOP_PAGES_KEY_MISMATCH');
    }
    return {...files, publisherRoot, sourceCommit, websiteRoot: fs.realpathSync(p.websiteRoot), sourceDirectory: path.join(publisherRoot, 'web-source')};
  } catch (error) { throw error.code === 'DESKTOP_PAGES_KEY_MISMATCH' ? error : fail('DESKTOP_PAGES_SOURCE_INVALID'); }
}

// Reuse every local publisher gate, stopping at its first credential request.
// No credential provider or network request can run during this preflight.
const verifyScript = `
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const [publisher,manifestPath,archivePath,publicKeyPath,commit,websiteRoot,sourceDirectory]=process.argv.slice(1);
process.argv[1]='';
try {
  const {publishPagePackage}=await import(pathToFileURL(publisher).href);
  let verified=false;
  try { await publishPagePackage({manifestPath,archivePath,publicKeyPath,commit,websiteRoot,sourceDirectory,
    tokenProvider:()=>{verified=true;throw Object.assign(Error(),{code:'PAGE_PREFLIGHT_VERIFIED'});},
    fetchImpl:()=>{throw Object.assign(Error(),{code:'PAGE_PREFLIGHT_NETWORK_FORBIDDEN'});}}); }
  catch(error){if(!verified||error.code!=='PAGE_PREFLIGHT_VERIFIED')throw error;}
  if(!verified)throw Error();
  const envelope=JSON.parse(await readFile(manifestPath,'utf8'));
  const payload=JSON.parse(Buffer.from(envelope.payload,'base64'));
  console.log(JSON.stringify({status:'VERIFIED',pageVersion:payload.version,sequence:payload.sequence,websiteCommit:payload.sourceCommits.website}));
} catch(error) {console.error(/^PAGE_[A-Z0-9_]+$/.test(error.code||'')?error.code:'PAGE_PREFLIGHT_INVALID');process.exitCode=1;}
`;

function child(file, args, options) {
  return new Promise(resolve => cp.execFile(file, args, options,
    (error, stdout, stderr) => resolve({error, stdout, stderr})));
}

async function run(args, options, publishing) {
  const settings = {encoding: 'utf8', windowsHide: true, shell: false,
    timeout: publishing ? 600000 : 120000, maxBuffer: 131072, signal: options.signal,
    env: {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never'}};
  let result;
  try { result = await (options.pageProcess || child)(process.execPath, args, settings); }
  catch (_) { throw fail(options.signal?.aborted ? 'DESKTOP_INTERRUPTED' : 'DESKTOP_PAGES_PROCESS_FAILED'); }
  if (options.signal?.aborted) throw fail('DESKTOP_INTERRUPTED');
  if (result.error) {
    if (result.error.killed || result.error.code === 'ETIMEDOUT') throw fail('DESKTOP_PAGES_TIMEOUT');
    const code = String(result.stderr || '').trim();
    if (code === 'PAGE_PUBLISH_AUTH_REQUIRED' || /^PAGE_PUBLISH_HTTP_(401|403)$/.test(code)) throw fail('DESKTOP_AUTH_REQUIRED');
    if (/^PAGE_PUBLISH_(REQUEST_UNCERTAIN|RELEASE_UNCERTAIN|RELEASE_UNCONFIRMED|INDEX_UNCONFIRMED|HTTP_(408|429|5\d\d))$/.test(code)) {
      throw fail('DESKTOP_PAGES_REQUEST_FAILED');
    }
    // Child stderr/stdout may contain credentials from third-party tooling. Keep only a known safe code.
    throw fail(/^PAGE_[A-Z0-9_]{1,80}$/.test(code) ? 'DESKTOP_PAGES_' + code.replace(/^PAGE_/, '') : 'DESKTOP_PAGES_PROCESS_FAILED');
  }
  try { return JSON.parse(String(result.stdout)); }
  catch (_) { throw fail('DESKTOP_PAGES_RESPONSE_INVALID'); }
}

async function verify(desktop, options = {}) {
  const files = localInputs(desktop, options);
  const result = await run(['--input-type=module', '--eval', verifyScript, '--',
    path.join(files.publisherRoot, 'scripts/publish-page-package.mjs'), files.manifest, files.archive,
    files.publicKey, files.sourceCommit, files.websiteRoot, files.sourceDirectory], options, false);
  if (result?.status !== 'VERIFIED' || !/^\d+\.\d+\.\d+$/.test(result.pageVersion || '') ||
      !Number.isSafeInteger(result.sequence) || result.sequence < 1 || !/^[a-f0-9]{40}$/.test(result.websiteCommit || '')) {
    throw fail('DESKTOP_PAGES_RESPONSE_INVALID');
  }
  return result;
}

async function publish(desktop, options = {}) {
  const files = localInputs(desktop, options);
  const result = await run([path.join(files.publisherRoot, 'scripts/publish-page-package.mjs'),
    '--manifest', files.manifest, '--archive', files.archive, '--public-key', files.publicKey,
    '--commit', files.sourceCommit, '--website-root', files.websiteRoot, '--source-directory', files.sourceDirectory], options, true);
  if (result?.archiveSha256 !== desktop.pages.archive.sha256 || result.manifestSha256 !== desktop.pages.manifest.sha256 ||
      !/^\d+\.\d+\.\d+$/.test(result.pageVersion || '') || !Number.isSafeInteger(result.sequence) || result.sequence < 1 ||
      !Number.isSafeInteger(result.release?.id) || result.release.id < 1 || result.release.latestApplication !== desktop.tag ||
      result.release.url !== `https://github.com/${repository}/releases/tag/pages-v${result.pageVersion}` ||
      !/^[a-f0-9]{40}$/.test(result.index?.commit || '')) throw fail('DESKTOP_PAGES_RESPONSE_INVALID');
  return {status: 'PUBLISHED', ...result, verifiedAt: new Date().toISOString()};
}

module.exports = {validate, verify, publish};
