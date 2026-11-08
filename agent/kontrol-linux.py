#!/usr/bin/env python3
# Ekran Paylaş — Uzaktan Kontrol programı (Linux / Ubuntu)
# Wayland ve X11'de çalışır: çekirdeğin sanal fare/klavye aygıtını (/dev/uinput) kullanır.
# Bu pencere açık kaldığı sürece, izin verdiğin kişi bu bilgisayarın faresini ve klavyesini kullanabilir.
# Kapatmak için Ctrl+C'ye bas ya da terminali kapat.
# Sadece Python standart kütüphanesi kullanılır, ek kurulum gerekmez.

import base64
import ctypes
import ctypes.util
import fcntl
import json
import os
import re
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.parse

WS_URL = '__WSURL__'
TOKEN = '__TOKEN__'
DRY_RUN = os.environ.get('EKRAN_DRYRUN') == '1'
SERVICE = os.environ.get('EKRAN_SERVICE') == '1'  # kalıcı kurulum (arka plan servisi)


def log(s):
    print(time.strftime('%H:%M:%S') + '  ' + s, flush=True)


# ---------------------------------------------------------------- uinput

UI_SET_EVBIT, UI_SET_KEYBIT, UI_SET_RELBIT, UI_SET_ABSBIT = 0x40045564, 0x40045565, 0x40045566, 0x40045567
UI_DEV_CREATE, UI_DEV_DESTROY = 0x5501, 0x5502
EV_SYN, EV_KEY, EV_REL, EV_ABS = 0, 1, 2, 3
SYN_REPORT = 0
REL_HWHEEL, REL_WHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES = 6, 8, 11, 12
ABS_X, ABS_Y = 0, 1
BTN_LEFT, BTN_RIGHT, BTN_MIDDLE = 0x110, 0x111, 0x112
ABS_MAX = 32767
EVENT = struct.Struct('llHHi')


class Device:
    """Tek bir sanal giriş aygıtı."""

    def __init__(self, name, keys=(), rels=(), absx=False):
        self.name = name
        self.fd = None
        if DRY_RUN:
            return
        self.fd = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_SYN)
        if keys:
            fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_KEY)
            for k in keys:
                fcntl.ioctl(self.fd, UI_SET_KEYBIT, k)
        if rels:
            fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_REL)
            for r in rels:
                fcntl.ioctl(self.fd, UI_SET_RELBIT, r)
        absmax = [0] * 64
        if absx:
            fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_ABS)
            for a in (ABS_X, ABS_Y):
                fcntl.ioctl(self.fd, UI_SET_ABSBIT, a)
                absmax[a] = ABS_MAX
        # struct uinput_user_dev
        dev = struct.pack('80sHHHHi', name.encode()[:79], 0x03, 0x1209, 0x4ec0, 1, 0)
        dev += struct.pack('64i', *absmax) + struct.pack('64i', *([0] * 64)) * 3
        os.write(self.fd, dev)
        fcntl.ioctl(self.fd, UI_DEV_CREATE)

    def emit(self, events):
        if DRY_RUN:
            print('[' + self.name + '] ' + ' '.join('%d:%d:%d' % e for e in events), flush=True)
            return
        data = b''.join(EVENT.pack(0, 0, t, c, v) for (t, c, v) in events)
        data += EVENT.pack(0, 0, EV_SYN, SYN_REPORT, 0)
        os.write(self.fd, data)

    def close(self):
        if self.fd is not None:
            try:
                fcntl.ioctl(self.fd, UI_DEV_DESTROY)
            except OSError:
                pass
            os.close(self.fd)


# ---------------------------------------------------------------- tuşlar

KEY_ESC, KEY_BACKSPACE, KEY_TAB, KEY_ENTER, KEY_LEFTCTRL = 1, 14, 15, 28, 29
KEY_LEFTSHIFT, KEY_LEFTALT, KEY_SPACE, KEY_CAPSLOCK = 42, 56, 57, 58
KEY_RIGHTALT, KEY_LEFTMETA = 100, 125
KEY_U = 22

