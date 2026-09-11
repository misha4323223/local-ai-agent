"use strict";

/* ── Хранение секретов (API-ключи, токены, PIN, agentEnv) ───────────────────
   Секреты живут в отдельном файле userData/secrets.json и шифруются через
   Electron safeStorage (на Windows — DPAPI, на macOS — Keychain).
   В settings.json (открытом) секретов больше нет.

   Откаты (чтобы ничего не сломать):
   - шифрование недоступно (Linux без keyring, приложение ещё не готово,
     тесты в plain-node) → значения хранятся как "plain:" + base64;
   - старые установки, где секреты лежали в settings.json открытым текстом →
     подхватываются при загрузке и при следующем сохранении переезжают в secrets.json.
   Модуль не требует electron на этапе require: safeStorage дёргается лениво,
   поэтому его можно тестировать в plain-node.
*/

const fs = require("fs");
const path = require("path");

// Поля настроек, которые считаются секретами и хранятся отдельно.
const SECRET_KEYS = [
  "openaiApiKey",
  "anthropicApiKey",
  "githubToken",
  "mobilePin",
  "visionKey",
  "agentEnv", // объект: пользователь кладёт сюда пароли/ключи для агента
  "openaiProfiles", // массив сохранённых OpenAI-подключений (внутри — apiKey)
  "yandexOauthToken", // OAuth-токен Yandex (для Yandex Cloud REST API)
  "serperApiKey", // API-ключ Serper (усиленный Google-поиск для агента)
  "sitePasswords", // пароли сайтов для агента (менеджер паролей) — шифруются как ключи
  "mailPassword", // пароль приложения для почты (SMTP/IMAP) — шифруется
];

// Секреты-объекты (не строки): перед шифрованием сериализуются в JSON.
const OBJECT_KEYS = ["agentEnv", "openaiProfiles", "sitePasswords"];
function isObjectKey(k) {
  return OBJECT_KEYS.indexOf(k) !== -1;
}

let secretsFile = null; // полный путь к secrets.json
let cache = null; // расшифрованный кэш { key: value }

function electron() {
  // В plain-node require("electron") возвращает путь к бинарю (не объект) —
  // safeStorage будет undefined, encryptText честно уйдёт в plain-откат.
  return require("electron");
}

function init(filePath) {
  secretsFile = filePath || null;
  cache = null;
}

function isEncryptionAvailable() {
  try {
    const e = electron();
    return !!(e && e.safeStorage && e.safeStorage.isEncryptionAvailable && e.safeStorage.isEncryptionAvailable());
  } catch {
    return false;
  }
}

function encryptText(plain) {
  try {
    const e = electron();
    if (e && e.safeStorage && e.safeStorage.isEncryptionAvailable && e.safeStorage.isEncryptionAvailable()) {
      return "enc:" + e.safeStorage.encryptString(plain).toString("base64");
    }
  } catch {}
  return "plain:" + Buffer.from(plain, "utf8").toString("base64");
}

function decryptText(stored) {
  const s = String(stored || "");
  try {
    if (s.startsWith("enc:")) {
      const e = electron();
      if (e && e.safeStorage && e.safeStorage.isEncryptionAvailable && e.safeStorage.isEncryptionAvailable()) {
        return e.safeStorage.decryptString(Buffer.from(s.slice(4), "base64"));
      }
      return null; // шифрование недоступно — расшифровать нечем
    }
    if (s.startsWith("plain:")) {
      return Buffer.from(s.slice(6), "base64").toString("utf8");
    }
  } catch {}
  return null;
}

// Читает secrets.json и возвращает объект { key: value }.
function loadSecrets() {
  if (cache) return cache;
  cache = {};
  if (!secretsFile || !fs.existsSync(secretsFile)) return cache;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(secretsFile, "utf8"));
  } catch {
    return cache;
  }
  for (const k of SECRET_KEYS) {
    const v = raw[k];
    if (v === undefined) continue;
    if (typeof v === "string" && (v.startsWith("enc:") || v.startsWith("plain:"))) {
      const d = decryptText(v);
      if (d === null) continue; // не расшифровать — не подставляем
      cache[k] = isObjectKey(k) ? safeParse(d) : d;
    } else {
      // старый формат: открытый текст — подхватываем как есть
      cache[k] = isObjectKey(k) ? safeParse(v) : v;
    }
  }
  return cache;
}

function safeParse(s) {
  if (typeof s === "object" && s !== null) return s;
  try {
    const v = JSON.parse(String(s || "{}"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// Сохраняет только секреты из объекта настроек (пустые значения пропускаются).
function saveSecrets(sec) {
  const out = {};
  const nextCache = {};
  for (const k of SECRET_KEYS) {
    const v = sec ? sec[k] : undefined;
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v === "") continue;
    if (typeof v === "object" && Object.keys(v).length === 0) continue;
    nextCache[k] = v; // в кэше — расшифрованные значения
    out[k] = encryptText(typeof v === "string" ? v : JSON.stringify(v));
  }
  cache = nextCache;
  if (!secretsFile) return;
  fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
  fs.writeFileSync(secretsFile, JSON.stringify(out, null, 2), "utf8");
}

// Делит объект настроек на { rest (без секретов), sec (только секреты) }.
function splitSecrets(s) {
  const rest = { ...s };
  const sec = {};
  for (const k of SECRET_KEYS) {
    if (rest[k] !== undefined) {
      sec[k] = rest[k];
      delete rest[k];
    }
  }
  return { rest, sec };
}

module.exports = {
  SECRET_KEYS,
  OBJECT_KEYS,
  init,
  loadSecrets,
  saveSecrets,
  splitSecrets,
  isEncryptionAvailable,
  _encryptText: encryptText,
  _decryptText: decryptText,
};