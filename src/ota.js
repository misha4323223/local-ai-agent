"use strict";
// Локальный self-update (OTA): агент собирает бандл (scripts/make-ota.js) в локальную папку,
// приложение проверяет её при старте и по таймеру, применяет и перезапускается.
// Файл стабильный — сам через OTA не обновляется (грузится из app.asar).
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");

// electron подключаем лениво, чтобы модуль можно было тестировать в plain-node
// с переопределённым корнем OTA (AI_AGENT_OTA_ROOT).
function electron() {
  return require("electron");
}

// Корень OTA: userData/ota (переопределяется переменной окружения для тестов)
const OTA_ROOT = () =>
  process.env.AI_AGENT_OTA_ROOT || path.join(electron().app.getPath("userData"), "ota");
const CURRENT = () => path.join(OTA_ROOT(), "current");
const PREV = () => path.join(OTA_ROOT(), "current.prev");
const TMP = () => path.join(OTA_ROOT(), "current.tmp");

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function writeJson(p, o) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(o, null, 2), "utf8");
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function parseVersion(v) {
  const m = String(v || "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map((n) => parseInt(n, 10)) : null;
}
function versionGt(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  if (!A || !B) return false;
  for (let i = 0; i < 3; i++) {
    if (A[i] !== B[i]) return A[i] > B[i];
  }
  return false;
}

// Установленная сейчас версия (применённый OTA)
function installedInfo() {
  const v = readJson(path.join(CURRENT(), "version.json"));
  return v && v.version ? { version: v.version, source: "ota" } : null;
}

// Кандидаты-источники OTA: папка в userData, настроенная папка, ota/ рядом с кодом (разработка)
function sources(settings) {
  const list = [];
  const push = (d) => {
    if (d && !list.includes(d)) list.push(d);
  };
  push(OTA_ROOT());
  push((settings && settings.otaDir) || "");
  push(path.join(__dirname, "..", "ota"));
  return list.filter((d) => fs.existsSync(path.join(d, "manifest.json")));
}

// Найти самый свежий не применённый бандл в локальных папках
function findCandidate(settings) {
  const installed = installedInfo();
  let best = null;
  for (const dir of sources(settings)) {
    const m = readJson(path.join(dir, "manifest.json"));
    if (!m || !m.version) continue;
    if (m.app && m.app !== "ai-agent") continue;
    if (installed && !versionGt(m.version, installed.version)) continue;
    if (best && !versionGt(m.version, best.version)) continue;
    best = { dir, manifest: m };
  }
  return best;
}

// Проверка синтаксиса JS через сам Electron (ELECTRON_RUN_AS_NODE) до применения бандла
function syntaxCheck(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--check", file], {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }),
      stdio: ["ignore", "ignore", "ignore"],
    });
    const t = setTimeout(() => {
      try {
        p.kill();
      } catch {}
      resolve(false);
    }, 15000);
    p.on("close", (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
}

// Применить бандл из dir: хеш/состав → распаковка → проверка синтаксиса → атомарный своп
async function applyBundle(dir, manifest) {
  const bundlePath = path.join(dir, "bundle.json");
  const raw = fs.readFileSync(bundlePath);
  if (manifest.sha256 && sha256(raw) !== manifest.sha256) {
    throw new Error("Хеш бандла не совпал — файл повреждён или подменён");
  }
  let bundle;
  try {
    bundle = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("bundle.json повреждён (не JSON)");
  }
  const files = bundle && bundle.files;
  if (!files || typeof files !== "object") throw new Error("Пустой бандл");
  if (!files["src/main.js"] || !files["src/renderer/index.html"]) {
    throw new Error("В бандле нет src/main.js или src/renderer/index.html");
  }

  // Распаковка во временную папку
  const tmpDir = TMP();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const rel of Object.keys(files)) {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(String(files[rel]), "base64"));
  }

  // Предварительная проверка синтаксиса всех JS-файлов (ловит «агент сломал код»)
  const jsFiles = Object.keys(files).filter((f) => f.endsWith(".js"));
  for (const rel of jsFiles) {
    if (!(await syntaxCheck(path.join(tmpDir, rel)))) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw new Error("Синтаксическая ошибка в " + rel + " — обновление отклонено");
    }
  }

  writeJson(path.join(tmpDir, "version.json"), {
    version: manifest.version,
    builtAt: manifest.builtAt || Date.now(),
    source: dir,
  });

  // Атомарно: current → current.prev, tmp → current
  fs.rmSync(PREV(), { recursive: true, force: true });
  if (fs.existsSync(CURRENT())) fs.renameSync(CURRENT(), PREV());
  fs.renameSync(tmpDir, CURRENT());
  return { ok: true, version: manifest.version };
}

function relaunch() {
  electron().app.relaunch();
  electron().app.exit(0);
}

// Полный проход: найти обновление, применить, перезапустить
async function check(settings) {
  if (!settings || settings.otaEnabled === false) return { status: "disabled" };
  if (global.__agentRunning) return { status: "busy" }; // не обновляемся посреди работы агента
  const cand = findCandidate(settings);
  if (!cand) return { status: "ok" };
  try {
    const r = await applyBundle(cand.dir, cand.manifest);
    relaunch();
    return { status: "applied", version: r.version };
  } catch (e) {
    return { status: "error", message: e.message || String(e) };
  }
}

// Откат на предыдущую версию (current.prev → current) и перезапуск
function rollback() {
  if (!fs.existsSync(PREV())) return { ok: false, message: "Предыдущей версии нет" };
  fs.rmSync(CURRENT(), { recursive: true, force: true });
  fs.renameSync(PREV(), CURRENT());
  relaunch();
  return { ok: true };
}

function status(settings) {
  const inst = installedInfo();
  return {
    enabled: settings ? settings.otaEnabled !== false : true,
    dir: OTA_ROOT(),
    installed: inst ? inst.version : "base",
    sources: sources(settings).map((d) => path.join(d, "manifest.json")),
  };
}

function openDir() {
  electron().shell.openPath(OTA_ROOT());
  return true;
}

// Полный сброс OTA: удаляет применённый бандл (userData/ota) — приложение вернётся
// к коду из установки. При removeSource=true дополнительно удаляет папку-источник
// разработки ota/ рядом с кодом (там лежит локально собранный бандл), чтобы
// нерабочее обновление не подхватилось снова.
function reset(removeSource, settings) {
  const removedUser = [];
  const removedSource = [];
  if (fs.existsSync(OTA_ROOT())) {
    fs.rmSync(OTA_ROOT(), { recursive: true, force: true });
    removedUser.push(OTA_ROOT());
  }
  if (removeSource) {
    const src = path.join(__dirname, "..", "ota");
    if (fs.existsSync(src)) {
      fs.rmSync(src, { recursive: true, force: true });
      removedSource.push(src);
    }
  }
  return {
    ok: true,
    removedUser,
    removedSource,
    sourcesLeft: sources(settings).map((d) => path.join(d, "manifest.json")),
  };
}

module.exports = { check, status, rollback, openDir, resolveCurrent: CURRENT, installedInfo, OTA_ROOT, findCandidate, applyBundle, versionGt, reset };