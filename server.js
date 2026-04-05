const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = {};

// Health check
app.get('/', (req, res) => {
  res.send('Manfee server is running. Rooms: ' + Object.keys(rooms).length);
});

// Serve socket.io client with no-cache headers
app.get('/sio.js', (req, res) => {
  const sioPath = path.join(__dirname, 'node_modules', 'socket.io', 'client-dist', 'socket.io.min.js');
  if (fs.existsSync(sioPath)) {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(sioPath);
  } else {
    res.redirect('/socket.io/socket.io.js');
  }
});

// ── HELPERS ─────────────────────────────────────────────────────────
function uid() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function newDeck() {
  const suits = ['S', 'H', 'D', 'C'];
  const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push({ r, s });
  return shuffle(deck);
}

const RV = { 2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14 };

function teamOf(seat) {
  return (seat === 0 || seat === 2) ? 0 : 1;
}

function broadcast(code) {
  if (rooms[code]) io.to(code).emit('room_update', rooms[code]);
}

function broadcastLobby() {
  const list = Object.values(rooms)
    .filter(r => r.visibility === 'public' && !r.started)
    .map(r => ({
      code: r.code,
      name: r.name,
      mode: r.mode,
      visibility: r.visibility,
      hostName: r.hostName,
      playerCount: r.seats.filter(Boolean).length
    }));
  io.emit('rooms_list', list);
}

// ── GAME LOGIC ───────────────────────────────────────────────────────
function dealRound(code) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;

  // Advance dealer
  if (g.dealer < 0) {
    g.dealer = Math.floor(Math.random() * 4);
  } else {
    g.dealer = (g.dealer + 1) % 4;
  }
  g.round = (g.round || 0) + 1;
  g.bids = [-1, -1, -1, -1];
  g.teamTarget = [-1, -1];
  g.roundPts = 1;
  g.dealerDecision = 'accept';
  g.tr = [0, 0, 0, 0];
  g.tk = [null, null, null, null];
  g.led = null;
  g.tc = 0;
  g.switched = false;
  g.trump = room.mode === 'kash' ? null : 'S';
  g.phase = 'bid';
  g.firstPlayer = (g.dealer + 1) % 4;
  g.bidOrder = [1, 2, 3, 0].map(o => (g.dealer + o) % 4);
  g.bidIdx = 0;

  // Deal hands
  const deck = newDeck();
  g.hands = [[], [], [], []];
  for (let i = 0; i < deck.length; i++) g.hands[i % 4].push(deck[i]);

  // Notify everyone
  io.to(code).emit('new_round', {
    dealer: g.dealer,
    round: g.round,
    scores: g.scores,
    seatOrder: room.seats.map(s => ({ id: s.id, name: s.name }))
  });

  // Send each player their hand
  room.seats.forEach((seat, seatIdx) => {
    const counts = g.hands.map((h, i) => i === seatIdx ? 0 : h.length);
    io.to(seat.id).emit('deal_hand', {
      hand: g.hands[seatIdx],
      cardCounts: counts
    });
  });

  // Start bidding after short delay
  setTimeout(() => askNextBid(code), 1000);
}

function askNextBid(code) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;

  if (g.bidIdx >= 3) {
    askDealerDecision(code);
    return;
  }

  const seat = g.bidOrder[g.bidIdx];
  const bidsPlaced = [...g.bids];

  // Tell everyone who is bidding
  io.to(code).emit('bid_request', { seat, bidsPlaced, bidOrder: g.bidOrder });
}

function askDealerDecision(code) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;
  const ds = g.dealer;
  const bidsTotal = g.bids.reduce((a, b) => a + (b >= 0 ? b : 0), 0);
  const dealerTeam = teamOf(ds);
  let oppBid = 0;
  [0, 1, 2, 3].forEach(s => {
    if (s !== ds && teamOf(s) !== dealerTeam && g.bids[s] >= 0) oppBid += g.bids[s];
  });
  g._oppBid = oppBid;
  g._bidsTotal = bidsTotal;
  io.to(code).emit('dealer_request', { seat: ds, bidsTotal, oppBid });
}

