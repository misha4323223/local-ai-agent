"use strict";

/* ─── Локальный семантический индекс кода (BM25 + стемминг Porter) ───────────
   Чистый Node-модуль (без Electron): используется main.js (desktop) и
   покрывается smoke-тестами.

   Чем отличается от searchFile/searchProject:
   - ищет по СМЫСЛУ, а не по точному тексту: auth найходит authenticate,
     авторизация; стемминг Porter снимает окончания;
   - разбирает идентификаторы кода: authToken / auth_token → auth + token;
   - ранжирует документы (BM25), а не просто перечисляет вхождения;
   - индекс кэшируется на диске (по отпечатку директории) — повторные поиски быстрые.

   Ограничения: до 1000 файлов, файлы до 256 КБ, суммарно до 50 МБ,
   бинарные и служебные каталоги пропускаются (как в чекпоинтах).
*/

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ── Porter stemmer (Martin Porter, 1980; каноническая JS-порт из tartarus.org) ──
const step2list = {
  ational: "ate", tional: "tion", enci: "ence", anci: "ance", izer: "ize",
  bli: "ble", alli: "al", entli: "ent", eli: "e", ousli: "ous",
  ization: "ize", ation: "ate", ator: "ate", alism: "al", iveness: "ive",
  fulness: "ful", ousness: "ous", aliti: "al", iviti: "ive", biliti: "ble",
  logi: "log",
};
const step3list = {
  icate: "ic", ative: "", alize: "al", iciti: "ic", ical: "ic", ful: "", ness: "",
};
const c = "[^aeiou]";
const v = "[aeiouy]";
const C = c + "[^aeiouy]*";
const V = v + "[aeiou]*";
const mgr0 = "^(" + C + ")?" + V + C;
const meq1 = "^(" + C + ")?" + V + C + "(" + V + ")?$";
const mgr1 = "^(" + C + ")?" + V + C + V + C;
const s_v = "^(" + C + ")?" + v;

const re_mgr0 = new RegExp(mgr0);
const re_mgr1 = new RegExp(mgr1);
const re_meq1 = new RegExp(meq1);
const re_s_v = new RegExp(s_v);

const re_1a = /^(.+?)(ss|i)es$/;
const re2_1a = /^(.+?)([^s])s$/;
const re_1b = /^(.+?)eed$/;
const re2_1b = /^(.+?)(ed|ing)$/;
const re_1b_2 = /.$/;
const re2_1b_2 = /(at|bl|iz)$/;
const re3_1b_2 = new RegExp("([^aeiouylsz])\\1$");
const re4_1b_2 = new RegExp("^" + C + v + "[^aeiouwxy]$");
const re_1c = /^(.+?[^aeiou])y$/;
const re_2 = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
const re_3 = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
const re_4 = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
const re_5a = /^(.+?)(e)$/;
const re_5b = /^(.+?)l$/;

// Стемминг одного слова (лат. строчные буквы). Слова короче 3 символов не трогаем.
function stem(w) {
  if (w.length < 3) return w;
  if (!/^[a-z]+$/.test(w)) return w; // кириллица/цифры — без стемминга
  let s = w;
  if (s[0] === "y") s = "Y" + s.slice(1);
  let m = re_1a.exec(s);
  if (m) s = m[1] + m[2];
  else {
    m = re2_1a.exec(s);
    if (m) s = m[1] + m[2];
  }
  m = re_1b.exec(s);
  if (m) {
    if (re_mgr0.test(s)) s = s.slice(0, -1);
  } else {
    m = re2_1b.exec(s);
    if (m) {
      s = m[1];
      if (re_1b_2.test(s)) {
        if (re2_1b_2.test(s)) s += "e";
      }
      if (re3_1b_2.test(s) && !re4_1b_2.test(s)) s = s.slice(0, -1);
    }
  }
  m = re_1c.exec(s);
  if (m) s = m[1] + "i";
  m = re_2.exec(s);
  if (m) s = m[1] + step2list[m[2]];
  else {
    m = re_3.exec(s);
    if (m) s = m[1] + step3list[m[2]];
    else {
      m = re_4.exec(s);
      if (m) s = m[1];
    }
  }
  m = re_5a.exec(s);
  if (m) {
    if (!re_meq1.test(s)) s = m[1];
  }
  m = re_5b.exec(s);
  if (m && re_mgr1.test(s)) s = s.slice(0, -1);
  return s;
}

