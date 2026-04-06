const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ── DATABASE (in-memory + file backup) ───────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'users.json');

// In-memory store - survives within process, file backup for restarts
let _memDB = null;

function loadDB() {
  if (_memDB) return _memDB; // Use memory if available
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(DB_PATH)) {
      _memDB = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } else {
      _memDB = { users: [] };
    }
  } catch(e) {
    _memDB = { users: [] };
  }
  return _memDB;
}

function saveDB(db) {
  _memDB = db; // Always update memory
  try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); } catch(e) {}
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'tteka_salt_2024').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── CREDIT SYSTEM ────────────────────────────────────────────────────
// Credits awarded per round based on performance
const CREDITS = {
  WIN_ROUND: 15,         // team won the round
  LOSS_ROUND: -5,        // team lost the round
  HIT_TARGET: 10,        // hit your bid target exactly
  PERFECT_BID: 20,       // bid exactly right and won every trick you bid
  WIN_GAME: 50,          // won the whole game
  LOSS_GAME: -10,        // lost the whole game
  PLAYED_ROUND: 5,       // just for playing a round
  TRICK_BONUS: 2,        // per trick above your target
};

function getLevel(credits) {
  if (credits >= 2000) return { level: 10, title: 'Grand Master', color: '#ff4444' };
  if (credits >= 1500) return { level: 9,  title: 'Master',       color: '#ff6600' };
  if (credits >= 1100) return { level: 8,  title: 'Expert',       color: '#ffaa00' };
  if (credits >= 800)  return { level: 7,  title: 'Advanced',     color: '#aacc00' };
  if (credits >= 550)  return { level: 6,  title: 'Skilled',      color: '#44cc44' };
  if (credits >= 350)  return { level: 5,  title: 'Experienced',  color: '#00ccaa' };
  if (credits >= 200)  return { level: 4,  title: 'Intermediate', color: '#00aaff' };
  if (credits >= 130)  return { level: 3,  title: 'Learner',      color: '#6688ff' };
  if (credits >= 100)  return { level: 2,  title: 'Beginner',     color: '#aaaaff' };
  return               { level: 1,  title: 'Newcomer',    color: '#888888' };
}

// ── AUTH REST API ─────────────────────────────────────────────────────
// POST /api/signup
app.post('/api/signup', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, error: 'Username and password required' });
  if (username.length < 2 || username.length > 20) return res.json({ ok: false, error: 'Username must be 2-20 characters' });
  if (password.length < 8) return res.json({ ok: false, error: 'Password must be at least 8 characters' });
  const clean = username.trim().replace(/[^a-zA-Z0-9_\- ]/g, '');
  if (clean.length < 2) return res.json({ ok: false, error: 'Invalid username characters' });

  const db = loadDB();
  const exists = db.users.find(u => u.username.toLowerCase() === clean.toLowerCase());
  if (exists) return res.json({ ok: false, error: 'Username already taken' });

  const user = {
    id: 'u_' + crypto.randomBytes(8).toString('hex'),
    username: clean,
    password: hashPassword(password),
    credits: 100,
    stats: { played: 0, won: 0, lost: 0, roundsPlayed: 0, roundsWon: 0, tricksWon: 0 },
    createdAt: Date.now(),
    token: generateToken()
  };
  db.users.push(user);
  saveDB(db);
  console.log('User signed up:', clean, '| Total users:', db.users.length);
  const { password: _, ...safe } = user;
  const level = getLevel(user.credits);
  res.json({ ok: true, user: { ...safe, level } });
});

// POST /api/login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, error: 'Username and password required' });
  const db = loadDB();
  const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  console.log('Login attempt:', username, '| Found user:', !!user, '| Users in DB:', db.users.length);
  if (!user || user.password !== hashPassword(password)) return res.json({ ok: false, error: 'Wrong username or password' });
  // Refresh token on login
  user.token = generateToken();
  saveDB(db);
  const { password: _, ...safe } = user;
  const level = getLevel(user.credits);
  res.json({ ok: true, user: { ...safe, level } });
});

