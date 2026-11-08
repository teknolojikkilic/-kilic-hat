const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
// Yedek yolda JPEG kareleri bu bağlantıdan geçiyor.
// destroyUpgrade:false -> /agent WebSocket bağlantılarını socket.io kapatmasın
const io = new Server(server, { maxHttpBufferSize: 3e6, destroyUpgrade: false });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

// ICE sunucuları. TURN istersen Render'da şu ortam değişkenlerini gir:
//   TURN_URLS        virgülle ayrılmış, örn: turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443?transport=tcp
//   TURN_USERNAME    kullanıcı adı
//   TURN_CREDENTIAL  şifre
app.get('/ice', (_req, res) => {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];
  const urls = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (urls.length) {
    iceServers.push({
      urls,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }
  res.set('Cache-Control', 'no-store').json({ iceServers });
});

// ---------- Windows kontrol programı indirme ----------
const TOKEN_RE = /^[a-f0-9]{32}$/;
const agentTemplate = fs.readFileSync(path.join(__dirname, 'agent', 'kontrol.ps1'), 'utf8');

function agentScript(req, token) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const wsUrl = `${proto === 'https' ? 'wss' : 'ws'}://${req.headers.host}/agent`;
  return agentTemplate.replace(/__WSURL__/g, wsUrl).replace(/__TOKEN__/g, token);
}

