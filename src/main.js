"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, Notification, clipboard, desktopCapturer } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const { execFile, spawn } = require("child_process");
const {
  SYSTEM_PROMPT,
  TOOL_DEFINITIONS,
  createThinkingStripper,
  extractToolCallsFromText,
  normalizeToolName,
  buildChatRequest,
  consumeProviderStream,
  listModels,
  readApiError,
  genCallId,
  contextBudget,
  trimConversation,
  truncateText,
  webSearchDDG,
  webFetchPage,
  // вспомогательная модель: зрение + генерация изображений
  auxConfig,
  describeImageRemote,
  generateImageRemote,
  selectTools,
  modelWindow,
  // инструменты ОС (парсеры, whitelist)
  parseProcessesCsv,
  registryPathAllowed,
  parseSysInfoJson,
  createContextManager,
  estimateTokens,
} = require("./renderer/agent-core.js");

// ─────────────────────────── Мобильный мост (LAN + PWA + PIN) ───────────────────────────
// Мост отдаёт интерфейс и дублирует IPC по WebSocket для телефона/планшета в той же сети.
// Прокси ipcMain.handle: каждый зарегистрированный обработчик сохраняется в карту —
// мобильный мост вызывает те же функции, что и окно приложения (никакого дублирования логики).
const MobileBridge = require("./mobile-bridge.js");
const _ipcHandleOrig = ipcMain.handle.bind(ipcMain);
const ipcHandlerMap = new Map();
ipcMain.handle = (channel, fn) => {
  ipcHandlerMap.set(channel, fn);
  return _ipcHandleOrig(channel, fn);
};
const mobileBridge = new MobileBridge({ handlerMap: ipcHandlerMap });
const ota = require("./ota.js"); // локальный self-update (OTA)

// ─────────────────────────── Настройки ───────────────────────────
// Клонирование репозиториев: явная кнопка «⬇ Выгрузить» в списке GitHub-репозиториев
// (клик по строке — только выбор; клонирует «Выгрузить»), поле «Клонировать» в панели проекта
// и инструмент агента gitClone используют единый robust-код (cloneRepoTo).
// Команды агента (runCommand/shell) дублируются в нижний терминал приложения через termAgentEcho.
// provider: "ollama" (локально) | "openai" (OpenAI-совместимые: Groq/GPT/DeepSeek/OpenRouter/свой) | "anthropic" (Claude)
const DEFAULT_SETTINGS = {
  provider: "ollama",
  ollamaUrl: "http://localhost:11434",
  openaiUrl: "https://api.groq.com/openai/v1",
  openaiApiKey: "",
  anthropicUrl: "https://api.anthropic.com",
  anthropicApiKey: "",
  model: "",
  workingDir: os.homedir(),
  githubToken: "",
  githubClientId: "",
  githubLogin: "",
  githubAvatarUrl: "",
  githubRepoSlug: "",
  githubRepoDir: "",
  allowAgentPush: false, // агенту ЗАПРЕЩЕНО пушить в GitHub, пока пользователь явно не включит
  agentAutoCommit: true, // авто-чекпоинт: локальный коммит после каждого завершённого задания агента
  projects: [], // список проектов (до 10): { id, name, dir, createdAt, lastOpened }

  // Мобильный доступ: мост по LAN с PIN-кодом (телефон в той же Wi-Fi сети).
  mobileEnabled: false,
  mobilePort: 9090,
  mobilePin: "",
  // Вспомогательная модель (второй ключ OpenRouter): зрение + генерация картинок
  visionEnabled: false,
  visionAuto: true,
  visionUrl: "https://openrouter.ai/api/v1",
  visionKey: "",
  visionModel: "",
  imageModel: "",
  activeProjectId: "", // id активного проекта (его dir = workingDir)
  // Локальный self-update (OTA): агент собирает бандл (scripts/make-ota.js), приложение применяет на ходу
  otaEnabled: true,
  otaDir: "", // необязательная папка-источник OTA (пусто — userData/ota + ota/ рядом с кодом)
};

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
const chatsFile = () => path.join(app.getPath("userData"), "chats.json");

// Миграция старых настроек (provider:"external" / externalUrl / apiKey) в новую схему.
function normalizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  if (s.provider === "external") s.provider = "openai";
  if (!raw || raw.openaiUrl === undefined) {
    if (raw && raw.externalUrl !== undefined) s.openaiUrl = raw.externalUrl;
  }
  if (!raw || raw.openaiApiKey === undefined) {
    if (raw && raw.apiKey !== undefined) s.openaiApiKey = raw.apiKey;
  }
  // Миграция на проекты: если списка ещё нет — заводим один проект из рабочей директории.
  if (!Array.isArray(raw.projects)) {
    const wd = s.workingDir && typeof s.workingDir === "string" ? s.workingDir.trim() : "";
    if (wd) {
      const base = path.basename(wd) || "Рабочая папка";
      s.projects = [{ id: "p-main", name: base, dir: wd, createdAt: Date.now(), lastOpened: Date.now() }];
      s.activeProjectId = "p-main";
    } else {
      s.projects = [];
      s.activeProjectId = "";
    }
  }
  if (!Array.isArray(s.projects)) s.projects = [];
  return s;
}

// Переменные окружения агента (envSet/envList/envUnset). Значения хранятся в settings.json
// (settings.agentEnv) и подмешиваются во все команды: runCommand, фоновые процессы, shell, git, docker.
let agentEnv = {};

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    const s = normalizeSettings(raw);
    agentEnv = (s && typeof s.agentEnv === "object" && s.agentEnv) || {};
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), "utf8");
}

function loadChats() {
  try {
    const d = JSON.parse(fs.readFileSync(chatsFile(), "utf8"));
    if (d && Array.isArray(d.chats)) return d;
  } catch {}
  return { chats: [], activeId: null };
}

function saveChats(d) {
  fs.mkdirSync(path.dirname(chatsFile()), { recursive: true });
  fs.writeFileSync(chatsFile(), JSON.stringify(d, null, 2), "utf8");
}

// ─────────────────────────── Пути и файлы ───────────────────────────
function resolvePath(p, settings) {
  const base = agentWorkDir(settings);
  if (!p) return base;
  if (path.isAbsolute(p)) return p;
  return path.resolve(base, p);
}

// ─────────────────────────── Git ───────────────────────────
// cwd — директория, в которой выполняется git; settings — для токена авторизации (OAuth / PAT).
function runGit(cwd, args, settings) {
  return new Promise((resolve) => {
    const opts = { cwd, timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
    if (settings && settings.githubToken) {
      opts.env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...agentEnv };
      // GitHub принимает на git-эндпоинте только Basic-авторизацию (Bearer отклоняет
      // с «remote: invalid credentials»). Схема как в GitHub Actions:
      // Authorization: Basic base64(<login или x-access-token>:<token>).
      const ghUser = ((settings.githubLogin || "").trim() || "x-access-token");
      const ghAuth = Buffer.from(ghUser + ":" + settings.githubToken).toString("base64");
      args = ["-c", "http.extraheader=Authorization: Basic " + ghAuth, ...args];
    } else if (Object.keys(agentEnv).length) {
      opts.env = { ...process.env, GIT_TERMINAL_PROMPT: "0", ...agentEnv };
    }
    execFile("git", args, opts, (err, stdout, stderr) => {
      const out = (stdout || "").toString();
      const errText = (stderr || "").toString();
      if (err) {
        let msg = (errText || err.message).toString().trim().slice(0, 4000);
        if (err.code === "ENOENT" || /not found|не является внутренней или внешней командой/i.test(msg)) {
          msg = "Git не найден в PATH. Установи Git (git-scm.com/downloads), перезапусти приложение и обнови PATH через инструмент refreshEnv. Ошибка: " + msg;
        }
        resolve({ ok: false, out, err: msg });
      } else {
        resolve({ ok: true, out: out.trim(), err: errText.trim() });
      }
    });
  });
}

// Рабочая директория приложения (или домашняя, если её нет)
function gitDirOrHome(settings) {
  return settings.workingDir && fs.existsSync(settings.workingDir) ? settings.workingDir : os.homedir();
}

// Директория, в которой агент выполняет git и команды: если недавно клонировали репозиторий — там,
// иначе в рабочей директории (если она сама — репозиторий), иначе в рабочей папке.
let lastAgentRepoDir = null; // путь, куда агент последний раз клонировал репозиторий
let clonedRepoPending = false; // одноразовый флаг: после клона/смены репозитория следующий ответ агента начнётся с анализа проекта
let activeRunUndo = []; // undo-снимки файлов последнего запуска агента
let lastUndoLog = [];
let pendingAsk = null; // ожидание ответа пользователя (askUser)

function agentWorkDir(settings) {
  const base = gitDirOrHome(settings);
  // Если выбран GitHub-репозиторий и его локальная папка ещё есть — работать в ней.
  if (settings.githubRepoSlug && settings.githubRepoDir && fs.existsSync(settings.githubRepoDir)) {
    return settings.githubRepoDir;
  }
  if (lastAgentRepoDir && fs.existsSync(lastAgentRepoDir)) return lastAgentRepoDir;
  return base;
}

// Вынимает имя репозитория из URL (https://github.com/user/repo.git, git@github.com:user/repo.git и т.п.)
// Имя используется как имя папки — чистим от того, что Windows не разрешает (точка/пробел в конце,
// служебные имена CON/PRN/AUX/NUL/COM1...), иначе git упадёт с «could not create work tree dir».
function repoNameFromUrl(url) {
  let u = String(url || "").trim().replace(/\/+$/, "");
  if (u.includes("git@") && u.includes(":")) u = "https://" + u.slice(u.indexOf(":") + 1);
  let name = (u.split("/").pop() || "repo").replace(/\.git$/i, "").replace(/[. ]+$/g, "").trim();
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = "repo";
  return name;
}

// Убирает учётные данные из git-URL: https://user:TOKEN@github.com/... -> https://github.com/...
// Нужно, чтобы токен не хранился в .git/config и не мешал сравнению remote-URL.
function stripUrlCreds(u) {
  const s = String(u || "").trim();
  return s.replace(/^(https?:\/\/)[^@/]+@/i, "$1");
}

function sanitizeDir(p) {
  if (!p || typeof p !== "string") return null;
  const abs = path.resolve(String(p));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return null;
  return abs;
}

function sanitizePath(p) {
  if (!p || typeof p !== "string") return null;
  const abs = path.resolve(String(p));
  if (!fs.existsSync(abs)) return null;
  return abs;
}

// Команды, которые агент может выполнять только после явного подтверждения пользователя
// (удаление данных, принудительный push, очистка истории и т.п.).
const DANGEROUS_CMD_RE =
  /(^|\s)(rm\s+-[a-z]*r|rmdir\s+\/s|rd\s+\/s|del\s+\/f|format\s+[a-z]:|mkfs\.|dd\s+if=|git\s+push([\s;&|()]|$)|git\s+reset\s+--hard|git\s+clean\s+-f|git\s+checkout\s+--|shutdown\s|taskkill\s+\/f|:?\(\)\s*\{|chmod\s+-R\s+777|sudo\s+rm|powershell\s+.*remove-item|Remove-Item\s+-Recurse|\bdel\b.*\/s)/i;

// Инструменты, требующие явного подтверждения пользователя (как опасные команды).
const DANGEROUS_TOOLS = new Set(["killProcess", "registryWrite", "installExe"]);

// Короткое описание аргументов для подтверждения опасного действия.
function describeToolArgs(name, a) {
  const x = a || {};
  if (name === "killProcess") return "завершить процесс «" + (x.name || x.pid || "?") + "»" + (x.force ? " (принудительно)" : "");
  if (name === "registryWrite") return "записать значение реестра «" + (x.name || "") + "» в " + (x.path || "?");
  if (name === "installExe") return "скачать и запустить установщик: " + String(x.url || "").slice(0, 120);
  return name + " " + JSON.stringify(x).slice(0, 120);
}

// Чистит ANSI-escape-последовательности (цвета npm-сборок и т.п.) из вывода терминала.
function stripAnsi(s) {
  return String(s || "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
    .replace(/\r/g, "");
}

// Запуск произвольной команды в терминале (без интерактива).
// Возвращает текст с кодом завершения и временем выполнения.
function runTerminalCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
    const start = Date.now();
    execFile(shell, args, {
      cwd,
      timeout: timeoutMs || 120000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...agentEnv },
    }, (err, stdout, stderr) => {
      const secs = ((Date.now() - start) / 1000).toFixed(1);
      const timeNote = " (" + secs + " с)";
      const out = stripAnsi(stdout || "").trim();
      const errText = stripAnsi(stderr || "").trim();
      if (!err) {
        if (out && errText) resolve(out + "\n\n[stderr]\n" + errText + timeNote);
        else resolve((out || errText || "Готово (без вывода).") + timeNote);
      } else {
        const code = err.killed ? "таймаут" : err.code;
        const parts = [];
        if (out) parts.push(out);
        if (errText) parts.push(errText);
        if (!parts.length) parts.push(err.message || String(err));
        resolve("Команда завершилась с кодом " + code + timeNote + ":\n" + parts.join("\n").slice(0, 6000));
      }
    });
  });
}

// ─────────────────────────── Помощники новых инструментов ───────────────────────────
// Определяет пакетный менеджер проекта по lockfile.
function detectPackageManager(cwd) {
  const has = (name) => fs.existsSync(path.join(cwd, name));
  if (has("bun.lockb") || has("bun.lock")) return { name: "bun", bin: "bun", add: "add", flagDev: "-d" };
  if (has("pnpm-lock.yaml")) return { name: "pnpm", bin: "pnpm", add: "add", flagDev: "-D" };
  if (has("yarn.lock")) return { name: "yarn", bin: "yarn", add: "add", flagDev: "-D" };
  return { name: "npm", bin: "npm", add: "install", flagDev: "-D" };
}

function hasLock(kind) {
  const cwd = agentWorkDir(loadSettings());
  const has = (name) => fs.existsSync(path.join(cwd, name));
  if (kind === "bun") return has("bun.lockb") || has("bun.lock");
  return has("package-lock.json") || has("npm-shrinkwrap.json");
}

// Выжимает из вывода тестового раннера краткий итог: сколько прошло/упало и какие тесты упали.
function summarizeTestOutput(out) {
  const s = String(out || "");
  const summary = [];
  const passMatch = s.match(/Tests:?\s+(\d+)\s+(passed|passing|пройден)/i) || s.match(/(\d+)\s*(passed|passing|пройден)/i) || s.match(/passed\s*(\d+)/i);
  const failMatch = s.match(/Tests:?\s+.*?(\d+)\s+(failed|failing|упал)/i) || s.match(/(\d+)\s*(failed|failing|упал)/i) || s.match(/failed\s*(\d+)/i);
  if (passMatch) summary.push("✅ прошло: " + passMatch[1]);
  if (failMatch) summary.push("❌ упало: " + failMatch[1]);
  const failLines = s.split("\n").map((l) => l.trim()).filter((l) => l && l.length < 200 && /^(✕|✗|×|FAIL\b|●|✖|❌)/.test(l)).slice(0, 15);
  if (failLines.length) summary.push("Упавшие тесты:\n" + failLines.join("\n"));
  if (!summary.length && /(fail|error)/i.test(s)) summary.push("В выводе есть ошибки/упавшие тесты — смотри полный вывод.");
  return summary.join("\n");
}

// Unified-дифф двух файлов/папок через git diff --no-index (git уже есть в системе).
function unifiedDiff(p1, p2) {
  return new Promise((resolve) => {
    execFile("git", ["diff", "--no-index", "--", p1, p2], {
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, ...agentEnv },
    }, (err, stdout, stderr) => {
      // git diff --no-index возвращает код 1 при различиях — это норма, патч в stdout.
      resolve({ patch: stripAnsi((stdout || "") + (stderr || "")).trim() });
    });
  });
}

// ─────────────────────────── Помощники: анализ/рефакторинг/API/БД ───────────────────────────
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Собирает исходники проекта, исключая node_modules/.git/dist и прочий мусор.
function projectSourceFiles(root) {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage", "__pycache__", ".venv", "venv", "target", "vendor", ".idea", ".vscode", ".cache", ".turbo", "node_modules"]);
  const EXT_OK = /\.(js|jsx|ts|tsx|mjs|cjs|json|css|scss|sass|less|html|htm|vue|svelte|py|go|rs|java|kt|kts|rb|php|cs|dart|md|markdown|yml|yaml|toml|sh|sql)$/i;
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 3000) return;
      if (e.name.startsWith(".") && e.name !== ".env" && e.name !== ".env.local") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(full);
      } else if (EXT_OK.test(e.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

// Структура файла: импорты, экспорты и объявления верхнего уровня с номерами строк.
function buildFileStructure(abs, filter) {
  let content;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch (e) {
    return { error: "не удалось прочитать файл: " + (e.message || String(e)) };
  }
  if (content.includes("\u0000")) return { error: "файл бинарный — структуру не показать" };
  const lines = content.split("\n");
  const filterRe = filter ? (() => { try { return new RegExp(String(filter), "i"); } catch { return null; } })() : null;
  const rows = [];
  const push = (lineNo, kind, text) => {
    const t = String(text || "").trim().slice(0, 110);
    if (!t) return;
    if (filterRe && !filterRe.test(kind + " " + t)) return;
    if (rows.length < 400) rows.push({ line: lineNo, kind, text: t });
  };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (rows.length >= 400) break;
    // импорты: import ... from 'x' / import 'x' / require('x')
    const imp = ln.match(/^\s*import\s+[^"']+?\s+from\s+["']([^"']+)["']/) ||
      ln.match(/^\s*import\s+\("?\s*["']([^"']+)["']/) ||
      ln.match(/^\s*import\s+["']([^"']+)["']\s*;?/) ||
      ln.match(/^\s*(?:const|let|var)\s+[\w$,\s{}*]+\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/);
    if (imp) { push(i + 1, "import", imp[1]); continue; }
    // экспорты
    const exp = ln.match(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/) ||
      ln.match(/^\s*export\s*\{[^}]*\}/) ||
      ln.match(/^\s*export\s+\*\s+from\s+["'][^"']+["']/);
    if (exp) { push(i + 1, "export", exp[1] || ln.trim().slice(0, 80)); continue; }
    // объявления верхнего уровня (без отступа)
    if (!/^\s/.test(ln)) {
      const dec = ln.match(/^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|func|fn|public|private|internal|static)\b[^;{=]*/);
      if (dec) push(i + 1, "decl", dec[0].trim());
    }
  }
  return { rows, totalLines: lines.length };
}

// Переименование идентификатора по границам слова во всех исходниках проекта (или в одном файле/папке).
function refactorRenameFiles(root, oldName, newName, dryRun) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(oldName)) return { error: "oldName должен быть валидным идентификатором (буквы/цифры/_/$)" };
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(newName)) return { error: "newName должен быть валидным идентификатором (буквы/цифры/_/$)" };
  if (oldName === newName) return { error: "oldName и newName совпадают" };
  const rootIsFile = argsPathIsFile(root);
  const files = rootIsFile ? [root] : projectSourceFiles(root);
  const re = new RegExp("(?<![A-Za-z0-9_$])" + escRe(oldName) + "(?![A-Za-z0-9_$])", "g");
  const changed = [];
  let total = 0;
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(f); } catch { continue; }
    if (buf.includes(0)) continue; // бинарный файл
    let content;
    try { content = buf.toString("utf8"); } catch { continue; }
    const m = content.match(re);
    if (!m) continue;
    const count = m.length;
    total += count;
    const sampleLines = content.split("\n").filter((l) => new RegExp("(?<![A-Za-z0-9_$])" + escRe(oldName) + "(?![A-Za-z0-9_$])").test(l)).slice(0, 2).map((l) => l.trim().slice(0, 120));
    if (!dryRun) {
      try { fs.writeFileSync(f, content.replace(re, newName), "utf8"); } catch { continue; }
    }
    const relBase = rootIsFile ? path.dirname(root) : root;
    changed.push({ rel: path.relative(relBase, f).split(path.sep).join("/"), count, sample: sampleLines.join(" | ") });
  }
  return { dryRun, changed, total };
}
function argsPathIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Поиск использований символа по границам слова (аналог «Найти все ссылки» в IDE).
// root — рабочая папка проекта или конкретный файл/папка. Каждая строка-совпадение
// классифицируется: определение / импорт / вызов / ссылка.
function findSymbolReferences(root, symbol) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) return { error: "symbol должен быть валидным идентификатором (буквы/цифры/_/$)" };
  const isFile = argsPathIsFile(root);
  const files = isFile ? [root] : projectSourceFiles(root);
  const re = new RegExp("(?<![A-Za-z0-9_$])" + escRe(symbol) + "(?![A-Za-z0-9_$])");
  const esc = escRe(symbol);
  const hits = [];
  for (const f of files) {
    if (hits.length >= 100) break;
    let buf;
    try { buf = fs.readFileSync(f); } catch { continue; }
    if (buf.includes(0)) continue; // бинарный файл
    const lines = buf.toString("utf8").split("\n");
    const rel = path.relative(isFile ? path.dirname(root) : root, f).split(path.sep).join("/") || path.basename(f);
    let perFile = 0;
    for (let i = 0; i < lines.length && perFile < 25 && hits.length < 100; i++) {
      const raw = lines[i];
      if (!re.test(raw)) continue;
      const t = raw.trim();
      let kind = "ссылка";
      const mods = "(?:async\\s+|static\\s+|get\\s+|set\\s+)*";
      if (/(^|[^A-Za-z0-9_$])(import\b|require\s*\()/.test(t) && !/^\s*(?:const|let|var)\s/.test(t)) kind = "импорт";
      else if (new RegExp("^(?:export\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum|def|func|fn)\\s+" + esc + "\\b").test(t)) kind = "определение";
      else if (new RegExp("^(?:export\\s+)?(?:const|let|var)\\s+" + esc + "\\s*(?:=|:)").test(t)) kind = "определение";
      else if (new RegExp("^" + esc + "\\s*:\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>").test(t)) kind = "определение";
      else if (new RegExp("^\\s{1,}" + mods + esc + "\\s*\\(").test(raw) && /\{\s*$/.test(raw)) kind = "определение";
      else if (new RegExp("(?:^|[^A-Za-z0-9_$])(?:new\\s+)?" + esc + "\\s*\\(").test(t)) kind = "вызов";
      else if (new RegExp("(^|[^A-Za-z0-9_$])new\\s+" + esc + "\\b").test(t)) kind = "вызов";
      hits.push({ file: rel, n: i + 1, kind, text: t.slice(0, 140) });
      perFile++;
    }
  }
  return { error: null, hits, truncated: hits.length >= 100 };
}

// Запуск команды со сбором вывода, пока не появится waitFor / процесс не завершится / не выйдет таймаут.
function spawnCollect(command, cwd, timeoutMs, waitFor) {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
    let out = "";
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      payload.out = out;
      resolve(payload);
    };
    const timer = setTimeout(() => {
      // Убиваем ДЕРЕВО (taskkill /T /F), а не только оболочку — иначе node/expo-сирота держит порт.
      killProcessTree(child);
      finish({ ok: false, timedOut: true, matched: false, code: "timeout" });
    }, timeoutMs || 120000);
    const child = spawn(shell, args, {
      cwd,
      detached: !(process.platform === "win32"),
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...agentEnv },
    });
    const onData = (d) => {
      out += stripAnsi((d || "").toString());
      if (waitFor && out.includes(waitFor)) finish({ ok: true, matched: true, code: 0 });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => finish({ ok: false, timedOut: false, matched: false, code: e && e.code }));
    child.on("close", (code) => finish({ ok: code === 0, timedOut: false, matched: false, code }));
  });
}

// Скриншот страницы: невидимое окно, ждём загрузку и отрисовку, снимаем capturePage.
function screenshotUrl(url) {
  return new Promise((resolve) => {
    let win = null;
    let timer = null;
    const done = (payload) => {
      if (timer) clearTimeout(timer);
      if (win && !win.isDestroyed()) { win.destroy(); win = null; }
      resolve(payload);
    };
    const fail = (msg) => done({ ok: false, err: msg });
    try {
      win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
    } catch (e) {
      return fail(e.message);
    }
    timer = setTimeout(() => fail("таймаут загрузки " + url + " (30 с)"), 30000);
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          const png = img.toPNG();
          done({ ok: true, dataUrl: "data:image/png;base64," + png.toString("base64") });
        } catch (e) {
          fail(e.message);
        }
      }, 2500);
    });
    win.webContents.once("did-fail-load", (_e, code, desc) => fail(code + " " + String(desc || "").slice(0, 300)));
    win.loadURL(url).catch((e) => fail(e.message));
  });
}

// ─────────────────────────── Фоновые процессы и постоянные shell-сессии ───────────────────────────
// Процессы живут между вызовами инструментов; вывод копится в кольцевой буфер.
const bgProcesses = new Map();
let bgSeq = 0;

function bgPushLines(rec, chunk) {
  const lines = stripAnsi(chunk.toString()).split("\n");
  for (const l of lines) rec.output.push(l);
  if (rec.output.length > 1000) rec.output.splice(0, rec.output.length - 1000);
}

function bgSpawn(command, opts) {
  opts = opts || {};
  const isWin = process.platform === "win32";
  const shell = opts.shell || (isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh");
  const args = opts.shellArgs || (isWin ? ["/d", "/s", "/c", command] : ["-c", command]);
  const child = spawn(shell, args, {
    cwd: opts.cwd || os.homedir(),
    detached: !isWin,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", FORCE_COLOR: "0", ...agentEnv },
  });
  const rec = {
    id: "bg" + (++bgSeq).toString(36) + "-" + Date.now().toString(36),
    command: String(command || ""),
    name: opts.name || String(command || "").slice(0, 60),
    cwd: opts.cwd || os.homedir(),
    startedAt: Date.now(),
    output: [],
    exited: false,
    exitCode: null,
    child,
  };
  bgProcesses.set(rec.id, rec);
  child.stdout.on("data", (d) => bgPushLines(rec, d));
  child.stderr.on("data", (d) => bgPushLines(rec, d));
  child.on("exit", (code) => { rec.exited = true; rec.exitCode = code; });
  child.on("error", (e) => { rec.exited = true; rec.error = e.message; });
  return rec;
}

function bgKill(rec) {
  if (!rec || !rec.child) return;
  const pid = rec.child.pid;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try { process.kill(-pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 1200);
    }
  } catch {}
  try { rec.child.kill(); } catch {}
}

// ─────────────────────────── Dev-серверы: распознавание и освобождение порта ───────────────────────────
// Команды, похожие на запуск длительного dev-сервера (не завершаются сами по себе).
// Сознательно НЕ ловим «vite build» и «npm run build» — это короткие команды.
const SERVER_CMD_RE =
  /(?:^|[\s;&|])(?:npx\s+)?expo\s+start\b|(?:^|[\s;&|])(?:npm|npx|bun|yarn|pnpm)\s+run\s+(dev|dev:[\w:.-]+|start|start:[\w:.-]+|serve|watch|preview)\b|(?:^|[\s;&|])(?:npm|bun|yarn|pnpm)\s+(start|serve|dev)\b|(?:^|[\s;&|])vite\b(?!\s+(build|optimize)\b)|(?:^|[\s;&|])next\s+dev\b|(?:^|[\s;&|])ng\s+serve\b|(?:^|[\s;&|])nodemon\b|(?:^|[\s;&|])tsx\s+watch\b|(?:^|[\s;&|])uvicorn\b|(?:^|[\s;&|])gunicorn\b|(?:^|[\s;&|])dotnet\s+run\b|(?:^|[\s;&|])flutter\s+run\b|(?:^|[\s;&|])(?:node|bun)\s+\S*(server|app|index|main)\.(js|ts|mjs|cjs)\b|(?:^|[\s;&|])python3?\s+\S*manage\.py\s+runserver\b/i;

