"use strict";

/* ── Почта для агента: SMTP (отправка) + IMAP (чтение) ──────────────────────
   Всё на встроенных модулях node (net/tls) — НИКАКИХ внешних зависимостей.
   Это принципиально: приложение обновляется по OTA (только папка src), поэтому
   новая библиотека требовала бы `bun install` вручную у пользователя.

   Что умеет:
   - sendMail(): подключение (implicit TLS 465/993 или STARTTLS 587), AUTH LOGIN,
     MAIL FROM / RCPT TO / DATA, письмо в UTF-8 (RFC 2047 для темы, base64 для тела),
     опционально multipart/alternative с HTML-версией;
   - listRecent(): вход по IMAP, SELECT INBOX, UID SEARCH, загрузка последних писем,
     разбор MIME (multipart, base64, quoted-printable, charsets utf-8/cp1251/koi8-r),
     декодирование темы и отправителя (RFC 2047);
   - extractCode(): поиск кода подтверждения в тексте письма.

   Безопасность: заголовки защищены от инъекции CRLF, размер письма и число
   получателей ограничены, пароль нигде не логируется и не возвращается в ответах.
   Сокет фабрикуется через connect (можно подменить в тестах).
*/

const net = require("net");
const tls = require("tls");

const DEFAULT_TIMEOUT = 20000;
const MAX_BODY = 200000; // байт на письмо
const MAX_RECIPIENTS = 20;
const MAX_FETCH = 10; // сколько последних писем забирать за раз

// ── Пресеты серверов по домену адреса ──────────────────────────────────────
const PRESETS = [
  {
    re: /@(gmail|googlemail)\.com$/i,
    imapHost: "imap.gmail.com", imapPort: 993,
    smtpHost: "smtp.gmail.com", smtpPort: 465,
    note: "Gmail: включи двухфакторную аутентификацию и создай «пароль приложения» (обычный пароль Google не подойдёт).",
  },
  {
    re: /@(yandex|ya)\.(ru|com|kz|by|ua)$/i,
    imapHost: "imap.yandex.ru", imapPort: 993,
    smtpHost: "smtp.yandex.ru", smtpPort: 465,
    note: "Яндекс: включи IMAP в «Все настройки → Почтовые программы» и создай пароль приложения для почты.",
  },
  {
    re: /@mail\.ru$/i,
    imapHost: "imap.mail.ru", imapPort: 993,
    smtpHost: "smtp.mail.ru", smtpPort: 465,
    note: "Mail.ru: нужен пароль для внешнего приложения (в настройках безопасности).",
  },
  {
    re: /@(outlook|hotmail|live|msn)\./i,
    imapHost: "outlook.office365.com", imapPort: 993,
    smtpHost: "smtp.office365.com", smtpPort: 587, starttls: true,
    note: "Outlook: SMTP работает через STARTTLS (порт 587).",
  },
  {
    re: /@rambler\.ru$/i,
    imapHost: "imap.rambler.ru", imapPort: 993,
    smtpHost: "smtp.rambler.ru", smtpPort: 465,
  },
];

// ── Утилиты ────────────────────────────────────────────────────────────────
function clip(v, max) {
  return String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim().slice(0, max || 300);
}

