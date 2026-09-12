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
  friendlyRateLimitError,
  genCallId,
  contextBudget,
  trimConversation,
  sanitizeToolPairs,
  truncateText,
  webSearchDDG,
  webSearch,
  classifyKeyError,
  webFetchPage,
  // вспомогательная модель: зрение + генерация изображений
  auxConfig,
  fmtError,
  describeImageRemote,
  generateImageRemote,
  routeTools,
  searchTools,
  ROUTER_MAX_TOKENS,
  groupOfTool,
  PLAN_MODE_TOOL_DEFINITIONS,
  modelWindow,
  ollamaModelInfo,
  // инструменты ОС (парсеры, whitelist)
  parseProcessesCsv,
  registryPathAllowed,
  parseSysInfoJson,
  createContextManager,
  estimateTokens,
  normalizePlanTasks,
  planSummary,
} = require("./renderer/agent-core.js");

// ─────────────────────────── Мобильный мост (LAN + PWA + PIN) ───────────────────────────
// Мост отдаёт интерфейс и дублирует IPC по WebSocket для телефона/планшета в той же сети.
// Прокси ipcMain.handle: каждый зарегистрированный обработчик сохраняется в карту —
// мобильный мост вызывает те же функции, что и окно приложения (никакого дублирования логики).
const MobileBridge = require("./mobile-bridge.js");
const browserTools = require("./browser-tools.js"); // браузерные инструменты агента (Playwright)
const appUi = require("./app-ui-tools.js"); // инструменты управления собственным окном приложения (app-*)
const secrets = require("./secrets.js"); // секреты: ключи, токены, PIN, agentEnv (safeStorage)
const agentStore = require("./agent-store.js"); // память проекта (заметки) и точки отката (чекпоинты)
const unifiedPatch = require("./unified-patch.js"); // применение unified diff (applyPatch)
const codeIndex = require("./code-index.js"); // семантический индекс кода (BM25 + стемминг)
const yandexCloud = require("./yandex-cloud.js"); // Yandex Cloud REST API: авторизация, дашборд, создание ресурсов
const vault = require("./vault.js"); // пароли сайтов: поиск записи, безопасный текст, подстановка в форму
const mail = require("./mail.js"); // почта агента: SMTP (отправка КП) + IMAP (коды подтверждения), на встроенных модулях
const ycCli = require("./yc-cli.js"); // официальный yc CLI внутрь папки приложения: загрузка + PATH (без системных прав)
const ycLogs = require("./yc-logs.js"); // логи Cloud Logging внутренним API (REST + gRPC) — внешний yc CLI не нужен
const winPs = require("./win-ps.js"); // живая сессия PowerShell: системные справки без холодного старта
secrets.init(path.join(app.getPath("userData"), "secrets.json"));
const _ipcHandleOrig = ipcMain.handle.bind(ipcMain);
const ipcHandlerMap = new Map();
ipcMain.handle = (channel, fn) => {
  ipcHandlerMap.set(channel, fn);
  return _ipcHandleOrig(channel, fn);
};
const mobileBridge = new MobileBridge({ handlerMap: ipcHandlerMap });
const ota = require("./ota.js"); // локальный self-update (OTA)
const selfDev = require("./self-dev.js"); // защита критичной инфраструктуры самообновления

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
  serperApiKey: "", // ключ Serper — усиленный Google-поиск для агента (webSearch)
  // Браузер агента: постоянный профиль (куки и входы на сайты переживают перезапуск приложения)
  browserProfile: true,
  // Работа в СВОЁМ Chrome через порт отладки (CDP): агент действует в твоих
  // вкладках с твоими входами на сайты. По умолчанию выключено.
  browserConnect: false,
  browserConnectPort: 9222,
  // Менеджер паролей: записи { id, name, url, login, password, note } — шифруются как остальные секреты
  sitePasswords: [],
  // Почта (SMTP/IMAP): агент отправляет КП и читает коды подтверждения. Пароль — в secrets.json.
  mailAddress: "", // адрес ящика (он же логин по умолчанию)
  mailUser: "", // логин, если провайдер требует отдельный (обычно пусто)
  mailFromName: "", // имя отправителя в письмах
  mailImapHost: "", // пусто — определится по адресу
  mailImapPort: 993,
  mailSmtpHost: "", // пусто — определится по адресу
  mailSmtpPort: 465,
  mailStarttls: false, // SMTP через STARTTLS (587) вместо неявного TLS (465)
  mailAllowAgentSend: false, // агенту ЗАПРЕЩЕНО отправлять письма, пока пользователь не включит
  activeProjectId: "", // id активного проекта (его dir = workingDir)
  // Локальный self-update (OTA): агент собирает бандл (scripts/make-ota.js), приложение применяет на ходу
  otaEnabled: true,
  otaDir: "", // необязательная папка-источник OTA (пусто — userData/ota + ota/ рядом с кодом)
  // Сохранённые OpenAI-совместимые подключения (несколько ключей): { id, name, url, apiKey, model, project }
  openaiProfiles: [],
  openaiActiveProfile: "", // id активного подключения ("" — не выбрано)
  autoSwitchProfiles: false, // при ошибке ключа/баланса/лимита — авто-переключение на следующее подключение

  // Yandex Cloud (REST API): авторизация (OAuth-токен — в secrets.json), каталог, разрешения агента
  ycCloudId: "", // id облака
  ycFolderId: "", // id каталога (folder), с которым работает дашборд и агент
  ycFolderName: "", // имя каталога для отображения
  ycAllowAgentCreate: false, // агенту ЗАПРЕЩЕНО создавать ресурсы, пока пользователь явно не включит
  ycAllowAgentDelete: false, // удаление ресурсов агентом — только с явного разрешения

  // Память диалогов: когда контекст переполняется, агент сворачивает старые шаги
  // в памятку — здесь такая памятка сохраняется локально по датам в
  // <userData>/context-memory/ГГГГ-ММ-ДД/. Потом можно спросить «что мы делали 5-го числа»
  // (инструменты memoryList / memorySearch). По умолчанию ВЫКЛЮЧЕНО — без явного
  // согласия пользователя на диск ничего не пишется.
  contextMemory: false,
  contextMemoryDays: 30, // сколько дней хранить (старые дни удаляются автоматически)
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
  // Миграция на сохранённые OpenAI-подключения: единственный URL+ключ → первый профиль.
  // (Только если поля openaiProfiles ещё не было вовсе — удалённые вручную профили не воскрешаем.)
  if (!raw || !Array.isArray(raw.openaiProfiles)) {
    const profUrl = String(s.openaiUrl || "").trim();
    if (profUrl) {
      s.openaiProfiles = [
        {
          id: "p-main",
          name: openaiProfileNameFromUrl(profUrl),
          url: profUrl,
          apiKey: s.openaiApiKey || "",
          model: s.openaiModel || "",
          project: s.openaiProject || "",
        },
      ];
      s.openaiActiveProfile = "p-main";
    } else {
      s.openaiProfiles = [];
      s.openaiActiveProfile = "";
    }
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
  // Пароли сайтов: чистка мусора и дублей (пустые/битые записи отбрасываются).
  s.sitePasswords = vault.sanitizeList(s.sitePasswords);
  return s;
}

// Переменные окружения агента (envSet/envList/envUnset). Значения хранятся в settings.json
// (settings.agentEnv) и подмешиваются во все команды: runCommand, фоновые процессы, shell, git, docker.
let agentEnv = {}; // итоговый набор: пользовательский + автоматический (Yandex Cloud)
let userAgentEnv = {}; // только то, что задал пользователь — это и сохраняется в настройках

// Автоматические переменные Yandex Cloud для команд агента. yc CLI читает их прямо
// из окружения, поэтому подключённый аккаунт работает без интерактивного `yc init`.
// ВАЖНО: YC_TOKEN и YC_IAM_TOKEN должны содержать IAM-токен — OAuth там не
// принимается (yc отвечает «The token is invalid»). IAM живёт ~1 час, поэтому
// держим свежий снимок (ycIamEnv) и продлеваем его в фоне до истечения.
// В чат значения не выводятся: envList показывает только имя и длину.
let ycIamEnv = null; // { token, expiresAtMs, forOauth }
let ycIamTimer = null;
let ycIamTimerAt = 0;
let ycIamLastTryTs = 0;
let lastAgentEnvSettings = null;
const YC_IAM_REFRESH_MARGIN = 5 * 60 * 1000;

function ycIamEnvToken(cfg) {
  if (!ycIamEnv || !cfg || !cfg.oauth || ycIamEnv.forOauth !== cfg.oauth) return "";
  if (Date.now() >= ycIamEnv.expiresAtMs - 60 * 1000) return "";
  return ycIamEnv.token;
}

function ycAutoEnv(s) {
  const out = {};
  try {
    const cfg = ycConfig(s);
    if (cfg.cloudId) out.YC_CLOUD_ID = cfg.cloudId;
    if (cfg.folderId) out.YC_FOLDER_ID = cfg.folderId;
    const iam = ycIamEnvToken(cfg);
    if (iam) {
      out.YC_IAM_TOKEN = iam;
      out.YC_TOKEN = iam;
    }
  } catch {}
  return out;
}

// Пересобрать окружение без сети (зовётся и по таймеру продления токена).
function rebuildAgentEnv() {
  agentEnv = { ...userAgentEnv, ...ycAutoEnv(lastAgentEnvSettings) };
}

// Фоновая синхронизация IAM-токена: обмен OAuth→IAM и продление за 5 минут до
// истечения. Не бросает и не ждёт: команды агента никогда не стоят из-за токена.
// Повторы ограничены (не чаще раза в минуту), иначе каждая команда дёргала бы IAM.
function ycIamSync(s) {
  try {
    const cfg = ycConfig(s);
    if (!cfg.oauth) {
      if (ycIamTimer) { clearTimeout(ycIamTimer); ycIamTimer = null; ycIamTimerAt = 0; }
      if (ycIamEnv) { ycIamEnv = null; rebuildAgentEnv(); }
      return;
    }
    if (ycIamEnv && ycIamEnv.forOauth === cfg.oauth && Date.now() < ycIamEnv.expiresAtMs - YC_IAM_REFRESH_MARGIN) {
      const at = ycIamEnv.expiresAtMs - YC_IAM_REFRESH_MARGIN;
      if (ycIamTimerAt !== at) {
        if (ycIamTimer) clearTimeout(ycIamTimer);
        ycIamTimerAt = at;
        ycIamTimer = setTimeout(() => {
          ycIamTimer = null;
          ycIamTimerAt = 0;
          ycIamSync(lastAgentEnvSettings);
        }, Math.max(30 * 1000, at - Date.now()));
        if (ycIamTimer.unref) ycIamTimer.unref();
      }
      return;
    }
    if (ycIamEnv && ycIamEnv.forOauth !== cfg.oauth) { ycIamEnv = null; rebuildAgentEnv(); }
    if (Date.now() - ycIamLastTryTs < 60 * 1000) return;
    ycIamLastTryTs = Date.now();
    yandexCloud
      .getIamTokenInfo(cfg.oauth)
      .then((info) => {
        ycIamEnv = { token: info.token, expiresAtMs: info.expiresAtMs || Date.now() + 3600 * 1000, forOauth: cfg.oauth };
        rebuildAgentEnv();
        ycIamSync(lastAgentEnvSettings);
      })
      .catch(() => {
        /* нет сети или токен не принят — команды отработают без YC_*, без падения */
      });
  } catch {}
}

// Папка со встроенным yc CLI — в PATH всех команд агента (как node).
function ycEnsurePath() {
  try {
    const dir = ycCli.binDir(app.getPath("userData"));
    if (!dir) return;
    const before = envPathInfo().value;
    if (!String(before || "").split(path.delimiter).map((x) => x.trim()).includes(dir)) setMergedPath(before, dir);
  } catch {}
}

// Пересобрать окружение агента: пользовательские переменные + автоматические YC.
function applyAgentEnv(s) {
  userAgentEnv = (s && typeof s.agentEnv === "object" && s.agentEnv) || {};
  lastAgentEnvSettings = s || lastAgentEnvSettings;
  rebuildAgentEnv();
  ycEnsurePath();
  // Фоновая подстановка свежего IAM в YC_IAM_TOKEN/YC_TOKEN (без await).
  ycIamSync(lastAgentEnvSettings);
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    const s = normalizeSettings(raw);
    // Секреты (ключи, токены, PIN, agentEnv) живут в зашифрованном secrets.json.
    const sec = secrets.loadSecrets();
    for (const k of secrets.SECRET_KEYS) {
      if (sec[k] !== undefined) s[k] = sec[k];
    }
    applyAgentEnv(s);
    // Постоянный профиль браузера агента: отдельная папка внутри userData.
    // Выключено — работаем как раньше, с чистым профилем на каждый запуск.
    applyBrowserSettings(s);
    return s;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  // Секреты — в отдельный зашифрованный файл, в settings.json их не остаётся.
  const { rest, sec } = secrets.splitSecrets(s);
  secrets.saveSecrets(sec);
  fs.writeFileSync(settingsFile(), JSON.stringify(rest, null, 2), "utf8");
}

// Имя подключения из URL: https://api.deepseek.com/v1 → deepseek.com
function openaiProfileNameFromUrl(url) {
  try {
    const m = String(url || "").match(/^https?:\/\/([^\/:?#]+)/i);
    return m ? m[1].replace(/^www\./, "") : "OpenAI";
  } catch {
    return "OpenAI";
  }
}

// Список OpenAI-подключений, которые реально можно использовать (есть id и ключ).
function openaiProfilesList(s) {
  const arr = Array.isArray(s && s.openaiProfiles) ? s.openaiProfiles : [];
  return arr.filter((p) => p && typeof p === "object" && p.id && String(p.apiKey || "").trim());
}

// Кулдаун подключений: после ошибки ключа/баланса/лимита не возвращаемся к этому
// ключу раньше времени — защита от «долбления» ограниченного ключа и лишних ротаций.
const profileCooldown = new Map(); // profileId → timestamp (мс), до которого не используем

function markProfileCooldown(id, ms) {
  if (!id) return;
  profileCooldown.set(id, Date.now() + Math.max(0, Number(ms) || 0));
}

// Переключает активное OpenAI-подключение на следующее по кругу и зеркалит его
// значения в основные поля настроек (их читает весь остальной код: чат, модели, тест).
// opts.penalizeCurrentMs — на сколько отложить текущий (провинившийся) ключ.
// Подключения в кулдауне пропускаются. Возвращает новый профиль или null.
function switchOpenaiProfile(s, opts) {
  const o = opts || {};
  const profs = openaiProfilesList(s);
  if (profs.length < 2) return null;
  const now = Date.now();
  const cur = s.openaiActiveProfile;
  const idx = Math.max(0, profs.findIndex((p) => p.id === cur));
  if (o.penalizeCurrentMs) markProfileCooldown(cur, o.penalizeCurrentMs);
  for (let step = 1; step <= profs.length; step++) {
    const next = profs[(idx + step) % profs.length];
    if (!next || next.id === cur) continue;
    if ((profileCooldown.get(next.id) || 0) > now) continue; // ещё не отлежался
    s.openaiActiveProfile = next.id;
    s.openaiUrl = next.url || s.openaiUrl;
    s.openaiApiKey = next.apiKey || "";
    if (next.model) s.openaiModel = next.model;
    if (next.project !== undefined) s.openaiProject = next.project || "";
    return next;
  }
  return null; // все подключения в кулдауне — переключать некуда
}

// Чтение чатов: основной файл, при повреждении — резервная копия .bak.
function loadChats() {
  const readOne = (file) => {
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      if (d && Array.isArray(d.chats)) return d;
    } catch {}
    return null;
  };
  return readOne(chatsFile()) || readOne(chatsFile() + ".bak") || { chats: [], activeId: null };
}

// Запись чатов атомарная: сначала во временный файл, потом подмена.
// Внезапное закрытие/падение во время записи больше не оставит обрезанный
// chats.json (из-за него вся история выглядела как «всё удалилось»).
function saveChats(d) {
  const file = chatsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), "utf8");
  try {
    if (fs.existsSync(file)) fs.renameSync(file, file + ".bak");
  } catch {}
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows: подмена может не пройти, если файл залочен — тогда копируем.
    try { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); } catch {}
  }
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

// Батчинг (правило 35): инструменты, которые безопасно выполнять ПАРАЛЛЕЛЬНО —
// только чтение без побочных эффектов и без диалогов с пользователем. Если в одном
// раунде модель прислала несколько таких вызовов, они идут одновременно.
const PARALLEL_SAFE_TOOLS = new Set([
  "readFile", "readFileLines", "listFiles", "listDirectory", "searchFile", "searchProject",
  "fileOutline", "readFileStructure", "semanticSearch", "findReferences", "explainCode",
  "getDependencies", "gitStatus", "gitLog", "gitDiff", "gitBranch", "gitBlame",
  "listProcesses", "getSystemInfo", "listPorts", "checkPort", "checkUrl",
  "checkInstalledProgram", "canExecute", "shellsStatus", "envList",
  "webSearch", "webFetch", "apiRequest", "memoryList", "memorySearch",
  "noteRead", "noteList", "checkpointList", "agentGuide", "vaultList",
]);

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

// Кодировка консоли Windows: cmd по умолчанию отдаёт CP866, и кириллица в выводе
// команд превращается в кашу («set | findstr», git, сборки). Переключаем страницу
// кода на UTF-8 прямо в команде. На других ОС аргументы как были.
function shellArgsFor(command) {
  if (process.platform === "win32") return ["/d", "/s", "/c", "chcp 65001>nul & " + command];
  return ["-c", command];
}

// Оболочка для runCommand/startBackground: cmd (по умолчанию на Windows),
// powershell/pwsh, bash, sh. Псевдонимы принимаются и по-русски.
const SHELL_KINDS = {
  cmd: "cmd", "командная строка": "cmd", консоль: "cmd", dos: "cmd",
  powershell: "powershell", ps: "powershell", ps1: "powershell", "пс": "powershell",
  pwsh: "pwsh", powershell7: "pwsh", ps7: "pwsh",
  bash: "bash", gitbash: "bash", "git-bash": "bash", "баш": "bash",
  sh: "sh", zsh: "sh", dash: "sh",
};

function normalizeShell(name) {
  const key = String(name == null ? "" : name).trim().toLowerCase();
  if (!key) return "";
  return SHELL_KINDS[key] || "";
}

// PowerShell: включаем UTF-8 на выходе (иначе кириллица в pipe превращается в
// кашу, как в cmd с CP866) и запрещаем прогресс-бар, который ломает парсинг.
// Команда передаётся через -EncodedCommand (UTF-16LE base64): это снимает ВСЕ
// проблемы с кавычками, $ и 2>$null, из-за которых раньше приходилось писать
// .ps1-файлы на каждое действие.
const PS_PRELUDE =
  "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " +
  "$OutputEncoding=[System.Text.Encoding]::UTF8; " +
  "$ProgressPreference='SilentlyContinue'; ";

