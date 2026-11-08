(() => {
  const $ = id => document.getElementById(id);
  const socket = io({ transports: ['websocket', 'polling'] });

  let ICE = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
  };
  fetch('/ice').then(r => r.json()).then(c => { if (c && c.iceServers) ICE = c; }).catch(() => {});

  const RELAY_AFTER_MS = 7000; // doğrudan bağlantı bu sürede kurulmazsa sunucu yoluna geç

  // ---------- Durum ----------
  let myStream = null;          // paylaştığım ekran
  const sharePeers = new Map(); // viewerId -> RTCPeerConnection (paylaşan taraf)
  let watchPeer = null;         // izleyici tarafı bağlantı
  let watchingId = null;
  let relayMode = false;        // görüntü sunucu üzerinden mi geliyor
  let relayTimer = null;
  let userClosed = false;       // kullanıcı izlemeyi bilerek kapattıysa otomatik açma
  let sharers = [];
  const pendingIce = new Map(); // peerId -> [candidates]

  // ---------- İsim ----------
  const nameInput = $('name');
  try { nameInput.value = localStorage.getItem('ekran-ad') || ''; } catch {}
  nameInput.addEventListener('change', () => {
    try { localStorage.setItem('ekran-ad', nameInput.value.trim()); } catch {}
  });

  // ---------- Destek kontrolü ----------
  const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  if (!canShare) {
    $('shareBtn').disabled = true;
    $('support').textContent = 'Bu cihaz ekran paylaşmayı desteklemiyor (telefon tarayıcıları izin vermiyor). Bilgisayardan paylaş, buradan izleyebilirsin.';
  }

  // ---------- Bağlantı ----------
  socket.on('connect', () => {
    $('conn').classList.add('on');
    if (myStream) socket.emit('start-share', { name: nameInput.value });
    // Bağlantı koptuysa ve bir ekranı izliyorsak, kaldığımız yerden devam et
    if (watchingId) watch(watchingId, true);
  });
  socket.on('disconnect', () => $('conn').classList.remove('on'));

  socket.on('sharers', list => {
    sharers = list;
    renderList();
    const me = list.find(s => s.id === socket.id);
    if (me) $('viewerCount').textContent = `${me.viewers} kişi izliyor`;
    autoWatch();
  });

  // ---------- Liste ----------
  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'az önce';
    const m = Math.round(s / 60);
    return m < 60 ? `${m} dk önce` : `${Math.round(m / 60)} sa önce`;
  }

  function renderList() {
    const el = $('list');
    el.innerHTML = '';
    const others = sharers.filter(s => s.id !== socket.id);
    if (!others.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = myStream ? 'Senden başka paylaşan yok.' : 'Şu an kimse ekran paylaşmıyor. İlk sen paylaş!';
      el.appendChild(d);
      return;
    }
    for (const s of others) {
      const b = document.createElement('button');
      b.className = 'card' + (s.id === watchingId ? ' active' : '');
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = s.name;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${ago(s.startedAt)} başladı · ${s.viewers} izleyici`;
      b.append(who, meta);
      b.onclick = () => { userClosed = false; watch(s.id, true); };
      el.appendChild(b);
    }
  }
  setInterval(renderList, 30000);

  function autoWatch() {
    if (myStream || userClosed) return;
    if (watchingId && sharers.some(s => s.id === watchingId)) return;
    const others = sharers.filter(s => s.id !== socket.id);
    if (others.length) watch(others[others.length - 1].id);
  }

  // ---------- Paylaşma ----------
  $('shareBtn').onclick = async () => {
    try {
      myStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: true
      });
    } catch (e) {
      myStream = null;
      return; // kullanıcı iptal etti
    }
    const vt = myStream.getVideoTracks()[0];
    if (vt && 'contentHint' in vt) vt.contentHint = 'detail';
    vt.addEventListener('ended', stopShare);

    stopWatching(true);
    $('localVideo').srcObject = myStream;
    $('mine').classList.add('show');
    $('shareBtn').disabled = true;
    socket.emit('start-share', { name: nameInput.value });
  };

  $('stopBtn').onclick = stopShare;

  function stopShare() {
    if (!myStream) return;
    myStream.getTracks().forEach(t => t.stop());
    myStream = null;
    relayCount = 0;
    tick(0);
    for (const pc of sharePeers.values()) pc.close();
    sharePeers.clear();
    $('localVideo').srcObject = null;
    $('mine').classList.remove('show');
    $('shareBtn').disabled = !canShare;
    socket.emit('stop-share');
    userClosed = false;
    autoWatch();
  }

  socket.on('viewer-joined', async ({ viewerId }) => {
    if (!myStream) return;
    sharePeers.get(viewerId)?.close();
    const pc = new RTCPeerConnection(ICE);
    sharePeers.set(viewerId, pc);
    myStream.getTracks().forEach(t => pc.addTrack(t, myStream));
    pc.onicecandidate = e => e.candidate && socket.emit('signal', { to: viewerId, data: { ice: e.candidate } });
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        pc.close();
        if (sharePeers.get(viewerId) === pc) sharePeers.delete(viewerId);
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { to: viewerId, data: { sdp: pc.localDescription } });
    // Yüksek kalite için bit hızını artır
    try {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'video') continue;
        const p = sender.getParameters();
        p.encodings = p.encodings?.length ? p.encodings : [{}];
        p.encodings[0].maxBitrate = 4_000_000;
        await sender.setParameters(p);
      }
    } catch {}
  });

  socket.on('viewer-left', ({ viewerId }) => {
    sharePeers.get(viewerId)?.close();
    sharePeers.delete(viewerId);
  });

  // ---------- Yedek yol: kareleri sunucu üzerinden gönder (paylaşan taraf) ----------
  // Sekme arka plandayken de düzgün çalışsın diye zamanlayıcı bir Worker'da.
  let relayCount = 0;
  let relayBusy = false;
  const ticker = new Worker(URL.createObjectURL(new Blob(
    ['let t;onmessage=e=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)}'],
    { type: 'text/javascript' })));
  const tick = ms => ticker.postMessage(ms);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let grabber = null;

  socket.on('relay-count', ({ n }) => {
    relayCount = n;
    if (myStream && n > 0) {
      const track = myStream.getVideoTracks()[0];
      grabber = ('ImageCapture' in window && track) ? new ImageCapture(track) : null;
      tick(100); // en fazla ~10 kare/sn
    } else tick(0);
  });

  ticker.onmessage = async () => {
    if (relayBusy || !myStream || relayCount <= 0) return;
    relayBusy = true;
    try {
      let src = null, w = 0, h = 0;
      if (grabber) {
        try { src = await grabber.grabFrame(); w = src.width; h = src.height; } catch { src = null; }
      }
      if (!src) {
        const lv = $('localVideo');
        src = lv; w = lv.videoWidth; h = lv.videoHeight;
      }
      if (w && h) {
        const sc = Math.min(1, 1600 / w);
        canvas.width = Math.round(w * sc);
        canvas.height = Math.round(h * sc);
        ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
        if (src.close) src.close();
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.65));
        if (blob) {
          const buf = await blob.arrayBuffer();
          await new Promise(r => {
            const to = setTimeout(r, 3000);
            socket.emit('frame', buf, () => { clearTimeout(to); r(); });
          });
        }
      }
    } catch {}
    relayBusy = false;
  };

  // ---------- İzleme ----------
  const video = $('remoteVideo');
  const img = $('relayImg');

  function watch(sharerId, force) {
    if (!force && sharerId === watchingId && (watchPeer || relayMode)) return;
    teardownWatch();
    watchingId = sharerId;
    const s = sharers.find(x => x.id === sharerId);
    $('watchName').textContent = s ? s.name : 'Ekran';
    setStatus('Bağlanıyor…');
    $('viewer').classList.add('show');
    resetView();
    socket.emit('watch', { sharerId });
    relayTimer = setTimeout(() => {
      if (!watchPeer || watchPeer.connectionState !== 'connected') startRelay();
    }, RELAY_AFTER_MS);
    renderList();
  }

  function teardownWatch() {
    clearTimeout(relayTimer);
    if (watchPeer) { watchPeer.close(); watchPeer = null; }
    relayMode = false;
    imgLoading = false;
    video.srcObject = null;
    video.style.display = '';
    img.style.display = 'none';
    img.removeAttribute('src');
    if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
    $('soundBtn').disabled = false;
    $('mode').textContent = '';
  }

  function stopWatching(notify) {
    teardownWatch();
    if (watchingId && notify !== false) socket.emit('unwatch');
    watchingId = null;
    $('viewer').classList.remove('show', 'pseudo-fs');
    document.body.classList.remove('noscroll');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    renderList();
  }

  function setStatus(t) {
    const el = $('vstatus');
    el.textContent = t || '';
    el.style.display = t ? '' : 'none';
  }

  function startRelay() {
    if (relayMode || !watchingId) return;
    clearTimeout(relayTimer);
    if (watchPeer) { watchPeer.close(); watchPeer = null; }
    relayMode = true;
    video.srcObject = null;
    video.style.display = 'none';
    img.style.display = '';
    $('soundBtn').disabled = true; // yedek yolda ses yok
    $('mode').textContent = 'Sunucu üzerinden';
    setStatus('Doğrudan bağlantı kurulamadı, sunucu üzerinden bağlanılıyor…');
    socket.emit('relay-on', { sharerId: watchingId });
  }

  // Yedek yoldan gelen kareler
  let lastUrl = null, imgLoading = false;
  socket.on('frame', buf => {
    if (!relayMode || imgLoading) return; // önceki kare yüklenmeden yenisini atla
    imgLoading = true;
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
    img.onload = () => {
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = url;
      imgLoading = false;
      setStatus('');
      layout();
    };
    img.onerror = () => { URL.revokeObjectURL(url); imgLoading = false; };
    img.src = url;
  });

  $('closeBtn').onclick = () => { userClosed = true; stopWatching(true); };

  socket.on('share-ended', ({ sharerId }) => {
    if (sharerId !== watchingId) return;
    stopWatching(false);
    autoWatch();
  });

  socket.on('signal', async ({ from, data }) => {
    // Paylaşan taraf: izleyiciden gelen cevap / ice
    const sp = sharePeers.get(from);
    if (sp) {
      if (data.sdp) {
        await sp.setRemoteDescription(data.sdp);
        flushIce(from, sp);
      } else if (data.ice) addIce(from, sp, data.ice);
      return;
    }
    // İzleyici taraf: paylaşandan gelen teklif / ice
    if (from !== watchingId || relayMode) return;
    if (data.sdp && data.sdp.type === 'offer') {
      if (watchPeer) watchPeer.close();
      const pc = new RTCPeerConnection(ICE);
      watchPeer = pc;
      pc.ontrack = e => {
        if (video.srcObject !== e.streams[0]) video.srcObject = e.streams[0];
        video.play().catch(() => {});
      };
      pc.onicecandidate = e => e.candidate && socket.emit('signal', { to: from, data: { ice: e.candidate } });
      pc.onconnectionstatechange = () => {
        if (pc !== watchPeer) return;
        if (pc.connectionState === 'connected') clearTimeout(relayTimer);
        if (pc.connectionState === 'failed') startRelay();
      };
      await pc.setRemoteDescription(data.sdp);
      flushIce(from, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
    } else if (data.ice && watchPeer) {
      addIce(from, watchPeer, data.ice);
    }
  });

  function addIce(id, pc, c) {
    if (pc.remoteDescription) pc.addIceCandidate(c).catch(() => {});
    else {
      if (!pendingIce.has(id)) pendingIce.set(id, []);
      pendingIce.get(id).push(c);
    }
  }
  function flushIce(id, pc) {
    for (const c of pendingIce.get(id) || []) pc.addIceCandidate(c).catch(() => {});
    pendingIce.delete(id);
  }

  // ---------- Görüntü kontrolleri (sığdır / doldur / 1:1, yakınlaş, kaydır) ----------
  const stage = $('stage');
  const view = { fit: 'contain', zoom: 1, x: 0, y: 0 };

  function layout() {
    const el = relayMode ? img : video;
    const vw = relayMode ? img.naturalWidth : video.videoWidth;
    const vh = relayMode ? img.naturalHeight : video.videoHeight;
    if (!vw || !vh) return;
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const base = view.fit === 'cover' ? Math.max(sw / vw, sh / vh)
               : view.fit === 'actual' ? 1 / (window.devicePixelRatio || 1)
               : Math.min(sw / vw, sh / vh);
    const w = vw * base * view.zoom, h = vh * base * view.zoom;
    const mx = Math.max(0, (w - sw) / 2), my = Math.max(0, (h - sh) / 2);
    view.x = Math.min(mx, Math.max(-mx, view.x));
    view.y = Math.min(my, Math.max(-my, view.y));
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    el.style.transform = `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))`;
    $('zoomVal').textContent = Math.round(view.zoom * 100) + '%';
  }

  function resetView() { view.zoom = 1; view.x = 0; view.y = 0; layout(); }
  function setZoom(z) { view.zoom = Math.min(8, Math.max(0.25, z)); layout(); }

  video.addEventListener('loadedmetadata', () => { setStatus(''); layout(); });
  video.addEventListener('resize', layout);
  window.addEventListener('resize', layout);
  document.addEventListener('fullscreenchange', () => setTimeout(layout, 50));

  document.querySelectorAll('[data-fit]').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('[data-fit]').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
      view.fit = b.dataset.fit;
      resetView();
    };
  });
  $('zoomIn').onclick = () => setZoom(view.zoom * 1.25);
  $('zoomOut').onclick = () => setZoom(view.zoom / 1.25);

  $('soundBtn').onclick = () => {
    video.muted = !video.muted;
    $('soundBtn').textContent = video.muted ? '🔇 Ses' : '🔊 Ses';
    video.play().catch(() => {});
  };

  $('fsBtn').onclick = () => {
    const el = $('viewer');
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    if (el.classList.contains('pseudo-fs')) {
      el.classList.remove('pseudo-fs');
      document.body.classList.remove('noscroll');
    } else if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    } else {
      // iPhone: gerçek tam ekran sadece videoya izin veriyor; kontroller kalsın diye sayfayı kaplıyoruz
      el.classList.add('pseudo-fs');
      document.body.classList.add('noscroll');
    }
    setTimeout(layout, 50);
  };

  stage.addEventListener('wheel', e => {
    e.preventDefault();
    setZoom(view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  stage.addEventListener('dblclick', () => (view.zoom > 1 ? resetView() : setZoom(2)));

  const pointers = new Map();
  let pinchStart = null;
  stage.addEventListener('pointerdown', e => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.classList.add('drag');
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), z: view.zoom };
    }
  });
  stage.addEventListener('pointermove', e => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      setZoom(pinchStart.z * Math.hypot(a.x - b.x, a.y - b.y) / pinchStart.d);
    } else if (pointers.size === 1) {
      view.x += cur.x - prev.x;
      view.y += cur.y - prev.y;
      layout();
    }
  });
  const up = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (!pointers.size) stage.classList.remove('drag');
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
})();
