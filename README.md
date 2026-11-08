# Ekran Paylaş

Kodla ekran paylaşma ve uzaktan kontrol. "Ekranımı Paylaş"a basınca 8 haneli bir kod çıkar. Kodu (ya da `/?kod=12345678` linkini) bilen kişi ekranı canlı izler, fare ve klavyeyle kontrol de edebilir. Kodsuz giren hiçbir şey görmez.

- Kod her paylaşımda yenilenir. Paylaşanın bağlantısı kısa süre koparsa aynı kod korunur, izleyenler otomatik devam eder.
- Kod tahminine karşı IP başına dakikada en fazla 15 yanlış deneme.

## İzleme
- Görüntü WebRTC ile doğrudan akar. 7 saniyede bağlanamazsa otomatik olarak sunucu üzerinden (WebSocket, 443) gelir.
- Sığdır / doldur / 1:1, yakınlaştırma, kaydırma, tam ekran, ses.
- İsteğe bağlı TURN: Render'da `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` ortam değişkenleri.

## Uzaktan fare ve klavye
Tarayıcı bilgisayarın gerçek faresini/klavyesini kontrol edemediği için paylaşan bilgisayarda küçük bir program çalışır (kurulum yok):

- **Windows** (`agent/kontrol.ps1`): `ekran-kontrol.bat`'ı çift tıkla ya da Win+R komutunu yapıştır.
- **Ubuntu / Linux** (`agent/kontrol-linux.py` + `.sh`): terminale `bash <(wget -qO- '…/kontrol.sh?t=…')` yapıştır. Çekirdeğin sanal fare/klavyesini (`/dev/uinput`) kullandığı için Wayland ve X11'de çalışır, bir kez sudo şifresi ister. Klavye düzeni (Türkçe Q/F vb.) otomatik okunur, izin kutusu zenity ile açılır.

1. Paylaşırken paneldeki Windows ya da Ubuntu sekmesinden programı başlat.
2. İzleyen kişi **🖱 Kontrol**'e basar. Varsayılan olarak kodu bilen sormadan kontrol eder. Paneldeki kutucuk kapatılırsa bilgisayarda en üstte izin kutusu çıkar.
3. Pencere açık kaldıkça çalışır. Kapatınca kontrol biter.

Telefonda: dokun = tıkla, basılı tut = sağ tık, kaydır = sürükle, iki parmak = sayfa kaydır / yakınlaştır, ⌨ = klavye.

Her tarayıcının kendine ait gizli bir anahtarı var. Program sadece o tarayıcıdan başlatılan paylaşıma bağlanır.

```
npm install
npm start
```
