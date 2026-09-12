"use strict";
/* Мобильный мост: доступ к ядру приложения с телефона/планшета по LAN.
   - HTTP-сервер отдаёт интерфейс (src/renderer) + PWA (manifest, service worker, иконка).
   - WebSocket-сервер (/ws) дублирует IPC: те же каналы, что у ipcMain, с защитой PIN-кодом.
   - События (ai:event, term:event, dev:event, github:event) транслируются всем клиентам.
   Без зависимостей: серверная часть WebSocket (RFC 6455) реализована вручную. */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Защита PIN от перебора: максимум неудачных попыток за окно времени,
// после чего вход блокируется на AUTH_LOCK_MS (глобально, а не на соединение).
const AUTH_MAX_FAILS = 10;
const AUTH_FAIL_WINDOW_MS = 60000;
const AUTH_LOCK_MS = 5 * 60 * 1000;
const RENDERER_DIR = path.join(__dirname, "renderer");

// Что мост отдаёт из src/renderer. Раньше список был захардкожен в handleHttp и в нём
// не было monochrome.css и highlight.js: телефон получал «неоновую» тему вместо
// монохромной, а подсветка кода молча отключалась.
const STATIC_FILES = new Set([
  "index.html",
  "styles.css",
  "monochrome.css",
  "app.js",
  "agent-core.js",
  "markdown.js",
  "highlight.js",
  "mobile-api.js",
  "bootstrap.js",
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

const MANIFEST = JSON.stringify(
  {
    name: "AI Developer Agent — мобильный доступ",
    short_name: "AI Agent",
    description: "Управляй своим AI-агентом с телефона: чат, консоль, превью, файлы и git.",
    start_url: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#0b0f1a",
    theme_color: "#0b0f1a",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  },
  null,
  2
);

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0ea5e9"/><stop offset="0.5" stop-color="#6366f1"/><stop offset="1" stop-color="#a855f7"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="110" fill="#0b0f1a"/>
  <rect x="22" y="22" width="468" height="468" rx="92" fill="url(#g)" opacity="0.14"/>
  <rect x="96" y="96" width="320" height="320" rx="64" fill="url(#g)" opacity="0.92"/>
  <path d="M196 206l74 50-74 50" stroke="#0b0f1a" stroke-width="30" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M282 306h40" stroke="#0b0f1a" stroke-width="30" stroke-linecap="round"/>
  <circle cx="330" cy="212" r="16" fill="#34d399"/>
</svg>`;

const SW_JS = `"use strict";
/* Service Worker мобильного доступа: офлайн-кэш интерфейса.
   Документ — network-first (всегда свежий), остальное — stale-while-revalidate. */
const CACHE = "ai-agent-mobile-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("/")))
    );
    return;
  }
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) c.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
`;

// ─── WebSocket-соединение (клиентская сторона, приём/отправка кадров) ───
class WsConn {
  constructor(socket, onMessage, onClose) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.fragOp = 0;
    this.authed = false;
    this.authTries = 0;
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.onClose) this.onClose(this);
    });
  }

  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.slice(off, off + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      }
      this.buf = this.buf.slice(off + maskLen + len);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0x8a, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) this.onMessage(payload);
        else {
          this.fragOp = opcode;
          this.frag = [payload];
        }
      } else if (opcode === 0x0 && this.fragOp) {
        this.frag.push(payload);
        if (fin) {
          const all = Buffer.concat(this.frag);
          this.frag = [];
          this.fragOp = 0;
          this.onMessage(all);
        }
      }
    }
  }

  sendFrame(opcode, payload) {
    try {
      if (this.socket.destroyed) return;
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[0] = 0x80 | opcode;
        header[1] = payload.length;
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      this.socket.write(Buffer.concat([header, payload]));
    } catch {}
  }

  sendText(str) {
    this.sendFrame(0x1, Buffer.from(String(str), "utf8"));
  }

  close() {
    try {
      this.sendFrame(0x8, Buffer.alloc(0));
      this.socket.end();
    } catch {}
  }

  destroy() {
    try {
      this.socket.destroy();
    } catch {}
  }
}

class MobileBridge {
  constructor(opts) {
    this.handlerMap = opts && opts.handlerMap; // Map<channel, fn>
    this.port = 9090;
    this.pin = "";
    this.enabled = false;
    this.server = null;
    this.clients = new Set();
    this.pingTimer = null;
    this.deny = new Set(["dialog:pickDir"]); // нативные диалоги недоступны с телефона
    // Глобальный rate-limit аутентификации (перебор PIN):
    this.authFailCount = 0;
    this.authFailWindowStart = 0;
    this.authLockedUntil = 0;
  }

  // ─── Жизненный цикл ───
  applySettings(s) {
    const enabled = !!(s && s.mobileEnabled);
    const port = (s && s.mobilePort) || 9090;
    const pin = (s && s.mobilePin) || "";
    const portChanged = this.server && port !== this.port;
    if (portChanged) this.stop();
    this.enabled = enabled;
    this.port = port;
    this.pin = pin;
    if (enabled && !this.server) this.start();
    if (!enabled && this.server) this.stop();
  }

  start() {
    if (this.server) return;
    const server = http.createServer((req, res) => this.handleHttp(req, res));
    server.on("upgrade", (req, socket) => this.handleUpgrade(req, socket));
    server.on("error", (err) => {
      // Порт занят/недоступен — мост просто не поднимется; приложение продолжает работать.
      console.error("[mobile] мост не запустился:", err.message);
    });
    server.listen(this.port, "0.0.0.0");
    this.server = server;
    this.pingTimer = setInterval(() => this.pingAll(), 25000);
    console.log("[mobile] мост запущен на :" + this.port);
  }

  stop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    if (this.server) {
      try {
        this.server.close();
      } catch {}
      this.server = null;
    }
  }

  // ─── Статус для настроек ───
  lanIps() {
    const out = [];
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const ni of ifs[name] || []) {
        if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
      }
    }
    return [...new Set(out)];
  }

  status() {
    const ips = this.lanIps();
    return {
      enabled: this.enabled,
      running: !!this.server,
      port: this.port,
      pin: this.pin || "",
      ips,
      url: ips.length ? "http://" + ips[0] + ":" + this.port : "",
      urls: ips.map((ip) => ({ ip, url: "http://" + ip + ":" + this.port })),
    };
  }

  // ─── HTTP: статика + PWA ───
  handleHttp(req, res) {
    try {
      let p = req.url.split("?")[0];
      if (p === "/") p = "/index.html";
      if (p === "/manifest.webmanifest") {
        res.writeHead(200, { "Content-Type": MIME[".webmanifest"], "Cache-Control": "no-cache" });
        res.end(MANIFEST);
        return;
      }
      if (p === "/sw.js") {
        res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-cache" });
        res.end(SW_JS);
        return;
      }
      if (p === "/icon.svg") {
        res.writeHead(200, { "Content-Type": MIME[".svg"], "Cache-Control": "public, max-age=86400" });
        res.end(ICON_SVG);
        return;
      }
      if (p === "/bootstrap.js") {
        // Маркер моста: mobile-api.js активируется только на страницах, отданных мостом
        // (в веб-превью server.js и Electron этого файла нет — там работает мок/preload).
        res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-cache" });
        res.end("window.__mobileBridge = true;\n");
        return;
      }
      const safe = path.basename(p); // только файлы из renderer, без подкаталогов
      if (STATIC_FILES.has(safe)) {
        const file = path.join(RENDERER_DIR, safe);
        if (!fs.existsSync(file)) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const ext = path.extname(safe).toLowerCase();
        res.writeHead(200, {
          "Content-Type": MIME[ext] || "application/octet-stream",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        });
        fs.createReadStream(file).pipe(res);
        return;
      }
      res.writeHead(404);
      res.end("Not found");
    } catch (e) {
      res.writeHead(500);
      res.end("Internal error");
    }
  }

  // ─── WebSocket: рукопожатие ───
  handleUpgrade(req, socket) {
    if (req.url.split("?")[0] !== "/ws") {
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
    );
    socket.setNoDelay(true);
    const conn = new WsConn(
      socket,
      (payload) => this.onWsMessage(conn, payload),
      (c) => this.clients.delete(c)
    );
    socket.on("data", (chunk) => conn.feed(chunk));
  }

  // ─── WebSocket: протокол (auth → call → res; события → ev) ───
  onWsMessage(conn, payload) {
    let msg;
    try {
      msg = JSON.parse(payload.toString("utf8"));
    } catch {
      return;
    }
    if (!conn.authed) {
      if (msg && msg.t === "auth") {
        const now = Date.now();
        // Глобальная блокировка после серии неудач: не считаем попытки, просто отказываем.
        if (now < this.authLockedUntil) {
          conn.sendText(JSON.stringify({ t: "auth_err", lock: true }));
          return;
        }
        if (this.pin && String(msg.pin) === String(this.pin)) {
          conn.authed = true;
          this.authFailCount = 0; // успешный вход — сбрасываем счётчик перебора
          this.authFailWindowStart = 0;
          this.clients.add(conn);
          conn.sendText(JSON.stringify({ t: "auth_ok", v: this.status() }));
        } else {
          conn.authTries++;
          // Неудача считается в глобальном окне (переподключение не обнуляет счётчик).
          if (now - this.authFailWindowStart > AUTH_FAIL_WINDOW_MS) {
            this.authFailWindowStart = now;
            this.authFailCount = 0;
          }
          this.authFailCount++;
          let locked = false;
          if (this.authFailCount >= AUTH_MAX_FAILS) {
            this.authLockedUntil = now + AUTH_LOCK_MS;
            this.authFailCount = 0;
            locked = true;
          }
          conn.sendText(JSON.stringify({ t: "auth_err", lock: locked }));
          if (conn.authTries >= 5) {
            conn.sendText(JSON.stringify({ t: "auth_lock" }));
            conn.destroy();
          }
        }
      }
      return;
    }
    if (!msg || msg.t !== "call" || !msg.ch) return;
    const { id, ch, args } = msg;
    if (this.deny.has(ch)) {
      conn.sendText(
        JSON.stringify({ t: "res", id, ok: false, e: "Действие недоступно с телефона: " + ch })
      );
      return;
    }
    const fn = this.handlerMap ? this.handlerMap.get(ch) : null;
    if (!fn) {
      conn.sendText(JSON.stringify({ t: "res", id, ok: false, e: "Неизвестный канал: " + ch }));
      return;
    }
    const fakeEvent = { sender: { send() {}, id: 0 } };
    const callArgs = Array.isArray(args) ? args : [];
    Promise.resolve()
      .then(() => fn(fakeEvent, ...callArgs))
      .then(
        (v) => conn.sendText(JSON.stringify({ t: "res", id, ok: true, v })),
        (err) =>
          conn.sendText(
            JSON.stringify({ t: "res", id, ok: false, e: (err && err.message) || String(err) })
          )
      );
  }

  broadcast(channel, ev) {
    if (!this.clients.size) return;
    const payload = JSON.stringify({ t: "ev", ch: channel, v: ev });
    for (const c of this.clients) {
      try {
        c.sendText(payload);
      } catch {}
    }
  }

  pingAll() {
    for (const c of this.clients) {
      try {
        c.sendFrame(0x9, Buffer.alloc(0));
      } catch {}
    }
  }
}

module.exports = MobileBridge;