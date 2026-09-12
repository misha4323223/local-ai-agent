"use strict";

/* ─── Хранилище агента: память проекта и точки отката ─────────────────────────
   Чистый Node-модуль (без Electron): используется main.js (desktop) и
   покрывается smoke-тестами.

   Память проекта (noteSave/noteRead/noteList/noteDelete):
     заметки агента, привязанные к рабочей директории. Переживают перезапуск
     и видны в следующих сессиях. Хранятся в
     <userData>/project-memory/<hash(workdir)>.json — ВНЕ проекта, чтобы
     не попадали в git и не мусорили в репозитории.

   Точки отката (checkpointSave/checkpointList/checkpointRollback):
     полный снимок текстовых файлов рабочей директории перед серией рискованных
     правок; rollback восстанавливает их все разом. Хранятся в
     <userData>/checkpoints/<id>.json.
*/

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ── Заметки ────────────────────────────────────────────────────────────────
const NOTE_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;
const NOTE_MAX_LEN = 6000; // символов на заметку
const NOTE_MAX_COUNT = 100; // заметок на проект

function memoryFile(userData, workdir) {
  const hash = crypto.createHash("sha1").update(String(workdir || "")).digest("hex").slice(0, 16);
  return path.join(userData, "project-memory", hash + ".json");
}

function memoryLoad(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    if (d && typeof d === "object" && !Array.isArray(d)) return d;
  } catch {}
  return {};
}

function memorySave(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function noteValidateKey(key) {
  const k = String(key || "").trim();
  return NOTE_KEY_RE.test(k) ? k : null;
}

// Сохранить/перезаписать заметку key. Возвращает { ok, message } или { ok:false, error }.
function noteSave(userData, workdir, key, content) {
  const k = noteValidateKey(key);
  if (!k) {
    return { ok: false, error: "key может содержать только латиницу, цифры, точку, дефис и подчёркивание (1–64 символа)." };
  }
  const text = String(content ?? "");
  if (!text.trim()) return { ok: false, error: "Укажи content — текст заметки." };
  if (text.length > NOTE_MAX_LEN) {
    return { ok: false, error: "Заметка слишком длинная: " + text.length + " символов (максимум " + NOTE_MAX_LEN + ")." };
  }
  const file = memoryFile(userData, workdir);
  const data = memoryLoad(file);
  if (!data[k] && Object.keys(data).length >= NOTE_MAX_COUNT) {
    return { ok: false, error: "Достигнут лимит заметок для проекта (" + NOTE_MAX_COUNT + "). Удали лишние через noteDelete." };
  }
  data[k] = { content: text, ts: Date.now() };
  memorySave(file, data);
  return {
    ok: true,
    message: "Заметка «" + k + "» сохранена (" + text.length + " симв.). В следующих сессиях она доступна через noteRead.",
    count: Object.keys(data).length,
  };
}

// Прочитать одну заметку (key) или все: { ok, notes: [{key, content, ts}] }.
function noteRead(userData, workdir, key) {
  const file = memoryFile(userData, workdir);
  const data = memoryLoad(file);
  const k = String(key || "").trim();
  if (k) {
    const rec = data[k];
    if (!rec) return { ok: false, error: "Заметка «" + k + "» не найдена. Смотри noteList." };
    return { ok: true, key: k, content: rec.content, ts: rec.ts };
  }
  const notes = Object.keys(data)
    .map((name) => ({ key: name, content: data[name].content, ts: data[name].ts }))
    .sort((a, b) => b.ts - a.ts);
  return { ok: true, notes };
}

function noteDelete(userData, workdir, key) {
  const k = noteValidateKey(key);
  if (!k) return { ok: false, error: "Недопустимый key." };
  const file = memoryFile(userData, workdir);
  const data = memoryLoad(file);
  if (!data[k]) return { ok: false, error: "Заметка «" + k + "» не найдена." };
  delete data[k];
  memorySave(file, data);
  return { ok: true, message: "Заметка «" + k + "» удалена." };
}

// ── Точки отката (чекпоинты) ────────────────────────────────────────────────
const CP_MAX_KEEP = 15; // сколько чекпоинтов храним (старые вытесняются)
const CP_MAX_FILES = 400; // макс. файлов в одном снимке
const CP_MAX_FILE_BYTES = 512 * 1024; // файлы больше — пропускаем (бинарные/огромные)
const CP_SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "dist", "build", "target",
  ".next", ".nuxt", ".output", ".cache", "coverage", ".idea", ".vscode",
  "__pycache__", ".expo", ".turbo", "ota",
]);

