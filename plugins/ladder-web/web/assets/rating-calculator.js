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
      noRules: '점수 계산 규칙을 불러올 수 없습니다. 페이지를 새로고침해 주세요.'
    }
  };

  // Must match plugins/ladder-core/index.js calculateDelta exactly.
  // Verified against ladder-core._test.calculateDelta in rating-calculator.test.mjs.
  function calculateDelta(playerPoints, opponentPoints, won, config) {
    if (!config.useDynamic) return won ? Number(config.fixedDelta) : -Number(config.fixedDelta);
    var expected = 1 / (1 + Math.pow(10, (opponentPoints - playerPoints) / 400));
    var raw = Math.round(Number(config.kFactor) * ((won ? 1 : 0) - expected));
    var magnitude = Math.max(Number(config.minDelta), Math.min(Number(config.maxDelta), Math.abs(raw)));
    return won ? magnitude : -magnitude;
  }

  function calculateCombined(totalPoints, monthPoints, config) {
    return Number(config.totalWeight) * Number(totalPoints) + Number(config.monthWeight) * Number(monthPoints);
  }

  function calculateMatchOutcomes(playerA, playerB, config) {
    var combinedA = calculateCombined(playerA.totalPoints, playerA.monthPoints, config);
    var combinedB = calculateCombined(playerB.totalPoints, playerB.monthPoints, config);
    return {
      combinedA: combinedA,
      combinedB: combinedB,
      aWins: {
        aDelta: calculateDelta(combinedA, combinedB, true, config),
        bDelta: calculateDelta(combinedB, combinedA, false, config)
      },
      bWins: {
        aDelta: calculateDelta(combinedA, combinedB, false, config),
        bDelta: calculateDelta(combinedB, combinedA, true, config)
      }
    };
  }

  function sanitizeNickname(value) {
    return String(value || '').split('$', 1)[0].trim();
  }

  function resolvePlayerPoints(response, fallbackName, rules) {
    var initial = Number(rules.initialPoints);
    if (!response || !response.found) {
      return {
        name: fallbackName,
        found: false,
        totalPoints: initial,
        monthPoints: initial
      };
    }
    var summary = response.summary || {};
    var totalPoints = summary.total && Number.isFinite(Number(summary.total.points))
      ? Number(summary.total.points) : initial;
    var monthPoints = summary.month && Number.isFinite(Number(summary.month.points))
      ? Number(summary.month.points) : initial;
    return {
      name: String(response.player || fallbackName),
      found: true,
      totalPoints: totalPoints,
      monthPoints: monthPoints
    };
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
    calculateDelta: calculateDelta,
    calculateCombined: calculateCombined,
    calculateMatchOutcomes: calculateMatchOutcomes,
    sanitizeNickname: sanitizeNickname,
    resolvePlayerPoints: resolvePlayerPoints,
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

  function renderPlayerCard(player, combined, rules) {
    var card = createEl('div', 'rating-calc-player');
    var nameRow = createEl('div', 'rating-calc-player-name', player.name);
    card.appendChild(nameRow);
    if (!player.found) {
      card.appendChild(createEl('div', 'rating-calc-badge', tr('notFoundBadge', {initial: rules.initialPoints})));
    }
    var metrics = createEl('dl', 'rating-calc-metrics');
    [
      [tr('totalLabel'), formatNumber(player.totalPoints)],
      [tr('monthLabel'), formatNumber(player.monthPoints)],
      [tr('combinedLabel'), formatNumber(combined)]
    ].forEach(function (pair) {
      var item = createEl('div', 'rating-calc-metric');
      item.appendChild(createEl('dt', '', pair[0]));
      item.appendChild(createEl('dd', '', pair[1]));
      metrics.appendChild(item);
    });
    card.appendChild(metrics);
    return card;
  }

  function renderOutcomeRow(winnerName, winnerDelta, loserName, loserDelta) {
    var row = createEl('div', 'rating-calc-outcome');
    row.appendChild(createEl('div', 'rating-calc-outcome-title', tr('winTitle', {name: winnerName})));
    var deltas = createEl('div', 'rating-calc-outcome-deltas');

    var winSpan = createEl('span', 'rating-calc-delta is-win');
    winSpan.textContent = winnerName + ' ' + formatDelta(winnerDelta);

    var sep = createEl('span', 'rating-calc-sep', ' / ');

    var loseSpan = createEl('span', 'rating-calc-delta is-loss');
    loseSpan.textContent = loserName + ' ' + formatDelta(loserDelta);

    deltas.appendChild(winSpan);
    deltas.appendChild(sep);
    deltas.appendChild(loseSpan);
    row.appendChild(deltas);
    return row;
  }

  function renderResult(calc) {
    var result = dialog.querySelector('.rating-calc-result');
    result.textContent = '';

    var playersGrid = createEl('div', 'rating-calc-players');
    playersGrid.appendChild(renderPlayerCard(calc.playerA, calc.outcomes.combinedA, calc.rules));
    playersGrid.appendChild(renderPlayerCard(calc.playerB, calc.outcomes.combinedB, calc.rules));
    result.appendChild(playersGrid);

    var outcomesWrap = createEl('div', 'rating-calc-outcomes');
    outcomesWrap.appendChild(renderOutcomeRow(calc.playerA.name, calc.outcomes.aWins.aDelta, calc.playerB.name, calc.outcomes.aWins.bDelta));
    outcomesWrap.appendChild(renderOutcomeRow(calc.playerB.name, calc.outcomes.bWins.bDelta, calc.playerA.name, calc.outcomes.bWins.aDelta));
    result.appendChild(outcomesWrap);

    if (!calc.rules.useDynamic) {
      result.appendChild(createEl('p', 'rating-calc-note', tr('fixedNotice', {fixed: calc.rules.fixedDelta})));
    }
    result.hidden = false;
  }

  async function fetchPlayer(nickname) {
    var response = await global.fetch('/api/ladder/player', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({player: nickname})
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }

  async function runCalculation() {
    var rules = getRules();
    var resultEl = dialog.querySelector('.rating-calc-result');
    if (!rules) {
      lastCalculation = null;
      resultEl.hidden = true;
      setStatus(tr('noRules'), true);
      return;
    }
    var nameA = sanitizeNickname(dialog.querySelector('input[name="playerA"]').value);
    var nameB = sanitizeNickname(dialog.querySelector('input[name="playerB"]').value);
    if (!nameA || !nameB) {
      lastCalculation = null;
      resultEl.hidden = true;
      setStatus(tr('emptyInput'), true);
      return;
    }
    var seq = ++requestSeq;
    var submitBtn = dialog.querySelector('.rating-calc-submit');
    submitBtn.disabled = true;
    setStatus(tr('loading'), false);
    try {
      var responses = await Promise.all([fetchPlayer(nameA), fetchPlayer(nameB)]);
      if (seq !== requestSeq) return;
      var playerA = resolvePlayerPoints(responses[0], nameA, rules);
      var playerB = resolvePlayerPoints(responses[1], nameB, rules);
      var outcomes = calculateMatchOutcomes(playerA, playerB, rules);
      lastCalculation = {playerA: playerA, playerB: playerB, outcomes: outcomes, rules: rules};
      setStatus('', false);
      renderResult(lastCalculation);
    } catch (error) {
      if (seq !== requestSeq) return;
      lastCalculation = null;
      resultEl.hidden = true;
      setStatus(tr('fetchError'), true);
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
  document.addEventListener('srvpro-rating-rules-change', function () {
    syncTriggers();
    if (lastCalculation && getRules()) {
      lastCalculation.rules = getRules();
      lastCalculation.outcomes = calculateMatchOutcomes(lastCalculation.playerA, lastCalculation.playerB, lastCalculation.rules);
      renderResult(lastCalculation);
    }
  });

  syncTriggers();
})(typeof window !== 'undefined' ? window : null);