SPECIAL = {
    'Enter': 28, 'Backspace': 14, 'Tab': 15, 'Escape': 1, 'Esc': 1, ' ': 57, 'Spacebar': 57,
    'PageUp': 104, 'PageDown': 109, 'End': 107, 'Home': 102,
    'ArrowLeft': 105, 'Left': 105, 'ArrowUp': 103, 'Up': 103,
    'ArrowRight': 106, 'Right': 106, 'ArrowDown': 108, 'Down': 108,
    'PrintScreen': 99, 'Insert': 110, 'Delete': 111, 'Del': 111,
    'Meta': 125, 'OS': 125, 'Win': 125, 'ContextMenu': 127, 'CapsLock': 58, 'Pause': 119,
}
F_KEYS = [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194]

# Tarayıcının fiziksel tuş adları (US yerleşimi konumları) -> evdev kodu
US_CODE = {}
for _i, _ch in enumerate('qwertyuiop'):
    US_CODE['Key' + _ch.upper()] = 16 + _i
for _i, _ch in enumerate('asdfghjkl'):
    US_CODE['Key' + _ch.upper()] = 30 + _i
for _i, _ch in enumerate('zxcvbnm'):
    US_CODE['Key' + _ch.upper()] = 44 + _i
for _i in range(1, 10):
    US_CODE['Digit%d' % _i] = 1 + _i
US_CODE['Digit0'] = 11

KEYPAD = {55, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 96, 98, 117, 118, 121}

# Kullanıcının klavye yerleşimine göre karakter -> (evdev kodu, seviye)
# seviye 0: düz, 1: Shift, 2: AltGr, 3: Shift+AltGr
CHARMAP = {}


def build_charmap(layout, variant):
    global CHARMAP
    path = ctypes.util.find_library('xkbcommon') or 'libxkbcommon.so.0'
    try:
        lib = ctypes.CDLL(path)
    except OSError:
        log('libxkbcommon bulunamadı, ABD klavye düzeni varsayılıyor.')
        return False

    class Names(ctypes.Structure):
        _fields_ = [('rules', ctypes.c_char_p), ('model', ctypes.c_char_p), ('layout', ctypes.c_char_p),
                    ('variant', ctypes.c_char_p), ('options', ctypes.c_char_p)]

    lib.xkb_context_new.restype = ctypes.c_void_p
    lib.xkb_context_new.argtypes = [ctypes.c_int]
    lib.xkb_keymap_new_from_names.restype = ctypes.c_void_p
    lib.xkb_keymap_new_from_names.argtypes = [ctypes.c_void_p, ctypes.POINTER(Names), ctypes.c_int]
    lib.xkb_keymap_min_keycode.restype = ctypes.c_uint32
    lib.xkb_keymap_min_keycode.argtypes = [ctypes.c_void_p]
    lib.xkb_keymap_max_keycode.restype = ctypes.c_uint32
    lib.xkb_keymap_max_keycode.argtypes = [ctypes.c_void_p]
    lib.xkb_keymap_num_levels_for_key.restype = ctypes.c_uint32
    lib.xkb_keymap_num_levels_for_key.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32]
    lib.xkb_keymap_key_get_syms_by_level.restype = ctypes.c_int
    lib.xkb_keymap_key_get_syms_by_level.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32,
                                                     ctypes.c_uint32, ctypes.POINTER(ctypes.POINTER(ctypes.c_uint32))]
    lib.xkb_keysym_to_utf32.restype = ctypes.c_uint32
    lib.xkb_keysym_to_utf32.argtypes = [ctypes.c_uint32]

    ctx = lib.xkb_context_new(0)
    names = Names(None, None, layout.encode(), variant.encode() if variant else None, None)
    km = lib.xkb_keymap_new_from_names(ctx, ctypes.byref(names), 0)
    if not km:
        log('"%s" klavye düzeni okunamadı, ABD düzeni varsayılıyor.' % layout)
        return False

    best = {}
    for kc in range(lib.xkb_keymap_min_keycode(km), lib.xkb_keymap_max_keycode(km) + 1):
        code = kc - 8
        if code <= 0 or code > 247:
            continue
        levels = min(4, lib.xkb_keymap_num_levels_for_key(km, kc, 0))
        for lvl in range(levels):
            syms = ctypes.POINTER(ctypes.c_uint32)()
            n = lib.xkb_keymap_key_get_syms_by_level(km, kc, 0, lvl, ctypes.byref(syms))
            if n < 1:
                continue
            u = lib.xkb_keysym_to_utf32(syms[0])
            if not u or u < 32 and u not in (9, 10, 13):
                continue
            ch = chr(u)
            rank = (lvl, code in KEYPAD, code)
            if ch not in best or rank < best[ch][0]:
                best[ch] = (rank, code, lvl)
    CHARMAP = {ch: (v[1], v[2]) for ch, v in best.items()}
    return True