// Убивает процесс вместе со ВСЕМ деревом (Windows — taskkill /T /F, иначе — группа процессов).
// Простой child.kill() на Windows убивает только cmd.exe, а node/expo-дети остаются и держат порт.
function killProcessTree(child) {
  const pid = child && child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try { process.kill(-pid, "SIGTERM"); } catch {}
      setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 1200);
    }
  } catch {}
  try { child.kill(); } catch {}
}

// Ждёт появления маркера в выводе фонового процесса (не убивая его и не дожидаясь выхода).
function bgWaitFor(rec, needle, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (needle && rec.output.join("\n").includes(needle)) return resolve({ matched: true });
      if (rec.exited) return resolve({ matched: false, exited: true, code: rec.exitCode });
      if (Date.now() - t0 > (timeoutMs || 120000)) return resolve({ matched: false, timedOut: true });
      setTimeout(tick, 300);
    };
    tick();
  });
}

// Достаёт порт из URL вида http://localhost:5000/path.
function parsePortFromUrl(url) {
  const m = String(url || "").match(/:(\d{1,5})(\/|$)/);
  return m ? parseInt(m[1], 10) : 0;
}

// Находит процессы, слушающие порт, и убивает их (освобождает порт).
async function killProcessesOnPort(port) {
  const p = parseInt(port, 10);
  if (!p || p < 1 || p > 65535) return { ok: false, error: "Некорректный порт: " + port };
  const killed = [];
  if (process.platform === "win32") {
    const out = await runTerminalCommand("netstat -ano -p tcp", os.homedir(), 15000);
    const pidSet = new Set();
    for (const line of String(out).split("\n")) {
      if (!/LISTENING/i.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const local = parts[1] || "";
      const pid = parts[parts.length - 1] || "";
      const pm = local.match(/:(\d{1,5})$/);
      if (pm && pm[1] === String(p) && /^\d+$/.test(pid)) pidSet.add(pid);
    }
    for (const pid of pidSet) {
      await new Promise((r) => {
        const k = spawn("taskkill", ["/pid", pid, "/T", "/F"], { windowsHide: true });
        k.on("close", () => r());
        k.on("error", () => r());
      });
      killed.push(pid);
    }
  } else {
    const out = await runTerminalCommand("lsof -ti tcp:" + p + " 2>/dev/null || fuser " + p + "/tcp 2>/dev/null", os.homedir(), 15000);
    const pids = (String(out).match(/\d+/g) || []).filter((x) => Number(x) > 1);
    for (const pid of pids) {
      try { process.kill(Number(pid), "SIGTERM"); } catch {}
      killed.push(pid);
    }
  }
  return { ok: killed.length > 0, killed };
}

// Ждём, пока вывод процесса «затихнет» (для shellSend: команда отработала).
function waitOutputQuiet(rec, maxMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let lastLen = rec.output.length;
    const tick = () => {
      if (rec.exited || Date.now() - t0 > (maxMs || 6000)) return resolve();
      if (rec.output.length !== lastLen) {
        lastLen = rec.output.length;
        return setTimeout(tick, 150);
      }
      if (Date.now() - t0 > 700) return resolve();
      setTimeout(tick, 150);
    };
    setTimeout(tick, 250);
  });
}

function bgTail(rec, lines) {
  const n = Math.min(Math.max(lines || 50, 1), 500);
  return rec.output.slice(-n).join("\n");
}

// Проверка HTTP(S)-URL: статус, заголовки, начало тела.
async function checkUrlStatus(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "AI-Developer-Agent" },
    });
    const body = await res.text().catch(() => "");
    const ct = res.headers.get("content-type") || "";
    const head = body.replace(/\s+/g, " ").trim().slice(0, 400);
    const lines = [
      "URL: " + url,
      "Статус: " + res.status + " " + (res.statusText || ""),
      "Content-Type: " + ct,
      "Размер тела: " + body.length + " символов",
    ];
    if (head) lines.push("Начало тела: " + head);
    return lines.join("\n");
  } catch (e) {
    return "Ошибка: сервер не ответил — " + (e.name === "AbortError" ? "таймаут 8 с" : e.message);
  } finally {
    clearTimeout(timer);
  }
}

// ── Поиск по всему проекту (grep) и обзор структуры ──
// Веб-поиск и чтение страниц (webSearchDDG / webFetchPage) — в agent-core.js.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt", ".output",
  ".venv", "venv", "env", "__pycache__", ".idea", ".vscode", ".dart_tool", ".flutter-plugins",
  ".gradle", "target", "vendor", "bower_components", "Pods", ".cache", ".parcel-cache", "lib-cov",
]);
const MAX_FILE_SCAN = 2 * 1024 * 1024; // файлы больше 2 МБ не сканируем поиском

// Рекурсивный обход проекта: вызывает onFile(relPath, absPath); останавливается по лимитам.
function walkProject(root, opts, onFile) {
  const maxDepth = opts.maxDepth || 8;
  const maxFiles = opts.maxFiles || 4000;
  let visited = 0;
  (function walk(dir, depth) {
    if (depth > maxDepth || visited >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (visited >= maxFiles) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      if (e.isDirectory()) {
        walk(abs, depth + 1);
      } else if (e.isFile()) {
        visited++;
        onFile(rel, abs);
      }
    }
  })(root, 0);
}

// Список файлов проекта для «осмотра» (listFiles).
function listProjectFiles(settings, sub) {
  const root = sub ? resolvePath(sub, settings) : agentWorkDir(settings);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return "Ошибка: папка не найдена: " + root;
  const out = [];
  const cap = 300;
  walkProject(root, { maxFiles: cap + 100 }, (rel) => {
    if (out.length < cap) out.push(rel.replace(/\\/g, "/"));
  });
  if (!out.length) return "В папке " + root + " нет файлов (или только в пропускаемых папках: node_modules, .git и т.п.).";
  const base = sub ? root : agentWorkDir(settings);
  const prefix = path.relative(agentWorkDir(settings), base) || "";
  const lines = out.map((f) => (prefix ? prefix.replace(/\\/g, "/") + "/" + f : f));
  const more = out.length >= cap ? "\n… (показаны первые " + cap + " записей)" : "";
  return "Файлы проекта (" + out.length + "):\n" + lines.join("\n") + more;
}

// Поиск по всем файлам проекта (searchProject), как grep -r.
function searchProjectFiles(pattern, settings, sub) {
  const root = sub ? resolvePath(sub, settings) : agentWorkDir(settings);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return "Ошибка: папка не найдена: " + root;
  let re = null;
  try {
    re = new RegExp(pattern, "i");
  } catch {}
  const maxResults = 40;
  const hits = [];
  walkProject(root, {}, (rel, abs) => {
    if (hits.length >= maxResults) return;
    if (BINARY_EXT.has(path.extname(abs).toLowerCase().replace(".", ""))) return;
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (!st.isFile() || st.size > MAX_FILE_SCAN) return;
    let content;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      return;
    }
    if (content.includes("\u0000")) return;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
      if (re ? re.test(lines[i]) : lines[i].includes(pattern)) {
        hits.push({ file: rel.replace(/\\/g, "/"), n: i + 1, text: lines[i].trim().slice(0, 220) });
      }
    }
  });
  if (!hits.length) return "Совпадений по «" + pattern + "» в проекте нет (каталог: " + root + ").";
  return (
    "Совпадения «" + pattern + "» (" + hits.length + "):\n" +
    hits.map((h) => h.file + ":" + h.n + "  " + h.text).join("\n") +
    "\n\nЧтобы посмотреть строки вокруг, используй readFileLines (path, start, count)."
  );
}

// Снимок файла для «отката изменений агента». Снимок делается ПЕРЕД каждой правкой,
// поэтому undoEdit(path, steps) умеет откатывать на несколько шагов назад.
// На файл хранится не более UNDO_MAX_PER_FILE последних снимков (старые вытесняются).
// content === null означает, что файл был создан агентом (откат = удалить).
const UNDO_MAX_PER_FILE = 5;
function snapshotFileForUndo(p) {
  try {
    let content;
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > 10 * 1024 * 1024) return; // очень большие файлы не копируем
      content = fs.readFileSync(p, "utf8");
    } else {
      content = null; // создан агентом
    }
    activeRunUndo.push({ path: p, content, ts: Date.now() });
    // вытесняем самые старые снимки этого файла, оставляя UNDO_MAX_PER_FILE
    let total = 0;
    for (const u of activeRunUndo) if (u.path === p) total++;
    let drop = total - UNDO_MAX_PER_FILE;
    if (drop > 0) {
      const kept = [];
      for (let i = 0; i < activeRunUndo.length; i++) {
        const u = activeRunUndo[i];
        if (u.path === p && drop > 0) { drop--; continue; }
        kept.push(u);
      }
      activeRunUndo = kept;
    }
  } catch {}
}

// ── Чекпоинт: снимок изменений последнего запуска сохраняется на диск, ──
// ── чтобы откат пережил перезапуск приложения. ──
const undoFile = () => path.join(app.getPath("userData"), "undo.json");

function persistUndo() {
  try {
    fs.mkdirSync(path.dirname(undoFile()), { recursive: true });
    fs.writeFileSync(undoFile(), JSON.stringify(lastUndoLog), "utf8");
  } catch {}
}

function loadPersistedUndo() {
  if (lastUndoLog.length) return;
  try {
    const d = JSON.parse(fs.readFileSync(undoFile(), "utf8"));
    if (Array.isArray(d)) lastUndoLog = d;
  } catch {}
}

// ─────────────────────────── Выполнение инструментов ───────────────────────────
function numberedLines(all, fromLine, toLine, total) {
  const pad = String(total).length;
  const out = [];
  for (let i = fromLine - 1; i < Math.min(toLine, all.length); i++) {
    out.push(String(i + 1).padStart(pad, " ") + " | " + all[i]);
  }
  return out.join("\n");
}

function langFromExt(p) {
  const ext = path.extname(p || "").toLowerCase();
  const map = {
    ".js": "JavaScript", ".jsx": "JavaScript/React", ".ts": "TypeScript", ".tsx": "TypeScript/React",
    ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".c": "C",
    ".cpp": "C++", ".h": "C/C++ header", ".cs": "C#", ".rb": "Ruby", ".php": "PHP", ".swift": "Swift",
    ".html": "HTML", ".htm": "HTML", ".css": "CSS", ".scss": "SCSS", ".vue": "Vue", ".svelte": "Svelte",
    ".json": "JSON", ".yaml": "YAML", ".yml": "YAML", ".toml": "TOML", ".md": "Markdown",
    ".sh": "Shell", ".bash": "Bash", ".sql": "SQL", ".dart": "Dart", ".lua": "Lua",
  };
  return map[ext] || "текст";
}

