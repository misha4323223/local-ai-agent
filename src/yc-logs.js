"use strict";

/* ── Логи Yandex Cloud БЕЗ внешнего yc CLI ──────────────────────────────────
   Почему так, а не «просто REST»: у сервиса Cloud Logging в REST-справочнике
   есть только Export, LogGroup, Operation и Sink. Чтение записей
   (LogReadingService.Read) HTTP-привязки НЕ имеет — метод доступен только по
   gRPC (в proto нет google.api.http). Поэтому:
     • список лог-групп берём обычным REST:   GET  {base}/logging/v1/logGroups
     • записи читаем по gRPC:                 POST {base}/yandex.cloud.logging.v1.LogReadingService/Read
   Всё на встроенных модулях node (http2 + свой минимальный protobuf), чтобы
   обновление доезжало по OTA без установки пакетов.
*/

const http2 = require("http2");

// ── Минимальный protobuf (varint / length-delimited) ───────────────────────
function varint(n) {
  const out = [];
  let v = BigInt(n);
  if (v < 0n) v += 1n << 64n;
  while (v > 127n) {
    out.push(Number(v & 127n) | 128);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function tag(field, wire) {
  return varint((Number(field) << 3) | wire);
}

function pbString(field, value) {
  const b = Buffer.from(String(value == null ? "" : value), "utf8");
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
}

function pbMessage(field, buf) {
  return Buffer.concat([tag(field, 2), varint(buf.length), buf]);
}

function pbInt(field, n) {
  return Buffer.concat([tag(field, 0), varint(n)]);
}

// google.protobuf.Timestamp { int64 seconds = 1; int32 nanos = 2; }
function pbTimestamp(field, ms) {
  const t = Number(ms) || 0;
  const seconds = Math.floor(t / 1000);
  const nanos = Math.max(0, Math.round((t - seconds * 1000) * 1e6));
  return pbMessage(field, Buffer.concat([pbInt(1, seconds), pbInt(2, nanos)]));
}

function readVarint(buf, pos) {
  let shift = 0n;
  let val = 0n;
  while (pos < buf.length) {
    const b = buf[pos++];
    val |= BigInt(b & 127) << shift;
    if (!(b & 128)) return { value: val, pos };
    shift += 7n;
    if (shift > 70n) break;
  }
  return { value: val, pos };
}

// Разбирает сообщение в плоский список полей: { field, wire, num | buf }
function pbDecode(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const t = readVarint(buf, pos);
    pos = t.pos;
    const field = Number(t.value >> 3n);
    const wire = Number(t.value & 7n);
    if (!field) break;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      out.push({ field, wire, num: v.value });
    } else if (wire === 2) {
      const l = readVarint(buf, pos);
      pos = l.pos;
      const len = Number(l.value);
      if (!Number.isFinite(len) || len < 0 || pos + len > buf.length) break;
      out.push({ field, wire, buf: buf.slice(pos, pos + len) });
      pos += len;
    } else if (wire === 5) {
      out.push({ field, wire, num: BigInt(buf.readUInt32LE(pos)) });
      pos += 4;
    } else if (wire === 1) {
      out.push({ field, wire, num: buf.readBigUInt64LE(pos) });
      pos += 8;
    } else {
      break; // неизвестный wire-тип — дальше разбирать нельзя
    }
  }
  return out;
}

function pbFirstString(fields, num) {
  for (const f of fields) if (f.field === num && f.wire === 2) return f.buf.toString("utf8");
  return "";
}

function parseTimestamp(buf) {
  if (!buf) return 0;
  const f = pbDecode(buf);
  let seconds = 0;
  let nanos = 0;
  for (const x of f) {
    if (x.field === 1 && x.wire === 0) seconds = Number(x.num);
    if (x.field === 2 && x.wire === 0) nanos = Number(x.num);
  }
  return seconds * 1000 + Math.round(nanos / 1e6);
}