function checkpointsDir(userData) {
  return path.join(userData, "checkpoints");
}

function cpIdValid(id) {
  return typeof id === "string" && /^[a-z0-9-]{1,64}$/i.test(id);
}

// Рекурсивный обход: только текстовые файлы (без NUL-байтов), не больше
// CP_MAX_FILE_BYTES, не глубже 20 уровней, максимум CP_MAX_FILES всего.
function collectFiles(dir, out, relPrefix, depth) {
  if (depth > 20 || out.length >= CP_MAX_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const ent of entries) {
    if (out.length >= CP_MAX_FILES) return;
    if (CP_SKIP_DIRS.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    const rel = relPrefix ? relPrefix + "/" + ent.name : ent.name;
    if (ent.isDirectory()) collectFiles(abs, out, rel, depth + 1);
    else if (ent.isFile()) {
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.size > CP_MAX_FILE_BYTES) continue;
      let content;
      try {
        const buf = fs.readFileSync(abs);
        if (buf.includes(0)) continue; // бинарный — пропускаем
        content = buf.toString("utf8");
      } catch {
        continue;
      }
      out.push({ rel, content });
    }
  }
}

function checkpointSave(userData, dir, label) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { ok: false, error: "Рабочая директория не найдена." };
  }
  const files = [];
  collectFiles(dir, files, "", 0);
  if (!files.length) {
    return { ok: false, error: "В рабочей директории нет файлов для снимка (бинарные и служебные пропускаются)." };
  }
  const id = Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
  const rec = {
    id,
    label: String(label || "").trim().slice(0, 80) || "Без названия",
    dir,
    createdAt: Date.now(),
    files,
  };
  const cdir = checkpointsDir(userData);
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, id + ".json"), JSON.stringify(rec), "utf8");
  // Вытесняем старые, оставляя CP_MAX_KEEP самых свежих.
  try {
    const all = fs.readdirSync(cdir).filter((f) => f.endsWith(".json")).sort().reverse();
    for (const f of all.slice(CP_MAX_KEEP)) fs.rmSync(path.join(cdir, f), { force: true });
  } catch {}
  return {
    ok: true,
    id,
    label: rec.label,
    files: files.length,
    message: "Чекпоинт «" + rec.label + "» создан: " + files.length + " файлов. Для отката используй checkpointRollback(id: " + id + ").",
  };
}

function checkpointList(userData) {
  const cdir = checkpointsDir(userData);
  let names = [];
  try {
    names = fs.readdirSync(cdir).filter((f) => f.endsWith(".json"));
  } catch {}
  const list = names
    .sort()
    .reverse()
    .map((f) => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(cdir, f), "utf8"));
        return { id: d.id, label: d.label, createdAt: d.createdAt, files: (d.files || []).length, dir: d.dir };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { ok: true, checkpoints: list };
}

function checkpointRollback(userData, id) {
  if (!cpIdValid(id)) return { ok: false, error: "Недопустимый идентификатор чекпоинта." };
  const file = path.join(checkpointsDir(userData), id + ".json");
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ok: false, error: "Чекпоинт «" + id + "» не найден. Смотри checkpointList." };
  }
  const dir = rec.dir;
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { ok: false, error: "Рабочая директория из чекпоинта больше не существует: " + dir };
  }
  const files = Array.isArray(rec.files) ? rec.files : [];
  const restored = [];
  const errors = [];
  for (const f of files) {
    const rel = String(f.rel || "");
    const safeRel = path.normalize(rel).replace(/^([/\\])+/, "");
    if (
      !safeRel ||
      safeRel === "." ||
      safeRel === ".." ||
      safeRel.startsWith(".." + path.sep) ||
      path.isAbsolute(safeRel)
    ) {
      errors.push(rel + " — недопустимый путь");
      continue;
    }
    const abs = path.join(dir, safeRel);
    if (!abs.startsWith(dir + path.sep) && abs !== dir) {
      errors.push(rel + " — вне директории");
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(f.content ?? ""), "utf8");
      restored.push(safeRel);
    } catch (e) {
      errors.push(rel + " — " + (e.message || String(e)));
    }
  }
  return {
    ok: errors.length === 0,
    restored: restored.slice(0, 200),
    restoredCount: restored.length,
    errors: errors.slice(0, 20),
    message:
      "Восстановлено файлов из чекпоинта «" + rec.label + "»: " + restored.length +
      (errors.length ? " (ошибок: " + errors.length + ")" : "") +
      ". Новые файлы, созданные после чекпоинта, не тронуты.",
  };
}