function powershellArgs(command) {
  const script = PS_PRELUDE + String(command || "");
  const enc = Buffer.from(script, "utf16le").toString("base64");
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc];
}

// bash/sh из Git for Windows (там же, где git) — чтобы shell: "bash"/"sh" работали
// без PATH. Возвращает абсолютный путь или "" (не найдено нигде).
function findGitShell(which) {
  const name = which === "sh" ? "sh" : "bash";
  if (process.platform !== "win32") {
    const inPath = findProgram(name).path;
    if (inPath) return inPath;
    const direct = name === "sh" ? "/bin/sh" : "/bin/bash";
    try { if (fs.existsSync(direct)) return direct; } catch {}
    return "";
  }
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const home = process.env.USERPROFILE || "";
  const roots = [
    path.join(pf, "Git"),
    path.join(pf86, "Git"),
    home ? path.join(home, "AppData", "Local", "Programs", "Git") : "",
  ].filter(Boolean);
  // Порядок как у самого Git: сначала bin, затем usr/bin (там же лежит sh).
  const subs = name === "sh"
    ? [["usr", "bin", "sh.exe"], ["bin", "sh.exe"]]
    : [["bin", "bash.exe"], ["usr", "bin", "bash.exe"]];
  for (const root of roots) {
    for (const sub of subs) {
      const cand = path.join(root, ...sub);
      try { if (fs.existsSync(cand)) return cand; } catch {}
    }
  }
  return findProgram(name).path || "";
}

// Человеческое объяснение, почему оболочки нет (попадает в ответ инструмента).
function shellMissingHint(which) {
  if (process.platform === "win32") {
    return (
      which + " не найден. Поставь Git for Windows (installSystemPackage(\"git\")) — " + which +
      " идёт вместе с ним; либо используй shell: \"powershell\" или \"cmd\"."
    );
  }
  return which + " не найден: ни в PATH, ни в /bin. Проверь установку (installSystemPackage).";
}

// Единая точка выбора оболочки → { kind, shell, args, shellHint }.
// shellHint — человеческое объяснение, если оболочки нет в системе.
function resolveShell(command, shellName) {
  const kind = normalizeShell(shellName) || (process.platform === "win32" ? "cmd" : "sh");
  if (kind === "cmd") {
    return { kind, shell: process.env.ComSpec || "cmd.exe", args: shellArgsFor(command), shellHint: "", missing: false };
  }
  if (kind === "powershell" || kind === "pwsh") {
    const probe = findProgram(kind === "pwsh" ? "pwsh" : "powershell");
    return {
      kind,
      shell: probe.found ? probe.path : kind === "pwsh" ? "pwsh" : "powershell",
      args: powershellArgs(command),
      shellHint: probe.found
        ? ""
        : "PowerShell не найден в PATH. Варианты: installSystemPackage(\"pwsh\") для PowerShell 7 или shell: \"cmd\".",
      // missing намеренно false: Windows ищет powershell.exe в System32 независимо
      // от PATH, и жёсткая блокировка дала бы ложный отказ на рабочей машине.
      missing: false,
    };
  }
  if (kind === "bash" || kind === "sh") {
    // На Windows sh живёт там же, где bash (Git for Windows). Раньше sh молча
    // уходил в /bin/sh, которого на Windows нет: агент получал ENOENT вообще
    // без объяснения. Теперь и sh ищется как Git-оболочка и получает подсказку.
    const found = findGitShell(kind);
    return {
      kind,
      shell: found || kind,
      args: kind === "sh" ? ["-c", command] : ["-lc", command],
      shellHint: found ? "" : shellMissingHint(kind),
      missing: !found,
    };
  }
  return { kind: "sh", shell: "/bin/sh", args: ["-c", command], shellHint: "", missing: false };
}

// Какие оболочки реально есть на этой машине: агент спрашивает один раз
// (инструмент shellsStatus), а не выясняет методом тыка.
function shellsStatus() {
  const win = process.platform === "win32";
  const defKind = win ? "cmd" : "sh";
  const defPath = win ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  let defOk = true;
  if (!win) {
    try { defOk = fs.existsSync("/bin/sh"); } catch { defOk = false; }
  }
  const list = [{ kind: defKind, available: defOk, path: defPath, def: true, hint: defOk ? "" : shellMissingHint("sh") }];
  const seen = { [defKind]: true };
  for (const k of ["powershell", "pwsh"]) {
    const p = findProgram(k);
    if (seen[k]) continue;
    seen[k] = true;
    list.push({ kind: k, available: !!p.found, path: p.path || "", def: false, hint: p.found ? "" : "Установи PowerShell 7: installSystemPackage(\"pwsh\")." });
  }
  for (const k of ["bash", "sh"]) {
    if (seen[k]) continue;
    seen[k] = true;
    const f = findGitShell(k);
    list.push({ kind: k, available: !!f, path: f || "", def: false, hint: f ? "" : shellMissingHint(k) });
  }
  return list;
}

// Строка про Yandex Cloud для САММАРИ ПРОЕКТА: агент всегда видит АКТУАЛЬНЫЙ
// каталог и разрешения, а не полагается на устаревшие результаты инструментов
// в истории переписки («каталог не выбран», хотя он уже выбран).
function ycBriefLine(s) {
  try {
    const cfg = ycConfig(s);
    if (!cfg.oauth) return "";
    if (!cfg.folderId) return "Yandex Cloud: подключён, каталог НЕ выбран — попроси пользователя выбрать каталог в Настройках → «☁️ Yandex Cloud».";
    return (
      "Yandex Cloud: каталог «" + (cfg.folderName || cfg.folderId) + "» (" + cfg.folderId + ")" +
      (cfg.cloudId ? ", облако " + cfg.cloudId : "") +
      "; создание ресурсов агентом " + (cfg.allowCreate ? "разрешено" : "ЗАПРЕЩЕНО") +
      ", удаление " + (cfg.allowDelete ? "разрешено" : "ЗАПРЕЩЕНО") + ". "
    );
  } catch {
    return "";
  }
}

// Короткая строка для САММАРИ ПРОЕКТА: что доступно, чтобы агент не гадал.
function shellsBrief() {
  const win = process.platform === "win32";
  const names = [win ? "cmd" : "sh"];
  for (const k of ["powershell", "pwsh"]) if (findProgram(k).found) names.push(k);
  for (const k of ["bash", "sh"]) if (findGitShell(k)) names.push(k);
  const uniq = names.filter((n, i) => names.indexOf(n) === i);
  return "по умолчанию " + (win ? "cmd" : "sh") + "; доступно: " + uniq.join(", ") + " (параметр shell у runCommand/startBackground)";
}

// Запуск произвольной команды в терминале (без интерактива).
// Возвращает текст с кодом завершения и временем выполнения.
function runTerminalCommand(command, cwd, timeoutMs, shellName) {
  return new Promise((resolve) => {
    const sh = resolveShell(command, shellName);
    const shell = sh.shell;
    const args = sh.args;
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
        const code = err.killed ? "таймаут" : err.code == null ? 1 : err.code;
        const parts = [];
        if (out) parts.push(out);
        if (errText) parts.push(errText);
        // Ошибки запуска (ENOENT/EACCES/EINVAL) не пишут в stderr — без этого
        // агент видел пустой вывод и не мог понять причину.
        if (!errText && err.message) parts.push(String(err.message));
        if (!parts.length) parts.push(err.message || String(err));
        const shHint = (err.code === "ENOENT" || sh.missing === true) && sh.shellHint ? "\n\n" + sh.shellHint : "";
        resolve("Команда завершилась с кодом " + code + timeNote + ":\n" + parts.join("\n").slice(0, 6000) + shHint);
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
    const args = shellArgsFor(command);
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
          const shot = encodeShot(img, {});
          done({ ok: true, dataUrl: "data:" + shot.mime + ";base64," + shot.buf.toString("base64"), mime: shot.mime });
        } catch (e) {
          fail(e.message);
        }
      }, 2500);
    });
    win.webContents.once("did-fail-load", (_e, code, desc) => fail(code + " " + String(desc || "").slice(0, 300)));
    win.loadURL(url).catch((e) => fail(e.message));
  });
}

// Сохранение скриншота на диск: скриншоты хранятся в userData/screenshots, чтобы
// агент мог проанализировать их vision-моделью через analyzeImage(path).
// Кодирование скриншота: JPEG по умолчанию (быстро, компактно, вдвое дешевле для
// vision-модели), PNG — по флагу png:true (точные задачи, чтение мелкого текста).
// Длинная сторона при необходимости ужимается до MAX_SHOT_SIDE.
const MAX_SHOT_SIDE = 1440;
function encodeShot(img, args) {
  const a = args || {};
  const wantPng = a.png === true || a.format === "png";
  let out = img;
  try {
    const sz = img.getSize();
    const longest = Math.max(sz.width || 0, sz.height || 0);
    const cap = Math.min(Math.max(parseInt(a.maxWidth, 10) || MAX_SHOT_SIDE, 480), 2560);
    if (longest > cap) {
      const k = cap / longest;
      out = img.resize({ width: Math.max(1, Math.round(sz.width * k)), height: Math.max(1, Math.round(sz.height * k)), quality: "good" });
    }
  } catch {}
  if (!wantPng) {
    try {
      const q = Math.min(Math.max(parseInt(a.quality, 10) || 72, 30), 100);
      const jpg = out.toJPEG(q);
      if (jpg && jpg.length) return { buf: jpg, mime: "image/jpeg", ext: ".jpg" };
    } catch {}
  }
  const png = out.toPNG();
  return { buf: png, mime: "image/png", ext: ".png" };
}

// Сохранить скриншот на диск (расширение — по типу картинки). Агент читает его
// через analyzeImage(path).
function saveScreenshotPng(buf, baseName, mime) {
  const dir = path.join(app.getPath("userData"), "screenshots");
  fs.mkdirSync(dir, { recursive: true });
  const ext = String(mime || "").indexOf("jpeg") !== -1 ? ".jpg" : ".png";
  const file = path.join(dir, String(baseName || "shot").replace(/[^\w.-]+/g, "_") + "-" + Date.now() + ext);
  fs.writeFileSync(file, buf);
  return file;
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
  const args = opts.shellArgs || shellArgsFor(command);
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
  // Оболочки: агент сразу видит, что доступно (bash/sh появляются с Git for Windows),
  // и не тратит попытки на «а вдруг bash есть».
  try {
    parts.push("Оболочки: " + shellsBrief());
  } catch {}
  // Yandex Cloud: актуальный каталог и разрешения прямо в системном промпте.
  try {
    const ycLine = ycBriefLine(loadSettings());
    if (ycLine) parts.push(ycLine);
  } catch {}
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
      let errText = stripAnsi(stderr || "");
      if (err) {
        if (typeof err.code === "number") code = err.code;
        else if (err.killed) code = -1; // таймаут
        else if (err.code === "ENOENT") code = 127;
        // EINVAL, EPERM, EACCES и прочие системные коды — раньше все становились
        // безликой «1» с пустым выводом, и диагноз был невозможен.
        else if (typeof err.code === "string") code = err.code;
        else code = 1;
        // У ошибок запуска stderr пуст — отдаём сообщение, иначе агент видит пустоту.
        if (!errText) errText = stripAnsi(String(err.message || err));
      }
      resolve({ ok: !err, code, out: stripAnsi(stdout || ""), err: errText });
    });
  });
}

// ── Системные запросы PowerShell через живую сессию (ускорение №5) ──────────
// Разовый `powershell.exe -NoProfile -Command "..."` — это холодный старт .NET
// (0,4–1,5 с) на КАЖДЫЙ запрос справки. Живая сессия держит ОДИН процесс;
// при любом сбое (нет PowerShell, таймаут, процесс умер) — обычный разовый
// запуск, то есть поведение инструментов не меняется ни в одном сценарии.
async function psScript(script, timeoutMs) {
  const ms = timeoutMs || 30000;
  if (process.platform === "win32") {
    const r = await winPs.exec(script, { timeoutMs: ms });
    if (!r.noSession) return r;
  }
  return spawnRaw(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: os.homedir(),
    timeoutMs: ms,
  });
}

// Кэш системных справок: агент часто спрашивает одно и то же подряд (что за ПК,
// жив ли процесс). Живёт коротким TTL, чтобы не отдавать протухшее состояние.
// isBad(v) — «это не результат, а ошибка»: такое не кэшируем.
const _sysCache = new Map(); // key → { t, val }
async function cachedPs(key, ttlMs, fn, isBad) {
  const hit = _sysCache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.val;
  const val = await fn();
  if (val && !(typeof isBad === "function" && isBad(val))) _sysCache.set(key, { t: Date.now(), val });
  return val;
}
function invalidatePsCache(prefix) {
  for (const k of Array.from(_sysCache.keys())) {
    if (!prefix || k.indexOf(prefix) === 0) _sysCache.delete(k);
  }
}

// Обновить PATH текущего процесса из системного окружения (после установок).
async function refreshEnvFromOS() {
  const before = envPathInfo().value;
  let sysPath = "";
  if (process.platform === "win32") {
    const r = await psScript(
      "$m=[Environment]::GetEnvironmentVariable('Path','Machine'); $u=[Environment]::GetEnvironmentVariable('Path','User'); Write-Output ($m + ';' + $u)",
      30000
    );
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

// Скачивает файл по URL в указанный путь с проверкой размера.
async function downloadFileTo(url, dest, limitMb) {
  let res;
  try {
    res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "AI-Developer-Agent" } });
  } catch (e) {
    return { ok: false, error: "Ошибка загрузки " + url + ": " + (e.message || String(e)) };
  }
  if (!res.ok) return { ok: false, error: "Ошибка HTTP " + res.status + " при загрузке " + url };
  const buf = Buffer.from(await res.arrayBuffer());
  const limit = (limitMb || 800) * 1024 * 1024;
  if (buf.length > limit) return { ok: false, error: "Файл слишком большой (> " + (limitMb || 800) + " МБ)." };
  try {
    fs.writeFileSync(dest, buf);
  } catch (e) {
    return { ok: false, error: "Не удалось сохранить файл: " + (e.message || String(e)) };
  }
  return { ok: true, size: buf.length };
}

// Ищет установщики в распакованном архиве (не глубже 3 уровней; сначала те,
// что лежат ближе к корню — обычно это setup.exe верхнего уровня).
function findInstallersIn(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 3 || out.length >= 40) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const en of entries) {
      const full = path.join(d, en.name);
      if (en.isDirectory()) { walk(full, depth + 1); continue; }
      if (/\.(exe|msi|bat|cmd)$/i.test(en.name)) out.push(full);
    }
  };
  walk(dir, 0);
  out.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  return out;
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

// git add -A, но БЕЗ файлов секретов (env-файлы вида DOTENV*): агент
// (авто-чекпоинт, gitCommit, публикация) не должен закоммитить ключи в git.
async function stageAllSafe(dir, settings) {
  const r = await runGit(dir, ["add", "-A", "--", ".", ":(exclude,glob)**/" + ".env" + "*"], settings);
  if (!r.ok) return r;
  // Страховка: снимаем с индекса всё, что всё же проскочило (имя с DOTENV).
  try {
    const cached = await runGit(dir, ["diff", "--cached", "--name-only"], settings);
    if (cached.ok && cached.out) {
      const secret = cached.out.split("\n").map((l) => l.trim()).filter((l) => {
        const base = l.split("/").pop() || l;
        return /^\.env(\..*)?$/i.test(base) || /\.env$/i.test(base);
      });
      if (secret.length) await runGit(dir, ["restore", "--staged", "--", ...secret], settings);
    }
  } catch {}
  return r;
}

