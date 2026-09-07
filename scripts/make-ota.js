"use strict";
// Сборка локального OTA-бандла (self-update агента).
// Использование: node scripts/make-ota.js [--out <папка>] [--version x.y.z]
// По умолчанию пишет в ota/ рядом с репозиторием: manifest.json + bundle.json.
// Приложение проверяет эту папку при старте и каждые 60 секунд и применяет обновление.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, "ota");
})();
const VER_ARG = (() => {
  const i = process.argv.indexOf("--version");
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]).trim() : "";
})();

// Зеркалит список файлов electron-builder (files: src/**, assets/**, package.json, server.js)
const INCLUDED = ["src", "assets", "package.json", "server.js"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "ota", "bin"]);
const SKIP_PREFIXES = [".tmp-"];

function collectFiles() {
  const files = {};
  const walk = (dir, base) => {
    for (const name of fs.readdirSync(dir)) {
      if (SKIP_DIRS.has(name) || SKIP_PREFIXES.some((p) => name.startsWith(p))) continue;
      const abs = path.join(dir, name);
      const rel = path.join(base, name).split(path.sep).join("/");
      if (fs.statSync(abs).isDirectory()) walk(abs, rel);
      else files[rel] = abs;
    }
  };
  for (const item of INCLUDED) {
    const abs = path.join(ROOT, item);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) walk(abs, item);
    else files[item] = abs;
  }
  return files;
}

function syntaxCheckAll(files) {
  let checked = 0;
  for (const rel of Object.keys(files)) {
    if (!rel.endsWith(".js")) continue;
    const r = spawnSync(process.execPath, ["--check", files[rel]], { encoding: "utf8" });
    if (r.status !== 0) {
      console.error("✗ Синтаксическая ошибка в " + rel + ":\n" + (r.stderr || r.stdout || "").slice(0, 1200));
      process.exit(1);
    }
    checked++;
  }
  return checked;
}

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

function bumpPatch(v) {
  const m = String(v || "0.0.0").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return "0.0.1";
  return m[1] + "." + m[2] + "." + (parseInt(m[3], 10) + 1);
}

function main() {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  } catch {
    pkg = { version: "1.0.0" };
  }
  const files = collectFiles();
  if (!files["src/main.js"] || !files["src/bootstrap.js"]) {
    console.error("✗ В бандле должны быть src/main.js и src/bootstrap.js");
    process.exit(1);
  }

  console.log("Проверка синтаксиса изменённых файлов…");
  const checked = syntaxCheckAll(files);

  const prev = readManifest(OUT);
  let version = VER_ARG || pkg.version || "1.0.0";
  if (!VER_ARG && prev && prev.version === version) version = bumpPatch(version);

  const filesB64 = {};
  let bytes = 0;
  for (const rel of Object.keys(files)) {
    const buf = fs.readFileSync(files[rel]);
    filesB64[rel] = buf.toString("base64");
    bytes += buf.length;
  }

  const bundleJson = JSON.stringify({ version, files: filesB64 });
  const manifest = {
    app: "ai-agent",
    version,
    builtAt: Date.now(),
    files: Object.keys(filesB64).length,
    sha256: crypto.createHash("sha256").update(bundleJson).digest("hex"),
  };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "bundle.json"), bundleJson, "utf8");
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  console.log("✓ OTA-бандл собран: " + OUT);
  console.log("  версия: " + version + (VER_ARG ? " (задана --version)" : prev ? " (авто-бамп патча)" : ""));
  console.log("  файлов: " + Object.keys(filesB64).length + " (JS проверено: " + checked + ")");
  console.log("  размер: " + (bytes / 1024).toFixed(1) + " КБ (base64: " + (bundleJson.length / 1024).toFixed(1) + " КБ)");
}

main();