// ── Память диалогов: сжатые памятки контекста, по датам ─────────────────────
/*  Когда контекст переполняется, агент сворачивает старые шаги в «памятку»
    (см. createContextManager в agent-core.js). Здесь каждая памятка сохраняется
    вместе с сообщениями, из которых она была сделана, в
      <userData>/context-memory/<ГГГГ-ММ-ДД>/<ЧЧ-ММ-СС>-<rand>.json
    плюс собранный человекочитаемый <ГГГГ-ММ-ДД>/day.md.

    Зачем: пользователь может позже спросить «посмотри, что мы делали 5-го числа» —
    агент читает это через memoryList / memorySearch.

    Папка лежит ВНЕ проекта (не попадает в git и не уезжает в OTA-бандл).
    Пишется только при включённой галочке «Память диалогов» (в настройках
    по умолчанию выключена) — без явного согласия на диск ничего не сохраняется. */
const CTX_MEMO_MAX_CHARS = 8000; // символов на одну памятку
const CTX_MEMO_MAX_MESSAGES = 80; // сколько сообщений-источников храним
const CTX_MEMO_MSG_CHARS = 4000; // обрезка одного сообщения
const CTX_MEMO_DAY_KEEP = 30; // сколько дней хранить по умолчанию
const CTX_MEMO_SEARCH_LIMIT = 20; // максимум совпадений в поиске

function contextMemoryDir(userData) {
  return path.join(userData, "context-memory");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// Локальная дата (по часам пользователя) в виде ГГГГ-ММ-ДД.
function localDayKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function localTimeKey(ts) {
  const d = new Date(Number(ts) || Date.now());
  return pad2(d.getHours()) + "-" + pad2(d.getMinutes()) + "-" + pad2(d.getSeconds());
}

function localTimeHuman(ts) {
  const d = new Date(Number(ts) || Date.now());
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function dayKeyValid(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Маскируем только бесспорные секреты (длинные ключи и приватные ключи),
// чтобы случайный токен из переписки не осел в дневнике. Обычный код не трогаем.
const CTX_SECRET_RES = [
  /-----BEGIN[^-\n]*PRIVATE KEY-----[\s\S]*?-----END[^-\n]*PRIVATE KEY-----/g,
  /\bsk-proj-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bya29\.[0-9A-Za-z_-]{20,}\b/g,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{24,}\b/g,
];

function redactSecrets(text) {
  let s = String(text ?? "");
  for (const re of CTX_SECRET_RES) s = s.replace(re, "[секрет скрыт]");
  return s;
}

// Содержимое сообщения → строка (многомодальные части сворачиваем в текст).
function flattenContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (p == null) continue;
      if (typeof p === "string") parts.push(p);
      else if (p.type === "text" && p.text) parts.push(String(p.text));
      else if (p.type === "image_url") parts.push("[изображение]");
      else if (p.text) parts.push(String(p.text));
    }
    return parts.join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

// Сообщения для дневника: только role+content, с обрезкой и маскировкой секретов.
function sanitizeMemoMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const tail = messages.slice(-CTX_MEMO_MAX_MESSAGES);
  const out = [];
  for (const m of tail) {
    if (!m || typeof m !== "object") continue;
    const role = String(m.role || "").trim();
    if (!role) continue;
    let text = redactSecrets(flattenContent(m.content));
    if (text.length > CTX_MEMO_MSG_CHARS) text = text.slice(0, CTX_MEMO_MSG_CHARS) + "\n… (обрезано)";
    const rec = { role, content: text };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      rec.tools = m.tool_calls.map((t) => String((t && t.function && t.function.name) || "?")).slice(0, 20);
    }
    out.push(rec);
  }
  return out;
}

// Атомарная запись текста: временный файл → подмена (внезапное закрытие не оставит обрезанный файл).
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); } catch {}
  }
}

function ctxMemoFiles(userData, day) {
  const dir = path.join(contextMemoryDir(userData), day);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return { dir, files: [] };
  }
  return { dir, files: names.sort().map((f) => path.join(dir, f)) };
}

function ctxMemoReadDay(userData, day) {
  const { files } = ctxMemoFiles(userData, day);
  const out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      if (d && typeof d === "object") out.push(d);
    } catch {}
  }
  return out;
}

