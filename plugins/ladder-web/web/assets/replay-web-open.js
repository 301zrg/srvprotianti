(function (global) {
  'use strict';

  var CHANNEL = 'srvprotiantiweb:replay-import';
  var MAX_BYTES = 8 * 1024 * 1024, INLINE_BYTES = 24 * 1024, MAX_URL = 34 * 1024;
  var prepared = null, active = null;
  var TEXT = {
    zh: {open: '网页播放', next: '继续网页播放', loading: '正在读取…', ready: '录像已读取，点击「继续网页播放」在新标签页接收。', waiting: '正在向网页版传递录像…', saved: '网页版已接收录像，兼容的格式会自动打开播放。', memory: '网页版仅临时保存，请立即下载备份。', cancelled: '已取消传递录像。', failed: '无法打开录像，请重试或下载后在网页版导入。', unavailable: '录像不可用，请刷新列表后重试。', popup: '新标签页被阻止，请允许弹窗后重试，或下载后导入。', timeout: '读取或传递超时，请重试或下载后导入。', closed: '网页版已关闭，尚未确认保存。', tooLarge: '录像超过 8 MB，请使用原下载入口。'},
    ja: {open: 'Web再生', next: 'Web再生へ進む', loading: '読み込み中…', ready: '読み込み済みです。「Web再生へ進む」で新しいタブに送信します。', waiting: 'Web版へリプレイを送信中…', saved: 'Web版で受信しました。対応形式は自動的に再生画面へ進みます。', memory: 'Web版では一時保存です。今すぐバックアップを保存してください。', cancelled: '送信をキャンセルしました。', failed: '開けません。再試行するか、保存してWeb版へインポートしてください。', unavailable: 'リプレイがありません。一覧を更新してください。', popup: '新しいタブがブロックされました。ポップアップを許可するか保存してインポートしてください。', timeout: '読み込み・送信がタイムアウトしました。再試行するか保存してインポートしてください。', closed: '保存を確認する前にWeb版が閉じられました。', tooLarge: '8 MBを超えています。元の保存リンクを使用してください。'},
    en: {open: 'Play in web', next: 'Continue to web', loading: 'Reading…', ready: 'Replay ready. Click “Continue to web” to send it to a new tab.', waiting: 'Sending replay to the web client…', saved: 'Replay received by the web client. Supported formats open the player automatically.', memory: 'Replay stored temporarily. Download a backup now.', cancelled: 'Replay transfer cancelled.', failed: 'Could not open replay. Retry, or download and import it in the web client.', unavailable: 'Replay unavailable. Refresh the list and retry.', popup: 'New tab blocked. Allow popups and retry, or download and import the replay.', timeout: 'Read or transfer timed out. Retry, or download and import the replay.', closed: 'Web client closed before saving was confirmed.', tooLarge: 'Replay exceeds 8 MB. Use the original download link.'},
    ko: {open: '웹 재생', next: '웹 재생 계속', loading: '읽는 중…', ready: '리플레이를 읽었습니다. “웹 재생 계속”을 눌러 새 탭으로 전송하세요.', waiting: '웹 클라이언트로 리플레이 전송 중…', saved: '웹에서 리플레이를 받았습니다. 지원되는 형식은 자동으로 재생 화면을 엽니다.', memory: '웹에 임시 저장했습니다. 지금 백업을 다운로드하세요.', cancelled: '전송을 취소했습니다.', failed: '열 수 없습니다. 다시 시도하거나 다운로드 후 웹에서 가져오세요.', unavailable: '리플레이가 없습니다. 목록을 새로고침하세요.', popup: '새 탭이 차단되었습니다. 팝업을 허용하거나 다운로드 후 가져오세요.', timeout: '읽기 또는 전송 시간이 초과되었습니다. 다시 시도하거나 다운로드 후 가져오세요.', closed: '저장을 확인하기 전에 웹 클라이언트가 닫혔습니다.', tooLarge: '8 MB를 초과했습니다. 원래 다운로드 링크를 사용하세요.'}
  };
  function label(key) { return global.SrvproWeb.t(TEXT, key); }
  function failure(key) { return Object.assign(new Error('Replay handoff failed'), {replayOpenKey: key}); }
  function status(button, key, error) {
    var parent = button.parentElement;
    if (!parent) return;
    var span = parent.querySelector('.replay-open-status');
    if (!span) {
      span = document.createElement('span'); span.className = 'replay-open-status'; parent.appendChild(span);
    }
    span.setAttribute('role', error ? 'alert' : 'status');
    span.classList.toggle('replay-open-error', !!error);
    span.textContent = label(key);
  }
  function busy(button) {
    button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = label('loading');
    return function () { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = label(prepared && prepared.button === button ? 'next' : 'open'); };
  }
  async function readFile(response) {
    if (!response.ok) throw failure('unavailable');
    if (Number(response.headers.get('Content-Length')) > MAX_BYTES) throw failure('tooLarge');
    // Bound streamed responses even when the server omits Content-Length.
    if (!response.body) throw failure('unavailable');
    var reader = response.body.getReader(), chunks = [], size = 0;
    try {
      while (true) {
        var part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > MAX_BYTES) { await reader.cancel(); throw failure('tooLarge'); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    if (!size) throw failure('unavailable');
    var bytes = new Uint8Array(size), offset = 0;
    chunks.forEach(function (chunk) { bytes.set(chunk, offset); offset += chunk.length; });
    return bytes;
  }
  function inlineUrl(bytes, name) {
    var url = global.SrvproDeckWeb.clientEntry();
    var encoded = btoa(Array.from(bytes, function (byte) { return String.fromCharCode(byte); }).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    url.hash = '/replay-import?' + new URLSearchParams({v: '1', kind: 'replay', format: 'yrp-base64url', file: name, data: encoded});
    if (url.href.length > MAX_URL) throw failure('tooLarge');
    return url.href;
  }
  function transfer(file) {
    var button = file.button, url, request;
    try {
      url = global.SrvproDeckWeb.clientEntry();
      request = Array.from(crypto.getRandomValues(new Uint8Array(16)), function (n) { return n.toString(16).padStart(2, '0'); }).join('');
      url.hash = '/replay-import?' + new URLSearchParams({v: '1', kind: 'replay', bridge: '1', origin: global.location.origin, request: request});
      if (url.href.length > MAX_URL) throw failure('tooLarge');
    } catch (error) { status(button, 'failed', true); return; }
    var restore = busy(button), peer = null, sent = false, finished = false, timer, closedTimer;
    function finish(key, error) {
      if (finished) return;
      finished = true; clearTimeout(timer); clearInterval(closedTimer); global.removeEventListener('message', receive);
      if (['saved', 'memory'].includes(key) && prepared === file) prepared = null;
      peer = null; active = null; restore(); status(button, key, error);
    }
    function receive(event) {
      var data = event.data;
      if (event.origin !== url.origin || event.source !== peer || !data || data.channel !== CHANNEL || data.version !== 1 || data.kind !== 'replay' || data.request !== request) return;
      if (data.type === 'ready' && !sent) {
        try {
          // Transfer a copy; keep the original bounded file available for retries.
          var copy = file.bytes.slice().buffer;
          peer.postMessage({channel: CHANNEL, version: 1, kind: 'replay', request: request, type: 'payload', format: 'yrp', filename: file.name, bytes: copy}, url.origin, [copy]);
          sent = true;
        } catch (error) { finish('failed', true); }
      } else if (data.type === 'result' && sent) {
        if (data.status === 'saved') finish('saved');
        else if (data.status === 'memory-only') finish('memory');
        else if (data.status === 'failed') finish('failed', true);
        else if (data.status === 'cancelled') finish('cancelled');
      }
    }
    active = {cancel: function () { finish('cancelled'); }};
    global.addEventListener('message', receive);
    timer = setTimeout(function () { finish('timeout', true); }, 60000);
    // All bytes are already read. Only this second click creates the new tab.
    try { peer = global.open(url.href, '_blank'); } catch (error) { finish('popup', true); return; }
    if (!peer) { finish('popup', true); return; }
    closedTimer = setInterval(function () { if (peer && peer.closed) finish('closed', true); }, 500);
    status(button, 'waiting');
  }
  async function open(button, source, name) {
    if (button.disabled) return;
    if (active) active.cancel();
    if (prepared && prepared.button === button && prepared.name === name) { transfer(prepared); return; }
    if (prepared) { var old = prepared.button; prepared = null; old.textContent = label('open'); status(old, 'cancelled'); }
    var restore = busy(button), controller = new AbortController(), finished = false;
    var timer = setTimeout(function () { controller.abort(); }, 45000);
    active = {cancel: function () { finished = true; controller.abort(); restore(); status(button, 'cancelled'); }};
    status(button, 'loading');
    try {
      if (typeof name !== 'string' || name.length > 240 || !/\.yrp$/i.test(name) || /[\\/\x00-\x1f\x7f]/.test(name)) throw failure('unavailable');
      var url = new URL(source, global.location.href);
      if (url.origin !== global.location.origin || url.pathname !== '/api/public/replay/' + encodeURIComponent(name) || url.search || url.hash) throw failure('failed');
      var bytes = await readFile(await fetch(url.href, {signal: controller.signal}));
      if (finished) return;
      if (bytes.length <= INLINE_BYTES) {
        // Public, bounded content; no second window/background fetch on phones.
        try { global.location.assign(inlineUrl(bytes, name)); return; }
        catch (error) { if (error.replayOpenKey !== 'tooLarge') throw error; }
      }
      prepared = {button: button, bytes: bytes, name: name};
      status(button, 'ready');
    } catch (error) {
      if (!finished) status(button, error.name === 'AbortError' ? 'timeout' : (error.replayOpenKey || 'failed'), true);
    } finally { clearTimeout(timer); controller.abort(); if (!finished) { active = null; restore(); } }
  }
  global.addEventListener('pagehide', function () { if (active) active.cancel(); prepared = null; });
  global.SrvproReplayWeb = {label: label, open: open};
})(window);
