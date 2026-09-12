"use strict";

/* ── Официальный yc CLI внутри папки приложения (без системных прав) ─────────
   Схема загрузки взята из официального установщика Yandex Cloud
   (https://storage.yandexcloud.net/yandexcloud-yc/install.sh):
     версия:  GET {SDK}/release/stable                        → "0.140.0"
     бинарь:  GET {SDK}/release/{VERSION}/{os}/{arch}/yc[.exe]
   Ставим в {userData}/bin — не в системный каталог, поэтому прав администратора
   не нужно, а папка попадает в PATH всех команд агента (см. main.js).
   Модуль не требует electron: путь передаётся аргументом, поэтому он полностью
   тестируется в обычном node с подставным fetch.
*/

const fs = require("fs");
const path = require("path");

const SDK = "https://storage.yandexcloud.net/yandexcloud-yc";

// Платформа → пара golang os/arch, которую использует хранилище Yandex.
function platformInfo(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  let os = "";
  if (p === "win32") os = "windows";
  else if (p === "darwin") os = "darwin";
  else if (p === "linux") os = "linux";
  else return { ok: false, error: "Платформа «" + p + "» официальным yc CLI не поддерживается." };

  let goarch = "";
  if (a === "x64") goarch = "amd64";
  else if (a === "arm64") goarch = "arm64";
  else if (a === "ia32") goarch = "386";
  else return { ok: false, error: "Разрядность «" + a + "» официальным yc CLI не поддерживается." };

  if (os === "windows" && goarch === "arm64") {
    return { ok: false, error: "Yandex Cloud не выпускает yc для Windows на ARM — используй сборку под x64." };
  }
  return { ok: true, os, arch: goarch, binName: os === "windows" ? "yc.exe" : "yc" };
}

function versionUrl() {
  return SDK + "/release/stable";
}

function binaryUrl(version, os, arch, binName) {
  const v = String(version == null ? "" : version).trim();
  return SDK + "/release/" + encodeURIComponent(v) + "/" + os + "/" + arch + "/" + (binName || "yc");
}

function binDir(userData) {
  return path.join(String(userData || ""), "bin");
}

function binPath(userData, binName) {
  const name = binName || platformInfo().binName || "yc";
  return path.join(binDir(userData), name);
}

// Путь к уже установленному yc внутри приложения (или null).
function installed(userData) {
  try {
    const p = binPath(userData);
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

async function download(fetchImpl, url, timeoutMs) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || 120000) : null;
  try {
    return await fetchImpl(url, Object.assign({ redirect: "follow" }, ctrl ? { signal: ctrl.signal } : {}));
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// opts: { userData, platform, arch, fetchImpl, timeoutMs, onLog }
async function install(opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const log = typeof o.onLog === "function" ? o.onLog : () => {};
  if (!fetchImpl) return { ok: false, error: "Нет доступа к сети (fetch недоступен)." };

  const info = platformInfo(o.platform, o.arch);
  if (!info.ok) return info;

  const userData = String(o.userData || "").trim();
  if (!userData) return { ok: false, error: "Не задана папка приложения (userData)." };

  const dir = binDir(userData);
  const target = path.join(dir, info.binName);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: "Не удалось создать папку " + dir + ": " + ((e && e.message) || e) };
  }

  // 1. Какая сейчас стабильная версия.
  let version = "";
  try {
    const r = await download(fetchImpl, versionUrl(), Math.min(o.timeoutMs || 120000, 30000));
    if (!r || !r.ok) return { ok: false, error: "Не удалось узнать версию yc (HTTP " + ((r && r.status) || "?") + ")." };
    version = String(await r.text()).trim();
  } catch (e) {
    return { ok: false, error: "Нет связи с хранилищем Yandex Cloud: " + ((e && e.message) || e) };
  }
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    return { ok: false, error: "Неожиданный ответ с версией yc: " + version.slice(0, 80) };
  }
  log("Версия yc: " + version + " (" + info.os + "/" + info.arch + ")");

  // 2. Загрузка в .tmp и подмена — как в официальном install.sh:
  //    недокачанный файл никогда не займёт место рабочего бинаря.
  const tmp = target + ".tmp";
  try {
    const r = await download(fetchImpl, binaryUrl(version, info.os, info.arch, info.binName), o.timeoutMs || 120000);
    if (!r || !r.ok) return { ok: false, error: "Скачивание не удалось (HTTP " + ((r && r.status) || "?") + ")." };
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1024 * 1024) {
      return { ok: false, error: "Файл подозрительно мал (" + buf.length + " байт) — скачивание не удалось." };
    }
    fs.writeFileSync(tmp, buf);
    if (info.binName !== "yc.exe") fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { ok: false, error: "Скачивание не удалось: " + ((e && e.message) || e) };
  }

  return { ok: true, path: target, dir, version, os: info.os, arch: info.arch, sizeMb: (fs.statSync(target).size / 1048576).toFixed(1) };
}

module.exports = {
  SDK,
  platformInfo,
  versionUrl,
  binaryUrl,
  binDir,
  binPath,
  installed,
  install,
};