// ── Справочники по сайтам (agent-guides) ────────────────────────────────────
// Встроенные лежат рядом с кодом (src/agent-guides/*.md), выученные агентом —
// в userData/agent-guides. В шапке файла может быть строка
// <!-- sites: console.cloud.google.com, cloud.google.com --> — по ней гайд
// подхватывается автоматически, когда агент открывает такой адрес.
function guideDirs() {
  return [path.join(app.getPath("userData"), "agent-guides"), path.join(__dirname, "agent-guides")];
}
function guideSafeName(raw) {
  return String(raw || "").trim().replace(/^agent-guide:/i, "").replace(/[^a-z0-9-_]/gi, "").toLowerCase();
}
function guideFilePath(name, forWrite) {
  const safe = guideSafeName(name);
  if (!safe) return "";
  if (forWrite) return path.join(guideDirs()[0], safe + ".md");
  for (const dir of guideDirs()) {
    const p = path.join(dir, safe + ".md");
    if (fs.existsSync(p)) return p;
  }
  return "";
}
function guideSitesOf(text) {
  const m = String(text || "").match(/<!--\s*sites:\s*([^>]+?)-->/i);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function guideTitleOf(text) {
  const m = String(text || "").match(/^#\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 80) : "";
}
function guideIndex() {
  const out = [];
  for (const dir of guideDirs()) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { names = []; }
    for (const f of names) {
      if (!f.endsWith(".md")) continue;
      const name = f.slice(0, -3);
      if (out.some((g) => g.name === name)) continue; // выученный важнее встроенного
      let text = "";
      try { text = fs.readFileSync(path.join(dir, f), "utf8"); } catch (e) { continue; }
      out.push({ name: name, title: guideTitleOf(text), sites: guideSitesOf(text), learned: dir === guideDirs()[0] });
    }
  }
  return out;
}
function guideReadText(name) {
  const p = guideFilePath(name, false);
  if (!p) return "";
  try { return fs.readFileSync(p, "utf8"); } catch (e) { return ""; }
}
// Гайд по адресу: точный домен, затем по вхождению (console.cloud.google.com ← cloud.google.com).
function guideForUrl(url) {
  let host = "";
  try { host = String(new URL(url).hostname || "").toLowerCase().replace(/^www\./, ""); } catch (e) { host = ""; }
  if (!host) return null;
  const list = guideIndex();
  for (const g of list) {
    for (const s of g.sites) {
      if (host === s) return g;
    }
  }
  for (const g of list) {
    for (const s of g.sites) {
      if (host.endsWith("." + s) || s.endsWith("." + host)) return g;
    }
  }
  return null;
}
function agentGuideCall(args) {
  args = args || {};
  const action = String(args.action || (args.save ? "save" : args.name ? "read" : args.url ? "match" : "list")).toLowerCase();
  if (action === "list") {
    const list = guideIndex();
    if (!list.length) return "Справочников пока нет.";
    return (
      "Справочники агента (сайты и темы):\n" +
      list
        .map((g) => "• " + g.name + (g.title ? " — " + g.title : "") + (g.sites.length ? " [" + g.sites.join(", ") + "]" : "") + (g.learned ? " (мой, сохранён)" : ""))
        .join("\n") +
      "\nЧитать: agentGuide { name: \"google-cloud\" } — или readFile(path: \"agent-guide:google-cloud\").\n" +
      "Свой маршрут: after удачного прохода — agentGuide { save: \"сайт\", title: \"…\", steps: \"1) … 2) …\" }."
    );
  }
  if (action === "match") {
    const g = guideForUrl(args.url || args.site || "");
    if (!g) return "Для этого адреса справочника нет — ищи по DOM (browserSnapshot) и, пройдя путь, сохрани его: agentGuide { save: … }.";
    return "К этому сайту есть справочник «" + g.name + "»" + (g.title ? " (" + g.title + ")" : "") + ". Читай: agentGuide { name: \"" + g.name + "\" }.";
  }
  if (action === "read") {
    const name = guideSafeName(args.name || args.site || args.id);
    const text = guideReadText(name);
    if (!text) {
      const list = guideIndex().map((g) => g.name).join(", ") || "пусто";
      return "Ошибка: справочник «" + (name || "?") + "» не найден. Есть: " + list + ".";
    }
    return "СПРАВОЧНИК АГЕНТА: «" + name + "» (читай и следуй ему):\n\n" + text;
  }
  if (action === "save") {
    const name = guideSafeName(args.save === true || args.save === "true" ? args.name : args.name || args.save || args.site);
    const steps = String(args.steps || args.text || args.notes || "").trim();
    if (!name || !steps) {
      return "Ошибка agentGuide: для сохранения нужны name (сайт, латиницей) и steps — что и в каком порядке сработало (селекторы, подписи кнопок, подводные камни).";
    }
    const old = guideReadText(name);
    const body =
      "# " + (String(args.title || "").trim() || "Маршрут: " + name) + "\n" +
      (args.sites ? "<!-- sites: " + String(args.sites) + " -->\n" : "") +
      (old ? old.replace(/^[\s\S]*?\n---\n/, "") + "\n" : "") +
      "---\n## " + new Date().toISOString().slice(0, 10) + " — пройдено успешно\n" + steps + "\n";
    try {
      fs.mkdirSync(guideDirs()[0], { recursive: true });
      fs.writeFileSync(guideFilePath(name, true), body, "utf8");
    } catch (e) {
      return "Ошибка: не удалось сохранить справочник: " + String((e && e.message) || e).slice(0, 140);
    }
    return "OK — маршрут сохранён: agent-guides/" + name + ".md. В следующий раз я прочитаю его сразу (agentGuide { name: \"" + name + "\" }).";
  }
  return "agentGuide: неизвестное действие «" + action + "». Доступно: list, read (name), match (url), save (name + steps).";
}

async function executeTool(name, args, settings) {
  args = args || {};
  try {
    // Пользователь нажал Esc/«Стоп» — агент должен немедленно остановиться.
    if (global.__agentStopRequested) {
      return "⏹ Остановлено пользователем (Esc / Стоп). Немедленно прекрати вызовы инструментов и заверши ответ КРАТКИМ итогом: что успел сделать и что осталось.";
    }
    switch (name) {
      // Предохранитель B: модель просит нужную возможность словами — включаем её
      // группу в текущей задаче и перечисляем подходящие инструменты.
      case "findTools": {
        const query = String(args.query || "").trim();
        if (!query) return "Укажи query — что нужно сделать словами (например «отправить письмо»).";
        const found = searchTools(query, args.limit);
        if (!found.length) {
          return "Ничего не нашлось по запросу «" + query + "». Сформулируй иначе (действие + объект: «клик по элементу страницы», «запуш ветки») или используй runCommand.";
        }
        const groups = [...new Set(found.map((f) => f.group).filter(Boolean))];
        if (activeToolRouter && groups.length) activeToolRouter.addGroups(groups);
        return (
          "Нашёл инструменты по запросу «" + query + "» (схемы уже добавлены в запрос — вызывай их как обычно):\n" +
          found.map((f) => "• " + f.name + (f.group ? " [" + f.group + "]" : "") + " — " + truncateText(f.description, 160)).join("\n") +
          (groups.length ? "\nВключены группы: " + groups.join(", ") + ". Список всех инструментов задачи — " + (activeToolRouter ? activeToolRouter.names().join(", ") : "") : "")
        );
      }
      case "createFolder": {
        const p = resolvePath(args.path, settings);
        fs.mkdirSync(p, { recursive: true });
        return "OK — папка создана: " + p;
      }
      case "readFile": {
        // Специальный путь для встроенных справочников агента (не файлы проекта):
        // readFile(path: "agent-guide:vk") → полный гайд по работе с ВКонтакте.
        const guidePath = String(args.path || "").trim();
        if (guidePath.startsWith("agent-guide:")) {
          const guideName = guideSafeName(guidePath);
          const guideFile = guideFilePath(guideName, false);
          if (guideFile) {
            return "СПРАВОЧНИК АГЕНТА: «" + guideName + "» (прочитай перед работой и следуй ему):\n\n" + fs.readFileSync(guideFile, "utf8");
          }
          const list = guideIndex().map((g) => g.name).join(", ") || "пусто";
          return "Ошибка: справочник «" + guideName + "» не найден. Есть: " + list + ". Список в любой момент: agentGuide {}.";
        }
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
        if (selfDev.protectedSelfPath(p, { appSrcDir: __dirname, otaRoot: ota.resolveCurrent() })) {
          return selfDev.protectedSelfPathMessage(p);
        }
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
      case "shellsStatus": {
        const rows = shellsStatus().map((s) => {
          if (s.available) return "✅ " + s.kind + (s.def ? " (по умолчанию)" : "") + " — " + (s.path || "найден в PATH");
          return "❌ " + s.kind + " — " + (s.hint || "не найден");
        });
        const defLine = process.platform === "win32" ? "По умолчанию команды идут в cmd." : "По умолчанию команды идут в sh.";
        const tip =
          process.platform === "win32"
            ? '\n\nПодсказка: PowerShell есть всегда — shell: "powershell" (кавычки, $ и 2>$null работают как в консоли). bash и sh появляются вместе с Git for Windows: installSystemPackage("git").'
            : "";
        return "Оболочки на этой машине:\n" + rows.join("\n") + "\n\n" + defLine + ' Выбор — параметр shell у runCommand и startBackground.' + tip;
      }
      case "runCommand": {
        const cmd = String(args.command || "").trim();
        if (!cmd) return "Ошибка: укажи команду";
        const shellRaw = String(args.shell == null ? "" : args.shell).trim();
        const shellName = normalizeShell(shellRaw);
        if (shellRaw && !shellName) {
          return "Ошибка: неизвестная оболочка «" + shellRaw + "». Доступно: cmd, powershell, pwsh, bash, sh.";
        }
        const cwd = agentWorkDir(settings);
        const timeoutMs = Math.min(parseInt(args.timeoutMs, 10) || 120000, 300000);
        termAgentEcho("$ " + cmd + "   (каталог: " + cwd + (shellName ? ", оболочка: " + shellName : "") + ")");
        const out = await runTerminalCommand(cmd, cwd, timeoutMs, shellName);
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
        const shellRaw = String(args.shell == null ? "" : args.shell).trim();
        const shellName = normalizeShell(shellRaw);
        if (shellRaw && !shellName) {
          return "Ошибка: неизвестная оболочка «" + shellRaw + "». Доступно: cmd, powershell, pwsh, bash, sh.";
        }
        const cwd = args.cwd ? resolvePath(args.cwd, settings) : agentWorkDir(settings);
        const bgShell = resolveShell(cmd, shellName);
        // Нет оболочки — spawn упадёт асинхронно, а инструмент успел бы отрапортовать
        // «OK … PID: undefined». Отвечаем честно и сразу.
        if (bgShell.missing) {
          return (
            "Ошибка: оболочка «" + (shellName || "?") + "» не найдена — фоновый процесс НЕ запущен.\n" +
            bgShell.shellHint +
            '\n\nПроверь доступные оболочки через shellsStatus, затем используй shell: "powershell" или "cmd".'
          );
        }
        const rec = bgSpawn(cmd, { name: args.name, cwd, shell: bgShell.shell, shellArgs: bgShell.args });
        termAgentEcho("$ " + cmd + "   (фоновый процесс " + rec.id + ", каталог: " + cwd + (shellName ? ", оболочка: " + shellName : "") + ")");
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
        const IMG_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif" };
        const dataUrl = "data:" + (IMG_MIME[ext] || "image/png") + ";base64," + fs.readFileSync(p).toString("base64");
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
          return "Ошибка анализа изображения: " + fmtError(e) + ". Проверь ключ и модель-зрение в Настройках → «🖼 Зрение и генерация».";
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
          return "Ошибка генерации изображения: " + fmtError(e) + ". Проверь ключ и модель-генерацию в Настройках → «🖼 Зрение и генерация».";
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
        let saved = null;
        try {
          const buf = Buffer.from(String(shot.dataUrl).split(",")[1] || "", "base64");
          if (buf.length) saved = saveScreenshotPng(buf, "page", shot.mime);
        } catch {}
        return "OK — скриншот " + url + " снят (1280×800), показан пользователю во встроенном просмотрщике" +
          (saved ? " и сохранён: " + saved : "") +
          ". Чтобы понять, что на экране, вызови analyzeImage(path: '" + (saved || "") + "') — вернёт описание вспомогательной vision-моделью.";
      }
      case "envSet": {
        const key = String(args.key || "").trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          return "Ошибка: имя переменной должно быть вида DATABASE_URL (латиница, цифры, подчёркивание)";
        }
        const value = String(args.value ?? "");
        const s = loadSettings();
        userAgentEnv[key] = value;
        s.agentEnv = { ...userAgentEnv };
        saveSettings(s);
        applyAgentEnv(s);
        return "OK — переменная " + key + " задана. Она доступна во всех следующих командах (runCommand, startBackground, shell, git, docker). Значение в чат не выводится.";
      }
      case "envList": {
        const keys = Object.keys(agentEnv);
        if (!keys.length) return "Переменные окружения агента не заданы. Задай через envSet(key, value).";
        const auto = ycAutoEnv(loadSettings());
        return "Доступные переменные (" + keys.length + "):\n" +
          keys.map((k) => {
            const v = String(agentEnv[k] || "");
            return "• " + k + " — установлена (" + v.length + " симв.)" + (k in auto ? " [авто: Yandex Cloud]" : "");
          }).join("\n") +
          "\n\nЗначения скрыты — они подмешиваются в команды автоматически.";
      }
      case "envUnset": {
        const key = String(args.key || "").trim();
        if (!key) return "Ошибка: укажи key";
        const auto = ycAutoEnv(loadSettings());
        if (!(key in userAgentEnv)) {
          if (key in auto) {
            return "Переменная " + key + " подставляется автоматически из настроек Yandex Cloud (Настройки → Yandex Cloud) — вручную её убрать нельзя.";
          }
          return "Переменная «" + key + "» не задана.";
        }
        const s = loadSettings();
        delete userAgentEnv[key];
        s.agentEnv = { ...userAgentEnv };
        saveSettings(s);
        applyAgentEnv(s);
        return "OK — переменная " + key + " удалена.";
      }
      case "writeFile": {
        if (!args.path) return "Ошибка: укажи path";
        const p = resolvePath(args.path, settings);
        if (selfDev.protectedSelfPath(p, { appSrcDir: __dirname, otaRoot: ota.resolveCurrent() })) {
          return selfDev.protectedSelfPathMessage(p);
        }
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
        // Serper (Google), если ключ задан в настройках; иначе — DuckDuckGo
        return await webSearch(q, settings && settings.serperApiKey);
      }
      case "webFetch": {
        return await webFetchPage(args.url);
      }
      // Браузерные инструменты (Playwright): видимое окно Chromium, которым агент управляет сам.
      // browserConnect — переключение на СВОЙ Chrome пользователя через порт отладки (CDP).
      case "browserConnect": {
        return await browserTools.connect(args);
      }
      case "browserOpen": {
        const opened = await browserTools.open(args);
        // Есть справочник по этому сайту — говорим сразу, а не после блужданий.
        if (typeof opened === "string" && !/^Ошибка/.test(opened)) {
          const g = guideForUrl(args && args.url);
          if (g) {
            return (
              opened +
              "\n📘 По этому сайту есть справочник агента «" + g.name + "»" + (g.title ? " (" + g.title + ")" : "") +
              " — прочитай ПЕРЕД действиями: agentGuide { name: \"" + g.name + "\" } (маршруты, подводные камни, селекторы)."
            );
          }
        }
        return opened;
      }
      case "browserSnapshot": {
        return await browserTools.snapshot(args);
      }
      case "browserFill": {
        return await browserTools.fill(args);
      }
      case "browserClick": {
        return await browserTools.click(args);
      }
      // Несколько действий ОДНОЙ командой (клик → ввод → Enter → проверка):
      // слабая модель не тратит ходы на каждый шаг и не «застревает».
      case "browserAct": {
        return await browserTools.act(args);
      }
      case "browserSelect": {
        return await browserTools.select(args);
      }
      case "browserPress": {
        return await browserTools.press(args);
      }
      case "browserText": {
        return await browserTools.text(args);
      }
      case "browserScreenshot": {
        // Скриншот сохраняем ФАЙЛОМ (data URL в контексте агента — это десятки
        // тысяч токенов). Файл показываем пользователю и, если настроено зрение,
        // разбираем vision-моделью. Модель может не ответить — тогда честно
        // говорим об этом и оставляем агенту пути по DOM.
        const shotDir = path.join(os.tmpdir(), "ai-agent-shots");
        const shot = await browserTools.screenshotFile(Object.assign({}, args, { dir: shotDir }));
        if (shot.error) return shot.error;
        const shotData = "data:image/png;base64," + shot.buf.toString("base64");
        if (activeEmit) activeEmit({ type: "image", path: shot.path, dataUrl: shotData });
        let shotOut =
          "OK — скриншот сохранён" + (shot.path ? ": " + shot.path : " (файл записать не удалось, картинка показана в чате)") +
          "\nСтраница: " + (shot.url || "—") + (shot.title ? " («" + shot.title + "»)" : "");
        const vcfg = auxConfig(settings);
        if (args && args.analyze === false) {
          shotOut += "\nДальше: analyzeImage { path: \"" + shot.path + "\" } при необходимости.";
        } else if (vcfg.visionModel && vcfg.key) {
          // Зрение включается, как только указана модель и есть ключ (галочка «Зрение»
          // лишь разрешает авто-пре-пасс присланных картинок). Спрашиваем про кликабельное:
          // карта DOM врёт на кастомных компонентах, а разбор скриншота — нет.
          try {
            const q =
              args && args.question
                ? String(args.question)
                : "Разбери скриншот страницы как инструкцию к действию, коротко и по делу: 1) что это за экран (сайт, диалог, шаг); 2) какие элементы КЛИКАБЕЛЬНЫ (кнопки, ссылки, вкладки, чекбоксы) — их точные подписи; 3) какие поля ввода и что в них; 4) что мешает (баннеры, согласия, перекрытия) и что нажать, чтобы их убрать; 5) что находится ЗА пределами экрана (видно начало списка/край элемента). Без воды — это уйдёт программисту, который видит только текст.";
            const desc = await describeImageRemote(vcfg, shotData, q, vcfg.visionModel);
            shotOut += "\n\nЧто видно (vision-модель):\n" + (desc || "(пусто)");
          } catch (e) {
            shotOut +=
              "\n\nVision-модель не ответила (" + String((e && e.message) || e).slice(0, 120) + ") — это не блокер: работай по DOM." +
              "\nbrowserSnapshot (карта с ref) · browserDOM (HTML слоя) · browserEval (JS на странице) · browserOverlays (слои и помехи).";
          }
        } else {
          shotOut +=
            "\n\nЗрение не настроено — работай по DOM: browserSnapshot, browserDOM, browserEval, browserOverlays." +
            "\nЧтобы я видел страницу: Настройки → вкладка «Зрение» → включи и укажи модель (например gemini-2.5-flash), затем повтори скриншот.";
        }
        return shotOut;
      }
      case "browserEval": {
        return await browserTools.evalJs(args);
      }
      case "browserDOM": {
        return await browserTools.domHtml(args);
      }
      case "browserOverlays": {
        return await browserTools.overlays(args);
      }
      case "browserWait": {
        return await browserTools.wait(args);
      }
      // Прокрутка (страница, внутренние контейнеры, «до элемента») и наведение мыши:
      // без них половина элементов остаётся за экраном, а меню по hover не раскрыть.
      case "browserScroll": {
        return await browserTools.scroll(args);
      }
      case "browserHover": {
        return await browserTools.hover(args);
      }
      // Что страница реально отправила и что вернул сервер (XHR/fetch).
      case "browserNetwork": {
        return await browserTools.network(args);
      }
      // Дождаться, когда DOM перестанет меняться и сеть опустеет (Angular-перерисовки).
      case "waitForIdle": {
        return await browserTools.waitForIdle(args);
      }
      // Справочники по сайтам: встроенные (src/agent-guides) + выученные агентом.
      case "agentGuide": {
        return agentGuideCall(args);
      }
      case "browserClose": {
        return await browserTools.close(args);
      }
      case "browserStatus": {
        return await browserTools.status();
      }
      case "browserClearProfile": {
        return await browserTools.clearProfile();
      }
      // Менеджер паролей: список сайтов (без паролей) и подстановка входа в форму.
      // Пароль идёт напрямую в браузер и никогда не попадает в текст ответа.
      case "vaultList": {
        return vault.listText(loadSettings().sitePasswords);
      }
      case "vaultFill": {
        const site = args.site || args.name || args.url || "";
        const entry = vault.findEntry(loadSettings().sitePasswords, site);
        if (!entry) return vault.notFoundText(loadSettings().sitePasswords, site);
        return await vault.fillLogin(entry, args, browserTools);
      }
      // Почта: отправка писем (КП клиентам) и чтение входящих (коды подтверждения).
      case "mailSend": {
        const cfg = mailConfig(loadSettings());
        if (!cfg.allowSend) {
          return "⛔ Отправка писем агентом ЗАПРЕЩЕНА. Скажи пользователю включить Настройки → «✉️ Почта» → чекбокс «Разрешить агенту отправлять письма».";
        }
        if (!cfg.address || !cfg.password || !cfg.smtpHost) {
          return "Почта не настроена. Скажи пользователю: Настройки → «✉️ Почта» → адрес, пароль приложения, затем кнопка «Определить по адресу».";
        }
        const r = await mail.sendMail(
          { host: cfg.smtpHost, port: cfg.smtpPort, user: cfg.user, password: cfg.password, secure: !cfg.starttls, starttls: cfg.starttls },
          { fromName: cfg.fromName, to: args.to || args.recipient, subject: args.subject, text: args.text, html: args.html }
        );
        if (!r.ok) return "Ошибка отправки: " + r.error;
        return "OK — письмо отправлено: " + (Array.isArray(r.to) ? r.to.join(", ") : r.to) + ". Тема: " + String(args.subject || "").slice(0, 120);
      }
      case "mailList": {
        const cfg = mailConfig(loadSettings());
        if (!cfg.address || !cfg.password || !cfg.imapHost) return "Почта не настроена — Настройки → «✉️ Почта».";
        const r = await mail.listRecent(
          { host: cfg.imapHost, port: cfg.imapPort, user: cfg.user, password: cfg.password, secure: true },
          { limit: args.limit, unseenOnly: args.unseenOnly === true }
        );
        if (!r.ok) return "Ошибка чтения почты: " + r.error;
        if (!r.messages.length) return "Входящих писем нет (ящик пуст).";
        const rows = r.messages.map((m) => {
          const code = mail.extractCode(m.text);
          const preview = String(m.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
          return "• " + m.from + "\n  Тема: " + m.subject + "\n  Дата: " + m.date + (code ? "\n  Код: " + code : "") + "\n  " + preview;
        });
        return "Последние письма (" + r.messages.length + " из " + r.total + "):\n\n" + rows.join("\n\n") + "\n\nОтправить письмо: mailSend(to, subject, text).";
      }
      case "mailCode": {
        const cfg = mailConfig(loadSettings());
        if (!cfg.address || !cfg.password || !cfg.imapHost) return "Почта не настроена — Настройки → «✉️ Почта».";
        const r = await mail.listRecent(
          { host: cfg.imapHost, port: cfg.imapPort, user: cfg.user, password: cfg.password, secure: true },
          { limit: Math.min(parseInt(args.limit, 10) || 5, 10) }
        );
        if (!r.ok) return "Ошибка чтения почты: " + r.error;
        const want = String(args.from || args.query || "").trim().toLowerCase();
        const list = want ? r.messages.filter((m) => (m.from + " " + m.subject).toLowerCase().includes(want)) : r.messages;
        for (const m of list) {
          const code = mail.extractCode(m.text);
          if (code) return "Код подтверждения: " + code + "\nИз письма: " + m.subject + " (" + m.from + ", " + m.date + ")";
        }
        return "Код подтверждения не найден в последних " + r.messages.length + " письмах" + (want ? " от «" + want + "»" : "") + ". Вызови mailList — возможно, письмо ещё не пришло.";
      }
      // Инструменты управления собственным окном приложения (app-*): DOM внутри Electron-окна.
      case "appRead": {
        return await appUi.read(args, mainWindow);
      }
      case "appClick": {
        return await appUi.click(args, mainWindow);
      }
      case "appFill": {
        return await appUi.fill(args, mainWindow);
      }
      case "appSelect": {
        return await appUi.select(args, mainWindow);
      }
      case "appPress": {
        return await appUi.press(args, mainWindow);
      }
      case "appWait": {
        return await appUi.wait(args, mainWindow);
      }
      case "appScreenshot": {
        const dataUrl = await appUi.screenshot(args, mainWindow);
        if (activeEmit) activeEmit({ type: "image", path: "app:window", dataUrl });
        return "OK — скриншот окна приложения снят и показан во встроенном просмотрщике. Детали разбирай через analyzeImage.";
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
        const add = await stageAllSafe(cwd, settings);
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
        // Не-GitHub хостинг (GitLab, Bitbucket, свой сервер): создание репозитория
        // делается на сайте хостинга, а мы сами прописываем remote и пушим ветку —
        // без GitHub API и без ручных команд в терминале.
        const remoteUrl = String(args.remoteUrl || "").trim();
        if (remoteUrl) {
          if (!/^(https?:\/\/|git@|ssh:\/\/)/i.test(remoteUrl)) {
            return "Ошибка: remoteUrl должен быть git-адресом — https://gitlab.com/you/repo.git или git@bitbucket.org:you/repo.git.";
          }
          const remoteName = String(args.remoteName || "origin").trim() || "origin";
          const existR = await runGit(cwdP, ["remote"], settings);
          const hasRemote = String(existR.out || "").split("\n").map((x) => x.trim()).includes(remoteName);
          const setR = await runGit(cwdP, hasRemote ? ["remote", "set-url", remoteName, remoteUrl] : ["remote", "add", remoteName, remoteUrl], settings);
          if (!setR.ok) return "Ошибка git remote: " + setR.err;
          const brR = await runGit(cwdP, ["rev-parse", "--abbrev-ref", "HEAD"], settings);
          const branch = String(brR.out || "").trim() || "main";
          const pushR = await runGit(cwdP, ["push", "-u", remoteName, branch], settings);
          if (!pushR.ok) {
            return (
              "Remote «" + remoteName + "» → " + remoteUrl + " прописан, но push не прошёл:\n" + pushR.err +
              "\n\nЧастые причины: репозиторий ещё не создан на сайте хостинга; нужен токен (для GitLab/Bitbucket — personal access token в адресе вида https://oauth2:TOKEN@host/…) или у аккаунта нет прав на запись."
            );
          }
          return "✅ Отправлено на «" + remoteName + "» (" + remoteUrl + "), ветка " + branch + ".\n" + (pushR.out || "Готово (без вывода).");
        }
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
      case "gitInit": {
        const dir = args.directory ? resolvePath(args.directory, settings) : agentWorkDir(settings);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return "Ошибка: папка не найдена: " + dir;
        const s = loadSettings();
        const check = await runGit(dir, ["rev-parse", "--is-inside-work-tree"], s);
        if (check.ok && String(check.out || "").trim() === "true") {
          return "Эта папка уже git-репозиторий: " + dir + "\nСостояние смотри через gitStatus.";
        }
        let initR = await runGit(dir, ["init", "-b", "main"], s);
        if (!initR.ok) initR = await runGit(dir, ["init"], s); // старые git без -b
        if (!initR.ok) return "Ошибка git init: " + initR.err;
        const msg = String(args.message || "").trim();
        if (msg) {
          const addR = await runGit(dir, ["add", "-A"], s);
          if (!addR.ok) return "Репозиторий создан, но первый коммит не удался: " + addR.err;
          const commitR = await runGit(dir, ["-c", "user.name=AI Agent", "-c", "user.email=ai-agent@local", "commit", "-m", msg], s);
          if (!commitR.ok) return "Репозиторий создан, но первый коммит не удался: " + commitR.err;
          return "✅ Создан локальный git-репозиторий: " + dir + " (ветка main), первый коммит «" + msg + "» сделан.\nGitHub НЕ задействован — это чисто локальный репозиторий.\nДальше можно: gitCommit — новые коммиты, gitBranch — ветки, gitPush — отправить в удалённый репозиторий (когда пользователь разрешит).";
        }
        return "✅ Создан локальный git-репозиторий: " + dir + " (ветка main).\nGitHub НЕ задействован — это чисто локальный репозиторий.\nДальше можно: gitCommit(message) — сделать первый коммит, gitBranch — ветки, gitPush — отправить в удалённый репозиторий (когда пользователь разрешит).";
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
          // CIM-запрос конфигурации ПК — самый дорогой в инструменте, а меняется
          // он раз в жизни машины: 30 с кэша снимают повторный обход системы.
          const siRaw = await cachedPs("sysinfo", 30000, async () => {
            const r = await psScript(ps, 30000);
            return r.ok ? r.out : "";
          });
          const si = parseSysInfoJson(siRaw);
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
          // Список процессов спрашивают подряд («сервер ещё жив?»): 2 с кэша
          // снимают повторный tasklist, а короткий TTL не показывает мёртвое.
          out = await cachedPs("proc:win", 2000, async () => {
            const r = await spawnRaw(["tasklist", "/FO", "CSV", "/NH"], { cwd: os.homedir(), timeoutMs: 20000 });
            return r.ok ? r.out : "";
          });
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
        invalidatePsCache("proc:"); // мы только что убили процесс — старый список не отдаём
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
        const shot = encodeShot(src.thumbnail, args);
        if (!shot.buf || !shot.buf.length) return "Пустой скриншот «" + src.name + "» — не удалось захватить.";
        const sz = src.thumbnail.getSize();
        const dataUrl = "data:" + shot.mime + ";base64," + shot.buf.toString("base64");
        if (activeEmit) activeEmit({ type: "image", path: "desktop:" + src.name, dataUrl });
        let saved = null;
        try {
          if (shot.buf.length) saved = saveScreenshotPng(shot.buf, "screen", shot.mime);
        } catch {}
        return "OK — скриншот «" + src.name + "» (" + sz.width + "×" + sz.height + ") снят, показан пользователю во встроенном просмотрщике" +
          (saved ? " и сохранён: " + saved : "") +
          ". Чтобы понять, что на экране, вызови analyzeImage(path: '" + (saved || "") + "') — вернёт описание вспомогательной vision-моделью.";
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
        // Реестр читают часто, а пишут редко — 5 с кэша на путь+значение;
        // ошибку (нет раздела/нет прав) не кэшируем: её могут исправить сразу.
        const rr = await cachedPs(
          "reg:" + regPath + "|" + name,
          5000,
          async () => {
            const r = await psScript(ps, 20000);
            return { out: (r.out || "").trim(), err: r.err || "" };
          },
          (v) => /__ERR__|Cannot find|не найден|отказано/i.test(v.out)
        );
        const out = rr.out;
        if (out.indexOf("__ERR__") !== -1 || /Cannot find|не найден|отказано/i.test(out + rr.err)) {
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
        const r = await psScript(ps, 20000);
        if (!r.ok || (r.out || "").indexOf("OK") === -1) {
          return "Ошибка записи: " + (((r.err || "") + " " + (r.out || "")).trim() || "неизвестная причина") + " — проверь права (HKCU не требует админа) или путь.";
        }
        invalidatePsCache("reg:"); // запись сделана — кэш чтения реестра больше не верен
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
        if (!/^https?:\/\//i.test(url)) {
          return "Ошибка: укажи прямой URL установщика — .exe, .msi или .zip (https://...).";
        }
        const tmpDir = path.join(os.tmpdir(), "ai-agent-install");
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { return "Ошибка: не удалось создать временную папку: " + (e.message || String(e)); }
        // Расширение берём из URL без строки запроса и #якоря. Имя файла больше
        // НЕ форсируется в .exe — иначе .msi и .zip скачивались как «installer.exe».
        const pathOnly = url.split("#")[0].split("?")[0];
        const ext = (path.extname(pathOnly) || "").toLowerCase();
        const rawBase = (name || path.basename(pathOnly) || "installer").replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.+$/, "") || "installer";
        const withExt = /\.(exe|msi|zip|msix|appx)$/i.test(rawBase) ? rawBase : rawBase + (ext || ".exe");

        // .zip — не установщик, а архив (portable-сборки): распаковываем и ищем
        // внутри .exe/.msi, чтобы сразу предложить (или выполнить) установку.
        if (ext === ".zip") {
          const destDir = path.join(tmpDir, withExt.replace(/\.zip$/i, "") + "-files");
          const res0 = await downloadAndExtractTo(url, destDir);
          if (/^Ошибка/.test(res0)) return res0;
          const found = findInstallersIn(destDir);
          if (!found.length) {
            return "Архив распакован: " + destDir + "\nУстановщика (.exe/.msi/.bat/.cmd) внутри не нашлось — это portable-сборка, запускай файлы прямо оттуда.\n" + res0;
          }
          const first = found[0];
          if (args.run !== true) {
            return (
              "Архив распакован: " + destDir + "\nНайдены установщики:\n" +
              found.slice(0, 10).map((f, i) => "  " + (i + 1) + ") " + f).join("\n") +
              "\n\nЗапустить первый: installExe({ url: ..., run: true }) — или запусти нужный файл сам через runCommand."
            );
          }
          const outZ = await runTerminalCommand('"' + first + '"', os.homedir(), 300000);
          return "Архив распакован: " + destDir + "\n$ \"" + first + "\"\n\n" + outZ;
        }

        // .msi ставится только msiexec (прямой запуск даёт «не является приложением»).
        if (ext === ".msi") {
          if (process.platform !== "win32") return "Ошибка: .msi ставится только в Windows (msiexec). Возьми .zip или сборку для этой ОС.";
          const destMsi = path.join(tmpDir, withExt);
          const dl = await downloadFileTo(url, destMsi);
          if (!dl.ok) return dl.error;
          const silentMsi = String(args.silentArgs || "").trim() || "/passive /norestart";
          const cmdMsi = "msiexec /i \"" + destMsi + "\" " + silentMsi;
          const outM = await runTerminalCommand(cmdMsi, os.homedir(), 300000, "cmd");
          const looksFailedM = /кодом (?!0$)[0-9]+|Access is denied|отказано в доступе|требуется повышение|administrator|1603|1722/i.test(outM);
          return (
            "Установщик скачан: " + destMsi + " (" + Math.round(dl.size / 1024 / 1024) + " МБ)\n" +
            "$ " + cmdMsi + "\n\n" + outM +
            (looksFailedM
              ? "\n\nmsiexec вернул ошибку (1603/1722 — установка не прошла). Часто нужны права администратора: runCommandAsAdmin(\"" + cmdMsi.replace(/"/g, "") + "\")."
              : "\n\nПроверь: checkInstalledProgram(\"" + (name || "программа") + "\").")
          );
        }

        // .exe и всё остальное — как раньше: скачать и запустить с тихими ключами.
        const silent = String(args.silentArgs || "").trim() || "/S";
        const dest = path.join(tmpDir, withExt);
        const dlx = await downloadFileTo(url, dest);
        if (!dlx.ok) return dlx.error;
        const cmd = '"' + dest + '" ' + silent;
        const out = await runTerminalCommand(cmd, os.homedir(), 300000);
        const looksFailed = /кодом [0-9]+|Access is denied|отказано в доступе|требуется повышение|administrator/i.test(out);
        return (
          "Установщик скачан: " + dest + " (" + Math.round(dlx.size / 1024 / 1024) + " МБ)\n" +
          "$ " + cmd + "\n\n" + out +
          (looksFailed
            ? "\n\nЕсли установка требует прав администратора — повтори через runCommandAsAdmin(\"" + cmd.replace(/"/g, "") + "\")."
            : "\n\nПроверь: checkInstalledProgram(\"" + (name || "программа") + "\").")
        );
      }
      case "noteSave": {
        const nKey = String(args.key || "").trim();
        const nContent = String(args.content ?? "");
        const nR = agentStore.noteSave(app.getPath("userData"), agentWorkDir(settings), nKey, nContent);
        return nR.ok ? "OK — " + nR.message : "Ошибка: " + nR.error;
      }
      case "noteRead": {
        const nrKey = String(args.key || "").trim();
        const nrR = agentStore.noteRead(app.getPath("userData"), agentWorkDir(settings), nrKey);
        if (!nrR.ok) return "Ошибка: " + nrR.error;
        if (nrR.key) return "Заметка «" + nrR.key + "»:\n" + nrR.content;
        if (!nrR.notes.length) {
          return "Заметок проекта пока нет. Сохрани первую через noteSave(key, content) — они переживают перезапуск и помогают продолжать работу в новых сессиях.";
        }
        const nrRows = nrR.notes.map((n) => "• " + n.key + " (" + new Date(n.ts).toLocaleString() + "):\n  " + n.content.replace(/\n/g, "\n  "));
        return "Заметки проекта (" + nrR.notes.length + "):\n" + nrRows.join("\n\n");
      }
      case "noteList": {
        const nlR = agentStore.noteRead(app.getPath("userData"), agentWorkDir(settings), "");
        if (!nlR.ok) return "Ошибка: " + nlR.error;
        if (!nlR.notes.length) return "Заметок проекта пока нет. Сохрани первую через noteSave(key, content).";
        return "Заметки проекта (" + nlR.notes.length + "):\n" + nlR.notes.map((n) => "• " + n.key).join("\n");
      }
      case "noteDelete": {
        const ndKey = String(args.key || "").trim();
        const ndR = agentStore.noteDelete(app.getPath("userData"), agentWorkDir(settings), ndKey);
        return ndR.ok ? "OK — " + ndR.message : "Ошибка: " + ndR.error;
      }
      case "todoWrite": {
        // План работ: приложение только нормализует и показывает его панелью-
        // чеклистом — состояние (статусы, переживание перезапуска) хранит интерфейс.
        const planTasks = normalizePlanTasks(args.tasks != null ? args.tasks : args.items != null ? args.items : args);
        if (!planTasks.length) {
          return "Ошибка: план пуст. Пришли непустой tasks — массив до 7 пунктов (строка или { text, status }).";
        }
        const planTitle = String(args.title || "").trim().slice(0, 80);
        if (activeEmit) activeEmit({ type: "plan", tasks: planTasks, title: planTitle });
        const ps = planSummary(planTasks);
        const planRows = planTasks.map((t) =>
          (t.status === "done" ? "✅ " : t.status === "failed" ? "⚠️ " : t.status === "in_progress" ? "🔄 " : "⬜ ") +
          t.text + (t.note ? " — " + t.note : "")
        );
        return (
          "OK — план показан пользователю: " + ps.done + " из " + ps.total + " готово" +
          (ps.failed ? ", сбоев: " + ps.failed : "") + ".\n" +
          planRows.join("\n") + "\n" +
          (ps.done === ps.total
            ? "Все пункты готовы — подведи короткий итог без пересказа плана."
            : "Продолжай со следующего пункта; после каждого шага вызывай todoWrite заново с ПОЛНЫМ списком.")
        );
      }
      case "memoryList": {
        // Настройки читаем в момент вызова: галочку могли включить только что.
        const ms = loadSettings();
        const memDir = agentStore.contextMemoryDir(app.getPath("userData"));
        if (!ms.contextMemory) {
          return (
            "Память диалогов выключена. Включи галочку «Память диалогов» в Настройках → 🧠 Память диалогов: тогда сжатые памятки будут сохраняться локально по датам, и я смогу вспоминать прошлые сессии.\n" +
            "Папка дневника: " + memDir
          );
        }
        const mmDate = String(args.date || "").trim();
        if (mmDate) {
          const mr = agentStore.contextMemoryRead(app.getPath("userData"), mmDate);
          if (!mr.ok) return "Ошибка: " + mr.error;
          const rows = mr.memos.map((m) =>
            "• " + m.time + " — " + (m.provider || "?") + (m.model ? "/" + m.model : "") +
            (m.workDir ? "\n  папка: " + m.workDir : "") + "\n" + String(m.memo || "").replace(/^/gm, "  ")
          );
          return "Памятки контекста за " + mmDate + " (" + mr.count + "):\n\n" + rows.join("\n\n");
        }
        const md = agentStore.contextMemoryDays(app.getPath("userData"));
        if (!md.length) {
          return "Память диалогов включена, но памяток пока нет: они появляются, когда контекст переполняется и старые шаги сворачиваются в памятку.";
        }
        const mrows = md.map((d) =>
          "• " + d.date + " — " + d.count + " памяток" + (d.last ? ", последняя в " + new Date(d.last).toLocaleTimeString() : "")
        );
        return (
          "Дни в памяти диалогов (" + md.length + "):\n" + mrows.join("\n") +
          '\n\nПамятки за конкретный день — memoryList(date: "ГГГГ-ММ-ДД"); поиск — memorySearch(query: "...").'
        );
      }
      case "memorySearch": {
        const ms2 = loadSettings();
        if (!ms2.contextMemory) {
          return "Память диалогов выключена — включи галочку «Память диалогов» в настройках (Настройки → 🧠).";
        }
        const mq = String(args.query || "").trim();
        if (!mq) return "Ошибка: укажи query — что искать в памятках.";
        const msr = agentStore.contextMemorySearch(app.getPath("userData"), {
          query: mq,
          date: String(args.date || "").trim(),
          limit: Number(args.limit) || 20,
        });
        if (!msr.ok) return "Ошибка: " + msr.error;
        if (!msr.matches.length) {
          return "По запросу «" + mq + "» в памяти диалогов ничего не найдено. Список дней — memoryList.";
        }
        const srows = msr.matches.map((m) => "• " + m.date + " " + m.time + " (совпадений: " + m.hits + "): " + m.snippet);
        return "Найдено в памяти диалогов (" + msr.count + "):\n" + srows.join("\n");
      }
      case "checkpointSave": {
        const csR = agentStore.checkpointSave(app.getPath("userData"), agentWorkDir(settings), args.label);
        return csR.ok ? "OK — " + csR.message : "Ошибка: " + csR.error;
      }
      case "checkpointList": {
        const clR = agentStore.checkpointList(app.getPath("userData"));
        if (!clR.checkpoints.length) {
          return "Чекпоинтов пока нет. Создай первый через checkpointSave(label) перед серией правок — потом можно откатиться через checkpointRollback(id).";
        }
        const clRows = clR.checkpoints.map((c) => "• " + c.id + " — «" + c.label + "», " + c.files + " файлов, " + new Date(c.createdAt).toLocaleString());
        return "Чекпоинты (" + clR.checkpoints.length + "):\n" + clRows.join("\n");
      }
      case "checkpointRollback": {
        const crId = String(args.id || "").trim();
        if (!crId) return "Ошибка: укажи id чекпоинта (смотри checkpointList).";
        const crR = agentStore.checkpointRollback(app.getPath("userData"), crId);
        if (!crR.ok) return "Ошибка: " + crR.error;
        return "OK — " + crR.message + (crR.errors && crR.errors.length ? "\nОшибки: " + crR.errors.join("; ") : "");
      }
      case "otaStatus": {
        const os = ota.status(loadSettings());
        return (
          "OTA-статус:\n" +
          "• Включено: " + (os.enabled ? "да" : "нет — включи в настройках «🔄 Самосовершенствование (OTA)»\n") +
          "• Установленная версия кода: " + os.installed + "\n" +
          "• Папка OTA: " + os.dir + "\n" +
          "• Источники бандлов: " + (os.sources && os.sources.length ? "\n  " + os.sources.join("\n  ") : "—")
        );
      }
      case "otaCheck": {
        const oc = await ota.check(loadSettings());
        if (oc.status === "disabled") return "OTA отключено в настройках (галочка «Разрешить локальные обновления на ходу»).";
        if (oc.status === "busy") return "Сейчас идёт работа агента — применять обновление нельзя. Бандл применится автоматически в течение минуты после завершения задачи.";
        if (oc.status === "applied") return "✅ Обновление применено до версии " + oc.version + " — приложение перезапускается с новым кодом.";
        if (oc.status === "error") return "Ошибка применения OTA: " + (oc.message || "неизвестная") + "\nПроверь синтаксис изменённых файлов (node --check) и пересобери бандл (node scripts/make-ota.js).";
        return "Обновлений нет — код актуален.";
      }
      case "otaRollback": {
        if (global.__agentRunning) return "Нельзя откатываться во время работы агента — дождись завершения текущей задачи.";
        const or = ota.rollback();
        return or.ok ? "↩ Откат выполнен — приложение перезапускается с предыдущей версией кода." : "Ошибка отката: " + (or.message || "предыдущей версии нет");
      }
      case "applyPatch": {
        const patch = String(args.patch ?? "");
        if (!patch.trim()) return "Ошибка: укажи patch — unified diff (формат git diff) с изменениями файлов.";
        const base = args.basePath ? resolvePath(args.basePath, settings) : agentWorkDir(settings);
        if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return "Ошибка: базовой директории нет: " + base;
        // Снимаем undo-снимки для всех файлов, которые затронет патч.
        for (const f of unifiedPatch.parsePatch(patch)) {
          const rel = unifiedPatch.safeRel(base, f.b || f.a);
          if (!rel) continue;
          const abs = path.join(base, rel);
          if (selfDev.protectedSelfPath(abs, { appSrcDir: __dirname, otaRoot: ota.resolveCurrent() })) {
            return "⛔ Патч затрагивает защищённый файл самообновления: " + abs + "\nПравка src/bootstrap.js, src/ota.js или папки применённого OTA-бандла заблокирована — убери этот файл из патча.";
          }
          if (fs.existsSync(abs) && fs.statSync(abs).isFile()) snapshotFileForUndo(abs);
        }
        const r = unifiedPatch.applyUnifiedPatch(base, patch);
        if (!r.ok) {
          return "Ошибка применения патча:\n" + r.errors.map((e) => "• " + e.path + " — " + e.error).join("\n") +
            "\n\nПеречитай файлы (readFile) и сгенерируй патч заново с точным контекстом, либо правь файлы по одному через editFile.";
        }
        return "OK — патч применён, изменено файлов: " + r.changed.length + (r.changed.length ? "\n" + r.changed.map((f) => "• " + f).join("\n") : "");
      }
      case "waitUntil": {
        const secs = Math.max(1, Math.min(parseInt(args.seconds, 10) || 5, 300));
        if (args.reason) termAgentEcho("⏳ " + args.reason + " (жду " + secs + " с)");
        await new Promise((res) => setTimeout(res, secs * 1000));
        return "OK — подождал " + secs + " с" + (args.reason ? " (" + args.reason + ")" : "") + ". Теперь перепроверь состояние (например checkPort/checkUrl/backgroundOutput).";
      }
      case "gitStash": {
        const cwd = agentWorkDir(settings);
        const action = String(args.action || "push").toLowerCase();
        const isList = action === "list";
        const isPop = action === "pop";
        const isPush = action === "push";
        if (!isList && !isPop && !isPush) return "Ошибка: action может быть push (сохранить изменения), pop (вернуть) или list (показать).";
        if (isList) {
          const r = await runGit(cwd, ["stash", "list"], settings);
          return r.ok ? (r.out || "Стеков stash нет.") : "Ошибка git: " + r.err;
        }
        if (isPop) {
          const r = await runGit(cwd, ["stash", "pop"], settings);
          if (!r.ok) return "Ошибка git: " + r.err + " (возможен конфликт — проверь gitStatus и разбери изменения вручную).";
          return "OK — изменения возвращены из stash:\n" + r.out;
        }
        const msg = String(args.message || "").trim() || "Авто-stash агента";
        const r = await runGit(cwd, ["stash", "push", "-m", msg], settings);
        if (!r.ok) return "Ошибка git: " + r.err;
        return "OK — изменения спрятаны в stash («" + msg + "»). Вернуть: gitStash(action: pop). Рабочее дерево теперь чистое.";
      }
      case "gitCherryPick": {
        const cwd = agentWorkDir(settings);
        const commit = String(args.commit || "").trim();
        if (!commit) return "Ошибка: укажи commit — хэш или ссылку (например HEAD~1 или abc123).";
        const r = await runGit(cwd, ["cherry-pick", commit], settings);
        if (!r.ok) return "Ошибка git: " + r.err + " (возможен конфликт — разбери его, затем gitCherryPick не нужен, просто gitCommit после разрешения).";
        return "OK — коммит " + commit + " перенесён на текущую ветку:\n" + r.out;
      }
      case "gitBlame": {
        const cwd = agentWorkDir(settings);
        const p = resolvePath(args.path, settings);
        if (!fs.existsSync(p)) return "Ошибка: файл не найден: " + p;
        const rel = path.relative(cwd, p) || path.basename(p);
        const lines = parseInt(args.lines, 10);
        const gitArgs = ["blame"];
        if (Number.isInteger(lines) && lines >= 1) gitArgs.push("-L", "1," + Math.min(lines, 500));
        gitArgs.push("--", rel);
        const r = await runGit(cwd, gitArgs, settings);
        if (!r.ok) return "Ошибка git: " + r.err;
        return "История строк файла " + rel + " (git blame):\n" + truncateText(r.out, 9000);
      }
      case "semanticSearch": {
        const query = String(args.query || "").trim();
        if (!query) return "Ошибка: укажи query — что ищем по смыслу (например «валидация входа», «db подключение»).";
        const base = args.path ? resolvePath(args.path, settings) : agentWorkDir(settings);
        if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return "Ошибка: директория не найдена: " + base;
        const maxResults = Math.min(parseInt(args.maxResults, 10) || 8, 20);
        const index = codeIndex.getIndex(app.getPath("userData"), base);
        if (!index.docsCount) return "Нечего искать в " + base + " — текстовых файлов не найдено.";
        const hits = codeIndex.searchIndex(index, query, maxResults);
        if (!hits.length) {
          return "По запросу «" + query + "» ничего не найдено в " + index.docsCount + " файлах (индекс: " + base + ").\nПопробуй другие слова (поиск работает по смыслу: auth → authenticate) или searchFile для точного регулярного поиска.";
        }
        const rows = hits.map((h, i) => {
          const sn = codeIndex.snippetForFile(base, h.rel, query, 3);
          return "#" + (i + 1) + " " + h.rel + " (релевантность " + h.score.toFixed(2) + ")\n" + sn.text;
        });
        return (
          "Семантический поиск «" + query + "» — индексировано файлов: " + index.docsCount + ", топ-" + hits.length + ":\n\n" +
          rows.join("\n\n") +
          "\n\nДальше: readFileLines(path, start, count) — читать найденное, searchFile — точный регулярный поиск."
        );
      }
      // ── Yandex Cloud (REST API): инструменты агента ──
      case "ycStatus": {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) {
          return "Yandex Cloud не подключён. Скажи пользователю: Настройки → «☁️ Yandex Cloud» → получить OAuth-токен и вставить его. После авторизации инструмент заработает.";
        }
        if (!cfg.folderId) return "Авторизация есть, но не выбран каталог. Открой Настройки → Yandex Cloud и выбери каталог (или дождись, пока приложение выберет первый автоматически).";
        try {
          const svcs = await yandexCloud.resourcesStatus(cfg.oauth, cfg.folderId);
          const rows = svcs.map((s) => "• " + s.icon + " " + s.title + ": " + (s.ok ? s.count : "ошибка: " + String(s.error || "").slice(0, 120)));
          return (
            "Yandex Cloud · каталог «" + cfg.folderName + "» (" + cfg.folderId + ")\n" +
            "Создание агентом: " + (cfg.allowCreate ? "разрешено" : "ЗАПРЕЩЕНО — включи в Настройках → Yandex Cloud") + "\n" +
            "Удаление агентом: " + (cfg.allowDelete ? "разрешено" : "ЗАПРЕЩЕНО — включи в Настройках → Yandex Cloud") + "\n\nРесурсы:\n" +
            rows.join("\n") +
            "\n\nСоздание: ycCreate(service, name). Доступны: " + yandexCloud.creatableKeys().join(", ") + ". Удаление: ycDelete(service, id) — id виден в ycList."
          );
        } catch (e) {
          return "Ошибка Yandex Cloud: " + ((e && e.message) || String(e));
        }
      }
      case "ycList": {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        if (!cfg.folderId) return "Не выбран каталог — Настройки → Yandex Cloud.";
        const serviceKey = String(args.service || args.key || "").trim();
        const svcDef = serviceKey ? yandexCloud.serviceByKey(serviceKey) : null;
        if (serviceKey && !svcDef) return "Неизвестный сервис: " + serviceKey + ". Доступны: " + yandexCloud.SERVICES.map((s) => s.key).join(", ") + ".";
        try {
          if (svcDef) {
            const r = await yandexCloud.listService(cfg.oauth, cfg.folderId, svcDef);
            // Каталог отдаёт объекты { id, name }, а Postbox (SES) — просто строки.
            const items = r.items.slice(0, 30).map((it) => {
              if (it == null) return "• —";
              if (typeof it !== "object") return "• " + String(it);
              return "• " + (it.name || it.id || "—") + (it.id ? "  (" + it.id + ")" : "");
            });
            return "«" + svcDef.title + "» в каталоге «" + cfg.folderName + "»: всего " + r.count + (r.count ? ":\n" + items.join("\n") : " — пусто.");
          }
          const all = await yandexCloud.resourcesStatus(cfg.oauth, cfg.folderId);
          return all.map((s) => "• " + s.icon + " " + s.title + ": " + (s.ok ? s.count : "ошибка: " + String(s.error || "").slice(0, 100))).join("\n");
        } catch (e) {
          return "Ошибка Yandex Cloud: " + ((e && e.message) || String(e));
        }
      }
      case "ycCreate": {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        if (!cfg.folderId) return "Не выбран каталог — Настройки → Yandex Cloud.";
        if (!cfg.allowCreate) {
          return "⛔ Создание ресурсов в Yandex Cloud агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту создавать ресурсы». (Удаление — отдельным чекбоксом.)";
        }
        const serviceKey = String(args.service || args.key || "").trim();
        const name = String(args.name || "").trim();
        if (!serviceKey || !name) return "Ошибка: укажи service (например ydb, serverlessContainers, storage, lockbox, containerRegistry, dns, vpc) и name. Создание платных ресурсов — только по явной просьбе пользователя.";
        try {
          const r = await yandexCloud.createResource(cfg.oauth, cfg.folderId, serviceKey, name);
          return "OK — " + r.message + " (service=" + serviceKey + ", каталог «" + cfg.folderName + "»). Проверить список: ycList(service: \"" + serviceKey + "\").";
        } catch (e) {
          return "Ошибка создания: " + ((e && e.message) || String(e));
        }
      }
      case "ycDelete": {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        if (!cfg.allowDelete) {
          return "⛔ Удаление ресурсов в Yandex Cloud агентом ЗАПРЕЩЕНО. Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту удалять ресурсы».";
        }
        const serviceKey = String(args.service || args.key || "").trim();
        const id = String(args.id || args.resourceId || "").trim();
        if (!serviceKey || !id) return "Ошибка: укажи service и id (id ресурса виден в ycList). Удаление необратимо — только по явной просьбе пользователя.";
        try {
          const r = await yandexCloud.deleteResource(cfg.oauth, serviceKey, id);
          return "OK — " + r.message + " (" + serviceKey + ").";
        } catch (e) {
          return "Ошибка удаления: " + ((e && e.message) || String(e));
        }
      }
      case "ycDeploy": {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        if (!cfg.folderId) return "Не выбран каталог — Настройки → Yandex Cloud.";
        const dir = args.directory ? resolvePath(args.directory, settings) : agentWorkDir(settings);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return "Ошибка: папка проекта не найдена: " + dir;
        const name = String(args.name || "").trim() || path.basename(dir);
        if (!cfg.allowCreate) {
          return "⛔ Деплой создаёт ресурсы в Yandex Cloud (реестр, контейнер, SA). Скажи пользователю включить в Настройках → «☁️ Yandex Cloud» чекбокс «Разрешить агенту создавать ресурсы». Деплой платный (Serverless Containers).";
        }
        // Прямой вызов общей логики деплоя (как кнопка «🚀 Задеплоить»)
        const cfg2 = ycConfig(loadSettings());
        const steps = [];
        const step = (t) => steps.push(t);
        try {
          const docker = findProgram("docker");
          if (!docker.found) return "Ошибка: Docker не найден на этом ПК. Установи Docker Desktop и повтори.";
          const df = path.join(dir, "Dockerfile");
          let dockerfile = df;
          if (!fs.existsSync(df)) {
            dockerfile = path.join(dir, "Dockerfile.yandexcloud");
            ycGenerateDockerfile(dir, dockerfile);
            step("Dockerfile сгенерирован");
          }
          const slug = yandexCloud.slugify(name);
          const reg = await yandexCloud.ensureRegistry(cfg2.oauth, cfg2.folderId, slug + "-registry");
          const image = "cr.yandex/" + reg.id + "/" + slug + ":latest";
          step("Реестр: " + reg.id);
          const iamTok = await yandexCloud.getIamToken(cfg2.oauth);
          const loginOut = await runTerminalCommand("docker login cr.yandex -u iam -p " + iamTok, dir, 90000);
          const loginTxt = String(loginOut || "");
          if (/error|denied|failed/i.test(loginTxt) && !/login succeeded/i.test(loginTxt)) {
            return "docker login не прошёл: " + truncateText(loginTxt, 500);
          }
          const buildOut = await runTerminalCommand('docker build -f "' + dockerfile + '" -t ' + image + ' .', dir, 600000);
          const buildTxt = String(buildOut || "");
          if (/error|failed|cannot/i.test(buildTxt) && !/successfully built/i.test(buildTxt)) {
            return "docker build упал:\n" + truncateText(buildTxt, 2500);
          }
          const pushOut = await runTerminalCommand("docker push " + image, dir, 600000);
          const pushTxt = String(pushOut || "");
          if (/error|denied|failed/i.test(pushTxt) && !/digest/i.test(pushTxt)) {
            return "docker push упал:\n" + truncateText(pushTxt, 1500);
          }
          step("Образ загружен: " + image);
          const cont = await yandexCloud.ensureContainer(cfg2.oauth, cfg2.folderId, slug);
          let saId = "";
          if (args.public !== false) {
            try {
              const sa = await yandexCloud.ensureServiceAccount(cfg2.oauth, cfg2.folderId, "sa-" + slug);
              saId = sa.id;
              await yandexCloud.addRoleOnFolder(cfg2.oauth, cfg2.folderId, sa.id, "serverless.containers.invoker");
              step("Публичный доступ настроен");
            } catch (e) {
              return "Не удалось настроить публичный доступ: " + ((e && e.message) || String(e));
            }
          }
          await yandexCloud.deployContainerRevision(cfg2.oauth, {
            containerId: cont.id,
            folderId: cfg2.folderId,
            imageUrl: image,
            serviceAccountId: saId || undefined,
            memoryMb: args.memoryMb || 256,
            cores: args.cores || 1,
            timeoutSec: args.timeoutSec || 30,
            env: args.env || {},
          });
          const info = await yandexCloud.containerInfo(cfg2.oauth, cont.id);
          return "✅ Приложение «" + name + "» задеплоено в Serverless Containers (каталог «" + cfg2.folderName + "»).\n\n" +
            "URL: " + (info.url || "—") + "\nКонтейнер: " + cont.id + "\nОбраз: " + image + "\n\nШаги:\n" +
            steps.map((s) => "• " + s).join("\n") +
            "\n\nПроверь доступ: открыть URL в браузере или curl. Логи: ycLogs(service: \"serverlessContainers\", id: \"" + cont.id + "\"). Повторный деплой той же папки обновит ревизию.";
        } catch (e) {
          return "Деплой не завершился: " + ((e && e.message) || String(e));
        }
      }
      case "ycLogs": {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        if (!cfg.folderId) return "Ошибка: выбери каталог (folder) в Настройках → Yandex Cloud.";
        const id = String(args.id || args.resourceId || "").trim();
        if (!id) return "Ошибка: укажи id ресурса (виден в ycList).";
        try {
          return await readYcLogsText(cfg, String(args.service || "").trim(), id, args);
        } catch (e) {
          return "Логи (" + (args.service || "ресурс") + "): " + ((e && e.message) || String(e));
        }
      }
      case "ycInstall": {
        const cfg = ycConfig(loadSettings());
        if (!cfg.oauth) return "Yandex Cloud не подключён — Настройки → Yandex Cloud.";
        const st = ycCliStatus();
        if (st.installed && !args.force) {
          // Пересобираем окружение: PATH и свежий YC_IAM_TOKEN — без перезапуска.
          applyAgentEnv(loadSettings());
          return "yc CLI уже встроен: " + st.path + " — доступен всем командам как «yc». YC_IAM_TOKEN (свежий IAM), YC_CLOUD_ID и YC_FOLDER_ID подставляются автоматически, yc init не нужен. Переустановить: ycInstall(force: true).";
        }
        try {
          const r = await ycCliInstall();
          if (!r.ok) return "Не удалось установить yc CLI: " + r.error;
          applyAgentEnv(loadSettings());
          const iamReady = !!ycIamEnvToken(ycConfig(loadSettings()));
          return "yc CLI установлен: " + r.path + " (версия " + r.version + ", " + r.os + "/" + r.arch + ", " + r.sizeMb + " МБ).\n" +
            "Папка добавлена в PATH всех команд агента — вызывай просто «yc ...». YC_IAM_TOKEN (свежий IAM), YC_CLOUD_ID и YC_FOLDER_ID подставляются автоматически, yc init не нужен. Проверка: yc config list" +
            (iamReady ? "" : "\n⚠ Свежий IAM-токен ещё не получен (нет сети или токен не принят) — если первая команда yc скажет «The token is invalid», повтори её через минуту.");
        } catch (e) {
          return "Не удалось установить yc CLI: " + ((e && e.message) || String(e));
        }
      }
      default:
        return "Ошибка: неизвестный инструмент " + name;
    }
  } catch (e) {
    return "Ошибка: " + fmtError(e);
  }
}

// ─────────────────────────── AI: список моделей ───────────────────────────
async function fetchModels(settings) {
  return listModels(settings);
}

// ─────────────────────────── AI: чат с инструментами ───────────────────────────
let activeAbort = null;
let activeEmit = null; // отправка ai:event из executeTool (showImage и т.п.)
// Роутер инструментов текущего запуска: findTools по нему включает группы на лету.
let activeToolRouter = null;

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
    const add = await stageAllSafe(dir, settings);
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

// Память диалогов: сохраняем сжатую памятку в локальный дневник по датам, но
// ТОЛЬКО если пользователь включил галочку «Память диалогов» (иначе — тишина).
function saveContextMemo(settings, entry, emit) {
  if (!settings || !settings.contextMemory) return null;
  if (!entry || !String(entry.text || "").trim()) return null;
  try {
    const r = agentStore.contextMemorySave(app.getPath("userData"), {
      ts: entry.ts,
      memo: entry.text,
      messages: entry.messages,
      provider: entry.provider,
      model: entry.model,
      workDir: agentWorkDir(settings),
      keepDays: Number(settings.contextMemoryDays) || agentStore.CTX_MEMO_DAY_KEEP,
    });
    if (r && r.ok && emit) {
      emit({
        type: "memory",
        text: "🧠 Память диалогов: сохранена памятка за " + r.day + " (памяток за день: " + r.count + "). Спросить прошлые сессии — memoryList / memorySearch.",
      });
    }
    return r;
  } catch {
    return null;
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
  let modelWin = 0; // реальное окно модели (0 — сервер не ответил)
  try {
    modelWin = await modelWindow(settings, settings.model);
    if (modelWin > 0) budget = Math.min(budget, modelWin - 4096);
    // Нижний предел — 3000 токенов, но НИКОГДА больше реального окна: у модели с
    // окном 2048 «пол» в 3000 гарантировал переполнение на каждом запросе.
    budget = Math.max(budget, modelWin > 0 ? Math.min(3000, modelWin) : 3000);
  } catch {}
  // Локальная модель без поддержки инструментов не сможет позвать ни один инструмент:
  // агент молча «разговаривал бы» и ничего не делал. Говорим об этом заранее и честно.
  if (provider === "ollama") {
    try {
      const oi = await ollamaModelInfo(settings, settings.model);
      if (oi.known && !oi.tools) {
        termEmit({
          type: "metrics",
          text:
            "⚠ Модель «" + settings.model + "» не умеет вызывать инструменты (нет capability «tools»): " +
            "она сможет только отвечать текстом, а не работать с файлами и git. " +
            "Возьми модель с поддержкой инструментов (например qwen3, llama3.1, mistral-nemo).",
        });
      }
    } catch {}
  }
  let contextRetried = false; // при переполнении контекста пробуем ещё раз с меньшим бюджетом
  let reportRetried = false; // пустой финальный текст — один раз просим итоговый отчёт
  // ── Роутер инструментов ──────────────────────────────────────────────────
  // Вместо «все 146 схем в каждом раунде» шлём базу + группы, нужные этой задаче
  // (routeTools из agent-core). Состав ЛИПКИЙ на всю задачу: группа, однажды
  // включённая, не исчезает на середине работы. Порядок схем всегда канонический —
  // иначе промахивается кэш префикса промпта (см. 1.5.46).
  const routerTask = (() => {
    const parts = [];
    for (let i = messages.length - 1; i >= 0 && parts.length < 3; i--) {
      const m = messages[i];
      if (!m || m.role !== "user") continue;
      const c = m.content;
      const txt = typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n")
          : "";
      if (txt) parts.push(txt);
    }
    return parts.join("\n").slice(0, 4000);
  })();
  // Группа → справочник агента: подключается сам, когда группа активна. Так «диета»
  // промпта ничего не теряет: длинные правила живут в гайдах и приходят ровно тогда,
  // когда нужны (браузер, система, окно приложения, облако).
  const GROUP_GUIDES = { browser: "browser", system: "system", app: "app", cloud: "yc" };
  const injectedGuides = new Set();
  const guideNotes = []; // system-сообщения с текстом гайдов (стабильный префикс)
  const stickyGroups = new Set(); // id групп, включённых в этой задаче
  const forceAllTools = !!settings.sendAllTools; // предохранитель C: «отправлять все инструменты»
  let routeInfo = null; // последний результат routeTools (метрики + предохранители)
  let activeTools = [];
  let toolsWeight = 0;
  let histBudget = 1500;
  let budgetWarned = false; // предупреждаем один раз за запуск, а не каждый раунд
  // Вес системного промпта (~8k токенов) — раньше в бюджет не входил, поэтому индикатор
  // контекста занижал заполнение и сжатие срабатывало позже, чем нужно.
  const systemWeight = estimateTokens(SYSTEM_PROMPT);
  // Объект для executeTool (findTools): включить группу на лету и посмотреть состав.
  activeToolRouter = {
    addGroups(ids) {
      let changed = false;
      for (const id of ids || []) {
        if (!id || stickyGroups.has(id)) continue;
        stickyGroups.add(id);
        changed = true;
      }
      if (changed) refreshTools();
    },
    has(id) {
      return stickyGroups.has(id);
    },
    names() {
      return activeTools.map((t) => t.function && t.function.name).filter(Boolean);
    },
    groups() {
      return [...stickyGroups];
    },
  };
  const refreshTools = () => {
    if (planMode) {
      routeInfo = null;
      activeTools = PLAN_MODE_TOOL_DEFINITIONS;
    } else {
      const baseWeight = routeTools({ text: "" }).tokens;
      // Потолок: не больше ROUTER_MAX_TOKENS и не больше того, что оставляет место
      // истории (system-промпт ~8k + минимум на диалог).
      const maxTokens = Math.max(baseWeight, Math.min(ROUTER_MAX_TOKENS, Math.max(baseWeight, budget - 12000)));
      routeInfo = routeTools({ text: routerTask, sticky: [...stickyGroups], forceAll: forceAllTools, maxTokens: maxTokens });
      for (const id of routeInfo.groups) stickyGroups.add(id);
      activeTools = routeInfo.tools;
    }
    toolsWeight = activeTools.length ? estimateTokens(JSON.stringify(activeTools)) : 0;
    // Тесное окно: схемы + промпт уже занимают почти всё. Честно говорим об этом
    // один раз — иначе агент «тупеет» без объяснений (модель видит обрезанный хвост).
    if (!budgetWarned && !planMode && budget > 0 && toolsWeight + systemWeight > budget * 0.9) {
      budgetWarned = true;
      termEmit({
        type: "metrics",
        text: "⚠ Окно модели мало: схемы (~" + Math.round(toolsWeight / 1000) + "k) + системный промпт (~" + Math.round(systemWeight / 1000) + "k) занимают почти всё окно (" + budget + " т.). Возьми модель с окном побольше — иначе агент видит обрезанный контекст и работает вслепую.",
      });
    }
    histBudget = Math.max(1500, Math.floor((budget - toolsWeight - systemWeight) * 0.85)); // история + резерв 15%: сжатие успевает до переполнения
    // Справочник группы: подключаем один раз за задачу, дальше он просто едет в запросе.
    if (!planMode && routeInfo) {
      for (const gid of routeInfo.groups) {
        const gname = GROUP_GUIDES[gid];
        if (!gname || injectedGuides.has(gname)) continue;
        const text = guideReadText(gname);
        if (!text.trim()) continue;
        injectedGuides.add(gname);
        guideNotes.push({
          role: "system",
          content:
            "=== СПРАВОЧНИК АГЕНТА: \"" + gname + "\" (группа \"" + gid + "\") — следуй ему в этой задаче ===\n" + text,
        });
        termEmit({ type: "metrics", text: "📘 Подключён справочник «" + gname + "» (группа «" + gid + "»)." });
      }
    }
  };
  refreshTools();
  const ctxManager = createContextManager({
    settings,
    emit,
    planMode,
    // Память диалогов: при сжатии контекста пишем памятку в локальный дневник (по датам).
    onMemo: (m) => saveContextMemo(settings, m, emit),
  });
  // Индикатор контекста: сколько токенов занимают история + схема инструментов.
  // Отправляется в интерфейс полоской под полем ввода (видно, когда контекст подходит к концу).
  const emitContext = (hist) => {
    try {
      const histTokens = hist && hist.length ? estimateTokens(JSON.stringify(hist)) : 0;
      const used = histTokens + toolsWeight + systemWeight;
      const percent = budget > 0 ? Math.max(0, Math.min(100, Math.round((used / budget) * 100))) : 0;
      emit({ type: "context", used, budget, percent, history: histTokens, tools: toolsWeight, system: systemWeight });
    } catch {}
  };

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
  emitContext(trimmedHistory);
  // Авто-разбор присланных картинок вспомогательной vision-моделью (второй ключ):
  // скриншот → описание → кодер работает с текстом (его модель может не видеть картинки).
  let runHistory = trimmedHistory;
  const vcfg = auxConfig(settings);
  if (vcfg.enabled && vcfg.auto && vcfg.visionModel && vcfg.url && !planMode) {
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
      content: SYSTEM_PROMPT + wdNote + briefNote + cloneNote + (planMode ? "\n\nРЕЖИМ ПЛАНА: доступен только todoWrite — вызови его с планом работ (3–7 пунктов) и в тексте перечисли файлы, которые затронешь. НЕ изменяй файлы и НЕ выполняй другие инструменты. Жди команды пользователя." : ""),
    },
    ...sanitizeToolPairs(runHistory.map((m) => ({ role: m.role, content: m.content }))),
  ];
  const maxRounds = planMode ? 3 : 25;
  let finalText = "";

  const stopGraceful = () => {
    if (!String(finalText || "").trim()) {
      finalText = "⏹ Остановлено пользователем. Изменения сохранены; напиши «продолжай», чтобы доработать.";
      emit({ type: "chunk", text: finalText });
    }
    lastUndoLog = activeRunUndo.slice();
    persistUndo();
    if (lastUndoLog.length) emit({ type: "undo_available", count: lastUndoLog.length });
    emit({ type: "done" });
    return { ok: true, text: finalText };
  };

  // Авто-повтор после сбоя: при любой ошибке (сеть/API/провайдер/инструмент) делаем ещё
  // попытку с продолжением контекста (история canonical сохраняется) — до AUTO_RETRY_LIMIT повторов.
  const AUTO_RETRY_LIMIT = 2;
  // Метрики раунда: токены/кэш/TTFB. Провайдер отдаёт их только по флагу
  // stream_options.include_usage; строгий сервер может его не знать — тогда
  // выключаем флаг на весь запуск и повторяем раунд (см. обработку !res.ok).
  let includeUsage = true;
  let roundUsage = null; // { prompt, completion, cached } текущего раунда
  for (let attemptNum = 1; ; attemptNum++) {
  try {
  for (let round = 0; round < maxRounds; round++) {
    roundUsage = null; // аккумулятор токенов текущего раунда
    const roundStartedAt = Date.now();
    let roundTtfbMs = 0;
    // Пользователь остановил агента (Esc/Стоп) — не начинаем новый раунд.
    if (global.__agentStopRequested) return stopGraceful();
    // Роутер: пересобираем набор схем (группы могли добавиться в прошлом раунде).
    refreshTools();
    let collected = "";
    const toolCalls = [];
    const stripper = createThinkingStripper({ onHidden: emitThink });

    // Контекст-менеджмент: между раундами держим историю в рамках бюджета токенов.
    // Хвост (текущий виток с tool-результатами) сохраняется целиком.
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...(await ctxManager.manage(canonical.slice(1), histBudget))];
      emitContext(canonical);
    }
    // Финальный предохранитель перед отправкой: осиротевшие tool-сообщения
    // (role:"tool" без предшествующего assistant с tool_calls) — 400 wrong_api_format.
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...sanitizeToolPairs(canonical.slice(1))];
    }

    const req = buildChatRequest(settings, {
      model: settings.model,
      messages: guideNotes.length ? [canonical[0], ...guideNotes, ...canonical.slice(1)] : canonical,
      tools: activeTools,
      // Статичный префикс промпта: до этой границы ставится точка кэша, чтобы
      // динамический «паспорт проекта» не обнулял кэш на каждом витке.
      staticSystem: SYSTEM_PROMPT,
      includeUsage: includeUsage,
      // Ollama: сколько контекста выделить (num_ctx) — считает agent-core из бюджета
      // и реального окна модели, чтобы сервер не резал запрос молча.
      numCtxBudget: budget,
      modelWindow: modelWin,
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
    roundTtfbMs = Date.now() - roundStartedAt; // заголовки ответа = первый байт
    if (!res.ok) {
      const detail = await readApiError(res);
      // Строгий OpenAI-совместимый сервер может не знать stream_options (мы просили им
      // токены и кэш). Это не ошибка пользователя: выключаем флаг и повторяем раунд.
      if (
        includeUsage &&
        (res.status === 400 || res.status === 422) &&
        /stream_options|include_usage|unknown|unrecognized|unsupported|extra|invalid/i.test(detail) &&
        !/context|too long|maximum|num_ctx/i.test(detail)
      ) {
        includeUsage = false;
        termEmit({
          type: "metrics",
          text: "Провайдер не понял stream_options.include_usage — отключаю (запрос без метрик токенов).",
        });
        round--;
        continue;
      }
      // Лимиты провайдера (Groq free ~7K токенов/мин): понятное объяснение вместо сырого JSON.
      const friendly = friendlyRateLimitError(res.status, detail, settings);
      if (friendly) throw new Error(friendly);
      // Переполнение контекста (частая беда локальных моделей Ollama с малым окном):
      // один раз повторяем запрос с резко урезанной историей, чтобы не падать.
      if (
        !contextRetried &&
        /context|too long|maximum|num_ctx|token/i.test(detail) &&
        budget > 3000
      ) {
        contextRetried = true;
        budget = Math.max(3000, Math.floor(budget * 0.4));
        histBudget = Math.max(1500, budget - toolsWeight - systemWeight);
        if (canonical.length > 1) {
          const sys = canonical[0];
          canonical = [sys, ...(await ctxManager.manage(canonical.slice(1), histBudget))];
          emitContext(canonical);
        }
        if (canonical.length > 1) {
          const sys = canonical[0];
          canonical = [sys, ...sanitizeToolPairs(canonical.slice(1))];
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
      onUsage: (u) => {
        if (!u) return;
        roundUsage = roundUsage || { prompt: 0, completion: 0, cached: 0 };
        // Провайдеры шлют usage частями (Anthropic: вход в message_start, выход в
        // message_delta) — по каждому полю берём максимум.
        roundUsage.prompt = Math.max(roundUsage.prompt, u.prompt || 0);
        roundUsage.completion = Math.max(roundUsage.completion, u.completion || 0);
        roundUsage.cached = Math.max(roundUsage.cached, u.cached || 0);
      },
    });

    // Метрики раунда в «Консоль» (вкладка «Консоль» правой панели): без цифр
    // любая оптимизация контекста — гадание.
    {
      const estPrompt = toolsWeight + estimateTokens(JSON.stringify(canonical));
      const totalMs = Date.now() - roundStartedAt;
      const tokens =
        roundUsage && roundUsage.prompt
          ? roundUsage.prompt + "→" + roundUsage.completion
          : "≈" + estPrompt + " (провайдер не прислал)";
      const cache =
        roundUsage && roundUsage.prompt
          ? roundUsage.cached + " (" + Math.round((roundUsage.cached / roundUsage.prompt) * 100) + "%)"
          : "нет данных";
      termEmit({
        type: "metrics",
        text:
          "раунд " + (round + 1) + "/" + maxRounds +
          " · схем " + activeTools.length + " (~" + toolsWeight + " т.)" +
          (routeInfo && routeInfo.groups.length ? " · групп " + routeInfo.groups.length : "") +
          (routeInfo && routeInfo.dropped.length ? " · срезано: " + routeInfo.dropped.join(",") : "") +
          " · токены " + tokens +
          " · кэш " + cache +
          " · TTFB " + (roundTtfbMs / 1000).toFixed(1) + " с" +
          " · всего " + (totalMs / 1000).toFixed(1) + " с",
      });
    }

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
        // Gemini 3.x: extra_content с thought signature нужно вернуть дословно,
        // иначе следующий раунд упадёт с 400 (missing thought_signature).
        ...(tc.extraContent ? { extraContent: tc.extraContent } : {}),
      };
      const sig = norm.name + "|" + JSON.stringify(norm.args);
      if (seenCalls.has(sig)) continue;
      seenCalls.add(sig);
      calls.push(norm);
    }
    // Предохранитель A: модель вызвала реальный инструмент, которого нет в текущем
    // наборе схем (группа не была активирована). Дотягиваем его группу — в этом и
    // следующих раундах схема будет на месте; сам вызов выполняем как обычно.
    if (!planMode && routeInfo) {
      for (const c of calls) {
        const gid = groupOfTool(c.name);
        if (!gid || stickyGroups.has(gid)) continue;
        stickyGroups.add(gid);
        refreshTools();
        termEmit({
          type: "metrics",
          text: "🔧 «" + c.name + "» вне набора схем — добавляю группу «" + gid + "» (схем станет " + activeTools.length + ").",
        });
      }
    }

    // Все вызовы раунда оказались дублями — завершаем без «пустых» tool_calls.
    if (!calls.length) {
      if (!String(finalText || "").trim()) finalText = "Готово.";
      emit({ type: "chunk", text: finalText });
      emit({ type: "done" });
      return { ok: true, text: finalText };
    }

    canonical.push({
      role: "assistant",
      content: finalText || null,
      tool_calls: calls.map((c) => {
        const call = {
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
        };
        if (c.extraContent) call.extra_content = c.extraContent;
        return call;
      }),
    });

    // Батчинг: если раунд целиком состоит из независимых read-only вызовов —
    // выполняем их параллельно (экономит по раунду на каждый вызов). Любой
    // пишущий/интерактивный инструмент в раунде возвращает строгую очередь.
    if (!planMode && calls.length > 1 && calls.every((c) => PARALLEL_SAFE_TOOLS.has(c.name))) {
      for (const c of calls) emit({ type: "tool_start", name: c.name, args: c.args });
      const results = await Promise.all(
        calls.map((c) =>
          executeTool(c.name, c.args, settings).catch((e) => "Ошибка инструмента " + c.name + ": " + fmtError(e))
        )
      );
      calls.forEach((c, i) => {
        const capped = truncateText(results[i], 8000);
        emit({ type: "tool_result", name: c.name, result: capped });
        canonical.push({ role: "tool", tool_call_id: c.id, content: capped });
      });
      if (global.__agentStopRequested) return stopGraceful();
      continue;
    }

    for (const c of calls) {
      // План-режим: выполняем только todoWrite. Если модель по привычке вызвала
      // другой инструмент — не выполняем его и говорим об этом прямо.
      if (planMode && c.name !== "todoWrite") {
        const blocked =
          "Режим плана: инструменты не выполняются. Составь план через todoWrite и дождись команды пользователя.";
        canonical.push({ role: "tool", tool_call_id: c.id, content: blocked });
        continue;
      }
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
    // Остановка во время выполнения инструментов — завершаем без нового раунда.
    if (global.__agentStopRequested) return stopGraceful();
  }
  throw Object.assign(new Error("Превышено максимальное число раундов вызова инструментов (" + maxRounds + ")."), { fatal: true });
  } catch (e) {
    const fatal = (e && e.name === "AbortError") || (e && e.fatal) || global.__agentStopRequested || (e && e.message && /Не выбрана модель/.test(e.message));
    if (fatal || attemptNum > AUTO_RETRY_LIMIT) throw e;
    const errText = String((e && e.message) || e).slice(0, 800);
    // Провайдер отверг stream_options уже внутри ответа (не ошибкой на заголовках) —
    // снимаем флаг: авто-повтор ниже пойдёт без него.
    if (includeUsage && /stream_options|include_usage/i.test(errText)) {
      includeUsage = false;
      termEmit({
        type: "metrics",
        text: "Провайдер отверг stream_options — повторяю запрос без метрик токенов.",
      });
    }
    // Авто-переключение на следующее сохранённое OpenAI-подключение: ошибка ключа/
    // баланса/лимита/сети — пробуем другой ключ вместо бессмысленных повторов.
    let switchedProfile = null;
    if (settings.provider === "openai" && settings.autoSwitchProfiles) {
      try {
        // Меняем ключ только когда ошибка действительно про ключ/баланс/лимит,
        // и откладываем провинившийся ключ на cooldown (не долбим провайдера).
        const cls = classifyKeyError(errText);
        if (cls.key) switchedProfile = switchOpenaiProfile(settings, { penalizeCurrentMs: cls.cooldownMs });
        if (switchedProfile) {
          saveSettings(settings); // активное подключение сохраняется (ключи — в secrets.json)
          emit({
            type: "profile_switched",
            name: switchedProfile.name || switchedProfile.id || "?",
            id: switchedProfile.id,
            error: errText,
          });
        }
      } catch {}
    }
    emit({ type: "text_override", text: "" }); // стираем частичный текст упавшей попытки в UI
    emit({
      type: "retry",
      attempt: attemptNum + 1,
      total: AUTO_RETRY_LIMIT + 1,
      error: errText + (switchedProfile ? " — переключено на подключение «" + (switchedProfile.name || switchedProfile.id) + "»" : ""),
    });
    finalText = "";
    await new Promise((r) => setTimeout(r, 3000)); // пауза: провайдеры сбрасывают лимиты за секунды
    canonical.push({
      role: "system",
      content:
        "⚠️ ПРЕДЫДУЩАЯ ПОПЫТКА УПАЛА — авто-повтор " + (attemptNum + 1) + " из " + (AUTO_RETRY_LIMIT + 1) + ".\n" +
        "Ошибка: " + errText + (switchedProfile ? " (выполнено переключение на другое подключение — ключ «" + (switchedProfile.name || switchedProfile.id) + "»)" : "") + "\n" +
        "Продолжай с того места, где остановился, опираясь на уже сделанное (инструменты, файлы, результаты выше). " +
        "Не начинай заново и не повторяй выполненные шаги: сначала быстро оцени текущее состояние (например git status или чтение ключевых файлов), затем продолжи. " +
        "Если ошибка про лимиты/токены — работай компактнее: меньше файлов целиком, чаще searchFile/semanticSearch, короче выводы.",
    });
    if (canonical.length > 1) {
      const sys = canonical[0];
      canonical = [sys, ...sanitizeToolPairs(canonical.slice(1))];
    }
    continue;
  }
  }
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
  // Кликабельные ссылки из чата: http(s) открываются в браузере пользователя,
  // а не в новом окне Electron.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (/^https?:/i.test(url)) {
      e.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });
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
  // Защита хранилища паролей: если сохранение пришло без массива sitePasswords
  // (старая версия интерфейса, обрезанный объект, мобильный клиент) — не затираем
  // уже сохранённые записи. Пустой массив — это осознанная очистка, её пропускаем.
  if (!s || !Array.isArray(s.sitePasswords)) merged.sitePasswords = prev.sitePasswords || [];
  // Защита пароля почты: сохранение без ключа mailPassword (мобильный клиент,
  // старый интерфейс) не должно стирать уже сохранённый пароль приложения.
  if (!s || s.mailPassword === undefined) merged.mailPassword = prev.mailPassword || "";
  // Защита выбора Yandex Cloud: каталог/облако меняются ТОЛЬКО своими IPC
  // (yc:setToken, yc:setFolder, автовыбор внутри yc:status, сброс в yc:logout) —
  // в форме настроек такого поля нет. Объект интерфейса, загруженный ДО автовыбора
  // каталога, приносил пустой (или устаревший) ycFolderId и стирал выбор: агент
  // снова видел «каталог не выбран», и каталог приходилось выбирать заново.
  // Та же болезнь, что у sitePasswords и mailPassword. Поэтому поля Yandex Cloud
  // берём из текущих настроек, а не из присланного объекта.
  merged.ycFolderId = prev.ycFolderId || "";
  merged.ycFolderName = prev.ycFolderName || "";
  merged.ycCloudId = prev.ycCloudId || "";
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
  applyAgentEnv(merged);
  // Мобильный доступ: при включении без PIN — генерируем его, затем применяем к мосту.
  if (merged.mobileEnabled && !merged.mobilePin) {
    merged.mobilePin = String(Math.floor(100000 + Math.random() * 900000));
  }
  applyBrowserSettings(merged);
  saveSettings(merged);
  mobileBridge.applySettings(merged);
  return merged;
});

