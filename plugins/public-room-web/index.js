'use strict';

const {seatedWaitingPlayers} = require('../../room-lifecycle');

function roomType(room) {
  if (room.random_type) {
    switch (room.random_type) {
      case 'TT': return 'ladder_match';
      case 'S': return 'random_single';
      case 'M': return 'random_match';
      case 'T': return 'random_tag';
      default: return 'random_other';
    }
  }
  if (room.windbot) return 'ai_battle';
  if (room.arena) return 'arena_room';
  if (room.challonge_info) return 'tournament_room';
  switch (room.hostinfo?.mode) {
    case 0: return 'single_room';
    case 1: return 'match_room';
    case 2: return 'tag_room';
    default: return 'unknown_room';
  }
}

module.exports.init = api => {
  api.hook('http_request', (request, response, url) => {
    if (request.method !== 'GET' || url.pathname !== api.config.endpoint) return false;
    const beginStage = global.ygopro.constants.DUEL_STAGE.BEGIN;
    const sidingStage = global.ygopro.constants.DUEL_STAGE.SIDING;
    const rooms = [];
    for (const room of global.ROOM_all || []) {
      if (!room || !room.established || room.deleted || room.deleting) continue;
      if (room.random_type && room.duel_stage === beginStage && seatedWaitingPlayers(room).length === 0) continue;
      const type = roomType(room);
      rooms.push({
        roomid: String(room.process_pid),
        roomname: String(room.name).split('$', 1)[0],
        roommode: room.hostinfo.mode,
        roomtype: type,
        randommode: type === 'random_other' ? String(room.random_type) : null,
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
        istart: room.duel_stage === beginStage ? 'wait' :
          `Duel:${Number(room.duel_count) || 0} ${room.duel_stage === sidingStage ? 'Siding' : `Turn:${Number(room.turn) || 0}`}`
      });
    }
    response.writeHead(200, {'Content-Type': 'application/json; charset=utf-8'});
    response.end(JSON.stringify({rooms}));
    return true;
  });
};