// Пересобирает <day>/day.md — человекочитаемый дневник за день.
function rebuildDayMarkdown(userData, day) {
  const memos = ctxMemoReadDay(userData, day);
  const lines = ["# Сжатые памятки контекста за " + day, ""];
  for (const m of memos) {
    const head = localTimeHuman(m.ts) + " — " + (m.provider || "?") + (m.model ? "/" + m.model : "");
    lines.push("## " + head);
    if (m.workDir) lines.push("Рабочая папка: `" + m.workDir + "`");
    lines.push("");
    lines.push(String(m.memo || "(пусто)"));
    const msgs = Array.isArray(m.messages) ? m.messages : [];
    if (msgs.length) {
      lines.push("", "<details>Сжатые шаги (" + msgs.length + "):", "");
      for (const s of msgs) {
        const one = String(s.content || "").replace(/\s*\n\s*/g, " ");
        const tools = Array.isArray(s.tools) && s.tools.length ? " → " + s.tools.join(", ") : "";
        lines.push("- **" + s.role + "**" + tools + ": " + (one.length > 300 ? one.slice(0, 300) + "…" : one));
      }
      lines.push("", "</details>");
    }
    lines.push("", "---", "");
  }
  atomicWriteText(path.join(contextMemoryDir(userData), day, "day.md"), lines.join("\n"));
}

// Сохранить одну памятку. entry: { ts, memo, messages, provider, model, workDir, keepDays }
function contextMemorySave(userData, entry) {
  if (!userData) return { ok: false, error: "Не задана папка данных приложения." };
  const e = entry || {};
  const memo = redactSecrets(String(e.memo || "")).trim().slice(0, CTX_MEMO_MAX_CHARS);
  if (!memo) return { ok: false, error: "Пустая памятка — сохранять нечего." };
  const ts = Number(e.ts) || Date.now();
  const day = localDayKey(ts);
  const dir = path.join(contextMemoryDir(userData), day);
  fs.mkdirSync(dir, { recursive: true });
  const id = localTimeKey(ts) + "-" + crypto.randomBytes(3).toString("hex");
  const messages = sanitizeMemoMessages(e.messages);
  const rec = {
    id,
    ts,
    day,
    provider: String(e.provider || "").slice(0, 40),
    model: String(e.model || "").slice(0, 80),
    workDir: String(e.workDir || "").slice(0, 400),
    memoChars: memo.length,
    memo,
    messages,
  };
  try {
    atomicWriteText(path.join(dir, id + ".json"), JSON.stringify(rec, null, 2));
    rebuildDayMarkdown(userData, day);
  } catch (err) {
    return { ok: false, error: "Не удалось записать памятку: " + (err.message || String(err)) };
  }
  contextMemoryPrune(userData, e.keepDays);
  const count = ctxMemoReadDay(userData, day).length;
  return { ok: true, id, day, dir, messages: messages.length, chars: rec.memoChars, count };
}

// Список дней: [{ date, count, first, last }] — свежие первыми.
function contextMemoryDays(userData) {
  const base = contextMemoryDir(userData);
  let names = [];
  try {
    names = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const days = [];
  for (const ent of names) {
    if (!ent.isDirectory() || !dayKeyValid(ent.name)) continue;
    const memos = ctxMemoReadDay(userData, ent.name);
    if (!memos.length) continue;
    const ts = memos.map((m) => Number(m.ts) || 0).filter(Boolean);
    days.push({
      date: ent.name,
      count: memos.length,
      first: ts.length ? Math.min(...ts) : 0,
      last: ts.length ? Math.max(...ts) : 0,
    });
  }
  return days.sort((a, b) => (a.date < b.date ? 1 : -1));
}

function contextMemoryRead(userData, date) {
  if (!dayKeyValid(date)) return { ok: false, error: "Укажи дату в формате ГГГГ-ММ-ДД." };
  const memos = ctxMemoReadDay(userData, date);
  if (!memos.length) return { ok: false, error: "За " + date + " памяток нет. Смотри memoryList (без даты) — там список дней." };
  const list = memos
    .map((m) => ({
      id: m.id,
      time: localTimeHuman(m.ts),
      ts: m.ts,
      provider: m.provider,
      model: m.model,
      workDir: m.workDir,
      chars: m.memoChars || String(m.memo || "").length,
      memo: String(m.memo || ""),
      messages: Array.isArray(m.messages) ? m.messages.length : 0,
    }))
    .sort((a, b) => b.ts - a.ts);
  return { ok: true, date, count: list.length, memos: list };
}

// Поиск по памяткам. opts: { query, date (необязательно), limit }
function contextMemorySearch(userData, opts) {
  const o = opts || {};
  const q = String(o.query || "").trim().toLowerCase();
  if (!q) return { ok: false, error: "Укажи query — что искать в памятках." };
  const day = dayKeyValid(o.date) ? o.date : "";
  const limit = Math.max(1, Math.min(100, Number(o.limit) || CTX_MEMO_SEARCH_LIMIT));
  const days = day ? [day] : contextMemoryDays(userData).map((d) => d.date);
  const matches = [];
  for (const d of days) {
    for (const m of ctxMemoReadDay(userData, d)) {
      const hay = (String(m.memo || "") + "\n" + String(m.workDir || "") + "\n" +
        (Array.isArray(m.messages) ? m.messages.map((s) => s.content || "").join("\n") : "")).toLowerCase();
      const at = hay.indexOf(q);
      if (at < 0) continue;
      let count = 0;
      for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) count++;
      const memoText = String(m.memo || "");
      const memoLower = memoText.toLowerCase();
      const pos = memoLower.indexOf(q);
      let snippet;
      if (pos >= 0) {
        const from = Math.max(0, pos - 160);
        snippet = (from > 0 ? "…" : "") + memoText.slice(from, pos + 340) + (pos + 340 < memoText.length ? "…" : "");
      } else {
        snippet = "(совпадение в сжатых шагах, не в самой памятке)";
      }
      matches.push({ date: d, id: m.id, time: localTimeHuman(m.ts), ts: m.ts, hits: count, snippet: snippet.replace(/\n/g, " ") });
    }
  }
  matches.sort((a, b) => (b.hits - a.hits) || (b.ts - a.ts));
  return { ok: true, query: String(o.query).trim(), count: matches.length, matches: matches.slice(0, limit) };
}