function applyDealerDecision(code, decision, socketId) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;
  const ds = g.dealer;

  if (room.seats[ds].id !== socketId) return;

  const dealerTeam = teamOf(ds);
  const oppBid = g._oppBid;
  const bidsTotal = g._bidsTotal;
  let dealerNeed, oppNeed, pts;

  if (decision === 'accept') {
    dealerNeed = (13 - bidsTotal) + 1;
    oppNeed = bidsTotal;
    pts = 1;
  } else if (decision === 'sw1') {
    dealerNeed = oppBid + 1;
    oppNeed = 13 - (oppBid + 1);
    pts = 1;
    rotateHands(room, g);
    g.switched = true;
  } else {
    dealerNeed = oppBid + 2;
    oppNeed = 13 - (oppBid + 2);
    pts = 2;
    rotateHands(room, g);
    g.switched = true;
  }

  g.teamTarget = dealerTeam === 0 ? [dealerNeed, oppNeed] : [oppNeed, dealerNeed];
  g.roundPts = pts;
  g.dealerDecision = decision;

  io.to(code).emit('dealer_decided', {
    seat: ds, decision, teamTargets: g.teamTarget, roundPts: pts
  });

  if (g.switched) {
    g.switchReady = new Set();
    room.seats.forEach((seat, idx) => {
      io.to(seat.id).emit('switch_hands', { newHand: g.hands[idx] });
    });
  } else {
    startPlay(code);
  }
}

function rotateHands(room, g) {
  const old = g.hands.map(h => [...h]);
  g.hands[1] = old[0];
  g.hands[2] = old[1];
  g.hands[3] = old[2];
  g.hands[0] = old[3];
}

function startPlay(code) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;
  g.phase = 'play';
  g.turn = g.firstPlayer;
  g.tk = [null, null, null, null];
  g.led = null;

  io.to(code).emit('play_start', {
    firstPlayer: g.firstPlayer,
    teamTargets: g.teamTarget,
    roundPts: g.roundPts
  });

  setTimeout(() => askPlay(code), 500);
}

function askPlay(code) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;
  const seat = g.turn;
  io.to(room.seats[seat].id).emit('your_turn', { seat, led: g.led });
}

function resolvePlay(code) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;

  const led = g.led;
  let best = null, bs = -1;
  for (let i = 0; i < 4; i++) {
    const c = g.tk[i];
    if (!c) continue;
    if (!best) { best = c; bs = i; continue; }
    if (g.trump && c.s === g.trump && best.s !== g.trump) { best = c; bs = i; continue; }
    if (g.trump && best.s === g.trump && c.s !== g.trump) continue;
    if (c.s === led && (best.s !== led || RV[c.r] > RV[best.r])) { best = c; bs = i; }
  }

  const winner = bs;
  g.tr[winner]++;
  g.tc++;
  g.tk = [null, null, null, null];
  g.led = null;

  io.to(code).emit('trick_result', {
    winner, trickCounts: [...g.tr], nextTurn: winner
  });

  if (g.tc >= 13) {
    setTimeout(() => endRound(code), 1000);
  } else {
    g.turn = winner;
    setTimeout(() => askPlay(code), 1200);
  }
}

function endRound(code) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;

  const us = g.tr.filter((_, i) => teamOf(i) === 0).reduce((a, b) => a + b, 0);
  const them = g.tr.filter((_, i) => teamOf(i) === 1).reduce((a, b) => a + b, 0);
  const ut = g.teamTarget[0], tt = g.teamTarget[1];
  let p0 = 0, p1 = 0, det = '';
  const pts = g.roundPts;

  if (room.mode === 'manfee') {
    const usHit = us >= ut, themHit = them >= tt;
    if (usHit && themHit)     { p0=0; p1=0; det=`Tie 0-0\nUs:${us}/${ut} · Them:${them}/${tt}`; }
    else if (usHit && !themHit) { p0=pts; p1=0; det=`Team A +${pts} pt${pts>1?'s':''} (${us}/${ut})\nTeam B missed (${them}/${tt})`; }
    else if (!usHit && themHit) { p0=0; p1=pts; det=`Team B +${pts} pt${pts>1?'s':''} (${them}/${tt})\nTeam A missed (${us}/${ut})`; }
    else                       { p0=0; p1=0; det=`Both missed 0-0\nUs:${us}/${ut} · Them:${them}/${tt}`; }
  } else {
    p0 = us; p1 = them;
    det = `Team A: ${us} tricks · Team B: ${them} tricks`;
  }

  const mode = g.switched ? `[Switch ${pts===2?'+2':'+1'}]\n` : '[Accept]\n';
  det = mode + det;
  g.scores[0] += p0;
  g.scores[1] += p1;

  const WIN = 52;
  const gameOver = g.scores[0] >= WIN || g.scores[1] >= WIN;
  const winner = g.scores[0] >= g.scores[1] ? 'Team A' : 'Team B';

  io.to(code).emit('round_result', {
    scores: [...g.scores],
    pts: [p0, p1],
    detail: det,
    gameOver,
    winner: gameOver ? winner : null
  });
}

