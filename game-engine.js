'use strict';

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════
const FULL_DECK = (() => {
  const d = [];
  for (let i = 0; i <= 20; i++) d.push(i, i);
  for (let i = 1; i <= 8; i++) d.push(-i * 10);
  return d;
})(); // 50 cards

const DECK_EV = FULL_DECK.reduce((a, b) => a + b, 0) / FULL_DECK.length; // ≈ 1.2
const CC = 6;           // community cards
const TRADE_WIN = 8000; // ms — trade race window
const EXEC_WIN  = 8000; // ms — exec decision window
const BOT_DELAY_ESTIMA  = 1800;
const BOT_DELAY_CARDS   = 600;
const CARD_PREVIEW_SECS  = 30;
const ESTIMA_PREVIEW_SECS = 90;
const MAKER_SECS         = 10;
const MAKER_GRACE        = 5;  // extra seconds for remote maker

const BOT_PROFILES = [
  { name:'Algo-X',     sf:0.70, th:1.2, cth:0.38, spd:0.90, mw:0.12, ag:1.6,  ub: 0.05, pb: 0.00, bias:0 },
  { name:'QuantEdge',  sf:0.50, th:0.8, cth:0.36, spd:0.88, mw:0.06, ag:2.2,  ub:-0.10, pb:-0.05, bias:0 },
  { name:'HedgeFund',  sf:1.70, th:3.2, cth:0.40, spd:1.05, mw:0.18, ag:2.0,  ub: 0.20, pb: 0.15, bias:0 },
  { name:'ArbBot',     sf:1.00, th:1.8, cth:0.38, spd:0.95, mw:0.35, ag:1.5,  ub: 0.00, pb: 0.00, bias:0 },
  { name:'BearTrap',   sf:1.10, th:2.5, cth:0.40, spd:1.00, mw:0.08, ag:1.8,  ub:-0.25, pb:-0.20, bias:-2.5 },
  { name:'BullRun',    sf:1.10, th:2.5, cth:0.40, spd:1.00, mw:0.08, ag:1.8,  ub: 0.25, pb: 0.20, bias: 2.5 },
  { name:'GammaBot',   sf:0.80, th:1.6, cth:0.36, spd:0.92, mw:0.38, ag:1.2,  ub: 0.10, pb:-0.10, bias:0 },
  { name:'DeltaOne',   sf:1.20, th:2.0, cth:0.42, spd:1.08, mw:0.20, ag:2.5,  ub:-0.10, pb: 0.10, bias:0 },
  { name:'Momentum',   sf:0.80, th:1.4, cth:0.37, spd:0.90, mw:0.40, ag:1.7,  ub: 0.15, pb: 0.05, bias:0 },
  { name:'SteadyHand', sf:1.50, th:2.8, cth:0.42, spd:1.10, mw:0.14, ag:1.0,  ub:-0.05, pb: 0.05, bias:0 },
];

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
function unknownPool(known) {
  const p = [...FULL_DECK];
  for (const c of known) {
    const i = p.indexOf(c);
    if (i !== -1) p.splice(i, 1);
  }
  return p;
}

