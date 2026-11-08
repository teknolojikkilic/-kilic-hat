# Ekran Paylaş

Oda kodu olmadan ekran paylaşma ve uzaktan kontrol. Siteye giren "Ekranımı Paylaş"a basar, siteyi açan herkes o ekranı canlı görür. İstersen telefondan ya da başka bir bilgisayardan fare ve klavyeyle kontrol de edilebilir.

## İzleme
- Görüntü WebRTC ile doğrudan akar. 7 saniyede bağlanamazsa otomatik olarak sunucu üzerinden (WebSocket, 443) gelir.
- Sığdır / doldur / 1:1, yakınlaştırma, kaydırma, tam ekran, ses.
- İsteğe bağlı TURN: Render'da `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` ortam değişkenleri.

## Uzaktan fare ve klavye
Tarayıcı bilgisayarın gerçek faresini/klavyesini kontrol edemediği için paylaşan Windows bilgisayarda küçük bir program çalışır (`agent/kontrol.ps1`, kurulum yok):

1. Paylaşırken sayfadaki **Kontrol programını indir**'e bas, `ekran-kontrol.bat`'ı çift tıkla (ya da **Komutu kopyala**, Win+R'ye yapıştır).
2. İzleyen kişi **🖱 Kontrol**'e basar, bilgisayarda en üstte izin kutusu çıkar.
3. Pencere açık kaldıkça çalışır. Kapatınca kontrol biter.

Telefonda: dokun = tıkla, basılı tut = sağ tık, kaydır = sürükle, iki parmak = sayfa kaydır / yakınlaştır, ⌨ = klavye.

Her tarayıcının kendine ait gizli bir anahtarı var. Program sadece o tarayıcıdan başlatılan paylaşıma bağlanır.

```
npm install
npm start
```