// google.protobuf.Struct { map<string, Value> fields = 1 }
function parseValue(buf) {
  for (const f of pbDecode(buf)) {
    if (f.field === 1) return null; // null_value
    if (f.field === 2 && f.wire === 1) {
      const d = Buffer.alloc(8);
      d.writeBigUInt64LE(f.num);
      return d.readDoubleLE(0);
    }
    if (f.field === 3 && f.wire === 2) return f.buf.toString("utf8");
    if (f.field === 4 && f.wire === 0) return Number(f.num) !== 0;
    if (f.field === 5 && f.wire === 2) return parseStruct(f.buf);
    if (f.field === 6 && f.wire === 2) return parseList(f.buf);
  }
  return null;
}

function parseList(buf) {
  const out = [];
  for (const f of pbDecode(buf)) if (f.field === 1 && f.wire === 2) out.push(parseValue(f.buf));
  return out;
}

function parseStruct(buf) {
  if (!buf) return null;
  const out = {};
  for (const f of pbDecode(buf)) {
    if (f.field !== 1 || f.wire !== 2) continue;
    const entry = pbDecode(f.buf);
    let key = "";
    let value = null;
    for (const e of entry) {
      if (e.field === 1 && e.wire === 2) key = e.buf.toString("utf8");
      if (e.field === 2 && e.wire === 2) value = parseValue(e.buf);
    }
    if (key) out[key] = value;
  }
  return out;
}

// LogEntry { uid=1, resource=2{type=1,id=2}, timestamp=3, ingested_at=4,
//            saved_at=5, level=6, message=7, json_payload=8, stream_name=9 }
const LEVEL_NAMES = { 0: "", 1: "TRACE", 2: "DEBUG", 3: "INFO", 4: "WARN", 5: "ERROR", 6: "FATAL" };

function parseEntry(buf) {
  const entry = { uid: "", type: "", resourceId: "", stream: "", timestamp: 0, level: 0, message: "", json: null };
  for (const f of pbDecode(buf)) {
    if (f.wire !== 2 && f.wire !== 0) continue;
    if (f.field === 1 && f.wire === 2) entry.uid = f.buf.toString("utf8");
    else if (f.field === 2 && f.wire === 2) {
      const r = pbDecode(f.buf);
      entry.type = pbFirstString(r, 1);
      entry.resourceId = pbFirstString(r, 2);
    } else if (f.field === 3 && f.wire === 2) entry.timestamp = parseTimestamp(f.buf);
    else if (f.field === 6 && f.wire === 0) entry.level = Number(f.num);
    else if (f.field === 7 && f.wire === 2) entry.message = f.buf.toString("utf8");
    else if (f.field === 8 && f.wire === 2) entry.json = parseStruct(f.buf);
    else if (f.field === 9 && f.wire === 2) entry.stream = f.buf.toString("utf8");
  }
  return entry;
}

// ReadResponse { log_group_id=1, entries=2 (repeated LogEntry) }
function parseReadResponse(buf) {
  const entries = [];
  if (!buf || !buf.length) return entries;
  for (const f of pbDecode(buf)) if (f.field === 2 && f.wire === 2) entries.push(parseEntry(f.buf));
  return entries;
}

// ── gRPC поверх встроенного http2 (унарный вызов) ──────────────────────────
function grpcFrames(buf) {
  const out = [];
  let pos = 0;
  while (pos + 5 <= buf.length) {
    const flag = buf.readUInt8(pos);
    const len = buf.readUInt32BE(pos + 1);
    pos += 5;
    if (len < 0 || pos + len > buf.length) break;
    if (!flag) out.push(buf.slice(pos, pos + len)); // сжатые кадры не поддерживаем
    pos += len;
  }
  return out;
}