def default_charmap():
    # libxkbcommon yoksa: ABD düzeni
    rows = [('1234567890-=', '!@#$%^&*()_+', 2), ('qwertyuiop[]', 'QWERTYUIOP{}', 16),
            ('asdfghjkl;\'`', 'ASDFGHJKL:"~', 30), ('\\zxcvbnm,./', '|ZXCVBNM<>?', 43)]
    for low, high, start in rows:
        for i, ch in enumerate(low):
            CHARMAP[ch] = (start + i, 0)
        for i, ch in enumerate(high):
            CHARMAP[ch] = (start + i, 1)
    CHARMAP[' '] = (57, 0)


# ---------------------------------------------------------------- ekran eşleme

MONITORS = []  # (w, h, x, y, primary)
TARGET = None
DESK = (0, 0, 1, 1)  # minx, miny, maxx, maxy


def parse_monitors(text):
    mons = []
    for line in (text or '').splitlines():
        m = re.search(r'(\d+)/\d+x(\d+)/\d+\+(-?\d+)\+(-?\d+)', line)
        if m:
            w, h, x, y = (int(v) for v in m.groups())
            mons.append((w, h, x, y, '*' in line.split()[1] if len(line.split()) > 1 else False))
    return mons


def pick_screen(stream_w=0, stream_h=0):
    global TARGET, DESK
    if not MONITORS:
        TARGET = None
        return
    DESK = (min(m[2] for m in MONITORS), min(m[3] for m in MONITORS),
            max(m[2] + m[0] for m in MONITORS), max(m[3] + m[1] for m in MONITORS))
    pick = next((m for m in MONITORS if m[4]), MONITORS[0])
    if stream_w and stream_h:
        exact = [m for m in MONITORS if abs(m[0] - stream_w) <= 2 and abs(m[1] - stream_h) <= 2]
        aspect = [m for m in MONITORS if abs(m[0] / m[1] - stream_w / stream_h) < 0.02]
        for group in (exact, aspect):
            if group:
                pick = next((m for m in group if m[4]), group[0])
                break
    if pick != TARGET:
        TARGET = pick
        if len(MONITORS) > 1:
            log('Kontrol edilen ekran: %dx%d (%d,%d)' % pick[:4])


def to_abs(x, y):
    x = min(1.0, max(0.0, float(x)))
    y = min(1.0, max(0.0, float(y)))
    if not TARGET:
        return int(round(x * ABS_MAX)), int(round(y * ABS_MAX))
    w, h, ox, oy, _ = TARGET
    px = ox + x * (w - 1)
    py = oy + y * (h - 1)
    dw = max(1, DESK[2] - DESK[0] - 1)
    dh = max(1, DESK[3] - DESK[1] - 1)
    return (int(round((px - DESK[0]) / dw * ABS_MAX)), int(round((py - DESK[1]) / dh * ABS_MAX)))


# ---------------------------------------------------------------- girdi

