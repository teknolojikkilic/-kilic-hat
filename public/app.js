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
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} }
  };

  // ---------- Durum ----------
  let myStream = null;          // paylaştığım ekran
  const sharePeers = new Map(); // viewerId -> RTCPeerConnection (paylaşan taraf)
  let watchPeer = null;         // izleyici tarafı bağlantı
  let watchingId = null;
  let relayMode = false;        // görüntü sunucu üzerinden mi geliyor
  let relayTimer = null;
  let myCode = null;            // paylaşırken aldığım 8 haneli kod
  let watchCode = null;         // izlediğim paylaşımın kodu
  let rejoinTimer = null;
  const pendingIce = new Map(); // peerId -> [candidates]

  // ---------- İsim ----------
  const nameInput = $('name');
  nameInput.value = store.get('ekran-ad') || '';
  nameInput.addEventListener('change', () => store.set('ekran-ad', nameInput.value.trim()));

  // ---------- Bu tarayıcının kontrol programı anahtarı ----------
  let token = store.get('ekran-token');
  if (!/^[a-f0-9]{32}$/.test(token || '')) {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    token = [...a].map(b => b.toString(16).padStart(2, '0')).join('');
    store.set('ekran-token', token);
  }
  $('agentDl').href = `/kontrol.bat?t=${token}`;
  const runCmd = `powershell -ep bypass -c "[Net.ServicePointManager]::SecurityProtocol='Tls12';irm '${location.origin}/kontrol.ps1?t=${token}'|iex"`;
  $('copyCmd').onclick = async () => {
    try {
      await navigator.clipboard.writeText(runCmd);
      $('copyCmd').textContent = 'Kopyalandı ✓ (Win+R → yapıştır → Enter)';
      setTimeout(() => { $('copyCmd').textContent = 'Komutu kopyala (Win+R)'; }, 4000);
    } catch {
      window.prompt('Bu komutu kopyala, Win+R ile açılan kutuya yapıştır ve Enter:', runCmd);
    }
  };

  const autoAllowBox = $('autoAllow');
  autoAllowBox.checked = store.get('ekran-auto') !== '0'; // varsayılan: kodu bilen sormadan kontrol eder
  autoAllowBox.onchange = () => {
    store.set('ekran-auto', autoAllowBox.checked ? '1' : '0');
    socket.emit('share-settings', { autoAllow: autoAllowBox.checked });
  };

  // ---------- Destek kontrolü ----------
  const canShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  if (!canShare) {
    $('shareBtn').disabled = true;
    $('support').textContent = 'Bu cihaz ekran paylaşmayı desteklemiyor (telefon tarayıcıları izin vermiyor). Bilgisayardan paylaş, buradan izleyip kontrol edebilirsin.';
  }

  // ---------- Bağlantı ----------
  socket.on('connect', () => {
    $('conn').classList.add('on');
    if (myStream) emitStartShare();
    // Bağlantı koptuysa ve bir ekranı izliyorsak, aynı kodla kaldığımız yerden devam et
    if (watchCode) join(watchCode, { silent: true });
  });
  socket.on('disconnect', () => $('conn').classList.remove('on'));

  // ---------- Kodla katıl ----------
  const codeInput = $('codeInput');
  const fmt = c => c.length > 4 ? c.slice(0, 4) + ' ' + c.slice(4) : c;
  codeInput.addEventListener('input', () => {
    const d = codeInput.value.replace(/\D/g, '').slice(0, 8);
    codeInput.value = fmt(d);
    $('joinErr').textContent = '';
    if (d.length === 8) join(d);
  });
  codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') join(codeInput.value); });
  $('joinBtn').onclick = () => join(codeInput.value);

  function join(raw, opts = {}) {
    const code = String(raw || '').replace(/\D/g, '');
    if (code.length !== 8) { $('joinErr').textContent = '8 haneli kodu gir.'; return; }
    if (myStream) { $('joinErr').textContent = 'Paylaşım açıkken izleyemezsin. Önce paylaşımı durdur.'; return; }
    clearTimeout(rejoinTimer);
    $('joinBtn').disabled = true;
    socket.emit('join', { code, name: nameInput.value }, res => {
      $('joinBtn').disabled = false;
      if (res && res.ok) {
        $('joinErr').textContent = '';
        watchCode = code;
        startWatching(res.sharerId, res.name);
        try { history.replaceState(null, '', '?kod=' + code); } catch {}
        return;
      }
      if (res && res.retry && (opts.tries || 0) < 20) {
        // Paylaşanın bağlantısı koptu; aynı kodla geri gelmesini bekle
        setStatus('Paylaşan yeniden bağlanıyor…');
        rejoinTimer = setTimeout(() => join(code, { silent: true, tries: (opts.tries || 0) + 1 }), 3000);
        return;
      }
      if (opts.silent) {
        stopWatching(false);
        toastOut('Paylaşım bitti.');
      }
      $('joinErr').textContent = (res && res.error) || 'Bağlanılamadı.';
    });
  }

  function toastOut(t) {
    $('joinErr').textContent = t;
  }

  // Linkle gelindiyse (?kod=12345678) doğrudan katıl
  const urlCode = (new URLSearchParams(location.search).get('kod') || '').replace(/\D/g, '');
  if (urlCode.length === 8) {
    codeInput.value = fmt(urlCode);
    if (socket.connected) join(urlCode); else socket.once('connect', () => { if (!watchCode) join(urlCode); });
  }

  // =====================================================================
  // PAYLAŞAN TARAF
  // =====================================================================
  function emitStartShare() {
    const st = (myStream.getVideoTracks()[0] || {}).getSettings ? myStream.getVideoTracks()[0].getSettings() : {};
    socket.emit('start-share', {
      name: nameInput.value,
      token,
      w: st.width || 0,
      h: st.height || 0,
      surface: st.displaySurface || '',
      autoAllow: autoAllowBox.checked,
      code: myCode // bağlantı kopup geldiyse aynı kodu iste
    }, res => {
      if (!res || !res.code) return;
      myCode = res.code;
      $('myCode').textContent = fmt(myCode);
    });
  }

  const shareLink = () => `${location.origin}/?kod=${myCode}`;
  async function copyText(t, btn, label) {
    try { await navigator.clipboard.writeText(t); btn.textContent = 'Kopyalandı ✓'; }
    catch { window.prompt('Kopyala:', t); }
    setTimeout(() => { btn.textContent = label; }, 2500);
  }
  $('copyCode').onclick = () => myCode && copyText(myCode, $('copyCode'), 'Kodu kopyala');
  $('copyLink').onclick = () => myCode && copyText(shareLink(), $('copyLink'), 'Linki kopyala');

  socket.on('viewers', ({ n, names }) => {
    $('viewerCount').textContent = n ? `${n} kişi izliyor: ${names.join(', ')}` : 'Henüz kimse izlemiyor';
  });

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
    myCode = null;
    $('myCode').textContent = '…';
    $('joinBox').hidden = true;
    $('localVideo').srcObject = myStream;
    $('mine').classList.add('show');
    $('shareBtn').disabled = true;
    emitStartShare();
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
    myCode = null;
    $('joinBox').hidden = false;
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

  // ---------- Uzaktan kontrol paneli (paylaşan) ----------
  socket.on('control-info', info => {
    $('agentDot').classList.toggle('on', info.agent);
    $('agentText').textContent = info.agent
      ? 'Kontrol programı bağlı — izin verdiğin kişi fare/klavyeyi kullanabilir'
      : 'Kontrol programı çalışmıyor';
    $('agentSetup').hidden = info.agent;
    $('surfaceWarn').hidden = !info.surface || info.surface === 'monitor';

    const reqs = $('ctrlRequests');
    reqs.innerHTML = '';
    for (const p of info.pending) {
      const d = document.createElement('div');
      d.className = 'req';
      const b = document.createElement('b');
      b.textContent = `${p.name} kontrol istiyor`;
      const yes = document.createElement('button');
      yes.className = 'btn btn-primary btn-sm';
      yes.textContent = 'İzin ver';
      yes.onclick = () => socket.emit('control-decision', { viewerId: p.id, allow: true });
      const no = document.createElement('button');
      no.className = 'btn btn-ghost btn-sm';
      no.textContent = 'Reddet';
      no.onclick = () => socket.emit('control-decision', { viewerId: p.id, allow: false });
      d.append(b, yes, no);
      reqs.appendChild(d);
    }

    const list = $('ctrlList');
    list.innerHTML = '';
    for (const c of info.controllers) {
      const d = document.createElement('div');
      d.className = 'ctl';
      const s = document.createElement('span');
      s.textContent = `🖱 ${c.name} kontrol ediyor`;
      const x = document.createElement('button');
      x.className = 'btn btn-danger btn-sm';
      x.textContent = 'Kes';
      x.onclick = () => socket.emit('control-revoke', { viewerId: c.id });
      d.append(s, x);
      list.appendChild(d);
    }
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

  // =====================================================================
  // İZLEYEN TARAF
  // =====================================================================
  const video = $('remoteVideo');
  const img = $('relayImg');

  // Sunucu kodu kabul ettikten sonra çağrılır; paylaşan bize bağlantı teklifini gönderir
  function startWatching(sharerId, name) {
    teardownWatch();
    watchingId = sharerId;
    $('watchName').textContent = name || 'Ekran';
    setStatus('Bağlanıyor…');
    $('viewer').classList.add('show');
    resetView();
    relayTimer = setTimeout(() => {
      if (!watchPeer || watchPeer.connectionState !== 'connected') startRelay();
    }, RELAY_AFTER_MS);
    setTimeout(() => $('viewer').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
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
    setCtrl('off');
  }

  function stopWatching(notify) {
    teardownWatch();
    if (watchingId && notify !== false) socket.emit('unwatch');
    watchingId = null;
    watchCode = null;
    clearTimeout(rejoinTimer);
    $('viewer').classList.remove('show', 'pseudo-fs');
    document.body.classList.remove('noscroll');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    try { if (location.search) history.replaceState(null, '', location.pathname); } catch {}
  }

  function setStatus(t) {
    const el = $('vstatus');
    el.textContent = t || '';
    el.style.display = t ? '' : 'none';
  }

  let toastTimer = null;
  function toast(t, ms = 3500) {
    const el = $('toast');
    el.textContent = t;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
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
    socket.emit('relay-on');
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

  $('closeBtn').onclick = () => stopWatching(true);

  socket.on('share-ended', ({ sharerId, reconnecting }) => {
    if (sharerId !== watchingId) return;
    if (reconnecting && watchCode) {
      // Paylaşanın bağlantısı koptu: aynı kodla geri gelince otomatik devam
      const code = watchCode;
      teardownWatch();
      watchCode = code;
      setStatus('Paylaşan yeniden bağlanıyor…');
      rejoinTimer = setTimeout(() => join(code, { silent: true, tries: 1 }), 3000);
      return;
    }
    stopWatching(false);
    toastOut('Paylaşım bitti.');
  });

  socket.on('control-available', ({ agent }) => {
    $('ctrlBtn').title = agent ? 'Fare ve klavyeyle kontrol et' : 'Paylaşan bilgisayarda kontrol programı çalışmıyor';
    $('ctrlBtn').style.opacity = agent || ctrlState !== 'off' ? '' : '.55';
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

  // ---------- Görüntü düzeni (sığdır / doldur / 1:1, yakınlaş, kaydır) ----------
  const stage = $('stage');
  const view = { fit: 'contain', zoom: 1, x: 0, y: 0 };
  const media = () => (relayMode ? img : video);

  function layout() {
    const el = media();
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

  // =====================================================================
  // UZAKTAN FARE / KLAVYE (izleyen)
  // =====================================================================
  let ctrlState = 'off'; // off | waiting | on
  const ctrlOn = () => ctrlState === 'on';
  const latched = { ctrl: false, alt: false, shift: false };
  let rightNext = false;
  let kbWanted = false;
  const kbInput = $('kbInput');
  const isTouchDevice = matchMedia('(pointer: coarse)').matches;

  function setCtrl(state, msg) {
    ctrlState = state === 'on' ? 'on' : state === 'waiting' ? 'waiting' : 'off';
    const btn = $('ctrlBtn');
    btn.classList.toggle('ctrl-on', ctrlState === 'on');
    btn.classList.toggle('ctrl-wait', ctrlState === 'waiting');
    btn.textContent = ctrlState === 'on' ? '🖱 Kontrol açık' : ctrlState === 'waiting' ? '⏳ İzin bekleniyor' : '🖱 Kontrol';
    stage.classList.toggle('control', ctrlState === 'on');
    $('keys').classList.toggle('show', ctrlState === 'on');
    const help = $('help');
    help.classList.toggle('show', ctrlState === 'on');
    help.textContent = isTouchDevice
      ? 'Dokun: tıkla · Basılı tut: sağ tık · Parmağı kaydır: sürükle · İki parmak: kaydır / yakınlaştır'
      : 'Fare ve klavyen uzak bilgisayarda çalışır. Tekerlek sayfayı kaydırır. Bırakmak için "Kontrol açık"a bas.';
    if (ctrlState !== 'on') {
      rightNext = false;
      clearLatches();
      $('rightBtn').classList.remove('latched');
      if (kbWanted) setKeyboard(false);
    }
    if (msg) toast(msg, ctrlState === 'off' ? 5000 : 2500);
    setTimeout(layout, 30);
  }

  $('ctrlBtn').onclick = () => {
    if (!watchingId) return;
    if (ctrlState === 'off') {
      setCtrl('waiting');
      socket.emit('control-request', { name: nameInput.value });
    } else {
      socket.emit('control-release');
      setCtrl('off');
    }
  };

  socket.on('control-state', ({ state, msg }) => {
    if (state === 'on') {
      setCtrl('on', isTouchDevice ? 'Kontrol sende. Ekrana dokunarak tıklayabilirsin.' : 'Kontrol sende.');
    } else if (state === 'waiting') {
      setCtrl('waiting', msg);
    } else {
      setCtrl('off', msg);
    }
  });

  // ---- Gönderme ----
  function sendIn(m) { if (ctrlOn()) socket.emit('input', m); }

  let moveQ = null, moveT = 0, moveTimer = null;
  function flushMove() {
    moveTimer = null;
    if (!moveQ || !ctrlOn()) { moveQ = null; return; }
    socket.volatile.emit('input', { t: 'move', x: moveQ.x, y: moveQ.y });
    moveQ = null;
    moveT = performance.now();
  }
  function sendMove(p) {
    if (!p) return;
    moveQ = p;
    const wait = 30 - (performance.now() - moveT);
    if (wait <= 0) flushMove();
    else if (!moveTimer) moveTimer = setTimeout(flushMove, wait);
  }
  function sendAt(t, p, extra) {
    if (!p) return;
    moveQ = null;
    sendIn(Object.assign({ t, x: p.x, y: p.y }, extra));
  }

  // Ekrandaki noktayı uzak ekranda 0..1 konuma çevir
  function norm(cx, cy) {
    const r = media().getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const x = (cx - r.left) / r.width, y = (cy - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  function mods(extra) {
    return Object.assign({ ctrl: latched.ctrl, alt: latched.alt, shift: latched.shift, meta: false }, extra || {});
  }
  function anyLatched() { return latched.ctrl || latched.alt || latched.shift; }
  function clearLatches() {
    latched.ctrl = latched.alt = latched.shift = false;
    document.querySelectorAll('[data-mod]').forEach(b => b.classList.remove('latched'));
  }
  function sendKey(k, c, m) {
    sendIn(Object.assign({ t: 'key', k, c: c || '' }, m || mods()));
    if (!m) clearLatches();
  }
  function sendText(s) { if (s) sendIn({ t: 'text', s }); }

  // ---- Dokunma / fare ----
  const pointers = new Map();
  let gesture = null;   // iki parmak
  let single = null;    // kontrol modunda tek parmak
  let lastMouseP = null;

  function cancelSingle() {
    if (!single) return;
    clearTimeout(single.longTimer);
    if (single.dragging) sendAt('up', single.last, { b: 0 });
    single = null;
  }

  function startGesture() {
    const [a, b] = [...pointers.values()];
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    gesture = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: view.zoom, c0: c, last: c, mode: null, acc: 0 };
  }

  function moveGesture() {
    const [a, b] = [...pointers.values()];
    const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const ratio = d / gesture.d0;
    if (!gesture.mode) {
      // Parmak hareketleri sırayla geldiği için oran yerine piksel farkına bak:
      // aradaki mesafe değişiyorsa yakınlaştırma, ikisi birlikte kayıyorsa kaydırma
      const dd = Math.abs(d - gesture.d0);
      const cm = Math.hypot(c.x - gesture.c0.x, c.y - gesture.c0.y);
      if (dd > 24 && dd > cm) gesture.mode = 'zoom';
      else if (cm > 14 && cm > dd) gesture.mode = (ctrlOn() && view.zoom <= 1.001) ? 'scroll' : 'pan';
    }
    if (gesture.mode === 'zoom') setZoom(gesture.z0 * ratio);
    else if (gesture.mode === 'pan') {
      view.x += c.x - gesture.last.x;
      view.y += c.y - gesture.last.y;
      layout();
    } else if (gesture.mode === 'scroll') {
      gesture.acc += c.y - gesture.last.y;
      while (Math.abs(gesture.acc) >= 25) {
        const step = Math.sign(gesture.acc);
        sendIn({ t: 'wheel', dy: step * 120, dx: 0 });
        gesture.acc -= step * 25;
      }
    }
    gesture.last = c;
  }

  stage.addEventListener('pointerdown', e => {
    if (ctrlOn() && e.pointerType === 'mouse') {
      e.preventDefault();
      const p = norm(e.clientX, e.clientY);
      if (p) { lastMouseP = p; sendAt('down', p, { b: e.button }); }
      try { stage.setPointerCapture(e.pointerId); } catch {}
      return;
    }
    try { stage.setPointerCapture(e.pointerId); } catch {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      cancelSingle();
      startGesture();
    } else if (pointers.size === 1) {
      if (ctrlOn()) {
        const p = norm(e.clientX, e.clientY);
        single = { sx: e.clientX, sy: e.clientY, start: p, last: p, dragging: false, done: false };
        single.longTimer = setTimeout(() => {
          if (!single || single.dragging || !single.start) return;
          sendAt('click', single.start, { b: 2, n: 1 });
          single.done = true;
          if (navigator.vibrate) navigator.vibrate(20);
        }, 550);
      } else {
        stage.classList.add('drag');
      }
    }
  });

  stage.addEventListener('pointermove', e => {
    if (ctrlOn() && e.pointerType === 'mouse') {
      const p = norm(e.clientX, e.clientY);
      if (p) { lastMouseP = p; sendMove(p); }
      return;
    }
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.set(e.pointerId, cur);
    if (pointers.size >= 2 && gesture) { moveGesture(); return; }
    if (pointers.size !== 1) return;
    if (ctrlOn()) {
      if (!single || single.done) return;
      if (!single.dragging && Math.hypot(cur.x - single.sx, cur.y - single.sy) > 10) {
        clearTimeout(single.longTimer);
        if (!single.start) return;
        single.dragging = true;
        sendAt('down', single.start, { b: 0 });
      }
      if (single.dragging) {
        const p = norm(cur.x, cur.y);
        if (p) { single.last = p; sendMove(p); }
      }
    } else {
      view.x += cur.x - prev.x;
      view.y += cur.y - prev.y;
      layout();
    }
  });

  const up = e => {
    if (ctrlOn() && e.pointerType === 'mouse') {
      const p = norm(e.clientX, e.clientY) || lastMouseP;
      if (p) sendAt('up', p, { b: e.button });
      return;
    }
    pointers.delete(e.pointerId);
    if (single && pointers.size === 0) {
      clearTimeout(single.longTimer);
      if (single.dragging) {
        sendAt('up', single.last, { b: 0 });
      } else if (!single.done && single.start && e.type === 'pointerup') {
        sendAt('click', single.start, { b: rightNext ? 2 : 0, n: 1 });
        if (rightNext) { rightNext = false; $('rightBtn').classList.remove('latched'); }
      }
      single = null;
    }
    if (pointers.size < 2) gesture = null;
    if (!pointers.size) stage.classList.remove('drag');
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);

  stage.addEventListener('contextmenu', e => { if (ctrlOn()) e.preventDefault(); });

  stage.addEventListener('wheel', e => {
    e.preventDefault();
    if (ctrlOn()) {
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
      const dy = Math.round(-e.deltaY * k * 1.2);
      const dx = Math.round(e.deltaX * k * 1.2);
      if (dy || dx) sendIn({ t: 'wheel', dy, dx });
      return;
    }
    setZoom(view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });

  stage.addEventListener('dblclick', () => {
    if (ctrlOn()) return; // çift tık uzak bilgisayara iki tık olarak gidiyor
    view.zoom > 1 ? resetView() : setZoom(2);
  });

  // ---- Bilgisayar klavyesi ----
  const SPECIAL = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'Insert', 'Home', 'End',
    'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ContextMenu', 'PrintScreen']);
  const IGNORE = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'Dead', 'Unidentified', 'Process', 'OS']);

  function keyFromEvent(e) {
    const altGr = e.getModifierState && e.getModifierState('AltGraph');
    // Mac'te Cmd -> Ctrl (kopyala/yapıştır alışkanlığı aynı kalsın)
    const ctrl = (e.ctrlKey || (isMac && e.metaKey)) && !altGr;
    const alt = e.altKey && !altGr;
    const meta = !isMac && e.metaKey;
    if (e.key.length === 1 && !ctrl && !alt && !meta) return { text: e.key };
    return { key: e.key, code: e.code, m: { ctrl, alt, shift: e.shiftKey, meta } };
  }

  document.addEventListener('keydown', e => {
    if (!ctrlOn()) return;
    const ae = document.activeElement;
    if (ae === nameInput || ae === kbInput) return;
    if (IGNORE.has(e.key)) return;
    e.preventDefault();
    const r = keyFromEvent(e);
    if (r.text) sendText(r.text);
    else sendKey(r.key, r.code, r.m);
  });

  // ---- Telefon klavyesi ----
  // Gizli kutudaki yazı uzak bilgisayara aynen yansıtılıyor (otomatik düzeltme dahil)
  let shadow = '';
  function resetKb() { kbInput.value = ''; shadow = ''; }

  kbInput.addEventListener('input', () => {
    const v = kbInput.value;
    if (v === shadow) return;
    let p = 0;
    while (p < v.length && p < shadow.length && v[p] === shadow[p]) p++;
    const del = shadow.length - p;
    const ins = v.slice(p);
    if (anyLatched() && del === 0 && ins.length === 1) {
      // Ctrl/Alt/Shift basılıyken yazılan harf -> kısayol (Ctrl+C gibi)
      sendKey(ins, '', mods());
      clearLatches();
      kbInput.value = shadow;
      return;
    }
    for (let i = 0; i < del; i++) sendKey('Backspace', '', { ctrl: false, alt: false, shift: false, meta: false });
    sendText(ins);
    shadow = v;
    if (v.length > 300) resetKb();
  });

  kbInput.addEventListener('keydown', e => {
    if (!ctrlOn()) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      sendKey('Enter', 'Enter', mods());
      clearLatches();
      resetKb();
      return;
    }
    if (e.key === 'Backspace' && kbInput.value === '') {
      e.preventDefault();
      sendKey('Backspace', 'Backspace', mods());
      clearLatches();
      return;
    }
    // Bağlı fiziksel klavyeden özel tuşlar / kısayollar
    if (SPECIAL.has(e.key) || e.ctrlKey || e.metaKey || (e.altKey && !(e.getModifierState && e.getModifierState('AltGraph')))) {
      if (IGNORE.has(e.key)) return;
      e.preventDefault();
      const r = keyFromEvent(e);
      if (r.text) sendText(r.text);
      else sendKey(r.key, r.code, r.m);
    }
  });

  function setKeyboard(on) {
    kbWanted = on;
    $('kbBtn').classList.toggle('latched', on);
    if (on) {
      resetKb();
      kbInput.focus({ preventScroll: true });
    } else {
      kbInput.blur();
    }
  }
  kbInput.addEventListener('blur', () => {
    // Kullanıcı klavyeyi kendisi kapattıysa düğmeyi de kapat
    setTimeout(() => {
      if (document.activeElement !== kbInput && kbWanted && !keepKb) {
        kbWanted = false;
        $('kbBtn').classList.remove('latched');
      }
    }, 150);
  });

  // Çubuktaki düğmeler klavyeyi kapatmasın
  let keepKb = false;
  const keysBar = $('keys');
  keysBar.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) { e.preventDefault(); keepKb = true; setTimeout(() => { keepKb = false; }, 400); }
  });
  keysBar.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
  keysBar.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'kbBtn') { setKeyboard(!kbWanted); return; }
    if (b.id === 'rightBtn') {
      rightNext = !rightNext;
      b.classList.toggle('latched', rightNext);
      toast(rightNext ? 'Sonraki dokunuş sağ tık olacak' : 'Sağ tık iptal', 1500);
    } else if (b.dataset.mod) {
      const m = b.dataset.mod;
      latched[m] = !latched[m];
      b.classList.toggle('latched', latched[m]);
    } else if (b.dataset.k) {
      const k = b.dataset.k;
      sendKey(k, k === 'Meta' ? 'MetaLeft' : k, k === 'Meta' ? { ctrl: false, alt: false, shift: false, meta: false } : undefined);
      if (k === 'Enter') resetKb();
    } else if (b.dataset.wheel) {
      sendIn({ t: 'wheel', dy: Number(b.dataset.wheel), dx: 0 });
    }
    if (kbWanted) kbInput.focus({ preventScroll: true });
  });
})();
