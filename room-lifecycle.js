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
  isEmptyWaitingRoom,
  shouldReapEmptyWaitingRoom,
  reconnectTimeoutAction,
  reconnectRegistrationRejection
};
