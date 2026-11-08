# Ekran Paylaş — Uzaktan Kontrol programı (Windows)
# Bu pencere açık kaldığı sürece, izin verdiğin kişi bu bilgisayarın faresini ve klavyesini kullanabilir.
# Kapatmak için pencereyi kapat ya da Ctrl+C'ye bas.

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
try { $Host.UI.RawUI.WindowTitle = 'Ekran Paylas - Uzaktan Kontrol' } catch {}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$WsUrl = '__WSURL__'
$Token = '__TOKEN__'

$code = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class KilicAgent
{
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern short VkKeyScanW(char ch);

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion u; }

    static readonly object SendLock = new object();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly Dictionary<string, Form> Asks = new Dictionary<string, Form>();
    static ClientWebSocket ws;
    static Rectangle target = Rectangle.Empty;
    static int streamW = 0, streamH = 0;

    public static void Run(string url, string token)
    {
        MakeDpiAware();
        PickScreen();
        while (true)
        {
            try { Session(url, token); }
            catch (Exception e)
            {
                Exception inner = e;
                while (inner.InnerException != null) inner = inner.InnerException;
                Log("Bağlantı koptu: " + inner.Message);
            }
            Log("3 saniye sonra yeniden bağlanılıyor...");
            Thread.Sleep(3000);
        }
    }

    static void MakeDpiAware()
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
        try { if (SetProcessDpiAwareness(2) == 0) return; } catch { }
        try { SetProcessDPIAware(); } catch { }
    }

    static void Log(string s)
    {
        Console.WriteLine(DateTime.Now.ToString("HH:mm:ss") + "  " + s);
    }

    static void Session(string url, string token)
    {
        ClientWebSocket sock = new ClientWebSocket();
        sock.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        sock.ConnectAsync(new Uri(url), CancellationToken.None).Wait();
        ws = sock;

        List<object> screens = new List<object>();
        foreach (Screen sc in Screen.AllScreens)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            d["w"] = sc.Bounds.Width;
            d["h"] = sc.Bounds.Height;
            d["primary"] = sc.Primary;
            screens.Add(d);
        }
        Dictionary<string, object> hello = new Dictionary<string, object>();
        hello["t"] = "hello";
        hello["token"] = token;
        hello["screens"] = screens;
        Send(hello);
        Log("Sunucuya bağlandı.");

        byte[] buf = new byte[65536];
        MemoryStream ms = new MemoryStream();
        try
        {
            while (sock.State == WebSocketState.Open)
            {
                WebSocketReceiveResult r = sock.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None).Result;
                if (r.MessageType == WebSocketMessageType.Close)
                {
                    if (r.CloseStatus.HasValue && (int)r.CloseStatus.Value == 4003)
                    {
                        Log("Bu bilgisayarda kontrol programı başka bir pencerede açıldı. Bu pencere kapanıyor.");
                        Thread.Sleep(3000);
                        Environment.Exit(0);
                    }
                    break;
                }
                ms.Write(buf, 0, r.Count);
                if (!r.EndOfMessage) continue;
                string text = Encoding.UTF8.GetString(ms.ToArray());
                ms.SetLength(0);
                try { Handle(text); }
                catch (Exception e) { Log("Hata: " + e.Message); }
            }
        }
        finally
        {
            ws = null;
            try { sock.Dispose(); } catch { }
        }
    }

    static void Send(object o)
    {
        ClientWebSocket s = ws;
        if (s == null || s.State != WebSocketState.Open) return;
        byte[] bytes = Encoding.UTF8.GetBytes(Json.Serialize(o));
        lock (SendLock)
        {
            try { s.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None).Wait(); }
            catch { }
        }
    }

    static double D(Dictionary<string, object> m, string k)
    {
        object v;
        if (m.TryGetValue(k, out v) && v != null) { try { return Convert.ToDouble(v); } catch { } }
        return 0;
    }
    static string S(Dictionary<string, object> m, string k)
    {
        object v;
        return (m.TryGetValue(k, out v) && v != null) ? v.ToString() : "";
    }
    static bool B(Dictionary<string, object> m, string k)
    {
        object v;
        return m.TryGetValue(k, out v) && v is bool && (bool)v;
    }

    static void Handle(string text)
    {
        Dictionary<string, object> m = Json.DeserializeObject(text) as Dictionary<string, object>;
        if (m == null) return;
        string t = S(m, "t");
        int b = (int)D(m, "b");
        switch (t)
        {
            case "meta":
                streamW = (int)D(m, "w"); streamH = (int)D(m, "h");
                PickScreen();
                break;
            case "move":
                MoveTo(D(m, "x"), D(m, "y"));
                break;
            case "down":
                MoveTo(D(m, "x"), D(m, "y"));
                MouseButton(b, true);
                break;
            case "up":
                MoveTo(D(m, "x"), D(m, "y"));
                MouseButton(b, false);
                break;
            case "click":
                MoveTo(D(m, "x"), D(m, "y"));
                int n = Math.Max(1, Math.Min(2, (int)D(m, "n")));
                for (int i = 0; i < n; i++) { MouseButton(b, true); MouseButton(b, false); }
                break;
            case "wheel":
                Wheel((int)D(m, "dy"), (int)D(m, "dx"));
                break;
            case "text":
                TypeText(S(m, "s"));
                break;
            case "key":
                Key(S(m, "k"), S(m, "c"), B(m, "ctrl"), B(m, "alt"), B(m, "shift"), B(m, "meta"));
                break;
            case "ask":
                Ask(S(m, "id"), S(m, "name"));
                break;
            case "close-ask":
                CloseAsk(S(m, "id"));
                break;
            case "info":
                Log(S(m, "s"));
                break;
        }
    }

    // Paylaşılan görüntünün boyutuna uyan monitörü seç
    static void PickScreen()
    {
        Screen pick = Screen.PrimaryScreen;
        Screen[] all = Screen.AllScreens;
        if (streamW > 0 && streamH > 0)
        {
            Screen exact = null, aspect = null;
            double want = (double)streamW / streamH;
            foreach (Screen sc in all)
            {
                if (Math.Abs(sc.Bounds.Width - streamW) <= 2 && Math.Abs(sc.Bounds.Height - streamH) <= 2)
                {
                    if (exact == null || sc.Primary) exact = sc;
                }
                double a = (double)sc.Bounds.Width / sc.Bounds.Height;
                if (Math.Abs(a - want) < 0.02 && (aspect == null || sc.Primary)) aspect = sc;
            }
            if (exact != null) pick = exact;
            else if (aspect != null) pick = aspect;
        }
        if (target != pick.Bounds)
        {
            target = pick.Bounds;
            Log("Kontrol edilen ekran: " + target.Width + "x" + target.Height);
        }
    }

    static void MoveTo(double x, double y)
    {
        if (target.Width <= 0) PickScreen();
        x = Math.Max(0, Math.Min(1, x));
        y = Math.Max(0, Math.Min(1, y));
        int px = target.Left + (int)Math.Round(x * (target.Width - 1));
        int py = target.Top + (int)Math.Round(y * (target.Height - 1));
        SetCursorPos(px, py);
    }

    static void SendOne(INPUT inp)
    {
        INPUT[] arr = new INPUT[] { inp };
        SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
    }

    static void Mouse(uint flags, uint data)
    {
        INPUT inp = new INPUT();
        inp.type = 0;
        inp.u.mi.dwFlags = flags;
        inp.u.mi.mouseData = data;
        SendOne(inp);
    }

    static void MouseButton(int b, bool down)
    {
        uint f;
        if (b == 2) f = down ? 0x0008u : 0x0010u;       // sağ
        else if (b == 1) f = down ? 0x0020u : 0x0040u;  // orta
        else f = down ? 0x0002u : 0x0004u;              // sol
        Mouse(f, 0);
    }

    static void Wheel(int dy, int dx)
    {
        if (dy != 0) Mouse(0x0800, unchecked((uint)dy));
        if (dx != 0) Mouse(0x1000, unchecked((uint)dx));
    }

    static void KeyRaw(ushort vk, bool up, bool ext)
    {
        INPUT inp = new INPUT();
        inp.type = 1;
        inp.u.ki.wVk = vk;
        inp.u.ki.dwFlags = (up ? 0x0002u : 0u) | (ext ? 0x0001u : 0u);
        SendOne(inp);
    }

    static void UnicodeChar(char ch)
    {
        INPUT down = new INPUT();
        down.type = 1;
        down.u.ki.wScan = ch;
        down.u.ki.dwFlags = 0x0004;
        INPUT up = down;
        up.u.ki.dwFlags = 0x0004 | 0x0002;
        SendInput(2, new INPUT[] { down, up }, Marshal.SizeOf(typeof(INPUT)));
    }

    static void Tap(ushort vk)
    {
        bool ext = IsExtended(vk);
        KeyRaw(vk, false, ext);
        KeyRaw(vk, true, ext);
    }

    static void TypeText(string s)
    {
        if (s.Length > 500) s = s.Substring(0, 500);
        foreach (char ch in s)
        {
            if (ch == '\r') continue;
            if (ch == '\n') Tap(0x0D);
            else if (ch == '\t') Tap(0x09);
            else UnicodeChar(ch);
        }
    }

    static bool IsExtended(ushort vk)
    {
        switch (vk)
        {
            case 0x21: case 0x22: case 0x23: case 0x24:
            case 0x25: case 0x26: case 0x27: case 0x28:
            case 0x2D: case 0x2E: case 0x5B: case 0x5D:
                return true;
        }
        return false;
    }

    static ushort SpecialKey(string k)
    {
        switch (k)
        {
            case "Enter": return 0x0D;
            case "Backspace": return 0x08;
            case "Tab": return 0x09;
            case "Escape": case "Esc": return 0x1B;
            case " ": case "Spacebar": return 0x20;
            case "PageUp": return 0x21;
            case "PageDown": return 0x22;
            case "End": return 0x23;
            case "Home": return 0x24;
            case "ArrowLeft": case "Left": return 0x25;
            case "ArrowUp": case "Up": return 0x26;
            case "ArrowRight": case "Right": return 0x27;
            case "ArrowDown": case "Down": return 0x28;
            case "PrintScreen": return 0x2C;
            case "Insert": return 0x2D;
            case "Delete": case "Del": return 0x2E;
            case "Meta": case "OS": case "Win": return 0x5B;
            case "ContextMenu": return 0x5D;
            case "CapsLock": return 0x14;
            case "Pause": return 0x13;
        }
        return 0;
    }

    static void Key(string k, string c, bool ctrl, bool alt, bool shift, bool meta)
    {
        ushort vk = SpecialKey(k);
        int fn;
        if (vk == 0 && k.Length >= 2 && k.Length <= 3 && k[0] == 'F' && int.TryParse(k.Substring(1), out fn) && fn >= 1 && fn <= 24)
            vk = (ushort)(0x6F + fn);
        if (vk == 0 && c.Length == 4 && c.StartsWith("Key"))
            vk = (ushort)char.ToUpperInvariant(c[3]);
        if (vk == 0 && c.Length == 6 && c.StartsWith("Digit"))
            vk = (ushort)c[5];
        if (vk == 0 && k.Length == 1)
        {
            char ch = k[0];
            if (ch >= 'a' && ch <= 'z') vk = (ushort)char.ToUpperInvariant(ch);
            else if ((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')) vk = (ushort)ch;
            else
            {
                short r = VkKeyScanW(ch);
                if (r != -1)
                {
                    vk = (ushort)(r & 0xFF);
                    int st = (r >> 8) & 0xFF;
                    if ((st & 1) != 0) shift = true;
                }
            }
        }
        if (vk == 0)
        {
            if (k.Length == 1 && !ctrl && !alt && !meta) TypeText(k);
            return;
        }
        if (vk == 0x5B) meta = false; // Win tuşunun kendisi

        List<ushort> mods = new List<ushort>();
        if (ctrl) mods.Add(0x11);
        if (alt) mods.Add(0x12);
        if (shift) mods.Add(0x10);
        if (meta) mods.Add(0x5B);
        foreach (ushort md in mods) KeyRaw(md, false, md == 0x5B);
        bool ext = IsExtended(vk);
        KeyRaw(vk, false, ext);
        KeyRaw(vk, true, ext);
        for (int i = mods.Count - 1; i >= 0; i--) KeyRaw(mods[i], true, mods[i] == 0x5B);
    }

    // ---------- İzin kutusu (her zaman en üstte) ----------
    static void Answer(string id, bool allow)
    {
        Dictionary<string, object> d = new Dictionary<string, object>();
        d["t"] = "answer";
        d["id"] = id;
        d["allow"] = allow;
        Send(d);
    }

    static void Ask(string id, string name)
    {
        if (string.IsNullOrEmpty(id)) return;
        lock (Asks) { if (Asks.ContainsKey(id)) return; }
        Log(name + " kontrol istiyor. Açılan kutudan izin ver ya da reddet.");
        Thread th = new Thread(delegate ()
        {
            Form f = new Form();
            float sc = 1f;
            using (Graphics g = f.CreateGraphics()) sc = g.DpiX / 96f;
            Func<int, int> P = delegate (int v) { return (int)Math.Round(v * sc); };

            f.Text = "Uzaktan kontrol isteği";
            f.TopMost = true;
            f.FormBorderStyle = FormBorderStyle.FixedDialog;
            f.StartPosition = FormStartPosition.CenterScreen;
            f.MinimizeBox = false;
            f.MaximizeBox = false;
            f.ShowInTaskbar = true;
            f.ClientSize = new Size(P(440), P(160));
            f.Font = new Font("Segoe UI", 10f);

            Label lbl = new Label();
            lbl.Text = "\"" + name + "\" bu bilgisayarın faresini ve klavyesini kontrol etmek istiyor.\r\n\r\nİzin veriyor musun?";
            lbl.SetBounds(P(18), P(16), P(404), P(80));

            Button yes = new Button();
            yes.Text = "İzin ver";
            yes.SetBounds(P(214), P(108), P(100), P(34));
            Button no = new Button();
            no.Text = "Reddet";
            no.SetBounds(P(322), P(108), P(100), P(34));

            bool answered = false;
            yes.Click += delegate { answered = true; Answer(id, true); f.Close(); };
            no.Click += delegate { answered = true; Answer(id, false); f.Close(); };
            f.FormClosed += delegate
            {
                lock (Asks) { Asks.Remove(id); }
                if (!answered && !"remote".Equals(f.Tag)) Answer(id, false);
            };
            f.Shown += delegate
            {
                f.Activate();
                try { System.Media.SystemSounds.Exclamation.Play(); } catch { }
            };
            f.Controls.Add(lbl);
            f.Controls.Add(yes);
            f.Controls.Add(no);
            f.AcceptButton = no;
            lock (Asks) { Asks[id] = f; }
            Application.Run(f);
        });
        th.SetApartmentState(ApartmentState.STA);
        th.IsBackground = true;
        th.Start();
    }

    static void CloseAsk(string id)
    {
        Form f;
        lock (Asks) { Asks.TryGetValue(id, out f); }
        if (f == null) return;
        try
        {
            f.Tag = "remote";
            if (f.IsHandleCreated) f.BeginInvoke(new MethodInvoker(f.Close));
        }
        catch { }
    }
}
'@

$refs = @('System.Windows.Forms', 'System.Drawing', 'System.Web.Extensions') | ForEach-Object {
  [Reflection.Assembly]::LoadWithPartialName($_).Location
}
Add-Type -TypeDefinition $code -ReferencedAssemblies $refs -Language CSharp

Write-Host ''
Write-Host '  Ekran Paylas - Uzaktan Kontrol' -ForegroundColor Green
Write-Host '  Bu pencere acik kaldikca, IZIN VERDIGIN kisi faren ve klavyeni kullanabilir.'
Write-Host '  Kontrolu tamamen kapatmak icin bu pencereyi kapat.'
Write-Host ''
[KilicAgent]::Run($WsUrl, $Token)