function grpcCall(origin, methodPath, iamToken, messageBuf, timeoutMs) {
  const timeout = Math.max(2000, Number(timeoutMs) || 25000);
  return new Promise((resolve, reject) => {
    let client;
    try {
      client = http2.connect(origin);
    } catch (e) {
      reject(new Error("не удалось подключиться к " + origin + ": " + ((e && e.message) || e)));
      return;
    }
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch {}
      fn(arg);
    };
    client.on("error", (e) => finish(reject, new Error("соединение с " + origin + ": " + ((e && e.message) || e))));

    let req;
    try {
      req = client.request({
        ":method": "POST",
        ":path": methodPath,
        "content-type": "application/grpc+proto",
        te: "trailers",
        "grpc-timeout": Math.max(1, Math.round(timeout / 1000)) + "S",
        authorization: "Bearer " + iamToken,
      });
    } catch (e) {
      finish(reject, new Error("не удалось создать gRPC-запрос: " + ((e && e.message) || e)));
      return;
    }

    const chunks = [];
    let httpStatus = 0;
    let grpcStatus = null;
    let grpcMessage = "";
    const takeHeaders = (headers) => {
      if (headers[":status"] !== undefined) httpStatus = Number(headers[":status"]);
      if (headers["grpc-status"] !== undefined) grpcStatus = Number(headers["grpc-status"]);
      if (headers["grpc-message"] !== undefined) {
        try {
          grpcMessage = decodeURIComponent(String(headers["grpc-message"]));
        } catch {
          grpcMessage = String(headers["grpc-message"]);
        }
      }
    };

    req.on("response", takeHeaders);
    req.on("trailers", takeHeaders);
    req.on("data", (d) => chunks.push(d));
    req.on("error", (e) => finish(reject, new Error("gRPC-запрос: " + ((e && e.message) || e))));
    req.setTimeout(timeout, () => {
      try { req.close(); } catch {}
      finish(reject, new Error("таймаут чтения логов (" + Math.round(timeout / 1000) + " с)"));
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (grpcStatus !== null && grpcStatus !== 0) {
        const hint =
          grpcStatus === 7
            ? " (нет прав: аккаунту не хватает роли logging.viewer на каталог)"
            : grpcStatus === 16
              ? " (не пройдена авторизация: проверь OAuth-токен)"
              : grpcStatus === 5
                ? " (лог-группа не найдена)"
                : "";
        return finish(reject, new Error("gRPC " + grpcStatus + hint + ": " + (grpcMessage || "ошибка сервиса логирования")));
      }
      if (httpStatus && httpStatus !== 200) {
        return finish(reject, new Error("HTTP " + httpStatus + ": " + body.toString("utf8").slice(0, 300)));
      }
      finish(resolve, grpcFrames(body));
    });

    const frame = Buffer.alloc(5 + messageBuf.length);
    frame.writeUInt8(0, 0);
    frame.writeUInt32BE(messageBuf.length, 1);
    messageBuf.copy(frame, 5);
    req.end(frame);
  });
}

// ── REST: список лог-групп каталога ────────────────────────────────────────
async function listLogGroups(iamToken, baseUrl, folderId, fetchImpl) {
  const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!f) throw new Error("нет доступа к сети (fetch недоступен)");
  const url = String(baseUrl).replace(/\/+$/, "") + "/logging/v1/logGroups?folderId=" + encodeURIComponent(folderId) + "&pageSize=100";
  const res = await f(url, { headers: { Authorization: "Bearer " + iamToken }, redirect: "follow" });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error("лог-группы: HTTP " + res.status + " " + String(text).slice(0, 200));
  let j = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = null;
  }
  const groups = Array.isArray(j && j.groups) ? j.groups : [];
  return groups.map((g) => ({ id: g.id, name: g.name || "", createdAt: g.createdAt || "" }));
}