// ─────────────────────────── Браузер агента (постоянный профиль) ───────────────────────────
// Сессии ВК и других сайтов хранятся в userData/browser-profile — вход переживает перезапуск.
// Единая точка применения браузерных настроек: своя папка профиля и режим «свой Chrome» (CDP).
function applyBrowserSettings(s) {
  const dir = path.join(app.getPath("userData"), "browser-profile");
  try {
    browserTools.setProfileDir(s && s.browserProfile === false ? "" : dir);
    browserTools.setConnectMode({
      enabled: !!(s && s.browserConnect === true),
      port: s && s.browserConnectPort,
      dataDir: dir,
    });
  } catch {}
}

ipcMain.handle("browser:profileInfo", () => {
  const s = loadSettings();
  const dir = browserTools.profilePath();
  let exists = false;
  try { exists = !!(dir && fs.existsSync(dir)); } catch {}
  return { enabled: s.browserProfile !== false, dir: dir || "", exists };
});
ipcMain.handle("browser:clearProfile", async () => {
  const message = await browserTools.clearProfile();
  return { ok: !/^Не удалось/.test(message), message };
});
// Подключение к своему Chrome по CDP (кнопка в Настройках и инструмент агента).
ipcMain.handle("browser:connect", async (_e, opts) => {
  const message = await browserTools.connect(opts || {});
  return { ok: !/^Ошибка/.test(message), message, info: browserTools.connectInfo() };
});
ipcMain.handle("browser:connectInfo", () => browserTools.connectInfo());