// ── SOCKET EVENTS ────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Connected:', socket.id);

  socket.on('list_rooms', () => {
    socket.emit('rooms_list', Object.values(rooms)
      .filter(r => r.visibility === 'public' && !r.started)
      .map(r => ({
        code: r.code, name: r.name, mode: r.mode,
        visibility: r.visibility, hostName: r.hostName,
        playerCount: r.seats.filter(Boolean).length
      }))
    );
  });

  socket.on('create_room', ({ name, mode, visibility, hostName }) => {
    const code = uid();
    rooms[code] = {
      code, name, mode, visibility,
      host: socket.id, hostName,
      seats: [null, null, null, null],
      spectators: [],
      started: false,
      game: { round: 0, scores: [0, 0], dealer: -1 }
    };
    socket.join(code);
    socket.data.name = hostName;
    socket.data.room = code;
    rooms[code].seats[0] = { id: socket.id, name: hostName };
    socket.emit('room_created', { code });
    socket.emit('joined_room', { room: rooms[code] });
    broadcast(code);
    broadcastLobby();
    console.log('Room created:', code, 'by', hostName);
  });

  socket.on('join_room', ({ code, playerName }) => {
    const c = (code || '').toUpperCase().trim();
    const room = rooms[c];
    if (!room) { socket.emit('error_msg', 'Room "' + c + '" not found'); return; }
    if (room.started) { socket.emit('error_msg', 'Game already started'); return; }
    socket.join(c);
    socket.data.name = playerName;
    socket.data.room = c;
    const alreadyIn = room.seats.some(s => s && s.id === socket.id) ||
                      room.spectators.some(s => s.id === socket.id);
    if (!alreadyIn) room.spectators.push({ id: socket.id, name: playerName });
    socket.emit('joined_room', { room });
    broadcast(c);
    broadcastLobby();
    console.log(playerName, 'joined room', c);
  });

  socket.on('take_seat', ({ code, seat }) => {
    const c = (code || '').toUpperCase().trim();
    const room = rooms[c];
    if (!room) { socket.emit('error_msg', 'Room not found'); return; }
    const seatNum = parseInt(seat);
    if (isNaN(seatNum) || seatNum < 0 || seatNum > 3) { socket.emit('error_msg', 'Bad seat'); return; }
    if (room.seats[seatNum] && room.seats[seatNum].id !== socket.id) {
      socket.emit('error_msg', 'Seat ' + (seatNum + 1) + ' is taken');
      return;
    }
    // Remove from current position
    room.seats = room.seats.map(s => (s && s.id === socket.id) ? null : s);
    room.spectators = room.spectators.filter(s => s.id !== socket.id);
    // Sit down
    room.seats[seatNum] = { id: socket.id, name: socket.data.name || 'Player' };
    console.log(socket.data.name, 'took seat', seatNum, 'in room', c);
    broadcast(c);
    broadcastLobby();
  });

  socket.on('leave_seat', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    room.seats = room.seats.map(s => (s && s.id === socket.id) ? null : s);
    if (!room.spectators.some(s => s.id === socket.id)) {
      room.spectators.push({ id: socket.id, name: socket.data.name || 'Player' });
    }
    broadcast(code);
    broadcastLobby();
  });

  socket.on('kick_seat', ({ code, seat }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    const p = room.seats[seat];
    if (p) {
      room.seats[seat] = null;
      room.spectators.push(p);
      io.to(p.id).emit('kicked_to_spectator');
      broadcast(code);
      broadcastLobby();
    }
  });

  socket.on('move_spec_to_seat', ({ code, playerId, seat }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    const seatNum = parseInt(seat);
    if (isNaN(seatNum) || seatNum < 0 || seatNum > 3) return;
    if (room.seats[seatNum]) { socket.emit('error_msg', 'Seat ' + (seatNum+1) + ' is already taken'); return; }
    // Remove from spectators
    const specIdx = room.spectators.findIndex(s => s.id === playerId);
    if (specIdx < 0) { socket.emit('error_msg', 'Player not found in spectators'); return; }
    const player = room.spectators.splice(specIdx, 1)[0];
    // Also remove from any other seat (safety check)
    room.seats = room.seats.map(s => (s && s.id === playerId) ? null : s);
    // Place in seat
    room.seats[seatNum] = { id: player.id, name: player.name };
    console.log('Host moved', player.name, 'to seat', seatNum);
    io.to(player.id).emit('moved_to_seat', { seat: seatNum });
    broadcast(code);
    broadcastLobby();
  });

  socket.on('start_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    if (room.seats.filter(Boolean).length < 4) {
      socket.emit('error_msg', 'Need 4 players seated to start');
      return;
    }
    room.started = true;
    room.game = { round: 0, scores: [0, 0], dealer: -1 };
    broadcastLobby();
    io.to(code).emit('game_start', {
      room,
      seatOrder: room.seats.map(s => ({ id: s.id, name: s.name }))
    });
    setTimeout(() => dealRound(code), 800);
  });

  socket.on('ready_to_bid', ({ code }) => {
    // Any player confirming the dealer announce triggers bidding start
    // Only process once (from first player who clicks OK)
    const room = rooms[code];
    if (!room || room.game.phase !== 'bid') return;
    if (!room.game._bidStarted) {
      room.game._bidStarted = true;
      askNextBid(code);
    }
  });

  socket.on('place_bid', ({ code, bid }) => {
    const room = rooms[code];
    if (!room) return;
    const g = room.game;
    const seat = room.seats.findIndex(s => s && s.id === socket.id);
    if (seat < 0) return;
    g.bids[seat] = parseInt(bid);
    io.to(code).emit('bid_placed', { seat, bid: g.bids[seat] });
    g.bidIdx++;
    if (g.bidIdx < 3) {
      askNextBid(code);
    } else {
      askDealerDecision(code);
    }
  });

  socket.on('dealer_decision', ({ code, decision }) => {
    applyDealerDecision(code, decision, socket.id);
  });

  socket.on('ready_to_play', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    const g = room.game;
    if (!g.switchReady) return;
    g.switchReady.add(socket.id);
    if (g.switchReady.size >= 4) startPlay(code);
  });

  socket.on('play_card', ({ code, card }) => {
    const room = rooms[code];
    if (!room) return;
    const g = room.game;
    const seat = room.seats.findIndex(s => s && s.id === socket.id);
    if (seat < 0 || seat !== g.turn) return;

    // Remove card from hand
    g.hands[seat] = g.hands[seat].filter(c => !(c.r === card.r && c.s === card.s));
    if (!g.led) g.led = card.s;
    g.tk[seat] = card;

    const counts = g.hands.map(h => h.length);
    const allPlayed = g.tk.every(c => c !== null);
    const nextTurn = allPlayed ? -1 : (g.turn + 1) % 4;

    io.to(code).emit('card_played', { seat, card, led: g.led, nextTurn, cardCounts: counts });

    if (allPlayed) {
      setTimeout(() => resolvePlay(code), 900);
    } else {
      g.turn = nextTurn;
      askPlay(code);
    }
  });

  socket.on('next_round', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.game._bidStarted = false;
    dealRound(code);
  });

  socket.on('restart_game', ({ code }) => {
    const room = rooms[code];
    if (!room || room.host !== socket.id) return;
    room.game = { round: 0, scores: [0, 0], dealer: -1 };
    room.started = false;
    setTimeout(() => {
      room.started = true;
      room.game._bidStarted = false;
      dealRound(code);
    }, 300);
  });

  socket.on('chat_msg', ({ code, msg }) => {
    const room = rooms[code];
    if (!room) return;
    const name = socket.data.name || 'Player';
    const clean = String(msg).slice(0, 80).replace(/</g, '&lt;');
    socket.to(code).emit('chat_msg', { name, msg: clean });
  });

  // ── WebRTC Voice Signaling ──
  // Relay offer/answer/ICE between peers in the same room
  socket.on('voice_offer', ({ code, to, offer }) => {
    // 'to' is target socket id, relay the offer with sender's id
    socket.to(to).emit('voice_offer', { from: socket.id, offer });
  });

  socket.on('voice_answer', ({ code, to, answer }) => {
    socket.to(to).emit('voice_answer', { from: socket.id, answer });
  });

  socket.on('voice_ice', ({ code, to, candidate }) => {
    socket.to(to).emit('voice_ice', { from: socket.id, candidate });
  });

  // When someone joins a room, tell existing members to initiate calls to the new peer
  socket.on('voice_join', ({ code }) => {
    const room = rooms[code];
    if (!room) return;
    // Tell everyone else in room that a new peer joined (they should initiate offer)
    socket.to(code).emit('voice_peer_joined', { peerId: socket.id });
    // Tell the new peer who's already in the room
    const members = [...(room.seats.filter(Boolean).map(s => s.id)),
                     ...room.spectators.map(s => s.id)]
                    .filter(id => id !== socket.id);
    socket.emit('voice_existing_peers', { peerIds: members });
  });

  socket.on('voice_leave', ({ code }) => {
    socket.to(code).emit('voice_peer_left', { peerId: socket.id });
  });

  socket.on('leave_room', ({ code }) => {
    handleLeave(socket, code);
  });

  socket.on('disconnect', () => {
    handleLeave(socket, socket.data.room);
    console.log('Disconnected:', socket.data.name || socket.id);
  });
});

function handleLeave(socket, code) {
  if (!code || !rooms[code]) return;
  const room = rooms[code];
  room.seats = room.seats.map(s => (s && s.id === socket.id) ? null : s);
  room.spectators = room.spectators.filter(s => s.id !== socket.id);
  socket.leave(code);
  if (room.host === socket.id && !room.started) {
    io.to(code).emit('room_closed', 'Host left the room');
    delete rooms[code];
  } else {
    io.to(code).emit('player_left', { name: socket.data.name || 'A player' });
    broadcast(code);
  }
  broadcastLobby();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Manfee server running on port', PORT);
});