// POST /api/auth — validate token
app.post('/api/auth', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.json({ ok: false });
  const db = loadDB();
  const user = db.users.find(u => u.token === token);
  if (!user) return res.json({ ok: false, error: 'Session expired. Please log in again.' });
  const { password: _, ...safe } = user;
  const level = getLevel(user.credits);
  res.json({ ok: true, user: { ...safe, level } });
});

// GET /api/leaderboard
app.get('/api/leaderboard', (req, res) => {
  const db = loadDB();
  const board = db.users
    .map(u => ({
      username: u.username,
      credits: u.credits,
      level: getLevel(u.credits),
      stats: u.stats
    }))
    .sort((a, b) => b.credits - a.credits)
    .slice(0, 20);
  res.json({ ok: true, board });
});

// ── CREDIT AWARD HELPER ───────────────────────────────────────────────
function awardCredits(userId, amount, reason) {
  if (!userId || userId.startsWith('ai_')) return null;
  const db = loadDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return null;
  user.credits = Math.max(0, (user.credits || 100) + amount);
  saveDB(db);
  return { credits: user.credits, level: getLevel(user.credits), change: amount, reason };
}

function updateStats(userId, statsUpdate) {
  if (!userId || userId.startsWith('ai_')) return;
  const db = loadDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return;
  Object.keys(statsUpdate).forEach(k => {
    user.stats[k] = (user.stats[k] || 0) + statsUpdate[k];
  });
  saveDB(db);
}

// ── STATIC FILE SERVING ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  const paths = [
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, 'index.html'),
  ];
  const found = paths.find(p => fs.existsSync(p));
  if (found) res.sendFile(found);
  else res.send('T-Teka server is running. Add index.html to deploy the game.');
});

// ── HELPERS ───────────────────────────────────────────────────────────
const rooms = {};

// Pre-load DB on startup
loadDB();

function uid() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

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

function teamOf(seat) { return (seat === 0 || seat === 2) ? 0 : 1; }

function broadcast(code) {
  if (rooms[code]) io.to(code).emit('room_update', rooms[code]);
}

function broadcastLobby() {
  const list = Object.values(rooms)
    .filter(r => r.visibility === 'public' && !r.started)
    .map(r => ({
      code: r.code, name: r.name, mode: r.mode,
      visibility: r.visibility, hostName: r.hostName,
      playerCount: r.seats.filter(Boolean).length
    }));
  io.emit('rooms_list', list);
}

// ── GAME LOGIC ────────────────────────────────────────────────────────
function dealRound(code) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;
  if (g.dealer < 0) g.dealer = Math.floor(Math.random() * 4);
  else g.dealer = (g.dealer + 1) % 4;
  g.round = (g.round || 0) + 1;
  g.bids = [-1, -1, -1, -1];
  g.teamTarget = [-1, -1];
  g.roundPts = 1;
  g.dealerDecision = 'accept';
  g.tr = [0, 0, 0, 0];
  g.tk = [null, null, null, null];
  g.led = null; g.tc = 0; g.switched = false;
  g.trump = room.mode === 'kash' ? null : 'S';
  g.phase = 'bid';
  g.firstPlayer = (g.dealer + 1) % 4;
  g.bidOrder = [1, 2, 3, 0].map(o => (g.dealer + o) % 4);
  g.bidIdx = 0; g.readyCount = 0;
  const deck = newDeck();
  g.hands = [[], [], [], []];
  for (let i = 0; i < deck.length; i++) g.hands[i % 4].push(deck[i]);
  io.to(code).emit('new_round', {
    dealer: g.dealer, round: g.round, scores: g.scores,
    seatOrder: room.seats.map(s => ({ id: s.id, name: s.name, credits: s.credits || 100, level: s.level || getLevel(100) }))
  });
  room.seats.forEach((seat, seatIdx) => {
    if (!seat || seat.id.startsWith('ai_')) return;
    io.to(seat.id).emit('deal_hand', { hand: g.hands[seatIdx], cardCounts: g.hands.map((h, i) => i === seatIdx ? 0 : h.length) });
  });
  // Award participation credits
  room.seats.forEach(seat => {
    if (!seat || seat.id.startsWith('ai_') || !seat.userId) return;
    const result = awardCredits(seat.userId, CREDITS.PLAYED_ROUND, 'Played a round');
    if (result) io.to(seat.id).emit('credits_update', result);
    updateStats(seat.userId, { roundsPlayed: 1 });
  });
  setTimeout(() => askNextBid(code), 1000);
}

