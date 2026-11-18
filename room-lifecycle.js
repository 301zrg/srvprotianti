'use strict';

function activeWaitingPlayers(room) {
  return (room?.players || []).filter(player => player && !player.isClosed && (player.pos == null || Number(player.pos) < 4));
}

function seatedWaitingPlayers(room) {
  return activeWaitingPlayers(room).filter(player => Number.isInteger(Number(player.pos)) && Number(player.pos) >= 0 && Number(player.pos) < 4);
}

// Same rule as ladder-core account keys: names differing only in case or
// surrounding spaces are one account.
function normalizePlayerName(name) {
  return String(name || '').trim().toLowerCase();
}

// A live waiting player (seated or still awaiting a seat) with this name. A
// stale connection of the same account must not attract its owner's next join.
function hasWaitingNamesake(room, name, except) {
  const key = normalizePlayerName(name);
  return !!key && activeWaitingPlayers(room).some(player => player !== except && normalizePlayerName(player.name) === key);
}

// A started match that has not ended. Rooms whose match already finished but
// are still settling or being deleted are not counted.
function isLiveMatch(room, beginStage) {
  return !!room && !room.deleted && !room.deleting && room.duel_stage !== beginStage && !room.match_completed && !room.finished;
}

// Duelling seats count even while disconnected: a player inside a reconnect
// window still owns that match.
function findLiveMatchForName(rooms, randomType, name, beginStage, except) {
  const key = normalizePlayerName(name);
  if (!key) return null;
  for (const room of rooms || []) {
    if (!room || room === except || room.random_type !== randomType || !isLiveMatch(room, beginStage)) continue;
    if ((room.players || []).some(player => player && Number(player.pos) < 4 && normalizePlayerName(player.name) === key)) return room;
  }
  return null;
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

function reconnectRegistrationRejection({enabled, room, client, hasExistingDisconnect, isPlayer, beginStage, autoSurrenderAfterDisconnect, disconnectedCount}) {
  if (!enabled) return 'disabled';
  if (!room) return 'room_missing';
  if (client.system_kicked) return 'system_kicked';
  // flee_free waives the leaving penalty after an opponent warning. It must not
  // remove the player's reconnect window if their connection drops.
  if (hasExistingDisconnect) return 'existing_disconnect';
  if (client.is_post_watcher) return 'post_watcher';
  if (!isPlayer) return 'not_player';
  if (room.duel_stage === beginStage) return 'room_not_started';
  if (room.windbot) return 'windbot';
  if (autoSurrenderAfterDisconnect && room.hostinfo.mode !== 1) return 'auto_surrender';
  if (room.random_type && !room.policy_overrides?.allowConcurrentReconnects && disconnectedCount > 1) {
    return 'concurrent_disconnect';
  }
  return null;
}

module.exports = {
  activeWaitingPlayers,
  seatedWaitingPlayers,
  normalizePlayerName,
  hasWaitingNamesake,
  isLiveMatch,
  findLiveMatchForName,
  isEmptyWaitingRoom,
  shouldReapEmptyWaitingRoom,
  reconnectTimeoutAction,
  reconnectRegistrationRejection
};