// ─────────────────────────── Почта (SMTP/IMAP) ───────────────────────────
// Проверка входа IMAP — кнопка «Проверить связь» в настройках. Письма не отправляются.
ipcMain.handle("mail:test", async () => {
  const cfg = mailConfig(loadSettings());
  const servers = {
    imapHost: cfg.imapHost, imapPort: cfg.imapPort,
    smtpHost: cfg.smtpHost, smtpPort: cfg.smtpPort,
    starttls: cfg.starttls, note: cfg.note,
  };
  if (!cfg.address) return { ok: false, error: "Укажи адрес почты.", servers };
  if (!cfg.password) return { ok: false, error: "Укажи пароль приложения для почты.", servers };
  const r = await mail.listRecent(
    { host: cfg.imapHost, port: cfg.imapPort, user: cfg.user, password: cfg.password, secure: true },
    { limit: 1 }
  );
  return { ok: r.ok, error: r.ok ? "" : r.error, total: r.ok ? r.total : 0, servers };
});

// Последние письма для интерфейса (кратко: без полного текста, но с найденным кодом).
ipcMain.handle("mail:recent", async (_e, limit) => {
  const cfg = mailConfig(loadSettings());
  if (!cfg.address || !cfg.password) return { ok: false, error: "Почта не настроена." };
  const r = await mail.listRecent(
    { host: cfg.imapHost, port: cfg.imapPort, user: cfg.user, password: cfg.password, secure: true },
    { limit: Math.min(parseInt(limit, 10) || 5, 10) }
  );
  if (!r.ok) return r;
  return {
    ok: true,
    total: r.total,
    messages: r.messages.map((m) => ({ from: m.from, subject: m.subject, date: m.date, code: mail.extractCode(m.text) })),
  };
});