// ── Токенизация кода: слова + разбор camelCase/snake_case ───────────────────
const TOKEN_RE = /^[a-z0-9а-яё]+$/;

function tokenizeCode(text) {
  const raw = [];
  let buf = "";
  const flush = () => {
    if (buf) raw.push(buf);
    buf = "";
  };
  for (const ch of String(text)) {
    if (/[a-zA-Z0-9а-яА-ЯёЁ]/.test(ch)) buf += ch;
    else flush();
  }
  flush();
  const out = [];
  for (const w of raw) {
    const parts = w.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    for (const p of parts) {
      const t = p.toLowerCase();
      if (t.length > 1 && TOKEN_RE.test(t)) out.push(t);
    }
  }
  return out;
}

// Степень родства двух стемов: 1 — равны; 0.8 — общий префикс >= 4 символов
// (компенсирует неточности стемминга: authenticat ~ authentic, authentic ~ authent).
function tokenRelated(a, b) {
  if (a === b) return 1;
  const min = Math.min(a.length, b.length);
  if (min >= 4 && (a.startsWith(b) || b.startsWith(a))) return 0.8;
  return 0;
}

function stemTokens(tokens) {
  const out = [];
  for (const t of tokens) out.push(stem(t));
  return out;
}

// ── Пропускаемые каталоги (общие с чекпоинтами) ─────────────────────────────
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "dist", "build", "target",
  ".next", ".nuxt", ".output", ".cache", "coverage", ".idea", ".vscode",
  "__pycache__", ".expo", ".turbo", "ota",
]);

const MAX_FILES = 1000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_DEPTH = 20;

// Статистический отпечаток директории: [количество файлов, сумма байт, max mtime].
// Совпал — индекс можно не пересобирать.
function fingerprintDir(dir) {
  let count = 0;
  let bytes = 0;
  let maxMtime = 0;
  const walk = (d, depth) => {
    if (depth > MAX_DEPTH || count >= MAX_FILES || bytes >= MAX_TOTAL_BYTES) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (count >= MAX_FILES || bytes >= MAX_TOTAL_BYTES) return;
      if (SKIP_DIRS.has(ent.name)) continue;
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) walk(abs, depth + 1);
      else if (ent.isFile()) {
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (st.size > MAX_FILE_BYTES) continue;
        count++;
        bytes += st.size;
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
      }
    }
  };
  walk(dir, 0);
  return count + "|" + bytes + "|" + Math.round(maxMtime);
}

// Полный индекс: [{ rel, len, tf }] + df (doc frequency) + avgLen.
function buildIndex(dir) {
  const docs = [];
  const df = {};
  let totalTokens = 0;
  let totalBytes = 0;
  const walk = (d, relPrefix, depth) => {
    if (depth > MAX_DEPTH || docs.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const ent of entries) {
      if (docs.length >= MAX_FILES || totalBytes >= MAX_TOTAL_BYTES) return;
      if (SKIP_DIRS.has(ent.name)) continue;
      const abs = path.join(d, ent.name);
      const rel = relPrefix ? relPrefix + "/" + ent.name : ent.name;
      if (ent.isDirectory()) walk(abs, rel, depth + 1);
      else if (ent.isFile()) {
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        if (st.size > MAX_FILE_BYTES) continue;
        let content;
        try {
          const buf = fs.readFileSync(abs);
          if (buf.includes(0)) continue;
          content = buf.toString("utf8");
        } catch {
          continue;
        }
        totalBytes += st.size;
        const tokens = stemTokens(tokenizeCode(content));
        const tf = {};
        for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
        for (const t of Object.keys(tf)) df[t] = (df[t] || 0) + 1;
        totalTokens += tokens.length;
        docs.push({ rel, len: tokens.length, tf });
      }
    }
  };
  walk(dir, "", 0);
  const avgLen = docs.length ? totalTokens / docs.length : 0;
  return { dir, docs, df, avgLen, docsCount: docs.length };
}

