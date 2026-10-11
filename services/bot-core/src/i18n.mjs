const strings = {
  'zh-cn': {
    waiting: '当前有人正在等待天梯匹配',
    monthly: '本月天梯排行榜前10名',
    total: '总战绩', selectedMonth: '所选月战绩', rank: '排名', points: '等级分', wins: '胜场', losses: '负场', diff: '胜负差', rate: '胜率',
    noRank: '本月暂无天梯记录', noRooms: '当前没有房间', noPlayer: '没有找到该玩家',
    unavailable: '查询暂时不可用', noChart: '最近没有可绘制的积分变化',
    decks: '本月使用卡组', matches: '场',
    helpTitle: '可用指令', helpRooms: '查询当前全部房间', helpPlayer: '查询玩家本月战绩', playerId: '玩家ID',
    helpStatus: '查询当前房间和人数', helpPlay: '查看整合包、桌面助手与连接方法', helpHelp: '显示指令帮助', helpTop: '查询本月排行榜前10',
    statusTitle: '服务器房间状态', statusRooms: '公开房间', statusPlaying: '进行中', statusPlayers: '房间内人数估算',
    statusWaiting: '单人等待天梯房间', statusChecked: '检查时间', statusUnavailable: '暂时无法获取当前房间状态',
    playTitle: 'Windows PC 游玩方法（二选一）', playLegacy: 'ADS Gateball Server 使用的旧版 ADS 客户端已不兼容本服。请改用新版 ADS 客户端或下方 KoishiPro 整合包；桌面助手不会升级游戏本体',
    playDownload: '新玩家：下载并解压 KoishiPro 整合包，已含游戏和本服禁卡表、卡池',
    playDesktop: '已有兼容的 YGOPro／KoishiPro：下载桌面天梯助手 ZIP，解压到 ygopro.exe 同级目录，运行 srvprotianti-desktop.exe；助手本身不含游戏',
    playDesktopSetup: '助手首次使用：退出游戏，在“设置”点“安装／更新 1103 环境”，填联机昵称（天梯为“用户名$专用密码”）；然后从助手中选择匹配、进房或观战',
    playConnect: '不用助手时进入 LAN Mode；如有预设的 Nexus Server 就直接选择，否则手动填写主机', playRegular: '普通房：昵称填用户名，按房间要求填写房间密码',
    playRanked: '天梯：昵称填“用户名$专用密码”，房间密码填 TT；首次连接自动注册',
    playJoin: '点击 Join，不要点击 Host。不要在群聊发送密码，也不要复用其他账号密码', playWeb: '网页版已上线（电脑／手机浏览器，无需安装）：https://ocg1103nexus.com/?lang=zh', playHelp: 'Discord 社群与求助'
  },
  'ja-jp': {
    waiting: '現在、ランクマッチで対戦相手を待っているプレイヤーがいます',
    monthly: '今月のランク上位10名',
    total: '通算戦績', selectedMonth: '選択月の戦績', rank: '順位', points: 'レート', wins: '勝', losses: '敗', diff: '勝敗差', rate: '勝率',
    noRank: '今月のランク記録はありません', noRooms: '現在ルームはありません', noPlayer: 'プレイヤーが見つかりません',
    unavailable: '現在、照会できません', noChart: 'グラフに表示できる最近の試合はありません',
    decks: '今月使用したデッキ', matches: '試合',
    helpTitle: '利用できるコマンド', helpRooms: '現在の全ルームを表示', helpPlayer: 'プレイヤーの今月の戦績を表示', playerId: 'プレイヤーID',
    helpStatus: '現在のルームと人数を表示', helpPlay: 'クライアント、デスクトップ補助ツールと接続方法を表示', helpHelp: 'コマンド一覧を表示', helpTop: '今月のランキング上位10名を表示',
    statusTitle: 'サーバーのルーム状況', statusRooms: '公開ルーム', statusPlaying: '対戦中', statusPlayers: 'ルーム内人数（概算）',
    statusWaiting: '対戦相手を待つランクルーム', statusChecked: '確認時刻', statusUnavailable: '現在のルーム状況を取得できません',
    playTitle: 'Windows PCでの遊び方（どちらかを選択）', playLegacy: 'ADS Gateball Serverで使われていた旧版ADSクライアントは、このサーバーでは利用できません。新しいADSクライアント、または下記のKoishiProパックをご利用ください。補助ツールはゲーム本体を更新しません',
    playDownload: '初めての方：ゲーム本体とサーバー用の制限リスト・カードプールを含むKoishiProパックをダウンロードして展開',
    playDesktop: '対応するYGOPro／KoishiProをお持ちの方：補助ツールのZIPをygopro.exeと同じフォルダーに展開し、srvprotianti-desktop.exeを起動。補助ツールにゲーム本体は含まれません',
    playDesktopSetup: '初回：ゲームを終了し、補助ツールの設定で「1103環境をインストール／更新」を選択。対戦用の名前（ランク戦は「ユーザー名$専用パスワード」）を設定し、補助ツールからマッチング・入室・観戦できます',
    playConnect: '補助ツールを使わない場合：LAN ModeでNexus Serverの項目があれば選択。なければホストを入力', playRegular: '通常ルーム：ニックネームにユーザー名、ルームパスワードは各ルームの案内に従って入力',
    playRanked: 'ランクマッチ：ニックネームは「ユーザー名$専用パスワード」、ルームパスワードはTT。初回接続時に自動登録',
    playJoin: 'HostではなくJoinを押してください。パスワードをチャットに投稿したり、他のアカウントと使い回したりしないでください', playWeb: 'ブラウザ版公開中（PC・スマートフォン、インストール不要）：https://ocg1103nexus.com/?lang=ja', playHelp: 'Discordコミュニティ・サポート'
  },
  'en-us': {
    waiting: 'A player is currently waiting for a ranked match',
    monthly: 'Top 10 ranked players this month',
    total: 'All-time stats', selectedMonth: 'Selected-month stats', rank: 'Rank', points: 'Points', wins: 'Wins', losses: 'Losses', diff: 'W-L', rate: 'Win rate',
    noRank: 'No ranked results this month', noRooms: 'There are no rooms', noPlayer: 'Player not found',
    unavailable: 'The query is temporarily unavailable', noChart: 'No recent point changes to plot',
    decks: 'Decks used this month', matches: 'matches',
    helpTitle: 'Available commands', helpRooms: 'List all current rooms', helpPlayer: "Show a player's stats for this month", playerId: 'player ID',
    helpStatus: 'Show current rooms and estimated occupancy', helpPlay: 'Show client, desktop assistant and connection steps', helpHelp: 'List commands', helpTop: 'Show this month’s top 10',
    statusTitle: 'Server room status', statusRooms: 'Public rooms', statusPlaying: 'In duel', statusPlayers: 'People in rooms (estimate)',
    statusWaiting: 'Ranked rooms waiting for an opponent', statusChecked: 'Checked', statusUnavailable: 'Current room status is unavailable',
    playTitle: 'How to play on Windows PC (choose one path)', playLegacy: 'The old ADS client used for ADS Gateball Server is no longer supported here. Use a current ADS client or the KoishiPro pack below. The desktop assistant does not update the game client',
    playDownload: 'New players: download and extract the KoishiPro pack; it includes the game, this server’s card pool and Forbidden & Limited List',
    playDesktop: 'Already have a compatible YGOPro/KoishiPro: download the desktop assistant ZIP, extract beside ygopro.exe, then run srvprotianti-desktop.exe. The assistant does not include the game',
    playDesktopSetup: 'First use: close the game; in the assistant’s Settings, install/update the 1103 environment and set your game login name (for ranked: “username$dedicated_password”). You can then match, join rooms or spectate from the assistant',
    playConnect: 'Without the assistant: open LAN Mode; select Nexus Server if listed, otherwise enter the host', playRegular: 'Regular room: use your username as nickname and follow the room password instructions',
    playRanked: 'Ranked matchmaking: nickname “username$dedicated_password”, Room Password TT. New usernames are registered on first connection',
    playJoin: 'Click Join, not Host. Never post your password in chat or reuse another account’s password', playWeb: 'Browser client available (desktop/mobile, no installation): https://ocg1103nexus.com/?lang=en', playHelp: 'Discord community and help'
  },
  'ko-kr': {
    waiting: '현재 랭크 매칭에서 상대를 기다리는 플레이어가 있습니다',
    monthly: '이번 달 랭크 상위 10명',
    total: '전체 전적', selectedMonth: '선택 월 전적', rank: '순위', points: '점수', wins: '승', losses: '패', diff: '승패차', rate: '승률',
    noRank: '이번 달 랭크 기록이 없습니다', noRooms: '현재 방이 없습니다', noPlayer: '플레이어를 찾을 수 없습니다',
    unavailable: '현재 조회할 수 없습니다', noChart: '그래프로 표시할 최근 점수 변화가 없습니다',
    decks: '이번 달 사용 덱', matches: '경기',
    helpTitle: '사용 가능한 명령어', helpRooms: '현재 모든 방 조회', helpPlayer: '플레이어의 이번 달 전적 조회', playerId: '플레이어 ID',
    helpStatus: '현재 방과 인원 조회', helpPlay: '게임 패키지·데스크톱 도우미 다운로드 및 접속 안내', helpHelp: '명령어 목록 표시', helpTop: '이번 달 상위 10명 조회',
    statusTitle: '서버 방 현황', statusRooms: '공개 방', statusPlaying: '대전 중', statusPlayers: '방에 있는 인원(추정)',
    statusWaiting: '상대를 기다리는 랭크 방', statusChecked: '확인 시각', statusUnavailable: '현재 방 현황을 가져올 수 없습니다',
    playTitle: 'Windows PC에서 플레이하는 방법(두 가지 중 선택)', playLegacy: 'ADS Gateball Server에서 사용하던 구형 ADS 클라이언트는 이 서버에서 지원되지 않습니다. 최신 ADS 클라이언트 또는 아래 KoishiPro 패키지를 사용하세요. 데스크톱 도우미는 게임 클라이언트를 업데이트하지 않습니다',
    playDownload: '처음 시작하는 분: 게임 본체와 서버 금지·제한 목록 및 카드 풀이 포함된 KoishiPro 패키지를 다운로드하고 압축 해제',
    playDesktop: '호환되는 YGOPro/KoishiPro가 이미 있는 분: 도우미 ZIP을 ygopro.exe와 같은 폴더에 압축 해제한 뒤 srvprotianti-desktop.exe를 실행하세요. 도우미에 게임 본체는 포함되지 않습니다',
    playDesktopSetup: '처음 사용할 때 게임을 종료하고 도우미 설정에서 1103 환경 설치/업데이트를 누르세요. 접속 이름(랭크전은 “사용자명$전용_비밀번호”)을 설정하면 도우미에서 매칭, 입장, 관전을 할 수 있습니다',
    playConnect: '도우미 없이 접속할 때: LAN Mode에서 Nexus Server 항목이 있으면 선택하고, 없으면 호스트 입력', playRegular: '일반 방: 닉네임에 사용자명을 입력하고 해당 방의 비밀번호 안내를 따르세요',
    playRanked: '랭크 매칭: 닉네임은 “사용자명$전용_비밀번호”, 방 비밀번호는 TT. 새 사용자명은 첫 접속 시 자동 등록',
    playJoin: 'Host가 아니라 Join을 누르세요. 비밀번호를 채팅에 올리거나 다른 계정의 비밀번호를 재사용하지 마세요', playWeb: '웹 버전 이용 가능(PC·모바일, 설치 불필요): https://ocg1103nexus.com/?lang=ko', playHelp: 'Discord 커뮤니티 및 문의'
  }
};

