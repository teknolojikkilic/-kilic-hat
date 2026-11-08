#!/usr/bin/env bash
# Ekran Paylaş — Kalıcı kurulumu kaldır (Linux / Ubuntu)
# Kontrol programını durdurur, siler ve verilen fare/klavye iznini geri alır.

set -u

DIR="$HOME/.local/share/ekran-paylas"
UNIT="ekran-paylas.service"
RULE="/etc/udev/rules.d/70-ekran-paylas-uinput.rules"
MODLOAD="/etc/modules-load.d/ekran-paylas.conf"

echo
echo "  Ekran Paylas - Kaldirma"

if [ "$(id -u)" = 0 ]; then
  printf '\n  HATA: Bu komutu sudo olmadan, kendi kullanıcınla çalıştır.\n\n'
  exit 1
fi

systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
rm -f "$HOME/.config/systemd/user/$UNIT"
rm -rf "$DIR"
systemctl --user daemon-reload >/dev/null 2>&1 || true
echo "  Program durduruldu ve silindi."

if [ -f "$RULE" ] || [ -f "$MODLOAD" ]; then
  echo
  echo "  Fare/klavye iznini geri almak için şifren istenecek."
  echo
  if sudo sh -c "
    rm -f '$RULE' '$MODLOAD'
    udevadm control --reload-rules
    setfacl -x 'u:$(id -un)' /dev/uinput 2>/dev/null || true
    udevadm trigger --action=change --subsystem-match=misc --sysname-match=uinput
  "; then
    echo "  İzin geri alındı."
  else
    echo "  İzin geri alınamadı (şifre girilmedi). Program yine de silindi."
  fi
fi

echo
echo "  Kaldirma tamam. Artik kimse bu bilgisayari uzaktan kontrol edemez."
echo
