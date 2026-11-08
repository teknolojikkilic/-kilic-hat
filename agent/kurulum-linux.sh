#!/usr/bin/env bash
# Ekran Paylaş — Kalıcı kurulum (Linux / Ubuntu)
# Bir kez çalıştır: kontrol programı bilgisayara yerleşir ve her açılışta kendiliğinden başlar.
# Sonrasında sadece sitede "Ekranımı Paylaş"a basmak yeter, bir daha komut gerekmez.
# Kaldırmak için sitedeki "Kaldır" komutunu çalıştır.

set -u

DIR="$HOME/.local/share/ekran-paylas"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="ekran-paylas.service"
RULE="/etc/udev/rules.d/70-ekran-paylas-uinput.rules"
MODLOAD="/etc/modules-load.d/ekran-paylas.conf"

say() { printf '\n  %s\n' "$1"; }
fail() { printf '\n  HATA: %s\n\n' "$1"; exit 1; }

echo
echo "  Ekran Paylas - Kalici kurulum"
echo "  Kontrol programi bu bilgisayara yerlesecek ve her acilista kendiliginden baslayacak."

[ "$(id -u)" = 0 ] && fail "Bu komutu sudo olmadan, kendi kullanıcınla çalıştır. Şifre gerekince kendisi soracak."
command -v python3 >/dev/null 2>&1 || fail "python3 bulunamadı. Önce şunu çalıştır:  sudo apt install python3"
command -v systemctl >/dev/null 2>&1 || fail "Bu sistemde systemd yok, kalıcı kurulum yapılamıyor. Sitedeki 'Sadece bu seferlik' komutunu kullan."
systemctl --user show-environment >/dev/null 2>&1 || fail "Kullanıcı servisleri çalışmıyor. Masaüstü oturumunda (Terminal'den) çalıştırdığından emin ol."

# ---------------------------------------------------------------- dosyalar
mkdir -p "$DIR" "$UNIT_DIR" || fail "$DIR oluşturulamadı."

cat > "$DIR/kontrol.py" <<'EKRAN_PY_EOF'
__PYTHON__
EKRAN_PY_EOF

cat > "$DIR/baslat.sh" <<'EKRAN_RUN_EOF'
#!/usr/bin/env bash
# Servis bu dosyayı çalıştırır: masaüstü bilgilerini toplayıp kontrol programını başlatır.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)

# Masaüstü oturumu açılana kadar bekle (ekran bilgisi ve izin kutusu için)
ENVS=""
for _ in $(seq 1 60); do
  ENVS=$(systemctl --user show-environment 2>/dev/null || true)
  if printf '%s\n' "$ENVS" | grep -qE '^(WAYLAND_DISPLAY|DISPLAY)='; then break; fi
  sleep 2
done
while IFS= read -r line; do
  case "$line" in
    DISPLAY=*|WAYLAND_DISPLAY=*|XAUTHORITY=*|XDG_SESSION_TYPE=*|DBUS_SESSION_BUS_ADDRESS=*) export "$line" ;;
  esac
done <<EOF
$ENVS
EOF

# Klavye düzeni (Türkçe Q, F, ABD...) — karakterlerin doğru tuşa basılması için
LAYOUT=""
VARIANT=""
if command -v gsettings >/dev/null 2>&1; then
  FIRST=$(gsettings get org.gnome.desktop.input-sources sources 2>/dev/null \
    | grep -o "('xkb', '[^']*')" | head -n1 | sed "s/.*'xkb', '\([^']*\)'.*/\1/")
  if [ -n "$FIRST" ]; then
    LAYOUT=${FIRST%%+*}
    [ "$FIRST" != "$LAYOUT" ] && VARIANT=${FIRST#*+}
  fi
fi
if [ -z "$LAYOUT" ] && command -v localectl >/dev/null 2>&1; then
  LAYOUT=$(localectl status 2>/dev/null | awk -F': ' '/X11 Layout/{print $2}' | cut -d, -f1)
  VARIANT=$(localectl status 2>/dev/null | awk -F': ' '/X11 Variant/{print $2}' | cut -d, -f1)
fi
if [ -z "$LAYOUT" ] && [ -f /etc/default/keyboard ]; then
  LAYOUT=$(. /etc/default/keyboard; echo "${XKBLAYOUT%%,*}")
  VARIANT=$(. /etc/default/keyboard; echo "${XKBVARIANT%%,*}")
fi

MONITORS=$(xrandr --listmonitors 2>/dev/null || true)
export EKRAN_LAYOUT="${LAYOUT:-us}" EKRAN_VARIANT="${VARIANT:-}" EKRAN_MONITORS="$MONITORS" EKRAN_SERVICE=1
exec python3 -u "$HERE/kontrol.py"
EKRAN_RUN_EOF
chmod 755 "$DIR/baslat.sh"
chmod 600 "$DIR/kontrol.py"

cat > "$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=Ekran Paylas - uzaktan kontrol programi

[Service]
ExecStart=$DIR/baslat.sh
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF

# ---------------------------------------------------------------- fare/klavye izni (bir kez sudo)
# /dev/uinput: çekirdeğin sanal fare/klavyesi. "uaccess" etiketi, o an masaüstünde oturan
# kullanıcıya erişim verir; böylece program her açılışta sudo istemeden çalışır.
if [ ! -f "$RULE" ] || [ ! -w /dev/uinput ]; then
  say "Fare ve klavye izni için bir kez şifren istenecek (yazarken ekranda görünmez, normal)."
  echo
  sudo sh -c "
    echo uinput > '$MODLOAD'
    echo 'KERNEL==\"uinput\", SUBSYSTEM==\"misc\", OPTIONS+=\"static_node=uinput\", TAG+=\"uaccess\"' > '$RULE'
    modprobe uinput 2>/dev/null || true
    udevadm control --reload-rules
    udevadm trigger --action=change --subsystem-match=misc --sysname-match=uinput
    udevadm settle 2>/dev/null || true
  " || fail "Şifre kabul edilmedi ya da yönetici izni yok."
  # Kural bir sonraki açılışta kesin işler; bu oturumda hemen çalışsın diye doğrudan izin de ver
  if [ ! -w /dev/uinput ]; then
    sudo setfacl -m "u:$(id -un):rw" /dev/uinput 2>/dev/null || true
  fi
  [ -w /dev/uinput ] || fail "/dev/uinput izni verilemedi. Bilgisayarı yeniden başlatıp komutu tekrar çalıştır."
fi

# ---------------------------------------------------------------- servisi başlat
systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null 2>&1 || fail "Servis etkinleştirilemedi."
systemctl --user restart "$UNIT" || fail "Servis başlatılamadı. Ayrıntı:  journalctl --user -u $UNIT"

sleep 3
if systemctl --user is-active --quiet "$UNIT"; then
  say "Kurulum tamam ✓"
  echo "  Program arka planda çalışıyor ve bilgisayar her açıldığında kendiliğinden başlayacak."
  echo "  Artık sadece sitede \"Ekranımı Paylaş\"a basman yeterli. Bu pencereyi kapatabilirsin."
  echo
else
  fail "Program başlamadı. Ayrıntı için:  journalctl --user -u $UNIT -n 30"
fi
