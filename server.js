const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Generous timeouts so tab-switching / mobile backgrounding doesn't kill the session.
  // Browsers throttle timers when a tab is hidden; 120 s gives plenty of margin.
  pingTimeout: 120000,
  pingInterval: 25000
});

// Serve static files from public directory
app.use(express.static('public'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: Object.keys(rooms).length });
});

// Room management
const rooms = {};

// How long to hold a disconnected slot before truly evicting (ms)
const GUEST_GRACE_MS  = 90_000;  // 90 s — covers slow mobile reconnects
const HOST_GRACE_MS   = 90_000;  // 90 s for host too

// Generate a 5-character room code (uppercase letters + numbers, no confusing chars)
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I, O, 1, 0 to avoid confusion
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ═══════════════════════════════════════════════════════════════
// TRADE WINDOW ADJUDICATION (server-side, eliminates round-trip latency)
// ═══════════════════════════════════════════════════════════════
//
// The trade race is now decided HERE on the server, not on the host browser.
// This cuts the guest→host→guest round-trip to a single guest→server leg.
//
// room.tradeWindow = { active:bool, winnerId:string|null, market:{bid,ask,makerId} }

function openRoomTradeWindow(room, market) {
  room.tradeWindow = { active: true, winnerId: null, market };
}

function closeRoomTradeWindow(room) {
  if (room.tradeWindow) room.tradeWindow.active = false;
  room.tradeWindow = null;
}

// Adjudicate a trade attempt. Returns true if this caller won, false otherwise.
// winnerType: 'guest' | 'bot' | 'host_human'
function adjudicateTrade(roomCode, room, callerSocket, winnerType, winnerInfo) {
  const tw = room.tradeWindow;

  // Window not open — this caller loses
  if (!tw || !tw.active) {
    if (winnerType === 'guest') {
      callerSocket.emit('host_response', { type: 'trade_lost' });
    } else if (winnerType === 'host_human') {
      callerSocket.emit('host_trade_lost');
    }
    return false;
  }

  // Already won by someone else
  if (tw.winnerId) {
    if (winnerType === 'guest') {
      callerSocket.emit('host_response', { type: 'trade_lost' });
    } else if (winnerType === 'host_human') {
      callerSocket.emit('host_trade_lost');
    }
    return false;
  }

  // ── This caller wins! ──
  tw.active = false;
  tw.winnerId = winnerType === 'guest' ? callerSocket.id
              : winnerType === 'bot'   ? `bot_${winnerInfo.playerIdx}`
              : `host_${callerSocket.id}`;

  const { bid, ask, makerId } = tw.market;

  if (winnerType === 'guest') {
    // Tell the winner directly
    callerSocket.emit('host_response', { type: 'trade_won', bid, ask, makerId });
    // Tell the host to execute the trade
    io.to(room.hostSocketId).emit('trade_awarded', {
      winnerType: 'guest',
      guestSocketId: callerSocket.id,
      guestName: winnerInfo.guestName,
      bid, ask, makerId
    });
    // Tell all other guests they lost (host_response is ignored by non-guest sockets)
    room.guests.forEach(g => {
      if (g.socketId !== callerSocket.id) {
        io.to(g.socketId).emit('host_response', { type: 'trade_lost' });
      }
    });

  } else if (winnerType === 'bot') {
    // Tell host to execute bot trade
    io.to(room.hostSocketId).emit('trade_awarded', {
      winnerType: 'bot',
      playerIdx: winnerInfo.playerIdx,
      action: winnerInfo.action,
      volume: winnerInfo.volume,
      bid, ask, makerId
    });
    // Tell all guests they lost
    room.guests.forEach(g => {
      io.to(g.socketId).emit('host_response', { type: 'trade_lost' });
    });

  } else if (winnerType === 'host_human') {
    // Tell host they won
    io.to(room.hostSocketId).emit('trade_awarded', {
      winnerType: 'host_human',
      bid, ask, makerId
    });
    // Tell all guests they lost
    room.guests.forEach(g => {
      io.to(g.socketId).emit('host_response', { type: 'trade_lost' });
    });
  }

  closeRoomTradeWindow(room);
  return true;
}