class Input:
    def __init__(self):
        self.kbd = Device('Ekran Paylas Klavye', keys=range(1, 248))
        self.ptr = Device('Ekran Paylas Fare', keys=(BTN_LEFT, BTN_RIGHT, BTN_MIDDLE),
                          rels=(REL_WHEEL, REL_HWHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES), absx=True)
        self.wheel_rest = [0, 0]
        if not DRY_RUN:
            time.sleep(0.6)  # masaüstünün yeni aygıtları görmesi için

    def close(self):
        self.kbd.close()
        self.ptr.close()

    # fare
    def move(self, x, y):
        ax, ay = to_abs(x, y)
        self.ptr.emit([(EV_ABS, ABS_X, ax), (EV_ABS, ABS_Y, ay)])

    def button(self, b, down):
        code = BTN_RIGHT if b == 2 else BTN_MIDDLE if b == 1 else BTN_LEFT
        self.ptr.emit([(EV_KEY, code, 1 if down else 0)])

    def wheel(self, dy, dx):
        evs = []
        for i, (val, hi, lo) in enumerate(((dy, REL_WHEEL_HI_RES, REL_WHEEL), (dx, REL_HWHEEL_HI_RES, REL_HWHEEL))):
            if not val:
                continue
            evs.append((EV_REL, hi, val))
            self.wheel_rest[i] += val
            notches = int(self.wheel_rest[i] / 120)
            if notches:
                evs.append((EV_REL, lo, notches))
                self.wheel_rest[i] -= notches * 120
        if evs:
            self.ptr.emit(evs)

    # klavye
    def key_raw(self, code, down):
        self.kbd.emit([(EV_KEY, code, 1 if down else 0)])

    def combo(self, mods, code):
        for m in mods:
            self.key_raw(m, True)
        self.key_raw(code, True)
        self.key_raw(code, False)
        for m in reversed(mods):
            self.key_raw(m, False)

    def type_char(self, ch):
        if ch == '\n':
            return self.combo([], KEY_ENTER)
        if ch == '\t':
            return self.combo([], KEY_TAB)
        if ch == '\r':
            return
        ent = CHARMAP.get(ch)
        if ent:
            code, lvl = ent
            mods = []
            if lvl in (1, 3):
                mods.append(KEY_LEFTSHIFT)
            if lvl in (2, 3):
                mods.append(KEY_RIGHTALT)
            return self.combo(mods, code)
        # Klavyede olmayan karakter: GNOME/IBus Unicode girişi (Ctrl+Shift+U, onaltılık kod, boşluk)
        self.combo([KEY_LEFTCTRL, KEY_LEFTSHIFT], KEY_U)
        for h in '%x' % ord(ch):
            e = CHARMAP.get(h)
            if e:
                self.combo([KEY_LEFTSHIFT] if e[1] == 1 else [], e[0])
        self.combo([], KEY_SPACE)

    def text(self, s):
        for ch in s[:500]:
            self.type_char(ch)

    def key(self, k, c, ctrl, alt, shift, meta):
        code, lvl = SPECIAL.get(k), 0
        m = re.fullmatch(r'F(\d{1,2})', k)
        if code is None and m and 1 <= int(m.group(1)) <= 24:
            code = F_KEYS[int(m.group(1)) - 1]
        if code is None and len(k) == 1:
            ent = CHARMAP.get(k) or CHARMAP.get(k.lower())
            if ent:
                code, lvl = ent
                if CHARMAP.get(k) is None:
                    lvl = 0  # büyük harf: Shift zaten mesajda
        if code is None and c in US_CODE:
            code = US_CODE[c]
        if code is None:
            if len(k) == 1 and not (ctrl or alt or meta):
                self.text(k)
            return
        mods = []
        if ctrl:
            mods.append(KEY_LEFTCTRL)
        if alt:
            mods.append(KEY_LEFTALT)
        if shift or lvl in (1, 3):
            mods.append(KEY_LEFTSHIFT)
        if lvl in (2, 3):
            mods.append(KEY_RIGHTALT)
        if meta and code != KEY_LEFTMETA:
            mods.append(KEY_LEFTMETA)
        self.combo(mods, code)


# ---------------------------------------------------------------- WebSocket (standart kütüphaneyle)