// Автоочистка: держим только keepDays самых свежих дней (по умолчанию 30).
function contextMemoryPrune(userData, keepDays) {
  const keep = Math.max(1, Math.min(3650, Number(keepDays) || CTX_MEMO_DAY_KEEP));
  const base = contextMemoryDir(userData);
  let names = [];
  try {
    names = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return { ok: true, removed: 0, kept: 0 };
  }
  const days = names.filter((e) => e.isDirectory() && dayKeyValid(e.name)).map((e) => e.name).sort().reverse();
  let removed = 0;
  for (const d of days.slice(keep)) {
    try {
      fs.rmSync(path.join(base, d), { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return { ok: true, removed, kept: Math.min(days.length, keep) };
}

// Очистка: одна дата или вообще всё. Возвращает { ok, removedDays, removedMemos }.
function contextMemoryClear(userData, date) {
  const base = contextMemoryDir(userData);
  if (date && !dayKeyValid(date)) return { ok: false, error: "Дата должна быть в формате ГГГГ-ММ-ДД." };
  const days = date
    ? [date]
    : (() => {
        try {
          return fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && dayKeyValid(e.name)).map((e) => e.name);
        } catch {
          return [];
        }
      })();
  let removedDays = 0;
  let removedMemos = 0;
  for (const d of days) {
    removedMemos += ctxMemoReadDay(userData, d).length;
    try {
      fs.rmSync(path.join(base, d), { recursive: true, force: true });
      removedDays++;
    } catch {}
  }
  return { ok: true, removedDays, removedMemos };
}

// Сводка для настроек: сколько дней, памяток и места занимает дневник.
function contextMemoryStats(userData) {
  const base = contextMemoryDir(userData);
  const days = contextMemoryDays(userData);
  let memos = 0;
  let bytes = 0;
  for (const d of days) memos += d.count;
  const walk = (dir) => {
    let items = [];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) walk(abs);
      else {
        try { bytes += fs.statSync(abs).size; } catch {}
      }
    }
  };
  walk(base);
  return {
    ok: true,
    dir: base,
    days: days.length,
    memos,
    bytes,
    newest: days.length ? days[0].date : "",
    oldest: days.length ? days[days.length - 1].date : "",
  };
}

module.exports = {
  NOTE_MAX_LEN,
  NOTE_MAX_COUNT,
  memoryFile,
  noteSave,
  noteRead,
  noteDelete,
  checkpointsDir,
  checkpointSave,
  checkpointList,
  checkpointRollback,
  // память диалогов (сжатые памятки контекста по датам)
  CTX_MEMO_MAX_CHARS,
  CTX_MEMO_DAY_KEEP,
  contextMemoryDir,
  localDayKey,
  redactSecrets,
  sanitizeMemoMessages,
  contextMemorySave,
  contextMemoryDays,
  contextMemoryRead,
  contextMemorySearch,
  contextMemoryPrune,
  contextMemoryClear,
  contextMemoryStats,
};