// ═══════════════════════════════════════════════════════════════
// SOCKET.IO EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // CREATE ROOM — host initiates
  socket.on('create_room', ({ displayName }) => {
    // Generate unique code
    let code;
    do {
      code = generateRoomCode();
    } while (rooms[code]);

    // Create and store room
    rooms[code] = {
      code,
      hostSocketId: socket.id,
      hostName: displayName || 'Host',
      hostDisconnectTimer: null,
      guests: [],
      gamePhase: 'waiting',
      tradeWindow: null,
      createdAt: Date.now()
    };

    // Join socket.io room
    socket.join(code);

    console.log(`Room created: ${code} by ${displayName}`);
    socket.emit('room_created', { code });
  });

  // JOIN ROOM — guest joins (also handles reconnection by matching name)
  socket.on('join_room', ({ code, displayName }) => {
    code = code.toUpperCase();
    const room = rooms[code];

    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    // Check if this is a reconnecting guest (same name already in room)
    const existingGuest = room.guests.find(g => g.name === displayName);
    if (existingGuest) {
      // Cancel the pending removal timer — they made it back in time
      if (existingGuest._disconnectTimer) {
        clearTimeout(existingGuest._disconnectTimer);
        existingGuest._disconnectTimer = null;
      }

      // Update socket ID & clear disconnected flag
      existingGuest.socketId = socket.id;
      existingGuest.disconnected = false;
      socket.join(code);
      console.log(`${displayName} reconnected to room ${code}`);

      socket.emit('room_joined', {
        code,
        hostName: room.hostName,
        guestIndex: existingGuest.index,
        guests: room.guests.map(g => ({ name: g.name, index: g.index })),
        reconnected: true
      });

      // Tell host the guest is back — host will re-broadcast game state
      io.to(room.hostSocketId).emit('guest_reconnected', {
        guestName: existingGuest.name,
        guestIndex: existingGuest.index,
        guestSocketId: socket.id
      });

      // Also send updated room list to host
      io.to(room.hostSocketId).emit('room_updated', {
        guests: room.guests.map(g => ({ name: g.name, index: g.index, socketId: g.socketId, ready: g.ready || false }))
      });
      return;
    }

    // New guest joining
    const guestIndex = room.guests.length;
    room.guests.push({
      socketId: socket.id,
      name: displayName || `Guest ${guestIndex + 1}`,
      index: guestIndex,
      ready: false,
      disconnected: false,
      _disconnectTimer: null
    });

    // Join socket.io room
    socket.join(code);

    console.log(`${displayName} joined room ${code}`);

    // Send confirmation to guest
    socket.emit('room_joined', {
      code,
      hostName: room.hostName,
      guestIndex,
      guests: room.guests.map(g => ({ name: g.name, index: g.index }))
    });

    // Notify host of new guest — include socketId + ready so host can track state
    io.to(room.hostSocketId).emit('room_updated', {
      guests: room.guests.map(g => ({ name: g.name, index: g.index, socketId: g.socketId, ready: g.ready || false }))
    });

    // Notify other guests — no socketIds exposed to guests
    socket.to(code).emit('room_updated', {
      guests: room.guests.map(g => ({ name: g.name, index: g.index }))
    });
  });

  // GAME STATE — host broadcasts to guests
  socket.on('game_state', (state) => {
    const roomCode = Object.keys(rooms).find(code => rooms[code].hostSocketId === socket.id);
    if (!roomCode) return;
    const room = rooms[roomCode];
    if (room.hostSocketId !== socket.id) return;
    socket.to(roomCode).emit('game_state', state);
  });

  // ── TRADE WINDOW — host signals it's open ──
  socket.on('trade_window_open', ({ bid, ask, makerId }) => {
    const roomCode = Object.keys(rooms).find(code => rooms[code].hostSocketId === socket.id);
    if (!roomCode) return;
    openRoomTradeWindow(rooms[roomCode], { bid, ask, makerId });
    console.log(`Trade window opened in room ${roomCode}: ${bid}/${ask}`);
  });

  // ── TRADE WINDOW — bot on host wins ──
  socket.on('bot_trade_now', ({ playerIdx, action, volume, bid, ask, makerId }) => {
    const roomCode = Object.keys(rooms).find(code => rooms[code].hostSocketId === socket.id);
    if (!roomCode) return;
    adjudicateTrade(roomCode, rooms[roomCode], socket, 'bot', { playerIdx, action, volume });
  });

  // ── TRADE WINDOW — host human clicks Trade Now ──
  socket.on('host_trade_now', ({ bid, ask, makerId }) => {
    const roomCode = Object.keys(rooms).find(code => rooms[code].hostSocketId === socket.id);
    if (!roomCode) return;
    adjudicateTrade(roomCode, rooms[roomCode], socket, 'host_human', {});
  });

  // ── TRADE WINDOW — host closes window (timeout or no takers) ──
  socket.on('trade_window_close', () => {
    const roomCode = Object.keys(rooms).find(code => rooms[code].hostSocketId === socket.id);
    if (!roomCode) return;
    const room = rooms[roomCode];
    if (room.tradeWindow && room.tradeWindow.active) {
      // No one won — close and notify any guests still waiting
      room.guests.forEach(g => {
        io.to(g.socketId).emit('host_response', { type: 'trade_lost' });
      });
      closeRoomTradeWindow(room);
    }
    console.log(`Trade window closed in room ${roomCode}`);
  });

  // GUEST ACTION — guest sends action, host receives (or server handles trade race)
  socket.on('guest_action', (action) => {
    const roomCode = Object.keys(rooms).find(code => {
      return rooms[code].guests.some(g => g.socketId === socket.id);
    });

    if (!roomCode) return;
    const room = rooms[roomCode];
    const guest = room.guests.find(g => g.socketId === socket.id);

    // Persist ready state on the server so room_updated always reflects it
    if (action.type === 'set_ready') {
      guest.ready = action.ready;
      io.to(room.hostSocketId).emit('room_updated', {
        guests: room.guests.map(g => ({ name: g.name, index: g.index, socketId: g.socketId, ready: g.ready || false }))
      });
      return;
    }

    // ── Server-side trade adjudication ──
    // Handle the race locally instead of bouncing guest→host→guest (saves ~500ms RTT).
    if (action.type === 'trade_now') {
      adjudicateTrade(roomCode, room, socket, 'guest', { guestName: guest.name });
      return; // do NOT forward to host — trade_awarded tells host what happened
    }

    // All other actions — forward to host with guest metadata
    io.to(room.hostSocketId).emit('guest_action', {
      ...action,
      guestSocketId: socket.id,
      guestIndex: guest.index,
      guestName: guest.name
    });
  });

  // HOST RESPONSE — host responds to specific guest (private cards, make_market_turn, etc.)
  socket.on('host_response', ({ guestSocketId, data }) => {
    io.to(guestSocketId).emit('host_response', data);
  });

  // REMOVE GUEST — host explicitly removes a guest
  socket.on('remove_guest', ({ guestSocketId }) => {
    const roomCode = Object.keys(rooms).find(code => rooms[code].hostSocketId === socket.id);
    if (!roomCode) return;
    const room = rooms[roomCode];
    if (room.hostSocketId !== socket.id) return;

    const guest = room.guests.find(g => g.socketId === guestSocketId);
    if (!guest) return;

    if (guest._disconnectTimer) clearTimeout(guest._disconnectTimer);
    room.guests = room.guests.filter(g => g.socketId !== guestSocketId);

    io.to(guestSocketId).emit('host_response', { type: 'kicked' });

    io.to(room.hostSocketId).emit('room_updated', {
      guests: room.guests.map(g => ({ name: g.name, index: g.index, socketId: g.socketId, ready: g.ready || false }))
    });

    console.log(`${guest.name} removed from room ${roomCode} by host`);
  });

  // CHAT — broadcast to whole room
  socket.on('chat', ({ message }) => {
    const roomCode = Object.keys(rooms).find(code => {
      const room = rooms[code];
      return room.hostSocketId === socket.id || room.guests.some(g => g.socketId === socket.id);
    });

    if (!roomCode) return;
    const room = rooms[roomCode];

    let senderName = 'Unknown';
    if (room.hostSocketId === socket.id) {
      senderName = room.hostName;
    } else {
      const guest = room.guests.find(g => g.socketId === socket.id);
      if (guest) senderName = guest.name;
    }

    io.to(roomCode).emit('chat', {
      name: senderName,
      message,
      ts: new Date().toISOString()
    });
  });

  // DISCONNECT — grace period before evicting, preserving room state
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);

    // ── Was this the host? ──
    const roomCode = Object.keys(rooms).find(code => rooms[code].hostSocketId === socket.id);
    if (roomCode) {
      const room = rooms[roomCode];
      // Give host time to reconnect before nuking the room
      room.hostDisconnectTimer = setTimeout(() => {
        if (rooms[roomCode]) {
          io.to(roomCode).emit('host_disconnected');
          delete rooms[roomCode];
          console.log(`Room ${roomCode} deleted (host never reconnected)`);
        }
      }, HOST_GRACE_MS);

      // Tell guests host is temporarily gone
      socket.to(roomCode).emit('host_temporarily_disconnected');
      console.log(`Host of room ${roomCode} disconnected — grace period started`);
      return;
    }

    // ── Was this a guest? ──
    const guestRoomCode = Object.keys(rooms).find(code => {
      return rooms[code].guests.some(g => g.socketId === socket.id);
    });

    if (guestRoomCode) {
      const room = rooms[guestRoomCode];
      const guest = room.guests.find(g => g.socketId === socket.id);
      if (!guest) return;

      guest.disconnected = true;
      const guestName = guest.name;

      // Notify host immediately (but don't remove yet)
      io.to(room.hostSocketId).emit('guest_temporarily_disconnected', {
        guestName,
        guestIndex: guest.index
      });

      console.log(`${guestName} disconnected from room ${guestRoomCode} — grace period started`);

      // Schedule permanent removal after grace period
      guest._disconnectTimer = setTimeout(() => {
        const r = rooms[guestRoomCode];
        if (!r) return;
        r.guests = r.guests.filter(g => g.name !== guestName);
        io.to(r.hostSocketId).emit('guest_left', { guestName });
        io.to(r.hostSocketId).emit('room_updated', {
          guests: r.guests.map(g => ({ name: g.name, index: g.index, socketId: g.socketId, ready: g.ready || false }))
        });
        console.log(`${guestName} permanently removed from room ${guestRoomCode} (grace expired)`);
      }, GUEST_GRACE_MS);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Market Maker server running on port ${PORT}`);
});