function askNextBid(code) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;
  if (g.bidIdx >= 3) { askDealerDecision(code); return; }
  const seat = g.bidOrder[g.bidIdx];
  const player = room.seats[seat];
  if (!player || player.id.startsWith('ai_')) {
    const hand = g.hands[seat];
    const so = g.bids.reduce((a, b) => a + (b >= 0 ? b : 0), 0);
    const spades = hand.filter(c => c.s === 'S').length;
    const high = hand.filter(c => RV[c.r] >= 12).length;
    const maxBid = Math.max(0, 13 - so - (3 - g.bidIdx));
    const bid = Math.max(0, Math.min(maxBid, Math.floor(spades * 0.65 + high * 0.4 + Math.random() * 1.5)));
    g.bids[seat] = bid; g.bidIdx++;
    io.to(code).emit('bid_placed', { seat, bid });
    setTimeout(() => askNextBid(code), 600);
  } else {
    io.to(player.id).emit('bid_request', { seat, bidsPlaced: g.bids });
    io.to(code).emit('bid_request', { seat, bidsPlaced: g.bids });
  }
}

function askDealerDecision(code) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;
  const ds = g.dealer;
  const so = g.bids.reduce((a, b) => a + (b >= 0 ? b : 0), 0);
  const dealerTeam = teamOf(ds);
  let oppBid = 0;
  for (let s = 0; s < 4; s++) if (s !== ds && teamOf(s) !== dealerTeam && g.bids[s] >= 0) oppBid += g.bids[s];
  const player = room.seats[ds];
  if (!player || player.id.startsWith('ai_')) {
    const spades = g.hands[ds].filter(c => c.s === 'S').length;
    const r = Math.random();
    let dec = 'accept';
    if (spades >= oppBid + 2 && r < 0.35) dec = 'sw2';
    else if (spades < (13 - so + 1) * 0.55 && r < 0.4) dec = 'sw1';
    setTimeout(() => applyDealerDecision(code, dec, so, oppBid), 800);
  } else {
    io.to(player.id).emit('dealer_request', { seat: ds, bidsTotal: so, oppBid });
  }
}

function applyDealerDecision(code, decision, so, oppBid) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;
  const ds = g.dealer;
  const dealerTeam = teamOf(ds);
  let dealerNeed, oppNeed, pts = 1;
  if (decision === 'accept') {
    dealerNeed = 13 - so + 1; oppNeed = so;
  } else if (decision === 'sw1') {
    dealerNeed = oppBid + 1; oppNeed = 13 - (oppBid + 1); pts = 1;
    const old = g.hands.map(h => [...h]);
    g.hands[0]=old[3]; g.hands[1]=old[0]; g.hands[2]=old[1]; g.hands[3]=old[2];
    g.switched = true;
  } else {
    dealerNeed = oppBid + 2; oppNeed = 13 - (oppBid + 2); pts = 2;
    const old = g.hands.map(h => [...h]);
    g.hands[0]=old[3]; g.hands[1]=old[0]; g.hands[2]=old[1]; g.hands[3]=old[2];
    g.switched = true;
  }
  g.teamTarget = dealerTeam === 0 ? [dealerNeed, oppNeed] : [oppNeed, dealerNeed];
  g.roundPts = pts;
  g.dealerDecision = decision;
  io.to(code).emit('dealer_decided', { seat: ds, decision, teamTargets: g.teamTarget, roundPts: pts });
  if (g.switched) {
    room.seats.forEach((seat, seatIdx) => {
      if (!seat || seat.id.startsWith('ai_')) return;
      io.to(seat.id).emit('switch_hands', { newHand: g.hands[seatIdx] });
    });
    g.readyCount = 0;
  } else {
    startPlay(code);
  }
}

function startPlay(code) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;
  g.phase = 'play'; g.turn = g.firstPlayer;
  g.tk = [null,null,null,null]; g.led = null; g.tc = 0; g.tr = [0,0,0,0];
  io.to(code).emit('play_start', { firstPlayer: g.firstPlayer, teamTargets: g.teamTarget, roundPts: g.roundPts });
  askPlay(code);
}

