"use strict";
// Точка входа приложения. Маленький и стабильный файл: решает, откуда загружать основной код —
// из app.asar (штатно) или из папки локального self-update (OTA) в userData.
// Никогда не включай в этот файл тяжёлую логику: он не обновляется через OTA.
const path = require("path");
const fs = require("fs");
const { app } = require("electron");

// Папка, внутри которой лежит src/ с основным кодом:
// в собранном приложении — .../app.asar (туда electron-builder кладёт src/** как есть),
// в разработке — корень репозитория. __dirname сам по себе — это src/, поэтому поднимаемся на уровень выше,
// иначе path.join(fromDir, "src", "main.js") даст задвоенное src\src\main.js.
const ASAR_DIR = path.join(__dirname, "..");
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

// Версия установленного приложения (package.json рядом с кодом — в app.asar его кладёт
// electron-builder). Если прочитать не удалось — null, и тогда ведём себя как раньше.
function installedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ASAR_DIR, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

// Версия применённого OTA-бандла (userData/ota/current/version.json)
function otaVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(OTA_CURRENT(), "version.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}

function versionGt(a, b) {
  const A = String(a || "0.0.0").match(/^(\d+)\.(\d+)\.(\d+)/);
  const B = String(b || "0.0.0").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!A || !B) return false;
  for (let i = 1; i <= 3; i++) {
    const x = parseInt(A[i], 10);
    const y = parseInt(B[i], 10);
    if (x !== y) return x > y;
  }
  return false;
}

// ГЛАВНОЕ ПРАВИЛО: применённый бандл загружается только если он СТРОГО НОВЕЕ
// установленной версии приложения. Если пользователь скачал/собрал свежий код
// (1.5.7 и выше), а в userData/ota/current остался старый бандл (1.3.x / 1.5.x) —
// старый бандл больше никогда не «перекрывает» установленный код.
function otaNewerThanInstalled() {
  const inst = installedVersion();
  if (!inst) return true; // версию установленного не прочитать — legacy-поведение
  return !!otaVersion() && versionGt(otaVersion(), inst);
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

// Если пользователь выключил OTA в настройках (Настройки → Self-update →
// «Разрешить локальные обновления на ходу») — грузим код ТОЛЬКО из установки,
// даже если в userData/ota/current остался применённый бандл.
function otaDisabled() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "settings.json"), "utf8"));
    return !!(raw && raw.otaEnabled === false);
  } catch {
    return false;
  }
}

(function boot() {
  if (!otaDisabled() && otaValid() && otaNewerThanInstalled()) {
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
  } else if (otaValid() && !otaDisabled()) {
    // Бандл есть, но он НЕ новее установленной версии (или версия не читается) —
    // грузим код из установки, а устаревший бандл удаляем, чтобы он не мешал
    // и не вводил в заблуждение (панель Self-update показывала его версию).
    try {
      fs.rmSync(OTA_CURRENT(), { recursive: true, force: true });
    } catch {}
  }
  loadMain(ASAR_DIR);
})();