WebSocketServer = require('ws').Server
url = require('url')
settings = global.settings
RoomLifecycle = require './room-lifecycle.js'

server = null
announced_waiting_rooms = new Set()

visible_waiting_room = (room)->
  return false if !room or room.deleted or room.deleting
  return true unless room.random_type
  return RoomLifecycle.seatedWaitingPlayers(room).length > 0

room_data = (room)->
  id: room.name,
  title: room.title || room.name,
  user: {username: room.username}
  users: ({username: client.name, position: client.pos} for client in room.players),
  options: room.get_roomlist_hostinfo(), # Should be updated when MyCard client updates
  arena: settings.modules.arena_mode.enabled && room.arena && settings.modules.arena_mode.mode

clients = new Set()

init = (http_server, ROOM_all)->
  server = new WebSocketServer
    server: http_server

  server.on 'connection', (connection, upgradeReq) ->
    connection.filter = url.parse(upgradeReq.url, true).query.filter || 'waiting'
    connection.send JSON.stringify
      event: 'init'
      data: room_data(room) for room in ROOM_all when room and room.established and !room.deleted and !room.deleting and (connection.filter == 'started' or (!room.private and visible_waiting_room(room))) and ((room.duel_stage != 0) == (connection.filter == 'started'))
    clients.add connection
    connection.on('close', () -> clients.delete connection if clients.has connection)

create = (room)->
  return if room.private or !visible_waiting_room(room)
  announced_waiting_rooms.add room
  broadcast('create', room_data(room), 'waiting')

update = (room)->
  return if room.private
  if !visible_waiting_room(room)
    if announced_waiting_rooms.delete(room)
      broadcast('delete', room.name, 'waiting')
    return
  event = if announced_waiting_rooms.has(room) then 'update' else 'create'
  announced_waiting_rooms.add room
  broadcast(event, room_data(room), 'waiting')

start = (room)->
  announced_waiting_rooms.delete room
  broadcast('delete', room.name, 'waiting') if !room.private
  broadcast('create', room_data(room), 'started')

_delete = (room)->
  announced_waiting_rooms.delete room
  if(room.duel_stage != 0)
    broadcast('delete', room.name, 'started')
  else
    broadcast('delete', room.name, 'waiting') if !room.private

broadcast = (event, data, filter)->
  return if !server
  message = JSON.stringify
    event: event
    data: data
  for connection in Array.from(clients.values()) when connection.filter == filter
    try
      connection.send message

module.exports =
  init: init
  create: create
  update: update
  start: start
  delete: _delete