function askPlay(code) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;
  const seat = g.turn;
  const player = room.seats[seat];
  if (!player || player.id.startsWith('ai_')) setTimeout(() => aiPlay(code, seat), 700);
  else io.to(player.id).emit('your_turn');
}

function aiPlay(code, seat) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;
  const hand = g.hands[seat];
  const playable = hand.filter(c => canPlay(c, hand, g.led));
  playCard(code, seat, aiPickCard(seat, playable, g));
}

function canPlay(card, hand, led) {
  if (!led) return true;
  return hand.some(c => c.s === led) ? card.s === led : true;
}

function aiPickCard(seat, pl, g) {
  const led = g.led, trump = g.trump, partner = (seat+2)%4;
  const hi = a => a.reduce((x,y) => RV[y.r]>RV[x.r]?y:x);
  const lo = a => a.reduce((x,y) => RV[y.r]<RV[x.r]?y:x);
  function curWin() {
    let best=null,bs=-1;
    for(let i=0;i<4;i++){const c=g.tk[i];if(!c)continue;if(!best){best=c;bs=i;continue;}
    if(trump&&c.s===trump&&best.s!==trump){best=c;bs=i;continue;}
    if(trump&&best.s===trump&&c.s!==trump)continue;
    if(c.s===led&&(best.s!==led||RV[c.r]>RV[best.r])){best=c;bs=i;}}return bs;
  }
  if(!led){const nt=pl.filter(c=>c.s!==trump);return nt.length?hi(nt):hi(pl);}
  const sc=pl.filter(c=>c.s===led);
  if(sc.length)return curWin()===partner?lo(sc):hi(sc);
  if(trump){const tc=pl.filter(c=>c.s===trump);if(tc.length&&curWin()!==partner)return hi(tc);}
  return lo(pl);
}

function playCard(code, seat, card) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;
  const idx = g.hands[seat].findIndex(c => c.r===card.r && c.s===card.s);
  if (idx < 0) return;
  g.hands[seat].splice(idx, 1);
  g.tk[seat] = card;
  if (!g.led) g.led = card.s;
  const nextTurn = (seat+1)%4;
  io.to(code).emit('card_played', { seat, card, led: g.led, nextTurn, cardCounts: g.hands.map(h=>h.length) });
  if (g.tk.every(c => c !== null)) setTimeout(() => resolveTrick(code), 800);
  else { g.turn = nextTurn; askPlay(code); }
}

function resolveTrick(code) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;
  const led = g.led, trump = g.trump;
  let best=null, winner=0;
  for(let i=0;i<4;i++){
    const c=g.tk[i];if(!c)continue;
    if(!best){best=c;winner=i;continue;}
    if(trump&&c.s===trump&&best.s!==trump){best=c;winner=i;continue;}
    if(trump&&best.s===trump&&c.s!==trump)continue;
    if(c.s===led&&(best.s!==led||RV[c.r]>RV[best.r])){best=c;winner=i;}
  }
  g.tr[winner]++; g.tc++;
  g.tk=[null,null,null,null]; g.led=null;
  io.to(code).emit('trick_result', { winner, trickCounts: g.tr, nextTurn: winner });
  // Award trick bonus to winning team members
  [winner, (winner+2)%4].forEach(s => {
    const seat = room.seats[s];
    if (seat && !seat.id.startsWith('ai_') && seat.userId) {
      const result = awardCredits(seat.userId, CREDITS.TRICK_BONUS, 'Won a trick');
      if (result) io.to(seat.id).emit('credits_update', result);
    }
  });
  if (g.tc >= 13) setTimeout(() => endRound(code), 600);
  else { g.turn = winner; askPlay(code); }
}

