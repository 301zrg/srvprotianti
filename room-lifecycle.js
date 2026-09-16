'use strict';

function activeWaitingPlayers(room) {
  return (room?.players || []).filter(player => player && !player.isClosed && (player.pos == null || Number(player.pos) < 4));
}

function seatedWaitingPlayers(room) {
  return activeWaitingPlayers(room).filter(player => Number.isInteger(Number(player.pos)) && Number(player.pos) >= 0 && Number(player.pos) < 4);
}

function isEmptyWaitingRoom(room, beginStage) {
  return !!room && !room.deleted && !room.deleting && room.duel_stage === beginStage && activeWaitingPlayers(room).length === 0;
}

function shouldReapEmptyWaitingRoom(room, nowMs, timeoutMs, beginStage) {
  if (!isEmptyWaitingRoom(room, beginStage)) {
    if (room) room.empty_waiting_since = null;
    return false;
  }
  const now = Number(nowMs);
  const timeout = Math.max(1, Number(timeoutMs) || 0);
  if (room.empty_waiting_since == null || !Number.isFinite(Number(room.empty_waiting_since))) {
    room.empty_waiting_since = now;
    return false;
  }
  return now - Number(room.empty_waiting_since) >= timeout;
}

function reconnectTimeoutAction(players, disconnects) {
  const activePlayers = (players || []).filter(player => player && !player.isClosed && Number(player.pos) < 4);
  if (activePlayers.length) return 'forfeit';
  if ((disconnects || []).some(info => info && !info.expired)) return 'wait';
  return 'neutral';
}

module.exports = {
  activeWaitingPlayers,
  seatedWaitingPlayers,
  isEmptyWaitingRoom,
  shouldReapEmptyWaitingRoom,
  reconnectTimeoutAction
};