// Адрес: грубая, но достаточная проверка (не даём уехать мусору в MAIL FROM).
function isEmail(v) {
  return /^[^\s@,<>"]+@[^\s@,<>"]+\.[^\s@,<>"]{2,}$/.test(clip(v, 320));
}

function guessServers(address) {
  const a = clip(address, 320);
  for (const p of PRESETS) {
    if (p.re.test(a)) {
      return {
        imapHost: p.imapHost, imapPort: p.imapPort,
        smtpHost: p.smtpHost, smtpPort: p.smtpPort,
        starttls: !!p.starttls, note: p.note || "", preset: true,
      };
    }
  }
  const domain = a.includes("@") ? a.split("@").pop().toLowerCase() : "";
  return {
    imapHost: domain ? "imap." + domain : "",
    imapPort: 993,
    smtpHost: domain ? "smtp." + domain : "",
    smtpPort: 465,
    starttls: false,
    note: "Провайдер не опознан — проверь адреса серверов и порты в настройках почты.",
    preset: false,
  };
}

// ── Чтение сокета: строки и точные порции байт (нужно для IMAP-литералов) ──
function createConn(socket) {
  let buf = Buffer.alloc(0);
  let closed = false;
  let error = null;
  const waiters = [];

  const pump = () => {
    while (waiters.length) {
      const w = waiters[0];
      if (error) { waiters.shift(); w.reject(error); continue; }
      let r = null;
      try { r = w.try(); } catch (e) { waiters.shift(); w.reject(e); continue; }
      if (r === null) {
        if (closed) { waiters.shift(); w.reject(new Error("сервер закрыл соединение")); }
        return;
      }
      waiters.shift();
      w.resolve(r);
    }
  };

  socket.on("data", (d) => { buf = Buffer.concat([buf, d]); pump(); });
  socket.on("error", (e) => { error = error || e; pump(); });
  socket.on("close", () => { closed = true; pump(); });
  socket.setTimeout(DEFAULT_TIMEOUT, () => { error = error || new Error("таймаут ожидания ответа почтового сервера"); pump(); });

  const waitFor = (tryFn) => new Promise((resolve, reject) => { waiters.push({ try: tryFn, resolve, reject }); pump(); });
  const waitLine = () => waitFor(() => {
    const i = buf.indexOf("\r\n");
    if (i < 0) return null;
    const line = buf.slice(0, i).toString("utf8");
    buf = buf.slice(i + 2);
    return line;
  });
  const waitBytes = (n) => waitFor(() => {
    if (buf.length < n) return null;
    const out = buf.slice(0, n);
    buf = buf.slice(n);
    return out;
  });

  return {
    socket,
    waitLine,
    waitBytes,
    write: (s) => socket.write(s),
    detach: () => { socket.removeAllListeners("data"); socket.removeAllListeners("close"); socket.removeAllListeners("error"); },
  };
}

// ── SMTP ───────────────────────────────────────────────────────────────────
function connectSocket({ host, port, secure, connect }) {
  if (typeof connect === "function") return connect({ host, port, secure });
  return new Promise((resolve, reject) => {
    const sock = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(sock))
      : net.connect({ host, port }, () => resolve(sock));
    sock.once("error", reject);
    sock.setTimeout(DEFAULT_TIMEOUT, () => { try { sock.destroy(); } catch {} reject(new Error("таймаут подключения к " + host + ":" + port)); });
  });
}

// Одна строка ответа SMTP: может быть многострочной «250-...\r\n250 ...»
async function smtpReply(conn) {
  const lines = [];
  for (;;) {
    const line = await conn.waitLine();
    lines.push(line);
    if (/^\d{3} /.test(line)) break;
    if (!/^\d{3}[- ]/.test(line)) break; // сервер говорит что-то нестандартное — не зависаем
  }
  const code = parseInt(String(lines[lines.length - 1]).slice(0, 3), 10) || 0;
  return { code, text: lines.join("\n") };
}

function b64(s) {
  return Buffer.from(String(s), "utf8").toString("base64");
}

// Обёртка темы/имени по RFC 2047 (иначе кириллица в заголовках превращается в кашу).
function encodeHeader(v) {
  const s = clip(v, 500);
  if (!s) return "";
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return "=?UTF-8?B?" + b64(s) + "?=";
}

function rfc2822Date(d) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n) => String(n).padStart(2, "0");
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? "+" : "-";
  const tz = Math.abs(tzMin);
  return (
    days[d.getDay()] + ", " + p(d.getDate()) + " " + months[d.getMonth()] + " " + d.getFullYear() +
    " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) +
    " " + sign + p(Math.floor(tz / 60)) + p(tz % 60)
  );
}

function wrapB64(s) {
  const b = Buffer.from(s, "utf8").toString("base64");
  return (b.match(/.{1,76}/g) || []).join("\r\n");
}