function endRound(code) {
  const room = rooms[code];
  if (!room) return;
  const g = room.game;
  const us=g.tr[0]+g.tr[2], them=g.tr[1]+g.tr[3];
  const ut=g.teamTarget[0], tt=g.teamTarget[1];
  let p0=0,p1=0,det='';
  const pts=g.roundPts;
  if (room.mode==='manfee'||room.mode==='teka') {
    const uh=us>=ut, th=them>=tt;
    if(uh&&!th){p0=pts;det=`Team A hit target (${us}/${ut}). Team B missed (${them}/${tt}).`;}
    else if(th&&!uh){p1=pts;det=`Team B hit target (${them}/${tt}). Team A missed (${us}/${ut}).`;}
    else if(uh&&th){det='Both teams hit target. No points scored.';}
    else{det='Both teams missed. No points scored.';}
  } else { p0=us;p1=them;det=`Team A: ${us} tricks. Team B: ${them} tricks.`; }
  g.scores[0]+=p0; g.scores[1]+=p1;
  const WIN=52;
  const gameOver=g.scores[0]>=WIN||g.scores[1]>=WIN;
  const winner=g.scores[0]>g.scores[1]?'Team A':'Team B';
  const mode=g.switched?`[Switch ${pts===2?'+2':'+1'}]\n`:'[Accept]\n';
  det=mode+det;

  // Award round credits
  for (let s = 0; s < 4; s++) {
    const seat = room.seats[s];
    if (!seat || seat.id.startsWith('ai_') || !seat.userId) continue;
    const team = teamOf(s);
    const myPts = team===0?p0:p1;
    const oppPts = team===0?p1:p0;
    let earned = 0, reasons = [];
    if (myPts > 0) { earned += CREDITS.WIN_ROUND; reasons.push('Round win'); }
    else if (oppPts > 0) { earned += CREDITS.LOSS_ROUND; reasons.push('Round loss'); }
    // Check if hit target
    const myTricks = team===0?us:them;
    const myTarget = team===0?ut:tt;
    if (myTricks >= myTarget) {
      earned += CREDITS.HIT_TARGET; reasons.push('Hit target');
      updateStats(seat.userId, { roundsWon: 1 });
    }
    const result = awardCredits(seat.userId, earned, reasons.join(', '));
    if (result) io.to(seat.id).emit('credits_update', result);
  }

  // Game over credits
  if (gameOver) {
    const winTeam = g.scores[0]>g.scores[1]?0:1;
    for (let s = 0; s < 4; s++) {
      const seat = room.seats[s];
      if (!seat || seat.id.startsWith('ai_') || !seat.userId) continue;
      const isWinner = teamOf(s)===winTeam;
      const result = awardCredits(seat.userId, isWinner?CREDITS.WIN_GAME:CREDITS.LOSS_GAME, isWinner?'Game win':'Game loss');
      if (result) io.to(seat.id).emit('credits_update', result);
      updateStats(seat.userId, isWinner?{ won:1, played:1 }:{ lost:1, played:1 });
    }
  }

  io.to(code).emit('round_result', {
    scores:[...g.scores], pts:[p0,p1], detail:det, gameOver,
    winner: gameOver?winner:null
  });
}

function handleLeave(socket) {
  const code = socket.data.room;
  if (!code || !rooms[code]) return;
  const room = rooms[code];
  const seatIdx = room.seats.findIndex(s => s&&s.id===socket.id);
  if (seatIdx>=0) room.seats[seatIdx]=null;
  const specIdx = room.spectators.findIndex(s => s.id===socket.id);
  if (specIdx>=0) room.spectators.splice(specIdx,1);
  socket.leave(code);
  socket.data.room=null;
  if (room.host===socket.id) {
    const newHost=[...room.seats.filter(s=>s&&!s.id.startsWith('ai_')),...room.spectators][0];
    if(newHost){room.host=newHost.id;room.hostName=newHost.name;io.to(code).emit('room_update',room);}
    else{io.to(code).emit('room_closed','Host left. Room closed.');delete rooms[code];}
  } else {
    io.to(code).emit('player_left',{name:socket.data.name||'A player'});
    broadcast(code);
  }
  broadcastLobby();
}