// Тестовое письмо самому себе — проверяет SMTP-отправку целиком.
ipcMain.handle("mail:testSend", async () => {
  const cfg = mailConfig(loadSettings());
  if (!cfg.address) return { ok: false, error: "Укажи адрес почты." };
  if (!cfg.password) return { ok: false, error: "Укажи пароль приложения для почты." };
  const r = await mail.sendMail(
    { host: cfg.smtpHost, port: cfg.smtpPort, user: cfg.user, password: cfg.password, secure: !cfg.starttls, starttls: cfg.starttls },
    {
      fromName: cfg.fromName,
      to: cfg.address,
      subject: "Проверка почты от AI-агента",
      text: "Это тестовое письмо. Если ты его видишь — отправка писем настроена верно.\n\n— AI Developer Agent",
    }
  );
  return r;
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
ipcMain.handle("ota:reset", (_e, removeSource) => ota.reset(!!removeSource, loadSettings()));

ipcMain.handle("chats:load", () => loadChats());
ipcMain.handle("chats:save", (_e, d) => {
  saveChats(d);
  return true;
});

// Синхронное сохранение при закрытии окна: renderer успевает записать данные на диск.
ipcMain.on("chats:saveSync", (e, d) => {
  try { saveChats(d); } catch {}
  e.returnValue = true;
});

ipcMain.handle("ai:send", async (_e, messages, opts) => {
  const settings = loadSettings();
  global.__agentStopRequested = false;
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
    global.__agentStopRequested = false;
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
  global.__agentStopRequested = true;
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

// ── G4F: поиск живого инстанса — указанный URL, затем типовые порты 1337 / 8080 ──
// Современный interference-API g4f живёт на 1337, старые сборки — на 8080.
// Используется кнопкой ▶ (подсказка при ошибке) и авто-подбором порта в настройках.
async function probeG4fBase(configuredBase, timeoutMs) {
  const t = timeoutMs || 2500;
  const candidates = [];
  const base = String(configuredBase || "").trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(base)) candidates.push(base);
  for (const port of [1337, 8080]) {
    const u = "http://localhost:" + port + "/v1";
    if (!candidates.includes(u)) candidates.push(u);
  }
  for (const u of candidates) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), t);
    try {
      const res = await fetch(u + "/models", { signal: ctrl.signal });
      if (res.ok) {
        const body = await res.text().catch(() => "");
        let count = 0;
        try {
          const j = JSON.parse(body);
          const list = Array.isArray(j) ? j : (j.data || j.models || []);
          count = Array.isArray(list) ? list.length : 0;
        } catch {}
        return { base: u, count };
      }
    } catch {} finally {
      clearTimeout(timer);
    }
  }
  return null;
}