// Собирает письмо: тема кодируется, тело — base64 (UTF-8), защита от CRLF-инъекций.
function buildMessage({ from, to, subject, text, html, date }) {
  const clean = (v) => String(v == null ? "" : v).replace(/[\r\n]+/g, " ");
  const recipients = (Array.isArray(to) ? to : [to]).map(clean).filter(Boolean);
  const subj = clip(subject, 500) || "(без темы)";
  const when = date || new Date();
  const head = [
    "From: " + from,
    "To: " + recipients.join(", "),
    "Subject: " + encodeHeader(subj),
    "Date: " + rfc2822Date(when),
    "MIME-Version: 1.0",
  ];
  const bodyText = String(text == null ? "" : text).replace(/\r?\n/g, "\r\n");
  const bodyHtml = String(html == null ? "" : html).replace(/\r?\n/g, "\r\n");
  if (bodyHtml) {
    const boundary = "==alt_" + Math.random().toString(36).slice(2) + "_" + when.getTime();
    return (
      head.join("\r\n") + "\r\n" +
      'Content-Type: multipart/alternative; boundary="' + boundary + '"\r\n\r\n' +
      "--" + boundary + "\r\n" +
      'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
      wrapB64(bodyText) + "\r\n" +
      "--" + boundary + "\r\n" +
      'Content-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
      wrapB64(bodyHtml) + "\r\n" +
      "--" + boundary + "--\r\n"
    );
  }
  return (
    head.join("\r\n") + "\r\n" +
    'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
    wrapB64(bodyText) + "\r\n"
  );
}

// Отправка письма. cfg: { host, port, user, password, secure, starttls, connect, timeout }
async function sendMail(cfg, letter) {
  const host = clip(cfg && cfg.host, 200);
  const port = parseInt(cfg && cfg.port, 10) || 465;
  const user = clip(cfg && cfg.user, 320);
  const password = String((cfg && cfg.password) || "");
  if (!host) return { ok: false, error: "Не задан SMTP-сервер (Настройки → ✉️ Почта)." };
  if (!isEmail(user)) return { ok: false, error: "Не задан адрес почты отправителя." };
  if (!password) return { ok: false, error: "Не задан пароль приложения для почты (Настройки → ✉️ Почта)." };

  const to = (Array.isArray(letter && letter.to) ? letter.to : [letter && letter.to]).filter(Boolean).map((v) => clip(v, 320));
  if (!to.length || !to.every(isEmail)) return { ok: false, error: "Проверь адреса получателей (нужен вид name@domain.ru)." };
  if (to.length > MAX_RECIPIENTS) return { ok: false, error: "Слишком много получателей (максимум " + MAX_RECIPIENTS + ")." };

  const message = buildMessage({
    from: (clip(letter && letter.fromName, 120) ? encodeHeader(letter.fromName) + " " : "") + "<" + user + ">",
    to,
    subject: letter && letter.subject,
    text: letter && letter.text,
    html: letter && letter.html,
  });
  if (Buffer.byteLength(message, "utf8") > MAX_BODY) return { ok: false, error: "Письмо слишком большое (лимит 200 КБ)." };

  const secure = cfg.secure !== false && !cfg.starttls;
  let conn = null;
  try {
    const socket = await connectSocket({ host, port, secure, connect: cfg.connect });
    conn = createConn(socket);
    let greeting = await smtpReply(conn);
    if (greeting.code !== 220) throw new Error("сервер не поздоровался: " + greeting.text.slice(0, 160));

    const ehlo = async () => {
      conn.write("EHLO ai-agent\r\n");
      const r = await smtpReply(conn);
      if (r.code !== 250) throw new Error("EHLO отклонён: " + r.text.slice(0, 160));
      return r.text.toLowerCase();
    };
    let caps = await ehlo();

    if (cfg.starttls) {
      if (!/starttls/.test(caps)) throw new Error("сервер не поддерживает STARTTLS");
      conn.write("STARTTLS\r\n");
      const r = await smtpReply(conn);
      if (r.code !== 220) throw new Error("STARTTLS отклонён: " + r.text.slice(0, 160));
      conn.detach();
      const upgraded = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: conn.socket, servername: host }, () => resolve(t));
        t.once("error", reject);
      });
      conn = createConn(upgraded);
      caps = await ehlo();
    }

    if (!/auth/.test(caps)) throw new Error("сервер не поддерживает AUTH (вход по паролю)");
    conn.write("AUTH LOGIN\r\n");
    let r = await smtpReply(conn);
    if (r.code !== 334) throw new Error("AUTH LOGIN отклонён: " + r.text.slice(0, 160));
    conn.write(b64(user) + "\r\n");
    r = await smtpReply(conn);
    if (r.code !== 334) throw new Error("сервер не запросил пароль: " + r.text.slice(0, 160));
    conn.write(b64(password) + "\r\n");
    r = await smtpReply(conn);
    if (r.code !== 235) {
      return {
        ok: false,
        error:
          "Сервер отклонил вход (" + r.code + "). Для Gmail/Яндекса/Mail.ru нужен «пароль приложения», " +
          "обычный пароль не подойдёт. Ответ сервера: " + r.text.slice(0, 200),
      };
    }

    conn.write("MAIL FROM:<" + user + ">\r\n");
    r = await smtpReply(conn);
    if (r.code !== 250) throw new Error("MAIL FROM отклонён: " + r.text.slice(0, 160));
    for (const rcpt of to) {
      conn.write("RCPT TO:<" + rcpt + ">\r\n");
      r = await smtpReply(conn);
      if (r.code !== 250 && r.code !== 251) return { ok: false, error: "Получатель " + rcpt + " отклонён сервером: " + r.text.slice(0, 160) };
    }
    conn.write("DATA\r\n");
    r = await smtpReply(conn);
    if (r.code !== 354) throw new Error("DATA отклонён: " + r.text.slice(0, 160));
    // Точка в начале строки экранируется удвоением (RFC 5321).
    conn.write(message.replace(/^\./gm, "..") + "\r\n.\r\n");
    r = await smtpReply(conn);
    if (r.code !== 250) throw new Error("Письмо не принято: " + r.text.slice(0, 200));
    try { conn.write("QUIT\r\n"); } catch {}
    return { ok: true, to, messageId: r.text.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: "SMTP: " + ((e && e.message) || String(e)).slice(0, 300) };
  } finally {
    if (conn && conn.socket) { try { conn.detach(); } catch {} try { conn.socket.destroy(); } catch {} }
  }
}

