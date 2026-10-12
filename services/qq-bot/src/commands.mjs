const cardViews = {怪兽: 'monster', 魔法: 'spell', 陷阱: 'trap', 额外: 'extra', 副卡: 'side'};
export function parseQqCommand(content) {
  const cleaned = String(content || '').replace(/<@!?[^>]+>/g, '').replace(/^@\S+\s*/, '').trim();
  for (const [pattern, name] of [[/^房间$/, 'rooms'], [/^状态$/, 'status'], [/^玩法$/, 'play'],
    [/^帮助$/, 'help'], [/^(排行|排行榜)$/, 'top']]) if (pattern.test(cleaned)) return {name};
  const player = /^战绩\s+(.+)$/.exec(cleaned);
  if (player) return {name: 'player', id: player[1].trim()};
  const report = /^(月报|卡组|卡片)(?:\s+(.*))?$/.exec(cleaned);
  if (!report) return null;
  const args = (report[2] || '').split(/\s+/).filter(Boolean);
  const category = report[1] === '卡片' ? args.shift() : undefined;
  const view = report[1] === '卡片' ? (Object.hasOwn(cardViews, category) ? cardViews[category] : undefined) : report[1] === '卡组' ? 'decks' : 'report';
  const month = args.shift();
  if (!view || args.length || month !== undefined && !/^[1-9]\d{3}-?\d{2}$/.test(month)) return {name: 'meta', invalid: true};
  return {name: 'meta', month, view};
}
