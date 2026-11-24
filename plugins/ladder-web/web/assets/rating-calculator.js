(function (global) {
  'use strict';

  var TEXT = {
    zh: {
      openButton: '等级分计算器',
      title: '等级分计算器',
      close: '关闭',
      playerA: '玩家 A 昵称',
      playerB: '玩家 B 昵称',
      placeholderA: '输入玩家 A 昵称',
      placeholderB: '输入玩家 B 昵称',
      calculate: '计算',
      loading: '正在查询玩家数据…',
      emptyInput: '请输入双方玩家昵称。',
      fetchError: '查询失败，请稍后重试。',
      notFoundBadge: '未找到账号，按新账号初始分（{initial} 分）计算',
      totalLabel: '总分',
      monthLabel: '当月分',
      combinedLabel: '综合分',
      winTitle: '{name} 赢',
      fixedNotice: '当前为固定计分模式，每场胜负加减固定为 {fixed} 分。',
      samePlayer: '两边填的是同一个账号，请输入两位不同的玩家。',
      invalidPlayer: '昵称无效（不能为空，最长 64 个字符）。',
      floorNote: '分数最低为 {floor} 分：{name} 分数不够扣，实际扣分会少于上面显示的数。',
      noRules: '当前无法获取计分规则，请刷新页面后重试。'
    },
    ja: {
      openButton: 'レート計算',
      title: 'レート変動シミュレーター',
      close: '閉じる',
      playerA: 'プレイヤーA',
      playerB: 'プレイヤーB',
      placeholderA: 'プレイヤーAの名前を入力',
      placeholderB: 'プレイヤーBの名前を入力',
      calculate: '計算する',
      loading: 'プレイヤー情報を取得中…',
      emptyInput: '両プレイヤーの名前を入力してください。',
      fetchError: 'データの取得に失敗しました。しばらくしてからもう一度お試しください。',
      notFoundBadge: '未登録のため初期レート（{initial}）で計算',
      totalLabel: '通算',
      monthLabel: '当月',
      combinedLabel: '総合レート',
      winTitle: '{name} の勝利',
      fixedNotice: '現在は固定方式のため、勝敗による変動は一律 {fixed} です。',
      samePlayer: '同じアカウントが入力されています。別々のプレイヤーを入力してください。',
      invalidPlayer: '名前が正しくありません（空欄不可、64文字まで）。',
      floorNote: 'レートは {floor} を下回らないため、{name} の実際の減少は表示より少なくなります。',
      noRules: '計算ルールを取得できませんでした。ページを再読み込みしてください。'
    },
    en: {
      openButton: 'Rating Calculator',
      title: 'Rating Calculator',
      close: 'Close',
      playerA: 'Player A',
      playerB: 'Player B',
      placeholderA: 'Enter Player A nickname',
      placeholderB: 'Enter Player B nickname',
      calculate: 'Calculate',
      loading: 'Looking up players…',
      emptyInput: 'Please enter both player nicknames.',
      fetchError: 'Failed to look up player data. Please try again later.',
      notFoundBadge: 'Not found — using new-account rating ({initial})',
      totalLabel: 'All-time',
      monthLabel: 'Monthly',
      combinedLabel: 'Combined',
      winTitle: '{name} wins',
      fixedNotice: 'Fixed scoring is active: every match awards or deducts {fixed} points.',
      samePlayer: 'Both names point to the same account. Please enter two different players.',
      invalidPlayer: 'Invalid nickname (required, up to 64 characters).',
      floorNote: 'Ratings cannot drop below {floor}, so {name} would actually lose less than shown.',
      noRules: 'Scoring rules are unavailable. Please reload the page and try again.'
    },
    ko: {
      openButton: '점수 계산기',
      title: '점수 변동 계산기',
      close: '닫기',
      playerA: '플레이어 A',
      playerB: '플레이어 B',
      placeholderA: '플레이어 A 닉네임 입력',
      placeholderB: '플레이어 B 닉네임 입력',
      calculate: '계산하기',
      loading: '플레이어 정보를 불러오는 중…',
      emptyInput: '두 플레이어의 닉네임을 모두 입력해 주세요.',
      fetchError: '플레이어 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
      notFoundBadge: '기록 없음 — 신규 계정 초기 점수({initial}점) 적용',
      totalLabel: '통산',
      monthLabel: '당월',
      combinedLabel: '종합 점수',
      winTitle: '{name} 승리',
      fixedNotice: '현재 고정 점수 방식이 적용되어 승패당 {fixed}점씩 변동됩니다.',
      samePlayer: '두 칸에 같은 계정이 입력되었습니다. 서로 다른 플레이어를 입력해 주세요.',
      invalidPlayer: '닉네임이 올바르지 않습니다(필수, 최대 64자).',
      floorNote: '점수는 {floor}점 아래로 내려가지 않으므로 {name}의 실제 감점은 표시된 값보다 적습니다.',
      noRules: '점수 계산 규칙을 불러올 수 없습니다. 페이지를 새로고침해 주세요.'
    }
  };

  // 计算全部在服务端完成（/api/ladder/rating-preview 调用结算用的 rating-formula.js），
  // 这里只做输入整理和显示，不保留公式副本。
  // All math runs server-side with the settlement formula; this file only displays it.
  function sanitizeNickname(value) {
    return String(value || '').split('$', 1)[0].trim();
  }

  function sameAccount(a, b) {
    return sanitizeNickname(a).toLowerCase() === sanitizeNickname(b).toLowerCase();
  }

  // The raw delta is what the Match record stores; the 0 floor can make the
  // real change smaller on either balance, which the page must not hide.
  function hitsFloor(player, delta, after) {
    return after.total !== player.total + delta || after.month !== player.month + delta;
  }

  function formatNumber(value) {
    var num = Number(value);
    if (!Number.isFinite(num)) return '-';
    return Number.isInteger(num) ? String(num) : String(Number(num.toFixed(2)));
  }

  function formatDelta(value) {
    var num = Number(value);
    if (num > 0) return '+' + num;
    if (num < 0) return '\u2212' + Math.abs(num);
    return '0';
  }

  function formatText(template, params) {
    return String(template).replace(/\{(\w+)\}/g, function (_, key) {
      return params && params[key] !== undefined ? String(params[key]) : '';
    });
  }

  var api = {
    TEXT: TEXT,
    sanitizeNickname: sanitizeNickname,
    sameAccount: sameAccount,
    hitsFloor: hitsFloor,
    formatNumber: formatNumber,
    formatDelta: formatDelta
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (!global || typeof global.document === 'undefined') return;

  global.SrvproRatingCalculator = api;

  var document = global.document;
  var dialog = null;
  var lastCalculation = null;
  var requestSeq = 0;

  function currentLang() {
    return global.SrvproWeb && typeof global.SrvproWeb.getLanguage === 'function'
      ? global.SrvproWeb.getLanguage() : 'zh';
  }

  function tr(key, params) {
    var dict = TEXT[currentLang()] || TEXT.zh;
    var raw = dict[key] !== undefined ? dict[key] : (TEXT.zh[key] !== undefined ? TEXT.zh[key] : key);
    return params ? formatText(raw, params) : raw;
  }

  function getRules() {
    return global.SrvproRatingRules && typeof global.SrvproRatingRules.getRules === 'function'
      ? global.SrvproRatingRules.getRules() : null;
  }

  function syncTriggers() {
    var rules = getRules();
    document.querySelectorAll('[data-rating-calc-open]').forEach(function (button) {
      button.textContent = tr('openButton');
      button.hidden = !rules;
    });
  }

  function createEl(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = createEl('dialog', 'rating-calc-dialog');
    dialog.id = 'ratingCalcDialog';
    dialog.setAttribute('aria-labelledby', 'ratingCalcTitle');

    var header = createEl('div', 'rating-calc-header');
    var title = createEl('h2', '');
    title.id = 'ratingCalcTitle';
    var closeBtn = createEl('button', 'rating-calc-close');
    closeBtn.type = 'button';
    closeBtn.dataset.calcClose = '1';
    header.appendChild(title);
    header.appendChild(closeBtn);

    var form = createEl('form', 'rating-calc-form');
    form.setAttribute('novalidate', '');
    var fields = createEl('div', 'rating-calc-fields');

    var labelA = createEl('label', 'rating-calc-field');
    var labelAText = createEl('span', '');
    labelAText.dataset.calcLabel = 'playerA';
    var inputA = createEl('input', '');
    inputA.type = 'text';
    inputA.name = 'playerA';
    inputA.autocomplete = 'off';
    inputA.maxLength = 64;
    labelA.appendChild(labelAText);
    labelA.appendChild(inputA);

    var labelB = createEl('label', 'rating-calc-field');
    var labelBText = createEl('span', '');
    labelBText.dataset.calcLabel = 'playerB';
    var inputB = createEl('input', '');
    inputB.type = 'text';
    inputB.name = 'playerB';
    inputB.autocomplete = 'off';
    inputB.maxLength = 64;
    labelB.appendChild(labelBText);
    labelB.appendChild(inputB);

    fields.appendChild(labelA);
    fields.appendChild(labelB);

    var actions = createEl('div', 'rating-calc-actions');
    var submitBtn = createEl('button', 'rating-calc-submit');
    submitBtn.type = 'submit';
    actions.appendChild(submitBtn);

    form.appendChild(fields);
    form.appendChild(actions);

    var status = createEl('p', 'rating-calc-status');
    status.setAttribute('role', 'status');
    status.hidden = true;

    var result = createEl('div', 'rating-calc-result');
    result.hidden = true;

    dialog.appendChild(header);
    dialog.appendChild(form);
    dialog.appendChild(status);
    dialog.appendChild(result);

    closeBtn.addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) dialog.close();
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      runCalculation();
    });

    document.body.appendChild(dialog);
    renderDialogText();
    return dialog;
  }

  function renderDialogText() {
    if (!dialog) return;
    dialog.querySelector('#ratingCalcTitle').textContent = tr('title');
    dialog.querySelector('[data-calc-close]').textContent = tr('close');
    dialog.querySelector('[data-calc-label="playerA"]').textContent = tr('playerA');
    dialog.querySelector('[data-calc-label="playerB"]').textContent = tr('playerB');
    dialog.querySelector('input[name="playerA"]').placeholder = tr('placeholderA');
    dialog.querySelector('input[name="playerB"]').placeholder = tr('placeholderB');
    dialog.querySelector('.rating-calc-submit').textContent = tr('calculate');
    if (lastCalculation) renderResult(lastCalculation);
  }

  function setStatus(message, isError) {
    var status = dialog.querySelector('.rating-calc-status');
    status.textContent = message || '';
    status.classList.toggle('is-error', !!isError);
    status.hidden = !message;
  }

  function renderPlayerCard(player, rules) {
    var card = createEl('div', 'rating-calc-player');
    card.appendChild(createEl('div', 'rating-calc-player-name', player.name));
    if (!player.found) {
      card.appendChild(createEl('div', 'rating-calc-badge', tr('notFoundBadge', {initial: rules.initialPoints})));
    }
    var metrics = createEl('dl', 'rating-calc-metrics');
    [
      [tr('totalLabel'), formatNumber(player.total)],
      [tr('monthLabel'), formatNumber(player.month)],
      [tr('combinedLabel'), formatNumber(player.combined)]
    ].forEach(function (pair) {
      var item = createEl('div', 'rating-calc-metric');
      item.appendChild(createEl('dt', '', pair[0]));
      item.appendChild(createEl('dd', '', pair[1]));
      metrics.appendChild(item);
    });
    card.appendChild(metrics);
    return card;
  }

  function renderOutcomeRow(players, outcome) {
    var winner = outcome.winnerIndex, loser = 1 - winner;
    var row = createEl('div', 'rating-calc-outcome');
    row.appendChild(createEl('div', 'rating-calc-outcome-title', tr('winTitle', {name: players[winner].name})));
    var deltas = createEl('div', 'rating-calc-outcome-deltas');
    deltas.appendChild(createEl('span', 'rating-calc-delta is-win', players[winner].name + ' ' + formatDelta(outcome.deltas[winner])));
    deltas.appendChild(createEl('span', 'rating-calc-sep', ' / '));
    deltas.appendChild(createEl('span', 'rating-calc-delta is-loss', players[loser].name + ' ' + formatDelta(outcome.deltas[loser])));
    row.appendChild(deltas);
    return row;
  }

  function renderResult(calc) {
    var result = dialog.querySelector('.rating-calc-result');
    result.textContent = '';
    var players = calc.players, rules = calc.rules;
    var grid = createEl('div', 'rating-calc-players');
    players.forEach(function (player) { grid.appendChild(renderPlayerCard(player, rules)); });
    result.appendChild(grid);

    var outcomesWrap = createEl('div', 'rating-calc-outcomes');
    calc.outcomes.forEach(function (outcome) { outcomesWrap.appendChild(renderOutcomeRow(players, outcome)); });
    result.appendChild(outcomesWrap);

    calc.outcomes.forEach(function (outcome) {
      var loser = 1 - outcome.winnerIndex;
      if (hitsFloor(players[loser], outcome.deltas[loser], outcome.after[loser])) {
        result.appendChild(createEl('p', 'rating-calc-note', tr('floorNote', {floor: rules.minimumPoints, name: players[loser].name})));
      }
    });
    if (!rules.useDynamic) {
      result.appendChild(createEl('p', 'rating-calc-note', tr('fixedNotice', {fixed: rules.fixedDelta})));
    }
    result.hidden = false;
  }

  async function fetchPreview(nameA, nameB) {
    var response = await global.fetch('/api/ladder/rating-preview', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({playerA: nameA, playerB: nameB})
    });
    var body = null;
    try { body = await response.json(); } catch (error) { body = null; }
    if (!response.ok) {
      var failure = new Error('HTTP ' + response.status);
      failure.code = body && body.error;
      throw failure;
    }
    return body;
  }

  function hideResult(messageKey) {
    lastCalculation = null;
    dialog.querySelector('.rating-calc-result').hidden = true;
    setStatus(tr(messageKey), true);
  }

  async function runCalculation() {
    if (!getRules()) return hideResult('noRules');
    var nameA = sanitizeNickname(dialog.querySelector('input[name="playerA"]').value);
    var nameB = sanitizeNickname(dialog.querySelector('input[name="playerB"]').value);
    if (!nameA || !nameB) return hideResult('emptyInput');
    if (sameAccount(nameA, nameB)) return hideResult('samePlayer');
    var seq = ++requestSeq;
    var submitBtn = dialog.querySelector('.rating-calc-submit');
    submitBtn.disabled = true;
    setStatus(tr('loading'), false);
    try {
      var preview = await fetchPreview(nameA, nameB);
      if (seq !== requestSeq) return;
      lastCalculation = preview;
      setStatus('', false);
      renderResult(lastCalculation);
    } catch (error) {
      if (seq !== requestSeq) return;
      hideResult(error.code === 'same_player' ? 'samePlayer' : error.code === 'invalid_player' ? 'invalidPlayer' : 'fetchError');
    } finally {
      if (seq === requestSeq) submitBtn.disabled = false;
    }
  }

  function openCalculator() {
    var dlg = ensureDialog();
    renderDialogText();
    if (!dlg.open) dlg.showModal();
    dlg.querySelector('input[name="playerA"]').focus();
  }

  document.addEventListener('click', function (event) {
    var trigger = event.target && event.target.closest ? event.target.closest('[data-rating-calc-open]') : null;
    if (trigger) openCalculator();
  });
  document.addEventListener('srvpro-language-change', function () {
    syncTriggers();
    renderDialogText();
  });
  // Rules changed under an open result: drop it rather than show stale numbers.
  document.addEventListener('srvpro-rating-rules-change', function () {
    syncTriggers();
    if (lastCalculation && dialog) {
      lastCalculation = null;
      dialog.querySelector('.rating-calc-result').hidden = true;
    }
  });

  syncTriggers();
})(typeof window !== 'undefined' ? window : null);