// ── IMAP ───────────────────────────────────────────────────────────────────
function quote(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// Читает полный ответ на команду: собирает строки и «вытаскивает» литералы {N}.
async function imapResponse(conn, tag) {
  const rows = [];
  const done = new RegExp("^" + tag + " (OK|NO|BAD)", "i");
  for (;;) {
    let line = await conn.waitLine();
    const row = { text: "", literals: [] };
    for (;;) {
      const m = line.match(/\{(\d+)\+?\}$/);
      if (!m) { row.text += line; break; }
      row.text += line.slice(0, line.length - m[0].length);
      row.literals.push(await conn.waitBytes(parseInt(m[1], 10)));
      line = await conn.waitLine(); // продолжение строки после литерала
    }
    rows.push(row);
    if (done.test(row.text)) break;
    if (rows.length > 5000) throw new Error("слишком длинный ответ IMAP");
  }
  const last = rows[rows.length - 1].text;
  if (!/^.*\bOK\b/i.test(last)) throw new Error("IMAP: " + last.slice(0, 200));
  return rows;
}

// ── Разбор MIME ────────────────────────────────────────────────────────────
// Таблицы для однобайтных кодировок (в Node их декодирования из коробки нет).
// CP1251: 8 строк по 16 символов — 0x80…0xFF. Ниже 0xC0 идёт кириллица,
// без неё русские письма декодировались в пустоту (баг был реальный).
const CP1251 = [
  "\u0402\u0403\u201A\u0453\u201E\u2026\u2020\u2021\u20AC\u2030\u0409\u2039\u040A\u040C\u040B\u040F",
  "\u0452\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u2122\u0459\u203A\u045A\u045C\u045B\u045F\u00A0",
  "\u040E\u045E\u0408\u00A4\u0490\u00A6\u00A7\u0401\u00A9\u0404\u00AB\u00AC\u00AD\u00AE\u0407\u00B0",
  "\u00B1\u0406\u0456\u0491\u00B5\u00B6\u00B7\u0451\u2116\u0454\u00BB\u0458\u0405\u0455\u0457\u00BF",
  "\u0410\u0411\u0412\u0413\u0414\u0415\u0416\u0417\u0418\u0419\u041A\u041B\u041C\u041D\u041E\u041F",
  "\u0420\u0421\u0422\u0423\u0424\u0425\u0426\u0427\u0428\u0429\u042A\u042B\u042C\u042D\u042E\u042F",
  "\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u0439\u043A\u043B\u043C\u043D\u043E\u043F",
  "\u0440\u0441\u0442\u0443\u0444\u0445\u0446\u0447\u0448\u0449\u044A\u044B\u044C\u044D\u044E\u044F",
];
const KOI8R = [
  "\u2500\u2502\u250C\u2510\u2514\u2518\u251C\u2524\u252C\u2534\u253C\u2580\u2584\u2588\u258C\u2590",
  "\u2591\u2592\u2593\u2320\u25A0\u2219\u221A\u2248\u2264\u2265\u00A0\u2321\u00B0\u00B2\u00B7\u00F7",
  "\u2550\u2551\u2552\u0451\u2553\u2554\u2555\u2556\u2557\u2558\u2559\u255A\u255B\u255C\u255D\u255E",
  "\u255F\u2560\u2561\u0401\u2562\u2563\u2564\u2565\u2566\u2567\u2568\u2569\u256A\u256B\u256C\u00A9",
  "\u044E\u0430\u0431\u0446\u0434\u0435\u0444\u0433\u0445\u0438\u0439\u043A\u043B\u043C\u043D\u043E",
  "\u043F\u044F\u0440\u0441\u0442\u0443\u0436\u0432\u044C\u044B\u0437\u0448\u044D\u0449\u0447\u044A",
  "\u042E\u0410\u0411\u0426\u0414\u0415\u0424\u0413\u0425\u0418\u0419\u041A\u041B\u041C\u041D\u041E",
  "\u041F\u042F\u0420\u0421\u0422\u0423\u0416\u0412\u042C\u042B\u0417\u0428\u042D\u0429\u0427\u042A",
];

function singleByte(buf, table) {
  let out = "";
  for (const b of buf) {
    if (b < 128) { out += String.fromCharCode(b); continue; }
    const row = table[floorDiv(b - 128, 16)];
    out += row ? row.charAt((b - 128) % 16) : "\uFFFD";
  }
  return out;
}

// UTF-8 с «спасением»: если письмо объявлено UTF-8, а байты на самом деле
// однобайтная кириллица (частая беда русских рассылок) — декодируем как CP1251.
function decodeUtf8(buf) {
  const s = buf.toString("utf8");
  return s.indexOf("\uFFFD") === -1 ? s : singleByte(buf, CP1251);
}

function decodeBytes(buf, charset) {
  const cs = String(charset || "utf-8").toLowerCase().replace(/["']/g, "").trim();
  if (cs === "utf-8" || cs === "utf8" || cs === "us-ascii" || cs === "ascii" || cs === "") return decodeUtf8(buf);
  if (cs === "iso-8859-1" || cs === "latin1" || cs === "windows-1252" || cs === "cp1252") return buf.toString("latin1");
  if (cs === "windows-1251" || cs === "cp1251") return singleByte(buf, CP1251);
  if (cs === "koi8-r" || cs === "koi8r") return singleByte(buf, KOI8R);
  return decodeUtf8(buf); // неизвестная кодировка — пробуем UTF-8, затем CP1251
}

function floorDiv(a, b) {
  return Math.floor(a / b);
}

// Декодирование quoted-printable: =XX → байт, «=» в конце строки — мягкий перенос.
function decodeQuotedPrintable(s) {
  const bytes = [];
  const src = String(s).replace(/=\r?\n/g, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "=" && i + 2 < src.length) {
      const hex = src.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); i += 2; continue; }
    }
    bytes.push(src.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes);
}

// RFC 2047: =?UTF-8?B?...?= и =?UTF-8?Q?...?= (в Q подчёркивание — пробел).
function decodeWords(s) {
  return String(s || "").replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset, enc, data) => {
    try {
      if (enc.toUpperCase() === "B") return decodeBytes(Buffer.from(data, "base64"), charset);
      return decodeBytes(decodeQuotedPrintable(data.replace(/_/g, " ")), charset);
    } catch {
      return _m;
    }
  });
}

