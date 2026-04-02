// manfee-server/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms = {}; // roomCode → room object

function uid() {
  return Math.random().toString(36).slice(2,8).toUpperCase();
}

io.on('connection', socket => {
  console.log('Player connected:', socket.id);

  socket.on('create_room', ({ name, mode, visibility, hostName }) => {
    const code = uid();
    rooms[code] = {
      code, name, mode, visibility, host: socket.id,
      seats: [null, null, null, null],
      spectators: [],
      started: false
    };
 socket.join(code);
    rooms[code].seats[0] = { id: socket.id, name: hostName };
    socket.emit('room_created', { code });
    io.to(code).emit('room_update', rooms[code]);
  });

  socket.on('join_room', ({ code, playerName }) => {
    const room = rooms[code];
    if (!room) { socket.emit('error', 'Room not found'); return; }
    socket.join(code);
    socket.data.room = code;
    if (!room.spectators.find(s => s.id === socket.id))
      room.spectators.push({ id: socket.id, name: playerName });
    io.to(code).emit('room_update', room);
  });

  socket.on('take_seat', ({ code, seat }) => {
    const room = rooms[code];
    if (!room || room.seats[seat]) return;
    // Remove from wherever they currently are
    room.seats = room.seats.map(s => s?.id === socket.id ? null : s);
    room.spectators = room.spectators.filter(s => s.id !== socket.id);
    room.seats[seat] = { id: socket.id, name: socket.data.name };
    io.to(code).emit('room_update', room);
  });
 socket.on('kick_to_spec', ({ code, seat }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    const p = room.seats[seat];
    if (p) { room.spectators.push(p); room.seats[seat] = null; }
    io.to(code).emit('room_update', room);
  });

  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    if (room.seats.filter(Boolean).length < 4) return;
    room.started = true;
    io.to(code).emit('game_start', { room });
  });

  socket.on('place_bid', ({ code, bid }) => {
    io.to(code).emit('bid_placed', { id: socket.id, bid });
  });

  socket.on('play_card', ({ code, card }) => {
    io.to(code).emit('card_played', { id: socket.id, card });
  });
socket.on('dealer_decision', ({ code, decision }) => {
    io.to(code).emit('dealer_decided', { id: socket.id, decision });
  });

  socket.on('disconnect', () => {
    // Clean up all rooms this player was in
    Object.values(rooms).forEach(room => {
      room.seats = room.seats.map(s => s?.id === socket.id ? null : s);
      room.spectators = room.spectators.filter(s => s.id !== socket.id);
      io.to(room.code).emit('room_update', room);
    });
  });
});

server.listen(3000, () => console.log('Manfee server running on port 3000'));