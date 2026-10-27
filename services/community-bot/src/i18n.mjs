const strings = {
  'zh-cn': {
    waiting: '当前有人正在等待天梯匹配',
    monthly: '本月天梯排行榜前10名',
    total: '总战绩', selectedMonth: '所选月战绩', rank: '排名', points: '等级分', wins: '胜场', losses: '负场', diff: '胜负差', rate: '胜率',
    noRank: '本月暂无天梯记录', noRooms: '当前没有房间', noPlayer: '没有找到该玩家',
    unavailable: '查询暂时不可用', noChart: '最近没有可绘制的积分变化',
    decks: '本月使用卡组', matches: '场',
    helpTitle: '可用指令', helpRooms: '查询当前全部房间', helpPlayer: '查询玩家本月战绩', playerId: '玩家ID'
  },
  'ja-jp': {
    waiting: '現在、ランクマッチで対戦相手を待っているプレイヤーがいます',
    monthly: '今月のランク上位10名',
    total: '通算戦績', selectedMonth: '選択月の戦績', rank: '順位', points: 'レート', wins: '勝', losses: '敗', diff: '勝敗差', rate: '勝率',
    noRank: '今月のランク記録はありません', noRooms: '現在ルームはありません', noPlayer: 'プレイヤーが見つかりません',
    unavailable: '現在、照会できません', noChart: 'グラフに表示できる最近の試合はありません',
    decks: '今月使用したデッキ', matches: '試合',
    helpTitle: '利用できるコマンド', helpRooms: '現在の全ルームを表示', helpPlayer: 'プレイヤーの今月の戦績を表示', playerId: 'プレイヤーID'
  },
  'en-us': {
    waiting: 'A player is currently waiting for a ranked match',
    monthly: 'Top 10 ranked players this month',
    total: 'All-time stats', selectedMonth: 'Selected-month stats', rank: 'Rank', points: 'Points', wins: 'Wins', losses: 'Losses', diff: 'W-L', rate: 'Win rate',
    noRank: 'No ranked results this month', noRooms: 'There are no rooms', noPlayer: 'Player not found',
    unavailable: 'The query is temporarily unavailable', noChart: 'No recent point changes to plot',
    decks: 'Decks used this month', matches: 'matches',
    helpTitle: 'Available commands', helpRooms: 'List all current rooms', helpPlayer: "Show a player's stats for this month", playerId: 'player ID'
  },
  'ko-kr': {
    waiting: '현재 랭크 매칭에서 상대를 기다리는 플레이어가 있습니다',
    monthly: '이번 달 랭크 상위 10명',
    total: '전체 전적', selectedMonth: '선택 월 전적', rank: '순위', points: '점수', wins: '승', losses: '패', diff: '승패차', rate: '승률',
    noRank: '이번 달 랭크 기록이 없습니다', noRooms: '현재 방이 없습니다', noPlayer: '플레이어를 찾을 수 없습니다',
    unavailable: '현재 조회할 수 없습니다', noChart: '그래프로 표시할 최근 점수 변화가 없습니다',
    decks: '이번 달 사용 덱', matches: '경기',
    helpTitle: '사용 가능한 명령어', helpRooms: '현재 모든 방 조회', helpPlayer: '플레이어의 이번 달 전적 조회', playerId: '플레이어 ID'
  }
};

export function message(key, languages) {
  return languages.map(code => strings[code][key]).join(' / ');
}

export function formatWaiting(languages) {
  return message('waiting', languages);
}

export function formatHelp(languages) {
  return languages.map(code => {
    const s = strings[code];
    return `${s.helpTitle}:\n@机器人 房间 — ${s.helpRooms}\n@机器人 战绩 <${s.playerId}> — ${s.helpPlayer}`;
  }).join('\n\n');
}

function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
export function percent(rate) { return `${(number(rate) * 100).toFixed(2)}%`; }
function safeName(value) { return String(value || '').replace(/[\r\n\t]/g, ' ').replace(/@/g, '＠').trim(); }

export function formatMonthly(result, month, languages) {
  const rows = Array.isArray(result?.ladder) ? result.ladder.slice(0, 10) : [];
  if (!rows.length) return `${month}: ${message('noRank', languages)}`;
  const labels = ['points', 'wins', 'losses', 'diff'].map(key => message(key, languages));
  const header = `${month}: ${message('monthly', languages)}\n${labels.join(' | ')}`;
  const entries = rows.map((row, index) => {
    const rank = Number.isFinite(Number(row.rank)) ? Number(row.rank) : index + 1;
    const name = safeName(row.name) || '?';
    return `${rank}. ${name} | ${number(row.duelPoints)} | ${number(row.wins)} | ${number(row.losses)} | ${number(row.diff)}`;
  });
  return [header, ...entries].join('\n');
}

export function formatRooms(rooms, languages) {
  const names = rooms.map(room => String(room.roomname || '').replace(/[\r\n]/g, ' ').trim()).filter(Boolean);
  return names.length ? names.join('\n') : message('noRooms', languages);
}

function formatPlayerLanguage(profile, code) {
  const month = profile.summary?.month || {};
  const total = profile.summary?.total || {};
  const s = strings[code];
  const statLines = (label, stat) => [
    `${label} | ${s.rank}: ${Number.isInteger(stat.rank) ? stat.rank : '—'}`,
    `${s.points}: ${number(stat.points)} | ${s.wins}: ${number(stat.wins)} | ${s.losses}: ${number(stat.losses)}`,
    `${s.diff}: ${number(stat.diff)} | ${s.rate}: ${percent(stat.winRate)}`
  ];
  const rows = [
    `${safeName(profile.player)} (${profile.month})`,
    ...statLines(s.total, total),
    ...statLines(s.selectedMonth, month),
    `${s.decks}:`
  ];
  const decks = Array.isArray(month.decks) ? month.decks : [];
  if (!decks.length) rows.push('—');
  for (const deck of decks) {
    const deckName = deck.names?.[code.slice(0, 2)] || deck.names?.zh || String(deck.deckTypeId);
    rows.push(`${safeName(deckName)} | ${number(deck.matches)} ${s.matches} | ${s.rate}: ${percent(deck.winRate)}`);
  }
  return rows.join('\n');
}

export function formatPlayer(profile, languages) {
  if (!profile?.found) return message('noPlayer', languages);
  return languages.map(code => formatPlayerLanguage(profile, code)).join('\n\n');
}