function splitHeadersBody(raw) {
  const i = raw.indexOf("\r\n\r\n");
  if (i >= 0) return { head: raw.slice(0, i), body: raw.slice(i + 4) };
  const j = raw.indexOf("\n\n");
  if (j >= 0) return { head: raw.slice(0, j), body: raw.slice(j + 2) };
  return { head: raw, body: "" };
}

function parseHeaders(head) {
  const out = {};
  const lines = String(head).split(/\r?\n/);
  let key = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && key) { out[key] += " " + line.trim(); continue; }
    const i = line.indexOf(":");
    if (i < 0) continue;
    key = line.slice(0, i).trim().toLowerCase();
    out[key] = line.slice(i + 1).trim();
  }
  return out;
}

function headerParam(value, name) {
  const m = String(value || "").match(new RegExp(name + '\\s*=\\s*"([^"]*)"', "i")) || String(value || "").match(new RegExp(name + "\\s*=\\s*([^;\\s]+)", "i"));
  return m ? m[1].trim() : "";
}

// Достаёт текстовую часть письма (с учётом multipart и transfer-encoding).
function decodeBody(head, body, depth) {
  const headers = parseHeaders(head);
  const ctype = headers["content-type"] || "text/plain";
  const enc = String(headers["content-transfer-encoding"] || "").toLowerCase().trim();
  const boundary = headerParam(ctype, "boundary");

  if (/^multipart\//i.test(ctype) && boundary) {
    const parts = String(body).split("--" + boundary);
    let best = null;
    for (const part of parts) {
      if (!part || /^--/.test(part.trim())) continue;
      const p = splitHeadersBody(part.replace(/^\r?\n/, ""));
      const pt = (parseHeaders(p.head)["content-type"] || "").toLowerCase();
      if (/^multipart\//.test(pt) && (depth || 0) < 3) {
        const nested = decodeBody(p.head, p.body, (depth || 0) + 1);
        if (nested.text && (!best || /text\/plain/.test(pt))) best = nested;
        continue;
      }
      if (/^text\/plain/.test(pt)) return decodeBody(p.head, p.body, (depth || 0) + 1);
      if (/^text\/html/.test(pt) && !best) best = decodeBody(p.head, p.body, (depth || 0) + 1);
    }
    return best || { text: "", charset: "" };
  }

  const charset = headerParam(ctype, "charset") || "utf-8";
  let buf;
  if (enc === "base64") buf = Buffer.from(String(body).replace(/\s+/g, ""), "base64");
  else if (enc === "quoted-printable") buf = decodeQuotedPrintable(body);
  else buf = Buffer.from(String(body), "latin1");
  let text = decodeBytes(buf, charset);
  if (/^text\/html/i.test(ctype)) {
    text = text
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n");
  }
  return { text: text.trim(), charset, html: /^text\/html/i.test(ctype) };
}