// ── Чтение записей: критерий + gRPC ────────────────────────────────────────
function buildReadRequest({ logGroupId, resourceIds, resourceTypes, sinceMs, untilMs, pageSize, filter }) {
  let criteria = Buffer.concat([pbString(1, logGroupId)]);
  const types = (Array.isArray(resourceTypes) ? resourceTypes : []).filter(Boolean).slice(0, 100);
  const ids = (Array.isArray(resourceIds) ? resourceIds : []).filter(Boolean).slice(0, 100);
  for (const t of types) criteria = Buffer.concat([criteria, pbString(2, t)]);
  for (const id of ids) criteria = Buffer.concat([criteria, pbString(3, id)]);
  if (sinceMs) criteria = Buffer.concat([criteria, pbTimestamp(4, sinceMs)]);
  if (untilMs) criteria = Buffer.concat([criteria, pbTimestamp(5, untilMs)]);
  if (filter) criteria = Buffer.concat([criteria, pbString(7, filter)]);
  criteria = Buffer.concat([criteria, pbInt(8, pageSize || 100)]);
  return pbMessage(2, criteria); // ReadRequest{ criteria = 2 }
}

async function readLogs(opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const baseUrl = String(o.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("не задан адрес сервиса логирования");
  const folderId = String(o.folderId || "").trim();
  if (!folderId) throw new Error("не выбран каталог (folder)");
  const resourceIds = (Array.isArray(o.resourceIds) ? o.resourceIds : [o.resourceIds]).map((x) => String(x || "").trim()).filter(Boolean);
  const limit = Math.max(1, Math.min(parseInt(o.limit, 10) || 100, 1000));
  const sinceMs = o.sinceMs || Date.now() - Math.max(1, Number(o.sinceHours) || 3) * 3600 * 1000;

  const groups = await listLogGroups(o.iamToken, baseUrl, folderId, fetchImpl);
  if (!groups.length) {
    const e = new Error(
      "в каталоге нет ни одной лог-группы. Логи этого ресурса в Yandex Cloud не собирались: " +
      "включи их в консоли (Cloud Logging) — или они появятся сами после первых записей."
    );
    e.status = 404;
    throw e;
  }
  const group = o.logGroupId ? groups.find((g) => g.id === o.logGroupId) || { id: o.logGroupId, name: "" } : groups[0];

  const reqBuf = buildReadRequest({
    logGroupId: group.id,
    resourceIds,
    resourceTypes: o.resourceTypes,
    sinceMs,
    untilMs: o.untilMs,
    pageSize: limit,
    filter: o.filter,
  });

  const grpc = o.grpcCall || grpcCall;
  const parts = await grpc(baseUrl, "/yandex.cloud.logging.v1.LogReadingService/Read", o.iamToken, reqBuf, o.timeoutMs || 25000);
  const frames = Array.isArray(parts) ? parts : grpcFrames(parts);
  const entries = parseReadResponse(frames[0] || Buffer.alloc(0));
  return { logGroupId: group.id, logGroupName: group.name, entries: entries.slice(-limit) };
}

// Человекочитаемая строка записи (для чата и панели логов).
function formatEntries(entries, opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(parseInt(o.max, 10) || 50, 500));
  const list = (Array.isArray(entries) ? entries : []).slice(-limit);
  const multi = new Set(list.map((e) => e.resourceId).filter(Boolean)).size > 1;
  return list.map((e) => {
    const ts = e.timestamp ? new Date(e.timestamp).toISOString().replace("T", " ").slice(0, 19) : "";
    const lvl = (LEVEL_NAMES[e.level] || "").padEnd(5);
    let msg = e.message;
    if (!msg && e.json) {
      try {
        msg = JSON.stringify(e.json);
      } catch {
        msg = "(json-payload)";
      }
    }
    const who = multi && e.resourceId ? "[" + e.resourceId.slice(0, 12) + "] " : "";
    return (ts ? ts + "  " : "") + lvl + " " + who + String(msg || "").slice(0, 600);
  });
}

module.exports = {
  LEVEL_NAMES,
  varint,
  tag,
  pbString,
  pbMessage,
  pbInt,
  pbTimestamp,
  pbDecode,
  parseTimestamp,
  parseStruct,
  parseValue,
  parseEntry,
  parseReadResponse,
  grpcFrames,
  grpcCall,
  listLogGroups,
  buildReadRequest,
  readLogs,
  formatEntries,
  _pb: { varint, pbDecode, pbString, pbMessage, pbInt, pbTimestamp },
};
