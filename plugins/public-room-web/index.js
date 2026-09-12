'use strict';

module.exports.init = api => {
  api.hook('http_request', (request, response, url) => {
    if (request.method !== 'GET' || url.pathname !== api.config.endpoint) return false;
    const beginStage = global.ygopro.constants.DUEL_STAGE.BEGIN;
    const rooms = [];
    for (const room of global.ROOM_all || []) {
      if (!room || !room.established) continue;
      rooms.push({
        roomid: String(room.process_pid),
        roomname: String(room.name).split('$', 1)[0],
        roommode: room.hostinfo.mode,
        needpass: String(room.name.includes('$')),
        users: (room.players || []).filter(player => player?.pos != null).sort((a, b) => a.pos - b.pos).map(player => ({
          id: '-1',
          name: typeof room.getMaskedPlayerName === 'function' ? room.getMaskedPlayerName(player) : player.name,
          ip: null,
          status: api.config.showPlayerStatus && room.duel_stage !== beginStage && player.pos !== 7 ? {
            score: room.scores[player.name_vpass],
            lp: player.lp ?? room.hostinfo.start_lp,
            cards: room.hostinfo.mode !== 2 ? (player.card_count ?? room.hostinfo.start_hand) : null
          } : null,
          pos: player.pos
        })),
        istart: room.duel_stage === beginStage ? 'wait' : 'start'
      });
    }
    response.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
    response.end(JSON.stringify({rooms}));
    return true;
  });
};