export function message(key, languages) {
  return languages.map(code => strings[code][key]).join(' / ');
}

export function formatWaiting(languages) {
  return message('waiting', languages);
}

export function formatHelp(languages, platform = 'qq') {
  return languages.map(code => {
    const s = strings[code];
    const prefix = platform === 'discord' ? '/' : '@机器人 ';
    const player = platform === 'discord' ? `player id:<${s.playerId}>` : `战绩 <${s.playerId}>`;
    const commands = platform === 'discord' ? ['rooms', player, 'status', 'play', 'help', 'top'] :
      ['房间', player, '状态', '玩法', '帮助', '排行'];
    return `${s.helpTitle}:\n${prefix}${commands[0]} — ${s.helpRooms}\n${prefix}${commands[1]} — ${s.helpPlayer}\n` +
      `${prefix}${commands[2]} — ${s.helpStatus}\n${prefix}${commands[3]} — ${s.helpPlay}\n` +
      `${prefix}${commands[4]} — ${s.helpHelp}\n${prefix}${commands[5]} — ${s.helpTop}` +
      (platform === 'discord' ? '\n/meta [month:YYYY-MM] [view] [language] — ' + ({'zh-cn': '卡组使用率、Match 胜率、五类卡片使用率及发推素材', 'ja-jp': 'デッキ使用率・マッチ勝率・5部門のカード採用率・X素材', 'ko-kr': '덱 사용률·매치 승률·5개 부문 카드 채용률·X 자료', 'en-us': 'Deck usage, Match win rates, five card zones and X assets'}[code]) : '');
  }).join('\n\n');
}

