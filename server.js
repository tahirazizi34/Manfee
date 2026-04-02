const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// roomCode -> room object
const rooms = {};

function uid() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function broadcast(code) {
  if (rooms[code]) io.to(code).emit('room_update', rooms[code]);
}

// Health check so Railway knows the server is alive
app.get('/', (req, res) => res.send('Manfee server is running'));

io.on('connection', socket => {
  console.log('Connected:', socket.id);

  // ── CREATE ROOM ──────────────────────────────────────────
  socket.on('create_room', ({ name, mode, visibility, hostName }) => {
    const code = uid();
    rooms[code] = {
      code,
      name,
      mode,
      visibility,
      host: socket.id,
      hostName,
      seats: [null, null, null, null],  // seats 0-3
      spectators: [],
      started: false,
      gameState: null
    };

    socket.join(code);
    socket.data.name = hostName;
    socket.data.room = code;

    // Host auto-sits in seat 0
    rooms[code].seats[0] = { id: socket.id, name: hostName };

    socket.emit('room_created', { code });
    broadcast(code);
    console.log(`Room ${code} created by ${hostName}`);
  });

  // ── JOIN ROOM ─────────────────────────────────────────────
  socket.on('join_room', ({ code, playerName }) => {
    const room = rooms[code];
    if (!room) {
      socket.emit('error_msg', 'Room not found. Check the code and try again.');
      return;
    }
    if (room.started) {
      socket.emit('error_msg', 'This game has already started.');
      return;
    }

    socket.join(code);
    socket.data.name = playerName;
    socket.data.room = code;

    // Add to spectators if not already seated
    const alreadySeated = room.seats.some(s => s && s.id === socket.id);
    const alreadySpec = room.spectators.some(s => s.id === socket.id);
    if (!alreadySeated && !alreadySpec) {
      room.spectators.push({ id: socket.id, name: playerName });
    }

    socket.emit('joined_room', { room });
    broadcast(code);
    console.log(`${playerName} joined room ${code}`);
  });

  // ── TAKE SEAT ─────────────────────────────────────────────
  socket.on('take_seat', ({ code, seat }) => {
    const room = rooms[code];
    if (!room) return;
    if (room.seats[seat]) {
      socket.emit('error_msg', 'That seat is already taken.');
      return;
    }

    // Remove player from wherever they currently are
    room.seats = room.seats.map(s => (s && s.id === socket.id) ? null : s);
    room.spectators = room.spectators.filter(s => s.id !== socket.id);

    room.seats[seat] = { id: socket.id, name: socket.data.name };
    broadcast(code);
  });

  // ── LEAVE SEAT (go to spectators) ────────────────────────
  socket.on('leave_seat', ({ code }) => {
    const room = rooms[code];
    if (!room) return;

    room.seats = room.seats.map(s => (s && s.id === socket.id) ? null : s);
    if (!room.spectators.some(s => s.id === socket.id)) {
      room.spectators.push({ id: socket.id, name: socket.data.name });
    }
    broadcast(code);
  });

  // ── KICK PLAYER TO SPECTATOR (host only) ─────────────────
  socket.on('kick_seat', ({ code, seat }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;

    const player = room.seats[seat];
    if (player) {
      room.seats[seat] = null;
      if (!room.spectators.some(s => s.id === player.id)) {
        room.spectators.push(player);
      }
      io.to(player.id).emit('kicked_to_spectator');
      broadcast(code);
    }
  });

  // ── MOVE PLAYER BETWEEN SEATS (host only) ────────────────
  socket.on('move_seat', ({ code, from, to }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    if (room.seats[to]) return; // destination occupied

    const player = room.seats[from];
    if (player) {
      room.seats[to] = player;
      room.seats[from] = null;
      broadcast(code);
    }
  });

  // ── KICK SPECTATOR (host only) ───────────────────────────
  socket.on('kick_spectator', ({ code, playerId }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.spectators = room.spectators.filter(s => s.id !== playerId);
    io.to(playerId).emit('kicked_from_room');
    broadcast(code);
  });

  // ── START GAME (host only) ───────────────────────────────
  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;

    const seated = room.seats.filter(Boolean);
    if (seated.length < 4) {
      socket.emit('error_msg', 'Need 4 players seated to start.');
      return;
    }

    room.started = true;

    // Build initial game state — the frontend handles actual game logic
    // Just tell everyone the seat order so they know who is who
    io.to(code).emit('game_start', {
      room,
      seatOrder: room.seats.map(s => ({ id: s.id, name: s.name }))
    });
    console.log(`Game started in room ${code}`);
  });

  // ── GAME EVENTS (relay to all players in room) ───────────

  // Bidding
  socket.on('place_bid', ({ code, bid }) => {
    const room = rooms[code];
    if (!room) return;
    const seat = room.seats.findIndex(s => s && s.id === socket.id);
    io.to(code).emit('bid_placed', { playerId: socket.id, seat, bid });
  });

  // Dealer decision: 'accept', 'sw1', or 'sw2'
  socket.on('dealer_decision', ({ code, decision }) => {
    const room = rooms[code];
    if (!room) return;
    io.to(code).emit('dealer_decided', { playerId: socket.id, decision });
  });

  // Play a card
  socket.on('play_card', ({ code, card }) => {
    const room = rooms[code];
    if (!room) return;
    const seat = room.seats.findIndex(s => s && s.id === socket.id);
    io.to(code).emit('card_played', { playerId: socket.id, seat, card });
  });

  // Chat message
  socket.on('chat_msg', ({ code, text }) => {
    const room = rooms[code];
    if (!room) return;
    io.to(code).emit('chat_msg', {
      name: socket.data.name || 'Unknown',
      text,
      ts: Date.now()
    });
  });

  // ── DISCONNECT ────────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.data.room;
    if (!code || !rooms[code]) return;

    const room = rooms[code];
    room.seats = room.seats.map(s => (s && s.id === socket.id) ? null : s);
    room.spectators = room.spectators.filter(s => s.id !== socket.id);

    // If host left and room not started, close the room
    if (room.host === socket.id && !room.started) {
      io.to(code).emit('room_closed', 'The host left the room.');
      delete rooms[code];
    } else {
      io.to(code).emit('player_left', { name: socket.data.name });
      broadcast(code);
    }

    console.log(`${socket.data.name || socket.id} disconnected from ${code}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Manfee server running on port ${PORT}`));