// Полное письмо (сырые байты, latin1-строка) → структурированный объект.
function parseMessage(raw, uid) {
  const { head, body } = splitHeadersBody(raw);
  const h = parseHeaders(head);
  const decoded = decodeBody(head, body, 0);
  const from = decodeWords(h.from || "");
  return {
    uid: uid == null ? null : uid,
    from,
    fromAddress: (from.match(/<([^>]+)>/) || [, from])[1].trim(),
    to: decodeWords(h.to || ""),
    subject: decodeWords(h.subject || "") || "(без темы)",
    date: decodeWords(h.date || ""),
    text: (decoded.text || "").slice(0, 20000),
    html: !!decoded.html,
    charset: decoded.charset || "",
  };
}

// Чтение последних писем. cfg: { host, port, user, password, secure, connect }
async function listRecent(cfg, opts) {
  opts = opts || {};
  const host = clip(cfg && cfg.host, 200);
  const port = parseInt((cfg && cfg.port) || 993, 10);
  const user = clip(cfg && cfg.user, 320);
  const password = String((cfg && cfg.password) || "");
  if (!host) return { ok: false, error: "Не задан IMAP-сервер (Настройки → ✉️ Почта)." };
  if (!isEmail(user)) return { ok: false, error: "Не задан адрес почты (Настройки → ✉️ Почта)." };
  if (!password) return { ok: false, error: "Не задан пароль приложения для почты (Настройки → ✉️ Почта)." };
  const limit = Math.max(1, Math.min(parseInt(opts.limit, 10) || 5, MAX_FETCH));

  let conn = null;
  try {
    const socket = await connectSocket({ host, port, secure: cfg.secure !== false, connect: cfg.connect });
    conn = createConn(socket);
    const greeting = await conn.waitLine();
    if (!/^\* OK/i.test(greeting)) throw new Error("IMAP не поздоровался: " + greeting.slice(0, 120));

    let seq = 0;
    const cmd = async (text) => {
      const tag = "a" + ++seq;
      conn.write(tag + " " + text + "\r\n");
      return imapResponse(conn, tag);
    };

    try {
      await cmd("LOGIN " + quote(user) + " " + quote(password));
    } catch (e) {
      return {
        ok: false,
        error:
          "IMAP: вход отклонён. Для Gmail/Яндекса/Mail.ru нужен «пароль приложения» (обычный пароль не подойдёт). " +
          "Ответ сервера: " + ((e && e.message) || String(e)).slice(0, 200),
      };
    }
    await cmd("SELECT INBOX");

    const searchRows = await cmd("UID SEARCH " + (opts.unseenOnly ? "UNSEEN" : "ALL"));
    const searchText = searchRows.map((r) => r.text).join("\n");
    const all = (searchText.match(/^\* SEARCH([\s\S]*)$/m) || [, ""])[1].trim().split(/\s+/).filter(Boolean);
    const uids = all.slice(-limit);
    if (!uids.length) return { ok: true, messages: [], total: 0 };

    const rows = await cmd("UID FETCH " + uids.join(",") + " (UID BODY.PEEK[])");
    const messages = [];
    for (const row of rows) {
      if (!/^\* \d+ FETCH/i.test(row.text)) continue;
      const uid = (row.text.match(/UID (\d+)/) || [])[1];
      const raw = row.literals.length ? row.literals[row.literals.length - 1].toString("latin1") : "";
      if (!raw) continue;
      messages.push(parseMessage(raw, uid ? parseInt(uid, 10) : null));
    }
    try { await cmd("LOGOUT"); } catch {}
    return { ok: true, messages, total: all.length };
  } catch (e) {
    return { ok: false, error: "IMAP: " + ((e && e.message) || String(e)).slice(0, 300) };
  } finally {
    if (conn && conn.socket) { try { conn.detach(); } catch {} try { conn.socket.destroy(); } catch {} }
  }
}