ipcMain.handle("g4f:probe", async (_e, opts) => {
  const found = await probeG4fBase(opts && opts.url);
  return found ? { ok: true, ...found } : { ok: false };
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
    push("err", "GET /models не прошёл: " + (e.message || String(e)) + ". Проверь, что g4f запущен («g4f api»).");
    // Подсказка: а не отвечает ли живой g4f на другом порту (1337 вместо 8080 и наоборот)?
    const alt = await probeG4fBase(base, 2500);
    if (alt && alt.base !== base) {
      push("ok", "Живой g4f найден на «" + alt.base + "» (моделей: " + alt.count + ") — а в поле URL указан «" + (base || "пусто") + "». Поправь URL, сохрани настройки и повтори тест.");
    } else if (!alt) {
      push("warn", "Живой g4f не найден ни на одном порту (1337 / 8080). Проверь, что запущен: `g4f api` (или `python -m g4f api`).");
    }
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
    const addAll = await stageAllSafe(dir, s);
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

// ─────────────────────────── Yandex Cloud (REST API) ───────────────────────────
// Ссылка для получения OAuth-токена (клиентское приложение Yandex Cloud — как у yc CLI):
const YANDEX_OAUTH_URL =
  "https://oauth.yandex.ru/authorize?response_type=token&client_id=1a6990aa636648e9b2ef855fa7bec2fb";

function ycConfig(s) {
  s = s || loadSettings();
  return {
    oauth: String(s.yandexOauthToken || "").trim(),
    cloudId: String(s.ycCloudId || "").trim(),
    folderId: String(s.ycFolderId || "").trim(),
    folderName: String(s.ycFolderName || "").trim(),
    allowCreate: !!s.ycAllowAgentCreate,
    allowDelete: !!s.ycAllowAgentDelete,
  };
}

// Ключ сервиса → тип ресурса Cloud Logging (нужен только как фильтр; по id точнее).
const YC_RESOURCE_TYPES = {
  apiGateway: "serverless.apigateway",
  certificateManager: "certificate-manager.certificate",
  cdn: "cdn.resource",
  dns: "dns.zone",
  iam: "iam.serviceAccount",
  lockbox: "lockbox.secret",
  logging: "logging.logGroup",
  containerRegistry: "container-registry.registry",
  storage: "storage.bucket",
  serverlessContainers: "serverless.container",
  vpc: "vpc.network",
  ydb: "ydb.database",
};

// Чтение логов Cloud Logging ВНУТРЕННИМ API приложения — внешний yc CLI не нужен.
// Лог-группы перечисляются по REST, записи читаются по gRPC: у LogReadingService
// нет HTTP-привязки, поэтому «POST /logging/v1/logs/read» не существует.
async function readYcLogsText(cfg, serviceKey, resourceId, args) {
  const a = args || {};
  if (!cfg.folderId) throw new Error("не выбран каталог (Настройки → Yandex Cloud).");
  const iam = await yandexCloud.getIamToken(cfg.oauth);
  // REST-список групп и gRPC-чтение живут на РАЗНЫХ хостах: logGroups — на
  // logging.api.cloud.yandex.net, а LogReadingService.Read — только на
  // reader.logging.yandexcloud.net (см. yc-logs.js и KNOWN_ENDPOINTS).
  const base = (await yandexCloud.endpoint("logging")) || "https://logging.api.cloud.yandex.net";
  const grpcBase = (await yandexCloud.endpoint("log-reading")) || "https://reader.logging.yandexcloud.net";
  const limit = Math.max(1, Math.min(parseInt(a.limit, 10) || 100, 500));
  const sinceHours = Math.max(1, Math.min(parseInt(a.sinceHours, 10) || 3, 168));
  const type = YC_RESOURCE_TYPES[serviceKey] || (a.type ? String(a.type) : "");
  const res = await ycLogs.readLogs({
    iamToken: iam,
    baseUrl: base,
    grpcBaseUrl: grpcBase,
    folderId: cfg.folderId,
    resourceIds: resourceId ? [resourceId] : [],
    resourceTypes: type ? [type] : [],
    sinceHours,
    limit,
    logGroupId: a.logGroupId ? String(a.logGroupId) : "",
    filter: a.filter ? String(a.filter) : "",
  });
  const entries = res.entries || [];
  const group = res.logGroupName || res.logGroupId || "—";
  if (!entries.length) {
    return "Логов за последние " + sinceHours + " ч нет (лог-группа «" + group + "»" + (resourceId ? ", ресурс " + resourceId : "") + ").";
  }
  return "Логи за последние " + sinceHours + " ч — " + entries.length + " записей, группа «" + group + "»:\n" + ycLogs.formatEntries(entries, { max: 50 }).join("\n");
}

// Встроенный yc CLI: он лежит в папке приложения, системных прав не требует.
function ycCliStatus() {
  const userData = app.getPath("userData");
  const p = ycCli.installed(userData);
  return { installed: !!p, path: p || "", dir: ycCli.binDir(userData) };
}

async function ycCliInstall() {
  const r = await ycCli.install({ userData: app.getPath("userData") });
  if (r && r.ok) ycEnsurePath();
  return r;
}

// Почта: собирает рабочую конфигурацию из настроек. Пустые серверы берутся из
// пресета провайдера (Gmail/Яндекс/Mail.ru/Outlook/Rambler), иначе — imap.<домен>.
function mailConfig(s) {
  s = s || loadSettings();
  const address = String(s.mailAddress || "").trim();
  const guess = mail.guessServers(address);
  const num = (v, fallback) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    address,
    user: String(s.mailUser || "").trim() || address,
    fromName: String(s.mailFromName || "").trim(),
    password: String(s.mailPassword || ""),
    imapHost: String(s.mailImapHost || "").trim() || guess.imapHost,
    imapPort: num(s.mailImapPort, guess.imapPort || 993),
    smtpHost: String(s.mailSmtpHost || "").trim() || guess.smtpHost,
    smtpPort: num(s.mailSmtpPort, guess.smtpPort || 465),
    starttls: s.mailStarttls === true || guess.starttls === true,
    allowSend: !!s.mailAllowAgentSend,
    note: guess.note || "",
  };
}

function ycRequireAuth(cfg) {
  if (!cfg || !cfg.oauth) {
    const e = new Error("Не выполнена авторизация Yandex Cloud. Открой Настройки → «☁️ Yandex Cloud», получи OAuth-токен и вставь его.");
    e.status = 401;
    throw e;
  }
}

// ── 🧠 Память диалогов: локальный дневник сжатых памяток (папка по датам) ──────
ipcMain.handle("memory:stats", () => {
  const s = loadSettings();
  const st = agentStore.contextMemoryStats(app.getPath("userData"));
  return {
    ...st,
    enabled: !!s.contextMemory,
    keepDays: Number(s.contextMemoryDays) || agentStore.CTX_MEMO_DAY_KEEP,
  };
});

ipcMain.handle("memory:days", () => {
  const s = loadSettings();
  if (!s.contextMemory) return { ok: false, error: "Память диалогов выключена." };
  const days = agentStore.contextMemoryDays(app.getPath("userData"));
  return { ok: true, days, dir: agentStore.contextMemoryDir(app.getPath("userData")) };
});

ipcMain.handle("memory:openDir", async () => {
  const dir = agentStore.contextMemoryDir(app.getPath("userData"));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const err = await shell.openPath(dir);
  return { ok: !err, dir, error: err || "" };
});

ipcMain.handle("memory:clear", (_e, date) => {
  const d = String(date || "").trim();
  const r = agentStore.contextMemoryClear(app.getPath("userData"), d);
  return {
    ...r,
    message: r.ok
      ? "Удалено дней: " + r.removedDays + ", памяток: " + r.removedMemos + "."
      : "Ошибка: " + r.error,
  };
});

ipcMain.handle("yc:status", async () => {
  const s = loadSettings();
  const cfg = ycConfig(s);
  const out = {
    ok: true,
    loggedIn: !!cfg.oauth,
    cloudId: cfg.cloudId,
    folderId: cfg.folderId,
    folderName: cfg.folderName,
    allowCreate: cfg.allowCreate,
    allowDelete: cfg.allowDelete,
    oauthUrl: YANDEX_OAUTH_URL,
    clouds: [],
    folders: [],
    iamOk: false,
    error: "",
  };
  if (!cfg.oauth) return out;
  try {
    // Обмен токена — один раз, затем облака и каталоги идут ПАРАЛЛЕЛЬНО, когда
    // каталог уже известен: последовательный путь складывал таймауты (20 с + 20 с)
    // и автовыбор каталога занимал десятки секунд.
    await yandexCloud.getIamToken(cfg.oauth);
    const cloudsP = yandexCloud.listClouds(cfg.oauth);
    const foldersP = cfg.cloudId ? yandexCloud.listFolders(cfg.oauth, cfg.cloudId) : null;
    const clouds = await cloudsP;
    out.clouds = clouds;
    out.iamOk = true;
    const cloudId = cfg.cloudId || (clouds[0] && clouds[0].id) || "";
    const folders = foldersP ? await foldersP : await yandexCloud.listFolders(cfg.oauth, cloudId);
    out.folders = folders;
    if (!cfg.folderId && folders[0]) {
      // Первый запуск: автоматически выбираем первый каталог первого облака.
      const merged = { ...s, ycCloudId: cloudId, ycFolderId: folders[0].id, ycFolderName: folders[0].name };
      saveSettings(merged);
      out.cloudId = cloudId;
      out.folderId = folders[0].id;
      out.folderName = folders[0].name;
    }
  } catch (e) {
    out.iamOk = false;
    out.error = (e && e.message) || String(e);
  }
  return out;
});

ipcMain.handle("yc:setToken", async (_e, token) => {
  const t = String(token || "").trim();
  if (!t) return { ok: false, error: "Вставь OAuth-токен со страницы авторизации Yandex." };
  try {
    yandexCloud.resetIamCache();
    const clouds = await yandexCloud.listClouds(t);
    const cloudId = (clouds[0] && clouds[0].id) || "";
    const folders = await yandexCloud.listFolders(t, cloudId);
    const folder = folders[0] || null;
    const merged = {
      ...loadSettings(),
      yandexOauthToken: t,
      ycCloudId: cloudId,
      ycFolderId: folder ? folder.id : "",
      ycFolderName: folder ? folder.name : "",
    };
    saveSettings(merged);
    return {
      ok: true,
      account: clouds[0] ? clouds[0].name : "аккаунт Yandex",
      cloudId,
      folderId: folder ? folder.id : "",
      folderName: folder ? folder.name : "",
      clouds,
      folders,
    };
  } catch (e) {
    yandexCloud.resetIamCache();
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle("yc:folders", async () => {
  const cfg = ycConfig();
  try {
    ycRequireAuth(cfg);
    const clouds = await yandexCloud.listClouds(cfg.oauth);
    const cloudId = cfg.cloudId || (clouds[0] && clouds[0].id) || "";
    const folders = await yandexCloud.listFolders(cfg.oauth, cloudId);
    return { ok: true, clouds, folders, cloudId };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle("yc:setFolder", (_e, folderId, folderName, cloudId) => {
  const merged = {
    ...loadSettings(),
    ycFolderId: String(folderId || "").trim(),
    ycFolderName: String(folderName || "").trim(),
    ycCloudId: String(cloudId || "").trim(),
  };
  saveSettings(merged);
  return { ok: true };
});

ipcMain.handle("yc:setPermissions", (_e, allowCreate, allowDelete) => {
  const merged = {
    ...loadSettings(),
    ycAllowAgentCreate: !!allowCreate,
    ycAllowAgentDelete: !!allowDelete,
  };
  saveSettings(merged);
  return { ok: true };
});

ipcMain.handle("yc:logout", () => {
  const s = loadSettings();
  delete s.yandexOauthToken;
  s.ycCloudId = "";
  s.ycFolderId = "";
  s.ycFolderName = "";
  saveSettings(s);
  yandexCloud.resetIamCache();
  return { ok: true };
});

// Дашборд: счётчики ресурсов по всем сервисам выбранного каталога.
ipcMain.handle("yc:resources", async () => {
  const cfg = ycConfig();
  try {
    ycRequireAuth(cfg);
    if (!cfg.folderId) {
      return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
    }
    const services = await yandexCloud.resourcesStatus(cfg.oauth, cfg.folderId);
    const total = services.reduce((acc, s) => acc + (s.ok ? s.count : 0), 0);
    const activeServices = services.filter((s) => s.ok && s.count > 0).length;
    return { ok: true, folderId: cfg.folderId, folderName: cfg.folderName, services, total, activeServices };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle("yc:create", async (_e, serviceKey, name) => {
  const cfg = ycConfig();
  try {
    ycRequireAuth(cfg);
    if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder)." };
    const r = await yandexCloud.createResource(cfg.oauth, cfg.folderId, String(serviceKey || ""), String(name || ""));
    return { ok: true, message: r.message, resourceId: r.resourceId, name: r.name };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle("yc:delete", async (_e, serviceKey, resourceId) => {
  const cfg = ycConfig();
  try {
    ycRequireAuth(cfg);
    const r = await yandexCloud.deleteResource(cfg.oauth, String(serviceKey || ""), String(resourceId || ""));
    return { ok: true, message: r.message };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Генерирует Dockerfile по типу проекта (node / python / статика), если своего нет.
function ycGenerateDockerfile(dir, outPath) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  let docker = "";
  if (has("package.json")) {
    docker = [
      "FROM node:20-alpine",
      "WORKDIR /app",
      "COPY package*.json ./",
      "RUN npm install --no-audit --no-fund 2>/dev/null || npm install",
      "COPY . .",
      "ENV PORT=8080",
      "EXPOSE 8080",
      'CMD ["sh", "-c", "PORT=8080 node server.js || PORT=8080 npm start || PORT=8080 npm run start || npm run dev -- --port 8080 --host 0.0.0.0"]',
    ].join("\n");
  } else if (has("requirements.txt") || has("pyproject.toml") || has("Pipfile")) {
    const req = has("requirements.txt") ? "COPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt" : "";
    docker = [
      "FROM python:3.12-slim",
      "WORKDIR /app",
      req,
      "COPY . .",
      "ENV PORT=8080",
      "EXPOSE 8080",
      'CMD ["sh", "-c", "PORT=8080 python app.py || PORT=8080 python main.py || pip install gunicorn && gunicorn -b 0.0.0.0:8080 app:app || gunicorn -b 0.0.0.0:8080 main:app"]',
    ].filter(Boolean).join("\n");
  } else if (has("index.html")) {
    docker = [
      "FROM nginx:alpine",
      "COPY . /usr/share/nginx/html",
      "EXPOSE 80",
    ].join("\n");
  } else {
    throw new Error("Не смог определить тип проекта для Dockerfile. Создай в папке проекта свой Dockerfile — деплой использует его.");
  }
  fs.writeFileSync(outPath, docker, "utf8");
}

// Деплой одной кнопкой: папка проекта → Container Registry → Serverless Containers → URL.
ipcMain.handle("yc:deploy", async (_e, folderDir, appName, opts) => {
  opts = opts || {};
  const cfg = ycConfig();
  try {
    ycRequireAuth(cfg);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder). Открой Настройки → «☁️ Yandex Cloud» и выбери каталог." };
  const dir = String(folderDir || "").trim() || agentWorkDir(loadSettings());
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { ok: false, error: "Папка проекта не найдена: " + dir };
  }
  const name = String(appName || "").trim() || path.basename(dir);
  const steps = [];
  const step = (text) => {
    steps.push(text);
    if (activeEmit) activeEmit({ type: "yc_step", text });
  };
  try {
    const docker = findProgram("docker");
    if (!docker.found) {
      return { ok: false, error: "Docker не найден на этом ПК. Установи Docker Desktop (https://www.docker.com/products/docker-desktop/) и перезапусти приложение.", steps };
    }
    step("1/6 ✓ Docker найден");

    const df = path.join(dir, "Dockerfile");
    let dockerfile = df;
    if (!fs.existsSync(df)) {
      dockerfile = path.join(dir, "Dockerfile.yandexcloud");
      try {
        ycGenerateDockerfile(dir, dockerfile);
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e), steps };
      }
      step("2/6 ✓ Dockerfile сгенерирован (" + path.basename(dockerfile) + ") — если приложению нужна особая сборка, поправь его и задеплой снова");
    } else {
      step("2/6 ✓ Использую Dockerfile проекта");
    }

    const slug = yandexCloud.slugify(name);
    const reg = await yandexCloud.ensureRegistry(cfg.oauth, cfg.folderId, slug + "-registry");
    const image = "cr.yandex/" + reg.id + "/" + slug + ":latest";
    step("3/6 ✓ Реестр готов: " + reg.id);

    const iamTok = await yandexCloud.getIamToken(cfg.oauth);
    const loginOut = await runTerminalCommand("docker login cr.yandex -u iam -p " + iamTok, dir, 90000);
    const loginTxt = String(loginOut || "");
    if (/error|denied|failed|unauthorized/i.test(loginTxt) && !/login succeeded/i.test(loginTxt)) {
      return { ok: false, error: "docker login к cr.yandex не прошёл:\n" + truncateText(loginTxt, 800), steps };
    }
    step("4/6 ✓ docker login к cr.yandex выполнен");

    const buildOut = await runTerminalCommand('docker build -f "' + dockerfile + '" -t ' + image + ' .', dir, 600000);
    const buildTxt = String(buildOut || "");
    if (/error|failed|cannot|denied|no such file/i.test(buildTxt) && !/successfully built/i.test(buildTxt)) {
      return { ok: false, error: "docker build упал:\n" + truncateText(buildTxt, 3000), steps };
    }
    step("5/6 ✓ Образ собран: " + image);

    const pushOut = await runTerminalCommand("docker push " + image, dir, 600000);
    const pushTxt = String(pushOut || "");
    if (/error|denied|failed|unauthorized/i.test(pushTxt) && !/digest/i.test(pushTxt)) {
      return { ok: false, error: "docker push упал:\n" + truncateText(pushTxt, 2000), steps };
    }
    step("6/6 ✓ Образ загружен в Container Registry");

    const cont = await yandexCloud.ensureContainer(cfg.oauth, cfg.folderId, slug);
    step("Контейнер готов: " + cont.id);

    let saId = "";
    if (opts.public !== false) {
      try {
        const sa = await yandexCloud.ensureServiceAccount(cfg.oauth, cfg.folderId, "sa-" + slug);
        saId = sa.id;
        await yandexCloud.addRoleOnFolder(cfg.oauth, cfg.folderId, sa.id, "serverless.containers.invoker");
        step("Публичный доступ настроен (SA + роль invoker)");
      } catch (e) {
        return {
          ok: false,
          error:
            "Не удалось настроить публичный доступ: " + ((e && e.message) || String(e)) +
            ". Проверь, что у твоего аккаунта есть роль editor на каталог, или задеплой с public=false (URL будет требовать авторизацию).",
          steps,
        };
      }
    }

    step("⏳ Деплой ревизии… это может занять 1–3 минуты");
    await yandexCloud.deployContainerRevision(cfg.oauth, {
      containerId: cont.id,
      folderId: cfg.folderId,
      imageUrl: image,
      serviceAccountId: saId || undefined,
      memoryMb: opts.memoryMb || 256,
      cores: opts.cores || 1,
      timeoutSec: opts.timeoutSec || 30,
      env: opts.env || {},
    });
    const info = await yandexCloud.containerInfo(cfg.oauth, cont.id);
    const fin = "✅ Готово! URL контейнера: " + (info.url || "—");
    steps.push(fin);
    if (activeEmit) activeEmit({ type: "yc_step", text: fin });
    return { ok: true, url: info.url, containerId: cont.id, name: slug, image, steps };
  } catch (e) {
    return { ok: false, error: "Деплой не завершился: " + ((e && e.message) || String(e)), steps };
  }
});

// Логи ресурса — внутренним API Cloud Logging (REST для лог-групп + gRPC для записей).
ipcMain.handle("yc:logs", async (_e, serviceKey, resourceId) => {
  const cfg = ycConfig();
  try {
    ycRequireAuth(cfg);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!cfg.folderId) return { ok: false, error: "Не выбран каталог (folder)." };
  const id = String(resourceId || "").trim();
  if (!id) return { ok: false, error: "Не указан id ресурса." };
  try {
    const text = await readYcLogsText(cfg, String(serviceKey || "").trim(), id, { limit: 100, sinceHours: 3 });
    return { ok: true, logs: text.split("\n").slice(1), raw: text };
  } catch (e) {
    return { ok: false, error: "Логи: " + ((e && e.message) || String(e)) };
  }
});

// Встроенный yc CLI: статус (стоит ли и где) и установка внутрь приложения.
ipcMain.handle("yc:cliStatus", () => ycCliStatus());
ipcMain.handle("yc:installCli", async () => {
  const cfg = ycConfig();
  try {
    ycRequireAuth(cfg);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const st = ycCliStatus();
  if (st.installed) return { ok: true, already: true, installed: true, path: st.path, dir: st.dir, version: "" };
  const r = await ycCliInstall();
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || "не удалось установить yc CLI" };
  return { ok: true, installed: true, path: r.path, dir: r.dir, version: r.version, sizeMb: r.sizeMb };
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

// Мягкая отмена последнего коммита: reset --soft HEAD~1 — изменения коммита
// возвращаются в рабочее дерево как незакоммиченные, ничего не теряется.
ipcMain.handle("git:undoLastCommit", async (_e, dir) => {
  const d = sanitizeDir(dir);
  if (!d) return { ok: false, error: "Папка не найдена" };
  const s = loadSettings();
  const log = await runGit(d, ["log", "-1", "--pretty=%h"], s);
  if (!log.ok || !String(log.out || "").trim()) {
    return { ok: false, error: "В истории нет коммитов для отмены" };
  }
  const r = await runGit(d, ["reset", "--soft", "HEAD~1"], s);
  if (!r.ok) return { ok: false, error: r.err || "Не удалось отменить коммит" };
  return { ok: true, out: "Последний коммит " + String(log.out).trim() + " отменён (reset --soft): его изменения вернулись как незакоммиченные, ничего не потеряно." };
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
  const add = await stageAllSafe(d, s);
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
  browserTools.stop().catch(() => {}); // закрываем окно Chromium агента
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
