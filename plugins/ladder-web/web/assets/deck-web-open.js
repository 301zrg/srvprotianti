(function (global) {
  'use strict';

  // Public static client; change this one address when its hosting location changes.
  var CLIENT_ENTRY = 'https://black-surf-69e5.1627406938.workers.dev/';
  var CHANNEL = 'srvprotiantiweb:deck-import';
  var MAX_BYTES = 65536;
  var MAX_URL = 4096;
  var TEXT = {
    zh: {open: '点击网页打开', openDeck: '点击网页打开卡组', openMine: '点击网页打开玩家卡组', openOpponent: '点击网页打开对手卡组', loading: '正在打开…', waiting: '正在向网页版传递卡组…', imported: '已在网页版打开卡组。', memory: '已打开临时卡组，请在网页版下载备份。', cancelled: '已取消打开卡组。', failed: '无法打开卡组，请重试或使用原下载按钮。', unavailable: '卡组不可用或无权访问，请刷新查询后重试。', popup: '新标签页被阻止，请允许弹窗后重试，或下载卡组后导入。', timeout: '传递卡组超时，请重试，或下载卡组后导入。', closed: '网页版已关闭，尚未确认导入。', tooLarge: '卡组超过一键打开限制，请下载文件后导入。'},
    ja: {open: 'Webで開く', openDeck: 'Webでデッキを開く', openMine: 'Webでプレイヤーのデッキを開く', openOpponent: 'Webで相手のデッキを開く', loading: '開いています…', waiting: 'Web版へデッキを送信中…', imported: 'Web版でデッキを開きました。', memory: '一時デッキを開きました。Web版でバックアップをダウンロードしてください。', cancelled: 'デッキを開く操作をキャンセルしました。', failed: 'デッキを開けません。再試行するかダウンロードしてください。', unavailable: 'デッキが存在しないかアクセスできません。検索を更新してください。', popup: '新しいタブがブロックされました。ポップアップを許可するかデッキをダウンロードしてください。', timeout: 'デッキの送信がタイムアウトしました。再試行するかダウンロードしてください。', closed: 'Web版が閉じられたため、インポートを確認できませんでした。', tooLarge: 'ワンクリックで開く制限を超えています。ファイルをダウンロードしてインポートしてください。'},
    en: {open: 'Open in web client', openDeck: 'Open deck in web client', openMine: 'Open player deck in web client', openOpponent: 'Open opponent deck in web client', loading: 'Opening…', waiting: 'Sending deck to the web client…', imported: 'Deck opened in the web client.', memory: 'Temporary deck opened. Download a backup in the web client.', cancelled: 'Opening the deck was cancelled.', failed: 'Could not open the deck. Retry or use the download button.', unavailable: 'Deck unavailable or access denied. Refresh the query and retry.', popup: 'New tab blocked. Allow popups and retry, or download and import the deck.', timeout: 'Deck transfer timed out. Retry or download and import the deck.', closed: 'Web client closed before import was confirmed.', tooLarge: 'Deck exceeds the one-click limit. Download the file and import it.'},
    ko: {open: '웹에서 열기', openDeck: '웹에서 덱 열기', openMine: '웹에서 플레이어 덱 열기', openOpponent: '웹에서 상대 덱 열기', loading: '여는 중…', waiting: '웹 클라이언트로 덱 전송 중…', imported: '웹 클라이언트에서 덱을 열었습니다.', memory: '임시 덱을 열었습니다. 웹에서 백업을 다운로드하세요.', cancelled: '덱 열기를 취소했습니다.', failed: '덱을 열 수 없습니다. 다시 시도하거나 다운로드하세요.', unavailable: '덱이 없거나 접근 권한이 없습니다. 조회를 새로고침하세요.', popup: '새 탭이 차단되었습니다. 팝업을 허용하거나 덱을 다운로드해 가져오세요.', timeout: '덱 전송 시간이 초과되었습니다. 다시 시도하거나 다운로드하세요.', closed: '가져오기를 확인하기 전에 웹 클라이언트가 닫혔습니다.', tooLarge: '원클릭 열기 제한을 초과했습니다. 파일을 다운로드해 가져오세요.'}
  };

  function label(key) { return global.SrvproWeb.t(TEXT, key); }
  function failure(key) { return Object.assign(new Error('Deck handoff failed'), {deckOpenKey: key}); }
  function entry() {
    var url = new URL(global.SRVPRO_WEB_CLIENT_URL || CLIENT_ENTRY);
    if (url.protocol !== 'https:' || url.username || url.password) throw failure('failed');
    return url;
  }
  function title(value) { return String(value || '').replace(/[\x00-\x1f\x7f]/g, '').trim().replace(/\.ydk$/i, '').slice(0, 120); }
  function encoded(bytes) {
    if (bytes.length > MAX_BYTES) throw failure('tooLarge');
    return btoa(Array.from(bytes, function (byte) { return String.fromCharCode(byte); }).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function publicUrl(format, bytes, name) {
    var url = entry();
    url.hash = '/import?' + new URLSearchParams({v: '1', kind: 'deck', format: format, data: encoded(bytes), title: title(name)});
    if (url.href.length > MAX_URL) throw failure('tooLarge');
    return url.href;
  }
  function status(button, key, isError) {
    var root = button.parentElement;
    if (!root) return;
    var message = root.querySelector('.deck-open-status');
    if (!message) {
      message = document.createElement('span');
      message.className = 'deck-open-status';
      root.appendChild(message);
    }
    message.setAttribute('role', isError ? 'alert' : 'status');
    message.classList.toggle('deck-open-error', !!isError);
    message.textContent = label(key);
  }
  function busy(button) {
    var old = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = label('loading');
    return function () {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = old;
    };
  }
  async function readYdk(response) {
    if (!response.ok) throw failure('unavailable');
    if (Number(response.headers.get('Content-Length')) > MAX_BYTES) throw failure('tooLarge');
    var bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw failure('unavailable');
    if (bytes.length > MAX_BYTES) throw failure('tooLarge');
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  }
  async function openYdk(button, source, name) {
    if (button.disabled) return;
    var restore = busy(button), controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 20000);
    status(button, 'loading');
    try {
      var url = new URL(source, global.location.href);
      if (url.origin !== global.location.origin) throw failure('failed');
      var text = await readYdk(await fetch(url.href, {signal: controller.signal}));
      // Same-tab navigation keeps file fetching active on mobile, with no popup delay.
      global.location.assign(publicUrl('ydk-utf8-base64url', new TextEncoder().encode(text), name));
    } catch (error) {
      status(button, error.name === 'AbortError' ? 'timeout' : (error.deckOpenKey || 'failed'), true);
    } finally { clearTimeout(timer); restore(); }
  }
  function openBuffer(button, base64, name) {
    if (button.disabled) return;
    try {
      if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_BYTES / 3) * 4) throw failure('tooLarge');
      var bytes = Uint8Array.from(atob(base64), function (character) { return character.charCodeAt(0); });
      global.location.assign(publicUrl('ygopro-update-deck-base64url', bytes, name));
    } catch (error) { status(button, error.deckOpenKey || 'failed', true); }
  }
  function openAuthorized(button, getResponse, name) {
    if (button.disabled) return;
    var url, request;
    try {
      url = entry();
      request = Array.from(crypto.getRandomValues(new Uint8Array(16)), function (n) { return n.toString(16).padStart(2, '0'); }).join('');
      url.hash = '/import?' + new URLSearchParams({v: '1', kind: 'deck', bridge: '1', origin: global.location.origin, request: request});
      if (url.href.length > MAX_URL) throw failure('tooLarge');
    } catch (error) { status(button, error.deckOpenKey || 'failed', true); return; }
    var restore = busy(button), peer = null, input = null, ready = false, sent = false, finished = false;
    var controller = new AbortController(), timer, closedTimer;
    var envelope = {channel: CHANNEL, version: 1, kind: 'deck', request: request};
    function finish(key, isError, closePeer) {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearInterval(closedTimer);
      global.removeEventListener('message', receive);
      controller.abort();
      if (closePeer && peer && !peer.closed) peer.close();
      peer = null; input = null;
      restore(); status(button, key, isError);
    }
    function send() {
      if (finished || sent || !ready || !input) return;
      try {
        peer.postMessage(Object.assign({}, envelope, {type: 'payload', format: 'ydk', text: input, title: title(name)}), url.origin);
        sent = true;
      } catch (error) { finish('failed', true, true); }
    }
    function receive(event) {
      var data = event.data;
      if (event.origin !== url.origin || event.source !== peer || !data || data.channel !== CHANNEL || data.version !== 1 || data.kind !== 'deck' || data.request !== request) return;
      if (data.type === 'ready') { ready = true; send(); }
      else if (data.type === 'result' && sent) {
        if (data.status === 'imported') finish('imported');
        else if (data.status === 'memory-only') finish('memory');
        else if (data.status === 'failed') finish('failed', true);
        else if (data.status === 'cancelled') finish('cancelled');
      }
    }
    global.addEventListener('message', receive);
    timer = setTimeout(function () { finish('timeout', true, !sent); }, 45000);
    // Must run synchronously inside the click handler, before any awaited fetch.
    try { peer = global.open(url.href, '_blank'); }
    catch (error) { finish('popup', true); return; }
    if (!peer) { finish('popup', true); return; }
    closedTimer = setInterval(function () { if (peer && peer.closed) finish('closed', true); }, 500);
    status(button, 'waiting');
    Promise.resolve().then(function () { return getResponse(controller.signal); }).then(readYdk).then(function (text) {
      if (finished) return;
      input = text; send();
    }).catch(function (error) {
      if (!finished) finish(error.name === 'AbortError' ? 'timeout' : (error.deckOpenKey || 'failed'), true, !sent);
    });
  }

  global.SrvproDeckWeb = {label: label, openYdk: openYdk, openBuffer: openBuffer, openAuthorized: openAuthorized};
})(window);