function shuffle(a) {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

// ═══════════════════════════════════════════════════════════════
// PLAYER
// ═══════════════════════════════════════════════════════════════
class Player {
  constructor(id, name, isHuman, firstCard) {
    this.id = id;
    this.name = name;
    this.isHuman = isHuman;
    this.privateCards = firstCard !== undefined ? [firstCard] : [];
    this.socketId = null; // set for human players
    this.position = 0;
    this.cash = 0;
    this.totalBought = 0;
    this.totalSold = 0;
    this.totalBuyVal = 0;
    this.totalSellVal = 0;
  }
  avgEntry() {
    if (!this.position) return 0;
    return this.position > 0
      ? this.totalBuyVal / this.totalBought
      : this.totalSellVal / this.totalSold;
  }
  mtmPnL(mid) { return this.cash + this.position * mid; }
  settlePnL(s) { return this.cash + this.position * s; }
}

// ═══════════════════════════════════════════════════════════════
// BOT  (all G-dependent methods take G explicitly)
// ═══════════════════════════════════════════════════════════════
class Bot extends Player {
  constructor(id, firstCard, p) {
    super(id, p.name, false, firstCard);
    this.p = p;
    this.fv = null;
  }

  calcFV(G) {
    if (G.gameType === 'estimathon') {
      const truth = G.estimaQuestion.answer;
      const logTruth = Math.log10(Math.abs(truth));
      const logA = (logTruth / 2) + (this.p.ub || 0) * 0.4 + (Math.random() - 0.5) * 0.6;
      const logB = (logTruth / 2) + (this.p.pb || 0) * 0.4 + (Math.random() - 0.5) * 0.6;
      this.fv = Math.round(Math.pow(10, logA) * Math.pow(10, logB));
      return this.fv;
    }
    const rev = G.communityCards.filter((_, i) => G.revealedIndices.includes(i));
    const rSum = rev.reduce((s, c) => s + c, 0);
    const nh = CC - G.revealedIndices.length;
    const pool = unknownPool([...this.privateCards, ...rev]);
    const ev = pool.length ? pool.reduce((s, c) => s + c, 0) / pool.length : DECK_EV;
    this.fv = Math.round((rSum + nh * ev + (this.p.bias || 0)) * 10) / 10;
    return this.fv;
  }

  observeMkt(bid, ask, makerId, G) {
    if (makerId === this.id || this.fv === null) return;
    const spreadRef = G.gameType === 'estimathon'
      ? Math.abs((bid + ask) / 2) * 0.12
      : 6;
    const w = this.p.mw * Math.exp(-(ask - bid) / Math.max(1, spreadRef));
    this.fv = Math.round((this.fv * (1 - w) + ((bid + ask) / 2) * w) * 10) / 10;
  }

  makeMkt(G) {
    if (this.fv === null) this.calcFV(G);
    const nh = G.gameType === 'estimathon' ? 0 : CC - G.revealedIndices.length;
    const uf = 1 + (nh / CC);
    const h = G.gameType === 'estimathon'
      ? Math.abs(this.fv) * 0.06 * this.p.sf
      : (2.5 * this.p.sf * uf) / 2;
    const bid = Math.round((this.fv - h) * 2) / 2;
    const ask = Math.max(Math.round((this.fv + h) * 2) / 2, bid + 0.5);
    return { bid, ask };
  }

  decide(bid, ask, G) {
    if (this.fv === null) this.calcFV(G);
    const eb = this.fv - ask, es = bid - this.fv;
    const th = G.gameType === 'estimathon'
      ? Math.abs(this.fv) * 0.02 * this.p.th
      : this.p.cth;
    if (eb > th) {
      const vol = G.gameType === 'estimathon'
        ? Math.min(20, Math.max(1, Math.round(this.p.ag * 2)))
        : Math.min(20, Math.max(1, Math.round(eb * this.p.ag)));
      return { action: 'buy', volume: vol, edge: eb };
    }
    if (es > th) {
      const vol = G.gameType === 'estimathon'
        ? Math.min(20, Math.max(1, Math.round(this.p.ag * 2)))
        : Math.min(20, Math.max(1, Math.round(es * this.p.ag)));
      return { action: 'sell', volume: vol, edge: es };
    }
    return null;
  }

  react(edge, G) {
    const spd = this.p.spd || 1.0;
    if (G.gameType !== 'estimathon') {
      const normalized = Math.min(1, edge / 5);
      const base = (1400 - normalized * 700) * spd;
      return Math.max(150, Math.min(2000, base + (Math.random() - 0.5) * 400));
    }
    const scale = Math.abs(this.fv || G.estimaQuestion?.answer || 1000) * 0.04;
    const s = Math.min(1, edge / Math.max(1, scale));
    return Math.max(200, Math.min(1500, (800 - s * 300) * spd + (Math.random() - 0.5) * 600));
  }
}

// ═══════════════════════════════════════════════════════════════
// GAME ROOM  — owns all game state and timers for one room
// ═══════════════════════════════════════════════════════════════
class GameRoom {
  constructor(roomCode, io, room) {
    this.roomCode = roomCode;
    this.io = io;
    this.room = room; // server's rooms[roomCode] object
    this.G = null;

    // Active timer handles — tracked so cleanup() can cancel everything
    this._timers = new Set();
    this._roundTimer = null;
    this._makerTimer = null;
    this._previewTimer = null;
    this._botTimers = [];
    this._tradeWindowTimer = null;
    this._nextTurnTimer = null;
    this._mkBotTimer = null;

    // Preview state
    this._previewReadySet = null;
  }

  // ─── Timer wrappers (auto-tracked) ───────────────────────────
  _st(fn, ms) {
    const t = setTimeout(() => { this._timers.delete(t); fn(); }, ms);
    this._timers.add(t);
    return t;
  }
  _si(fn, ms) {
    const t = setInterval(fn, ms);
    this._timers.add(t);
    return t;
  }
  _ct(t) {
    if (!t) return;
    clearTimeout(t); clearInterval(t);
    this._timers.delete(t);
  }

  // ─── Broadcast / unicast ─────────────────────────────────────
  _broadcast(event, data) {
    this.io.to(this.roomCode).emit(event, data);
  }
  _unicast(socketId, event, data) {
    if (socketId) this.io.to(socketId).emit(event, data);
  }

  // ─── Socket ↔ player index helpers ──────────────────────────
  _socketToPlayerIdx(socketId) {
    if (socketId === this.room.hostSocketId) return 0;
    const g = this.room.guests.find(g => g.socketId === socketId);
    return g ? g.index + 1 : -1;
  }
  _getSocketId(playerIdx) {
    if (playerIdx === 0) return this.room.hostSocketId;
    const g = this.room.guests.find(g => g.index + 1 === playerIdx);
    return g ? g.socketId : null;
  }
  _allHumanSockets() {
    const sids = [];
    if (this.room.hostSocketId) sids.push(this.room.hostSocketId);
    this.room.guests.forEach(g => { if (g.socketId) sids.push(g.socketId); });
    return sids;
  }

  // ─── Build broadcast-safe public state ───────────────────────
  _publicState() {
    const G = this.G;
    if (!G) return null;

    // Build playerIndexMap: socketId → playerIdx
    const playerIndexMap = {};
    playerIndexMap[this.room.hostSocketId] = 0;
    this.room.guests.forEach(g => { playerIndexMap[g.socketId] = g.index + 1; });

    return {
      phase: G.phase,
      round: G.round,
      gameType: G.gameType,
      currentMarket: G.currentMarket,
      marketMakerIdx: G.marketMakerIdx,
      communityCards: G.gameType === 'cards' ? G.communityCards : null,
      revealedIndices: G.revealedIndices,
      estimaQuestion: G.gameType === 'estimathon' ? {
        q: G.estimaQuestion.q,
        unit: G.estimaQuestion.unit,
        hint1: G.estimaQuestion.hint1,
        hint2: G.estimaQuestion.hint2,
        order: G.estimaQuestion.order,
        answer: G.phase === 'settling' ? G.estimaQuestion.answer : undefined,
      } : null,
      players: G.players.map(p => ({
        name: p.name,
        isHuman: p.isHuman,
        position: p.position,
        cash: p.cash,
        avgEntry: p.avgEntry(),
        totalBought: p.totalBought,
        totalSold: p.totalSold,
      })),
      trades: G.trades.slice(-30),
      settlementValue: G.settlementValue,
      roundEndTime: G.roundEndTime,
      previewEndTime: G.previewEndTime || null,
      playerIndexMap,
    };
  }

  broadcastState() {
    const state = this._publicState();
    if (state) this._broadcast('game_state_update', state);
  }

  // ─── Send private cards to one player ────────────────────────
  _sendPrivateCards(playerIdx) {
    const sid = this._getSocketId(playerIdx);
    if (!sid) return;
    const pl = this.G.players[playerIdx];
    if (!pl) return;
    this._unicast(sid, 'player_sync', {
      type: 'private_cards',
      cards: [...pl.privateCards],
      playerIdx,
      round: this.G.round,
    });
  }

  _sendAllPrivateCards() {
    this.G.players.forEach((p, i) => { if (p.isHuman) this._sendPrivateCards(i); });
  }

  // ═══════════════════════════════════════════════════════════════
  // START GAME
  // ═══════════════════════════════════════════════════════════════
  start(config) {
    const { numPlayers, numHumans, roundMinutes, gameType, guestNames, question } = config;

    const G = {
      gameType,
      players: [],
      humanPlayerIndices: [],
      deck: [],
      communityCards: [],
      revealedIndices: [],
      estimaQuestion: question || null,
      phase: 'starting',
      round: 1,
      roundEndTime: null,
      currentMarket: null,
      marketMakerIdx: null,
      tradeWindow: null,
      execState: null,
      trades: [],
      tradeCounter: 0,
      settlementValue: null,
      previewEndTime: null,
      config: { numPlayers, numHumans, roundMinutes },
    };
    this.G = G;

    // Build player list
    const hostName = this.room.hostName || 'Host';
    const allHumanNames = [hostName, ...(guestNames || [])];
    let deck = shuffle(FULL_DECK);
    const profs = shuffle(BOT_PROFILES);

    for (let i = 0; i < numHumans; i++) {
      const p = new Player(i, allHumanNames[i] || `Player ${i + 1}`, true, deck[0]);
      p.socketId = i === 0
        ? this.room.hostSocketId
        : (this.room.guests[i - 1]?.socketId || null);
      G.players.push(p);
      G.humanPlayerIndices.push(i);
      deck = deck.slice(1);
    }
    for (let i = 0; i < numPlayers - numHumans; i++) {
      G.players.push(new Bot(numHumans + i, deck[0], profs[i % profs.length]));
      deck = deck.slice(1);
    }

    G.communityCards = deck.slice(0, CC);
    G.deck = deck.slice(CC);

    // Broadcast starting phase so clients know game is about to begin
    this.broadcastState();

    // Start preview
    if (gameType === 'estimathon') {
      this._startEstimaPreview();
    } else {
      this._startCardPreview();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PREVIEW PHASES
  // ═══════════════════════════════════════════════════════════════
  _startCardPreview() {
    const G = this.G;
    G.phase = 'card_preview';
    G.previewEndTime = Date.now() + CARD_PREVIEW_SECS * 1000;
    this._previewReadySet = new Set();
    this._sendAllPrivateCards();
    this.broadcastState();

    // Auto-advance if not everyone signals done within the window + 5s grace
    this._previewTimer = this._st(() => this._allPreviewDone(), (CARD_PREVIEW_SECS + 5) * 1000);
  }

  _startEstimaPreview() {
    const G = this.G;
    G.phase = 'estima_preview';
    G.previewEndTime = Date.now() + ESTIMA_PREVIEW_SECS * 1000;
    this._previewReadySet = new Set();
    this._sendAllPrivateCards();
    this.broadcastState();

    this._previewTimer = this._st(() => this._allPreviewDone(), (ESTIMA_PREVIEW_SECS + 5) * 1000);
  }

  handlePreviewDone(socketId) {
    if (!this._previewReadySet) return;
    this._previewReadySet.add(socketId);
    // Check if all human players are done
    const humanSids = this._allHumanSockets();
    if (humanSids.length > 0 && humanSids.every(sid => this._previewReadySet.has(sid))) {
      this._ct(this._previewTimer);
      this._previewTimer = null;
      this._allPreviewDone();
    }
  }

  _allPreviewDone() {
    this._previewReadySet = null;
    this.startRound(this.G.round);
  }

  // ═══════════════════════════════════════════════════════════════
  // ROUND MANAGEMENT
  // ═══════════════════════════════════════════════════════════════
  startRound(round) {
    const G = this.G;
    G.round = round;
    G.phase = 'round_active';
    G.currentMarket = null;
    G.marketMakerIdx = null;

    if (G.gameType === 'cards') {
      if (round === 2) this._revealCards([0, 1]);
      if (round === 3) this._revealCards([2, 3]);
    }

    // All bots recalc FV for the new round
    G.players.forEach(p => { if (!p.isHuman) p.calcFV(G); });

    G.roundEndTime = Date.now() + G.config.roundMinutes * 60000;

    // Round countdown — server-side
    this._roundTimer = this._si(() => {
      const rem = Math.max(0, G.roundEndTime - Date.now());
      if (rem <= 0) {
        this._ct(this._roundTimer);
        this._roundTimer = null;
        this.endRound();
      }
    }, 500);

    this.broadcastState();
    this.selectMaker();
  }

  endRound() {
    const G = this.G;
    this._cancelTradeWindow();
    if (G.round < 3) {
      G.phase = 'round_end';
      this.broadcastState();
      // Await host's continue_round action
    } else {
      this.settle();
    }
  }

  handleContinueRound(socketId) {
    // Only host triggers the continue — could also be any human, but let's keep it to host
    const G = this.G;
    if (!G || G.phase !== 'round_end') return;
    G.round++;

    if (G.gameType === 'cards') {
      // Deal one new card to every player
      if (G.deck.length >= G.players.length) {
        G.players.forEach(p => {
          const card = G.deck[0];
          G.deck = G.deck.slice(1);
          p.privateCards.push(card);
        });
      }
      this._startCardPreview();
    } else {
      G.previewEndTime = null;
      this._startEstimaPreview();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MARKET MAKING
  // ═══════════════════════════════════════════════════════════════
  selectMaker(prefIdx) {
    const G = this.G;
    if (!G || G.phase === 'settling') return;

    this._ct(this._mkBotTimer); this._mkBotTimer = null;
    this._cancelTradeWindow();

    const idx = prefIdx !== undefined
      ? prefIdx
      : Math.floor(Math.random() * G.players.length);

    G.marketMakerIdx = idx;
    G.phase = 'making_market';
    const maker = G.players[idx];

    if (maker.isHuman) {
      const sid = this._getSocketId(idx);
      if (sid) {
        this._unicast(sid, 'player_sync', { type: 'make_market_your_turn', playerIdx: idx });
      }
      this.broadcastState();

      // Auto-post a wide market if human doesn't respond in time
      this._makerTimer = this._st(() => {
        if (G.phase !== 'making_market' || G.marketMakerIdx !== idx) return;
        const revSum = G.revealedIndices.reduce((s, i) => s + G.communityCards[i], 0);
        const roughFV = revSum + (CC - G.revealedIndices.length) * DECK_EV;
        const sprd = G.gameType === 'estimathon' ? Math.abs(roughFV) * 0.2 : 8;
        const bid = Math.round((roughFV - sprd / 2) * 2) / 2;
        const ask = Math.round((roughFV + sprd / 2) * 2) / 2;
        console.log(`[${this.roomCode}] Maker timeout — auto-posting for ${maker.name}`);
        this.postMarket(bid, ask, idx);
      }, (MAKER_SECS + MAKER_GRACE) * 1000);

    } else {
      // Bot makes market after a random delay
      this.broadcastState();
      const delay = (G.gameType === 'estimathon' ? BOT_DELAY_ESTIMA : BOT_DELAY_CARDS)
        + (Math.random() - 0.5) * 300;
      this._mkBotTimer = this._st(() => {
        if (G.phase !== 'making_market' || G.marketMakerIdx !== idx) return;
        const m = maker.makeMkt(G);
        this.postMarket(m.bid, m.ask, idx);
      }, delay);
    }
  }

  postMarket(bid, ask, makerId) {
    const G = this.G;
    this._ct(this._makerTimer); this._makerTimer = null;

    G.currentMarket = { bid, ask, makerId };
    G.phase = 'trade_window';

    // All bots observe the new market
    G.players.forEach(p => { if (!p.isHuman) p.observeMkt(bid, ask, makerId, G); });

    this.broadcastState();
    this._openTradeWindow(bid, ask, makerId);
  }

  // Called when a human player (maker) posts a market via player_action
  handlePostMarket(socketId, bid, ask) {
    const G = this.G;
    if (!G || G.phase !== 'making_market') return;
    const playerIdx = this._socketToPlayerIdx(socketId);
    if (playerIdx < 0 || playerIdx !== G.marketMakerIdx) return;
    this.postMarket(bid, ask, playerIdx);
  }

  // ═══════════════════════════════════════════════════════════════
  // TRADE WINDOW
  // ═══════════════════════════════════════════════════════════════
  _openTradeWindow(bid, ask, makerId) {
    const G = this.G;
    G.tradeWindow = { active: true, bid, ask, makerId, winnerId: null };

    // Schedule bot reactions
    this._botTimers = [];
    G.players.forEach((pl, idx) => {
      if (idx === makerId || pl.isHuman) return;
      const dec = pl.decide(bid, ask, G);
      if (!dec) return;
      const delay = pl.react(dec.edge, G);
      const t = this._st(() => {
        if (!G.tradeWindow || !G.tradeWindow.active) return;
        this._adjudicateTrade('bot', null, { playerIdx: idx, action: dec.action, volume: dec.volume });
      }, delay);
      this._botTimers.push(t);
    });

    // Window timeout — no takers → rotate maker
    this._tradeWindowTimer = this._st(() => {
      if (!G.tradeWindow || !G.tradeWindow.active) return;
      this._closeTradeWindowInternal();
      G.phase = 'making_market';
      // Notify all waiting humans that the window expired
      this._allHumanSockets().forEach(sid => {
        this._unicast(sid, 'host_response', { type: 'trade_lost' });
      });
      this.broadcastState();
      this._nextTurn(null);
    }, TRADE_WIN);
  }

  // ─── Core race adjudication ───────────────────────────────────
  // winnerType: 'bot' | 'human'
  // info for bot: { playerIdx, action, volume }
  _adjudicateTrade(winnerType, socketId, info) {
    const G = this.G;
    if (!G.tradeWindow || !G.tradeWindow.active) {
      if (winnerType === 'human' && socketId) {
        this._unicast(socketId, 'host_response', { type: 'trade_lost' });
      }
      return;
    }
    if (G.tradeWindow.winnerId) {
      if (winnerType === 'human' && socketId) {
        this._unicast(socketId, 'host_response', { type: 'trade_lost' });
      }
      return;
    }

    // ─ This caller wins ─
    G.tradeWindow.winnerId = winnerType === 'bot'
      ? `bot_${info.playerIdx}`
      : `human_${socketId}`;

    const { bid, ask, makerId } = G.tradeWindow;
    this._closeTradeWindowInternal();

    if (winnerType === 'bot') {
      this.execTrade(info.playerIdx, info.action, info.volume, bid, ask, makerId);
      G.phase = 'making_market';
      // Tell all humans they lost
      this._allHumanSockets().forEach(sid => {
        this._unicast(sid, 'host_response', { type: 'trade_lost' });
      });
      this.broadcastState();
      this._nextTurn(info.playerIdx);

    } else {
      // Human won — give them the exec form, notify others they lost
      this._unicast(socketId, 'host_response', { type: 'trade_won', bid, ask, makerId });
      // Preserve tradeWindow stub for confirm_trade (needs makerId)
      G.tradeWindow = { active: false, bid, ask, makerId };
      // Tell all OTHER humans they lost
      this._allHumanSockets().forEach(sid => {
        if (sid !== socketId) this._unicast(sid, 'host_response', { type: 'trade_lost' });
      });
      // Don't broadcastState here yet — winner is still deciding
    }
  }

  // External entry points called by server.js
  handleTradeNow(socketId) {
    const G = this.G;
    if (!G || G.phase !== 'trade_window' || !G.tradeWindow || !G.tradeWindow.active) {
      this._unicast(socketId, 'host_response', { type: 'trade_lost' });
      return;
    }
    this._adjudicateTrade('human', socketId, null);
  }

  handleConfirmTrade(socketId, action, volume) {
    const G = this.G;
    if (!G || !G.tradeWindow) return;
    const traderIdx = this._socketToPlayerIdx(socketId);
    if (traderIdx < 0) return;
    const { bid, ask, makerId } = G.tradeWindow;
    this.execTrade(traderIdx, action, volume, bid, ask, makerId);
    G.tradeWindow = null;
    G.phase = 'making_market';
    this.broadcastState();
    this._nextTurn(traderIdx);
  }

  _closeTradeWindowInternal() {
    this._botTimers.forEach(t => this._ct(t));
    this._botTimers = [];
    this._ct(this._tradeWindowTimer); this._tradeWindowTimer = null;
    if (this.G && this.G.tradeWindow) this.G.tradeWindow.active = false;
  }

  _cancelTradeWindow() {
    this._closeTradeWindowInternal();
    if (this.G) { this.G.tradeWindow = null; this.G.execState = null; }
  }

  // ═══════════════════════════════════════════════════════════════
  // TURN ROTATION
  // ═══════════════════════════════════════════════════════════════
  _nextTurn(newIdx) {
    const G = this.G;
    if (!G || G.phase === 'settling') return;
    this._ct(this._nextTurnTimer); this._nextTurnTimer = null;
    this._nextTurnTimer = this._st(() => {
      if (!G || !['round_active', 'trade_window', 'making_market'].includes(G.phase)) return;
      G.phase = 'making_market';
      const ni = newIdx !== null
        ? newIdx
        : (G.marketMakerIdx !== null ? (G.marketMakerIdx + 1) % G.players.length : 0);
      this.selectMaker(ni);
    }, 200);
  }

  // ═══════════════════════════════════════════════════════════════
  // TRADE EXECUTION
  // ═══════════════════════════════════════════════════════════════
  execTrade(traderIdx, action, vol, bid, ask, makerId) {
    const G = this.G;
    const tr = G.players[traderIdx], mk = G.players[makerId];
    if (!tr || !mk) return;
    const price = action === 'buy' ? ask : bid;

    if (action === 'buy') {
      tr.position += vol;  tr.cash -= price * vol;  tr.totalBought += vol;  tr.totalBuyVal  += price * vol;
      mk.position -= vol;  mk.cash += price * vol;  mk.totalSold   += vol;  mk.totalSellVal += price * vol;
    } else {
      tr.position -= vol;  tr.cash += price * vol;  tr.totalSold   += vol;  tr.totalSellVal += price * vol;
      mk.position += vol;  mk.cash -= price * vol;  mk.totalBought += vol;  mk.totalBuyVal  += price * vol;
    }

    G.tradeCounter++;
    G.trades.push({
      num: G.tradeCounter, round: G.round,
      makerId, makerName: mk.name,
      bid, ask,
      traderId: traderIdx, traderName: tr.name,
      action, volume: vol, price,
      time: new Date().toLocaleTimeString(),
    });
    console.log(`[${this.roomCode}] Trade #${G.tradeCounter}: ${tr.name} ${action} ${vol} @ ${price}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // CARD REVEALS
  // ═══════════════════════════════════════════════════════════════
  _revealCards(indices) {
    const fresh = indices.filter(i => !this.G.revealedIndices.includes(i));
    this.G.revealedIndices.push(...fresh);
  }

  // ═══════════════════════════════════════════════════════════════
  // SETTLEMENT
  // ═══════════════════════════════════════════════════════════════
  settle() {
    const G = this.G;
    G.phase = 'settling';
    this._ct(this._roundTimer); this._roundTimer = null;
    this._cancelTradeWindow();

    if (G.gameType === 'cards') {
      G.revealedIndices = [0, 1, 2, 3, 4, 5];
      G.settlementValue = G.communityCards.reduce((a, b) => a + b, 0);
    } else {
      G.settlementValue = G.estimaQuestion.answer;
    }

    this.broadcastState();
    console.log(`[${this.roomCode}] Game settled: ${G.settlementValue}`);
  }

  // ═══════════════════════════════════════════════════════════════
  // PLAYER RECONNECT — re-send private state
  // ═══════════════════════════════════════════════════════════════
  handleReconnect(playerIdx, newSocketId) {
    const G = this.G;
    if (!G) return;
    // Update socketId in players array
    if (G.players[playerIdx]) G.players[playerIdx].socketId = newSocketId;
    // Re-send private cards
    this._sendPrivateCards(playerIdx);
    // Re-broadcast full state
    this.broadcastState();
  }

  // Update socket IDs when a guest reconnects
  refreshGuestSocket(guestIndex, newSocketId) {
    const playerIdx = guestIndex + 1;
    this.handleReconnect(playerIdx, newSocketId);
  }

  // ═══════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════
  cleanup() {
    for (const t of this._timers) { clearTimeout(t); clearInterval(t); }
    this._timers.clear();
    this._botTimers = [];
    this.G = null;
    this._previewReadySet = null;
    console.log(`[${this.roomCode}] GameRoom cleaned up`);
  }

  // ─── Convenience accessor ────────────────────────────────────
  get isActive() { return this.G !== null; }
}

module.exports = { GameRoom, shuffle, FULL_DECK, DECK_EV };
