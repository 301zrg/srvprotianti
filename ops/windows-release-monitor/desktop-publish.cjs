'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const {setTimeout: sleep} = require('node:timers/promises');
const pages = require('./desktop-pages.cjs');

function fail(code) {
  const messages = {
    DESKTOP_AUTH_REQUIRED: '助手发布需要本机 GitHub 写权限认证；请配置现有 Git 凭据或当前进程的 GITHUB_TOKEN，再恢复本批次。',
    DESKTOP_CI_FAILED: '助手 Windows CI 失败；服务器不会因此再次重启，请检查该版本构建。',
    DESKTOP_CI_TIMEOUT: '助手发布等待超时；再次打开入口会核对既有标签和发布结果，不重复推送标签。'
  };
  return Object.assign(new Error(messages[code] || code), {code});
}

function validate(desktop) {
  const d = desktop;
  if (!d || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(d.repository || '') ||
      !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(d.tag || '') ||
      !/^[a-f0-9]{40}$/.test(d.targetCommit || '') || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.ya?ml$/.test(d.workflow || '') ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]*\.zip$/.test(d.asset?.name || '') ||
      (d.asset.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(d.asset.sha256)) ||
      (d.timeoutMinutes !== undefined && (!Number.isInteger(d.timeoutMinutes) || d.timeoutMinutes < 1 || d.timeoutMinutes > 180)) ||
      (d.pollSeconds !== undefined && (!Number.isInteger(d.pollSeconds) || d.pollSeconds < 5 || d.pollSeconds > 60))) {
    throw fail('DESKTOP_MANIFEST_INVALID');
  }
  if (Object.hasOwn(d, 'pages')) {
    pages.validate(d.pages);
    if (d.repository !== '301zrg/srvprotianti-desktop') throw fail('DESKTOP_MANIFEST_INVALID');
  }
  return d;
}

function localCredential(repository, spawnSync = cp.spawnSync) {
  const supplied = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (supplied) return supplied;
  const result = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\nusername=' + repository.split('/')[0] + '\n\n', encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never'}
  });
  if (result.status !== 0) return null;
  return result.stdout.match(/^password=(.+)$/m)?.[1]?.trim() || null;
}

async function context(desktop, options) {
  const d = validate(desktop);
  const token = await (options.credentialProvider || (() => localCredential(d.repository)))();
  if (options.signal?.aborted) throw fail('DESKTOP_INTERRUPTED');
  const fetchImpl = options.fetchImpl || fetch;
  const prefix = `https://api.github.com/repos/${d.repository}`;
  const headers = {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'srvpro-windows-release-monitor', ...(token ? {Authorization: `Bearer ${token}`} : {})};
  async function api(route, {method = 'GET', body, missing = false} = {}) {
    const attempts = method === 'GET' ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (options.signal?.aborted) throw fail('DESKTOP_INTERRUPTED');
      let response, reason;
      try {
        response = await fetchImpl(prefix + route, {method, redirect: 'error', headers: {...headers,
          ...(body ? {'Content-Type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined,
          signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)});
      } catch (error) {
        if (options.signal?.aborted) throw fail('DESKTOP_INTERRUPTED');
        const code = error.cause?.code || error.code || error.name;
        reason = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'NETWORK';
      }
      if (response) {
        if (missing && response.status === 404) return null;
        if ([401, 403].includes(response.status)) throw fail('DESKTOP_AUTH_REQUIRED');
        if (response.ok) {
          try { return await response.json(); } catch (_) { throw fail('DESKTOP_RESPONSE_INVALID'); }
        }
        reason = 'HTTP_' + response.status;
        if (![500, 502, 503, 504].includes(response.status)) {
          throw Object.assign(fail('DESKTOP_REQUEST_FAILED'), {message: 'DESKTOP_REQUEST_FAILED: ' + reason});
        }
        await response.body?.cancel().catch(() => {});
      }
      if (attempt + 1 === attempts) {
        throw Object.assign(fail('DESKTOP_REQUEST_FAILED'), {message: 'DESKTOP_REQUEST_FAILED: ' + reason});
      }
      // Retry only reads. Uncertain writes still reconcile their original result exactly once.
      options.log?.(`GitHub 只读检查临时失败（${reason}），有限重试 ${attempt + 1}/${attempts - 1}。`);
      await (options.sleep || sleep)(1000 * (attempt + 1), undefined, options.signal ? {signal: options.signal} : undefined);
    }
  }
  async function tagCommit() {
    const ref = await api('/git/ref/tags/' + encodeURIComponent(d.tag), {missing: true});
    if (!ref) return null;
    let object = ref.object;
    for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
      if (!/^[a-f0-9]{40}$/.test(object.sha || '')) throw fail('DESKTOP_RESPONSE_INVALID');
      object = (await api('/git/tags/' + object.sha)).object;
    }
    if (object?.type !== 'commit' || object.sha !== d.targetCommit) throw fail('DESKTOP_TAG_CONFLICT');
    return object.sha;
  }
  async function verifySource() {
    if ((await api('/commits/' + d.targetCommit)).sha !== d.targetCommit) throw fail('DESKTOP_COMMIT_INVALID');
    const versions = await Promise.all(['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml'].map(async file => {
      const value = await api('/contents/' + file + '?ref=' + d.targetCommit);
      if (value.encoding !== 'base64' || typeof value.content !== 'string' || value.content.length > 1048576) throw fail('DESKTOP_RESPONSE_INVALID');
      const text = Buffer.from(value.content, 'base64').toString('utf8');
      try { return file.endsWith('.toml') ? text.match(/^version\s*=\s*"([^"]+)"/m)?.[1] : JSON.parse(text).version; }
      catch (_) { throw fail('DESKTOP_VERSION_MISMATCH'); }
    }));
    if (!versions.every(version => 'v' + version === d.tag)) throw fail('DESKTOP_VERSION_MISMATCH');
    if ((await api('/actions/workflows/' + encodeURIComponent(d.workflow))).state !== 'active') throw fail('DESKTOP_WORKFLOW_INACTIVE');
  }
  return {d, options, token, api, prefix, headers, fetchImpl, tagCommit, verifySource};
}

