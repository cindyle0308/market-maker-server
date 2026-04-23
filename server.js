const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 30000,
  pingInterval: 10000
});

// Serve static files from public directory
app.use(express.static('public'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: Object.keys(rooms).length });
});

// Room management
const rooms = {};

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
      guests: [],
      gamePhase: 'waiting',
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
      // Update socket ID — treat as reconnect
      const oldSocketId = existingGuest.socketId;
      existingGuest.socketId = socket.id;
      socket.join(code);
      console.log(`${displayName} reconnected to room ${code}`);

      socket.emit('room_joined', {
        code,
        hostName: room.hostName,
        guestIndex: existingGuest.index,
        guests: room.guests.map(g => ({ name: g.name, index: g.index })),
        reconnected: true
      });

      // Notify host of updated socket IDs
      io.to(room.hostSocketId).emit('room_updated', {
        guests: room.guests.map(g => ({ name: g.name, index: g.index, socketId: g.socketId }))
      });
      return;
    }

    // New guest joining
    const guestIndex = room.guests.length;
    room.guests.push({
      socketId: socket.id,
      name: displayName || `Guest ${guestIndex + 1}`,
      index: guestIndex
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

    // Notify host of new guest — include socketId so host can send private messages
    io.to(room.hostSocketId).emit('room_updated', {
      guests: room.guests.map(g => ({ name: g.name, index: g.index, socketId: g.socketId }))
    });

    // Notify other guests — no socketIds exposed to guests
    socket.to(code).emit('room_updated', {
      guests: room.guests.map(g => ({ name: g.name, index: g.index }))
    });
  });

  // GAME STATE — host broadcasts to guests
  socket.on('game_state', (state) => {
    // Find which room this socket belongs to
    const roomCode = Object.keys(rooms).find(code => {
      return rooms[code].hostSocketId === socket.id;
    });

    if (!roomCode) return;
    const room = rooms[roomCode];

    // Only host can broadcast state
    if (room.hostSocketId !== socket.id) return;

    // Forward to all guests in the room
    socket.to(roomCode).emit('game_state', state);
  });

  // GUEST ACTION — guest sends action, host receives
  socket.on('guest_action', (action) => {
    // Find which room this guest is in
    const roomCode = Object.keys(rooms).find(code => {
      return rooms[code].guests.some(g => g.socketId === socket.id);
    });

    if (!roomCode) return;
    const room = rooms[roomCode];
    const guest = room.guests.find(g => g.socketId === socket.id);

    // Send to host with guest metadata
    io.to(room.hostSocketId).emit('guest_action', {
      ...action,
      guestSocketId: socket.id,
      guestIndex: guest.index,
      guestName: guest.name
    });
  });

  // HOST RESPONSE — host responds to specific guest
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

    // Remove from room
    room.guests = room.guests.filter(g => g.socketId !== guestSocketId);

    // Notify the kicked guest
    io.to(guestSocketId).emit('host_response', { type: 'kicked' });

    // Send updated list to host
    io.to(room.hostSocketId).emit('room_updated', {
      guests: room.guests.map(g => ({ name: g.name, index: g.index, socketId: g.socketId }))
    });

    console.log(`${guest.name} removed from room ${roomCode} by host`);
  });

  // CHAT — broadcast to whole room
  socket.on('chat', ({ message }) => {
    // Find which room this socket belongs to
    const roomCode = Object.keys(rooms).find(code => {
      const room = rooms[code];
      return room.hostSocketId === socket.id || room.guests.some(g => g.socketId === socket.id);
    });

    if (!roomCode) return;
    const room = rooms[roomCode];

    // Determine sender name
    let senderName = 'Unknown';
    if (room.hostSocketId === socket.id) {
      senderName = room.hostName;
    } else {
      const guest = room.guests.find(g => g.socketId === socket.id);
      if (guest) senderName = guest.name;
    }

    // Broadcast to room
    io.to(roomCode).emit('chat', {
      name: senderName,
      message,
      ts: new Date().toISOString()
    });
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);

    // Check if this was a host
    const roomCode = Object.keys(rooms).find(code => {
      return rooms[code].hostSocketId === socket.id;
    });

    if (roomCode) {
      // Host disconnected — notify all guests and delete room
      io.to(roomCode).emit('host_disconnected');
      delete rooms[roomCode];
      console.log(`Room ${roomCode} deleted (host disconnected)`);
      return;
    }

    // Check if this was a guest
    const guestRoomCode = Object.keys(rooms).find(code => {
      return rooms[code].guests.some(g => g.socketId === socket.id);
    });

    if (guestRoomCode) {
      const room = rooms[guestRoomCode];
      const guest = room.guests.find(g => g.socketId === socket.id);
      const guestName = guest ? guest.name : 'A guest';

      // Remove guest from room
      room.guests = room.guests.filter(g => g.socketId !== socket.id);

      // Notify host
      io.to(room.hostSocketId).emit('guest_left', { guestName });

      // Also send updated room list so host can re-sync
      io.to(room.hostSocketId).emit('room_updated', {
        guests: room.guests.map(g => ({ name: g.name, index: g.index, socketId: g.socketId }))
      });

      console.log(`${guestName} left room ${guestRoomCode}`);
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