// ── Код подтверждения ──────────────────────────────────────────────────────
// Ищем числа 4–8 знаков рядом со словами «код/code/подтвержд/verification», иначе —
// первый подходящий номер (годы, телефоны и цены отсеиваем).
function extractCode(text) {
  const s = String(text || "");
  if (!s) return null;
  const words = /(код|code|подтвержд|verif|otp|pin|пароль|password)/i;
  const nums = [];
  const re = /(?<![0-9])([0-9]{4,8})(?![0-9])/g;
  let m;
  while ((m = re.exec(s))) nums.push({ value: m[1], at: m.index });
  const near = nums.filter((n) => words.test(s.slice(Math.max(0, n.at - 120), n.at + 120)));
  const pick = (n) => {
    if (/^(19|20)\d{2}$/.test(n.value)) return false; // год
    if (/^8\d{10}$/.test(n.value)) return false;
    if (/^\d{10,}$/.test(n.value)) return false;
    return true;
  };
  const good = near.filter(pick);
  if (good.length) return good[good.length - 1].value;
  const any = nums.filter(pick);
  return any.length ? any[any.length - 1].value : null;
}

module.exports = {
  PRESETS,
  MAX_FETCH,
  clip,
  isEmail,
  guessServers,
  buildMessage,
  encodeHeader,
  smtpReply,
  parseMessage,
  parseHeaders,
  decodeWords,
  decodeBytes,
  decodeQuotedPrintable,
  decodeBody,
  extractCode,
  sendMail,
  listRecent,
  _createConn: createConn,
};
