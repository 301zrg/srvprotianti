import {LANGUAGE_KEYS} from './languages.mjs';
export const CARD_METRICS = ['monster', 'spell', 'trap', 'extra', 'side'];
export const REPORT_LANGUAGES = LANGUAGE_KEYS;
export const metricNames = {
  en: ['Main Deck Monsters', 'Main Deck Spells', 'Main Deck Traps', 'Extra Deck', 'Side Deck'],
  ja: ['メインデッキ：モンスター', 'メインデッキ：魔法', 'メインデッキ：罠', 'エクストラデッキ', 'サイドデッキ'],
  zh: ['主卡怪兽', '主卡魔法', '主卡陷阱', '额外', '副卡'],
  ko: ['메인 덱 몬스터', '메인 덱 마법', '메인 덱 함정', '엑스트라 덱', '사이드 덱']
};
const labels = {
  en: {empty: 'No data for this month.', unavailable: 'The report is temporarily unavailable.', invalid: 'Use a valid YYYY-MM month, not a future month.',
    current: 'In progress', report: 'Monthly Report', full: 'Full data', uses: 'Uses', usage: 'Usage', rate: 'Match win rate', samples: 'samples',
    snapshot: 'Generated', published: 'Published edition', query: 'Query edition', attachment: 'Attachments exceed the server upload limit. Try the decks view or a single card category.', denied: 'This action requires server owner or Administrator permission.', view: 'Choose a view from the suggestions.'},
  ja: {empty: 'この月のデータはありません。', unavailable: '現在、月報を取得できません。', invalid: '未来の月を除き、YYYY-MM 形式で入力してください。',
    current: '集計中', report: '月間統計', full: '詳細', uses: '使用数', usage: '使用率', rate: 'マッチ勝率', samples: 'サンプル',
    snapshot: '生成日時', published: '公開済み版', query: '照会版', attachment: '添付ファイルがアップロード上限を超えています。デッキまたはカード部門を個別に照会してください。', denied: 'この操作にはサーバー所有者または管理者（Administrator）権限が必要です。', view: '候補から表示内容を選んでください。'},
  zh: {empty: '该月暂无数据。', unavailable: '月报暂时不可用。', invalid: '请填写有效的 YYYY-MM 月份，不能查询未来月份。',
    current: '进行中数据', report: '天梯月报', full: '完整数据', uses: '使用次数', usage: '使用率', rate: 'Match 胜率', samples: '样本',
    snapshot: '生成时间', published: '已发布版', query: '查询版', attachment: '附件超过服务器上传限制，请改用卡组查询或单类卡片查询。', denied: '该操作仅限服务器所有者或拥有 Administrator 权限的管理员。', view: '请从候选列表中选择查询类型。'},
  ko: {empty: '해당 월의 데이터가 없습니다.', unavailable: '현재 월간 보고서를 조회할 수 없습니다.', invalid: '미래 월을 제외하고 올바른 YYYY-MM 형식으로 입력하세요.',
    current: '집계 중', report: '월간 통계', full: '전체 통계', uses: '사용 횟수', usage: '사용률', rate: '매치 승률', samples: '표본',
    snapshot: '생성 시각', published: '게시된 버전', query: '조회 버전', attachment: '첨부 파일이 업로드 제한을 초과합니다. 덱 또는 카드 부문을 개별적으로 조회하세요.', denied: '이 작업은 서버 소유자 또는 관리자(Administrator) 권한이 필요합니다.', view: '추천 목록에서 조회 항목을 선택하세요.'}
};
export const languageKey = value => REPORT_LANGUAGES[value] || (labels[value] ? value : 'en');
export const reportLabel = (key, language) => labels[languageKey(language)][key];
export const displayMonth = month => `${month.slice(0, 4)}-${month.slice(4)}`;
export const reportPercent = rate => rate === null ? '—' : `${(rate * 100).toFixed(2)}%`;
export const safeReportText = value => String(value ?? '').replace(/[\r\n\t\x00-\x1f]/g, ' ').replace(/@/g, '＠').slice(0, 256);
export const localizedName = (names, language) => safeReportText(names?.[languageKey(language)] || names?.zh || names?.en || '—');
export function localizedUsageModel(model, language) {
  const url = new URL(model.usageUrl);
  url.searchParams.set('L', languageKey(language));
  return {...model, usageUrl: url.toString()};
}
const markdownName = (names, language) => localizedName(names, language).replace(/[\\*_~`<>\[\]|]/g, '\\$&');

export function formatMonthlyReport(model) {
  const count = model.decks.length;
  const text = `${displayMonth(model.month)} · OCG 1103 Nexus Monthly Report${model.partial ? ' · In progress' : ''}\n\n` +
    `EN · Top ${count} decks by usage with overall and matchup Match win rates; card usage Top 10 for Main Deck monsters, Main Deck spells, Main Deck traps, Extra Deck and Side Deck.\n` +
    `日本語 · デッキ使用率上位${count}種の総合・対戦別マッチ勝率と、メインデッキのモンスター・魔法・罠、エクストラデッキ、サイドデッキ各部門のカード採用率上位10枚。\n` +
    `한국어 · 덱 사용률 상위 ${count}종의 전체 및 상대 덱별 매치 승률과 메인 덱 몬스터·마법·함정, 엑스트라 덱, 사이드 덱 각 부문의 카드 채용률 상위 10장.\n` +
    `中文 · 卡组使用率前${count}及总体、对阵 Match 胜率；主卡怪兽、主卡魔法、主卡陷阱、额外、副卡使用率各前10。\n\n` +
    `Full data / 詳細 / 전체 통계 / 完整数据：${model.usageUrl}`;
  const fewer = CARD_METRICS.filter(metric => model.cards[metric].length < 10);
  const result = text + (fewer.length ? `\nAvailable entries / 実際の件数 / 실제 항목 수 / 实际条数：${fewer.map(m => `${m} ${model.cards[m].length}`).join(', ')}` : '');
  if (result.length > 1800) throw new Error('Monthly report message is too long');
  return result;
}

export function formatReportQuery(model, language, view = 'report') {
  const lang = languageKey(language), s = labels[lang];
  const lines = [`${displayMonth(model.month)} · OCG 1103 Nexus · ${s.report}${model.partial ? ` · ${s.current}` : ''}`];
  if (view === 'decks') {
    lines.push(`${s.usage} | ${s.rate} (${s.samples})`);
    model.decks.forEach((deck, i) => lines.push(`${i + 1}. ${markdownName(deck.names, lang)} | ${reportPercent(deck.usageRate)} | ${reportPercent(deck.overall.rate)} (n=${deck.overall.matches})`));
  } else if (CARD_METRICS.includes(view)) {
    lines.push(metricNames[lang][CARD_METRICS.indexOf(view)]);
    model.cards[view].forEach((card, i) => lines.push(`${i + 1}. ${markdownName(card.names, lang)} | ${reportPercent(card.usageRate)} | ${s.uses}: ${card.deckCount}`));
  } else {
    const top = {en: 'Top', ja: '上位', zh: '前', ko: '상위'}[lang];
    lines.push(`${top} ${model.decks.length} · ${metricNames[lang].join(' / ')}: ${top} 10`);
  }
  lines.push(`${s.snapshot}: ${model.generatedAt}`, `${s.full}: ${model.usageUrl}`);
  return lines.join('\n');
}

// The generated caption contains only plain text and one URL (no emoji or mentions).
// These weights are the official twitter-text v3 code-point ranges, not JS .length.
export function captionWeightedLength(text) {
  return [...text.normalize('NFC').replace(/https?:\/\/\S+/g, ' '.repeat(23))].reduce((sum, char) => {
    const c = char.codePointAt(0);
    return sum + (c <= 0x10ff || c >= 0x2000 && c <= 0x200d || c >= 0x2010 && c <= 0x201f || c >= 0x2032 && c <= 0x2037 ? 1 : 2);
  }, 0);
}

export function reportCaption(model) {
  const text = `OCG 1103 Nexus | ${displayMonth(model.month)} Ladder Report${model.partial ? ' (in progress)' : ''}\n` +
    `Top ${model.decks.length} decks: usage & Match win rates.\n` +
    'Card Top 10: Main Deck monsters, spells, traps; Extra Deck; Side Deck.\n' +
    `${Number(model.month.slice(0, 4))}年${Number(model.month.slice(4))}月 月間統計\n${model.usageUrl}`;
  if (captionWeightedLength(text) > 280) throw new Error('X caption exceeds 280 weighted characters');
  return text;
}

export function reportSummary(model) {
  const lines = [formatMonthlyReport(model), `Generated: ${model.generatedAt}`, `Coverage: ${model.coverage.validCardDecks}/${model.coverage.allDecks}`,
    `Other types: ${reportPercent(model.otherRate)}`, '', formatReportQuery(model, 'en', 'decks')];
  model.decks.forEach(deck => {
    lines.push('', localizedName(deck.names, 'en') + ' -> opponent: wins / Match samples');
    deck.matchups.forEach((cell, i) => lines.push(`${localizedName(model.decks[i].names, 'en')}: ${cell.wins}/${cell.matches} (${reportPercent(cell.rate)})${cell.matches > 0 && cell.matches < 20 ? ' *small sample' : ''}`));
  });
  CARD_METRICS.forEach(metric => lines.push('', formatReportQuery(model, 'en', metric)));
  return lines.join('\n');
}