async function inspect(c) {
  await c.verifySource();
  const tag = await c.tagCommit();
  if (!tag) {
    if (!c.token) throw fail('DESKTOP_AUTH_REQUIRED');
    return {status: 'READY_TO_TAG'};
  }
  const release = await c.api('/releases/tags/' + encodeURIComponent(c.d.tag), {missing: true});
  return {status: release && !release.draft && !release.prerelease ? 'ALREADY_PUBLISHED' : 'CI_PENDING', release};
}

async function verifyAsset(c, release, workflowRunId) {
  if (release.tag_name !== c.d.tag || release.draft || release.prerelease || !Array.isArray(release.assets)) throw fail('DESKTOP_RELEASE_INVALID');
  const assets = release.assets.filter(asset => asset.name === c.d.asset.name);
  if (assets.length !== 1) throw fail('DESKTOP_ASSET_MISSING');
  const asset = assets[0], expected = /^sha256:([a-f0-9]{64})$/.exec(asset.digest || '')?.[1];
  if (!expected || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.id) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 268435456) {
    throw fail('DESKTOP_ASSET_INVALID');
  }
  let response;
  try { response = await c.fetchImpl(c.prefix + '/releases/assets/' + asset.id, {
    headers: {...c.headers, Accept: 'application/octet-stream'}, redirect: 'follow',
    signal: c.options.signal ? AbortSignal.any([c.options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)}); }
  catch (_) { throw fail('DESKTOP_ASSET_DOWNLOAD_FAILED'); }
  if (!response.ok || !response.body) throw fail('DESKTOP_ASSET_DOWNLOAD_FAILED');
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > asset.size || size > 268435456) { await response.body.cancel?.().catch(() => {}); throw fail('DESKTOP_ASSET_MISMATCH'); }
    hash.update(chunk);
  }
  const actual = hash.digest('hex');
  if (size !== asset.size || actual !== expected || (c.d.asset.sha256 && actual !== c.d.asset.sha256)) throw fail('DESKTOP_ASSET_MISMATCH');
  const result = {status: 'PUBLISHED', repository: c.d.repository, tag: c.d.tag, targetCommit: c.d.targetCommit,
    releaseId: release.id, assetId: asset.id, assetSHA256: actual, workflowRunId: workflowRunId || null,
    url: `https://github.com/${c.d.repository}/releases/tag/${c.d.tag}`, verifiedAt: new Date().toISOString()};
  return result;
}

