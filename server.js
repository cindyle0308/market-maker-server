'use strict';

const express    = require('express');
const http       = require('http');
const socketIO   = require('socket.io');
const { GameRoom } = require('./game-engine');

const app    = express();
const server = http.createServer(app);
const io     = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Generous timeouts so tab-switching / mobile backgrounding doesn't kill the session.
  pingTimeout:  120000,
  pingInterval:  25000,
});

app.use(express.static('public'));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: Object.keys(rooms).length });
});

// ═══════════════════════════════════════════════════════════════
// ROOM REGISTRY
// ═══════════════════════════════════════════════════════════════
const rooms = {};

const GUEST_GRACE_MS = 90_000;
const HOST_GRACE_MS  = 90_000;

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ═══════════════════════════════════════════════════════════════
// SOCKET HANDLERS
// ═══════════════════════════════════════════════════════════════
io.on('connection', socket => {
  console.log('Client connected:', socket.id);

  // ── CREATE ROOM ─────────────────────────────────────────────
  socket.on('create_room', ({ displayName }) => {
    let code;
    do { code = generateRoomCode(); } while (rooms[code]);

    rooms[code] = {
      code,
      hostSocketId: socket.id,
      hostName: displayName || 'Host',
      hostDisconnectTimer: null,
      guests: [],
      gamePhase: 'waiting',
      gameEngine: null,          // ← server-side GameRoom
      createdAt: Date.now(),
    };

    socket.join(code);
    console.log(`Room created: ${code} by ${displayName}`);
    socket.emit('room_created', { code });
  });

  // ── JOIN ROOM ────────────────────────────────────────────────
  socket.on('join_room', ({ code, displayName }) => {
    code = code.toUpperCase();
    const room = rooms[code];
    if (!room) { socket.emit('error', { message: 'Room not found' }); return; }

    // Reconnect path — same name already in room
    const existing = room.guests.find(g => g.name === displayName);
    if (existing) {
      if (existing._disconnectTimer) {
        clearTimeout(existing._disconnectTimer);
        existing._disconnectTimer = null;
      }
      existing.socketId = socket.id;
      existing.disconnected = false;
      socket.join(code);
      console.log(`${displayName} reconnected to room ${code}`);

      socket.emit('room_joined', {
        code, hostName: room.hostName,
        guestIndex: existing.index,
        guests: room.guests.map(g => ({ name: g.name, index: g.index })),
        reconnected: true,
      });
      io.to(room.hostSocketId).emit('guest_reconnected', {
        guestName: existing.name, guestIndex: existing.index, guestSocketId: socket.id,
      });
      io.to(room.hostSocketId).emit('room_updated', {
        guests: room.guests.map(g => ({ name: g.name, index: g.index, socketId: g.socketId, ready: g.ready || false })),
      });

      // If a server-side game is running, re-send private state to the reconnected guest
      if (room.gameEngine && room.gameEngine.isActive) {
        room.gameEngine.refreshGuestSocket(existing.index, socket.id);
      }
      return;
    }

    // New guest
    const guestIndex = room.guests.length;
    room.guests.push({
      socketId: socket.id,
      name: displayName || `Guest ${guestIndex + 1}`,
      index: guestIndex,
      ready: false,
      disconnected: false,
      _disconnectTimer: null,
    });
    socket.join(code);
    console.log(`${displayName} joined room ${code}`);

    socket.emit('room_joined', {
      code, hostName: room.hostName,
      guestIndex,
      guests: room.guests.map(g => ({ name: g.name, index: g.index })),
    });
    io.to(room.hostSocketId).emit('room_updated', {
      guests: room.guests.map(g => ({ name: g.name, index: g.index, socketId: g.socketId, ready: g.ready || false })),
    });
    socket.to(code).emit('room_updated', {
      guests: room.guests.map(g => ({ name: g.name, index: g.index })),
    });
  });

  // ── GAME STATE RELAY (host → guests, legacy path for local play) ──
  socket.on('game_state', state => {
    const roomCode = _hostRoom(socket.id);
    if (!roomCode) return;
    const room = rooms[roomCode];
    // Don't relay if server-side engine is active (engine broadcasts directly)
    if (room.gameEngine && room.gameEngine.isActive) return;
    socket.to(roomCode).emit('game_state', state);
  });

  // ═══════════════════════════════════════════════════════════════
  // PLAYER ACTION — unified event for all game actions
  // Sent by both host and guests in server-side game mode.
  // ═══════════════════════════════════════════════════════════════
  socket.on('player_action', action => {
    const roomCode = _anyRoom(socket.id);
    if (!roomCode) return;
    const room = rooms[roomCode];

    // ── game_start: host initiates a server-side game ──────────
    if (action.type === 'game_start') {
      if (socket.id !== room.hostSocketId) return; // only host
      // Tear down any previous engine
      if (room.gameEngine) { room.gameEngine.cleanup(); room.gameEngine = null; }
      room.gameEngine = new GameRoom(roomCode, io, room);
      room.gamePhase = 'playing';
      console.log(`[${roomCode}] Server-side game starting`);
      room.gameEngine.start(action.config);
      return;
    }

    // All other actions require an active game engine
    const engine = room.gameEngine;
    if (!engine || !engine.isActive) return;

    switch (action.type) {
      case 'preview_done':
        engine.handlePreviewDone(socket.id);
        break;

      case 'continue_round':
        engine.handleContinueRound(socket.id);
        break;

      case 'post_market':
        engine.handlePostMarket(socket.id, action.bid, action.ask);
        break;

      case 'trade_now':
        engine.handleTradeNow(socket.id);
        break;

      case 'confirm_trade':
        engine.handleConfirmTrade(socket.id, action.action, action.volume);
        break;

      // ── set_ready is still handled legacy-style via guest_action ──
      default:
        break;
    }
  });

  // ── GUEST ACTION (legacy path — set_ready, guest_quit, etc.) ──
  socket.on('guest_action', action => {
    const roomCode = _anyRoom(socket.id);
    if (!roomCode) return;
    const room = rooms[roomCode];

    if (action.type === 'set_ready') {
      const guest = room.guests.find(g => g.socketId === socket.id);
      if (guest) {
        guest.ready = action.ready;
        io.to(room.hostSocketId).emit('room_updated', {
          guests: room.guests.map(g => ({ name: g.name, index: g.index, socketId: g.socketId, ready: g.ready || false })),
        });
      }
      return;
    }

    // If server-side engine is active, route game actions through player_action instead
    if (room.gameEngine && room.gameEngine.isActive) {
      // Route trade_now and confirm_trade to the engine directly
      if (action.type === 'trade_now') {
        room.gameEngine.handleTradeNow(socket.id);
        return;
      }
      if (action.type === 'confirm_trade') {
        room.gameEngine.handleConfirmTrade(socket.id, action.action, action.volume);
        return;
      }
      if (action.type === 'preview_done') {
        room.gameEngine.handlePreviewDone(socket.id);
        return;
      }
      if (action.type === 'make_market') {
        room.gameEngine.handlePostMarket(socket.id, action.bid, action.ask);
        return;
      }
    }

    // Legacy: forward to host
    if (socket.id !== room.hostSocketId) {
      const guest = room.guests.find(g => g.socketId === socket.id);
      if (!guest) return;
      io.to(room.hostSocketId).emit('guest_action', {
        ...action,
        guestSocketId: socket.id,
        guestIndex: guest.index,
        guestName: guest.name,
      });
    }
  });

  // ── LEGACY: trade window signals (kept for backward compat during transition) ──
  socket.on('trade_window_open', ({ bid, ask, makerId }) => {
    // Only used if running in legacy (non-engine) mode — engine handles this internally
    const roomCode = _hostRoom(socket.id);
    if (!roomCode) return;
    const room = rooms[roomCode];
    if (room.gameEngine && room.gameEngine.isActive) return; // engine handles it
    room.tradeWindow = { active: true, winnerId: null, market: { bid, ask, makerId } };
  });

  socket.on('bot_trade_now', ({ playerIdx, action, volume, bid, ask, makerId }) => {
    const roomCode = _hostRoom(socket.id);
    if (!roomCode) return;
    const room = rooms[roomCode];
    if (room.gameEngine && room.gameEngine.isActive) return; // engine handles it
    // Legacy adjudication
    _legacyAdjudicate(roomCode, room, socket, 'bot', { playerIdx, action, volume });
  });

  socket.on('host_trade_now', () => {
    const roomCode = _hostRoom(socket.id);
    if (!roomCode) return;
    const room = rooms[roomCode];
    if (room.gameEngine && room.gameEngine.isActive) {
      room.gameEngine.handleTradeNow(socket.id);
      return;
    }
    _legacyAdjudicate(roomCode, room, socket, 'host_human', {});
  });

  socket.on('trade_window_close', () => {
    const roomCode = _hostRoom(socket.id);
    if (!roomCode) return;
    const room = rooms[roomCode];
    if (room.gameEngine && room.gameEngine.isActive) return;
    if (room.tradeWindow && room.tradeWindow.active) {
      room.guests.forEach(g => io.to(g.socketId).emit('host_response', { type: 'trade_lost' }));
      room.tradeWindow = null;
    }
  });

  // ── HOST RESPONSE (private relay) ───────────────────────────
  socket.on('host_response', ({ guestSocketId, data }) => {
    io.to(guestSocketId).emit('host_response', data);
  });

  // ── REMOVE GUEST ─────────────────────────────────────────────
  socket.on('remove_guest', ({ guestSocketId }) => {
    const roomCode = _hostRoom(socket.id);
    if (!roomCode) return;
    const room = rooms[roomCode];
    const guest = room.guests.find(g => g.socketId === guestSocketId);
    if (!guest) return;
    if (guest._disconnectTimer) clearTimeout(guest._disconnectTimer);
    room.guests = room.guests.filter(g => g.socketId !== guestSocketId);
    io.to(guestSocketId).emit('host_response', { type: 'kicked' });
    io.to(room.hostSocketId).emit('room_updated', {
      guests: room.guests.map(g => ({ name: g.name, index: g.index, socketId: g.socketId, ready: g.ready || false })),
    });
    console.log(`${guest.name} removed from room ${roomCode}`);
  });

  // ── CHAT ─────────────────────────────────────────────────────
  socket.on('chat', ({ message }) => {
    const roomCode = _anyRoom(socket.id);
    if (!roomCode) return;
    const room = rooms[roomCode];
    let senderName = room.hostSocketId === socket.id
      ? room.hostName
      : (room.guests.find(g => g.socketId === socket.id)?.name || 'Unknown');
    io.to(roomCode).emit('chat', { name: senderName, message, ts: new Date().toISOString() });
  });

  // ── DISCONNECT ───────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);

    // Was this the host?
    const hostRoomCode = _hostRoom(socket.id);
    if (hostRoomCode) {
      const room = rooms[hostRoomCode];
      room.hostDisconnectTimer = setTimeout(() => {
        if (rooms[hostRoomCode]) {
          // Clean up engine before deleting room
          if (room.gameEngine) { room.gameEngine.cleanup(); room.gameEngine = null; }
          io.to(hostRoomCode).emit('host_disconnected');
          delete rooms[hostRoomCode];
          console.log(`Room ${hostRoomCode} deleted (host never reconnected)`);
        }
      }, HOST_GRACE_MS);
      socket.to(hostRoomCode).emit('host_temporarily_disconnected');
      console.log(`Host of room ${hostRoomCode} disconnected — grace started`);
      return;
    }

    // Was this a guest?
    const guestRoomCode = Object.keys(rooms).find(code =>
      rooms[code].guests.some(g => g.socketId === socket.id)
    );
    if (guestRoomCode) {
      const room = rooms[guestRoomCode];
      const guest = room.guests.find(g => g.socketId === socket.id);
      if (!guest) return;
      guest.disconnected = true;
      const guestName = guest.name;
      io.to(room.hostSocketId).emit('guest_temporarily_disconnected', {
        guestName, guestIndex: guest.index,
      });
      console.log(`${guestName} disconnected from room ${guestRoomCode} — grace started`);
      guest._disconnectTimer = setTimeout(() => {
        const r = rooms[guestRoomCode];
        if (!r) return;
        r.guests = r.guests.filter(g => g.name !== guestName);
        io.to(r.hostSocketId).emit('guest_left', { guestName });
        io.to(r.hostSocketId).emit('room_updated', {
          guests: r.guests.map(g => ({ name: g.name, index: g.index, socketId: g.socketId, ready: g.ready || false })),
        });
        console.log(`${guestName} permanently removed from room ${guestRoomCode}`);
      }, GUEST_GRACE_MS);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
function _hostRoom(socketId) {
  return Object.keys(rooms).find(code => rooms[code].hostSocketId === socketId) || null;
}
function _guestRoom(socketId) {
  return Object.keys(rooms).find(code => rooms[code].guests.some(g => g.socketId === socketId)) || null;
}
function _anyRoom(socketId) {
  return _hostRoom(socketId) || _guestRoom(socketId) || null;
}

// ── Legacy trade adjudication (kept for non-engine rooms) ──────
function _legacyAdjudicate(roomCode, room, callerSocket, winnerType, winnerInfo) {
  const tw = room.tradeWindow;
  if (!tw || !tw.active) {
    if (winnerType === 'host_human') callerSocket.emit('host_trade_lost');
    return false;
  }
  if (tw.winnerId) {
    if (winnerType === 'host_human') callerSocket.emit('host_trade_lost');
    return false;
  }
  tw.active = false;
  tw.winnerId = winnerType === 'bot'
    ? `bot_${winnerInfo.playerIdx}`
    : `host_${callerSocket.id}`;

  const { bid, ask, makerId } = tw.market;

  if (winnerType === 'bot') {
    io.to(room.hostSocketId).emit('trade_awarded', {
      winnerType: 'bot', playerIdx: winnerInfo.playerIdx,
      action: winnerInfo.action, volume: winnerInfo.volume, bid, ask, makerId,
    });
    room.guests.forEach(g => io.to(g.socketId).emit('host_response', { type: 'trade_lost' }));
  } else if (winnerType === 'host_human') {
    io.to(room.hostSocketId).emit('trade_awarded', { winnerType: 'host_human', bid, ask, makerId });
    room.guests.forEach(g => io.to(g.socketId).emit('host_response', { type: 'trade_lost' }));
  }
  room.tradeWindow = null;
  return true;
}

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Market Maker server running on port ${PORT}`));