app.get('/kontrol.ps1', (req, res) => {
  const t = String(req.query.t || '');
  if (!TOKEN_RE.test(t)) return res.status(400).send('Geçersiz bağlantı');
  res.set('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send(agentScript(req, t));
});

app.get('/kontrol.bat', (req, res) => {
  const t = String(req.query.t || '');
  if (!TOKEN_RE.test(t)) return res.status(400).send('Geçersiz bağlantı');
  // .bat + PowerShell tek dosyada: cmd ilk bloğu çalıştırır, PowerShell dosyanın tamamını okur
  const header = [
    '<# :',
    '@echo off',
    'title Ekran Paylas - Uzaktan Kontrol',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText(\'%~f0\', [Text.Encoding]::UTF8))"',
    'echo.',
    'pause',
    'exit /b',
    '#>',
    ''
  ].join('\n');
  const body = (header + agentScript(req, t)).replace(/\r?\n/g, '\r\n');
  res.set({
    'Cache-Control': 'no-store',
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="ekran-kontrol.bat"'
  }).send(Buffer.from(body, 'utf8')); // BOM yok: cmd ilk satırı bozulmadan okusun
});

// ---------- Durum ----------
// sharers: socketId -> { id, name, startedAt, viewers:Set, relay:Set, token, w, h, surface,
//                        autoAllow, controllers:Set, pending:Set }
const sharers = new Map();
const agents = new Map(); // token -> ws

function publicList() {
  return [...sharers.values()].map(s => ({
    id: s.id,
    name: s.name,
    startedAt: s.startedAt,
    viewers: s.viewers.size,
    control: hasAgent(s)
  }));
}

function broadcastList() {
  io.emit('sharers', publicList());
}

function cleanName(n) {
  const s = String(n || '').replace(/[<>]/g, '').trim().slice(0, 30);
  return s || 'Misafir';
}

function hasAgent(s) {
  const a = s && s.token && agents.get(s.token);
  return !!(a && a.readyState === 1);
}

function toAgent(s, msg) {
  const a = s && s.token && agents.get(s.token);
  if (a && a.readyState === 1) a.send(JSON.stringify(msg));
}

function nameOf(id) {
  const so = io.sockets.sockets.get(id);
  return (so && so.data.name) || 'Misafir';
}

function sendControlInfo(s) {
  io.to(s.id).emit('control-info', {
    agent: hasAgent(s),
    surface: s.surface || '',
    controllers: [...s.controllers].map(id => ({ id, name: nameOf(id) })),
    pending: [...s.pending].map(id => ({ id, name: nameOf(id) }))
  });
}

function setControl(viewerId, state, msg) {
  io.to(viewerId).emit('control-state', { state, msg: msg || '' });
}

function dropControl(s, viewerId, state, msg) {
  const had = s.controllers.delete(viewerId);
  const wasPending = s.pending.delete(viewerId);
  if (wasPending) toAgent(s, { t: 'close-ask', id: viewerId });
  if (had) toAgent(s, { t: 'info', s: `${nameOf(viewerId)} kontrolü bıraktı.` });
  if (state) setControl(viewerId, state, msg);
  if (had || wasPending) sendControlInfo(s);
}

function decide(s, viewerId, allow) {
  if (!s.pending.has(viewerId)) return;
  s.pending.delete(viewerId);
  toAgent(s, { t: 'close-ask', id: viewerId });
  if (allow && hasAgent(s)) {
    s.controllers.add(viewerId);
    setControl(viewerId, 'on');
    toAgent(s, { t: 'info', s: `${nameOf(viewerId)} kontrolü aldı.` });
  } else {
    setControl(viewerId, 'denied', 'Kontrol isteği reddedildi.');
  }
  sendControlInfo(s);
}

function leaveAsViewer(socket) {
  const target = socket.data.watching;
  if (!target) return;
  const s = sharers.get(target);
  if (s) {
    s.viewers.delete(socket.id);
    if (s.relay.delete(socket.id)) sendRelayCount(s);
    dropControl(s, socket.id);
    io.to(target).emit('viewer-left', { viewerId: socket.id });
  }
  socket.data.watching = null;
}

function sendRelayCount(s) {
  io.to(s.id).emit('relay-count', { n: s.relay.size });
}

function stopSharing(socket) {
  const s = sharers.get(socket.id);
  if (!s) return;
  for (const id of s.pending) toAgent(s, { t: 'close-ask', id });
  if (s.controllers.size) toAgent(s, { t: 'info', s: 'Paylaşım bitti, kontrol kapandı.' });
  for (const v of s.viewers) io.to(v).emit('share-ended', { sharerId: socket.id });
  sharers.delete(socket.id);
  broadcastList();
}

function sharersWithToken(token) {
  return [...sharers.values()].filter(s => s.token === token);
}

// Kontrol programından gelen girdiyi doğrula, sadece bilinen alanları geçir
function cleanInput(m) {
  if (!m || typeof m !== 'object') return null;
  const n = (v, a, b) => Math.min(b, Math.max(a, Number(v) || 0));
  const btn = [0, 1, 2].includes(m.b) ? m.b : 0;
  switch (m.t) {
    case 'move': return { t: 'move', x: n(m.x, 0, 1), y: n(m.y, 0, 1) };
    case 'down':
    case 'up': return { t: m.t, b: btn, x: n(m.x, 0, 1), y: n(m.y, 0, 1) };
    case 'click': return { t: 'click', b: btn, n: m.n === 2 ? 2 : 1, x: n(m.x, 0, 1), y: n(m.y, 0, 1) };
    case 'wheel': return { t: 'wheel', dy: Math.round(n(m.dy, -2400, 2400)), dx: Math.round(n(m.dx, -2400, 2400)) };
    case 'text': return typeof m.s === 'string' && m.s ? { t: 'text', s: m.s.slice(0, 500) } : null;
    case 'key':
      return typeof m.k === 'string' && m.k ? {
        t: 'key', k: m.k.slice(0, 24), c: String(m.c || '').slice(0, 24),
        ctrl: !!m.ctrl, alt: !!m.alt, shift: !!m.shift, meta: !!m.meta
      } : null;
  }
  return null;
}

io.on('connection', socket => {
  socket.data.name = 'Misafir';
  socket.emit('sharers', publicList());

  socket.on('start-share', ({ name, token, w, h, surface, autoAllow } = {}) => {
    leaveAsViewer(socket);
    socket.data.name = cleanName(name);
    const s = {
      id: socket.id,
      name: socket.data.name,
      startedAt: Date.now(),
      viewers: new Set(),
      relay: new Set(),
      token: TOKEN_RE.test(String(token || '')) ? token : null,
      w: Number(w) || 0,
      h: Number(h) || 0,
      surface: String(surface || '').slice(0, 20),
      autoAllow: !!autoAllow,
      controllers: new Set(),
      pending: new Set()
    };
    sharers.set(socket.id, s);
    toAgent(s, { t: 'meta', w: s.w, h: s.h });
    sendControlInfo(s);
    broadcastList();
  });

  socket.on('share-settings', ({ autoAllow } = {}) => {
    const s = sharers.get(socket.id);
    if (!s) return;
    s.autoAllow = !!autoAllow;
    if (s.autoAllow) for (const id of [...s.pending]) decide(s, id, true);
  });

  socket.on('stop-share', () => stopSharing(socket));

  socket.on('watch', ({ sharerId, name } = {}) => {
    if (sharerId === socket.id) return;
    if (name !== undefined) socket.data.name = cleanName(name);
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

  // ---------- Uzaktan kontrol ----------
  socket.on('control-request', ({ name } = {}) => {
    const s = sharers.get(socket.data.watching);
    if (!s) return;
    if (name !== undefined) socket.data.name = cleanName(name);
    if (s.controllers.has(socket.id)) return setControl(socket.id, 'on');
    if (!hasAgent(s)) {
      return setControl(socket.id, 'noagent',
        'Paylaşan bilgisayarda kontrol programı çalışmıyor. Paylaşan kişi sayfadaki "Kontrol programını indir"i açmalı.');
    }
    if (s.surface && s.surface !== 'monitor') {
      return setControl(socket.id, 'noagent',
        'Paylaşan kişi tüm ekranı değil bir pencere/sekme paylaşıyor. Kontrol için "Tüm ekran" paylaşılmalı.');
    }
    s.pending.add(socket.id);
    if (s.autoAllow) return decide(s, socket.id, true);
    setControl(socket.id, 'waiting', 'İzin bekleniyor…');
    toAgent(s, { t: 'ask', id: socket.id, name: socket.data.name });
    sendControlInfo(s);
  });

  socket.on('control-release', () => {
    const s = sharers.get(socket.data.watching);
    if (s) dropControl(s, socket.id, 'off');
  });

  socket.on('control-decision', ({ viewerId, allow } = {}) => {
    const s = sharers.get(socket.id);
    if (s) decide(s, viewerId, !!allow);
  });

  socket.on('control-revoke', ({ viewerId } = {}) => {
    const s = sharers.get(socket.id);
    if (s) dropControl(s, viewerId, 'off', 'Paylaşan kişi kontrolü kapattı.');
  });

  socket.on('input', msg => {
    const s = sharers.get(socket.data.watching);
    if (!s || !s.controllers.has(socket.id)) return;
    const clean = cleanInput(msg);
    if (clean) toAgent(s, clean);
  });

  // ---------- Yedek görüntü yolu ----------
  socket.on('relay-on', ({ sharerId } = {}) => {
    const s = sharers.get(sharerId);
    if (!s || socket.data.watching !== sharerId) return;
    s.relay.add(socket.id);
    sendRelayCount(s);
  });

  socket.on('frame', (buf, ack) => {
    const s = sharers.get(socket.id);
    if (s && s.relay.size && buf) io.to([...s.relay]).volatile.emit('frame', buf);
    if (typeof ack === 'function') ack();
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

// ---------- Kontrol programı bağlantısı (düz WebSocket: /agent) ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, sock, head) => {
  if ((req.url || '').split('?')[0] !== '/agent') return; // socket.io kendi yolunu yönetiyor
  wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
});

function agentChanged(token) {
  for (const s of sharersWithToken(token)) {
    if (!hasAgent(s)) {
      for (const id of [...s.controllers]) setControl(id, 'off', 'Kontrol programı kapandı.');
      for (const id of [...s.pending]) setControl(id, 'off', 'Kontrol programı kapandı.');
      s.controllers.clear();
      s.pending.clear();
    } else {
      toAgent(s, { t: 'meta', w: s.w, h: s.h });
    }
    sendControlInfo(s);
  }
  broadcastList();
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const helloTimer = setTimeout(() => ws.close(4001, 'hello yok'), 10000);

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.t === 'hello') {
      if (!TOKEN_RE.test(String(m.token || ''))) return ws.close(4002, 'token');
      clearTimeout(helloTimer);
      const old = agents.get(m.token);
      if (old && old !== ws) { old.replaced = true; old.close(4003, 'yeni program bağlandı'); }
      ws.token = m.token;
      agents.set(m.token, ws);
      const live = sharersWithToken(m.token).length > 0;
      ws.send(JSON.stringify({
        t: 'info',
        s: live ? 'Paylaşım bulundu, kontrol istekleri bekleniyor.'
                : 'Sayfada "Ekranımı Paylaş" ile tüm ekranı paylaşınca kontrol istekleri gelecek.'
      }));
      agentChanged(m.token);
      return;
    }
    if (!ws.token) return;
    if (m.t === 'answer') {
      for (const s of sharersWithToken(ws.token)) decide(s, String(m.id || ''), !!m.allow);
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (ws.token && agents.get(ws.token) === ws) {
      agents.delete(ws.token);
      agentChanged(ws.token);
    }
  });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ekran paylaşma ${PORT} portunda çalışıyor`));