class WebSocket:
    def __init__(self, url):
        u = urllib.parse.urlparse(url)
        host, port = u.hostname, u.port or (443 if u.scheme == 'wss' else 80)
        proxy = os.environ.get('https_proxy') or os.environ.get('HTTPS_PROXY')
        if proxy and u.scheme == 'wss':
            p = urllib.parse.urlparse(proxy if '://' in proxy else 'http://' + proxy)
            sock = socket.create_connection((p.hostname, p.port or 80), timeout=20)
            sock.sendall(('CONNECT %s:%d HTTP/1.1\r\nHost: %s:%d\r\n\r\n' % (host, port, host, port)).encode())
            resp = self._read_head(sock)[0]
            if b' 200' not in resp.split(b'\r\n')[0]:
                raise OSError('Vekil sunucu bağlantıyı reddetti')
        else:
            sock = socket.create_connection((host, port), timeout=20)
        if u.scheme == 'wss':
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
        key = base64.b64encode(os.urandom(16)).decode()
        path = (u.path or '/') + ('?' + u.query if u.query else '')
        sock.sendall(('GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                      'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nUser-Agent: ekran-kontrol-linux\r\n\r\n'
                      % (path, host, key)).encode())
        head, rest = self._read_head(sock)
        if b' 101 ' not in head.split(b'\r\n')[0] + b' ':
            raise OSError('Sunucu WebSocket bağlantısını kabul etmedi')
        sock.settimeout(None)
        self.sock = sock
        self.buf = rest
        self.lock = threading.Lock()
        self.close_code = None

    @staticmethod
    def _read_head(sock):
        buf = b''
        while b'\r\n\r\n' not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                raise OSError('Bağlantı kapandı')
            buf += chunk
        head, rest = buf.split(b'\r\n\r\n', 1)
        return head, rest

    def _recv(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise OSError('Bağlantı kapandı')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send_frame(self, opcode, payload):
        mask = os.urandom(4)
        n = len(payload)
        hdr = bytes([0x80 | opcode])
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack('>H', n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack('>Q', n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        with self.lock:
            self.sock.sendall(hdr + mask + masked)

    def send(self, obj):
        self._send_frame(0x1, json.dumps(obj).encode())

    def recv(self):
        """Bir metin mesajı döndürür; bağlantı kapanınca None."""
        parts = []
        while True:
            b1, b2 = self._recv(2)
            fin, opcode = b1 & 0x80, b1 & 0x0F
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack('>H', self._recv(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', self._recv(8))[0]
            mask = self._recv(4) if b2 & 0x80 else None
            data = self._recv(n)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if opcode == 0x9:  # ping
                self._send_frame(0xA, data)
                continue
            if opcode == 0xA:
                continue
            if opcode == 0x8:
                self.close_code = struct.unpack('>H', data[:2])[0] if len(data) >= 2 else None
                try:
                    self._send_frame(0x8, data[:2])
                except OSError:
                    pass
                return None
            parts.append(data)
            if fin:
                return b''.join(parts).decode('utf-8', 'replace')

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# ---------------------------------------------------------------- izin kutusu

ASKS = {}
SESSION_ENV = {k: os.environ[k] for k in ('DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
                                         'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY') if os.environ.get(k)}


def ask(ws, vid, name):
    if vid in ASKS:
        return
    log('%s kontrol istiyor. Açılan kutudan izin ver ya da reddet.' % name)
    cmd = ['zenity', '--question', '--title=Uzaktan kontrol isteği', '--width=380', '--timeout=120',
           '--text="%s" bu bilgisayarın faresini ve klavyesini kontrol etmek istiyor.\n\nİzin veriyor musun?'
           % name.replace('&', '&amp;').replace('<', '&lt;'),
           '--ok-label=İzin ver', '--cancel-label=Reddet']
    user = os.environ.get('SUDO_USER')
    if os.geteuid() == 0 and user:
        cmd = ['runuser', '-u', user, '--', 'env'] + ['%s=%s' % kv for kv in SESSION_ENV.items()] + cmd

    def run():
        try:
            p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            log('İzin kutusu açılamadı (zenity yok). Paylaşım sayfasındaki düğmelerden karar ver.')
            return
        p.remote = False
        ASKS[vid] = p
        rc = p.wait()
        if ASKS.get(vid) is p:
            del ASKS[vid]
        if not p.remote:
            try:
                ws.send({'t': 'answer', 'id': vid, 'allow': rc == 0})
            except OSError:
                pass

    threading.Thread(target=run, daemon=True).start()


def close_ask(vid):
    p = ASKS.pop(vid, None)
    if p:
        p.remote = True
        try:
            p.terminate()
        except OSError:
            pass


# ---------------------------------------------------------------- ana döngü

def handle(inp, ws, m):
    t = m.get('t')
    f = lambda k: float(m.get(k) or 0)
    b = int(m.get('b') or 0)
    if t == 'meta':
        pick_screen(int(m.get('w') or 0), int(m.get('h') or 0))
    elif t == 'move':
        inp.move(f('x'), f('y'))
    elif t in ('down', 'up'):
        inp.move(f('x'), f('y'))
        inp.button(b, t == 'down')
    elif t == 'click':
        inp.move(f('x'), f('y'))
        for _ in range(max(1, min(2, int(m.get('n') or 1)))):
            inp.button(b, True)
            inp.button(b, False)
    elif t == 'wheel':
        inp.wheel(int(m.get('dy') or 0), int(m.get('dx') or 0))
    elif t == 'text':
        inp.text(str(m.get('s') or ''))
    elif t == 'key':
        inp.key(str(m.get('k') or ''), str(m.get('c') or ''), bool(m.get('ctrl')), bool(m.get('alt')),
                bool(m.get('shift')), bool(m.get('meta')))
    elif t == 'ask':
        ask(ws, str(m.get('id') or ''), str(m.get('name') or 'Misafir'))
    elif t == 'close-ask':
        close_ask(str(m.get('id') or ''))
    elif t == 'info':
        log(str(m.get('s') or ''))


def main():
    print('\n  Ekran Paylas - Uzaktan Kontrol (Linux)')
    print('  Bu pencere acik kaldikca, IZIN VERDIGIN kisi faren ve klavyeni kullanabilir.')
    print('  Kontrolu tamamen kapatmak icin Ctrl+C ya da terminali kapat.\n', flush=True)

    layout = (os.environ.get('EKRAN_LAYOUT') or 'us').split(',')[0].strip() or 'us'
    variant = (os.environ.get('EKRAN_VARIANT') or '').split(',')[0].strip()
    if build_charmap(layout, variant):
        log('Klavye düzeni: %s%s' % (layout, ' (' + variant + ')' if variant else ''))
    else:
        default_charmap()
    MONITORS.extend(parse_monitors(os.environ.get('EKRAN_MONITORS', '')))
    pick_screen()

    try:
        inp = Input()
    except PermissionError:
        log('/dev/uinput için izin yok. Programı sudo ile çalıştır.')
        sys.exit(1)
    except FileNotFoundError:
        log('/dev/uinput bulunamadı. "sudo modprobe uinput" çalıştırıp tekrar dene.')
        sys.exit(1)

    delay = 3
    try:
        while True:
            ws = None
            try:
                ws = WebSocket(WS_URL)
                ws.send({'t': 'hello', 'token': TOKEN, 'screens': [{'w': m[0], 'h': m[1], 'primary': m[4]} for m in MONITORS]})
                log('Sunucuya bağlandı.')
                delay = 3
                while True:
                    msg = ws.recv()
                    if msg is None:
                        break
                    try:
                        handle(inp, ws, json.loads(msg))
                    except Exception as e:  # tek bir hatalı mesaj programı durdurmasın
                        log('Hata: %s' % e)
                if ws.close_code == 4003:
                    if not SERVICE:
                        log('Kontrol programı başka bir pencerede açıldı. Bu pencere kapanıyor.')
                        return
                    # Kalıcı kurulum: tek seferlik pencere kapanınca görevi geri al
                    log('Kontrol başka bir pencerede açıldı. 1 dakika sonra görev geri alınacak.')
                    delay = 60
                else:
                    log('Bağlantı kapandı.')
            except (OSError, ssl.SSLError) as e:
                log('Bağlantı koptu: %s' % e)
            finally:
                if ws:
                    ws.close()
            log('%d saniye sonra yeniden bağlanılıyor...' % delay)
            time.sleep(delay)
            if delay < 60:
                delay = min(30, delay * 2)
    except KeyboardInterrupt:
        print()
        log('Kapatıldı, kontrol bitti.')
    finally:
        for vid in list(ASKS):
            close_ask(vid)
        inp.close()


if __name__ == '__main__':
    main()