function saveResult(c, result) {
  if (c.options.stateDir) {
    fs.mkdirSync(c.options.stateDir, {recursive: true});
    const target = path.join(c.options.stateDir, `desktop-${c.d.repository.replace('/', '-')}-${c.d.tag}.json`);
    fs.writeFileSync(target + '.tmp', JSON.stringify(result, null, 2));
    fs.renameSync(target + '.tmp', target);
  }
}

async function preflightDesktop(desktop, options = {}) {
  if (desktop == null) return {skipped: true};
  validate(desktop);
  const pageResult = desktop.pages ? await (options.pagesAdapter || pages).verify(desktop, options) : null;
  const c = await context(desktop, options);
  if (desktop.pages && !c.token) throw fail('DESKTOP_AUTH_REQUIRED');
  const result = await inspect(c);
  // Preflight is read-only and does not push a version tag or download a ZIP.
  return {status: result.status, repository: c.d.repository, tag: c.d.tag, targetCommit: c.d.targetCommit,
    ...(pageResult ? {pages: pageResult} : {})};
}

async function publishDesktop(desktop, options = {}) {
  if (desktop == null) return {skipped: true};
  validate(desktop);
  if (desktop.pages) await (options.pagesAdapter || pages).verify(desktop, options);
  const c = await context(desktop, options), initial = await inspect(c);
  const complete = async (release, workflowRunId) => {
    const result = await verifyAsset(c, release, workflowRunId);
    if (desktop.pages) {
      result.status = 'EXE_VERIFIED';
      result.pages = {status: 'PENDING'};
      saveResult(c, result);
      options.log?.('助手安装包已核验，开始发布并核验已签名页面包。');
      result.pages = await (options.pagesAdapter || pages).publish(desktop, options);
      result.status = 'PUBLISHED';
    }
    saveResult(c, result);
    return result;
  };
  if (initial.status === 'ALREADY_PUBLISHED') return complete(initial.release);
  if (initial.status === 'READY_TO_TAG') {
    if (options.signal?.aborted) throw fail('DESKTOP_INTERRUPTED');
    // A lost response is reconciled once; never blindly create/move the tag again.
    try { await c.api('/git/refs', {method: 'POST', body: {ref: 'refs/tags/' + c.d.tag, sha: c.d.targetCommit}}); }
    catch (_) { if (!await c.tagCommit()) throw fail('DESKTOP_TAG_CREATION_UNCERTAIN'); }
    if (!await c.tagCommit()) throw fail('DESKTOP_TAG_CREATION_UNCERTAIN');
  }
  const deadline = Date.now() + (c.d.timeoutMinutes || 90) * 60000;
  for (let polls = 0; Date.now() < deadline && polls < (options.maxPolls || Infinity); polls++) {
    if (options.signal?.aborted) throw fail('DESKTOP_INTERRUPTED');
    if (!await c.tagCommit()) throw fail('DESKTOP_TAG_CONFLICT');
    const runs = await c.api('/actions/workflows/' + encodeURIComponent(c.d.workflow) + '/runs?head_sha=' + c.d.targetCommit + '&event=push&per_page=100');
    if (!Array.isArray(runs.workflow_runs)) throw fail('DESKTOP_RESPONSE_INVALID');
    const tagged = runs.workflow_runs.filter(run => run.head_sha === c.d.targetCommit && run.head_branch === c.d.tag && run.event === 'push')
      .sort((a, b) => b.id - a.id)[0];
    if (tagged?.status === 'completed' && tagged.conclusion !== 'success') throw fail('DESKTOP_CI_FAILED');
    const release = await c.api('/releases/tags/' + encodeURIComponent(c.d.tag), {missing: true});
    if (release && !release.draft && !release.prerelease && tagged?.status === 'completed' && tagged.conclusion === 'success') {
      return complete(release, tagged.id);
    }
    options.log?.(`助手 ${c.d.tag}：等待 Windows CI 与正式 ZIP。`);
    await (options.sleep || sleep)((c.d.pollSeconds || 20) * 1000, undefined, options.signal ? {signal: options.signal} : undefined);
  }
  throw fail('DESKTOP_CI_TIMEOUT');
}

module.exports = {preflightDesktop, publishDesktop, validate, localCredential};
