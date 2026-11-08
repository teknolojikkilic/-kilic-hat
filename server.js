const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Aktif paylaşımlar: socketId -> { id, name, startedAt, viewers:Set }
const sharers = new Map();

function publicList() {
  return [...sharers.values()].map(s => ({
    id: s.id,
    name: s.name,
    startedAt: s.startedAt,
    viewers: s.viewers.size
  }));
}

function broadcastList() {
  io.emit('sharers', publicList());
}

function cleanName(n) {
  const s = String(n || '').replace(/[<>]/g, '').trim().slice(0, 30);
  return s || 'Misafir';
}

function leaveAsViewer(socket) {
  const target = socket.data.watching;
  if (!target) return;
  const s = sharers.get(target);
  if (s) {
    s.viewers.delete(socket.id);
    io.to(target).emit('viewer-left', { viewerId: socket.id });
  }
  socket.data.watching = null;
}

function stopSharing(socket) {
  const s = sharers.get(socket.id);
  if (!s) return;
  for (const v of s.viewers) io.to(v).emit('share-ended', { sharerId: socket.id });
  sharers.delete(socket.id);
  broadcastList();
}

io.on('connection', socket => {
  socket.emit('sharers', publicList());

  socket.on('start-share', ({ name } = {}) => {
    leaveAsViewer(socket);
    sharers.set(socket.id, {
      id: socket.id,
      name: cleanName(name),
      startedAt: Date.now(),
      viewers: new Set()
    });
    broadcastList();
  });

  socket.on('stop-share', () => stopSharing(socket));

  socket.on('watch', ({ sharerId } = {}) => {
    if (sharerId === socket.id) return;
    leaveAsViewer(socket);
    const s = sharers.get(sharerId);
    if (!s) {
      socket.emit('share-ended', { sharerId });
      return;
    }
    s.viewers.add(socket.id);
    socket.data.watching = sharerId;
    io.to(sharerId).emit('viewer-joined', { viewerId: socket.id });
    broadcastList();
  });

  socket.on('unwatch', () => {
    leaveAsViewer(socket);
    broadcastList();
  });

  // WebRTC sinyal aktarımı (offer / answer / ice)
  socket.on('signal', ({ to, data } = {}) => {
    if (!to || !data) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    leaveAsViewer(socket);
    stopSharing(socket);
    broadcastList();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ekran paylaşma ${PORT} portunda çalışıyor`));
