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
};