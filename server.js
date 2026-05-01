const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 120000,
  pingInterval: 25000
});

// Serve static files from public directory
app.use(express.static('public'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: Object.keys(rooms).length });
});

const rooms = {};
const GUEST_GRACE_MS = 90_000;
const HOST_GRACE_MS  = 90_000;

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function openRoomTradeWindow(room, market) {
  room.tradeWindow = { active: true, winnerId: null, market };
}
function closeRoomTradeWindow(room) {
  if (room.tradeWindow) room.tradeWindow.active = false;
  room.tradeWindow = null;
}
function adjudicateTrade(roomCode, room, callerSocket, winnerType, winnerInfo) {
  const tw = room.tradeWindow;
  if (!tw || !tw.active) {
    if (winnerType === 'guest') callerSocket.emit('host_response', { type: 'trade_lost' });
    else if (winnerType === 'host_human') callerSocket.emit('host_trade_lost');
    return false;
  }
  if (tw.winnerId) {
    if (winnerType === 'guest') callerSocket.emit('host_response', { type: 'trade_lost' });
    else if (winnerType === 'host_human') callerSocket.emit('host_trade_lost');
    return false;
  }
  tw.active = false;
  tw.winnerId = winnerType === 'guest' ? callerSocket.id : winnerType === 'bot' ? `bot_${winnerInfo.playerIdx}` : `host_${callerSocket.id}`;
  const { bid, ask, makerId } = tw.market;
  if (winnerType === 'guest') {
    callerSocket.emit('host_response', { type: 'trade_won', bid, ask, makerId });
    io.to(room.hostSocketId).emit('trade_awarded', { winnerType: 'guest', guestSocketId: callerSocket.id, guestName: winnerInfo.guestName, bid, ask, makerId });
    room.guests.forEach(g => { if (g.socketId !== callerSocket.id) io.to(g.socketId).emit('host_response', { type: 'trade_lost' }); });
  } else if (winnerType === 'bot') {
    io.to(room.hostSocketId).emit('trade_awarded', { winnerType: 'bot', playerIdx: winnerInfo.playerIdx, action: winnerInfo.action, volume: winnerInfo.volume, bid, ask, makerId });
    room.guests.forEach(g => { io.to(g.socketId).emit('host_response', { type: 'trade_lost' }); });
  } else if (winnerType === 'host_human') {
    io.to(room.hostSocketId).emit('trade_awarded', { winnerType: 'host_human', bid, ask, makerId });
    room.guests.forEach(g => { io.to(g.socketId).emit('host_response', { type: 'trade_lost' }); });
  }
  closeRoomTradeWindow(room);
  return true;
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('create_room', ({ displayName }) => {
    let code; do { code = generateRoomCode(); } while (rooms[code]);
    rooms[code] = { code, hostSocketId: socket.id, hostName: displayName||'Host', hostDisconnectTimer: null, guests: [], gamePhase: 'waiting', tradeWindow: null, createdAt: Date.now() };
    socket.join(code); socket.emit('room_created', { code });
  });
  socket.on('join_room', ({ code, displayName }) => {
    code = code.toUpperCase(); const room = rooms[code];
    if (!room) { socket.emit('error', { message: 'Room not found' }); return; }
    const existingGuest = room.guests.find(g => g.name === displayName);
    if (existingGuest) {
      if (existingGuest._disconnectTimer) { clearTimeout(existingGuest._disconnectTimer); existingGuest._disconnectTimer = null; }
      existingGuest.socketId = socket.id; existingGuest.disconnected = false; socket.join(code);
      socket.emit('room_joined', { code, hostName: room.hostName, guestIndex: existingGuest.index, guests: room.guests.map(g=>({name:g.name,index:g.index})), reconnected: true });
      io.to(room.hostSocketId).emit('guest_reconnected', { guestName: existingGuest.name, guestIndex: existingGuest.index, guestSocketId: socket.id });
      io.to(room.hostSocketId).emit('room_updated', { guests: room.guests.map(g=>({name:g.name,index:g.index,socketId:g.socketId,ready:g.ready||false})) });
      return;
    }
    const guestIndex = room.guests.length;
    room.guests.push({ socketId: socket.id, name: displayName||`Guest ${guestIndex+1}`, index: guestIndex, ready: false, disconnected: false, _disconnectTimer: null });
    socket.join(code);
    socket.emit('room_joined', { code, hostName: room.hostName, guestIndex, guests: room.guests.map(g=>({name:g.name,index:g.index})) });
    io.to(room.hostSocketId).emit('room_updated', { guests: room.guests.map(g=>({name:g.name,index:g.index,socketId:g.socketId,ready:g.ready||false})) });
    socket.to(code).emit('room_updated', { guests: room.guests.map(g=>({name:g.name,index:g.index})) });
  });
  socket.on('game_state', (state) => {
    const roomCode = Object.keys(rooms).find(c => rooms[c].hostSocketId === socket.id);
    if (roomCode) socket.to(roomCode).emit('game_state', state);
  });
  socket.on('trade_window_open', ({ bid, ask, makerId }) => {
    const roomCode = Object.keys(rooms).find(c => rooms[c].hostSocketId === socket.id);
    if (roomCode) openRoomTradeWindow(rooms[roomCode], { bid, ask, makerId });
  });
  socket.on('bot_trade_now', ({ playerIdx, action, volume }) => {
    const roomCode = Object.keys(rooms).find(c => rooms[c].hostSocketId === socket.id);
    if (roomCode) adjudicateTrade(roomCode, rooms[roomCode], socket, 'bot', { playerIdx, action, volume });
  });
  socket.on('host_trade_now', () => {
    const roomCode = Object.keys(rooms).find(c => rooms[c].hostSocketId === socket.id);
    if (roomCode) adjudicateTrade(roomCode, rooms[roomCode], socket, 'host_human', {});
  });
  socket.on('trade_window_close', () => {
    const roomCode = Object.keys(rooms).find(c => rooms[c].hostSocketId === socket.id);
    if (!roomCode) return;
    const room = rooms[roomCode];
    if (room.tradeWindow && room.tradeWindow.active) { room.guests.forEach(g => { io.to(g.socketId).emit('host_response', { type: 'trade_lost' }); }); closeRoomTradeWindow(room); }
  });
  socket.on('guest_action', (action) => {
    const roomCode = Object.keys(rooms).find(c => rooms[c].guests.some(g => g.socketId === socket.id));
    if (!roomCode) return;
    const room = rooms[roomCode]; const guest = room.guests.find(g => g.socketId === socket.id);
    if (action.type === 'set_ready') { guest.ready = action.ready; io.to(room.hostSocketId).emit('room_updated', { guests: room.guests.map(g=>({name:g.name,index:g.index,socketId:g.socketId,ready:g.ready||false})) }); return; }
    if (action.type === 'trade_now') { adjudicateTrade(roomCode, room, socket, 'guest', { guestName: guest.name }); return; }
    io.to(room.hostSocketId).emit('guest_action', { ...action, guestSocketId: socket.id, guestIndex: guest.index, guestName: guest.name });
  });
  socket.on('host_response', ({ guestSocketId, data }) => { io.to(guestSocketId).emit('host_response', data); });
  socket.on('remove_guest', ({ guestSocketId }) => {
    const roomCode = Object.keys(rooms).find(c => rooms[c].hostSocketId === socket.id);
    if (!roomCode) return;
    const room = rooms[roomCode]; const guest = room.guests.find(g => g.socketId === guestSocketId);
    if (!guest) return;
    if (guest._disconnectTimer) clearTimeout(guest._disconnectTimer);
    room.guests = room.guests.filter(g => g.socketId !== guestSocketId);
    io.to(guestSocketId).emit('host_response', { type: 'kicked' });
    io.to(room.hostSocketId).emit('room_updated', { guests: room.guests.map(g=>({name:g.name,index:g.index,socketId:g.socketId,ready:g.ready||false})) });
  });
  socket.on('chat', ({ message }) => {
    const roomCode = Object.keys(rooms).find(c => { const r = rooms[c]; return r.hostSocketId === socket.id || r.guests.some(g => g.socketId === socket.id); });
    if (!roomCode) return;
    const room = rooms[roomCode]; let senderName = 'Unknown';
    if (room.hostSocketId === socket.id) senderName = room.hostName;
    else { const g = room.guests.find(g => g.socketId === socket.id); if (g) senderName = g.name; }
    io.to(roomCode).emit('chat', { name: senderName, message, ts: new Date().toISOString() });
  });
  socket.on('disconnect', () => {
    const roomCode = Object.keys(rooms).find(c => rooms[c].hostSocketId === socket.id);
    if (roomCode) {
      const room = rooms[roomCode];
      room.hostDisconnectTimer = setTimeout(() => { if (rooms[roomCode]) { io.to(roomCode).emit('host_disconnected'); delete rooms[roomCode]; } }, HOST_GRACE_MS);
      socket.to(roomCode).emit('host_temporarily_disconnected'); return;
    }
    const guestRoomCode = Object.keys(rooms).find(c => rooms[c].guests.some(g => g.socketId === socket.id));
    if (guestRoomCode) {
      const room = rooms[guestRoomCode]; const guest = room.guests.find(g => g.socketId === socket.id);
      if (!guest) return; guest.disconnected = true; const guestName = guest.name;
      io.to(room.hostSocketId).emit('guest_temporarily_disconnected', { guestName, guestIndex: guest.index });
      guest._disconnectTimer = setTimeout(() => {
        const r = rooms[guestRoomCode]; if (!r) return;
        r.guests = r.guests.filter(g => g.name !== guestName);
        io.to(r.hostSocketId).emit('guest_left', { guestName });
        io.to(r.hostSocketId).emit('room_updated', { guests: r.guests.map(g=>({name:g.name,index:g.index,socketId:g.socketId,ready:g.ready||false})) });
      }, GUEST_GRACE_MS);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Market Maker server running on port ${PORT}`); });