// Карта структуры файла: определения с номерами строк (языконезависимые эвристики)
const OUTLINE_RULES = [
  { kind: "функция", re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: "функция", re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/ },
  { kind: "класс", re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: "класс", re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: "метод", re: /^\s{2,}(?:async\s+)?(?:get|set\s+)?(?!(?:for|while|if|switch|catch|return)\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/ },
  { kind: "функция", re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
  { kind: "класс", re: /^\s*class\s+([A-Za-z_]\w*)/ },
  { kind: "функция", re: /^\s*func\s+([A-Za-z_]\w*)/ },
  { kind: "функция", re: /^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?(?:fn|function)\s+([A-Za-z_$][\w$]*)/ },
  { kind: "функция", re: /^\s*(?:def|pub\s+fn)\s+([A-Za-z_]\w*)/ },
  { kind: "заголовок", re: /^(#{1,4})\s+(.*)$/, nameOf: (m) => "#".repeat(m[1].length) + " " + m[2].slice(0, 80) },
  { kind: "css", re: /^([.#][\w-]+)\s*\{/ },
  { kind: "html", re: /^\s*<([a-zA-Z][\w-]*)([^>]*)>/, nameOf: (m) => {
      const id = /id=["']([^"']+)["']/.exec(m[2]);
      const cls = /class=["']([^"']+)["']/.exec(m[2]);
      return "<" + m[1] + (id ? " #" + id[1] : "") + (cls ? " ." + cls[1].split(/\s+/)[0] : "") + ">";
    } },
];

function buildFileOutline(content, filter, cap) {
  const all = content.split("\n");
  const entries = [];
  const filterRe = filter ? (() => { try { return new RegExp(filter, "i"); } catch { return null; } })() : null;
  const pad = String(all.length).length;
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    for (const rule of OUTLINE_RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const name = rule.nameOf ? rule.nameOf(m) : m[1];
      if (filterRe && !filterRe.test(name) && !filterRe.test(rule.kind)) continue;
      entries.push({ line: i + 1, kind: rule.kind, name: String(name).slice(0, 90) });
      break; // одна запись на строку
    }
    if (entries.length >= cap) break;
  }
  const text = entries.map((e) => String(e.line).padStart(pad, " ") + " | " + e.kind.padEnd(8, " ") + " | " + e.name).join("\n");
  return { entries, text };
}

// Диапазоны определений файла (start..end) по тем же правилам, что и fileOutline.
// end = строка перед началом следующего определения (или последняя строка файла) —
// приблизительные, но достаточные границы «блока» для режима searchFile blocks:true.
function buildBlockRanges(all) {
  const ranges = [];
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    for (const rule of OUTLINE_RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const name = rule.nameOf ? rule.nameOf(m) : m[1];
      ranges.push({ start: i + 1, kind: rule.kind, name: String(name).slice(0, 90) });
      break; // одна запись на строку
    }
  }
  for (let i = 0; i < ranges.length; i++) {
    ranges[i].end = i + 1 < ranges.length ? ranges[i + 1].start - 1 : all.length;
  }
  return ranges;
}

// Краткая «визитка» проекта для старта сессии: имя, скрипты, двухуровневая структура,
// первые строки README. Подмешивается к системному промпту в runAi — агенту не нужно
// осматриваться с нуля, а истории хватает дольше. Чисто синхронная и дешёвая.
function buildProjectBrief(root) {
  if (!root || !fs.existsSync(root)) return "";
  const parts = [];
  // package.json: имя и скрипты
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const name = (pkg.name && String(pkg.name)) || path.basename(root);
    parts.push("Проект: " + name + " (каталог: " + root + ")");
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    const scriptList = Object.keys(scripts).slice(0, 12).map((k) => k + ": " + String(scripts[k]).slice(0, 50));
    if (scriptList.length) parts.push("Скрипты package.json: " + scriptList.join("; "));
  } catch {}
  // Двухуровневая структура (без node_modules/.git и прочего мусора)
  const tree = [];
  const walkBrief = (dir, depth) => {
    if (depth > 2 || tree.length >= 80) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (tree.length >= 80) return;
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join("/");
      tree.push((e.isDirectory() ? "📁 " : "📄 ") + rel + (e.isDirectory() ? "/" : ""));
      if (e.isDirectory()) walkBrief(path.join(dir, e.name), depth + 1);
    }
  };
  walkBrief(root, 0);
  if (tree.length) parts.push("Структура (" + tree.length + " записей):\n" + tree.join("\n"));
  // README: первые непустые строки без разметки заголовков
  const readme = ["README.md", "readme.md", "Readme.md", "README.MD"]
    .map((f) => path.join(root, f))
    .find((f) => fs.existsSync(f));
  if (readme) {
    try {
      const head = fs.readFileSync(readme, "utf8")
        .split("\n")
        .map((l) => l.replace(/^#+\s*/, "").trim())
        .filter((l) => l && !/^```/.test(l))
        .slice(0, 10)
        .join(" · ");
      if (head) parts.push("README (начало): " + head);
    } catch {}
  }
  return parts.join("\n\n");
}

// ═══════════════════ Системные программы и окружение ═══════════════════
// Получить PATH (с учётом agentEnv) — на Windows ключ может быть «Path».
function envPathInfo() {
  const e = { ...process.env, ...agentEnv };
  const key = Object.keys(e).find((k) => k.toLowerCase() === "path");
  return { e, key, value: key ? String(e[key] || "") : "" };
}

function setMergedPath(before, extra) {
  const parts = [];
  const push = (v) => {
    for (const seg of String(v || "").split(path.delimiter)) {
      const t = seg.trim();
      if (t && !parts.includes(t)) parts.push(t);
    }
  };
  push(before);
  push(extra);
  process.env.PATH = parts.join(path.delimiter);
  return parts;
}

// Поиск исполняемого файла: PATH (+ PATHEXT на Windows) + типовые места установки.
function findProgram(name) {
  const prog = String(name || "").trim();
  if (!prog) return { found: false, reason: "Пустое имя программы" };
  if (prog.includes("/") || prog.includes("\\")) {
    const abs = path.resolve(prog);
    if (fs.existsSync(abs)) return { found: true, path: abs };
    return { found: false, reason: "Не найден файл: " + abs };
  }
  const { e, value } = envPathInfo();
  const dirs = (value || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? String(e.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const cands = [];
  for (const d of dirs) {
    for (const ext of exts) {
      const cand = path.join(d, prog + (ext || ""));
      if (!cands.includes(cand)) cands.push(cand);
    }
  }
  if (process.platform === "win32") {
    const home = e.USERPROFILE || "";
    const pf = e.ProgramFiles || "C:\\Program Files";
    const known = {
      git: [path.join(pf, "Git", "cmd", "git.exe"), path.join(home, "AppData", "Local", "Programs", "Git", "cmd", "git.exe")],
      node: [path.join(pf, "nodejs", "node.exe")],
      python: [path.join(home, "AppData", "Local", "Programs", "Python", "python.exe")],
      code: [path.join(home, "AppData", "Local", "Programs", "Microsoft VS Code", "Code.exe")],
    };
    for (const k of Object.keys(known)) {
      if (prog.toLowerCase() === k || prog.toLowerCase().startsWith(k + ".") || prog.toLowerCase().startsWith(k + " ")) {
        cands.push(...known[k]);
      }
    }
  }
  for (const cand of cands) {
    try {
      if (cand && fs.existsSync(cand) && fs.statSync(cand).isFile()) return { found: true, path: cand };
    } catch {}
  }
  return { found: false, reason: "«" + prog + "» не найден в PATH" + (process.platform === "win32" ? " и в типовых местах установки" : "") };
}

function runProgVersion(bin) {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, ...agentEnv } }, (err, stdout, stderr) => {
      const text = stripAnsi((stdout || "") + "\n" + (stderr || "")).trim();
      resolve(text ? text.split("\n")[0].slice(0, 180) : "");
    });
  });
}

function spawnRaw(args, opts) {
  return new Promise((resolve) => {
    const o = opts || {};
    execFile(args[0], args.slice(1), {
      cwd: o.cwd || os.homedir(),
      timeout: o.timeoutMs || 60000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", FORCE_COLOR: "0", ...agentEnv },
    }, (err, stdout, stderr) => {
      let code = 0;
      if (err) {
        if (typeof err.code === "number") code = err.code;
        else if (err.killed) code = -1; // таймаут
        else if (err.code === "ENOENT") code = 127;
        else code = 1;
      }
      resolve({ ok: !err, code, out: stripAnsi(stdout || ""), err: stripAnsi(stderr || "") });
    });
  });
}

// Обновить PATH текущего процесса из системного окружения (после установок).
async function refreshEnvFromOS() {
  const before = envPathInfo().value;
  let sysPath = "";
  if (process.platform === "win32") {
    const r = await spawnRaw(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      "$m=[Environment]::GetEnvironmentVariable('Path','Machine'); $u=[Environment]::GetEnvironmentVariable('Path','User'); Write-Output ($m + ';' + $u)"], { cwd: os.homedir(), timeoutMs: 30000 });
    sysPath = (r.out || "").trim();
  } else {
    for (const shell of ["bash", "sh"]) {
      const r = await spawnRaw([shell, "-lc", 'printf "%s" "$PATH"'], { cwd: os.homedir(), timeoutMs: 30000 });
      if (r.ok && (r.out || "").trim()) {
        sysPath = (r.out || "").trim();
        break;
      }
    }
  }
  if (!sysPath) return "Не удалось прочитать системный PATH — вызови refreshEnv() ещё раз после перезапуска приложения.";
  const all = setMergedPath(before, sysPath);
  const beforeParts = (before || "").split(path.delimiter).map((x) => x.trim()).filter(Boolean);
  const added = all.filter((x) => !beforeParts.includes(x));
  return (
    "PATH обновлён в текущей сессии (до перезапуска).\n" +
    "Записей было: " + beforeParts.length + ", стало: " + all.length +
    (added.length ? "\nДобавлено (новые пути):\n" + added.slice(0, 20).join("\n") + (added.length > 20 ? "\n… и ещё " + (added.length - 20) : "") : "\nНовых путей не появилось.") +
    "\n\nПроверь установку: checkInstalledProgram(имя). Уже открытые shell-сессии PATH не меняют — обновляются только новые процессы приложения."
  );
}

const WINGET_IDS = {
  git: "Git.Git",
  node: "OpenJS.NodeJS.LTS",
  npm: "OpenJS.NodeJS.npm",
  python: "Python.Python.3.12",
  python3: "Python.Python.3.12",
  ffmpeg: "Gyan.FFmpeg",
  gh: "GitHub.cli",
  "7zip": "7zip.7zip",
  "7z": "7zip.7zip",
  powershell: "Microsoft.PowerShell",
  yarn: "Yarn.Yarn",
  pnpm: "pnpm.pnpm",
  bun: "Oven-sh.Bun",
  docker: "Docker.DockerDesktop",
  dotnet: "Microsoft.DotNet.SDK.8",
  java: "EclipseAdoptium.Temurin.21.JDK",
  jdk: "EclipseAdoptium.Temurin.21.JDK",
  curl: "curl.curl",
  wget: "GNU.Wget2",
  make: "GnuWin32.Make",
  cmake: "Kitware.CMake",
  sqlite: "SQLite.SQLite",
  redis: "Redis.Redis",
  nginx: "Nginx.Nginx",
  postgresql: "PostgreSQL.PostgreSQL.16",
  postgres: "PostgreSQL.PostgreSQL.16",
  mysql: "Oracle.MySQL",
  mongodb: "MongoDB.Server",
  ollama: "Ollama.Ollama",
  chrome: "Google.Chrome",
  chromium: "Chromium.Chromium",
  firefox: "Mozilla.Firefox",
  vscode: "Microsoft.VisualStudioCode",
  notepadpp: "Notepad++.Notepad++",
  vlc: "VideoLAN.VLC",
  winrar: "RARLab.WinRAR",
  powertoys: "Microsoft.PowerToys",
  terminal: "Microsoft.WindowsTerminal",
  imagemagick: "ImageMagick.ImageMagick",
  telegram: "Telegram.TelegramDesktop",
  discord: "Discord.Discord",
  slack: "SlackTechnologies.Slack",
  obs: "OBSProject.OBSStudio",
  blender: "BlenderFoundation.Blender",
  gimp: "GIMP.GIMP",
  inkscape: "Inkscape.Inkscape",
  figma: "Figma.Figma",
  drawio: "JGraph.Draw",
  obsidian: "Obsidian.Obsidian",
  everything: "voidtools.Everything",
  spotify: "Spotify.Spotify",
  zoom: "Zoom.Zoom",
  putty: "PuTTY.PuTTY",
  wireshark: "WiresharkFoundation.Wireshark",
};

const EXIT_HINTS = {
  0: "Успех — команда завершилась корректно (код 0).",
  1: "Общая ошибка: команда упала. Смотри вывод выше — чаще всего ошибка в коде/конфигурации, а не в системе.",
  2: "Неправильное использование команды: неверные аргументы или синтаксис.",
  126: "Команда найдена, но не может выполниться: нет прав на запуск или файл не исполняемый.",
  127: "Команда НЕ НАЙДЕНА: программы нет в PATH / она не установлена. Проверь через checkInstalledProgram, при необходимости установи (installSystemPackage) и обнови PATH (refreshEnv).",
  130: "Прервано пользователем (Ctrl+C / SIGINT).",
  137: "Процесс убит (SIGKILL) — обычно нехватка памяти или принудительная остановка.",
  143: "Завершён по SIGTERM (мягкая остановка).",
  9009: "Windows: команда не найдена (аналог кода 127).",
  740: "Windows: нужны права администратора — используй runCommandAsAdmin или установи из-под администратора.",
  5: "Windows: отказано в доступе — файл занят, нет прав или нужен администратор (runCommandAsAdmin).",
  206: "Windows: слишком длинная командная строка — сократи команду.",
};

function explainExit(exitCode, cmdText) {
  const code = typeof exitCode === "number" ? exitCode : NaN;
  const lines = [];
  if (cmdText) lines.push("Команда: " + String(cmdText).slice(0, 300));
  lines.push("Код завершения: " + (Number.isNaN(code) ? "— (не число)" : code) + (code === -1 ? " (таймаут — процесс убит по времени)" : ""));
  lines.push("");
  lines.push(
    EXIT_HINTS[code] ||
      (Number.isNaN(code)
        ? "Укажи exitCode числом, чтобы получить объяснение."
        : "Код " + code + " не входит в типовую таблицу. Смотри текст ошибки: если там «not found» / «не является внутренней или внешней командой» — программа не установлена; «denied»/«доступ запрещён» — нужны права; иначе это ошибка самой команды.")
  );
  if (code === 127 || code === 9009) {
    lines.push("Что делать: 1) canExecute(имя) — проверить наличие; 2) installSystemPackage(имя) — установить; 3) refreshEnv() — обновить PATH; 4) проверить заново.");
  }
  if (code === 740 || code === 5) {
    lines.push("Что делать: запусти через runCommandAsAdmin (появится системный запрос прав) либо установи программу из-под администратора.");
  }
  return lines.join("\n");
}

async function installSystemPkg(pkg) {
  const name = String(pkg || "").trim();
  if (!name) return "Ошибка: укажи packageName (например git, node, python, ffmpeg или winget-ID вида Vendor.Name).";
  const plat = process.platform;
  const info = findProgram(name.split(/[\\/]/).pop() || name);
  if (info.found) {
    const v = await runProgVersion(info.path);
    return "«" + name + "» уже установлен: " + info.path + (v ? "\n" + v : "") + "\nУстановка не нужна.";
  }
  if (plat === "win32") {
    const id = name.includes(".") ? name : WINGET_IDS[name.toLowerCase()];
    if (!id) {
      return "Не знаю winget-ID для «" + name + "». Найди точный ID: wingetSearch(\"" + name + "\"), затем installSystemPackage('Vendor.Name'). Известные ID: " + Object.keys(WINGET_IDS).join(", ") + ". Либо укажи прямую ссылку на установщик: installExe(url, name).";
    }
    const wg = findProgram("winget");
    if (!wg.found) {
      const choco = findProgram("choco");
      if (choco.found) {
        const cmd = "choco install -y " + name.split(".").pop();
        const out = await runTerminalCommand(cmd, os.homedir(), 300000);
        return "$ " + cmd + "\n\n" + out + "\n\nДальше: 1) refreshEnv() — обновить PATH; 2) checkInstalledProgram(\"" + name + "\"). Если нужен администратор — повтори через runCommandAsAdmin(\"" + cmd + "\").";
      }
      const scoop = findProgram("scoop");
      if (scoop.found) {
        const cmd = "scoop install " + name.split(".").pop();
        const out = await runTerminalCommand(cmd, os.homedir(), 300000);
        return "$ " + cmd + "\n\n" + out + "\n\nДальше: 1) refreshEnv() — обновить PATH; 2) checkInstalledProgram(\"" + name + "\").";
      }
      return "winget не установлен (choco и scoop тоже не найдены). Установи winget из Microsoft Store («App Installer»), либо укажи прямую ссылку на установщик: installExe(url, name).";
    }
    const cmd = "winget install --id " + id + " --exact --accept-package-agreements --accept-source-agreements --disable-interactivity";
    const out = await runTerminalCommand(cmd, os.homedir(), 300000);
    return (
      "$ " + cmd + "\n\n" + out +
      "\n\nДальше: 1) refreshEnv() — обновить PATH; 2) checkInstalledProgram(имя) — проверить. " +
      "Если установка потребовала UAC/администратора и прервалась — повтори через runCommandAsAdmin(\"" + cmd + "\") или установи вручную."
    );
  }
  if (plat === "darwin") {
    const brew = findProgram("brew");
    if (!brew.found) return "На macOS установка идёт через Homebrew, но он не найден. Поставь Homebrew (brew.sh) и вызови installSystemPackage снова.";
    const cmd = "brew install " + name;
    const out = await runTerminalCommand(cmd, os.homedir(), 600000);
    return "$ " + cmd + "\n\n" + out + "\n\nПроверь: checkInstalledProgram(" + name + ").";
  }
  const isRoot = typeof process.getuid === "function" && process.getuid && process.getuid() === 0;
  let mgr = null;
  for (const [bin, flag] of [["apt-get", "install -y"], ["dnf", "install -y"], ["apk", "add"]]) {
    if (findProgram(bin).found) { mgr = bin + " " + flag; break; }
  }
  if (!mgr) return "Не нашёл пакетный менеджер (apt-get/dnf/apk). Установи " + name + " вручную.";
  const sudo = isRoot ? "" : "sudo -n ";
  const cmd = sudo + mgr + " " + name;
  const out = await runTerminalCommand(cmd, os.homedir(), 600000);
  const looksFailed = /кодом (1|100|127|126)|not found|E: |Unable to/i.test(out);
  return (
    "$ " + cmd + "\n\n" + out +
    (looksFailed
      ? "\n\nПохоже, установка не удалась: без sudo пакетный менеджер требует пароль. Запусти через runCommandAsAdmin(\"" + cmd + "\") — появится системный запрос прав."
      : "\n\nПроверь: checkInstalledProgram(" + name + ").")
  );
}

async function downloadAndExtractTo(url, destDir) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return "Ошибка: укажи полный URL (https://…/archive.zip, .tar.gz и т.п.)";
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (e) {
    return "Ошибка: не удалось создать папку " + destDir + ": " + (e.message || String(e));
  }
  let res;
  try {
    res = await fetch(u, { redirect: "follow", headers: { "User-Agent": "AI-Developer-Agent" } });
  } catch (e) {
    return "Ошибка загрузки " + u + ": " + (e.message || String(e));
  }
  if (!res.ok) return "Ошибка HTTP " + res.status + " при загрузке " + u;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 300 * 1024 * 1024) return "Архив слишком большой (>300 МБ): " + buf.length + " байт.";
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const pathLow = u.toLowerCase();
  const isZip = pathLow.endsWith(".zip") || contentType.includes("zip");
  const isTar = /\.(tar\.gz|tgz|tar\.bz2|tbz2|tar)$/.test(pathLow) || contentType.includes("gzip") || contentType.includes("tar");
  if (!isZip && !isTar) return "Не похоже на архив (.zip / .tar.gz / .tgz): " + u + ". Скачивать обычные файлы через runCommand (curl / Invoke-WebRequest).";
  const tmpFile = path.join(os.tmpdir(), "ai-agent-dl-" + Date.now().toString(36) + (isZip ? ".zip" : ".tar"));
  try {
    fs.writeFileSync(tmpFile, buf);
    let note = "";
    if (process.platform === "win32") {
      const ps = "Expand-Archive -Path '" + tmpFile.replace(/'/g, "''") + "' -DestinationPath '" + destDir.replace(/'/g, "''") + "' -Force";
      const r = await spawnRaw(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], { timeoutMs: 180000 });
      if (!r.ok) return "Не удалось распаковать: " + ((r.err || r.out || "").trim() || "код " + r.code);
    } else if (isZip) {
      const r = await spawnRaw(["unzip", "-q", "-o", tmpFile, "-d", destDir], { timeoutMs: 180000 });
      if (!r.ok) return "Не удалось распаковать (нужен unzip): " + ((r.err || r.out || "").trim() || "код " + r.code) + "\nВарианты: установи unzip (installSystemPackage) или скачай tar-архив (.tar.gz).";
    } else {
      const flag = /\.(tar\.gz|tgz)$/.test(pathLow) ? "-xzf" : "-xf";
      const r = await spawnRaw(["tar", flag, tmpFile, "-C", destDir], { timeoutMs: 180000 });
      if (!r.ok) return "Не удалось распаковать: " + ((r.err || r.out || "").trim() || "код " + r.code);
    }
    const names = [];
    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const en of entries) {
        const full = path.join(d, en.name);
        if (en.isDirectory()) walk(full);
        else names.push(path.relative(destDir, full).split(path.sep).join("/"));
      }
    };
    walk(destDir);
    return "OK — скачано и распаковано в " + destDir + "\nФайлов: " + names.length + (names.length ? "\nПримеры:\n" + names.slice(0, 15).map((n) => "• " + n).join("\n") : "");
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function runAsAdmin(cmd) {
  const command = String(cmd || "").trim();
  if (!command) return "Ошибка: укажи команду для запуска с правами администратора.";
  if (process.platform === "win32") {
    const tmp = path.join(os.tmpdir(), "ai-agent-elev-" + Date.now().toString(36) + ".cmd");
    fs.writeFileSync(tmp, "@echo off\r\n" + command + "\r\n", "utf8");
    try {
      const ps = "Start-Process -FilePath $env:ComSpec -ArgumentList '/d','/c','" + tmp + "' -Verb RunAs -Wait";
      const enc = Buffer.from(ps, "utf16le").toString("base64");
      const r = await spawnRaw(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", enc], { timeoutMs: 600000 });
      return (r.ok
        ? "OK — команда запущена с правами администратора (UAC подтверждён)."
        : "Не удалось запустить с правами администратора: " + ((r.err || "").trim() || "код " + r.code) + " — возможно, запрос UAC отклонён.") +
        "\nВывод администрируемого окна приложение не перехватывает. После установки: refreshEnv() → checkInstalledProgram(имя).";
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
  if (process.platform === "darwin") {
    const esc = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
    const r = await spawnRaw(["osascript", "-e", 'do shell script "' + esc + '" with administrator privileges'], { timeoutMs: 600000 });
    return (r.ok ? "OK — команда выполнена с правами администратора." : "Не удалось: " + ((r.err || "").trim() || "код " + r.code)) + "\nВывод: " + ((r.out || r.err || "(пусто)").trim() || "(пусто)").slice(0, 2000);
  }
  const pkexec = findProgram("pkexec");
  if (pkexec.found) {
    const r = await spawnRaw(["pkexec", "/bin/sh", "-c", command], { timeoutMs: 600000 });
    return (r.ok ? "OK — команда выполнена с правами администратора." : "Не удалось / отклонено: " + ((r.err || "").trim() || "код " + r.code)) + "\nВывод: " + ((r.out || r.err || "(пусто)").trim() || "(пусто)").slice(0, 2000);
  }
  return "На Linux нужен pkexec (policykit) или sudo с паролем. Установи pkexec либо выполни команду вручную в терминале с sudo.";
}

async function executeTool(name, args, settings) {
  args = args || {};
  try {
    switch (name) {
      case "createFolder": {
        const p = resolvePath(args.path, settings);
        fs.mkdirSync(p, { recursive: true });
        return "OK — папка создана: " + p;
      }
      case "readFile": {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const st = fs.statSync(p);
        if (st.size > 5 * 1024 * 1024) return "Ошибка: файл слишком большой (" + st.size + " байт). Используй fileOutline для структуры и readFileLines для чтения по частям.";
        let content = fs.readFileSync(p, "utf8");
        const lines = content.split("\n");
        // Большой файл — краткий обзор вместо выгрузки целиком (экономия токенов)
        if (lines.length > 800) {
          const head = numberedLines(lines, 1, Math.min(60, lines.length), lines.length);
          const tail = numberedLines(lines, Math.max(1, lines.length - 14), lines.length, lines.length);
          const outline = buildFileOutline(content, null, 200);
          return (
            "Файл большой: " + lines.length + " строк, " + st.size + " байт (" + langFromExt(p) + ").\n" +
            "Не читай его целиком: используй fileOutline (структура), searchFile (поиск с context) и readFileLines (диапазон).\n\n" +
            "─ СТРУКТУРА (первые " + outline.entries.length + " определений):\n" + outline.text + "\n\n" +
            "─ НАЧАЛО ФАЙЛА:\n" + head + "\n\n" +
            "─ КОНЕЦ ФАЙЛА:\n" + tail
          );
        }
        return "Содержимое " + p + " (" + lines.length + " строк):\n" + content;
      }
      case "readFileLines": {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const st = fs.statSync(p);
        if (!st.isFile()) return "Ошибка: это не файл";
        const all = fs.readFileSync(p, "utf8").split("\n");
        const start = Math.max(1, parseInt(args.start, 10) || 1);
        const count = Math.min(500, Math.max(1, parseInt(args.count, 10) || 100));
        const from = start - 1;
        const chunk = all.slice(from, from + count);
        if (!chunk.length) return "Файл закончился раньше строки " + start + ". Всего строк: " + all.length;
        const numbered = chunk.map((line, i) => {
          const n = start + i;
          return String(n).padStart(String(all.length).length, " ") + " | " + line;
        });
        return "Строки " + start + "–" + (start + chunk.length - 1) + " из " + all.length + " файла " + p + ":\n" + numbered.join("\n");
      }
      case "editFile": {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const newText = String(args.newText ?? "");
        const content = fs.readFileSync(p, "utf8");
        // Режим 2: замена диапазона строк по номерам (startLine..endLine) — для больших файлов
        const startLine = parseInt(args.startLine, 10);
        if (Number.isInteger(startLine) && startLine >= 1) {
          const endLine = Number.isInteger(parseInt(args.endLine, 10)) ? Math.max(startLine, parseInt(args.endLine, 10)) : startLine;
          const all = content.split("\n");
          if (startLine > all.length) return "Ошибка: startLine=" + startLine + " больше числа строк файла (" + all.length + ").";
          if (endLine > all.length) return "Ошибка: endLine=" + endLine + " больше числа строк файла (" + all.length + ").";
          snapshotFileForUndo(p);
          const before = all.slice(0, startLine - 1);
          const after = all.slice(endLine); // endLine включительно — берём всё после неё
          const updated = before.concat(newText === "" ? [] : newText.split("\n"), after).join("\n");
          fs.writeFileSync(p, updated, "utf8");
          const replaced = endLine === startLine ? "строку " + startLine : "строки " + startLine + "–" + endLine;
          return "OK — заменены " + replaced + " (" + (endLine - startLine + 1) + " стр." + (endLine === startLine ? "а" : "") + " → " + newText.split("\n").length + " стр.) в " + p;
        }
        const oldText = String(args.oldText ?? "");
        if (!oldText) return "Ошибка: укажи oldText (режим точной замены) или startLine (режим замены строк по номерам).";
        const lineOf = (idx) => content.slice(0, idx).split("\n").length;
        const positions = [];
        let from = 0;
        while (from <= content.length - oldText.length) {
          const idx = content.indexOf(oldText, from);
          if (idx === -1) break;
          positions.push(idx);
          from = idx + oldText.length;
        }
        if (!positions.length) {
          return "Ошибка: фрагмент для замены не найден в файле. Перечитай файл (readFile / readFileLines) и повтори с точным текстом, включая отступы.";
        }
        const occurrence = parseInt(args.occurrence, 10);
        if (positions.length > 1 && !args.replaceAll && !Number.isInteger(occurrence)) {
          const lines = positions.map(lineOf).join(", ");
          return "Ошибка: фрагмент встречается " + positions.length + " раз (строки: " + lines + "). Уточни контекст в oldText (добавь окружающие строки), укажи occurrence (номер вхождения, например 2) или replaceAll=true.";
        }
        snapshotFileForUndo(p);
        let updated, where;
        if (args.replaceAll) {
          updated = content.split(oldText).join(newText);
          where = "вхождений: " + positions.length;
        } else {
          const idx = Number.isInteger(occurrence) && occurrence >= 1
            ? positions[Math.min(occurrence, positions.length) - 1]
            : positions[0];
          updated = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
          where = "строка " + lineOf(idx) + (positions.length > 1 ? " (вхождение " + (positions.indexOf(idx) + 1) + " из " + positions.length + ")" : "");
        }
        fs.writeFileSync(p, updated, "utf8");
        return "OK — заменено (" + where + ") в " + p;
      }
      case "runCommand": {
        const cmd = String(args.command || "").trim();
        if (!cmd) return "Ошибка: укажи команду";
        const cwd = agentWorkDir(settings);
        const timeoutMs = Math.min(parseInt(args.timeoutMs, 10) || 120000, 300000);
        termAgentEcho("$ " + cmd + "   (каталог: " + cwd + ")");
        const out = await runTerminalCommand(cmd, cwd, timeoutMs);
        termAgentEcho(out);
        let out2 = out;
        if (out.includes("кодом таймаут") && SERVER_CMD_RE.test(cmd)) {
          out2 +=
            "\n\n⏱ Команда не завершилась за " + timeoutMs + " мс — похоже, это длительный dev-сервер (он не завершается сам). Правильно: startBackground(\"" +
            cmd.slice(0, 80) +
            "\") — вернёт id БЕЗ блокировки; затем checkUrl/checkPort для проверки готовности, backgroundOutput(id) для логов, stopBackground(id) для остановки (освободит порт). НЕ жди завершения сервера через runCommand.";
        }
        return truncateText("$ " + cmd + "\n(каталог: " + cwd + ")\n\n" + out2, 9000);
      }
      case "startBackground": {
        const cmd = String(args.command || "").trim();
        if (!cmd) return "Ошибка: укажи command";
        const cwd = args.cwd ? resolvePath(args.cwd, settings) : agentWorkDir(settings);
        const rec = bgSpawn(cmd, { name: args.name, cwd });
        termAgentEcho("$ " + cmd + "   (фоновый процесс " + rec.id + ", каталог: " + cwd + ")");
        return "OK — фоновый процесс запущен:\nid: " + rec.id + "\nкоманда: " + cmd + "\nPID: " + rec.child.pid + "\n\nДальше: backgroundOutput(id) — логи, sendInput(id, текст) — ввод в процесс, stopBackground(id) — остановить, checkUrl/checkPort — проверить готовность сервера.";
      }
      case "listBackground": {
        if (!bgProcesses.size) return "Фоновых процессов нет.";
        const rows = [];
        for (const rec of bgProcesses.values()) {
          const alive = !rec.exited;
          const pid = rec.child && rec.child.pid ? rec.child.pid : "—";
          const secs = Math.round((Date.now() - rec.startedAt) / 1000);
          const tail = bgTail(rec, 3).trim().slice(0, 140);
          rows.push(
            "• " + rec.id + " [" + (alive ? "работает" : "завершён, код " + rec.exitCode) + ", PID " + pid + ", " + secs + " c] " + rec.name +
              (tail ? "\n    → " + tail : "")
          );
        }
        return "Фоновые процессы (" + bgProcesses.size + "):\n" + rows.join("\n");
      }
      case "backgroundOutput": {
        const rec = bgProcesses.get(String(args.id || ""));
        if (!rec) return "Ошибка: процесс с id «" + args.id + "» не найден. Смотри listBackground.";
        const status = rec.exited ? "ЗАВЕРШЁН (код " + rec.exitCode + ")" : "РАБОТАЕТ (PID " + (rec.child && rec.child.pid) + ")";
        return "Фоновый процесс " + rec.id + " — " + status + "\nКоманда: " + rec.command + "\n\n" + (bgTail(rec, args.lines) || "(вывода пока нет)");
      }
      case "sendInput": {
        const rec = bgProcesses.get(String(args.id || ""));
        if (!rec) return "Ошибка: процесс с id «" + args.id + "» не найден. Смотри listBackground.";
        if (rec.exited || !rec.child.stdin || !rec.child.stdin.writable) return "Ошибка: процесс завершён или его stdin закрыт.";
        const input = String(args.input ?? "");
        try {
          rec.child.stdin.write(input + "\n");
        } catch (e) {
          return "Ошибка записи в процесс: " + e.message;
        }
        return "OK — отправлено в процесс " + rec.id + ": " + input;
      }
      case "stopBackground": {
        const rec = bgProcesses.get(String(args.id || ""));
        if (!rec) return "Ошибка: процесс с id «" + args.id + "» не найден. Смотри listBackground.";
        bgKill(rec);
        return "OK — процесс " + rec.id + " остановлен.";
      }
      case "shellStart": {
        const isWin = process.platform === "win32";
        const rec = bgSpawn("", {
          shell: isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
          shellArgs: isWin ? ["/Q"] : [],
          name: args.name || "shell",
          cwd: agentWorkDir(settings),
        });
        return "OK — постоянная shell-сессия запущена:\nid: " + rec.id + "\nPID: " + rec.child.pid + "\n\nОтправляй команды через shellSend(id, команда), смотри вывод через backgroundOutput(id), останови через stopBackground(id). Состояние (переменные, текущая папка) сохраняется между командами.";
      }
      case "shellSend": {
        const rec = bgProcesses.get(String(args.id || ""));
        if (!rec) return "Ошибка: shell-сессия с id «" + args.id + "» не найдена. Запусти её через shellStart.";
        if (rec.exited) return "Ошибка: shell-сессия завершена.";
        const cmd = String(args.command || "").trim();
        if (!cmd) return "Ошибка: укажи command";
        termAgentEcho("$ " + cmd + "   (shell-сессия " + rec.id + ")");
        const from = rec.output.length;
        try {
          rec.child.stdin.write(cmd + "\n");
        } catch (e) {
          return "Ошибка записи в shell: " + e.message;
        }
        await waitOutputQuiet(rec, 8000);
        const out = rec.output.slice(from).join("\n").trim();
        termAgentEcho(out);
        return "$ " + cmd + "\n" + (out || "(нет вывода)");
      }
      case "checkUrl": {
        const url = String(args.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return "Ошибка: укажи полный URL, начинающийся с http:// или https:// (например http://localhost:3000)";
        return await checkUrlStatus(url);
      }
      case "openUrl": {
        const url = String(args.url || "").trim();
        if (!/^(https?|file):\/\//i.test(url)) return "Ошибка: укажи полный URL";
        shell.openExternal(url).catch(() => {});
        return "OK — открыто в браузере: " + url;
      }
      case "showImage": {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const ext = path.extname(p).toLowerCase();
        const IMG_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif"];
        if (!IMG_EXTS.includes(ext)) return "Ошибка: это не изображение (" + (ext || "без расширения") + "). Поддерживаются: " + IMG_EXTS.join(", ");
        const st = fs.statSync(p);
        if (st.size > 8 * 1024 * 1024) return "Ошибка: файл слишком большой (" + st.size + " байт). Максимум 8 МБ.";
        const dataUrl = "data:image/" + (ext === ".svg" ? "svg+xml" : ext.slice(1)) + ";base64," + fs.readFileSync(p).toString("base64");
        if (activeEmit) activeEmit({ type: "image", path: p, dataUrl });
        return "OK — изображение показано пользователю: " + p + " (" + st.size + " байт)";
      }
      case "analyzeImage": {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const ext = path.extname(p).toLowerCase();
        const IMG_EXTS_AN = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif"];
        if (!IMG_EXTS_AN.includes(ext)) return "Ошибка: это не изображение (" + (ext || "без расширения") + "). Поддерживаются: " + IMG_EXTS_AN.join(", ");
        const st = fs.statSync(p);
        if (st.size > 8 * 1024 * 1024) return "Ошибка: файл слишком большой (" + st.size + " байт). Максимум 8 МБ.";
        const dataUrl = "data:image/" + (ext === ".svg" ? "svg+xml" : ext.slice(1)) + ";base64," + fs.readFileSync(p).toString("base64");
        if (activeEmit) activeEmit({ type: "image", path: p, dataUrl });
        const cfg = auxConfig(settings);
        if (!cfg.enabled) return "Ошибка: вспомогательная модель выключена. Включи «🖼 Зрение и генерация» в Настройках.";
        if (!cfg.visionModel) return "Ошибка: не указана модель для чтения изображений (поле «Модель-зрение» в Настройках).";
        const question = args.question || "Опиши подробно, что изображено на картинке: объекты, текст, UI, цвета, расположение. Это описание пойдёт программисту.";
        try {
          const desc = await describeImageRemote(cfg, dataUrl, question, cfg.visionModel);
          return "Описание изображения (" + p + "):\n" + (desc || "(пусто)") + "\n\nЕсли пользователь ждёт правок по этой картинке — вноси изменения и сообщи итог.";
        } catch (e) {
          return "Ошибка анализа изображения: " + ((e && e.message) || e) + ". Проверь ключ и модель-зрение в Настройках → «🖼 Зрение и генерация».";
        }
      }
      case "generateImage": {
        const prompt = String(args.prompt || "").trim();
        if (!prompt) return "Ошибка: укажи prompt — текстовое описание картинки.";
        const cfg = auxConfig(settings);
        if (!cfg.enabled) return "Ошибка: вспомогательная модель выключена. Включи «🖼 Зрение и генерация» в Настройках.";
        if (!cfg.imageModel) return "Ошибка: не указана модель для генерации картинок (поле «Модель-генерация» в Настройках).";
        let name = String(args.filename || "").trim();
        if (!name) name = "generated-" + Date.now() + ".png";
        name = path.basename(name).replace(/[^\w.\-]+/g, "_");
        const extG = path.extname(name).toLowerCase();
        if (![".png", ".jpg", ".jpeg", ".webp"].includes(extG)) name += ".png";
        const out = path.join(agentWorkDir(settings), name);
        try {
          const { buf, mediaType } = await generateImageRemote(cfg, prompt, cfg.imageModel, { aspectRatio: args.aspect_ratio });
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, buf);
          const dataUrl = "data:" + mediaType + ";base64," + buf.toString("base64");
          if (activeEmit) activeEmit({ type: "image", path: out, dataUrl });
          return "OK — изображение сгенерировано и сохранено: " + out + " (" + buf.length + " байт, " + mediaType + "). Превью уже показано пользователю. Встраивай файл в проект (относительный путь: " + name + ")."
        } catch (e) {
          return "Ошибка генерации изображения: " + ((e && e.message) || e) + ". Проверь ключ и модель-генерацию в Настройках → «🖼 Зрение и генерация».";
        }
      }
      case "checkPort": {
        const port = parseInt(args.port, 10);
        if (!port || port < 1 || port > 65535) return "Ошибка: укажи корректный порт (1–65535)";
        return await new Promise((resolve) => {
          const sock = net.connect({ port, host: "127.0.0.1" });
          sock.setTimeout(2000);
          sock.once("connect", () => { sock.destroy(); resolve("Порт " + port + " занят — на нём что-то слушает."); });
          sock.once("timeout", () => { sock.destroy(); resolve("Порт " + port + " свободен."); });
          sock.once("error", () => { sock.destroy(); resolve("Порт " + port + " свободен (соединение отклонено)."); });
        });
      }
      case "listPorts": {
        const cmd = process.platform === "win32"
          ? "netstat -ano -p tcp"
          : "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null";
        const out = await runTerminalCommand(cmd, os.homedir(), 15000);
        const lines = String(out)
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /LISTEN|LISTENING/i.test(l))
          .slice(0, 40);
        return "Слушающие порты:\n" + (lines.join("\n") || "не удалось получить список портов:\n" + String(out).slice(0, 1000));
      }
      case "dockerBuild": {
        const dir = args.directory ? resolvePath(args.directory, settings) : agentWorkDir(settings);
        if (!fs.existsSync(dir)) return "Ошибка: папка не найдена: " + dir;
        const tag = String(args.tag || "").trim();
        const cmd = "docker build" + (tag ? " -t " + tag : "") + " .";
        const out = await runTerminalCommand(cmd, dir, 300000);
        return truncateText(out, 6000);
      }
      case "dockerRun": {
        const image = String(args.image || "").trim();
        if (!image) return "Ошибка: укажи image";
        const extra = String(args.args || "").trim();
        const detached = args.detached !== false;
        const cmd = "docker run " + (detached ? "-d " : "") + (extra ? extra + " " : "") + image;
        const out = await runTerminalCommand(cmd, agentWorkDir(settings), 120000);
        return truncateText(out, 4000);
      }
      case "dockerExec": {
        const container = String(args.container || "").trim();
        const command = String(args.command || "").trim();
        if (!container || !command) return "Ошибка: укажи container и command";
        const out = await runTerminalCommand("docker exec " + container + " " + command, agentWorkDir(settings), 60000);
        return truncateText(out, 4000);
      }
      case "installPackage": {
        const pkg = String(args.packageName || "").trim();
        if (!pkg) return "Ошибка: укажи packageName (например «express» или «react@18.3.1»)";
        const cwd = agentWorkDir(settings);
        const pm = detectPackageManager(cwd);
        const dev = !!args.dev;
        const cmd = pm.bin + " " + pm.add + (dev ? " " + pm.flagDev : "") + " " + pkg;
        const out = await runTerminalCommand(cmd, cwd, 300000);
        return truncateText("$ " + cmd + "\n(менеджер пакетов: " + pm.name + ", каталог: " + cwd + ")\n\n" + out, 6000);
      }
      case "lintProject": {
        const cwd = agentWorkDir(settings);
        const parts = [];
        const has = (name) => fs.existsSync(path.join(cwd, name));
        if (has("tsconfig.json")) {
          parts.push("$ npx -y tsc --noEmit\n" + (await runTerminalCommand("npx -y tsc --noEmit", cwd, 300000)));
        }
        if (has("eslint.config.js") || has("eslint.config.mjs") || has("eslint.config.cjs") || has(".eslintrc") || has(".eslintrc.json") || has(".eslintrc.js")) {
          parts.push("$ npx -y eslint .\n" + (await runTerminalCommand("npx -y eslint .", cwd, 300000)));
        }
        if (!parts.length) {
          return "Не нашёл конфигов проверки в " + cwd + " (tsconfig.json или eslint.config.* / .eslintrc). Можно запустить проверку вручную через runCommand.";
        }
        return truncateText(parts.join("\n\n"), 9000);
      }
      case "runTests": {
        const cwd = agentWorkDir(settings);
        const timeoutMs = Math.min(parseInt(args.timeoutMs, 10) || 180000, 600000);
        let cmd = null;
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
          if (pkg.scripts && pkg.scripts.test) cmd = "npm test";
        } catch {}
        if (!cmd) {
          cmd = hasLock("bun") ? "bun test" : "npm test";
        }
        const out = await runTerminalCommand(cmd, cwd, timeoutMs);
        const summary = summarizeTestOutput(out);
        return truncateText("$ " + cmd + " (каталог: " + cwd + ")\n\n" + out + (summary ? "\n\n--- Итог ---\n" + summary : ""), 9000);
      }
      case "diffView": {
        const p1 = resolvePath(args.path1, settings);
        const p2 = resolvePath(args.path2, settings);
        if (!fs.existsSync(p1)) return "Ошибка: не найден путь: " + p1;
        if (!fs.existsSync(p2)) return "Ошибка: не найден путь: " + p2;
        const r = await unifiedDiff(p1, p2);
        if (!r.patch) return "Файлы идентичны: " + p1 + " = " + p2;
        if (activeEmit) activeEmit({ type: "diff", a: p1, b: p2, patch: r.patch });
        return "Дифф " + p1 + " ↔ " + p2 + " (открыт в просмотрщике приложения):\n\n" + truncateText(r.patch, 8000);
      }
      case "previewUI": {
        const url = String(args.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return "Ошибка: укажи полный URL вида http://localhost:3000";
        if (activeEmit) activeEmit({ type: "preview", url });
        return "OK — открыт встроенный предпросмотр: " + url + " (закрывается кнопкой ✕ в углу окна предпросмотра)";
      }
      case "screenshotCapture": {
        const url = String(args.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return "Ошибка: укажи полный URL вида http://localhost:3000";
        const shot = await screenshotUrl(url);
        if (!shot.ok) return "Ошибка скриншота: " + shot.err;
        if (activeEmit) activeEmit({ type: "image", path: url, dataUrl: shot.dataUrl });
        return "OK — скриншот " + url + " снят (1280×800) и показан пользователю во встроенном просмотрщике.";
      }
      case "envSet": {
        const key = String(args.key || "").trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return "Ошибка: имя переменной должно быть вида DATABASE_URL (латиница, цифры, подчёркивание)";
        }
        const value = String(args.value ?? "");
        agentEnv[key] = value;
        const s = loadSettings();
        s.agentEnv = { ...agentEnv };
        saveSettings(s);
        return "OK — переменная " + key + " задана. Она доступна во всех следующих командах (runCommand, startBackground, shell, git, docker). Значение в чат не выводится.";
      }
      case "envList": {
        const keys = Object.keys(agentEnv);
        if (!keys.length) return "Переменные окружения агента не заданы. Задай через envSet(key, value).";
        return "Заданные переменные (" + keys.length + "):\n" +
          keys.map((k) => {
            const v = String(agentEnv[k] || "");
            return "• " + k + " — установлена (" + v.length + " симв.)";
          }).join("\n") +
          "\n\nЗначения скрыты — они подмешиваются в команды автоматически.";
      }
      case "envUnset": {
        const key = String(args.key || "").trim();
        if (!key || !(key in agentEnv)) return "Переменная «" + key + "» не задана.";
        delete agentEnv[key];
        const s = loadSettings();
        s.agentEnv = { ...agentEnv };
        saveSettings(s);
        return "OK — переменная " + key + " удалена.";
      }
      case "writeFile": {
        if (!args.path) return "Ошибка: укажи path";
        const p = resolvePath(args.path, settings);
        const content = String(args.content ?? "");
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const existed = fs.existsSync(p);
        fs.writeFileSync(p, content, "utf8");
        const lines = content ? content.split("\n").length : 0;
        const sizeNote = content ? ", " + content.length + " символов" : "";
        return "OK — файл " + (existed ? "перезаписан" : "создан") + ": " + p + " (" + lines + " строк" + sizeNote + ")";
      }
      case "webSearch": {
        const q = String(args.query || args.q || "").trim();
        return await webSearchDDG(q);
      }
      case "webFetch": {
        return await webFetchPage(args.url);
      }
      case "searchFile": {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const st = fs.statSync(p);
        if (!st.isFile()) return "Ошибка: это не файл";
        const pattern = String(args.pattern || args.regex || "").trim();
        if (!pattern) return "Ошибка: укажи pattern (строку или регулярное выражение)";
        const maxResults = Math.min(parseInt(args.maxResults, 10) || 40, 100);
        const context = Math.min(Math.max(parseInt(args.context, 10) || 0, 0), 40);
        const blocks = args.blocks === true || args.blocks === "true" || args.blocks === "1" || args.blocks === 1;
        let re = null;
        try {
          re = new RegExp(pattern, args.caseSensitive ? "" : "i");
        } catch {}
        const all = fs.readFileSync(p, "utf8").split("\n");
        const hits = [];
        let total = 0;
        for (let i = 0; i < all.length; i++) {
          const line = all[i];
          if (re ? re.test(line) : line.includes(pattern)) {
            total++;
            if (hits.length < maxResults) hits.push({ n: i + 1, text: line.trim().slice(0, 300) });
          }
        }
        if (!total) return "Совпадений по «" + pattern + "» в " + p + " нет.";
        const pad = String(all.length).length;
        let shown;
        if (blocks) {
          // Режим «блоками»: вместо отдельных строк показываем целиком enclosing-определения
          // (функции/классы/методы и т.п. по OUTLINE_RULES) с диапазоном строк.
          const ranges = buildBlockRanges(all);
          const byBlock = new Map();
          for (const h of hits) {
            let owner = null;
            for (const r of ranges) {
              if (r.start > h.n) break;
              if (h.n <= r.end) owner = r; // последний подходящий = самый вложенный
            }
            if (!owner) owner = { start: h.n, end: h.n, kind: "строка", name: "строка " + h.n };
            const key = owner.start + "|" + owner.name;
            if (!byBlock.has(key)) byBlock.set(key, { owner, hits: [] });
            byBlock.get(key).hits.push(h);
          }
          const MAX_BLOCK_LINES = 120;
          const blockCap = Math.min(maxResults, 20); // блоки крупнее строк — лимит строже
          const lines = [];
          let blocksShown = 0;
          for (const { owner, hits: hh } of byBlock.values()) {
            if (blocksShown >= blockCap) break;
            blocksShown++;
            const from = owner.start;
            const to = Math.min(owner.end, from + MAX_BLOCK_LINES - 1);
            const hitSet = new Set(hh.map((x) => x.n));
            lines.push("── " + owner.kind + " " + owner.name + " (строки " + owner.start + "–" + to + (to < owner.end ? "+" : "") + ") ──");
            for (let i = from; i <= to; i++) {
              lines.push((hitSet.has(i) ? ">" : " ") + String(i).padStart(pad, " ") + " | " + all[i - 1].slice(0, 300));
            }
            if (to < owner.end) lines.push("        … (блок обрезан: ещё " + (owner.end - to) + " строк)");
          }
          const more = total > hits.length ? "\n… и ещё " + (total - hits.length) + " совпадений (укажи maxResults больше)" : "";
          return "Совпадения «" + pattern + "» в " + p + " — всего " + total + ", показано блоков: " + blocksShown + " (blocks: true):\n" + truncateText(lines.join("\n"), 9000) + more;
        }
        if (context > 0) {
          // Окна вокруг совпадений: строки context до и после, с отметкой > для самой строки
          shown = [];
          let prevEnd = 0;
          for (const h of hits) {
            const from = Math.max(1, h.n - context);
            const to = Math.min(all.length, h.n + context);
            if (from > prevEnd + 1) shown.push("        … (пропущено)");
            for (let i = from; i <= to; i++) {
              const mark = i === h.n ? ">" : " ";
              shown.push(mark + String(i).padStart(pad, " ") + " | " + all[i - 1].slice(0, 300));
            }
            prevEnd = to;
          }
          const more = total > hits.length ? "\n… и ещё " + (total - hits.length) + " совпадений (укажи maxResults больше)" : "";
          return "Совпадения «" + pattern + "» в " + p + " — всего " + total + ", показано " + hits.length + " (контекст ±" + context + " строк):\n" + shown.join("\n") + more;
        }
        shown = hits.map((h) => String(h.n).padStart(pad, " ") + " | " + h.text);
        const more = total > hits.length ? "\n… и ещё " + (total - hits.length) + " совпадений (укажи maxResults больше)" : "";
        return "Совпадения «" + pattern + "» в " + p + " — всего " + total + ", показано " + hits.length + ":\n" + shown.join("\n") + more;
      }
      case "fileOutline": {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const st = fs.statSync(p);
        if (!st.isFile()) return "Ошибка: это не файл";
        const content = fs.readFileSync(p, "utf8");
        const filter = String(args.pattern || "").trim();
        const res = buildFileOutline(content, filter || null, 300);
        if (!res.entries.length) {
          return filter
            ? "В структуре " + p + " нет определений, совпадающих с «" + filter + "»."
            : "Определений (функции/классы/заголовки) в " + p + " не найдено. Файл: " + content.split("\n").length + " строк, " + st.size + " байт.";
        }
        return "Структура " + p + " (" + content.split("\n").length + " строк) — " + res.entries.length + " определений" + (filter ? " по фильтру «" + filter + "»" : "") + ":\n" + res.text;
      }
      case "listFiles": {
        return listProjectFiles(settings, args.path);
      }
      case "searchProject": {
        const pattern = String(args.pattern || args.regex || args.query || "").trim();
        if (!pattern) return "Ошибка: укажи pattern (строку или регулярное выражение)";
        return searchProjectFiles(pattern, settings, args.path);
      }
      case "askUser": {
        return "Ошибка: askUser обрабатывается отдельно — дождись ответа пользователя.";
      }
      case "listDirectory": {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: папка не найдена: " + p;
        const entries = fs.readdirSync(p, { withFileTypes: true });
        const lines = entries.map((e) => (e.isDirectory() ? "[папка] " : "[файл]  ") + e.name);
        return "Содержимое " + p + " (" + entries.length + "):\n" + lines.slice(0, 500).join("\n");
      }
      case "gitClone": {
        const url = String(args.url || "").trim();
        if (!url) return "Ошибка: укажи url репозитория";
        const base = settings.workingDir || os.homedir();
        const dir = args.directory
          ? resolvePath(args.directory, settings)
          : path.join(base, repoNameFromUrl(url));
        const r = await runGit(base, ["clone", url, dir], settings);
        if (r.ok) {
          if (stripUrlCreds(url) !== url) {
            await runGit(dir, ["remote", "set-url", "origin", stripUrlCreds(url)], settings);
          }
          lastAgentRepoDir = dir; // все следующие git/команды — внутри склонированного репозитория
          clonedRepoPending = true; // следующий ответ агента начнётся с анализа нового проекта
          return "OK — репозиторий клонирован: " + dir + "\nТеперь git-команды и терминал работают внутри этого репозитория.";
        }
        return "Ошибка git: " + r.err;
      }
      case "gitStatus": {
        const r = await runGit(agentWorkDir(settings), ["status"], settings);
        return r.ok ? (r.out || "Готово (без вывода).") : "Ошибка git: " + r.err;
      }
      case "gitCommit": {
        if (!args.message) return "Ошибка: укажи message для коммита";
        const cwd = agentWorkDir(settings);
        const add = await runGit(cwd, ["add", "-A"], settings);
        if (!add.ok) return "Ошибка git add: " + add.err;
        const commit = await runGit(
          cwd,
          ["-c", "user.name=AI Agent", "-c", "user.email=ai-agent@local", "commit", "-m", String(args.message)],
          settings
        );
        return "git add -A:\n" + add.out + "\n\ngit commit:\n" + (commit.ok ? commit.out : "Ошибка git: " + commit.err);
      }
      case "gitPush": {
        if (!settings.allowAgentPush) {
          return (
            "⛔ git push заблокирован: пользователь не разрешил агенту отправлять коммиты на GitHub.\n" +
            "Как разрешить (на выбор пользователя):\n" +
            "1. Настройки → GitHub → включить «Разрешить агенту git push» — после этого инструмент заработает;\n" +
            "2. либо пользователь сам нажимает «Push» во вкладке «Изменения» панели проекта.\n" +
            "Сообщи пользователю, что пуш не выполнен и почему — не пытайся обойти блокировку через runCommand."
          );
        }
        const r = await runGit(agentWorkDir(settings), ["push"], settings);
        return r.ok ? (r.out || "Готово (без вывода).") : "Ошибка git: " + r.err;
      }
      case "gitPublish": {
        // Создание репозитория + push — та же политика безопасности, что и у gitPush.
        if (!settings.allowAgentPush) {
          return (
            "⛔ gitPublish заблокирован: создание репозитория и отправка кода на GitHub запрещены, пока пользователь не разрешит.\n" +
            "Как разрешить (на выбор пользователя):\n" +
            "1. Настройки → GitHub → включить «Разрешить агенту git push»;\n" +
            "2. либо пользователь сам нажимает «⬆ Опубликовать на GitHub» в панели проекта.\n" +
            "Сообщи пользователю, что публикация не выполнена и почему — не пытайся обойти блокировку через runCommand."
          );
        }
        const cwdP = args.directory ? resolvePath(args.directory, settings) : agentWorkDir(settings);
        const resP = await publishLocalToGithub(cwdP, settings, {
          name: args.name,
          description: args.description,
          private: args.private !== false,
          message: args.message,
        });
        return resP.ok
          ? "✅ " + resP.message
          : "Ошибка публикации: " + resP.error;
      }
      case "gitPull": {
        const r = await runGit(agentWorkDir(settings), ["pull"], settings);
        return r.ok ? (r.out || "Готово (без вывода).") : "Ошибка git: " + r.err;
      }
      case "gitLog": {
        const r = await runGit(agentWorkDir(settings), ["log", "--oneline", "-n", "30", "--decorate"], settings);
        return r.ok ? (r.out || "Коммитов пока нет.") : "Ошибка git: " + r.err;
      }
      case "gitRevert": {
        if (!args.commit) return "Ошибка: укажи commit (хэш, например HEAD~1)";
        const r = await runGit(agentWorkDir(settings), ["revert", "--no-edit", String(args.commit)], settings);
        return r.ok ? "OK — коммит отменён:\n" + (r.out || "") : "Ошибка git: " + r.err;
      }
      case "readFileStructure": {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        if (!fs.statSync(p).isFile()) return "Ошибка: это не файл, а папка — укажи путь к файлу";
        const r = buildFileStructure(p, args.pattern);
        if (r.error) return "Ошибка: " + r.error;
        if (!r.rows.length) return "В файле не найдено импортов/экспортов/объявлений" + (args.pattern ? " по фильтру «" + args.pattern + "»" : "") + ": " + p;
        const pad = String(r.totalLines).length;
        const text = r.rows.map((x) => String(x.line).padStart(pad, " ") + " | " + x.kind.padEnd(6, " ") + " | " + x.text).join("\n");
        return "Структура " + p + " (" + r.totalLines + " строк, показано " + r.rows.length + "):\n" + truncateText(text, 9000) + "\n\nФрагмент читай через readFileLines(path, start, count).";
      }
      case "explainCode": {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        if (!fs.statSync(p).isFile()) return "Ошибка: это не файл, а папка — укажи путь к файлу";
        const st = fs.statSync(p);
        if (st.size > 5 * 1024 * 1024) return "Ошибка: файл слишком большой (" + st.size + " байт). Смотри структуру через fileOutline, фрагменты — readFileLines.";
        const all = fs.readFileSync(p, "utf8").split("\n");
        const total = all.length;
        const blocks = buildBlockRanges(all);
        const pad = String(total).length;
        const capWindow = 220; // максимум строк в одном окне
        const focus = { how: "весь файл (по умолчанию — начало)", start: 1, end: Math.min(total, 120) };
        if (args.symbol) {
          const sym = String(args.symbol).trim();
          const hits = blocks.filter((b) => sym && b.name && b.name.toLowerCase().includes(sym.toLowerCase()));
          if (!hits.length) {
            const outline = buildFileOutline(all.join("\n"), null, 300);
            return "Не нашёл определение по имени «" + sym + "» в " + p + ". Структура файла:\n" + outline.text +
              "\n\nУкажи точное имя (fileOutline / searchFile blocks:true помогут найти) или строку через line.";
          }
          const b = hits[0];
          focus.how = "символ «" + sym + "» → блок «" + b.name + "» (" + b.kind + ", строки " + b.start + "–" + b.end + ")" +
            (hits.length > 1 ? "; есть ещё совпадения на строках " + hits.slice(1).map((x) => x.start).join(", ") : "");
          focus.start = b.start;
          focus.end = b.end;
        } else if (args.line != null || args.start != null) {
          const raw = parseInt(args.line != null ? args.line : args.start, 10);
          const want = Math.max(1, Math.min(raw || 1, total));
          if (args.endLine != null) {
            focus.how = "строки " + want + "–" + Math.max(want, Math.min(parseInt(args.endLine, 10) || want, total));
            focus.start = want;
            focus.end = Math.max(want, Math.min(parseInt(args.endLine, 10) || want, total));
          } else {
            // Без endLine расширяем до границ enclosing-блока (функция/класс/метод по OUTLINE_RULES)
            let enc = null;
            for (const b of blocks) if (b.start <= want) enc = b;
            if (enc) {
              focus.how = "строка " + want + " → внутри блока «" + enc.name + "» (" + enc.kind + ", строки " + enc.start + "–" + enc.end + ")";
              focus.start = enc.start;
              focus.end = enc.end;
            } else {
              focus.how = "строка " + want + " (вне определений — показано ±24 строки)";
              focus.start = want;
              focus.end = Math.min(total, want + 24);
            }
          }
        }
        if (focus.end - focus.start + 1 > capWindow) {
          focus.end = focus.start + capWindow - 1;
          focus.how += " (обрезано до " + capWindow + " строк — сузь диапазон endLine)";
        }
        // Импорты в шапке файла — до первой «рабочей» строки кода
        const imports = [];
        for (let i = 0; i < Math.min(total, 80); i++) {
          const t = all[i].trim();
          if (!t || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#") || t.startsWith("<!--")) continue;
          if (/^(import\b|from\s+["']|require\(|#include|use\s+[A-Za-z_:]+;|package\s+[A-Za-z_])/.test(t)) {
            imports.push(String(i + 1).padStart(pad, " ") + " | " + all[i].trim().slice(0, 110));
            if (imports.length >= 25) break;
          } else if (imports.length) {
            break; // импорты кончились
          }
        }
        const inside = buildFileOutline(all.join("\n"), null, 400).entries.filter((e) => e.line >= focus.start && e.line <= focus.end);
        const win = numberedLines(all, focus.start, focus.end, total);
        const out = [];
        out.push("Файл " + p + " (" + langFromExt(p) + ", " + total + " строк, " + st.size + " байт)");
        out.push("Запрос: " + focus.how);
        if (imports.length) out.push("\nИмпорты/зависимости (шапка файла, " + imports.length + "):\n" + imports.join("\n"));
        out.push("\nКод (строки " + focus.start + "–" + focus.end + "):\n" + win);
        if (inside.length) {
          out.push("\nВ этом окне определено:\n" + inside.map((e) => String(e.line).padStart(pad, " ") + " | " + e.kind.padEnd(8, " ") + " | " + e.name).join("\n"));
        }
        const markers = [];
        for (let i = focus.start - 1; i < focus.end && i < all.length; i++) {
          const t = all[i] || "";
          if (/TODO|FIXME|HACK|XXX/.test(t)) markers.push(String(i + 1).padStart(pad, " ") + " | " + t.trim().slice(0, 100));
        }
        if (markers.length) out.push("\nМаркеры TODO/FIXME в окне:\n" + markers.join("\n"));
        out.push("\nОбъясни пользователю этот код своими словами. Больше контекста: fileOutline (структура), readFileLines (другой диапазон), searchFile с blocks:true, findReferences (где используется).");
        return truncateText(out.join("\n"), 16000);
      }
      case "undoEdit": {
        loadPersistedUndo();
        const p = args.path ? resolvePath(args.path, settings) : null;
        if (!p) {
          if (!lastUndoLog.length && !activeRunUndo.length) return "Нет изменений для отката (undo-журнал пуст).";
          const counts = new Map();
          for (const u of [...activeRunUndo, ...lastUndoLog]) counts.set(u.path, (counts.get(u.path) || 0) + 1);
          return "Можно откатить (по одному — undoEdit(path), шагами — undoEdit(path, steps: N)):\n" +
            [...counts.entries()].map(([f, c]) => "• " + f + (c > 1 ? " — шагов в истории: " + c : "")).join("\n");
        }
        // Снимки файла: сначала свежие из текущего запуска, затем из сохранённого журнала.
        const snaps = [];
        for (let i = activeRunUndo.length - 1; i >= 0; i--) if (activeRunUndo[i].path === p) snaps.push(activeRunUndo[i]);
        for (let i = lastUndoLog.length - 1; i >= 0; i--) if (lastUndoLog[i].path === p) snaps.push(lastUndoLog[i]);
        if (!snaps.length) return "Нет снимка для отката: " + p + " (агент не менял этот файл в последних запусках).";
        const steps = Math.min(Math.max(parseInt(args.steps, 10) || 1, 1), snaps.length);
        const popped = snaps.slice(0, steps); // снимаем steps самых свежих
        const target = popped[popped.length - 1]; // возвращаемся к состоянию до самой ранней из откатываемых правок
        try {
          if (target.content === null) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
          } else {
            fs.writeFileSync(p, target.content, "utf8");
          }
        } catch (e) {
          return "Ошибка отката: " + (e.message || String(e));
        }
        const gone = new Set(popped);
        activeRunUndo = activeRunUndo.filter((u) => !gone.has(u));
        lastUndoLog = lastUndoLog.filter((u) => !gone.has(u));
        persistUndo();
        const how = popped.length === 1 ? "последнюю правку агента" : popped.length + " правки агента";
        return target.content === null
          ? "OK — файл удалён (он был создан агентом): " + p
          : "OK — файл откачен на " + how + " назад: " + p + " (снимков осталось: " + Math.max(0, snaps.length - popped.length) + ")";
      }
      case "refactorRename": {
        const oldName = String(args.oldName || "").trim();
        const newName = String(args.newName || "").trim();
        const dryRun = !!args.dryRun;
        const root = args.path ? resolvePath(args.path, settings) : agentWorkDir(settings);
        if (!fs.existsSync(root)) return "Ошибка: не найден путь: " + root;
        const r = refactorRenameFiles(root, oldName, newName, dryRun);
        if (r.error) return "Ошибка: " + r.error;
        if (!r.changed.length) return "Совпадений «" + oldName + "» не найдено" + (args.path ? " в " + args.path : " по проекту") + ".";
        const head = dryRun
          ? "🔍 dryRun — ничего не изменено. Будет заменено «" + oldName + "» → «" + newName + "» (" + r.total + " вхожд.):"
          : "OK — заменено " + r.total + " вхожд. «" + oldName + "» → «" + newName + "» в " + r.changed.length + " файлах:";
        const lines = r.changed.slice(0, 40).map((c) => "• " + c.rel + " — " + c.count + " вхожд." + (c.sample ? "\n    " + c.sample : ""));
        return truncateText(head + "\n" + lines.join("\n") + (r.changed.length > 40 ? "\n… и ещё " + (r.changed.length - 40) + " файлов" : ""), 9000);
      }
      case "runCommandOutput": {
        const cmd = String(args.command || "").trim();
        if (!cmd) return "Ошибка: укажи команду";
        const cwd = agentWorkDir(settings);
        const waitFor = args.waitFor ? String(args.waitFor) : "";
        const retries = Math.min(Math.max(parseInt(args.retries, 10) || 0, 0), 5);
        const timeoutMs = Math.min(parseInt(args.timeoutMs, 10) || 120000, 600000);
        // Длительный dev-сервер (expo start, npm run dev, vite…): он не завершается сам,
        // поэтому запускаем через bgSpawn — не блокируемся, регистрируем в bgProcesses
        // (агент сможет остановить его через stopBackground и освободить порт) и ждём
        // только маркер готовности, если waitFor задан. Сервер по таймауту НЕ убиваем.
        if (SERVER_CMD_RE.test(cmd)) {
          const rec = bgSpawn(cmd, { name: args.name || cmd.slice(0, 50), cwd });
          termAgentEcho("$ " + cmd + "   (фоновый процесс " + rec.id + ", каталог: " + cwd + ")");
          let head =
            "OK — команда похожа на длительный dev-сервер, запущена в фоне БЕЗ ожидания завершения.\n" +
            "id: " + rec.id + "\nкоманда: " + cmd + "\nPID: " + rec.child.pid + "\n";
          if (waitFor) {
            const r = await bgWaitFor(rec, waitFor, timeoutMs);
            head += r.matched
              ? "✅ в выводе появился маркер «" + waitFor + "» — сервер готов.\n"
              : r.exited
                ? "❌ процесс завершился раньше маркера (код " + r.code + ").\n"
                : "⏱ маркер «" + waitFor + "» не появился за " + timeoutMs + " мс (сервер продолжает работать в фоне).\n";
          } else {
            head += "Дальше: checkUrl/checkPort — проверить готовность, backgroundOutput(id) — логи, stopBackground(id) — остановить (освободит порт).\n";
          }
          const tail = truncateText(bgTail(rec, args.lines) || "(вывода пока нет)", 6000);
          return head + "\n--- вывод ---\n" + tail;
        }
        const log = [];
        let last = null;
        let attempt = 0;
        for (; attempt <= retries; attempt++) {
          if (attempt > 0) {
            await new Promise((r2) => setTimeout(r2, 2000));
            log.push("→ повторная попытка #" + (attempt + 1));
          }
          const res = await spawnCollect(cmd, cwd, timeoutMs, waitFor);
          last = res;
          if (res.matched) {
            log.push("✅ в выводе появился текст «" + waitFor + "» (попытка #" + (attempt + 1) + ")");
            break;
          }
          if (res.ok) {
            log.push("✅ команда завершилась успешно (попытка #" + (attempt + 1) + ")");
            break;
          }
          log.push((res.timedOut ? "⏱ таймаут (" + timeoutMs + " мс)" : "❌ команда упала (код " + res.code + ")") + " — попытка #" + (attempt + 1));
        }
        const tail = truncateText((last && stripAnsi(last.out || "")) || "(без вывода)", 8000);
        return "$ " + cmd + "\n(каталог: " + cwd + ", попыток: " + (attempt + 1) + ")\n\n" + log.join("\n") + "\n\n--- вывод последней попытки ---\n" + tail;
      }
      case "checkInstalledProgram": {
        const prog = String(args.programName || "").trim();
        if (!prog) return "Ошибка: укажи programName (например git).";
        const info = findProgram(prog);
        if (!info.found) {
          return "Установлено: нет\n" + info.reason + "\n\nУстанови через installSystemPackage(\"" + prog + "\"), затем вызови refreshEnv() и повтори проверку.";
        }
        const v = await runProgVersion(info.path);
        return "Установлено: да\nПуть: " + info.path + "\nВерсия: " + (v || "не определилась (нет --version)") + "\n\nТочную проверку из командной строки: canExecute(\"" + prog + "\").";
      }
      case "canExecute": {
        const prog = String(args.programName || args.command || "").trim().split(/\s+/)[0] || "";
        if (!prog) return "Ошибка: укажи programName или command.";
        const builtins = ["cd", "echo", "set", "exit", "cls", "dir", "type", "pwd", "export", "source", "alias", "if", "for", "while", "test", "true", "false"];
        if (builtins.includes(prog.toLowerCase())) {
          return "Можно выполнить: да\n«" + prog + "» — встроенная команда оболочки, отдельная программа не нужна.";
        }
        const info = findProgram(prog);
        if (info.found) return "Можно выполнить: да\nПрограмма: " + prog + "\nПуть: " + info.path;
        return "Можно выполнить: нет — «" + prog + "» не найден в PATH.\nУстанови: installSystemPackage(\"" + prog + "\"), затем refreshEnv().\nТочная проверка: checkInstalledProgram(\"" + prog + "\").";
      }
      case "getSystemInfo": {
        const rows = [];
        const osName = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : process.platform === "linux" ? "Linux" : process.platform;
        rows.push("ОС: " + osName + (process.arch ? " (" + process.arch + ")" : ""));
        rows.push("Версия Node.js (приложение): " + (process.version || ""));
        rows.push("Домашний каталог: " + os.homedir());
        rows.push("Рабочая директория агента: " + agentWorkDir(settings));
        rows.push("Записей в PATH: " + (envPathInfo().value || "").split(path.delimiter).filter(Boolean).length);
        rows.push("");
        // Расширенная информация: Windows — PowerShell/CIM, остальные — os.*
        if (process.platform === "win32") {
          const ps =
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
            "$os=Get-CimInstance Win32_OperatingSystem; " +
            "$cpu=Get-CimInstance Win32_Processor; " +
            "$gpu=Get-CimInstance Win32_VideoController | Select-Object -First 1; " +
            "$ips=@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } | ForEach-Object { $_.IPAddress }); " +
            "$disks=@(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Root=$_.Root; UsedGB=[math]::Round($_.Used/1GB,1); FreeGB=[math]::Round($_.Free/1GB,1) } }); " +
            "[pscustomobject]@{ os=$os.Caption; build=$os.Version; cpu=$cpu.Name; gpu=$gpu.Name; ramGB=[math]::Round($os.TotalVisibleMemorySize/1MB,1); ips=$ips; disks=$disks } | ConvertTo-Json -Compress -Depth 3";
          const r = await spawnRaw(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], { cwd: os.homedir(), timeoutMs: 30000 });
          const si = parseSysInfoJson(r.ok ? r.out : "");
          if (si.os) rows.push("Windows: " + si.os + (si.build ? " (build " + si.build + ")" : ""));
          if (si.cpu) rows.push("CPU: " + truncateText(si.cpu, 100));
          if (si.gpu) rows.push("GPU: " + truncateText(si.gpu, 100));
          if (si.ramGB) rows.push("RAM: " + si.ramGB + " ГБ");
          if (Array.isArray(si.ips) && si.ips.length) rows.push("IP-адреса (LAN): " + si.ips.join(", "));
          if (Array.isArray(si.disks) && si.disks.length) {
            rows.push("Диски:");
            for (const d of si.disks) {
              rows.push("• " + (d.Root || "?") + " — свободно " + (d.FreeGB != null ? d.FreeGB : "?") + " ГБ, занято " + (d.UsedGB != null ? d.UsedGB : "?") + " ГБ");
            }
          }
        } else {
          const cpus = os.cpus();
          if (cpus && cpus.length) rows.push("CPU: " + truncateText(cpus[0].model, 100) + " (" + cpus.length + " ядер)");
          rows.push("RAM: " + Math.round(os.totalmem() / 1024 / 1024 / 1024) + " ГБ всего, свободно " + Math.round(os.freemem() / 1024 / 1024 / 1024) + " ГБ");
          const ips = [];
          for (const k of Object.keys(os.networkInterfaces())) {
            for (const a of os.networkInterfaces()[k] || []) {
              if (a && a.family === "IPv4" && !a.internal && a.address && a.address.indexOf("127.") !== 0) ips.push(a.address);
            }
          }
          if (ips.length) rows.push("IP-адреса (LAN): " + ips.join(", "));
        }
        rows.push("");
        rows.push("Ключевые программы:");
        for (const n of ["git", "node", "npm", "python", "docker"]) {
          const f = findProgram(n);
          if (!f.found) rows.push("• " + n + ": не установлен");
          else {
            const v = await runProgVersion(f.path);
            rows.push("• " + n + ": " + (v || "установлен — " + f.path));
          }
        }
        // Установленные программы через winget (кратко: количество + первые 10)
        if (process.platform === "win32") {
          const w = await spawnRaw(["winget", "list", "--accept-source-agreements", "--disable-interactivity"], { cwd: os.homedir(), timeoutMs: 25000 });
          const wl = (w.out || "").split("\n").map((l) => l.trim()).filter((l) => l && !/^Name[ ]+Id[ ]+Version/i.test(l) && l.indexOf("---") !== 0 && !/^[0-9]+ package/i.test(l));
          if (wl.length) {
            rows.push("");
            rows.push("Установленные программы (winget, всего ~" + wl.length + "):");
            for (const l of wl.slice(0, 10)) rows.push("• " + l);
          }
        }
        rows.push("");
        rows.push("Советы: не установлено → installSystemPackage(имя) или wingetSearch(имя); не видно после установки → refreshEnv(); нужны права администратора → runCommandAsAdmin(команда); зависший процесс → listProcesses + killProcess; непонятная ошибка → explainError(код).");
        return rows.join("\n");
      }
      case "installSystemPackage": {
        return await installSystemPkg(args.packageName);
      }
      case "runCommandAsAdmin": {
        return await runAsAdmin(args.command);
      }
      case "refreshEnv": {
        return await refreshEnvFromOS();
      }
      case "explainError": {
        const codeRaw = args.exitCode;
        const code = codeRaw == null || codeRaw === "" ? NaN : parseInt(codeRaw, 10);
        return explainExit(Number.isNaN(code) ? NaN : code, args.command);
      }
      case "timeoutCommand": {
        const cmd = String(args.command || "").trim();
        if (!cmd) return "Ошибка: укажи команду";
        const ms = Math.min(Math.max(parseInt(args.timeoutMs, 10) || 15000, 1000), 600000);
        const res = await spawnCollect(cmd, agentWorkDir(settings), ms, "");
        const body = (res.out || "").trim();
        if (res.ok) return "$ " + cmd + " (лимит " + ms + " мс)\n\n" + (body || "Готово (без вывода).");
        if (res.timedOut) return "⏱ Команда не уложилась в " + ms + " мс и остановлена принудительно:\n$ " + cmd + "\n\n" + (body.slice(0, 3000) || "(вывода не было)") + "\n\nУвеличь timeoutMs или разбей команду на шаги.";
        return "$ " + cmd + "\nКоманда упала (код " + res.code + "):\n" + (body.slice(0, 4000) || "(без вывода)") + "\n\nОбъяснение: " + explainExit(res.code, cmd);
      }
      case "retryCommand": {
        const cmd = String(args.command || "").trim();
        if (!cmd) return "Ошибка: укажи команду";
        const retries = Math.min(Math.max(parseInt(args.maxRetries, 10) || 2, 0), 5);
        const pauseMs = Math.min(Math.max(parseInt(args.pauseMs, 10) || 2000, 200), 30000);
        const timeoutMs = Math.min(Math.max(parseInt(args.timeoutMs, 10) || 60000, 1000), 300000);
        const log = [];
        let last = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
          const res = await spawnCollect(cmd, agentWorkDir(settings), timeoutMs, "");
          last = res;
          if (res.ok) {
            return "$ " + cmd + "\n(попыток: " + (attempt + 1) + ")\n\n✅ успех с попытки #" + (attempt + 1) + "\n\n--- вывод ---\n" + ((res.out || "").trim().slice(0, 6000) || "(пусто)");
          }
          log.push("❌ попытка #" + (attempt + 1) + (res.timedOut ? " — таймаут " + timeoutMs + " мс" : " — код " + res.code) + (attempt < retries ? " → повтор через " + pauseMs + " мс" : ""));
          if (attempt < retries) await new Promise((r2) => setTimeout(r2, pauseMs));
        }
        return "$ " + cmd + "\nНе удалось после " + (retries + 1) + " попыток:\n" + log.join("\n") + "\n\n--- вывод последней попытки ---\n" + ((last && (last.out || "").trim().slice(0, 5000)) || "(пусто)") + "\n\nОбъяснение: " + explainExit(last ? last.code : 1, cmd);
      }
      case "downloadAndExtract": {
        const dest = args.path ? resolvePath(args.path, settings) : path.join(agentWorkDir(settings), "downloads");
        return await downloadAndExtractTo(args.url, dest);
      }
      case "apiRequest": {
        const url = String(args.url || "").trim();
        if (!/^https?:\/\//i.test(url)) return "Ошибка: укажи полный URL (http/https)";
        const method = String(args.method || "GET").toUpperCase();
        const headers = args.headers && typeof args.headers === "object" ? { ...args.headers } : {};
        let body = args.body;
        if (body && typeof body === "object") {
          body = JSON.stringify(body);
          if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        try {
          const res = await fetch(url, {
            method,
            headers,
            body: body === undefined || body === null ? undefined : String(body),
            signal: ctrl.signal,
            redirect: "follow",
          });
          const text = await res.text();
          const ct = res.headers.get("content-type") || "";
          const isText = /text|json|xml|javascript|html|urlencoded/i.test(ct) || text.length === 0;
          const shown = isText
            ? truncateText(text, 6000)
            : "(" + text.length + " байт, тип " + (ct || "неизвестен") + " — бинарное тело не показываю)";
          return "HTTP " + res.status + " " + res.statusText + " — " + method + " " + url + "\n" +
            "Content-Type: " + (ct || "—") + "\n" +
            "Объём тела: " + Buffer.byteLength(text, "utf8") + " байт\n\n" + shown;
        } catch (e) {
          return "Ошибка " + method + " " + url + ": " + ((e && e.name === "AbortError") ? "таймаут (30 с)" : (e && e.message) || String(e));
        } finally {
          clearTimeout(timer);
        }
      }
      case "runScript": {
        const cwd = agentWorkDir(settings);
        const name = String(args.scriptName || "").trim();
        if (!name) return "Ошибка: укажи scriptName (имя скрипта из package.json)";
        let pkg = null;
        try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")); } catch {}
        if (!pkg) return "В каталоге " + cwd + " нет package.json.";
        const scripts = pkg.scripts || {};
        if (!(name in scripts)) return "Скрипта «" + name + "» нет. Доступные скрипты: " + (Object.keys(scripts).join(", ") || "нет");
        const pm = detectPackageManager(cwd);
        const extra = String(args.args || "");
        const cmd = pm.name === "npm" ? "npm run " + name + (extra ? " " + extra : "") : pm.bin + " run " + name + (extra ? " " + extra : "");
        const out = await runTerminalCommand(cmd, cwd, 300000);
        return truncateText("$ " + cmd + "\n(каталог: " + cwd + ")\n\n" + out, 9000);
      }
      case "validateProject": {
        const cwd = agentWorkDir(settings);
        const has = (n) => fs.existsSync(path.join(cwd, n));
        const steps = [];
        if (has("tsconfig.json")) {
          const out = await runTerminalCommand("npx -y tsc --noEmit", cwd, 300000);
          steps.push({ name: "TypeScript (tsc --noEmit)", ok: !out.startsWith("Команда завершилась"), out });
        }
        if (has("eslint.config.js") || has("eslint.config.mjs") || has("eslint.config.cjs") || has(".eslintrc") || has(".eslintrc.json") || has(".eslintrc.js") || has(".eslintrc.cjs")) {
          const out = await runTerminalCommand("npx -y eslint .", cwd, 300000);
          steps.push({ name: "ESLint", ok: !out.startsWith("Команда завершилась"), out });
        }
        let pkg = null;
        try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")); } catch {}
        if (pkg && pkg.scripts && pkg.scripts.test) {
          const out = await runTerminalCommand("npm test", cwd, 300000);
          const s = summarizeTestOutput(out);
          steps.push({ name: "Тесты (npm test)", ok: !out.startsWith("Команда завершилась") && !/(failed|failing|упало)/i.test(s), out });
        }
        if (!steps.length) {
          return "Не нашёл, что проверять в " + cwd + ": нет tsconfig.json, eslint-конфига и test-скрипта. Укажи задачи через runCommand или установи инструменты.";
        }
        const okCount = steps.filter((s) => s.ok).length;
        const body = steps.map((s) => {
          const icon = s.ok ? "✅" : "❌";
          return icon + " " + s.name + (s.ok ? " — ок" : "") + "\n" + truncateText(s.out, 1400);
        }).join("\n\n");
        return "Проверка проекта (" + cwd + "): " + okCount + " из " + steps.length + " этапов успешно\n\n" + body;
      }
      case "gitBranch": {
        const cwd = agentWorkDir(settings);
        const cur = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], settings);
        const list = await runGit(cwd, ["branch", "-a", "--no-color"], settings);
        if (!cur.ok && !list.ok) return "Ошибка git: " + (cur.err || list.err);
        return "Текущая ветка: " + (cur.ok ? cur.out : "(не git-репозиторий)") + "\n\nВсе ветки:\n" + (list.ok ? list.out : "(веток нет)");
      }
      case "gitCheckout": {
        const cwdCh = agentWorkDir(settings);
        const branch = String(args.branch || args.name || "").trim();
        if (!branch) return "Ошибка: укажи branch — имя ветки (create: true, чтобы создать новую)";
        const create = !!args.create;
        const r = await runGit(cwdCh, ["checkout", ...(create ? ["-b", branch] : [branch])], settings);
        if (!r.ok) {
          const hint = create
            ? ""
            : "\n(Если ветки ещё нет — повтори с create: true. Если есть незакоммиченные изменения, мешающие переключению, — сначала закоммить их или отложи через git stash.)";
          return "Ошибка git: " + r.err + hint;
        }
        return "OK — " + (create ? "создана и активирована ветка «" : "переключение на ветку «") + branch + "»:\n" + r.out;
      }
      case "findReferences": {
        const symbol = String(args.symbol || "").trim();
        if (!symbol) return "Ошибка: укажи symbol (имя функции/переменной/класса)";
        let root = agentWorkDir(settings);
        if (args.path) {
          const rp = resolvePath(args.path, settings);
          if (!fs.existsSync(rp)) return "Ошибка: путь не найден: " + rp;
          root = rp;
        }
        const r = findSymbolReferences(root, symbol);
        if (r.error) return "Ошибка: " + r.error;
        if (!r.hits.length) return "Использований «" + symbol + "» не найдено в " + root + ".";
        const files = new Set(r.hits.map((h) => h.file));
        const defs = r.hits.filter((h) => h.kind === "определение").length;
        const calls = r.hits.filter((h) => h.kind === "вызов").length;
        const mark = { "определение": "◈", "импорт": "⤓", "вызов": "▸", "ссылка": "·" };
        const pad = String(Math.max(...r.hits.map((h) => h.n))).length;
        const text = r.hits.map((h) => (mark[h.kind] || "·") + " " + h.file + ":" + String(h.n).padStart(pad, " ") + "  [" + h.kind + "] " + h.text).join("\n");
        return "Символ «" + symbol + "» — " + r.hits.length + " вхожд. в " + files.size + " файл. (◈ определений: " + defs + ", ▸ вызовов: " + calls + ")\n\n" + truncateText(text, 9000);
      }
      case "gitDiff": {
        const cwd = agentWorkDir(settings);
        const b1 = String(args.branch1 || "").trim();
        const b2 = String(args.branch2 || "").trim();
        const spec = b1 && b2 ? [b1, b2] : b1 ? [b1] : [];
        if (!spec.length) {
          const d = await runGit(cwd, ["diff", "--stat"], settings);
          return d.ok ? (d.out || "Рабочее дерево чистое — нет незакоммиченных изменений.") : "Ошибка git: " + d.err;
        }
        const st = await runGit(cwd, ["diff", "--stat", ...spec], settings);
        const ns = await runGit(cwd, ["diff", "--name-status", ...spec], settings);
        const stat = st.ok ? st.out : "";
        const names = ns.ok ? ns.out : "";
        if (!stat && !names) return "Различий нет: " + spec.join(" … ") + " — ветки идентичны (или ветка не найдена).";
        return "Сравнение " + spec.join(" … ") + " — изменено файлов: " + names.split("\n").filter(Boolean).length + "\n\n" + stat + "\n\n--- Файлы ---\n" + truncateText(names, 3000);
      }
      case "gitUndoLastCommit": {
        const cwd = agentWorkDir(settings);
        const r = await runGit(cwd, ["reset", "--soft", "HEAD~1"], settings);
        if (!r.ok) return "Ошибка git: " + r.err + "\n(Частая причина — в истории нет коммитов для отмены.)";
        return "OK — последний коммит отменён (git reset --soft HEAD~1): его изменения вернулись в рабочее дерево как незакоммиченные, ничего не потеряно.\n" + r.out;
      }
      case "getDependencies": {
        const cwd = agentWorkDir(settings);
        let pkg = null;
        try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")); } catch {}
        if (!pkg) return "package.json не найден в " + cwd;
        const deps = pkg.dependencies || {};
        const dev = pkg.devDependencies || {};
        const installed = (n) => {
          try { return JSON.parse(fs.readFileSync(path.join(cwd, "node_modules", n, "package.json"), "utf8")).version; } catch { return null; }
        };
        const fmt = (o) => Object.keys(o).length
          ? Object.keys(o).map((n) => "• " + n + "@" + o[n] + " → " + (installed(n) ? "установлено " + installed(n) : "НЕ установлено")).join("\n")
          : "— пусто";
        let out = "📦 dependencies (" + Object.keys(deps).length + ") в " + cwd + ":\n" + fmt(deps);
        out += "\n\n🛠 devDependencies (" + Object.keys(dev).length + "):\n" + fmt(dev);
        if (args.audit) {
          if (!fs.existsSync(path.join(cwd, "package-lock.json"))) {
            out += "\n\nnpm audit требует package-lock.json (создаётся npm install). Для bun/pnpm используй их audit-команды через runCommand.";
          } else {
            out += "\n\n--- npm audit (omit dev) ---\n" + truncateText(await runTerminalCommand("npm audit --omit=dev", cwd, 120000), 4000);
          }
        }
        return truncateText(out, 9000);
      }
      case "formatCode": {
        const cwd = agentWorkDir(settings);
        const target = args.path ? resolvePath(args.path, settings) : "";
        if (!target || !fs.existsSync(target)) return "Ошибка: укажи существующий path (файл или папка)";
        const bin = path.join(cwd, "node_modules", ".bin", process.platform === "win32" ? "prettier.cmd" : "prettier");
        if (!fs.existsSync(bin)) return "Prettier не установлен в проекте. Установи его: installPackage(\"prettier\", true), затем повтори formatCode.";
        const check = !!args.check;
        const out = await runTerminalCommand(bin + (check ? " --check " : " --write ") + "\"" + target + "\"", cwd, 120000);
        return truncateText("$ prettier " + (check ? "--check" : "--write") + " " + path.relative(cwd, target) + "\n\n" + out, 6000);
      }
      case "dbQuery": {
        const conn = String(args.connectionString || "").trim();
        const sql = String(args.sql || "").trim();
        if (!conn || !sql) return "Ошибка: укажи connectionString и sql";
        let kind = "";
        try {
          const u = new URL(conn);
          if (u.protocol === "postgres:" || u.protocol === "postgresql:") kind = "postgres";
          else if (u.protocol === "mysql:") kind = "mysql";
        } catch {}
        if (!kind) return "Ошибка: поддерживаются строки подключения postgres://... и mysql://...";
        return await new Promise((resolve) => {
          const baseEnv = { ...process.env, ...agentEnv };
          if (kind === "postgres") {
            execFile("psql", [conn, "-v", "ON_ERROR_STOP=1", "-c", sql], { timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: baseEnv }, (err, stdout, stderr) => {
              const o = stripAnsi((stdout || "").toString());
              const e = stripAnsi((stderr || "").toString());
              if (err) {
                if (err.code === "ENOENT") return resolve("Клиент psql не найден в системе. Установи PostgreSQL-клиент и добавь в PATH, затем повтори.");
                return resolve(truncateText("Ошибка psql:\n" + (e || err.message || String(err)), 7000));
              }
              resolve(truncateText("psql OK:\n" + (o || "(без вывода)") + (e ? "\n[stderr]\n" + e : ""), 7000));
            });
          } else {
            let u = null;
            try { u = new URL(conn); } catch {}
            if (!u) return resolve("Ошибка парсинга строки подключения");
            const a = [];
            if (u.hostname) a.push("--host=" + u.hostname);
            if (u.port) a.push("--port=" + u.port);
            if (u.username) a.push("--user=" + decodeURIComponent(u.username));
            const db = decodeURIComponent((u.pathname || "").replace(/^\//, ""));
            if (db) a.push(db);
            a.push("-e", sql);
            const menv = { ...baseEnv };
            if (u.password) menv.MYSQL_PWD = decodeURIComponent(u.password);
            execFile("mysql", a, { timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: menv }, (err, stdout, stderr) => {
              const o = stripAnsi((stdout || "").toString());
              const e = stripAnsi((stderr || "").toString());
              if (err) {
                if (err.code === "ENOENT") return resolve("Клиент mysql не найден в системе. Установи MySQL-клиент и добавь в PATH, затем повтори.");
                return resolve(truncateText("Ошибка mysql:\n" + (e || err.message || String(err)), 7000));
              }
              resolve(truncateText("mysql OK:\n" + (o || "(без вывода)") + (e ? "\n[stderr]\n" + e : ""), 7000));
            });
          }
        });
      }
      case "listProcesses": {
        const filter = String(args.filter || "").trim().toLowerCase();
        let out = "";
        if (process.platform === "win32") {
          const r = await spawnRaw(["tasklist", "/FO", "CSV", "/NH"], { cwd: os.homedir(), timeoutMs: 20000 });
          out = r.ok ? r.out : "";
        } else {
          const r = await spawnRaw(["ps", "-eo", "pid=,comm=,%cpu=,rss=,args="], { cwd: os.homedir(), timeoutMs: 20000 });
          out = r.ok ? r.out : "";
        }
        let procs = parseProcessesCsv(out);
        if (filter) {
          procs = procs.filter((p) => (p.name || "").toLowerCase().indexOf(filter) !== -1 || (p.args || "").toLowerCase().indexOf(filter) !== -1);
        }
        procs = procs.slice(0, 60);
        if (!procs.length) return "Процессы не найдены" + (filter ? " по фильтру «" + filter + "»" : "") + ".";
        const head = "Процессы" + (filter ? " (фильтр «" + filter + "»)" : "") + " (" + procs.length + " из списка):\n";
        return head + procs.map((p) => {
          const mem = p.mem ? " " + p.mem : p.rss ? " " + Math.round(Number(p.rss) / 1024) + " КБ" : "";
          const argsPart = p.args ? "  «" + truncateText(p.args, 110) + "»" : "";
          return "• PID " + p.pid + " — " + (p.name || "") + mem + argsPart;
        }).join("\n") + "\n\nЗависший процесс завершай через killProcess(pid или name).";
      }
      case "killProcess": {
        const pid = parseInt(args.pid, 10);
        const name = String(args.name || "").trim();
        const force = args.force === true || args.force === "true" || args.force === 1;
        if (!pid && !name) return "Ошибка: укажи pid (число из listProcesses) или name (например node).";
        let cmd, label;
        if (process.platform === "win32") {
          cmd = "taskkill " + (pid ? "/PID " + pid : "/IM " + name) + " /T" + (force ? " /F" : "");
          label = pid ? "PID " + pid : name;
        } else if (pid) {
          cmd = "kill " + (force ? "-9 " : "") + pid;
          label = "PID " + pid;
        } else {
          cmd = "pkill " + (force ? "-9 " : "-TERM ") + JSON.stringify(name);
          label = name;
        }
        const out = await runTerminalCommand(cmd, os.homedir(), 20000);
        const failed = /не найден|ERROR|not found|No matching|No processes|кодом (1|128)/i.test(out);
        return (failed ? "Возможно, процесс уже завершён или не найден:\n" : "OK — процесс " + label + " завершён.\n") + "$ " + cmd + "\n\n" + out;
      }
      case "clipboardWrite": {
        const text = String(args.text == null ? "" : args.text);
        try {
          clipboard.writeText(text);
        } catch (e) {
          return "Ошибка: не удалось записать в буфер обмена: " + (e.message || String(e));
        }
        return "OK — текст скопирован в буфер обмена (" + text.length + " симв.).";
      }
      case "clipboardRead": {
        let text = "";
        try {
          text = clipboard.readText() || "";
        } catch (e) {
          return "Ошибка: не удалось прочитать буфер обмена: " + (e.message || String(e));
        }
        if (!text.trim()) return "Буфер обмена пуст (текста нет).";
        return "Содержимое буфера обмена:\n\n" + truncateText(text, 4000);
      }
      case "screenshotDesktop": {
        const winFilter = String(args.window || "").trim().toLowerCase();
        let sources = [];
        try {
          sources = await desktopCapturer.getSources({
            types: winFilter ? ["window"] : ["screen"],
            thumbnailSize: { width: 1920, height: 1080 },
            fetchWindowIcons: false,
          });
        } catch (e) {
          return "Ошибка захвата экрана: " + (e.message || String(e)) + " (работает только в десктоп-приложении).";
        }
        let src = sources[0];
        if (winFilter) src = sources.find((s) => s.name.toLowerCase().indexOf(winFilter) !== -1) || sources[0];
        if (!src) return "Не удалось получить источники экрана/окон.";
        const png = src.thumbnail.toPNG();
        if (!png || !png.length) return "Пустой скриншот «" + src.name + "» — не удалось захватить.";
        const sz = src.thumbnail.getSize();
        const dataUrl = "data:image/png;base64," + png.toString("base64");
        if (activeEmit) activeEmit({ type: "image", path: "desktop:" + src.name, dataUrl });
        return "OK — скриншот «" + src.name + "» (" + sz.width + "×" + sz.height + ") снят и показан пользователю во встроенном просмотрщике. При необходимости проанализируй детали через analyzeImage.";
      }
      case "registryRead": {
        if (process.platform !== "win32") return "Ошибка: реестр Windows доступен только на Windows.";
        const regPath = String(args.path || "").trim();
        const name = String(args.name || "").trim();
        const chk = registryPathAllowed(regPath, false);
        if (!chk.ok) return "Ошибка: " + chk.error;
        const esc = regPath.replace(/'/g, "''");
        let ps;
        if (name) {
          const escName = name.replace(/'/g, "''");
          ps =
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
            "try { $v = Get-ItemPropertyValue -Path '" + esc + "' -Name '" + escName + "' -ErrorAction Stop; Write-Output (($v | Out-String).Trim()) } catch { Write-Output '__ERR__' }";
        } else {
          ps =
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
            "$i = Get-Item -Path '" + esc + "' -ErrorAction SilentlyContinue; " +
            "if ($null -eq $i) { Write-Output '__ERR__' } else { $d = $i.GetValue(''); if ($null -eq $d) { Write-Output '(раздел без значения по умолчанию)' } else { Write-Output ('Значение по умолчанию: ' + $d) } }";
        }
        const r = await spawnRaw(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], { cwd: os.homedir(), timeoutMs: 20000 });
        const out = (r.out || "").trim();
        if (out.indexOf("__ERR__") !== -1 || /Cannot find|не найден|отказано/i.test(out + r.err)) {
          return "Раздел или значение не найдено: " + regPath + (name ? " → " + name : "") + ". Проверь путь — чтение разрешено только из SOFTWARE/ENVIRONMENT/SYSTEM/SECURITY.";
        }
        return "Реестр " + regPath + (name ? " → " + name : "") + ":\n" + out;
      }
      case "registryWrite": {
        if (process.platform !== "win32") return "Ошибка: реестр Windows доступен только на Windows.";
        const regPath = String(args.path || "").trim();
        const name = String(args.name || "").trim();
        if (!name) return "Ошибка: укажи name (имя значения).";
        const value = String(args.value == null ? "" : args.value);
        const type = String(args.type || "REG_SZ").toUpperCase();
        if (["REG_SZ", "REG_DWORD", "REG_EXPAND_SZ"].indexOf(type) === -1) {
          return "Ошибка: type должен быть REG_SZ, REG_DWORD или REG_EXPAND_SZ.";
        }
        const chk = registryPathAllowed(regPath, true);
        if (!chk.ok) return "Ошибка: " + chk.error;
        const esc = regPath.replace(/'/g, "''");
        const escName = name.replace(/'/g, "''");
        const valPs = type === "REG_DWORD" ? String(Number(value) || 0) : value.replace(/'/g, "''");
        const ps =
          "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
          "$p = '" + esc + "';" +
          "New-Item -Path $p -Force | Out-Null;" +
          "New-ItemProperty -Path $p -Name '" + escName + "' -Value '" + valPs + "' -PropertyType " + type + " -Force | Out-Null;" +
          "Write-Output 'OK'";
        const r = await spawnRaw(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], { cwd: os.homedir(), timeoutMs: 20000 });
        if (!r.ok || (r.out || "").indexOf("OK") === -1) {
          return "Ошибка записи: " + (((r.err || "") + " " + (r.out || "")).trim() || "неизвестная причина") + " — проверь права (HKCU не требует админа) или путь.";
        }
        return "OK — значение «" + name + "» = «" + value + "» (" + type + ") записано в " + regPath;
      }
      case "openPath": {
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: путь не найден: " + p;
        const err = await shell.openPath(p);
        return err ? "Не удалось открыть: " + err : "OK — открыто системным приложением: " + p;
      }
      case "wingetSearch": {
        if (process.platform !== "win32") return "Ошибка: winget доступен только на Windows.";
        const q = String(args.query || "").trim();
        if (!q) return "Ошибка: укажи query (например python, ffmpeg, ollama).";
        const r = await spawnRaw(["winget", "search", q, "--accept-source-agreements", "--disable-interactivity"], { cwd: os.homedir(), timeoutMs: 60000 });
        const out = (r.out || "").trim();
        if (!r.ok && !out) {
          return "winget недоступен: " + ((r.err || "").trim() || "код " + r.code) + ". Установи winget (Microsoft Store: «App Installer») или используй installSystemPackage — при отсутствии winget попробует choco/scoop.";
        }
        const lines = out.split("\n").filter((l) => l.trim() && !/^Name\s+Id\s+Version\s+Source/i.test(l));
        return "Результаты winget search «" + q + "»:\n\n" + (lines.slice(0, 25).join("\n") || out || "ничего не найдено") + "\n\nУстановка: installSystemPackage(\"" + q + "\") — если ID уникален, или укажи полный ID вида Vendor.Name из списка.";
      }
      case "installExe": {
        const url = String(args.url || "").trim();
        const name = String(args.name || "").trim();
        if (!/^https?:\/\//i.test(url)) return "Ошибка: укажи прямой URL установщика .exe (https://...).";
        const silent = String(args.silentArgs || "").trim() || "/S";
        const tmpDir = path.join(os.tmpdir(), "ai-agent-install");
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { return "Ошибка: не удалось создать временную папку: " + (e.message || String(e)); }
        const base = (name || "installer").replace(/[^A-Za-z0-9._-]/g, "_") + ".exe";
        const dest = path.join(tmpDir, base);
        let res;
        try {
          res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "AI-Developer-Agent" } });
        } catch (e) {
          return "Ошибка загрузки " + url + ": " + (e.message || String(e));
        }
        if (!res.ok) return "Ошибка HTTP " + res.status + " при загрузке " + url;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 500 * 1024 * 1024) return "Установщик слишком большой (>500 МБ).";
        fs.writeFileSync(dest, buf);
        const cmd = '"' + dest + '" ' + silent;
        const out = await runTerminalCommand(cmd, os.homedir(), 300000);
        const looksFailed = /кодом [0-9]+|Access is denied|отказано в доступе|требуется повышение|administrator/i.test(out);
        return (
          "Установщик скачан: " + dest + " (" + Math.round(buf.length / 1024 / 1024) + " МБ)\n" +
          "$ " + cmd + "\n\n" + out +
          (looksFailed
            ? "\n\nЕсли установка требует прав администратора — повтори через runCommandAsAdmin(\"" + cmd.replace(/"/g, "") + "\")."
            : "\n\nПроверь: checkInstalledProgram(\"" + (name || "программа") + "\").")
        );
      }
      default:
        return "Ошибка: неизвестный инструмент " + name;
    }
  } catch (e) {
    return "Ошибка: " + (e.message || String(e));
  }
}

// ─────────────────────────── AI: список моделей ───────────────────────────
async function fetchModels(settings) {
  return listModels(settings);
}

// ─────────────────────────── AI: чат с инструментами ───────────────────────────
let activeAbort = null;
let activeEmit = null; // отправка ai:event из executeTool (showImage и т.п.)

// Авто-чекпоинт (как в Replit): после завершённого задания агента, если он менял файлы
// в git-репозитории — создаём один локальный коммит-точку возврата. Никогда не пушит.
async function autoCheckpointCommit(settings, messages) {
  try {
    if (settings && settings.agentAutoCommit === false) return { committed: false };
    const dir = agentWorkDir(settings);
    if (!dir || !fs.existsSync(dir)) return { committed: false };
    // Не git-репозиторий или нет изменений — пропускаем тихо.
    const st = await runGit(dir, ["status", "--porcelain"], settings);
    if (!st.ok || !st.out.trim()) return { committed: false };
    // Заголовок коммита — из последнего сообщения пользователя (первая строка).
    let title = "";
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === "user" && typeof m.content === "string" && m.content.trim()) {
          const lines = m.content.replace(/```[\s\S]*?```/g, " ").split("\n");
          title = lines.find(function (l) { return l.trim(); }) || "";
          break;
        }
      }
    }
    title = String(title).replace(/\s+/g, " ").trim().slice(0, 70);
    if (!title) title = "Работа агента";
    const add = await runGit(dir, ["add", "-A"], settings);
    if (!add.ok) return { committed: false };
    const commit = await runGit(
      dir,
      ["-c", "user.name=AI Agent", "-c", "user.email=ai-agent@local", "commit", "-m", "Авто-коммит агента: " + title],
      settings
    );
    if (!commit.ok) return { committed: false };
    return { committed: true, message: "💾 Авто-коммит агента: " + title };
  } catch (e) {
    return { committed: false };
  }
}

async function runAi(settings, messages, win, opts) {
  opts = opts || {};
  const planMode = !!(opts.plan || opts.planMode); // режим «сначала план»: инструменты не выполняются
  const emit = (ev) => {
    if (!win.isDestroyed()) win.webContents.send("ai:event", ev);
  };
  activeEmit = emit;
  const abort = new AbortController();
  activeAbort = abort;
  activeRunUndo = [];
  const provider = settings.provider || "openai";
  // Рассуждения модели (текст из <think>...</think> и нативные reasoning_content / thinking_delta)
  const emitThink = (text) => {
    if (text) emit({ type: "thinking", text });
  };

  if (!settings.model) {
    throw new Error("Не выбрана модель. Открой Настройки и обнови список моделей (кнопка ↻).");
  }

  // Контекст-окно: бюджет = реальное окно модели (если известно) минус резерв на вывод.
  let budget = contextBudget(provider, settings.model);
  try {
    const win = await modelWindow(settings, settings.model);
    if (win > 0) budget = Math.min(budget, win - 4096);
    if (budget < 3000) budget = 3000;
  } catch {}
  let contextRetried = false; // при переполнении контекста пробуем ещё раз с меньшим бюджетом
  let reportRetried = false; // пустой финальный текст — один раз просим итоговый отчёт
  // Динамический список инструментов: при тесном контексте — только ядро файлов/терминала.
  const activeTools = planMode ? [] : selectTools(budget);
  const toolsWeight = activeTools.length ? estimateTokens(JSON.stringify(activeTools)) : 0;
  let histBudget = Math.max(1500, budget - toolsWeight); // бюджет истории без учёта схемы инструментов
  const ctxManager = createContextManager({ settings, emit, planMode });

  // Вопрос пользователю (askUser / подтверждение опасной команды).
  const askUserWait = (question) => {
    emit({ type: "ask", question });
    return new Promise((resolve) => {
      pendingAsk = resolve;
      // Если пользователь не ответит за 5 минут — продолжаем без ответа
      setTimeout(() => {
        if (pendingAsk) {
          const r = pendingAsk;
          pendingAsk = null;
          r("");
        }
      }, 300000);
    });
  };
  const trimmedHistory = await ctxManager.manage(messages, histBudget);
  // Авто-разбор присланных картинок вспомогательной vision-моделью (второй ключ):
  // скриншот → описание → кодер работает с текстом (его модель может не видеть картинки).
  let runHistory = trimmedHistory;
  const vcfg = auxConfig(settings);
  if (vcfg.enabled && vcfg.auto && vcfg.visionModel && vcfg.key && vcfg.url && !planMode) {
    let target = -1;
    for (let i = runHistory.length - 1; i >= 0; i--) {
      const m = runHistory[i];
      if (m && m.role === "user" && Array.isArray(m.content) && m.content.some((p) => p && p.type === "image_url")) {
        target = i;
        break;
      }
    }
    if (target >= 0) {
      const msg = runHistory[target];
      const text = (msg.content || []).filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n");
      const imgs = (msg.content || []).filter((p) => p && p.type === "image_url" && p.image_url && p.image_url.url).slice(0, 3);
      emit({ type: "vision", text: "👁 Разбираю присланные изображения вспомогательной моделью…" });
      try {
        const descs = [];
        for (const part of imgs) {
          const desc = await describeImageRemote(vcfg, part.image_url.url, "Опиши подробно, что изображено на картинке: объекты, текст, интерфейс, цвета, расположение. Это описание уйдёт программисту вместо картинки.", vcfg.visionModel);
          descs.push(desc || "(описание пустое)");
        }
        const note = "\n\n[Описание присланного изображения (сделано вспомогательной vision-моделью на отдельном ключе):]\n" + descs.join("\n\n---\n\n");
        runHistory = runHistory.slice();
        runHistory[target] = { ...msg, content: text ? text + note : note.trim() };
        emit({ type: "vision", text: "✓ Изображения разобраны — описание передано основной модели." });
      } catch (e) {
        emit({ type: "vision", text: "⚠ Не удалось разобрать изображение: " + ((e && e.message) || e) + " — картинка отправлена как есть." });
      }
    }
  }
  // Канонические сообщения (OpenAI-стиль). Провайдер-специфику применяем на лету в buildChatRequest.
  const workDir = agentWorkDir(settings);
  const wdNote =
    "\n\nРабочая директория приложения (туда создаются файлы и там выполняются команды): " +
    workDir +
    (lastAgentRepoDir && lastAgentRepoDir !== workDir ? "\nАктивный репозиторий: " + lastAgentRepoDir : "") +
    '\nОтносительные пути вроде "test.txt" или "src/utils/helper.txt" резолвятся относительно рабочей директории.';
  // Краткая «визитка» проекта — чтобы агент не начинал сессию вслепую
  // (buildProjectBrief: имя, скрипты, структура, начало README).
  const projectBrief = buildProjectBrief(workDir);
  const briefNote = projectBrief
    ? "\n\n=== САММАРИ ПРОЕКТА (сгенерировано автоматически; детали — через listFiles / fileOutline / readFileLines) ===\n" + projectBrief
    : "";
  // Одноразовый толчок после клонирования/выбора репозитория: без него агент может
  // не догадаться, что пользователь ждёт разбора нового проекта. Флаг сбрасывается
  // сразу после первого ответа — постоянной нагрузки на контекст нет.
  let cloneNote = "";
  if (clonedRepoPending && !planMode) {
    clonedRepoPending = false;
    cloneNote =
      "\n\nПроект только что склонирован (рабочая директория сменилась). Пользователь ждёт: краткий анализ проекта и инструкцию, как его запустить — команда запуска (скрипты — в САММАРИ ПРОЕКТА), порт, как проверить (startBackground + checkUrl/checkPort; для веб-интерфейса — previewUI). Файлы целиком не читай — fileOutline / readFileLines / searchProject.";
  }
  let canonical = [
    {
      role: "system",
      content: SYSTEM_PROMPT + wdNote + briefNote + cloneNote + (planMode ? "\n\nРЕЖИМ ПЛАНА: сейчас НЕ выполняй инструменты и НЕ изменяй файлы. Составь пошаговый план работ и перечисли файлы, которые затронешь. Жди команды пользователя." : ""),
    },
    ...runHistory.map((m) => ({ role: m.role, content: m.content })),
  ];
  const maxRounds = planMode ? 3 : 25;
  let finalText = "";

  for (let round = 0; round < maxRounds; round++) {
    let collected = "";
    const toolCalls = [];
    const stripper = createThinkingStripper({ onHidden: emitThink });

    // Контекст-менеджмент: между раундами держим историю в рамках бюджета токенов.
    // Хвост (текущий виток с tool-результатами) сохраняется целиком.
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...(await ctxManager.manage(canonical.slice(1), histBudget))];
    }

    const req = buildChatRequest(settings, {
      model: settings.model,
      messages: canonical,
      tools: planMode ? [] : activeTools,
    });
    let res;
    try {
      res = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: abort.signal,
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new Error("Сетевая ошибка при запросе к " + provider + ": " + e.message);
    }
    if (!res.ok) {
      const detail = await readApiError(res);
      // Переполнение контекста (частая беда локальных моделей Ollama с малым окном):
      // один раз повторяем запрос с резко урезанной историей, чтобы не падать.
      if (
        !contextRetried &&
        /context|too long|maximum|num_ctx|token/i.test(detail) &&
        budget > 3000
      ) {
        contextRetried = true;
        budget = Math.max(3000, Math.floor(budget * 0.4));
        histBudget = Math.max(1500, budget - toolsWeight);
        if (canonical.length > 1) {
          const sys = canonical[0];
          canonical = [sys, ...(await ctxManager.manage(canonical.slice(1), histBudget))];
        }
        round--;
        continue;
      }
      // 402 = Insufficient Balance: у провайдера кончились деньги. Подсказываем по-русски.
      if (res.status === 402) {
        throw new Error(
          "API error 402: Недостаточно средств на балансе провайдера (" + (settings.provider || "openai") + "). Пополни счёт или выбери другого провайдера/модель в настройках."
        );
      }
      throw new Error("API error " + res.status + ": " + detail);
    }

    await consumeProviderStream({
      response: res,
      provider,
      onText: (text) => {
        const vis = stripper.push(text);
        if (vis) {
          collected += vis;
          emit({ type: "chunk", text: vis });
        }
      },
      onToolCall: (tc) => toolCalls.push(tc),
      onThinking: emitThink,
    });

    const tail = stripper.finish();
    if (tail) {
      collected += tail;
      emit({ type: "chunk", text: tail });
    }
    finalText = collected;

    // Запасной способ: модель могла напечатать JSON-вызов инструмента текстом,
    // а не через tool_calls. Находим такие вызовы и выполняем их.
    // В режиме плана инструменты не выполняются вовсе — план только составляется.
    if (toolCalls.length === 0 && !planMode) {
      const fallbackCalls = extractToolCallsFromText(finalText);
      if (fallbackCalls.length) {
        for (const fc of fallbackCalls) {
          toolCalls.push({ id: genCallId(), name: fc.name, args: fc.args });
        }
        // Убираем JSON-мусор из показанного пользователю текста
        let cleaned = finalText;
        for (const fc of fallbackCalls) {
          cleaned = cleaned.split(fc.raw).join("");
        }
        cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
        if (cleaned) emit({ type: "text_override", text: cleaned });
      }
    }

    // Пустой финальный ответ — не молчим. Один раз просим итоговый отчёт.
    if (toolCalls.length === 0 && !planMode && !reportRetried && !String(finalText || "").trim() && !abort.signal.aborted) {
      reportRetried = true;
      canonical.push({
        role: "user",
        content:
          "Ты завершил действия, но итоговый ответ получился пустым. Напиши структурированный итоговый отчёт: что сделано, какие файлы созданы/изменены, какие команды выполнялись, как проверить результат.",
      });
      continue;
    }

    if (toolCalls.length === 0) {
      if (!String(finalText || "").trim() && !abort.signal.aborted) {
        finalText =
          "⚠ Модель не прислала итоговый текст (вероятно, переполнен контекст). Изменения сохранены; нажми «↻ Перегенерировать» или напиши «продолжай».";
        emit({ type: "chunk", text: finalText });
      }
      lastUndoLog = activeRunUndo.slice();
      persistUndo();
      if (lastUndoLog.length) emit({ type: "undo_available", count: lastUndoLog.length });
      // Авто-чекпоинт: агент менял файлы — фиксируем локальный коммит-точку возврата (без пуша).
      if (!planMode && lastUndoLog.length) {
        const cp = await autoCheckpointCommit(settings, messages);
        if (cp && cp.committed) emit({ type: "checkpoint", message: cp.message });
      }
      // Системное уведомление, если окно не в фокусе (долгий ответ закончился)
      if (mainWindow && !mainWindow.isFocused() && Notification.isSupported()) {
        try {
          const snippet = String(finalText || "").trim().slice(0, 140);
          new Notification({
            title: "AI Developer Agent",
            body: "Ответ агента готов" + (snippet ? ": " + snippet : ""),
          }).show();
        } catch {}
      }
      emit({ type: "done" });
      return { ok: true, text: finalText };
    }

    // Нормализуем имена, назначаем стабильные id (нужны для tool-сообщений)
    // и убираем дубли: одинаковый вызов в одном раунде выполняется один раз.
    const seenCalls = new Set();
    const calls = [];
    for (const tc of toolCalls) {
      const norm = {
        id: tc.id || genCallId(),
        name: normalizeToolName(tc.name),
        args: tc.args && typeof tc.args === "object" ? tc.args : {},
      };
      const sig = norm.name + "|" + JSON.stringify(norm.args);
      if (seenCalls.has(sig)) continue;
      seenCalls.add(sig);
      calls.push(norm);
    }

    canonical.push({
      role: "assistant",
      content: finalText || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
      })),
    });

    for (const c of calls) {
      emit({ type: "tool_start", name: c.name, args: c.args });
      let result;
      if (c.name === "askUser") {
        const question = (c.args && c.args.question) || "Уточни, пожалуйста";
        const answer = await askUserWait(question);
        result = answer && String(answer).trim() ? String(answer).trim() : "(пользователь не дал ответ)";
      } else if (c.name === "runCommand") {
        // Потенциально опасные команды выполняем только после явного подтверждения.
        const cmd = String((c.args && c.args.command) || "");
        if (DANGEROUS_CMD_RE.test(cmd)) {
          const answer = await askUserWait(
            "⚠️ Команда потенциально опасна: «" + cmd.slice(0, 160) + "»\nВыполнить? (да / нет)"
          );
          const ok = /^(да|yes|y|ok|го|ага|точно|конечно|давай|выполн)/i.test(String(answer || "").trim());
          if (!ok) {
            result =
              "Команда НЕ выполнена: пользователь не подтвердил опасную операцию. Сообщи, что действие пропущено, и предложи безопасную альтернативу.";
          } else {
            result = await executeTool(c.name, c.args, settings);
          }
        } else {
          result = await executeTool(c.name, c.args, settings);
        }
      } else if (DANGEROUS_TOOLS.has(c.name)) {
        const desc = describeToolArgs(c.name, c.args);
        const answer = await askUserWait("⚠️ Действие потенциально опасно: " + desc + "\nВыполнить? (да / нет)");
        const ok = /^(да|yes|y|ok|го|ага|точно|конечно|давай|выполн)/i.test(String(answer || "").trim());
        if (!ok) {
          result = "Действие НЕ выполнено: пользователь не подтвердил. Сообщи, что действие пропущено, и предложи безопасную альтернативу.";
        } else {
          result = await executeTool(c.name, c.args, settings);
        }
      } else {
        // Чекпоинт: до правки файла запоминаем его состояние (для отката изменений агента)
        if (c.name === "writeFile" || c.name === "editFile") {
          try { snapshotFileForUndo(resolvePath(c.args && c.args.path, settings)); } catch {}
        }
        result = await executeTool(c.name, c.args, settings);
      }
      // Держим контекст в рамках бюджета: длинный вывод инструмента ужимаем
      const capped = truncateText(result, 8000);
      emit({ type: "tool_result", name: c.name, result: capped });
      canonical.push({ role: "tool", tool_call_id: c.id, content: capped });
    }
  }

  throw new Error("Превышено максимальное число раундов вызова инструментов (" + maxRounds + ").");
}

// ─────────────────────────── Окно ───────────────────────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "AI Developer Agent",
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Прокси webContents.send: все события (ai:event, term:event, dev:event, github:event)
  // дополнительно транслируются клиентам мобильного моста по WebSocket.
  const _wcSend = mainWindow.webContents.send.bind(mainWindow.webContents);
  mainWindow.webContents.send = (ch, ev) => {
    try {
      mobileBridge.broadcast(ch, ev);
    } catch {}
    return _wcSend(ch, ev);
  };
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ─────────────────────────── Пользовательский терминал (нижняя панель, как в Replit) ───────────────────────────
let userTerm = null; // { child, buf, exited, startedAt }

function termEmit(ev) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("term:event", ev);
}

// Показывает команду и вывод агента в нижнем терминале приложения (как Replit Agent):
// пользователь видит, что агент выполняет, даже если панель откроют позже.
function termAgentEcho(text) {
  const clean = stripAnsi(String(text || ""));
  if (!clean) return;
  if (userTerm && !userTerm.exited) {
    const lines = clean.split("\n");
    userTerm.buf.push(...lines);
    if (userTerm.buf.length > 2000) userTerm.buf.splice(0, userTerm.buf.length - 2000);
  }
  termEmit({ type: "agent", text: clean });
}

function termStart(cwd) {
  if (userTerm && !userTerm.exited) return { ok: false, error: "Терминал уже запущен" };
  const isWin = process.platform === "win32";
  const shell = isWin ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const args = isWin ? ["/Q"] : [];
  let child = null;
  try {
    child = spawn(shell, args, {
      cwd: cwd || os.homedir(),
      detached: !isWin,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", FORCE_COLOR: "0", ...agentEnv },
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const rec = { child, buf: [], exited: false, startedAt: Date.now() };
  userTerm = rec;
  const push = (chunk) => {
    const text = stripAnsi(chunk.toString());
    rec.buf.push(text);
    if (rec.buf.length > 2000) rec.buf.splice(0, rec.buf.length - 2000);
    termEmit({ type: "out", text });
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("exit", (code) => {
    rec.exited = true;
    termEmit({ type: "exit", code });
  });
  child.on("error", (e) => {
    rec.exited = true;
    termEmit({ type: "exit", code: null, error: e.message });
  });
  termEmit({ type: "start", cwd });
  return { ok: true, cwd };
}

function termInput(text) {
  if (!userTerm || userTerm.exited) return { ok: false, error: "Терминал не запущен. Перезапусти панель." };
  try {
    userTerm.child.stdin.write(String(text) + "\n");
    termEmit({ type: "in", text: String(text) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function termStop() {
  if (!userTerm) return { ok: false, error: "Терминал не запущен" };
  const rec = userTerm;
  userTerm = null;
  bgKill(rec);
  return { ok: true };
}

// Автодополнение команды в терминале (Tab): команды из PATH или файлы рабочей папки.
function termComplete(line) {
  const text = String(line || "");
  const cwd = agentWorkDir(loadSettings());
  const sp = text.lastIndexOf(" ");
  const token = sp >= 0 ? text.slice(sp + 1) : text;
  const base = sp >= 0 ? text.slice(0, sp + 1) : "";
  const matches = [];
  const listDir = (dir, prefix, fullPrefix) => {
    try {
      for (const e of fs.readdirSync(dir)) {
        if (!e.startsWith(prefix)) continue;
        let isDir = false;
        try { isDir = fs.statSync(path.join(dir, e)).isDirectory(); } catch {}
        matches.push(fullPrefix + e + (isDir ? "/" : ""));
      }
    } catch {}
  };
  if (!token) {
    listDir(cwd, "", ""); // пустой токен — файлы рабочей папки
  } else if (token.includes("/") || token.startsWith(".")) {
    const isAbs = path.isAbsolute(token);
    const slash = token.lastIndexOf("/");
    const dirPart = slash >= 0 ? token.slice(0, slash + 1) : "";
    const filePart = slash >= 0 ? token.slice(slash + 1) : token;
    const searchDir = isAbs ? (dirPart || "/") : path.join(cwd, dirPart);
    listDir(searchDir, filePart, dirPart);
  } else {
    const pathDirs = (process.env.PATH || "").split(path.delimiter);
    for (const d of pathDirs) {
      try {
        for (const e of fs.readdirSync(d)) {
          if (e.toLowerCase().startsWith(token.toLowerCase())) matches.push(e);
        }
      } catch {}
    }
    // Команд с таким префиксом нет — дополняем файлами рабочей папки (как в bash)
    if (!matches.length) listDir(cwd, token, "");
  }
  return { matches: [...new Set(matches)].sort().slice(0, 30), base, tokenLen: token.length };
}

// ─────────────────────────── IPC ───────────────────────────
ipcMain.handle("settings:get", () => loadSettings());
ipcMain.handle("settings:set", (_e, s) => {
  const prev = loadSettings();
  if (s && s.workingDir && prev.workingDir !== s.workingDir) {
    lastAgentRepoDir = null; // рабочая папка сменилась — сбрасываем «активный репозиторий»
  }
  const merged = normalizeSettings({ ...prev, ...(s || {}) });
  // При смене рабочей папки — сбрасываем локальную папку выбранного GitHub-репозитория,
  // чтобы не подхватывать старый путь от прошлой локации.
  if (s && s.workingDir && prev.workingDir !== s.workingDir) {
    merged.githubRepoDir = "";
    // Рабочая папка сменилась вручную — обновляем папку активного проекта, чтобы список не расходился.
    if (Array.isArray(merged.projects) && merged.activeProjectId) {
      const pr = merged.projects.find((p) => p.id === merged.activeProjectId);
      if (pr) pr.dir = merged.workingDir;
    }
  }
  agentEnv = (merged.agentEnv && typeof merged.agentEnv === "object") ? merged.agentEnv : {};
  // Мобильный доступ: при включении без PIN — генерируем его, затем применяем к мосту.
  if (merged.mobileEnabled && !merged.mobilePin) {
    merged.mobilePin = String(Math.floor(100000 + Math.random() * 900000));
  }
  saveSettings(merged);
  mobileBridge.applySettings(merged);
  return merged;
});

// ─────────────────────────── Мобильный доступ (LAN + PWA + PIN) ───────────────────────────
ipcMain.handle("mobile:status", () => mobileBridge.status());
ipcMain.handle("mobile:pinRegen", () => {
  const s = loadSettings();
  s.mobilePin = String(Math.floor(100000 + Math.random() * 900000));
  saveSettings(s);
  mobileBridge.applySettings(s);
  return mobileBridge.status();
});

// ─────────────────────────── Проекты (до 10, переключение) ───────────────────────────
// Возвращает список проектов (свежие сверху) и id активного.
ipcMain.handle("projects:list", () => {
  const s = loadSettings();
  const list = (Array.isArray(s.projects) ? s.projects : [])
    .map((p) => ({
      id: p.id,
      name: p.name,
      dir: p.dir,
      exists: !!(p.dir && fs.existsSync(p.dir)),
      lastOpened: p.lastOpened || 0,
    }))
    .sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
  return { ok: true, projects: list, activeId: s.activeProjectId || "" };
});

// Создаёт проект: имя + папка (если не указана — ~/Имя). Становится активным. Максимум 10.
ipcMain.handle("projects:create", async (_e, name, dir) => {
  const s = loadSettings();
  const list = Array.isArray(s.projects) ? s.projects : [];
  if (list.length >= 10) return { ok: false, error: "Достигнут лимит: максимум 10 проектов. Удали один из списка (🗑 — папка не удаляется)." };
  const nm = String(name || "").trim();
  if (!nm) return { ok: false, error: "Введи название проекта." };
  if (nm.length > 60) return { ok: false, error: "Название слишком длинное (до 60 символов)." };
  const safe = nm.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 60) || "Проект";
  const target = (typeof dir === "string" && dir.trim()) ? dir.trim() : path.join(os.homedir(), safe);
  const prep = ensureWritableDir(target);
  if (!prep.ok) return prep;
  const abs = prep.dir;
  const dup = list.find((p) => p.dir && path.resolve(p.dir) === abs);
  if (dup) return { ok: false, error: "Эта папка уже используется проектом «" + dup.name + "»." };
  const id = "p-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const entry = { id, name: nm, dir: abs, createdAt: Date.now(), lastOpened: Date.now() };
  const merged = { ...s, projects: [...list, entry], activeProjectId: id, workingDir: abs, githubRepoDir: "" };
  saveSettings(merged);
  lastAgentRepoDir = null; // рабочая папка сменилась — сбрасываем «активный репозиторий»
  return { ok: true, project: entry };
});

// Переключает активный проект: его папка становится workingDir.
ipcMain.handle("projects:activate", (_e, id) => {
  const s = loadSettings();
  const list = Array.isArray(s.projects) ? s.projects : [];
  const p = list.find((x) => x.id === id);
  if (!p) return { ok: false, error: "Проект не найден." };
  if (!p.dir || !fs.existsSync(p.dir)) {
    return { ok: false, error: "Папка проекта больше не существует: " + (p.dir || "?") + " — убери проект из списка (🗑) и создай заново." };
  }
  p.lastOpened = Date.now();
  const merged = { ...s, projects: list, activeProjectId: id, workingDir: p.dir, githubRepoDir: "" };
  saveSettings(merged);
  lastAgentRepoDir = null;
  clonedRepoPending = false; // флаг «только что склонирован» не переносится между проектами
  activeRunUndo = []; // undo-снимки предыдущего проекта не применяются в новом
  return { ok: true, project: p };
});

// Убирает проект из списка (папка на диске НЕ удаляется).
ipcMain.handle("projects:remove", (_e, id) => {
  const s = loadSettings();
  const list = Array.isArray(s.projects) ? s.projects : [];
  const rest = list.filter((p) => p.id !== id);
  if (rest.length === list.length) return { ok: false, error: "Проект не найден." };
  let activeId = s.activeProjectId;
  const merged0 = { ...s, projects: rest };
  if (activeId === id) {
    const next = [...rest].sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))[0];
    if (next) {
      activeId = next.id;
      merged0.workingDir = next.dir;
    } else {
      activeId = "";
      merged0.workingDir = s.workingDir; // текущая папка не выдёргивается, просто список пуст
    }
  }
  const merged = { ...merged0, activeProjectId: activeId };
  if (!activeId) merged.githubRepoDir = "";
  saveSettings(merged);
  if (!activeId) lastAgentRepoDir = null;
  return { ok: true, activeId };
});

ipcMain.handle("term:start", () => termStart(agentWorkDir(loadSettings())));
ipcMain.handle("term:input", (_e, text) => termInput(text));
ipcMain.handle("term:stop", () => termStop());
ipcMain.handle("term:status", () => ({ running: !!(userTerm && !userTerm.exited) }));
ipcMain.handle("term:complete", (_e, line) => termComplete(line));

// ─────────────────────────── Быстрый запуск проекта (превью) ───────────────────────────
// Пользователь сам запускает dev-сервер проекта и останавливает его (освобождая порт).
let devRun = null; // { rec, command, cwd }

function devEmit(ev) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("dev:event", ev);
}

// Автоопределение команды запуска по package.json проекта.
function detectDevCommand(dir) {
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {}
  const scripts = (pkg && pkg.scripts) || {};
  const hasBun =
    fs.existsSync(path.join(dir, "bun.lockb")) ||
    fs.existsSync(path.join(dir, "bun.lock")) ||
    fs.existsSync(path.join(dir, "bunfig.toml"));
  if (scripts.dev) return hasBun ? "bun run dev" : "npm run dev";
  if (scripts.start) return hasBun ? "bun run start" : "npm start";
  if (scripts.serve) return "npm run serve";
  return "";
}

function devStart(dir, command) {
  const d = sanitizeDir(dir) || agentWorkDir(loadSettings());
  if (!d || !fs.existsSync(d)) return { ok: false, error: "Папка проекта не найдена" };
  if (devRun && devRun.rec && !devRun.rec.exited) {
    return { ok: false, error: "Проект уже запущен — сначала останови его (⏹)." };
  }
  const cmd = String(command || "").trim() || detectDevCommand(d);
  if (!cmd) return { ok: false, error: "Не найден скрипт запуска (dev/start в package.json). Укажи команду вручную." };
  let rec;
  try {
    rec = bgSpawn(cmd, { cwd: d, name: "dev:" + cmd.slice(0, 50) });
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  devRun = { rec, command: cmd, cwd: d };
  const push = (chunk) => devEmit({ type: "out", text: stripAnsi(chunk.toString()) });
  rec.child.stdout.on("data", push);
  rec.child.stderr.on("data", push);
  rec.child.on("exit", (code) => {
    if (devRun && devRun.rec === rec) devRun = null;
    devEmit({ type: "exit", code });
  });
  rec.child.on("error", (e) => {
    if (devRun && devRun.rec === rec) devRun = null;
    devEmit({ type: "exit", code: null, error: e.message });
  });
  devEmit({ type: "start", command: cmd, cwd: d });
  return { ok: true, command: cmd, cwd: d };
}

async function devStop() {
  const stopped = [];
  if (devRun && devRun.rec && !devRun.rec.exited) {
    const rec = devRun.rec;
    devRun = null;
    bgKill(rec);
    stopped.push(rec.name || rec.command);
  }
  // Порт тоже освобождаем: процесс мог быть запущен агентом (startBackground /
  // runCommandOutput для сервера) или остаться сиротой от прошлого запуска.
  const port = parsePortFromUrl(loadSettings().previewUrl);
  if (port) {
    const r = await killProcessesOnPort(port);
    if (r && r.ok && r.killed && r.killed.length) stopped.push("порт " + port + " (PID " + r.killed.join(", ") + ")");
  }
  if (!stopped.length) return { ok: false, error: "Проект не запущен (процесс и порт свободны)" };
  devEmit({ type: "stopped" });
  return { ok: true, stopped };
}

function devStatus(dir) {
  if (devRun && devRun.rec && devRun.rec.exited) devRun = null;
  const d = sanitizeDir(dir) || agentWorkDir(loadSettings());
  return {
    ok: true,
    running: !!(devRun && devRun.rec && !devRun.rec.exited),
    command: devRun ? devRun.command : "",
    cwd: devRun ? devRun.cwd : "",
    detected: d && fs.existsSync(d) ? detectDevCommand(d) : "",
  };
}

ipcMain.handle("dev:start", (_e, dir, command) => devStart(dir, command));
ipcMain.handle("dev:stop", () => devStop());
ipcMain.handle("dev:status", (_e, dir) => devStatus(dir));

// Локальный self-update (OTA): статус, проверка, откат, открыть папку
ipcMain.handle("ota:status", () => ota.status(loadSettings()));
ipcMain.handle("ota:check", async () => {
  try {
    return await ota.check(loadSettings());
  } catch (e) {
    return { status: "error", message: e.message || String(e) };
  }
});
ipcMain.handle("ota:rollback", () => ota.rollback());
ipcMain.handle("ota:openDir", () => ota.openDir());

ipcMain.handle("chats:load", () => loadChats());
ipcMain.handle("chats:save", (_e, d) => {
  saveChats(d);
  return true;
});

ipcMain.handle("ai:send", async (_e, messages, opts) => {
  const settings = loadSettings();
  global.__agentRunning = true;
  try {
    await runAi(settings, messages || [], mainWindow, opts || {});
    return { ok: true };
  } catch (e) {
    const msg = e.name === "AbortError" ? "⏹ Генерация остановлена" : e.message || String(e);
    // Даже при ошибке изменения файлов, сделанные до неё, должны откатываться
    if (activeRunUndo.length) {
      lastUndoLog = activeRunUndo.slice();
      persistUndo();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("ai:event", { type: "undo_available", count: lastUndoLog.length });
      }
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("ai:event", { type: "error", message: msg });
    }
    return { ok: false, error: msg };
  } finally {
    global.__agentRunning = false;
  }
});

// Ответ пользователя на вопрос агента (askUser)
ipcMain.handle("ai:answer", (_e, text) => {
  if (pendingAsk) {
    const r = pendingAsk;
    pendingAsk = null;
    r(text);
    return true;
  }
  return false;
});

// ─── Откат изменений агента (чекпоинт последнего запуска) ───
ipcMain.handle("undo:status", () => {
  loadPersistedUndo(); // чекпоинт мог остаться после перезапуска приложения
  return {
    ok: true,
    count: lastUndoLog.length,
    files: lastUndoLog.map((u) => u.path),
  };
});

ipcMain.handle("undo:rollback", () => {
  loadPersistedUndo();
  const restored = [];
  for (let i = lastUndoLog.length - 1; i >= 0; i--) {
    const u = lastUndoLog[i];
    try {
      if (u.content === null) {
        if (fs.existsSync(u.path)) fs.unlinkSync(u.path); // файл создан агентом — удаляем
      } else {
        fs.writeFileSync(u.path, u.content, "utf8"); // возвращаем прежнее содержимое
      }
      restored.push(u.path);
    } catch (e) {
      restored.push(u.path + " (ошибка: " + (e.message || String(e)) + ")");
    }
  }
  const count = restored.length;
  lastUndoLog = [];
  activeRunUndo = [];
  try { fs.unlinkSync(undoFile()); } catch {} // чекпоинт израсходован
  return { ok: true, count, restored };
});

ipcMain.handle("ai:stop", () => {
  if (activeAbort) activeAbort.abort();
  if (pendingAsk) {
    const r = pendingAsk;
    pendingAsk = null;
    r("");
  }
  return true;
});

ipcMain.handle("ai:test", async (_e, ui) => {
  const s = normalizeSettings({ ...loadSettings(), ...(ui || {}) });
  try {
    const models = await fetchModels(s);
    return { ok: true, message: "Подключено! Найдено моделей: " + models.length, models };
  } catch (e) {
    return { ok: false, message: e.message || String(e), models: [] };
  }
});

// ── G4F: тест провайдера (кнопка ▶ в настройках) — логи в консоль приложения ──
// Делается в главном процессе: здесь нет CORS и видно сырые статусы/тела ответов g4f.
ipcMain.handle("g4f:test", async (_e, opts) => {
  const log = [];
  const push = (level, text) => log.push({ level, text });
  const t0 = Date.now();
  const base = String((opts && opts.url) || "").trim().replace(/\/+$/, "");
  const provider = String((opts && opts.provider) || "").trim();
  const model = String((opts && opts.model) || "").trim();
  const fetchT = (url, init, timeoutMs) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
    return fetch(url, Object.assign({ signal: ctrl.signal, redirect: "follow" }, init || {})).finally(() => clearTimeout(t));
  };
  const textT = (res) => res.text().catch(() => "");
  push("info", "Проверка G4F: провайдер «" + (provider || "?") + "» → " + (base || "URL пуст"));
  if (!/^https?:\/\//i.test(base)) {
    push("err", "Базовый URL не заполнен или не похож на http://localhost:1337/v1 — поправь поле URL.");
    return { ok: false, log };
  }
  // 1) Список моделей
  const mUrl = base + "/models";
  try {
    const res = await fetchT(mUrl, {}, 15000);
    const body = await textT(res);
    push("info", "GET " + mUrl + " → HTTP " + res.status + " (" + (Date.now() - t0) + " мс)");
    if (!res.ok) {
      push("err", "Ответ не 2xx: " + body.slice(0, 300));
    } else {
      let arr = [];
      try {
        const j = JSON.parse(body);
        const list = Array.isArray(j) ? j : (j.data || j.models || []);
        arr = list.map((m) => (typeof m === "string" ? m : (m && (m.id || m.name)) || "")).filter(Boolean);
      } catch {}
      if (arr.length) push("ok", "Моделей отдаёт: " + arr.length + ". Первые: " + arr.slice(0, 8).join(", "));
      else push("warn", "Список моделей пуст или в неожиданном формате: " + body.slice(0, 200));
    }
  } catch (e) {
    push("err", "GET /models не прошёл: " + (e.message || String(e)) + ". Проверь, что g4f запущен («g4f api») и порт правильный (1337 / 8080).");
  }
  // 2) Минимальный чат-запрос: что РЕАЛЬНО отвечает провайдер
  if (provider && provider !== "default" && model) {
    const cUrl = base + "/chat/completions";
    push("info", "POST " + cUrl + " — модель «" + model + "» через провайдера «" + provider + "» (max_tokens 8)");
    const t1 = Date.now();
    try {
      const res = await fetchT(cUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          provider,
          messages: [{ role: "user", content: "Ответь одним словом: пинг" }],
          max_tokens: 8,
          stream: false,
        }),
      }, 30000);
      const body = await textT(res);
      if (!res.ok) {
        push("err", "HTTP " + res.status + " (" + (Date.now() - t1) + " мс): " + body.slice(0, 400));
      } else {
        let snippet = "";
        try {
          const j = JSON.parse(body);
          const c0 = j.choices && j.choices[0];
          snippet = c0 && c0.message && c0.message.content
            ? String(c0.message.content).trim().slice(0, 140)
            : (c0 && c0.text ? String(c0.text).trim().slice(0, 140) : "");
        } catch {}
        if (snippet) push("ok", "Ответ получен (" + (Date.now() - t1) + " мс): «" + snippet + "» — провайдер отвечает.");
        else push("warn", "HTTP 200, но текста в ответе нет (" + (Date.now() - t1) + " мс). Сырой ответ: " + body.slice(0, 300));
      }
    } catch (e) {
      push("err", "POST /chat/completions не прошёл: " + (e.message || String(e)));
    }
  } else if (provider === "default") {
    push("warn", "Провайдер «default» — авто-режим: проверяется только список моделей, чат-тест пропущен.");
  } else {
    push("warn", "Модель не указана — чат-тест пропущен. Выбери модель провайдера (чипы ниже) и повтори.");
  }
  push("info", "— Проверка завершена за " + (Date.now() - t0) + " мс —");
  return { ok: true, log };
});


ipcMain.handle("ai:models", async (_e, ui) => {
  const s = normalizeSettings({ ...loadSettings(), ...(ui || {}) });
  try {
    return { ok: true, models: await fetchModels(s) };
  } catch (e) {
    return { ok: false, message: e.message || String(e), models: [] };
  }
});

ipcMain.handle("dialog:pickDir", async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Выберите рабочую директорию",
  });
  return r.canceled ? null : r.filePaths[0];
});

// ─────────────────────────── GitHub OAuth (device flow) + repo picker ───────────────────────────
let githubPollTimer = null;
let githubPollActive = false;
const GITHUB_API = "https://api.github.com";

/** Гарантирует, что папка существует и доступна на запись (клонирование, создание файлов).
 *  Возвращает { ok:true, dir } или { ok:false, error } с понятной подсказкой. */
function ensureWritableDir(dir) {
  const abs = dir && typeof dir === "string" && dir.trim() ? path.resolve(String(dir).trim()) : "";
  if (!abs) return { ok: false, error: "Не указана рабочая директория — выбери её в Настройках → Проект (📁) или в панели проекта." };
  try {
    fs.mkdirSync(abs, { recursive: true });
  } catch (e) {
    return { ok: false, error: "Не удалось создать папку: " + abs + " — " + (e.message || String(e)) };
  }
  try {
    fs.accessSync(abs, fs.constants.W_OK);
  } catch (e) {
    return {
      ok: false,
      error: "Нет прав на запись в папку: " + abs + " (Permission denied). " +
        "Клонирование и создание файлов в ней невозможны — выбери другую рабочую директорию " +
        "(📁 в панели проекта или Настройки → Проект): обычную папку на диске, а не защищённую системную.",
    };
  }
  // Реальная проверка записи: git падает с «could not create work tree dir ... Permission denied»,
  // даже когда accessSync(W_OK) проходит (OneDrive Files On-Demand, защищённые/сетевые/системные папки).
  // Поэтому создаём и удаляем временную подпапку — точно как это сделает git при клонировании.
  const probe = path.join(abs, ".ai-agent-write-test");
  try {
    fs.mkdirSync(probe);
  } catch (e) {
    if (e.code !== "EEXIST") {
      return {
        ok: false,
        error: "В папке нет прав на запись — git не сможет создать тут репозиторий: " + abs + " (" + (e.message || String(e)) + "). " +
          "Выбери другую рабочую директорию (📁 в панели проекта): обычную локальную папку на диске " +
          "(например, C:\\Users\\<имя>\\projects) — не системную, не сетевую и не синхронизируемую OneDrive.",
      };
    }
  }
  try {
    fs.rmdirSync(probe);
  } catch {}
  return { ok: true, dir: abs };
}

/** Клонирует URL в workersDir и возвращает путь к папке репозитория. */
async function cloneRepoTo(url, workersDir, settings) {
  const prep = ensureWritableDir(workersDir);
  if (!prep.ok) return prep;
  workersDir = prep.dir;
  const name = repoNameFromUrl(url);
  const target = path.join(workersDir, name);
  if (fs.existsSync(target)) {
    // Пустая папка (например, от прошлой неудачной попытки клонирования) — убираем и клонируем заново.
    let empty = false;
    try {
      empty = fs.readdirSync(target).length === 0;
    } catch {}
    if (empty) {
      try {
        fs.rmdirSync(target);
      } catch (e) {
        return { ok: false, error: "Папка " + target + " пустая, но не удалось её очистить: " + (e.message || String(e)) };
      }
    } else {
      const info = await runGit(target, ["remote", "get-url", "origin"], settings);
      if (info.ok) {
        const cleanOrigin = stripUrlCreds(info.out.trim());
        if (cleanOrigin === stripUrlCreds(url)) {
          // В origin мог застрять токен (клон вручную с https://user:TOKEN@...) — убираем его из .git/config.
          if (info.out.trim() !== cleanOrigin) {
            await runGit(target, ["remote", "set-url", "origin", cleanOrigin], settings);
          }
          return { ok: true, dir: target, cloned: false, message: "Репозиторий уже есть: " + target };
        }
      }
      return { ok: false, error: "В рабочей папке уже есть папка \"" + name + "\". Удали её или выбери другую рабочую папку." };
    }
  }
  const r = await runGit(workersDir, ["clone", url, name], settings);
  if (!r.ok) {
    const denied = /permission denied|отказано в доступе|could not create work tree dir|eacces/i.test(r.err);
    if (denied) {
      // Приложение пишет в папку, а git — нет (антивирус или «Контролируемый доступ к папкам»
      // Windows блокирует именно git.exe). Пробуем запасные записываемые папки.
      const mainKey = path.resolve(workersDir).toLowerCase();
      for (const cand of cloneBaseCandidates("", settings)) {
        const prep = ensureWritableDir(cand);
        if (!prep.ok) continue;
        if (path.resolve(prep.dir).toLowerCase() === mainKey) continue;
        const fbTarget = path.join(prep.dir, name);
        if (fs.existsSync(fbTarget)) continue;
        const r2 = await runGit(prep.dir, ["clone", url, name], settings);
        if (r2.ok) {
          if (stripUrlCreds(url) !== url) {
            await runGit(fbTarget, ["remote", "set-url", "origin", stripUrlCreds(url)], settings);
          }
          return {
            ok: true,
            dir: fbTarget,
            cloned: true,
            message: "Клонировано: " + fbTarget + " (в рабочей папке «" + workersDir + "» git не смог создать файлы — использована записываемая папка)",
          };
        }
      }
    }
    return {
      ok: false,
      error: r.err + (denied
        ? "\n\nGit не смог создать папку репозитория в «" + workersDir + "». Папка защищена от записи " +
          "(или доступ блокирует антивирус/OneDrive). Выбери другую рабочую директорию (📁 в панели проекта) " +
          "— например C:\\Users\\<имя>\\projects — и нажми «Выгрузить» ещё раз."
        : ""),
    };
  }
  if (stripUrlCreds(url) !== url) {
    await runGit(target, ["remote", "set-url", "origin", stripUrlCreds(url)], settings);
  }
  return { ok: true, dir: target, cloned: true, message: "Клонировано: " + target };
}

function isGitHubRepoSlug(v) {
  const s = String(v || "").trim();
  return /^[\w.-]+\/[\w.-]+$/i.test(s) && !s.includes("/") === false && s.indexOf("/") > 0;
}

function githubEmit(ev) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("github:event", ev);
}

async function githubApiFetch(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 300) };
}

async function fetchGithubUser(token) {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "User-Agent": "AI-Developer-Agent",
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

ipcMain.handle("github:user", async () => {
  const s = loadSettings();
  if (!s.githubToken) return { ok: false, error: "Не подключено" };
  const u = await fetchGithubUser(s.githubToken);
  if (!u) return { ok: false, error: "Не удалось получить профиль GitHub (токен мог быть отозван)" };
  const merged = { ...s, githubLogin: u.login || s.githubLogin, githubAvatarUrl: u.avatar_url || s.githubAvatarUrl };
  saveSettings(merged);
  return { ok: true, login: u.login, avatar: u.avatar_url };
});

// ── Репозитории GitHub: список >100 шт. через пагинацию, поиск — через search API ──
function mapGithubRepo(r) {
  if (!r || typeof r.name !== "string" || !r.owner || typeof r.owner.login !== "string") return null;
  const currentLogin = loadSettings().githubLogin || "";
  return {
    slug: r.owner.login + "/" + r.name,
    name: r.name,
    owner: r.owner.login,
    full_name: r.full_name || (r.owner.login + "/" + r.name),
    url: (r.clone_url || "https://github.com/" + r.owner.login + "/" + r.name + ".git"),
    description: r.description || "",
    isPrivate: r.private || false,
    default_branch: r.default_branch || "main",
    language: r.language || "",
    updated: r.updated_at || "",
    own: currentLogin === r.owner.login,
  };
}

function ghApiHeaders(token) {
  return {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "User-Agent": "AI-Developer-Agent",
  };
}

async function ghApiJson(url, token) {
  try {
    const res = await fetch(url, { headers: ghApiHeaders(token) });
    const text = await res.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, json, text: (text || "").slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: (e && e.message) || String(e) };
  }
}

// Страница списка «мои репозитории» (аккаунт + коллаборации + организации).
async function githubReposPage(token, page) {
  const n = Math.max(1, parseInt(page, 10) || 1);
  const url = GITHUB_API + "/user/repos?per_page=100&page=" + n + "&sort=updated&affiliation=owner,collaborator,organization_member";
  const res = await ghApiJson(url, token);
  if (!res.ok) return { ok: false, error: "GitHub API " + res.status + ": " + (res.text || res.status) };
  const data = Array.isArray(res.json) ? res.json : [];
  const repos = data.map(mapGithubRepo).filter(Boolean);
  return { ok: true, repos, hasMore: repos.length === 100 };
}

let githubOrgsCache = { at: 0, list: [] };
async function githubUserOrgs(token) {
  if (Date.now() - githubOrgsCache.at < 5 * 60 * 1000) return githubOrgsCache.list;
  try {
    const res = await ghApiJson(GITHUB_API + "/user/orgs?per_page=100", token);
    if (res.ok && Array.isArray(res.json)) {
      githubOrgsCache = { at: Date.now(), list: res.json.map((o) => o && o.login).filter(Boolean) };
    }
  } catch {}
  return githubOrgsCache.list;
}

async function githubLoginFor(token) {
  const s = loadSettings();
  if (s.githubLogin) return s.githubLogin;
  const u = await fetchGithubUser(token);
  if (u && u.login) {
    try { saveSettings({ ...loadSettings(), githubLogin: u.login }); } catch {}
    return u.login;
  }
  return "";
}

// Поиск по имени: ищем параллельно по аккаунту и его организациям (приватные репозитории
// видны в поиске только со scope-квалификатором user:/org:), затем сливаем и сортируем.
const ghSearchCache = new Map(); // key: нормализованный запрос -> { at, res } (кэш 45 c)
async function githubReposSearch(token, q) {
  const key = String(q || "").trim().toLowerCase();
  const hit = ghSearchCache.get(key);
  if (hit && Date.now() - hit.at < 45000) return hit.res;
  const login = await githubLoginFor(token);
  const orgs = (await githubUserOrgs(token)).slice(0, 8);
  const scopes = [];
  if (login) scopes.push("user:" + login);
  for (const o of orgs) scopes.push("org:" + o);
  const collected = [];
  const jobs = scopes.map(async (scope) => {
    const url = GITHUB_API + "/search/repositories?q=" + encodeURIComponent(String(q).trim() + " in:name " + scope) +
      "&per_page=100&sort=updated&order=desc";
    const res = await ghApiJson(url, token);
    if (res.ok && res.json && Array.isArray(res.json.items)) {
      for (const it of res.json.items) collected.push(it);
    }
    return res.status;
  });
  await Promise.all(jobs);
  const seen = new Set();
  const repos = [];
  for (const it of collected) {
    const r = mapGithubRepo(it);
    if (!r || seen.has(r.slug)) continue;
    seen.add(r.slug);
    repos.push(r);
  }
  repos.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  const capped = repos.slice(0, 150);
  const res = { ok: true, repos: capped, hasMore: false, total: repos.length, searched: true };
  ghSearchCache.set(key, { at: Date.now(), res });
  return res;
}

// Точный slug owner/repo — одним запросом (не зависит от списка из 100 и от принадлежности).
async function githubRepoBySlug(token, slug) {
  const res = await ghApiJson(GITHUB_API + "/repos/" + String(slug).trim(), token);
  if (!res.ok) return { ok: false, error: "Репозиторий не найден или нет к нему доступа: " + slug + " (GitHub API " + res.status + ")" };
  const r = mapGithubRepo(res.json);
  return r ? { ok: true, repo: r } : { ok: false, error: "Неожиданный ответ GitHub API" };
}

// База для клонирования: явно указанная папка (создаётся, если её ещё нет) → сохранённая
// рабочая директория → домашняя. Никогда не «теряем» клон в неожиданном месте.
// База для клонирования: запрошенная папка → сохранённая рабочая → домашняя → Документы → временная.
// Берём первую, куда РЕАЛЬНО можно писать: git падает «Permission denied» на защищённых,
// сетевых, системных папках и профилях без прав (OneDrive, Program Files и т.п.).
// Кандидаты папок для клонирования по порядку предпочтения (без повторов).
function cloneBaseCandidates(workingDir, s) {
  const candidates = [];
  const push = (d) => {
    const t = typeof d === "string" && d.trim() ? d.trim() : "";
    if (t) candidates.push(t);
  };
  push(workingDir);
  if (s) push(s.workingDir);
  push(os.homedir());
  try { push(app.getPath("documents")); } catch {}
  push(os.tmpdir());
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = path.resolve(c).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// База для клонирования: запрошенная папка → сохранённая рабочая → домашняя → Документы → временная.
// Берём первую, куда РЕАЛЬНО можно писать: git падает «Permission denied» на защищённых,
// сетевых, системных папках и профилях без прав (OneDrive, Program Files и т.п.).
function pickCloneBase(workingDir, s) {
  for (const c of cloneBaseCandidates(workingDir, s)) {
    const prep = ensureWritableDir(c);
    if (prep.ok) return prep; // { ok: true, dir }
  }
  return {
    ok: false,
    error: "Не нашлось ни одной папки, куда можно писать, для клонирования. Проверены: " + cloneBaseCandidates(workingDir, s).join(", "),
  };
}

// Публикация локальной папки как НОВОГО репозитория GitHub: создать репозиторий + первый push.
// dir — папка проекта (создаётся, если её ещё нет). opts: { name, description, private, message }.
async function publishLocalToGithub(dir, s, opts) {
  opts = opts || {};
  const name = String(opts.name || "").trim();
  const description = String(opts.description || "").trim().slice(0, 300);
  const isPrivate = opts.private !== false; // приватный по умолчанию — безопаснее
  if (!s || !s.githubToken) return { ok: false, error: "GitHub не подключён — подключи аккаунт в Настройках → GitHub." };
  if (!name) return { ok: false, error: "Укажи имя нового репозитория." };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.length > 100) {
    return { ok: false, error: "Недопустимое имя репозитория «" + name + "»: только буквы, цифры, точка, дефис и подчёркивание (без пробелов, не начинается с точки)." };
  }
  const prep = ensureWritableDir(dir);
  if (!prep.ok) return prep;
  dir = prep.dir;
  // Если в папке уже есть origin — это существующий репозиторий, а не «новый»: пусть используют Push.
  const originR = await runGit(dir, ["remote", "get-url", "origin"], s);
  if (originR.ok && String(originR.out || "").trim()) {
    return { ok: false, error: "В папке уже настроен удалённый репозиторий origin: " + stripUrlCreds(String(originR.out).trim()) + ". Используй Push во вкладке «Изменения», а не публикацию нового репозитория." };
  }
  // Владелец (аккаунт, куда создаём)
  let login = String(s.githubLogin || "").trim();
  if (!login) {
    const u = await fetchGithubUser(s.githubToken);
    if (u && u.login) login = String(u.login).trim();
  }
  if (!login) return { ok: false, error: "Не удалось определить GitHub-логин — токен мог быть отозван. Подключи GitHub заново в Настройках." };
  // git init, если папка ещё не репозиторий
  const inRepo = await runGit(dir, ["rev-parse", "--is-inside-work-tree"], s);
  if (!inRepo.ok) {
    let initR = await runGit(dir, ["init", "-b", "main"], s);
    if (!initR.ok) initR = await runGit(dir, ["init"], s); // старые версии git без -b
    if (!initR.ok) return { ok: false, error: "git init не удался: " + initR.err };
  }
  // Ветка для публикации: текущая (если репозиторий с коммитами), иначе создаём main.
  let branch = "main";
  const brR = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"], s);
  const curBranch = brR.ok ? String(brR.out || "").trim() : "";
  if (curBranch && curBranch !== "HEAD") {
    branch = curBranch;
    if (branch === "master") {
      const rn = await runGit(dir, ["branch", "-M", "main"], s); // переименовываем в main
      if (rn.ok) branch = "main";
    }
  } else {
    const co = await runGit(dir, ["checkout", "-b", "main"], s);
    if (!co.ok && !(await runGit(dir, ["rev-parse", "--verify", "HEAD"], s)).ok) {
      return { ok: false, error: "Не удалось создать ветку main: " + co.err };
    }
  }
  // Создаём репозиторий на GitHub (POST /user/repos)
  let createRes;
  try {
    createRes = await fetch(GITHUB_API + "/user/repos", {
      method: "POST",
      headers: ghApiHeaders(s.githubToken),
      body: JSON.stringify({ name, description, private: isPrivate, auto_init: false }),
    });
  } catch (e) {
    return { ok: false, error: "Ошибка запроса к GitHub API: " + (e && e.message ? e.message : String(e)) };
  }
  const createText = await createRes.text().catch(() => "");
  let createJson = null;
  try { createJson = JSON.parse(createText); } catch {}
  if (createRes.status !== 201) {
    let reason = "GitHub API " + createRes.status + ": " + String(createText || "").slice(0, 200);
    if (createJson && createJson.message) reason = String(createJson.message);
    if (createRes.status === 422) {
      reason = "Не удалось создать репозиторий «" + name + "»: он уже существует на этом аккаунте или имя недопустимо.";
    }
    return { ok: false, error: reason };
  }
  const repoUrl = (createJson && createJson.html_url) || ("https://github.com/" + login + "/" + name);
  const cloneUrl = (createJson && createJson.clone_url) || ("https://github.com/" + login + "/" + name + ".git");
  // remote origin (в URL нет токена — авторизация идёт заголовком Basic в runGit)
  const addR = await runGit(dir, ["remote", "add", "origin", cloneUrl], s);
  if (!addR.ok) return { ok: false, error: "Репозиторий создан: " + repoUrl + ".\nНо не удалось добавить remote origin: " + addR.err };
  // Коммитим файлы, если есть что коммитить (первый коммит или незакоммиченные изменения)
  const stR = await runGit(dir, ["status", "--porcelain"], s);
  const headOk = (await runGit(dir, ["rev-parse", "--verify", "HEAD"], s)).ok;
  const changes = stR.ok && !!String(stR.out || "").trim();
  if (changes) {
    const addAll = await runGit(dir, ["add", "-A"], s);
    if (!addAll.ok) return { ok: false, error: "Репозиторий создан: " + repoUrl + ".\ngit add не удался: " + addAll.err };
    const msg = String(opts.message || "").trim() || "Initial commit";
    const cm = await runGit(dir, ["-c", "user.name=AI Agent", "-c", "user.email=ai-agent@local", "commit", "-m", msg], s);
    if (!cm.ok) return { ok: false, error: "Репозиторий создан: " + repoUrl + ".\nНе удалось создать коммит: " + cm.err };
  } else if (!headOk) {
    return { ok: false, error: "Репозиторий создан: " + repoUrl + ".\nНо в папке нет файлов — нечего коммитить. Добавь файлы и нажми «Опубликовать» снова." };
  }
  // Пуш (авторизация — заголовок Basic, который runGit подставляет из githubToken)
  const pushR = await runGit(dir, ["push", "-u", "origin", branch], s);
  if (!pushR.ok) return { ok: false, error: "Репозиторий создан: " + repoUrl + ".\nPush не удался: " + pushR.err };
  // Новый пустой репозиторий GitHub по умолчанию может указывать на master —
  // переключаем ветку по умолчанию на опубликованную (иначе репозиторий откроется «пустым»).
  try {
    await fetch(GITHUB_API + "/repos/" + encodeURIComponent(login + "/" + name), {
      method: "PATCH",
      headers: ghApiHeaders(s.githubToken),
      body: JSON.stringify({ default_branch: branch }),
    });
  } catch {}
  // Запоминаем как активный репозиторий (панель проекта следует за ним)
  try { saveSettings({ ...loadSettings(), githubRepoSlug: login + "/" + name, githubRepoDir: dir }); } catch {}
  lastAgentRepoDir = dir;
  clonedRepoPending = true; // следующий ответ агента начнётся с анализа опубликованного проекта
  return {
    ok: true,
    slug: login + "/" + name,
    url: repoUrl,
    dir,
    message: "Создан репозиторий " + login + "/" + name + (isPrivate ? " (приватный)" : "") + " и выгружено на GitHub:\n" + repoUrl + "\nВетка: " + branch + ".",
  };
}

// Создать НОВЫЙ репозиторий на GitHub и выгрузить в него папку проекта (первый push).
ipcMain.handle("github:publish", async (_e, opts) => {
  const s = loadSettings();
  opts = opts || {};
  const reqDir = opts.dir && typeof opts.dir === "string" ? opts.dir.trim() : "";
  const dir = reqDir ? (sanitizeDir(reqDir) || reqDir) : agentWorkDir(s);
  const res = await publishLocalToGithub(dir, s, opts);
  if (res.ok) githubEmit({ type: "published", slug: res.slug, dir: res.dir, url: res.url });
  return res;
});

ipcMain.handle("github:repos", async (_e, opts) => {
  const s = loadSettings();
  if (!s.githubToken) return { ok: false, error: "Не подключено" };
  opts = opts || {};
  const query = String(opts.query || "").trim();
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const res = query ? await githubReposSearch(s.githubToken, query) : await githubReposPage(s.githubToken, page);
  if (!res.ok) return res;
  return { ok: true, repos: res.repos, query, page: query ? 1 : page, hasMore: !query && !!res.hasMore, total: res.total || res.repos.length };
});

ipcMain.handle("github:selectRepo", async (_e, repoSlug, workingDir) => {
  const s = loadSettings();
  if (!s.githubToken) return { ok: false, error: "Не подключено" };
  const slug = String(repoSlug || "").trim();
  if (!isGitHubRepoSlug(slug)) return { ok: false, error: "Неверное имя репозитория. Ожидается owner/repo." };
  const bySlug = await githubRepoBySlug(s.githubToken, slug);
  if (!bySlug.ok) return bySlug;
  const base = pickCloneBase(workingDir, s);
  if (!base.ok) return base;
  const cloneResult = await cloneRepoTo(bySlug.repo.url, base.dir, s);
  if (!cloneResult.ok) return cloneResult;
  const merged = { ...s, githubRepoSlug: slug, githubRepoDir: cloneResult.dir };
  saveSettings(merged);
  clonedRepoPending = true; // следующий ответ агента начнётся с анализа выбранного репозитория
  return { ok: true, slug: slug, dir: cloneResult.dir, cloned: cloneResult.cloned, message: cloneResult.message };
});

// Выбор репозитория БЕЗ клонирования: строка помечается, а клонирует уже явная кнопка «⬇ Выгрузить»
// (github:selectRepo) в рабочую директорию.
ipcMain.handle("github:pickRepo", async (_e, repoSlug) => {
  const s = loadSettings();
  if (!s.githubToken) return { ok: false, error: "Не подключено" };
  const slug = String(repoSlug || "").trim();
  if (!isGitHubRepoSlug(slug)) return { ok: false, error: "Неверное имя репозитория. Ожидается owner/repo." };
  const bySlug = await githubRepoBySlug(s.githubToken, slug);
  if (!bySlug.ok) return bySlug;
  saveSettings({ ...s, githubRepoSlug: slug, githubRepoDir: "" });
  return { ok: true, slug, repo: { name: bySlug.repo.name, owner: bySlug.repo.owner } };
});

ipcMain.handle("github:selectedRepo", async () => {
  const s = loadSettings();
  if (!s.githubToken) return { ok: false, error: "Не подключено" };
  if (!s.githubRepoSlug) return { ok: true, slug: null, dir: null };
  let dir = s.githubRepoDir && fs.existsSync(s.githubRepoDir) ? s.githubRepoDir : null;
  if (!dir) {
    // Репозиторий может быть только «выбран» (кнопка «⬇ Выгрузить» ещё не нажата) — папки нет,
    // тогда возвращаем null, и интерфейс покажет кнопку «⬇ Выгрузить».
    const base = s.workingDir && fs.existsSync(s.workingDir) ? s.workingDir : os.homedir();
    const name = repoNameFromUrl("https://github.com/" + s.githubRepoSlug + ".git");
    const cand = path.join(base, name);
    if (fs.existsSync(cand)) dir = cand;
  }
  return { ok: true, slug: s.githubRepoSlug, dir };
});

ipcMain.handle("github:unselectRepo", async () => {
  const merged = { ...loadSettings(), githubRepoSlug: "", githubRepoDir: "" };
  saveSettings(merged);
  return { ok: true };
});

async function readBody(res) { return (await res.text().catch(() => "")); }

ipcMain.handle("github:disconnect", () => {
  const merged = { ...loadSettings(), githubToken: "", githubLogin: "", githubAvatarUrl: "" };
  saveSettings(merged);
  return { ok: true };
});

ipcMain.handle("github:deviceCancel", () => {
  githubPollActive = false;
  if (githubPollTimer) { clearTimeout(githubPollTimer); githubPollTimer = null; }
  return true;
});

ipcMain.handle("github:deviceStart", async () => {
  const s = loadSettings();
  const clientId = (s.githubClientId || "").trim();
  if (!clientId) {
    return {
      ok: false,
      error:
        "Не указан Client ID OAuth-приложения. Создай приложение на github.com/settings/applications/new и вставь Client ID в настройки.",
    };
  }
  if (githubPollActive) return { ok: false, error: "Авторизация уже запущена. Сначала закрой текущее окно кода." };

  const { status, json } = await githubApiFetch("https://github.com/login/device/code", {
    client_id: clientId,
    scope: "repo",
  });
  if (status !== 200 || !json || !json.device_code) {
    return {
      ok: false,
      error: "GitHub не выдал код устройства: " + ((json && (json.error_description || json.error)) || "HTTP " + status),
    };
  }

  githubPollActive = true;
  const { device_code, user_code, verification_uri, expires_in, interval } = json;
  const deadline = Date.now() + (expires_in || 900) * 1000;

  const poll = async () => {
    if (!githubPollActive) return;
    if (Date.now() > deadline) {
      githubPollActive = false;
      githubEmit({ type: "expired", message: "Код истёк" });
      return;
    }
    const r = await githubApiFetch("https://github.com/login/oauth/access_token", {
      client_id: clientId,
      device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (!githubPollActive) return;
    if (r.json && r.json.access_token) {
      githubPollActive = false;
      const token = r.json.access_token;
      const u = await fetchGithubUser(token);
      const merged = {
        ...loadSettings(),
        githubToken: token,
        githubLogin: (u && u.login) || "",
        githubAvatarUrl: (u && u.avatar_url) || "",
      };
      saveSettings(merged);
      githubEmit({ type: "done", login: merged.githubLogin, avatar: merged.githubAvatarUrl });
      return;
    }
    const err = r.json && r.json.error;
    if (err === "authorization_pending" || err === "slow_down") {
      const wait = ((r.json && r.json.interval) || interval || 5) * 1000 + (err === "slow_down" ? 5000 : 0);
      githubPollTimer = setTimeout(poll, wait);
      return;
    }
    githubPollActive = false;
    githubEmit({
      type: "error",
      message: (r.json && (r.json.error_description || r.json.error)) || "Ошибка авторизации",
    });
  };

  githubPollTimer = setTimeout(poll, 1000);
  return { ok: true, user_code, verification_uri, expires_in: expires_in || 900 };
});

// ─────────────────────────── Файлы (панель проекта) ───────────────────────────
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "svg", "avif", "heic",
  "exe", "dll", "so", "dylib", "bin", "dat", "db", "sqlite", "sqlite3",
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "jar", "apk", "ipa",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods",
  "mp3", "mp4", "avi", "mov", "mkv", "wav", "ogg", "flac", "webm",
  "woff", "woff2", "ttf", "otf", "eot", "wasm", "pyc", "class", "lock",
]);

ipcMain.handle("fs:listTree", (_e, dir) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  try {
    const entries = fs
      .readdirSync(d, { withFileTypes: true })
      .filter((e) => e.name !== ".git")
      .map((e) => {
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(path.join(d, e.name));
          size = e.isFile() ? st.size : 0;
          mtime = st.mtimeMs;
        } catch {}
        return { name: e.name, isDir: e.isDirectory(), size, mtime };
      })
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, "ru")));
    return { ok: true, entries };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle("fs:readFile", (_e, p) => {
  const abs = sanitizePath(p);
  if (!abs) return { ok: false, error: "Файл не найден" };
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { ok: false, error: "Это не файл" };
    const ext = path.extname(abs).toLowerCase().replace(".", "");
    if (BINARY_EXT.has(ext)) return { ok: false, error: "Бинарный файл — предпросмотр недоступен", binary: true };
    let content = fs.readFileSync(abs, "utf8");
    if (content.includes("\u0000")) return { ok: false, error: "Бинарный файл — предпросмотр недоступен", binary: true };
    let truncated = false;
    if (content.length > 300000) {
      content = content.slice(0, 300000);
      truncated = true;
    }
    return { ok: true, content, size: st.size, truncated };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle("fs:readImage", (_e, p) => {
  const abs = sanitizePath(p);
  if (!abs) return { ok: false, error: "Файл не найден" };
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { ok: false, error: "Это не файл" };
    if (st.size > 8 * 1024 * 1024) return { ok: false, error: "Файл слишком большой (максимум 8 МБ)" };
    const ext = path.extname(abs).toLowerCase();
    const IMG = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico", ".avif"];
    if (!IMG.includes(ext)) return { ok: false, error: "Не изображение" };
    const mime = ext === ".svg" ? "image/svg+xml" : "image/" + ext.slice(1);
    const dataUrl = "data:" + mime + ";base64," + fs.readFileSync(abs).toString("base64");
    return { ok: true, dataUrl, size: st.size };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// ── Файлы: ручное создание / редактирование / удаление / импорт перетаскиванием ──
function fsNameError(name) {
  const n = String(name || "").trim();
  if (!n) return "Пустое имя";
  if (n === "." || n === "..") return "Недопустимое имя: " + n;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) return "Имя содержит недопустимые символы: " + n;
  if (n.length > 150) return "Имя слишком длинное (максимум 150 символов)";
  return null;
}

ipcMain.handle("fs:createFile", (_e, dir, name, content) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const err = fsNameError(name);
  if (err) return { ok: false, error: err };
  const target = path.join(d, String(name).trim());
  if (fs.existsSync(target)) return { ok: false, error: "Файл уже существует: " + target };
  try {
    fs.writeFileSync(target, content == null ? "" : String(content), "utf8");
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: (e.message || String(e)) + " — проверь права на запись в папку." };
  }
});

ipcMain.handle("fs:createFolder", (_e, dir, name) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const err = fsNameError(name);
  if (err) return { ok: false, error: err };
  const target = path.join(d, String(name).trim());
  if (fs.existsSync(target)) return { ok: false, error: "Папка уже существует: " + target };
  try {
    fs.mkdirSync(target, { recursive: false });
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: (e.message || String(e)) + " — проверь права на запись в папку." };
  }
});

ipcMain.handle("fs:writeFile", (_e, p, content) => {
  const abs = sanitizePath(p);
  if (!abs) return { ok: false, error: "Файл не найден" };
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { ok: false, error: "Это не файл" };
    const text = content == null ? "" : String(content);
    if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) return { ok: false, error: "Слишком большой файл для сохранения из панели (максимум 2 МБ)" };
    fs.writeFileSync(abs, text, "utf8");
    return { ok: true, path: abs };
  } catch (e) {
    return { ok: false, error: (e.message || String(e)) + " — проверь права на запись." };
  }
});

ipcMain.handle("fs:delete", (_e, p) => {
  const abs = sanitizePath(p);
  if (!abs) return { ok: false, error: "Путь не найден" };
  try {
    const isDir = fs.statSync(abs).isDirectory();
    fs.rmSync(abs, { recursive: true, force: true });
    return { ok: true, deleted: abs, isDir };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// Импорт перетаскиванием: items = [{ src, rel }] — src абсолютный путь на диске,
// rel — относительный путь внутри targetDir (может содержать подпапки).
ipcMain.handle("fs:importDropped", async (_e, targetDir, items) => {
  const d = sanitizeDir(targetDir);
  if (!d) return { ok: false, error: "Папка назначения не найдена" };
  if (!Array.isArray(items)) return { ok: false, error: "Нет данных для импорта" };
  const created = [];
  const errors = [];
  for (const it of items) {
    const src = it && typeof it.src === "string" ? it.src : "";
    const rel = String((it && it.rel) || "").split(/[\\/]/).map((x) => x.trim()).filter(Boolean).join("/");
    if (!src || !fs.existsSync(src) || !fs.statSync(src).isFile()) {
      if (src) errors.push((it.name || src) + " — источник не найден");
      continue;
    }
    if (!rel) continue;
    const bad = rel.split("/").some((part) => fsNameError(part));
    if (bad) { errors.push(rel + " — недопустимое имя"); continue; }
    const dest = path.join(d, rel);
    if (!dest.startsWith(d + path.sep)) { errors.push(rel + " — недопустимый путь"); continue; }
    if (fs.existsSync(dest)) {
      // не перезаписываем молча — добавляем суффикс -2, -3…
      const ext = path.extname(dest);
      const base = dest.slice(0, dest.length - ext.length);
      let i = 2;
      let final = path.join(path.dirname(dest), path.basename(base) + "-" + i + ext);
      while (fs.existsSync(final)) { i++; final = path.join(path.dirname(dest), path.basename(base) + "-" + i + ext); }
      try {
        fs.mkdirSync(path.dirname(final), { recursive: true });
        fs.copyFileSync(src, final);
        created.push(final);
      } catch (e) {
        errors.push(path.basename(final) + " — " + (e.message || String(e)));
      }
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      created.push(dest);
    } catch (e) {
      errors.push(rel + " — " + (e.message || String(e)));
    }
  }
  return { ok: created.length > 0 || errors.length === 0, created, errors };
});

ipcMain.handle("fs:openInExplorer", (_e, p) => {
  const abs = sanitizePath(p);
  if (abs) shell.showItemInFolder(abs);
  return true;
});

ipcMain.handle("shell:openExternal", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) shell.openExternal(url);
  return true;
});

// ─────────────────────────── Git (панель проекта) ───────────────────────────
ipcMain.handle("git:repoInfo", async (_e, dir) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const s = loadSettings();
  const root = await runGit(d, ["rev-parse", "--show-toplevel"], s);
  if (!root.ok) return { ok: true, isRepo: false, message: "Не git-репозиторий" };
  const rootDir = (root.out || "").trim();
  const [branchR, remoteR] = await Promise.all([
    runGit(rootDir, ["branch", "--show-current"], s),
    runGit(rootDir, ["remote", "get-url", "origin"], s),
  ]);
  let remote = remoteR.ok ? remoteR.out.trim() : "";
  // Никогда не показываем токен, если он оказался зашит в URL
  remote = remote.replace(/^https?:\/\/[^@\/]+@/i, "https://");
  return { ok: true, isRepo: true, root: rootDir, branch: branchR.ok ? branchR.out.trim() : "", remote };
});

ipcMain.handle("git:status", async (_e, dir) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const r = await runGit(d, ["status", "--porcelain=v1", "-b", "-uall"], loadSettings());
  if (!r.ok) return { ok: false, error: r.err };
  const staged = [];
  const unstaged = [];
  const untracked = [];
  let branch = "HEAD";
  let ahead = 0;
  let behind = 0;
  let detached = false;
  for (const line of r.out.split("\n")) {
    if (line.startsWith("## ")) {
      const m = line.match(/^## (\S+?)(?:\.\.\.\S+)?(?: \[(.*)\])?$/);
      branch = (m && m[1]) || "HEAD";
      if (branch === "HEAD") detached = true;
      if (m && m[2]) {
        const am = m[2].match(/ahead (\d+)/);
        if (am) ahead = parseInt(am[1], 10);
        const bm = m[2].match(/behind (\d+)/);
        if (bm) behind = parseInt(bm[1], 10);
      }
      continue;
    }
    const X = line[0] || " ";
    const Y = line[1] || " ";
    const name = line.slice(3).replace(/^"|"$/g, "");
    if (X === "?" && Y === "?") untracked.push(name);
    else {
      if (X !== " " && X !== "?") staged.push(name);
      if (Y !== " ") unstaged.push(name);
    }
  }
  return {
    ok: true,
    branch,
    ahead,
    behind,
    detached,
    staged: staged.slice(0, 200),
    unstaged: unstaged.slice(0, 200),
    untracked: untracked.slice(0, 200),
  };
});

ipcMain.handle("git:log", async (_e, dir, n) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const count = Math.max(1, Math.min(parseInt(n, 10) || 50, 200));
  const r = await runGit(d, ["log", "-n", String(count), "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s"], loadSettings());
  if (!r.ok) return { ok: false, error: r.err };
  const commits = r.out
    ? r.out.split("\n").map((line) => {
        const parts = line.split("\x1f");
        return {
          hash: parts[0] || "",
          short: parts[1] || "",
          author: parts[2] || "",
          email: parts[3] || "",
          date: parts[4] || "",
          message: parts[5] || "",
        };
      })
    : [];
  return { ok: true, commits };
});

ipcMain.handle("git:commitDetail", async (_e, dir, hash) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const r = await runGit(
    d,
    ["show", "--numstat", "--format=%H%x1f%s%x1f%an%x1f%aI", String(hash)],
    loadSettings()
  );
  if (!r.ok) return { ok: false, error: r.err };
  const lines = r.out.split("\n");
  const meta = lines[0] ? lines[0].split("\x1f") : [];
  const files = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("\t");
    if (parts.length < 3) continue;
    const add = parts[0] === "-" ? 0 : parseInt(parts[0], 10) || 0;
    const del = parts[1] === "-" ? 0 : parseInt(parts[1], 10) || 0;
    let p = parts.slice(2).join("\t");
    let status = "mod";
    if (p.includes("=>")) status = "renamed";
    else if (add > 0 && del === 0) status = "added";
    else if (del > 0 && add === 0) status = "deleted";
    files.push({ path: p, additions: add, deletions: del, status });
  }
  return { ok: true, hash: meta[0] || "", message: meta[1] || "", author: meta[2] || "", date: meta[3] || "", files };
});

ipcMain.handle("git:revert", async (_e, dir, hash) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const r = await runGit(d, ["revert", "--no-edit", String(hash)], loadSettings());
  return r.ok ? { ok: true, out: r.out || "Коммит отменён." } : { ok: false, error: r.err || "Не удалось откатить (возможен конфликт)" };
});

ipcMain.handle("git:resetHard", async (_e, dir, hash) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const r = await runGit(d, ["reset", "--hard", String(hash)], loadSettings());
  return r.ok ? { ok: true, out: "Сброшено к " + String(hash) } : { ok: false, error: r.err };
});

ipcMain.handle("git:restore", async (_e, dir) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const r = await runGit(d, ["restore", "."], loadSettings());
  return r.ok ? { ok: true, out: "Изменения отменены." } : { ok: false, error: r.err };
});

// Дифф файла (или пометка, что файл новый и не отслеживается)
ipcMain.handle("git:diff", async (_e, dir, file) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  if (!file || typeof file !== "string" || !file.trim()) return { ok: false, error: "Файл не указан" };
  const rel = path.isAbsolute(file) ? path.relative(d, file) : file;
  const r = await runGit(d, ["diff", "--", rel], loadSettings());
  if (r.ok && r.out) return { ok: true, diff: r.out, untracked: false };
  const abs = path.isAbsolute(file) ? file : path.join(d, rel);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    return { ok: true, untracked: true, size: fs.statSync(abs).size, path: abs };
  }
  return { ok: false, error: "Нет изменений или файл не найден" };
});

// Коммит всех изменений с указанным сообщением
ipcMain.handle("git:commit", async (_e, dir, message) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const msg = String(message || "").trim();
  if (!msg) return { ok: false, error: "Укажи сообщение коммита" };
  const s = loadSettings();
  const add = await runGit(d, ["add", "-A"], s);
  if (!add.ok) return { ok: false, error: add.err };
  const commit = await runGit(
    d,
    ["-c", "user.name=AI Agent", "-c", "user.email=ai-agent@local", "commit", "-m", msg],
    s
  );
  if (!commit.ok) return { ok: false, error: commit.err || "Коммит не создан (нет изменений?)" };
  return { ok: true, out: commit.out || "Коммит создан." };
});

ipcMain.handle("git:push", async (_e, dir) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const r = await runGit(d, ["push"], loadSettings());
  return r.ok ? { ok: true, out: r.out || "Отправлено на GitHub." } : { ok: false, error: r.err };
});

ipcMain.handle("git:clone", async (_e, base, url) => {
  const u = String(url || "").trim();
  if (!/^(https?:\/\/|git@)/i.test(u)) return { ok: false, error: "URL должен начинаться с https:// или git@" };
  const prep = pickCloneBase(base, loadSettings());
  if (!prep.ok) return prep;
  const r = await cloneRepoTo(u, prep.dir, loadSettings());
  if (r.ok) {
    lastAgentRepoDir = r.dir; // агент тоже работает внутри склонированного репозитория
    clonedRepoPending = true; // следующий ответ агента начнётся с анализа нового проекта
  }
  return r.ok ? { ok: true, out: r.message || "Клонировано", dir: r.dir, cloned: r.cloned } : r;
});

// ─────────────────────────── Жизненный цикл ───────────────────────────
// ─────────────────────────── Auto Updater ───────────────────────────
// Показываем прогресс в строке заголовка и уведомляем, когда обновление готово.
function initAutoUpdater() {
  autoUpdater.autoDownload = false;           // спросим пользователя перед загрузкой
  autoUpdater.autoInstallOnAppQuit = true;    // установить при закрытии, если уже скачан

  autoUpdater.on("checking-for-update", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle("AI Developer Agent — проверка обновлений…");
  });
  autoUpdater.on("update-available", (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle("AI Developer Agent — доступно обновление");
      mainWindow.webContents.send("ai:event", { type: "update:available", info });
    }
    // Спрашиваем: скачать?
    new Notification({
      title: "AI Developer Agent",
      body: `Доступна версия ${info.version}. Скачать и установить?`,
    }).show();
    autoUpdater.downloadUpdate().catch((e) => console.error("[updater] download error", e));
  });
  autoUpdater.on("update-not-available", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle("AI Developer Agent");
  });
  autoUpdater.on("download-progress", (p) => {
    const pct = Math.round(p.percent);
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.setTitle(`AI Developer Agent — загрузка ${pct}%`);
  });
  autoUpdater.on("update-downloaded", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle("AI Developer Agent — обновление готово");
      mainWindow.webContents.send("ai:event", { type: "update:downloaded" });
    }
    new Notification({
      title: "AI Developer Agent",
      body: "Обновление скачано. Применится при следующем перезапуске.",
    }).show();
  });
  autoUpdater.on("error", (e) => {
    console.error("[updater]", e.message);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle("AI Developer Agent");
  });

  // Проверка раз в час
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10_000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000);
}

app.whenReady().then(() => {
  createWindow();
  mobileBridge.applySettings(loadSettings());
  initAutoUpdater();
  // Локальный self-update (OTA): проверка при старте и каждые 60 секунд
  const otaTick = () => {
    ota.check(loadSettings()).catch(() => {});
  };
  setTimeout(otaTick, 5000);
  setInterval(otaTick, 60000);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// При выходе — останавливаем все фоновые процессы.
app.on("before-quit", () => {
  for (const rec of bgProcesses.values()) bgKill(rec);
  bgProcesses.clear();
  if (userTerm) {
    const rec = userTerm;
    userTerm = null;
    bgKill(rec);
  }
  if (devRun) {
    const rec = devRun.rec;
    devRun = null;
    bgKill(rec);
  }
  mobileBridge.stop();
});
