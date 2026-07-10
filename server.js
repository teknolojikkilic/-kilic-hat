const express = require('express');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Bellekte ses tutmak için multer (dosya diske yazılmaz)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Telegram'a metin mesajı gönder
async function sendText(text) {
  try {
    await fetch(`${TG}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text }),
    });
  } catch (e) { console.error('Telegram metin hatası:', e); }
}

// ── 1: Hatırlatma (not + numara isteğe bağlı) ─────────
app.post('/api/reminder', async (req, res) => {
  const note = (req.body.note || '').toString().slice(0, 500).trim();
  const phone = (req.body.phone || '').toString().slice(0, 30).trim();

  let text = '📌 Hatırlatma var!';
  if (note) text += `\n\n📝 Not: ${note}`;
  if (phone) text += `\n📱 Numara: ${phone}`;
  if (!note && !phone) text += '\nBirisi seni hatırlatmak için aradı.';

  await sendText(text);
  res.json({ ok: true });
});

// ── 3: Geri arama talebi (numara ile) ─────────────────
app.post('/api/callback', async (req, res) => {
  const numara = (req.body.phone || '').toString().slice(0, 30);
  await sendText(`📞 Seninle görüşmek isteyen biri var!\nNumara: ${numara}`);
  res.json({ ok: true });
});

// ── 2: Sesli mesaj ─────────────────────────────────────
app.post('/api/voice', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false });
  try {
    // Ses dosyasını Telegram'a voice olarak yükle
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('caption', '🎙️ Yeni sesli mesajın var!');
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' });
    form.append('audio', blob, 'mesaj.webm');

    await fetch(`${TG}/sendAudio`, { method: 'POST', body: form });
    res.json({ ok: true });
  } catch (e) {
    console.error('Ses gönderme hatası:', e);
    // Ses gönderilemezse en azından haber ver
    await sendText('🎙️ Biri sesli mesaj bıraktı ama iletilemedi.');
    res.status(500).json({ ok: false });
  }
});

// Sağlık kontrolü (UptimeRobot için)
app.get('/health', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sunucu ${PORT} portunda çalışıyor`));
