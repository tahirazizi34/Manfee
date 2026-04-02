const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

const rooms = {};
const SYM = {S:'♠',H:'♥',D:'♦',C:'♣'};
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RV = {2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14};

app.get('/', (req,res) => res.send('Manfee server is running'));

function uid(){ return Math.random().toString(36).slice(2,8).toUpperCase(); }

function broadcast(code){ if(rooms[code]) io.to(code).emit('room_update', rooms[code]); }

function shuffle(a){ for(let i=a.length-1;i>0;i--){let j=~~(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

function newDeck(){
  let d=[];
  for(let s of['S','H','D','C']) for(let r of RANKS) d.push({r,s});
  return shuffle(d);
}

function teamOf(seat){ return (seat===0||seat===2)?0:1; }

function publicRooms(){
  return Object.values(rooms)
    .filter(r=>r.visibility==='public'&&!r.started)
    .map(r=>({
      code:r.code, name:r.name, mode:r.mode,
      visibility:r.visibility, hostName:r.hostName,
      playerCount:r.seats.filter(Boolean).length
    }));
}

// ── DEAL & GAME LOGIC ────────────────────────────────────────────
function dealRound(code){
  const room = rooms[code];
  if(!room) return;

  let g = room.game;
  g.round = g.round||1;
  g.scores = g.scores||[0,0];
  g.dealer = g.dealer>=0 ? (g.dealer+1)%4 : ~~(Math.random()*4);
  g.firstGame = g.firstGame!==false;
  g.firstGame = false;
  g.bids = [-1,-1,-1,-1];
  g.teamTarget = [-1,-1];
  g.roundPts = 1;
  g.dealerDecision = 'accept';
  g.tr = [0,0,0,0];
  g.tk = [null,null,null,null];
  g.led = null;
  g.tc = 0;
  g.switched = false;
  g.trump = room.mode==='kash' ? null : 'S';
  g.phase = 'bid';

  // Deal 13 cards each
  let deck = newDeck();
  g.hands = [[],[],[],[]];
  for(let i=0;i<deck.length;i++) g.hands[i%4].push(deck[i]);

  // First player = seat to right of dealer (clockwise = dealer+1 mod 4)
  g.firstPlayer = (g.dealer+1)%4;

  // Tell everyone new round
  io.to(code).emit('new_round',{
    dealer: g.dealer, round: g.round,
    scores: g.scores, firstGame: g.firstGame,
    seatOrder: room.seats.map(s=>({id:s.id,name:s.name}))
  });

  // Send each player their hand + other players' card counts
  room.seats.forEach((seat, seatIdx) => {
    let counts = g.hands.map((h,i)=>i===seatIdx?0:h.length);
    io.to(seat.id).emit('deal_hand',{
      hand: g.hands[seatIdx],
      cardCounts: counts
    });
  });
}

function startBidding(code){
  const room = rooms[code];
  const g = room.game;
  g.bidIdx = 0;
  // Bidding order: clockwise from right of dealer, dealer bids last
  g.bidOrder = [1,2,3,0].map(o=>(g.dealer+o)%4);
  askNextBid(code);
}

function askNextBid(code){
  const room = rooms[code];
  const g = room.game;
  if(g.bidIdx >= 3){ // all non-dealers done → dealer's turn
    askDealerDecision(code);
    return;
  }
  let seat = g.bidOrder[g.bidIdx];
  let bidsPlaced = [...g.bids];
  io.to(room.seats[seat].id).emit('bid_request',{
    seat, bidsPlaced, bidOrder: g.bidOrder
  });
  // Also tell others who is bidding
  room.seats.forEach((s,i)=>{
    if(i!==seat) io.to(s.id).emit('bid_request',{ seat, bidsPlaced, bidOrder:g.bidOrder });
  });
}

function askDealerDecision(code){
  const room = rooms[code];
  const g = room.game;
  let ds = g.dealer;
  let bidsTotal = g.bids.reduce((a,b)=>a+(b>=0?b:0),0);
  let dealerTeam = teamOf(ds);
  let oppBid = 0;
  [0,1,2,3].forEach(s=>{if(s!==ds&&teamOf(s)!==dealerTeam&&g.bids[s]>=0) oppBid+=g.bids[s];});
  g._oppBid = oppBid;
  g._bidsTotal = bidsTotal;
  io.to(room.seats[ds].id).emit('dealer_request',{ seat:ds, bidsTotal, oppBid });
  room.seats.forEach((s,i)=>{
    if(i!==ds) io.to(s.id).emit('dealer_request',{ seat:ds, bidsTotal, oppBid });
  });
}

function applyDealerDecision(code, decision){
  const room = rooms[code];
  const g = room.game;
  const ds = g.dealer;
  const dealerTeam = teamOf(ds);
  const oppBid = g._oppBid;
  const bidsTotal = g._bidsTotal;

  let dealerNeed, oppNeed, pts;
  if(decision==='accept'){
    dealerNeed = 13-bidsTotal+1; oppNeed = bidsTotal; pts=1;
  } else if(decision==='sw1'){
    dealerNeed = oppBid+1; oppNeed = 13-(oppBid+1); pts=1;
    rotateHands(room, g);
    g.switched=true;
  } else {
    dealerNeed = oppBid+2; oppNeed = 13-(oppBid+2); pts=2;
    rotateHands(room, g);
    g.switched=true;
  }

  g.teamTarget = dealerTeam===0 ? [dealerNeed,oppNeed] : [oppNeed,dealerNeed];
  g.roundPts = pts;
  g.dealerDecision = decision;

  io.to(code).emit('dealer_decided',{
    seat:ds, decision, teamTargets:g.teamTarget, roundPts:pts
  });

  if(g.switched){
    // Send each player their new hand
    room.seats.forEach((seat,seatIdx)=>{
      io.to(seat.id).emit('switch_hands',{ newHand: g.hands[seatIdx] });
    });
    // Wait for all players to confirm ready
    g.switchReady = new Set();
  } else {
    startPlay(code);
  }
}

function rotateHands(room, g){
  // Clockwise: seat 0→seat 1→seat 2→seat 3→seat 0
  let old = g.hands.map(h=>[...h]);
  g.hands[1]=old[0]; g.hands[2]=old[1]; g.hands[3]=old[2]; g.hands[0]=old[3];
}

function startPlay(code){
  const room = rooms[code];
  const g = room.game;
  g.phase = 'play';
  g.turn = g.firstPlayer;

  io.to(code).emit('play_start',{
    firstPlayer: g.firstPlayer,
    teamTargets: g.teamTarget,
    roundPts: g.roundPts
  });

  // Tell first player it's their turn
  askPlay(code);
}

function askPlay(code){
  const room = rooms[code];
  const g = room.game;
  let seat = g.turn;
  io.to(room.seats[seat].id).emit('your_turn',{ seat, led:g.led });
}

function resolvePlay(code){
  const room = rooms[code];
  const g = room.game;

  // Find winner
  let led=g.led, best=null, bs=-1;
  for(let i=0;i<4;i++){
    let c=g.tk[i]; if(!c) continue;
    if(!best){best=c;bs=i;continue;}
    if(g.trump&&c.s===g.trump&&best.s!==g.trump){best=c;bs=i;continue;}
    if(g.trump&&best.s===g.trump&&c.s!==g.trump) continue;
    if(c.s===led&&(best.s!==led||RV[c.r]>RV[best.r])){best=c;bs=i;}
  }
  let winner=bs;
  let team=teamOf(winner);
  g.tr[winner]++;
  g.tc++;
  g.tk=[null,null,null,null];
  g.led=null;

  io.to(code).emit('trick_result',{
    winner, trickCounts:[...g.tr], nextTurn:winner
  });

  if(g.tc>=13){
    setTimeout(()=>endRound(code), 900);
    return;
  }
  g.turn=winner;
  setTimeout(()=>askPlay(code), 1000);
}

function endRound(code){
  const room = rooms[code];
  const g = room.game;

  let us=g.tr.filter((_,i)=>teamOf(i)===0).reduce((a,b)=>a+b,0);
  let them=g.tr.filter((_,i)=>teamOf(i)===1).reduce((a,b)=>a+b,0);
  let ut=g.teamTarget[0], tt=g.teamTarget[1];
  let p0=0,p1=0,det='';
  let pts=g.roundPts;

  if(room.mode==='manfee'){
    let usHit=us>=ut, themHit=them>=tt;
    if(usHit&&themHit){p0=0;p1=0;det=`Both hit target → Tie 0-0\nUs:${us}/${ut} · Them:${them}/${tt}`;}
    else if(usHit&&!themHit){p0=pts;p1=0;det=`Team A hit ${ut}+ → +${pts} pt${pts>1?'s':''}\nTeam B missed (${them}/${tt})`;}
    else if(!usHit&&themHit){p0=0;p1=pts;det=`Team B hit ${tt}+ → +${pts} pt${pts>1?'s':''}\nTeam A missed (${us}/${ut})`;}
    else{p0=0;p1=0;det=`Both missed → 0-0\nUs:${us}/${ut} · Them:${them}/${tt}`;}
  } else {
    p0=us; p1=them; det=`Team A: ${us} tricks · Team B: ${them} tricks`;
  }

  let mode=g.switched?`[Switch ${pts===2?'+2':'+1'}]\n`:'[Accept]\n';
  det=mode+det;
  g.scores[0]+=p0; g.scores[1]+=p1;

  let win=52;
  let gameOver=g.scores[0]>=win||g.scores[1]>=win;
  let winner=g.scores[0]>=g.scores[1]?'Team A':'Team B';

  io.to(code).emit('round_result',{
    scores:[...g.scores], pts:[p0,p1], detail:det,
    gameOver, winner: gameOver?winner:null
  });
}

// ── SOCKET EVENTS ─────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Connected:', socket.id);

  socket.on('list_rooms', () => {
    socket.emit('rooms_list', publicRooms());
  });

  socket.on('create_room', ({ name, mode, visibility, hostName }) => {
    const code = uid();
    rooms[code] = {
      code, name, mode, visibility, host:socket.id, hostName,
      seats: [null,null,null,null], spectators: [], started:false,
      game: { round:0, scores:[0,0], dealer:-1, firstGame:true }
    };
    socket.join(code);
    socket.data.name = hostName;
    socket.data.room = code;
    rooms[code].seats[0] = { id:socket.id, name:hostName };
    socket.emit('room_created', { code });
    socket.emit('joined_room', { room:rooms[code] });
    broadcast(code);
  });

  socket.on('join_room', ({ code, playerName }) => {
    const room = rooms[code];
    if(!room){ socket.emit('error_msg','Room not found'); return; }
    if(room.started){ socket.emit('error_msg','Game already started'); return; }
    socket.join(code);
    socket.data.name = playerName;
    socket.data.room = code;
    const alreadySeated = room.seats.some(s=>s&&s.id===socket.id);
    const alreadySpec = room.spectators.some(s=>s.id===socket.id);
    if(!alreadySeated&&!alreadySpec) room.spectators.push({ id:socket.id, name:playerName });
    socket.emit('joined_room', { room });
    broadcast(code);
  });

  socket.on('take_seat', ({ code, seat }) => {
    const room = rooms[code]; if(!room) return;
    if(room.seats[seat]){ socket.emit('error_msg','Seat taken'); return; }
    room.seats = room.seats.map(s=>(s&&s.id===socket.id)?null:s);
    room.spectators = room.spectators.filter(s=>s.id!==socket.id);
    room.seats[seat] = { id:socket.id, name:socket.data.name };
    broadcast(code);
  });

  socket.on('leave_seat', ({ code }) => {
    const room = rooms[code]; if(!room) return;
    room.seats = room.seats.map(s=>(s&&s.id===socket.id)?null:s);
    if(!room.spectators.some(s=>s.id===socket.id))
      room.spectators.push({ id:socket.id, name:socket.data.name });
    broadcast(code);
  });

  socket.on('kick_seat', ({ code, seat }) => {
    const room = rooms[code]; if(!room||room.host!==socket.id) return;
    const p = room.seats[seat];
    if(p){ room.seats[seat]=null; room.spectators.push(p); io.to(p.id).emit('kicked_to_spectator'); broadcast(code); }
  });

  socket.on('start_game', ({ code }) => {
    const room = rooms[code]; if(!room||room.host!==socket.id) return;
    if(room.seats.filter(Boolean).length<4){ socket.emit('error_msg','Need 4 players seated'); return; }
    room.started = true;
    room.game.round = 0;
    room.game.scores = [0,0];
    room.game.dealer = -1;
    io.to(code).emit('game_start',{
      room, seatOrder: room.seats.map(s=>({id:s.id,name:s.name}))
    });
    setTimeout(()=>dealRound(code), 500);
  });

  socket.on('ready_to_bid', ({ code }) => {
    // After dealer announce, host triggers bidding
    const room = rooms[code]; if(!room) return;
    if(socket.id===room.host||socket.id===room.seats[0]?.id){
      startBidding(code);
    }
  });

  socket.on('place_bid', ({ code, bid }) => {
    const room = rooms[code]; if(!room) return;
    const g = room.game;
    const seat = room.seats.findIndex(s=>s&&s.id===socket.id);
    if(seat<0) return;
    g.bids[seat] = bid;
    io.to(code).emit('bid_placed', { seat, bid });
    g.bidIdx++;
    if(g.bidIdx<3) askNextBid(code);
    else askDealerDecision(code);
  });

  socket.on('dealer_decision', ({ code, decision }) => {
    const room = rooms[code]; if(!room) return;
    const seat = room.seats.findIndex(s=>s&&s.id===socket.id);
    if(seat!==room.game.dealer) return;
    applyDealerDecision(code, decision);
  });

  socket.on('ready_to_play', ({ code }) => {
    const room = rooms[code]; if(!room) return;
    const g = room.game;
    if(!g.switchReady) return;
    g.switchReady.add(socket.id);
    if(g.switchReady.size>=4) startPlay(code);
  });

  socket.on('play_card', ({ code, card }) => {
    const room = rooms[code]; if(!room) return;
    const g = room.game;
    const seat = room.seats.findIndex(s=>s&&s.id===socket.id);
    if(seat!==g.turn) return;
    // Remove from hand
    g.hands[seat] = g.hands[seat].filter(c=>!(c.r===card.r&&c.s===card.s));
    if(!g.led) g.led = card.s;
    g.tk[seat] = card;

    let counts = g.hands.map(h=>h.length);
    let allPlayed = g.tk.every(c=>c!==null);

    io.to(code).emit('card_played',{
      seat, card, led:g.led,
      nextTurn: allPlayed ? -1 : (g.turn+1)%4, // rough; server resolves
      cardCounts: counts
    });

    if(allPlayed){
      setTimeout(()=>resolvePlay(code), 800);
    } else {
      g.turn = (g.turn+1)%4; // simplified CCW; adjust if needed
      askPlay(code);
    }
  });

  socket.on('next_round', ({ code }) => {
    const room = rooms[code]; if(!room||room.host!==socket.id) return;
    room.game.round++;
    dealRound(code);
  });

  socket.on('restart_game', ({ code }) => {
    const room = rooms[code]; if(!room||room.host!==socket.id) return;
    room.game = { round:0, scores:[0,0], dealer:-1, firstGame:true };
    room.started = false;
    setTimeout(()=>{ room.started=true; dealRound(code); }, 300);
  });

  socket.on('leave_room', ({ code }) => {
    const room = rooms[code]; if(!room) return;
    room.seats = room.seats.map(s=>(s&&s.id===socket.id)?null:s);
    room.spectators = room.spectators.filter(s=>s.id!==socket.id);
    socket.leave(code);
    if(room.host===socket.id&&!room.started){
      io.to(code).emit('room_closed','The host left.');
      delete rooms[code];
    } else {
      io.to(code).emit('player_left',{ name:socket.data.name });
      broadcast(code);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    if(!code||!rooms[code]) return;
    const room = rooms[code];
    room.seats = room.seats.map(s=>(s&&s.id===socket.id)?null:s);
    room.spectators = room.spectators.filter(s=>s.id!==socket.id);
    if(room.host===socket.id&&!room.started){
      io.to(code).emit('room_closed','Host disconnected.');
      delete rooms[code];
    } else {
      io.to(code).emit('player_left',{ name:socket.data.name });
      broadcast(code);
    }
    console.log(`${socket.data.name||socket.id} disconnected`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Manfee server on port ${PORT}`));