export function formatStatus(status, languages) {
  return languages.map(code => {
    const s = strings[code];
    const checked = status.checkedAt ? new Date(status.checkedAt).toISOString() : '—';
    if (!status.available) return `${s.statusTitle}: ${s.statusUnavailable}\n${s.statusChecked}: ${checked}`;
    return `${s.statusTitle}\n${s.statusRooms}: ${status.rooms} | ${s.statusPlaying}: ${status.playing}\n` +
      `${s.statusPlayers}: ${status.players} | ${s.statusWaiting}: ${status.waiting}\n${s.statusChecked}: ${checked}`;
  }).join('\n\n');
}

export function formatPlay(guide, languages) {
  return languages.map(code => {
    const s = strings[code];
    return `${s.playTitle}\n${s.playLegacy}\nA. ${s.playDownload}: ${guide.clientDownloadUrl}\n` +
      `B. ${s.playDesktop}: ${guide.desktopDownloadUrl}\n${s.playDesktopSetup}\n` +
      `${s.playConnect}: ${guide.gameHost}:${guide.gamePort}\n` +
      `${s.playRegular}\n${s.playRanked}\n${s.playJoin}\n` +
      `${guide.introUrl}\n${s.playHelp}: ${guide.discordInviteUrl}\n${s.playWeb}`;
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

export function formatWinStreak(row) {
  const name = safeName(row.player), streak = number(row.streak), points = number(row.points);
  const wins = number(row.wins), diff = number(row.diff), rate = percent(row.winRate);
  return [
    `${name}玩家当前${streak}连胜！本月等级分${points}、胜场${wins}、胜负差${diff}、胜率${rate}。`,
    `Player ${name} is currently on a ${streak}-match winning streak! This month: rating ${points}, wins ${wins}, win-loss difference ${diff}, win rate ${rate}.`,
    `${name}選手は現在${streak}連勝中！今月のレート${points}、勝利数${wins}、勝敗差${diff}、勝率${rate}。`,
    `${name} 플레이어는 현재 ${streak}연승 중입니다! 이번 달 레이팅 ${points}, 승리 ${wins}, 승패차 ${diff}, 승률 ${rate}.`
  ].join('\n\n');
}