// BM25-поиск по индексу. Возвращает [{ rel, score, matched }].
function searchIndex(index, query, maxResults) {
  const qTokens = stemTokens(tokenizeCode(query));
  const uniq = [];
  for (const t of qTokens) if (!uniq.includes(t)) uniq.push(t);
  if (!uniq.length) return [];
  const N = index.docsCount;
  const avg = index.avgLen || 1;
  const scores = [];
  for (const doc of index.docs) {
    let score = 0;
    const matched = [];
    const docTokens = Object.keys(doc.tf);
    for (const t of uniq) {
      let tf = 0;
      let hit = null;
      for (const dt of docTokens) {
        const w = tokenRelated(t, dt);
        if (w > 0) {
          tf += doc.tf[dt] * w;
          if (!hit) hit = dt;
        }
      }
      if (!tf) continue;
      matched.push(t);
      const n = index.df[t] || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * tf * 1.5) / (tf + 1.5 * (0.25 + 0.75 * (doc.len / avg)));
    }
    if (score > 0) scores.push({ rel: doc.rel, score, matched });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, Math.max(1, Math.min(maxResults || 8, 20)));
}

// Сниппет: первая строка файла с токеном запроса + окрестность ±3 строки.
function snippetForFile(baseDir, rel, query, radius) {
  radius = radius || 3;
  const abs = path.join(baseDir, rel);
  let lines;
  try {
    lines = fs.readFileSync(abs, "utf8").split("\n");
  } catch {
    return { line: 0, text: "" };
  }
  const qTokens = stemTokens(tokenizeCode(query));
  let hit = -1;
  for (let i = 0; i < lines.length; i++) {
    const toks = stemTokens(tokenizeCode(lines[i]));
    if (qTokens.some((t) => toks.some((dt) => tokenRelated(t, dt) > 0))) {
      hit = i;
      break;
    }
  }
  if (hit === -1) {
    // Fallback: любое совпадение по подстроке
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i].toLowerCase();
      if (qTokens.some((t) => low.includes(t))) {
        hit = i;
        break;
      }
    }
  }
  if (hit === -1) return { line: 0, text: "(сниппет не найден)" };
  const from = Math.max(0, hit - radius);
  const to = Math.min(lines.length, hit + radius + 1);
  const pad = String(to).length;
  const text = lines
    .slice(from, to)
    .map((l, i) => String(from + i + 1).padStart(pad, " ") + " | " + l)
    .join("\n");
  return { line: hit + 1, text };
}

// ── Кэш на диске: userData/code-index/<hash(dir)>.json ─────────────────────
function cacheFile(userData, dir) {
  const hash = crypto.createHash("sha1").update(String(dir || "")).digest("hex").slice(0, 16);
  return path.join(userData, "code-index", hash + ".json");
}

function loadCache(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    if (d && d.dir && Array.isArray(d.docs)) return d;
  } catch {}
  return null;
}

function saveCache(file, index) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(index), "utf8");
  } catch {}
}

// Получить индекс для директории: берёт кэш по отпечатку или пересобирает.
function getIndex(userData, dir) {
  const fp = fingerprintDir(dir);
  const file = cacheFile(userData, dir);
  const cached = loadCache(file);
  if (cached && cached.fingerprint === fp && cached.dir === dir) return cached;
  const index = buildIndex(dir);
  index.fingerprint = fp;
  saveCache(file, index);
  return index;
}

module.exports = {
  stem,
  tokenRelated,
  tokenizeCode,
  stemTokens,
  SKIP_DIRS,
  fingerprintDir,
  buildIndex,
  searchIndex,
  snippetForFile,
  getIndex,
};