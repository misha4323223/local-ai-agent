"use strict";

/* ─── Применение unified diff (формат git diff) к файлам в базовой директории ──
   Чистый Node-модуль (без Electron): используется main.js (desktop) и
   покрывается smoke-тестами.

   Поддерживает:
   - изменение существующих файлов (контекст + удалённые/добавленные строки);
   - создание новых файлов (--- /dev/null);
   - удаление файлов (+++ /dev/null).
   Безопасность: пути нормализуются и обязаны оставаться внутри baseDir
   (никаких .., абсолютных путей и обхода).
*/

const path = require("path");
const fs = require("fs");

// Разбор патча на файлы: [{ a, b, newFile, deletedFile, hunks: [{oldStart, old, new}] }]
function parsePatch(text) {
  const lines = String(text || "").split("\n");
  const files = [];
  let cur = null;
  let inHunk = false;

  const flush = () => {
    if (cur) {
      files.push(cur);
      cur = null;
    }
  };

  const startHunk = (line) => {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!cur) return;
    cur.hunks.push({
      oldStart: m ? parseInt(m[1], 10) : 1,
      oldCount: m && m[2] ? parseInt(m[2], 10) : 1,
      newStart: m ? parseInt(m[3], 10) : 1,
      newCount: m && m[4] ? parseInt(m[4], 10) : 1,
      old: [],
      new: [],
    });
    inHunk = true;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      const m = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
      cur = { a: m ? m[1] : "", b: m ? m[2] : "", hunks: [], newFile: false, deletedFile: false };
      inHunk = false;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (!cur) cur = { a: "", b: "", hunks: [], newFile: false, deletedFile: false };
      cur.a = line.slice(4).replace(/^\s*(a\/|b\/)/, "");
      if (/\/dev\/null/.test(line)) cur.newFile = true;
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!cur) cur = { a: "", b: "", hunks: [], newFile: false, deletedFile: false };
      cur.b = line.slice(4).replace(/^\s*(a\/|b\/)/, "");
      if (/\/dev\/null/.test(line)) cur.deletedFile = true;
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@ ")) {
      startHunk(line);
      continue;
    }
    if (inHunk && cur && cur.hunks.length) {
      const h = cur.hunks[cur.hunks.length - 1];
      if (line.startsWith("\\ No newline")) continue;
      const c = line[0];
      if (c === "-") h.old.push(line.slice(1));
      else if (c === "+") h.new.push(line.slice(1));
      else if (c === " ") {
        h.old.push(line.slice(1));
        h.new.push(line.slice(1));
      } else {
        inHunk = false; // секция закончилась (мусор/метаданные)
      }
    }
  }
  flush();
  return files;
}

// Безопасный относительный путь внутри baseDir; null, если недопустим.
function safeRel(baseDir, rel) {
  const raw = String(rel || "").replace(/\\/g, "/");
  const norm = path.posix.normalize(raw);
  if (!norm || norm === "." || norm === ".." || norm.startsWith("../") || path.posix.isAbsolute(norm)) return null;
  const abs = path.join(baseDir, norm);
  if (abs !== baseDir && !abs.startsWith(baseDir + path.sep)) return null;
  return norm;
}

// Применить один хунк к массиву строк (1-based позиции из старого файла).
// Возвращает { ok, lines?, error? }.
function applyHunk(lines, hunk) {
  const oldBlock = hunk.old;
  const newBlock = hunk.new;
  if (!oldBlock.length && !newBlock.length) return { ok: true, lines };
  const WINDOW = 60;
  const from = Math.max(0, hunk.oldStart - 1 - WINDOW);
  const to = Math.min(lines.length - oldBlock.length + 1, hunk.oldStart - 1 + WINDOW + 1);
  let found = -1;
  for (let p = from; p < to; p++) {
    let ok = true;
    for (let k = 0; k < oldBlock.length; k++) {
      if (lines[p + k] !== oldBlock[k]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      found = p;
      break;
    }
  }
  if (found === -1) {
    return {
      ok: false,
      error:
        "контекст хунка @@ -" + hunk.oldStart + " не найден в файле (строки не совпали). " +
        "Перечитай файл и сгенерируй патч заново с точным контекстом.",
    };
  }
  return {
    ok: true,
    lines: lines.slice(0, found).concat(newBlock, lines.slice(found + oldBlock.length)),
  };
}

// Применить патч к файлам внутри baseDir.
// Возвращает { ok, changed: [rel], errors: [{path, error}] }.
function applyUnifiedPatch(baseDir, text) {
  const errors = [];
  const changed = [];
  const files = parsePatch(text);
  if (!files.length) {
    return { ok: false, changed, errors: [{ path: "(патч)", error: "патч пустой или не распознан (нужен формат git diff)" }] };
  }
  for (const f of files) {
    // Для удаления путь берём из старой стороны (b = /dev/null), для создания — из новой.
    const target = f.deletedFile ? f.a : f.b || f.a;
    const rel = safeRel(baseDir, target);
    if (!rel) {
      errors.push({ path: target, error: "недопустимый путь (вне базовой директории)" });
      continue;
    }
    const abs = path.join(baseDir, rel);
    try {
      if (f.deletedFile) {
        if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
        changed.push(rel);
        continue;
      }
      if (f.newFile) {
        // Новый файл: все строки из «+»-сторон хунков, в порядке хунков.
        const out = [];
        for (const h of f.hunks) out.push(...h.new);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, out.join("\n"), "utf8");
        changed.push(rel);
        continue;
      }
      if (!fs.existsSync(abs)) {
        errors.push({ path: rel, error: "файл не найден" });
        continue;
      }
      const cur = fs.readFileSync(abs, "utf8").split("\n");
      let lines = cur;
      let fileOk = true;
      for (const h of f.hunks) {
        const r = applyHunk(lines, h);
        if (!r.ok) {
          errors.push({ path: rel, error: r.error });
          fileOk = false;
          break;
        }
        lines = r.lines;
      }
      if (!fileOk) continue;
      // Не пишем файл, если ничего не поменялось (пустые хунки).
      const joined = lines.join("\n");
      if (joined !== fs.readFileSync(abs, "utf8")) {
        fs.writeFileSync(abs, joined, "utf8");
        changed.push(rel);
      }
    } catch (e) {
      errors.push({ path: rel, error: e.message || String(e) });
    }
  }
  return { ok: errors.length === 0, changed, errors };
}

module.exports = { parsePatch, applyUnifiedPatch, safeRel };