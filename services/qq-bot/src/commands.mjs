const views = {report: 'report', 月报: 'report', decks: 'decks', 卡组: 'decks', monster: 'monster', 怪兽: 'monster',
  spell: 'spell', 魔法: 'spell', trap: 'trap', 陷阱: 'trap', extra: 'extra', 额外: 'extra', side: 'side', 副卡: 'side'};
export function parseQqCommand(content) {
  const cleaned = String(content || '').replace(/<@!?[^>]+>/g, '').replace(/^@\S+\s*/, '').trim();
  for (const [pattern, name] of [[/^(房间|\/rooms)$/i, 'rooms'], [/^(状态|\/status)$/i, 'status'], [/^(玩法|\/play)$/i, 'play'],
    [/^(帮助|\/help)$/i, 'help'], [/^(排行|排行榜|\/top)$/i, 'top']]) if (pattern.test(cleaned)) return {name};
  const player = /^(?:战绩|\/player)\s+(.+)$/i.exec(cleaned);
  if (player) return {name: 'player', id: player[1].trim()};
  const report = /^(月报|卡组|卡片|\/meta)(?:\s+(.*))?$/i.exec(cleaned);
  if (!report) return null;
  let month, view = report[1] === '卡组' ? 'decks' : 'report', hasView = false;
  for (const value of (report[2] || '').split(/\s+/).filter(Boolean)) {
    const token = value.replace(/^(month|view):/i, '').toLowerCase();
    if (/^[1-9]\d{3}-?\d{2}$/.test(token) && month === undefined && !/^view:/i.test(value)) month = token;
    else if (views[token] && !hasView && !/^month:/i.test(value)) { view = views[token]; hasView = true; }
    else return {name: 'meta', invalid: true};
  }
  if (report[1] === '卡片' && !['monster', 'spell', 'trap', 'extra', 'side'].includes(view)) return {name: 'meta', invalid: true};
  return {name: 'meta', month, view};
}
