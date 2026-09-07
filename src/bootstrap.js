"use strict";
// Точка входа приложения. Маленький и стабильный файл: решает, откуда загружать основной код —
// из app.asar (штатно) или из папки локального self-update (OTA) в userData.
// Никогда не включай в этот файл тяжёлую логику: он не обновляется через OTA.
const path = require("path");
const fs = require("fs");
const { app } = require("electron");

const ASAR_DIR = __dirname; // .../app.asar/src (в разработке — корень репозитория/src)
const OTA_ROOT = () => path.join(app.getPath("userData"), "ota");
const OTA_CURRENT = () => path.join(OTA_ROOT(), "current");

function otaValid() {
  try {
    return (
      fs.existsSync(path.join(OTA_CURRENT(), "version.json")) &&
      fs.existsSync(path.join(OTA_CURRENT(), "src", "main.js"))
    );
  } catch {
    return false;
  }
}

// Если OTA-код требует модуль, которого нет в его дереве (например electron-updater) —
// до-разрешаем из node_modules установленного приложения (app.asar / репозиторий).
const Module = require("module");
const _resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  try {
    return _resolveFilename.call(this, request, parent, isMain, options);
  } catch (e) {
    const pf = parent && typeof parent.filename === "string" ? parent.filename : "";
    if (pf.indexOf(path.join("ota", "current")) !== -1) {
      const fallback = {
        filename: path.join(ASAR_DIR, "fallback.js"),
        paths: Module._nodeModulePaths(ASAR_DIR),
      };
      return _resolveFilename.call(this, request, fallback, isMain, options);
    }
    throw e;
  }
};

function loadMain(fromDir) {
  require(path.join(fromDir, "src", "main.js"));
}

(function boot() {
  if (otaValid()) {
    try {
      loadMain(OTA_CURRENT());
      return;
    } catch (e) {
      console.error("[ota] не удалось загрузить обновлённый код, откат на установленную версию:", (e && e.stack) || e);
      // Помечаем бандл сломанным, чтобы больше не пытаться грузить его
      try {
        fs.rmSync(path.join(OTA_ROOT(), "current.broken"), { recursive: true, force: true });
        fs.renameSync(OTA_CURRENT(), path.join(OTA_ROOT(), "current.broken"));
      } catch {}
    }
  }
  loadMain(ASAR_DIR);
})();