// One ordered language selection is shared by QQ text, data names and figures.
export const LANGUAGE_KEYS = {'zh-cn': 'zh', 'en-us': 'en', 'ja-jp': 'ja', 'ko-kr': 'ko'};
export function languageKeys(languages) {
  if (!Array.isArray(languages) || !languages.length) throw new Error('Languages are required');
  const keys = languages.map(code => LANGUAGE_KEYS[code] || (Object.values(LANGUAGE_KEYS).includes(code) ? code : null));
  if (keys.some(key => !key) || new Set(keys).size !== keys.length) throw new Error('Invalid languages');
  return keys;
}
export const joinLanguages = (languages, format) => languageKeys(languages).map(format).join('\n');
export const imageCopy = {
  zh: {rating: '最近比赛积分变化', match: '比赛序号（0 = 首场之前）', decks: '卡组使用率与对阵胜率', cards: '卡片使用率',
    usage: '使用率', uses: '使用次数', overall: '总体胜率', deck: '卡组', samples: '样本', empty: '暂无数据', current: '进行中数据',
    matrix: '行是己方卡组，列是对手；每格显示 Match 胜率与样本数。* 表示样本少于20；— 表示无样本。请打开原图放大查看。',
    shares: '前列卡组 / 其他 / 其余已识别卡组占比', coverage: '有效卡片样本 / 全部参赛卡组样本', generated: '生成时间', full: '完整数据',
    deckNote: '卡组使用率分母包含“其他”；总体胜率包含矩阵外的全部对手。样本不是独立玩家数或实体比赛场数。',
    cardNote: '使用率 = 含该卡的卡组数 / 有效卡片样本数；副卡为第一局初始配置，不代表实际换入频率。'},
  en: {rating: 'Rating over recent matches', match: 'Match (0 = before first)', decks: 'Deck Usage & Matchups', cards: 'Card Inclusion Rates',
    usage: 'Usage', uses: 'Uses', overall: 'Overall', deck: 'Deck', samples: 'samples', empty: 'No data', current: 'In progress',
    matrix: 'Rows = deck played; columns = opponent. Match win rate and player-view samples. * n < 20; — no samples. Open the original to zoom.',
    shares: 'Top decks / Other / Remaining identified share', coverage: 'Valid card-data / all player-view deck samples', generated: 'Generated', full: 'Full data',
    deckNote: 'Usage includes Other in its denominator. Overall includes every opponent outside this matrix. Samples are not unique players or physical Matches.',
    cardNote: 'Rate = decks containing this card / valid card-data samples. Side Deck = Game 1 initial configuration, not siding frequency.'},
  ja: {rating: '最近の試合のレート推移', match: '試合番号（0 = 最初の試合前）', decks: 'デッキ使用率・対戦別マッチ勝率', cards: 'カード採用率',
    usage: '使用率', uses: '使用数', overall: '総合勝率', deck: 'デッキ', samples: 'サンプル', empty: 'データなし', current: '集計中',
    matrix: '行は使用デッキ、列は対戦相手。各セルはマッチ勝率とサンプル数。* は20未満、— はサンプルなし。原画像を拡大してください。',
    shares: '上位デッキ / その他 / 残りの分類済みデッキの割合', coverage: '有効カードデータ / 全参戦デッキサンプル', generated: '生成日時', full: '詳細',
    deckNote: '使用率の分母は「その他」を含みます。総合勝率は表外の相手も含みます。サンプル数は固有の人数や実際のマッチ数ではありません。',
    cardNote: '採用率 = このカードを含むデッキ数 / 有効カードデータ数。サイドデッキは第1ゲーム開始時の構成で、投入頻度ではありません。'},
  ko: {rating: '최근 경기의 레이팅 변화', match: '경기 번호 (0 = 첫 경기 전)', decks: '덱 사용률 및 상대별 매치 승률', cards: '카드 채용률',
    usage: '사용률', uses: '사용 횟수', overall: '전체 승률', deck: '덱', samples: '표본', empty: '데이터 없음', current: '집계 중',
    matrix: '행은 사용 덱, 열은 상대 덱입니다. 각 칸은 매치 승률과 표본 수입니다. * 는20 미만, — 는 표본 없음. 원본을 확대하세요.',
    shares: '상위 덱 / 기타 / 나머지 분류된 덱의 비율', coverage: '유효 카드 데이터 / 전체 참가 덱 표본', generated: '생성 시각', full: '전체 통계',
    deckNote: '사용률 분모는 기타를 포함합니다. 전체 승률은 표 밖의 모든 상대를 포함합니다. 표본은 고유 플레이어나 실제 매치 수가 아닙니다.',
    cardNote: '채용률 = 해당 카드가 포함된 덱 수 / 유효 카드 표본. 사이드 덱은 첫 게임 초기 구성으로 실제 교체 빈도가 아닙니다.'}
};