// ── SOCKET EVENTS ─────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Connected:', socket.id);

  socket.on('list_rooms', () => {
    socket.emit('rooms_list', Object.values(rooms)
      .filter(r=>r.visibility==='public'&&!r.started)
      .map(r=>({code:r.code,name:r.name,mode:r.mode,visibility:r.visibility,hostName:r.hostName,playerCount:r.seats.filter(Boolean).length})));
  });

  socket.on('create_room', ({ name, mode, visibility, hostName, userId, credits, level }) => {
    const code = uid();
    rooms[code] = {
      code, name, mode, visibility,
      host: socket.id, hostName,
      seats: [null,null,null,null],
      spectators: [], started: false,
      game: { round:0, scores:[0,0], dealer:-1 }
    };
    socket.join(code);
    socket.data.name=hostName; socket.data.room=code;
    rooms[code].seats[0]={id:socket.id,name:hostName,userId:userId||null,credits:credits||100,level:level||getLevel(100)};
    socket.emit('room_created',{code});
    socket.emit('joined_room',{room:rooms[code]});
    broadcast(code); broadcastLobby();
  });

  socket.on('join_room', ({ code, playerName, userId, credits, level }) => {
    const c=(code||'').toUpperCase().trim();
    const room=rooms[c];
    if(!room){socket.emit('error_msg','Room "'+c+'" not found');return;}
    if(room.started){socket.emit('error_msg','Game already started');return;}
    socket.join(c);
    socket.data.name=playerName; socket.data.room=c;
    const alreadyIn=room.seats.some(s=>s&&s.id===socket.id)||room.spectators.some(s=>s.id===socket.id);
    if(!alreadyIn) room.spectators.push({id:socket.id,name:playerName,userId:userId||null,credits:credits||100,level:level||getLevel(100)});
    socket.emit('joined_room',{room});
    broadcast(c); broadcastLobby();
  });

  socket.on('take_seat', ({ code, seat, userId, credits, level }) => {
    const c=(code||'').toUpperCase().trim();
    const room=rooms[c];
    if(!room){socket.emit('error_msg','Room not found');return;}
    const seatNum=parseInt(seat);
    if(isNaN(seatNum)||seatNum<0||seatNum>3){socket.emit('error_msg','Bad seat');return;}
    if(room.seats[seatNum]&&room.seats[seatNum].id!==socket.id){socket.emit('error_msg','Seat taken');return;}
    const name=socket.data.name||'Player';
    const oldSeat=room.seats.findIndex(s=>s&&s.id===socket.id);
    if(oldSeat>=0)room.seats[oldSeat]=null;
    const specIdx=room.spectators.findIndex(s=>s.id===socket.id);
    if(specIdx>=0)room.spectators.splice(specIdx,1);
    room.seats[seatNum]={id:socket.id,name,userId:userId||null,credits:credits||100,level:level||getLevel(100)};
    broadcast(c); broadcastLobby();
  });

  socket.on('leave_seat', ({ code }) => {
    const c=(code||'').toUpperCase().trim();
    const room=rooms[c];
    if(!room)return;
    const seatIdx=room.seats.findIndex(s=>s&&s.id===socket.id);
    if(seatIdx>=0){
      const seat=room.seats[seatIdx];
      room.seats[seatIdx]=null;
      room.spectators.push({id:socket.id,name:socket.data.name||'Player',userId:seat.userId,credits:seat.credits,level:seat.level});
      broadcast(c); broadcastLobby();
    }
  });

  socket.on('kick_seat', ({ code, seat }) => {
    const room=rooms[code];
    if(!room||room.host!==socket.id)return;
    const player=room.seats[seat];
    if(player){room.seats[seat]=null;room.spectators.push(player);io.to(player.id).emit('kicked_to_spectator');broadcast(code);broadcastLobby();}
  });

  socket.on('move_spec_to_seat', ({ code, playerId, seat }) => {
    const room=rooms[code];
    if(!room||room.host!==socket.id)return;
    const specIdx=room.spectators.findIndex(s=>s.id===playerId);
    if(specIdx<0||room.seats[seat])return;
    const spec=room.spectators.splice(specIdx,1)[0];
    room.seats[seat]=spec;
    io.to(playerId).emit('moved_to_seat',{seat});
    broadcast(code); broadcastLobby();
  });

  socket.on('start_game', ({ code }) => {
    const room=rooms[code];
    if(!room){socket.emit('error_msg','Room not found');return;}
    if(room.host!==socket.id){socket.emit('error_msg','Only the host can start');return;}
    for(let i=0;i<4;i++){
      if(!room.seats[i]) room.seats[i]={id:'ai_'+i,name:['Cyrus','Arash','Bilal','Zaid'][i],userId:null};
    }
    room.started=true;
    room.game={round:0,scores:[0,0],dealer:-1};
    broadcastLobby();
    io.to(code).emit('game_start',{room,seatOrder:room.seats.map(s=>({id:s.id,name:s.name,credits:s.credits||100,level:s.level||getLevel(100)}))});
    setTimeout(()=>dealRound(code),800);
  });

  socket.on('ready_to_bid', ({ code }) => {
    const room=rooms[code];if(!room)return;
    room.game.bidIdx++; askNextBid(code);
  });

  socket.on('place_bid', ({ code, bid }) => {
    const room=rooms[code];if(!room)return;
    const g=room.game;
    const seat=g.bidOrder[g.bidIdx];
    g.bids[seat]=bid; g.bidIdx++;
    io.to(code).emit('bid_placed',{seat,bid});
    askNextBid(code);
  });

  socket.on('dealer_decision', ({ code, decision }) => {
    const room=rooms[code];if(!room)return;
    const g=room.game;
    const so=g.bids.reduce((a,b)=>a+(b>=0?b:0),0);
    const ds=g.dealer, dealerTeam=teamOf(ds);
    let oppBid=0;
    for(let s=0;s<4;s++) if(s!==ds&&teamOf(s)!==dealerTeam&&g.bids[s]>=0) oppBid+=g.bids[s];
    applyDealerDecision(code,decision,so,oppBid);
  });

  socket.on('ready_to_play', ({ code }) => {
    const room=rooms[code];if(!room)return;
    const g=room.game;
    g.readyCount=(g.readyCount||0)+1;
    const humanCount=room.seats.filter(s=>s&&!s.id.startsWith('ai_')).length;
    if(g.readyCount>=humanCount) startPlay(code);
  });

  socket.on('play_card', ({ code, card }) => {
    const room=rooms[code];if(!room)return;
    const g=room.game;
    const seat=room.seats.findIndex(s=>s&&s.id===socket.id);
    if(seat<0||seat!==g.turn)return;
    playCard(code,seat,card);
  });

  socket.on('next_round', ({ code }) => {
    const room=rooms[code];
    if(!room||room.host!==socket.id)return;
    dealRound(code);
  });

  socket.on('restart_game', ({ code }) => {
    const room=rooms[code];
    if(!room||room.host!==socket.id)return;
    room.game.scores=[0,0]; room.game.dealer=-1;
    dealRound(code);
  });

  socket.on('chat_msg', ({ code, msg }) => {
    const room=rooms[code];if(!room)return;
    const name=socket.data.name||'Player';
    const clean=String(msg).slice(0,80).replace(/</g,'&lt;');
    socket.to(code).emit('chat_msg',{name,msg:clean});
  });

  // WebRTC Voice
  socket.on('voice_offer',({code,to,offer})=>socket.to(to).emit('voice_offer',{from:socket.id,offer}));
  socket.on('voice_answer',({code,to,answer})=>socket.to(to).emit('voice_answer',{from:socket.id,answer}));
  socket.on('voice_ice',({code,to,candidate})=>socket.to(to).emit('voice_ice',{from:socket.id,candidate}));
  socket.on('voice_join',({code})=>{
    const room=rooms[code];if(!room)return;
    socket.to(code).emit('voice_peer_joined',{peerId:socket.id});
    const members=[...room.seats.filter(s=>s&&!s.id.startsWith('ai_')).map(s=>s.id),...room.spectators.map(s=>s.id)].filter(id=>id!==socket.id);
    socket.emit('voice_existing_peers',{peerIds:members});
  });
  socket.on('voice_leave',({code})=>socket.to(code).emit('voice_peer_left',{peerId:socket.id}));

  socket.on('leave_room', ({ code }) => { socket.data.room=code; handleLeave(socket); });
  socket.on('disconnect', () => { console.log('Disconnected:', socket.id); handleLeave(socket); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('T-Teka server running on port', PORT));
