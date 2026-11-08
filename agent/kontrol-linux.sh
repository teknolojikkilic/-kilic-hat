#!/usr/bin/env bash
# Ekran Paylaş — Uzaktan Kontrol (Linux / Ubuntu)
# Çalıştır:  bash ekran-kontrol.sh
# Wayland ve X11'de çalışır. Sanal fare/klavye için bir kez sudo şifresi ister.

set -u

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 bulunamadı. Kur:  sudo apt install python3"
  exit 1
fi

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

# Monitörler (birden fazla ekran varsa doğru ekrana tıklamak için)
MONITORS=$(xrandr --listmonitors 2>/dev/null || true)

export EKRAN_LAYOUT="${LAYOUT:-us}" EKRAN_VARIANT="${VARIANT:-}" EKRAN_MONITORS="$MONITORS"

PY=$(mktemp /tmp/ekran-kontrol.XXXXXX)
trap 'rm -f "$PY"' EXIT
cat > "$PY" <<'EKRAN_PY_EOF'
__PYTHON__
EKRAN_PY_EOF

if [ -w /dev/uinput ]; then
  python3 "$PY"
else
  echo
  echo "  Sanal fare ve klavye (/dev/uinput) için yönetici izni gerekiyor."
  echo "  sudo şifren istenecek."
  echo
  [ -e /dev/uinput ] || sudo modprobe uinput 2>/dev/null || true
  sudo --preserve-env=EKRAN_LAYOUT,EKRAN_VARIANT,EKRAN_MONITORS,DISPLAY,WAYLAND_DISPLAY,XDG_RUNTIME_DIR,DBUS_SESSION_BUS_ADDRESS,XAUTHORITY,https_proxy,HTTPS_PROXY \
    python3 "$PY"
fi
