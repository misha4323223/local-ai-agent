"use strict";
// Защита критичной инфраструктуры самообновления от случайной поломки агентом.
// Агент может править собственный код (self-development через OTA), но НЕ может
// трогать файлы, без которых приложение не загрузится и не обновится:
//   - <appSrcDir>/bootstrap.js — загрузчик приложения;
//   - <appSrcDir>/ota.js       — ядро применения обновлений;
//   - otaRoot (папка применённого OTA-бандла, userData/ota/current) и всё внутри.
// Модуль чистый (без Electron) — тестируется в plain-node.
const path = require("path");

// Проверяет, находится ли абсолютный путь под защитой самообновления.
function protectedSelfPath(abs, opts) {
  opts = opts || {};
  const p = path.resolve(String(abs || ""));
  if (!p) return false;
  const appSrcDir = opts.appSrcDir ? path.resolve(String(opts.appSrcDir)) : __dirname;
  const otaRoot = opts.otaRoot ? path.resolve(String(opts.otaRoot)) : "";
  const lp = p.toLowerCase();
  if (lp === path.join(appSrcDir, "bootstrap.js").toLowerCase()) return true;
  if (lp === path.join(appSrcDir, "ota.js").toLowerCase()) return true;
  if (otaRoot) {
    const lr = otaRoot.toLowerCase();
    if (lp === lr || lp.startsWith(lr + path.sep)) return true;
  }
  return false;
}

// Человекочитаемое сообщение об отказе (для ошибки инструмента).
function protectedSelfPathMessage(abs, opts) {
  const p = path.resolve(String(abs || ""));
  return (
    "⛔ Действие заблокировано: путь под защитой самообновления — " + p + "\n" +
    "Это критичная инфраструктура приложения (src/bootstrap.js, src/ota.js или папка применённого OTA-бандла); " +
    "её поломка выведет приложение из строя. Правь другие файлы src/ и пересобери обновление: node scripts/make-ota.js."
  );
}

module.exports = { protectedSelfPath, protectedSelfPathMessage };