"use strict";

/* ── Браузерные инструменты агента (Playwright) ─────────────────────────────
   Агент получает ВИДИМОЕ окно Chromium и управляет им через инструменты:
   открыть URL, КАРТА страницы (browserSnapshot), заполнить поле, кликнуть,
   выбрать из <select>, нажать клавишу, прочитать текст страницы, сделать
   скриншот, подождать элемент, закрыть вкладку.
   Окно видимое намеренно: пользователь видит, что делает агент, и может
   дожимать руками капчу / 2FA / лишние подтверждения.

   Как агент «понимает» кнопки (без перебора селекторов):
     • browserSnapshot отдаёт карту: ref (e1, e2…), роль, видимое имя, подсказки;
     • браузер сам нумерует элементы атрибутом data-agent-ref — ref живут до
       перезагрузки страницы;
     • browserClick / browserFill принимают ref, role+name (доступное имя),
       label/placeholder или обычный CSS-селектор — что удобнее агенту;
     • если элемент не найден, инструмент НЕ молчит, а возвращает похожие
       элементы с их ref — следующий шаг делается без угадывания.

   Браузер запускается лениво — только при первом вызове инструмента.
   Приоритет движков (чтобы ничего не качать на Windows):
     1) системный Edge  (channel: "msedge") — есть почти на каждом Windows;
     2) системный Chrome (channel: "chrome");
     3) Chromium из playwright — если бинарь не установлен, скачивается
        автоматически один раз (npx playwright install chromium).

   Все функции возвращают строки для агента (как остальные инструменты)
   и НЕ бросают исключений наружу — ошибки превращаются в текст ответа.
   Модуль не требует playwright на этапе require (ленивая загрузка),
   поэтому работает и там, где пакет ещё не установлен (node --check и т.п.).
*/

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const dom = require("./dom-map.js"); // карта интерфейса: роли, имена, ref, подсказки

let pw = null; // модуль playwright (лениво)
let browser = null; // Browser (обычный запуск) ИЛИ BrowserContext (постоянный профиль)
let sessionClosed = false; // для BrowserContext: пришло событие "close" — сессия мертва
let profileDir = ""; // папка постоянного профиля (пусто — сессии не сохраняются)
let runningProfileDir = null; // папка профиля, с которой запущена текущая сессия
let tabs = new Map(); // tabId -> { id, page, openedAt }
let tabSeq = 0;
let activeTabId = null;
let installPromise = null; // один инсталлятор на всё время жизни процесса
let engineName = "";

// ── Свой Chrome по CDP ────────────────────────────────────────────────────
// Playwright даёт быстрые и точные инструменты (клик/ввод/карта страницы), но в
// СВОЁМ окне Chromium. Чтобы работать в браузере пользователя (его входы в ВК,
// почту и т.д.), приложение подключается к Chrome с включённым портом отладки —
// тогда browserClick/browserFill действуют в его вкладках с его сессиями.
let connectEnabled = false; // настройка «работать в своём Chrome»
let connectPort = 9222; // порт отладки
let connectDataDir = ""; // отдельный профиль для запуска Chrome с отладкой
let cdpActive = false; // текущая сессия получена по CDP
let cdpContext = null; // контекст браузера пользователя (для новых вкладок)
let runningModeKey = null; // режим+профиль текущей сессии (см. modeKey)

const ACTION_TIMEOUT = 12000;

// Только для тестов: подставляет заглушку playwright (реальный браузер не запускается)
// или сбрасывает кэш (null), чтобы следующий вызов взял свежий модуль.
function setPlaywright(mock) {
  pw = mock || null;
  return pw;
}

function loadPlaywright() {
  if (pw) return pw;
  try {
    // eslint-disable-next-line global-require
    pw = require("playwright");
    return pw;
  } catch (e) {
    pw = null;
    throw new Error(
      "Библиотека playwright не найдена. Установи её: npm install playwright" +
        (e && e.message ? " (" + e.message.slice(0, 120) + ")" : "")
    );
  }
}

// Находит cli.js playwright-core: через require.resolve (в собранном приложении
// electron-builder с asarUnpack отдаёт реальный путь из app.asar.unpacked).
function findPlaywrightCli() {
  const cands = [];
  try { cands.push(require.resolve("playwright-core/cli.js")); } catch {}
  try {
    const pkg = require.resolve("playwright-core/package.json");
    cands.push(path.join(path.dirname(pkg), "cli.js"));
  } catch {}
  try { cands.push(require.resolve("playwright/cli.js")); } catch {}
  for (const c of cands) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// Скачивание Chromium (один раз на процесс). Запускаем cli.js самим процессом
// (process.execPath с ELECTRON_RUN_AS_NODE=1) — это работает и в dev, и в собранном
// приложении, и не требует установленного node/npx в PATH пользователя.
function installChromium() {
  if (installPromise) return installPromise;
  installPromise = new Promise((resolve) => {
    const cli = findPlaywrightCli();
    const useOwnNode = !!(cli && process.execPath);
    const cmd = useOwnNode
      ? '"' + process.execPath + '" "' + cli + '" install chromium'
      : "npx playwright install chromium";
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
    const env = useOwnNode ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env;
    let out = "";
    const child = spawn(shell, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 600000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim().slice(-2500) });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out: e.message || String(e) });
    });
  });
  return installPromise;
}

// ── Постоянный профиль браузера ───────────────────────────────────────────
// Папка задаётся из main.js (userData/browser-profile). Внутри неё Chromium
// хранит куки, localStorage и авторизации — поэтому вход в ВК и на сайты
// переживает закрытие и перезапуск приложения. Пустая строка — как раньше
// (чистый профиль на каждый запуск).
function setProfileDir(dir) {
  profileDir = dir ? String(dir) : "";
  return profileDir;
}

function profilePath() {
  return profileDir;
}

// Настройки режима «свой Chrome»: включает main.js из настроек приложения.
function setConnectMode(cfg) {
  const c = cfg || {};
  connectEnabled = c.enabled === true;
  const p = parseInt(c.port, 10);
  connectPort = p >= 1024 && p <= 65535 ? p : 9222;
  connectDataDir = c.dataDir ? String(c.dataDir) : "";
  return { enabled: connectEnabled, port: connectPort, dir: connectDataDir };
}

function connectInfo() {
  return { enabled: connectEnabled, port: connectPort, dataDir: connectDataDir, active: cdpActive };
}

// Ключ режима: смена режима или профиля означает «нужна новая сессия».
function modeKey() {
  return connectEnabled ? "cdp:" + connectPort + ":" + connectDataDir : "launch:" + profileDir;
}

function profileNote() {
  const head = cdpActive
    ? "\nРежим: СВОЙ Chrome по CDP (:" + connectPort + ") — используются твои вкладки и входы на сайты."
    : "";
  return head + (profileDir
    ? "\nПрофиль: постоянный — куки и входы на сайтах сохраняются между запусками."
    : "\nПрофиль: временный — при закрытии браузера сессии и входы теряются.");
}

// ── CDP: подключение к своему Chrome ──────────────────────────────────────
function cdpEndpoint(port) {
  return "http://127.0.0.1:" + (parseInt(port, 10) || connectPort || 9222);
}

// Ждёт, пока порт отладки откроется (Chrome стартует 1–3 секунды).
async function cdpReady(endpoint, timeoutMs) {
  const deadline = Date.now() + (timeoutMs == null ? 700 : timeoutMs);
  while (Date.now() < deadline) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, 900);
      const res = await fetch(endpoint + "/json/version", { signal: ctrl.signal });
      clearTimeout(timer);
      if (res && res.ok) {
        const j = await res.json().catch(() => null);
        if (j && j.Browser) return j;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

// Установленные Chrome / Edge / Chromium — в порядке предпочтения.
function chromeCandidates() {
  const out = [];
  const push = (name, p) => { if (p) out.push({ name, path: p }); };
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const la = process.env.LOCALAPPDATA || "";
    push("chrome", path.join(pf, "Google", "Chrome", "Application", "chrome.exe"));
    push("chrome", path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"));
    push("chrome", la ? path.join(la, "Google", "Chrome", "Application", "chrome.exe") : "");
    push("edge", path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"));
    push("edge", path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"));
    push("chromium", la ? path.join(la, "Chromium", "Application", "chrome.exe") : "");
  } else if (process.platform === "darwin") {
    push("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    push("edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    push("chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else {
    push("chrome", "/usr/bin/google-chrome");
    push("chrome", "/usr/bin/google-chrome-stable");
    push("chromium", "/usr/bin/chromium");
    push("chromium", "/usr/bin/chromium-browser");
    push("edge", "/usr/bin/microsoft-edge");
  }
  return out.filter((c) => {
    try { return fs.existsSync(c.path); } catch { return false; }
  });
}

function findChromeExe(which) {
  const list = chromeCandidates();
  if (which) {
    const hit = list.find((c) => c.name === which);
    return hit ? hit.path : "";
  }
  return list.length ? list[0].path : "";
}

// Запускает установленный Chrome/Edge с портом отладки. Отдельный профиль нужен
// обязательно: с Chrome 136+ порт отладки НЕ работает со стандартной папкой
// профиля (защита от кражи куки). В этом профиле и сохраняются входы на сайты.
function launchDebugChrome(port, dataDir, which) {
  const exe = findChromeExe(String(which || "").trim().toLowerCase());
  if (!exe) return { ok: false, error: "Не нашёл установленный Chrome или Edge — установи Google Chrome и повтори." };
  const dir = dataDir || path.join(os.tmpdir(), "ai-agent-chrome-cdp");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const args = [
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + dir,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--start-maximized",
  ];
  try {
    const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  return { ok: true, exe, dir };
}

// Что делать, если подключиться не удалось.
function cdpHowTo(port) {
  const p = parseInt(port, 10) || connectPort || 9222;
  const run =
    process.platform === "win32"
      ? '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=' + p + ' --user-data-dir="%LOCALAPPDATA%\\chrome-debug"'
      : 'google-chrome --remote-debugging-port=' + p + ' --user-data-dir="$HOME/chrome-debug"';
  return (
    "Как подключиться к своему Chrome:\n" +
    "  1) Закрой Chrome полностью — запущенный Chrome порт отладки не откроет.\n" +
    "  2) Запусти: " + run + "\n" +
    "  3) Войди на нужные сайты (ВК, почта) — дальше агент работает в этих же вкладках.\n" +
    "Важно: с Chrome 136+ порт отладки не работает со стандартным профилем (защита от кражи куки) — нужен отдельный --user-data-dir.\n" +
    "Проще всего: Настройки → 🌐 Браузер агента → «Подключиться к моему Chrome» — приложение само запустит Chrome со своим профилем, и входы в нём сохранятся."
  );
}

// Вкладки текущего браузера: в режиме CDP — вкладки пользователя (его контекст).
function listPages() {
  try {
    if (cdpActive && cdpContext) return cdpContext.pages();
    if (browser && typeof browser.pages === "function") return browser.pages();
  } catch {}
  return [];
}

// Новая вкладка. В режиме CDP — в контексте пользователя, иначе вкладка была бы
// без его куки и входов (новый контекст = чистый профиль).
async function newPageInBrowser() {
  if (cdpActive && cdpContext) {
    try { return await cdpContext.newPage(); } catch {}
  }
  return await browser.newPage();
}

// Подхватывает УЖЕ открытые вкладки пользователя (ВК, почта, кабинеты), чтобы
// агент работал в них, а не открывал новые «пустые». Помечены adopted — их агент
// не закрывает.
function adoptExistingPages() {
  const names = [];
  for (const p of listPages()) {
    if (tabs.size >= 25) break;
    let url = "";
    try { url = p.url() || ""; } catch { continue; }
    if (!/^https?:/i.test(url)) continue;
    const tabId = "tab" + (++tabSeq);
    tabs.set(tabId, { id: tabId, page: p, openedAt: Date.now(), adopted: true });
    if (!activeTabId) activeTabId = tabId;
    try {
      p.on("close", () => {
        if (tabs.has(tabId)) {
          tabs.delete(tabId);
          if (activeTabId === tabId) activeTabId = tabs.size ? Array.from(tabs.keys()).pop() : null;
        }
      });
    } catch {}
    names.push(tabId + "  " + url.slice(0, 90));
  }
  return names;
}

// Подключение к своему Chrome: сначала пробуем уже запущенный с отладкой, иначе
// запускаем Chrome сами и ждём порт.
async function attachCdp(opts) {
  const o = opts || {};
  const port = parseInt(o.port, 10) || connectPort || 9222;
  const endpoint = cdpEndpoint(port);
  const { chromium } = loadPlaywright();
  let info = await cdpReady(endpoint, o.waitMs == null ? 700 : o.waitMs);
  let launched = "";
  if (!info && o.launch !== false) {
    const r = launchDebugChrome(port, connectDataDir, o.browser);
    if (!r.ok) return { ok: false, message: "Не удалось запустить Chrome: " + r.error + "\n\n" + cdpHowTo(port) };
    launched = "Запустил Chrome с отладкой:\n  " + r.exe + "\n  профиль: " + r.dir;
    info = await cdpReady(endpoint, 20000);
    if (!info) {
      return {
        ok: false,
        message:
          launched +
          "\n\nПорт " + port + " не открылся за 20 с. Обычно причина одна: Chrome уже запущен — закрой ВСЕ его окна и повтори.\n\n" +
          cdpHowTo(port),
      };
    }
  }
  if (!info) {
    return { ok: false, message: "На " + endpoint + " никто не слушает (Chrome с отладкой не запущен).\n\n" + cdpHowTo(port) };
  }
  if (sessionAlive()) await stop();
  let b;
  try {
    b = await chromium.connectOverCDP(endpoint);
  } catch (e) {
    return {
      ok: false,
      message: "Не удалось подключиться к " + endpoint + ": " + String((e && e.message) || e).slice(0, 200) + "\n\n" + cdpHowTo(port),
    };
  }
  browser = b;
  cdpActive = true;
  sessionClosed = false;
  connectPort = port; // работаем на том порту, с которым реально соединились
  runningProfileDir = profileDir;
  engineName = "Свой Chrome (CDP :" + port + ")";
  try { cdpContext = (b.contexts() || [])[0] || null; } catch { cdpContext = null; }
  wireBrowser();
  const adopted = adoptExistingPages();
  return { ok: true, port, launched, adopted, browserName: (info && info.Browser) || "", endpoint };
}

// Инструмент агента: подключиться к своему Chrome (и открыть url, если задан).
async function connect(args) {
  args = args || {};
  const r = await attachCdp({ port: args.port, launch: args.launch !== false, browser: args.browser });
  if (!r.ok) return "Ошибка browserConnect:\n" + r.message;
  const lines = [
    "OK — подключился к твоему Chrome по CDP: " + r.endpoint + (r.browserName ? " (" + r.browserName + ")" : ""),
  ];
  if (r.launched) lines.push(r.launched);
  if (r.adopted && r.adopted.length) {
    lines.push("Твои открытые вкладки подхвачены (" + r.adopted.length + "):");
    lines.push(...r.adopted.slice(0, 15).map((x) => "  " + x));
    lines.push("Работаю в этих вкладках — твои входы на сайты на месте. Твои вкладки я не закрываю.");
  } else {
    lines.push("Открытых вкладок с сайтами не нашёл — открой страницу через browserOpen (url) или скажи, что сделать.");
  }
  lines.push('Дальше: browserSnapshot — карта кнопок и полей. Отключиться: browserClose (tabId: "all") — твой Chrome продолжит работать.');
  const url = String(args.url || "").trim();
  if (/^https?:\/\//i.test(url)) {
    const opened = await open({ url, newTab: args.newTab !== false });
    lines.push("", opened);
  }
  return lines.join("\n");
}

// Жива ли текущая сессия: у Browser есть isConnected(), у BrowserContext — нет
// (для него признак — не пришло событие "close", см. wireBrowser).
function sessionAlive() {
  if (!browser || sessionClosed) return false;
  try {
    if (typeof browser.isConnected === "function") return browser.isConnected();
  } catch {
    return false;
  }
  return true;
}

// Запуск движка: с папкой профиля — launchPersistentContext, без неё — обычный launch.
async function launchEngine(chromium, name, opts) {
  // Следы автоматизации, которые мешают входу на сайты с жёсткими проверками
  // (Google, банки): плашка «управляется автоматизированным ПО», флаг
  // --enable-automation и navigator.webdriver = true. Это документированные
  // опции Playwright — мы лишь не афишируем автоматизацию, пароли и входы
  // по-прежнему вводит сам пользователь. Защиты сайтов не обходятся.
  const args = ["--start-maximized", "--disable-infobars", "--disable-blink-features=AutomationControlled"];
  const base = {
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
    ...opts,
    args,
  };
  if (profileDir) {
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch {}
    const ctx = await chromium.launchPersistentContext(profileDir, base);
    return { ok: true, browser: ctx, engine: name + " · постоянный профиль", persistent: true };
  }
  const b = await chromium.launch(base);
  return { ok: true, browser: b, engine: name, persistent: false };
}

// Запуск браузера: системный Edge → Chrome → свой Chromium (с авто-установкой).
async function launchBrowser() {
  const { chromium } = loadPlaywright();
  const attempts = [
    { name: "Edge (системный)", opts: { channel: "msedge" } },
    { name: "Chrome (системный)", opts: { channel: "chrome" } },
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      return await launchEngine(chromium, a.name, a.opts);
    } catch (e) {
      lastErr = e;
    }
  }
  // Свой Chromium из playwright: сначала проверяем, установлен ли бинарь.
  let execPath = "";
  try { execPath = chromium.executablePath() || ""; } catch {}
  const needInstall = execPath && !fs.existsSync(execPath);
  if (needInstall) return { needInstall: true, message: "Chromium (playwright) не установлен — скачиваю…" };
  try {
    return await launchEngine(chromium, "Chromium (playwright)", {});
  } catch (e) {
    lastErr = e;
  }
  return { ok: false, error: (lastErr && lastErr.message) || "Не удалось запустить браузер" };
}

// Гарантирует запущенный браузер: возвращает { ok:true } либо сообщение об ошибке.
// Никогда не бросает исключений наружу — все ошибки превращаются в текст для агента.
async function ensureBrowser() {
  try {
    return await ensureBrowserInner();
  } catch (e) {
    return { ok: false, message: "Ошибка браузера: " + ((e && e.message) || String(e)).slice(0, 300) };
  }
}

async function ensureBrowserInner() {
  if (sessionAlive()) {
    // Режим (свой Chrome по CDP или собственный Chromium) и профиль не менялись —
    // работаем в текущей сессии.
    if (runningModeKey === modeKey()) return { ok: true };
    // Режим или профиль сменили — перезапускаем, чтобы применилось сразу.
    await stop();
  }
  // Режим «свой Chrome»: подключаемся по CDP (если Chrome не запущен с отладкой —
  // запускаем его сами со своим профилем).
  if (connectEnabled) {
    const c = await attachCdp({ port: connectPort, launch: true });
    return c.ok ? { ok: true } : { ok: false, message: c.message };
  }
  const r = await launchBrowser();
  if (r.needInstall) {
    const inst = await installChromium();
    if (!inst.ok) {
      return {
        ok: false,
        message:
          "Не удалось установить Chromium автоматически. Сделай это вручную один раз:\n" +
          "  npm install playwright && npx playwright install chromium\n" +
          "Затем повтори вызов. Лог установки:\n" +
          (inst.out || "нет вывода"),
      };
    }
    const r2 = await launchBrowser();
    if (!r2.ok) return { ok: false, message: r2.error || "Chromium установлен, но не запустился." };
    browser = r2.browser;
    engineName = r2.engine;
    runningProfileDir = profileDir;
    wireBrowser();
    return { ok: true };
  }
  if (!r.ok) return { ok: false, message: r.error || "Не удалось запустить браузер" };
  browser = r.browser;
  engineName = r.engine;
  runningProfileDir = profileDir;
  wireBrowser();
  return { ok: true };
}

function wireBrowser() {
  sessionClosed = false;
  runningModeKey = modeKey();
  const reset = () => {
    tabs.clear();
    activeTabId = null;
    browser = null;
    sessionClosed = true;
  };
  try {
    // У Browser событие "disconnected", у BrowserContext (постоянный профиль) — "close".
    const evt = typeof browser.isConnected === "function" ? "disconnected" : "close";
    browser.on(evt, reset);
  } catch {}
}

function resolveTab(tabId) {
  if (tabId && tabs.has(String(tabId))) return tabs.get(String(tabId));
  if (activeTabId && tabs.has(activeTabId)) return tabs.get(activeTabId);
  return null;
}

function needTab(tabId) {
  if (!sessionAlive()) {
    return { error: "Браузер не запущен. Сначала вызови browserOpen (url)." };
  }
  const tab = resolveTab(tabId);
  if (!tab) {
    return { error: "Вкладка не найдена: " + (tabId || activeTabId || "—") + ". Открой страницу через browserOpen (url)." };
  }
  return { tab };
}

async function pageInfo(page) {
  let url = "";
  let title = "";
  try { url = page.url(); } catch {}
  try { title = await page.title(); } catch {}
  return { url, title };
}

async function afterNavigation(page) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
  } catch {}
}

// ── Карта страницы и умный поиск элементов ────────────────────────────────
// Идея: агент НЕ должен угадывать селекторы. Страница сама отдаёт карту —
// нумерованные ссылки (ref) с ролью и видимым именем; дальше агент действует
// по ref. Функция выполняется ВНУТРИ страницы, поэтому не ссылается ни на что
// снаружи — только DOM (её же использует тест с мини-DOM).
function collectInPage() {
  const SEL =
    "a[href],button,input,select,textarea,summary,[role],[contenteditable],[onclick],[tabindex]";
  const w = window;
  if (!w.__aiAgentRefSeq) w.__aiAgentRefSeq = 0;
  const nodes = document.querySelectorAll(SEL);
  const items = [];
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const tag = (el.tagName || "").toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && type === "hidden") continue;
    let rect = null;
    try { rect = el.getBoundingClientRect(); } catch (e) { rect = null; }
    if (!rect || rect.width < 1 || rect.height < 1) continue;
    let style = null;
    try { style = w.getComputedStyle(el); } catch (e) {}
    if (
      style &&
      (style.visibility === "hidden" || style.display === "none" ||
        style.opacity === "0" || style.pointerEvents === "none")
    ) {
      continue;
    }
    let ref = el.getAttribute("data-agent-ref");
    if (!ref) {
      w.__aiAgentRefSeq += 1;
      ref = "e" + w.__aiAgentRefSeq;
      el.setAttribute("data-agent-ref", ref);
    }
    const attr = (n) => el.getAttribute(n) || "";
    let labelledby = "";
    const lb = attr("aria-labelledby");
    if (lb) {
      labelledby = lb
        .split(/\s+/)
        .map((id) => {
          const n = document.getElementById(id);
          return n ? (n.innerText || n.textContent || "") : "";
        })
        .join(" ")
        .trim();
    }
    let labelText = "";
    try {
      if (el.labels && el.labels.length) {
        for (let j = 0; j < el.labels.length; j++) {
          labelText += " " + (el.labels[j].innerText || el.labels[j].textContent || "");
        }
      } else if (el.closest) {
        const p = el.closest("label");
        if (p) labelText = p.innerText || p.textContent || "";
      }
    } catch (e) {}
    let text = "";
    try { text = el.innerText || el.textContent || ""; } catch (e) {}
    const cls = typeof el.className === "string" ? el.className : "";
    items.push({
      ref,
      tag,
      type,
      roleAttr: attr("role").toLowerCase(),
      contenteditable:
        el.isContentEditable === true || attr("contenteditable") === "true" || attr("contenteditable") === "",
      onclick: !!el.onclick || !!attr("onclick"),
      tabindex: el.getAttribute("tabindex"),
      href: tag === "a" ? attr("href") : "",
      disabled: el.disabled === true || attr("aria-disabled") === "true",
      checked: el.checked === true,
      ariaLabel: attr("aria-label"),
      labelledby,
      labelText,
      text: String(text).replace(/\s+/g, " ").trim().slice(0, 160),
      // Значения полей НЕ собираем: там бывают пароли, коды 2FA и личные данные.
      // Исключение — подписи кнопок-<input>: value и есть видимое имя кнопки.
      value:
        tag === "input" && (type === "submit" || type === "button" || type === "reset" || type === "image")
          ? attr("value")
          : "",
      placeholder: attr("placeholder"),
      title: attr("title"),
      alt: attr("alt"),
      nameAttr: tag === "input" || tag === "select" || tag === "textarea" ? attr("name") : "",
      id: attr("id"),
      cls: String(cls).replace(/\s+/g, " ").trim().slice(0, 80),
      inViewport:
        rect.bottom > 0 && rect.top < (w.innerHeight || 0) && rect.right > 0 && rect.left < (w.innerWidth || 0),
    });
    if (items.length >= 400) break;
  }
  return { url: location.href, title: document.title || "", items };
}

// Собрать карту страницы и превратить её в элементы для агента (роли и имена — из dom-map).
async function collectMap(page) {
  const raw = await page.evaluate(collectInPage);
  const items = [];
  let order = 0;
  for (const r of (raw && raw.items) || []) {
    if (!dom.isInteractive(r)) continue;
    order += 1;
    items.push({
      ref: r.ref,
      role: dom.roleOf(r),
      name: dom.accessibleName(r),
      tag: r.tag,
      type: r.type,
      id: r.id,
      cls: r.cls,
      placeholder: r.placeholder,
      href: r.href ? String(r.href).slice(0, 200) : "",
      disabled: !!r.disabled,
      checked: !!r.checked,
      secret: r.type === "password",
      inViewport: r.inViewport !== false,
      order,
    });
  }
  return { url: (raw && raw.url) || "", title: (raw && raw.title) || "", items };
}

// Селектор может прийти как CSS, text=… или xpath=… — поддерживаем все виды.
function cssOrTextLocator(page, s) {
  const t = String(s || "").trim();
  if (/^xpath=/i.test(t)) return page.locator("xpath=" + t.slice(6).trim());
  return page.locator(t);
}

// Первый подходящий локатор: сначала ВИДИМЫЙ, иначе — просто существующий
// (элемент может появиться чуть позже — нативная авто-догрузка Playwright).
async function firstUsable(candidates) {
  let fallback = null;
  for (const c of candidates) {
    if (!c || !c.loc) continue;
    let loc = c.loc;
    try {
      if (typeof loc.first === "function") loc = loc.first();
    } catch {}
    let n = 0;
    try { n = await loc.count(); } catch { n = 0; }
    if (!n) continue;
    let vis = false;
    try { vis = await loc.isVisible(); } catch { vis = false; }
    if (vis) return { loc, desc: c.desc };
    if (!fallback) fallback = { loc, desc: c.desc };
  }
  return fallback;
}

const CLICK_ROLES = ["button", "link", "menuitem", "tab", "checkbox", "radio", "option", "switch", "treeitem"];
const FIELD_ROLES = ["textbox", "searchbox", "combobox", "spinbutton"];

// Кандидаты для клика — от самого надёжного (ref) к самому общему (текст).
function clickCandidates(page, q) {
  const out = [];
  if (q.ref) out.push({ loc: page.locator(dom.refSelector(q.ref)), desc: "ref " + q.ref });
  if (q.selector) {
    out.push({ loc: cssOrTextLocator(page, q.selector), desc: q.selector });
    if (!/^(text|xpath)=/i.test(q.selector)) {
      out.push({ loc: page.getByText(q.selector, { exact: false }), desc: "текст «" + q.selector + "»" });
    }
  }
  if (q.role) {
    out.push({
      loc: page.getByRole(q.role, q.name ? { name: q.name } : {}),
      desc: "role=" + q.role + (q.name ? ' name="' + q.name + '"' : ""),
    });
  }
  // Поиск по имени идёт всегда, даже если роль задана: так запрос по роли из карты
  // («clickable» у div) все равно найдёт кнопку, если роль не совпала.
  const nm = q.name || q.label || q.text;
  if (nm) {
    for (const role of CLICK_ROLES) {
      out.push({ loc: page.getByRole(role, { name: nm }), desc: "role=" + role + ' name="' + nm + '"' });
    }
    out.push({ loc: page.getByText(nm, { exact: false }), desc: "текст «" + nm + "»" });
  }
  return out;
}

// Кандидаты для полей ввода: ref, selector, подпись, placeholder, role+name.
function fieldCandidates(page, q) {
  const out = [];
  if (q.ref) out.push({ loc: page.locator(dom.refSelector(q.ref)), desc: "ref " + q.ref });
  if (q.selector) {
    out.push({ loc: cssOrTextLocator(page, q.selector), desc: q.selector });
    if (!/^(text|xpath)=/i.test(q.selector)) {
      out.push({ loc: page.getByLabel(q.selector, { exact: false }), desc: "подпись «" + q.selector + "»" });
      out.push({ loc: page.getByText(q.selector, { exact: false }), desc: "текст «" + q.selector + "»" });
    }
  }
  if (q.label) out.push({ loc: page.getByLabel(q.label, { exact: false }), desc: "подпись «" + q.label + "»" });
  if (q.placeholder) {
    out.push({ loc: page.getByPlaceholder(q.placeholder, { exact: false }), desc: "placeholder «" + q.placeholder + "»" });
  }
  if (q.role) {
    out.push({
      loc: page.getByRole(q.role, q.name ? { name: q.name } : {}),
      desc: "role=" + q.role + (q.name ? ' name="' + q.name + '"' : ""),
    });
  }
  const nm = q.name;
  if (nm) {
    out.push({ loc: page.getByLabel(nm, { exact: false }), desc: "подпись «" + nm + "»" });
    out.push({ loc: page.getByPlaceholder(nm, { exact: false }), desc: "placeholder «" + nm + "»" });
    for (const role of FIELD_ROLES) {
      out.push({ loc: page.getByRole(role, { name: nm }), desc: "role=" + role + ' name="' + nm + '"' });
    }
  }
  return out;
}

async function resolveTarget(page, q, kind) {
  let cands = [];
  try {
    cands = kind === "field" ? fieldCandidates(page, q) : clickCandidates(page, q);
  } catch (e) {
    cands = [];
  }
  return await firstUsable(cands);
}

// Что искать в подсказках: человеческое имя, а не CSS-селектор.
function suggestQuery(q) {
  const human = q.name || q.label || q.placeholder || q.text;
  if (human) return human;
  const s = String(q.selector || "").replace(/^(text|xpath)=/i, "");
  const stripped = s.replace(/[#.\[\]>+~*:=()'"|]/g, " ").replace(/\s+/g, " ").trim();
  return stripped || s;
}

// Промах: не молчим, а присылаем карту похожих элементов с ref — агент
// делает следующий шаг сразу, без перебора селекторов.
async function missText(page, what, q, reason) {
  let map = { items: [] };
  try { map = await collectMap(page); } catch {}
  const why = /не найден|not found|no element|Timeout|timed out/i.test(String(reason || ""))
    ? ""
    : String(reason || "").slice(0, 150);
  return (
    "Ошибка " + what + ":\n" +
    dom.suggestText({ items: map.items || [], query: suggestQuery(q), reason: why })
  );
}

// ── Инструменты ────────────────────────────────────────────────────────────

// Открыть страницу в новой (или активной) вкладке. Возвращает id вкладки.
async function open(args) {
  args = args || {};
  const url = String(args.url || "").trim();
  if (!/^https?:\/\//i.test(url)) return "Ошибка: укажи полный URL, например https://example.com";
  const r = await ensureBrowser();
  if (!r.ok) return r.message;
  let page = null;
  if (!args.newTab && activeTabId) {
    const cur = tabs.get(activeTabId);
    if (cur) page = cur.page;
  }
  if (!page) {
    // Постоянный профиль (и свой Chrome по CDP) стартует с пустой вкладки —
    // используем её, а не плодим новую.
    try {
      if (!tabs.size) {
        const pages = listPages();
        if (pages.length === 1 && pages[0].url() === "about:blank") page = pages[0];
      }
    } catch {}
  }
  if (!page) page = await newPageInBrowser();
  const tabId = "tab" + (++tabSeq);
  tabs.set(tabId, { id: tabId, page, openedAt: Date.now() });
  activeTabId = tabId;
  page.on("close", () => {
    if (tabs.has(tabId)) {
      tabs.delete(tabId);
      if (activeTabId === tabId) activeTabId = tabs.size ? Array.from(tabs.keys()).pop() : null;
    }
  });
  let navErr = "";
  try {
    await page.goto(url, {
      waitUntil: args.waitUntil === "load" ? "load" : "domcontentloaded",
      timeout: 30000,
    });
  } catch (e) {
    navErr = (e && e.message ? e.message : String(e)).slice(0, 300);
  }
  const info = await pageInfo(page);
  let out =
    "Вкладка " + tabId + " открыта (движок: " + engineName + ")\n" +
    "URL: " + (info.url || url) + "\n" +
    "Заголовок: " + (info.title || "—");
  if (navErr && !/net::ERR_NAME_NOT_RESOLVED|timeout/i.test(navErr)) out += "\nЗамечание: " + navErr;
  return out;
}

// Заполнить текстовое поле. Поле можно указать как угодно: ref из browserSnapshot
// (самый надёжный), label/placeholder/name (подпись или подсказка поля), role+name
// или selector (CSS, text=…, xpath=…).
// Поддержка contenteditable (ВК и другие SPA): если fill не сработал —
// клик по полю → очистка (Ctrl+A) → вставка через insertText, которая корректно
// триггерит события ввода в кастомных редакторах.
async function fill(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const text = String(args.text == null ? "" : args.text);
  const q = dom.parseQuery(args, { forField: true });
  if (!dom.hasQuery(q)) {
    return "Ошибка browserFill: укажи поле — ref из browserSnapshot (ref: \"e4\"), label/placeholder/name (видимая подпись) или selector (CSS / text= / xpath=).";
  }
  const target = await resolveTarget(t.tab.page, q, "field");
  if (!target) return missText(t.tab.page, "browserFill", q, "поле не найдено");
  let via = "fill";
  try {
    await target.loc.fill(text, { timeout: ACTION_TIMEOUT });
  } catch (e1) {
    const firstErr = (e1 && e1.message) || String(e1);
    try {
      await target.loc.click({ timeout: ACTION_TIMEOUT });
      await t.tab.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A", { timeout: ACTION_TIMEOUT });
      await t.tab.page.keyboard.insertText(text, { timeout: ACTION_TIMEOUT });
      via = "insertText";
    } catch (e2) {
      return missText(t.tab.page, "browserFill", q, ((e2 && e2.message) || firstErr || "").slice(0, 160));
    }
  }
  return "OK — поле «" + target.desc + "» заполнено (" + text.length + " символов, способ: " + via + ").";
}

// Кликнуть по элементу. Способы (любой один): ref из browserSnapshot,
// role+name (доступное имя — например role: "button", name: "Войти"),
// name/text (видимый текст), selector (CSS / text= / xpath=).
async function click(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const q = dom.parseQuery(args);
  if (!dom.hasQuery(q)) {
    return "Ошибка browserClick: укажи, по чему кликать — ref из browserSnapshot (ref: \"e2\"), name (видимый текст кнопки), role+name или selector. Карту элементов даёт browserSnapshot.";
  }
  const target = await resolveTarget(t.tab.page, q, "click");
  if (!target) return missText(t.tab.page, "browserClick", q, "элемент не найден");
  try {
    try { await target.loc.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch {}
    await target.loc.click({ timeout: ACTION_TIMEOUT });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (/intercepts pointer events/i.test(msg)) {
      return (
        "Ошибка browserClick («" + target.desc + "»): элемент перекрыт другим слоем (баннер, окно cookie, модальное окно). " +
        "Закрой перекрывающее окно и повтори.\n" +
        (await missText(t.tab.page, "browserClick", q, "перекрыт другим элементом"))
      );
    }
    return missText(t.tab.page, "browserClick", q, msg.slice(0, 160));
  }
  if (args.waitLoad !== false) await afterNavigation(t.tab.page);
  const info = await pageInfo(t.tab.page);
  return "OK — клик по «" + target.desc + "». Текущий URL: " + (info.url || "—");
}

// Выбрать значение в <select>: ref / selector / label. Если вариант не подошёл —
// показываем реальные варианты списка (без угадывания).
async function select(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const value = args.value == null ? "" : String(args.value);
  const q = dom.parseQuery(args, { forField: true });
  if (!dom.hasQuery(q)) return "Ошибка browserSelect: укажи список — ref из browserSnapshot, selector или label.";
  const target = await resolveTarget(t.tab.page, q, "field");
  if (!target) return missText(t.tab.page, "browserSelect", q, "список не найден");
  try {
    await target.loc.selectOption(value, { timeout: ACTION_TIMEOUT });
    return "OK — в «" + target.desc + "» выбрано: " + value;
  } catch (e) {
    let opts = [];
    try {
      opts = await target.loc.evaluate((el) =>
        Array.from(el.options || [])
          .map((o) => o.value + (o.text && o.text !== o.value ? " («" + o.text + "»)" : ""))
          .slice(0, 20)
      );
    } catch {}
    const head = "Ошибка browserSelect: в «" + target.desc + "» не выбрался вариант «" + value + "».";
    return opts.length
      ? head + "\nВарианты списка: " + opts.join(", ")
      : head + " " + String((e && e.message) || "").slice(0, 150);
  }
}

// Нажать клавишу (Enter, Escape, Tab, стрелки…). Работает с активным элементом страницы.
async function press(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const key = String(args.key || "").trim();
  if (!key) return "Ошибка: укажи key (например Enter)";
  try {
    await t.tab.page.keyboard.press(key, { timeout: ACTION_TIMEOUT });
  } catch (e) {
    return "Ошибка browserPress: " + ((e && e.message || "").slice(0, 200));
  }
  if (args.waitLoad !== false) await afterNavigation(t.tab.page);
  return "OK — нажата клавиша " + key + ".";
}

// Прочитать видимый текст страницы (до max символов).
async function text(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const max = Math.max(1000, Math.min(parseInt(args.max, 10) || 12000, 30000));
  let bodyText = "";
  try {
    bodyText = await t.tab.page.evaluate(() => (document.body ? document.body.innerText : ""));
  } catch (e) {
    return "Ошибка browserText: " + ((e && e.message || "").slice(0, 200));
  }
  const info = await pageInfo(t.tab.page);
  const clean = String(bodyText || "").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = clean.length > max;
  const shown = truncated ? clean.slice(0, max) + "\n… [текст обрезан, всего " + clean.length + " символов]" : clean;
  return "URL: " + (info.url || "—") + "\nЗаголовок: " + (info.title || "—") + "\n\n" + (shown || "(пустая страница)");
}

// Скриншот страницы (PNG, data URL). Можно передать в vision-модель или показать пользователю.
async function screenshot(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  try {
    const buf = await t.tab.page.screenshot({ type: "png", fullPage: args.fullPage === true });
    return "data:image/png;base64," + buf.toString("base64");
  } catch (e) {
    return "Ошибка browserScreenshot: " + ((e && e.message || "").slice(0, 200));
  }
}

// Ждать появления элемента: selector, ref или name/text (та же логика поиска,
 // что у клика — поэтому ожидание можно писать словами, а не селектором).
async function wait(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const q = dom.parseQuery(args);
  if (!dom.hasQuery(q)) return "Ошибка browserWait: укажи selector, ref или name/text ожидаемого элемента.";
  const timeout = Math.min(parseInt(args.timeout, 10) || 10000, 60000);
  const cands = q.ref
    ? [{ loc: t.tab.page.locator(dom.refSelector(q.ref)), desc: "ref " + q.ref }]
    : clickCandidates(t.tab.page, q);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const target = await firstUsable(cands);
    if (target) {
      let vis = false;
      try { vis = await target.loc.isVisible(); } catch { vis = false; }
      if (vis) return "OK — элемент «" + target.desc + "» появился.";
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return missText(t.tab.page, "browserWait", q, "не появился за " + timeout + " мс");
}

// Карта интерактивных элементов страницы: ref, роль, видимое имя.
// Это «глаза» агента на кнопки и поля — вместо угадывания селекторов.
async function snapshot(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  let map;
  try {
    map = await collectMap(t.tab.page);
  } catch (e) {
    return "Ошибка browserSnapshot: " + String((e && e.message) || e).slice(0, 200);
  }
  return dom.formatSnapshot({
    items: map.items,
    url: map.url,
    title: map.title,
    filter: String(args.filter || "").trim(),
    limit: parseInt(args.limit, 10) || 60,
  });
}

// Закрыть вкладку (по умолчанию активную; "all" — все вкладки и браузер).
async function close(args) {
  args = args || {};
  if (args.tabId === "all" || args.all) {
    const list = Array.from(tabs.values());
    for (const tb of list) {
      if (tb.adopted) continue; // вкладки пользователя не закрываем
      try { await tb.page.close(); } catch {}
    }
    const adoptedCount = list.filter((tb) => tb.adopted).length;
    tabs.clear();
    activeTabId = null;
    runningProfileDir = null;
    runningModeKey = null;
    if (cdpActive) {
      // Свой Chrome НЕ закрываем: только отключаемся, его вкладки и сессии целы.
      browser = null;
      cdpActive = false;
      cdpContext = null;
      sessionClosed = true;
      return (
        "OK — отключился от твоего Chrome (он продолжает работать, вкладки" +
        (adoptedCount ? " (" + adoptedCount + ")" : "") +
        " и входы на сайты на месте)."
      );
    }
    if (sessionAlive()) { try { await browser.close(); } catch {} }
    browser = null;
    sessionClosed = true;
    return "OK — все вкладки и браузер закрыты.";
  }
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  if (t.tab.adopted) {
    return "Это вкладка твоего Chrome (" + t.tab.id + ") — я её не закрываю, чтобы не тронуть твою работу. Открой новую вкладку через browserOpen.";
  }
  const id = t.tab.id;
  try { await t.tab.page.close(); } catch {}
  tabs.delete(id);
  if (activeTabId === id) activeTabId = tabs.size ? Array.from(tabs.keys()).pop() : null;
  return "OK — вкладка " + id + " закрыта.";
}

// Список открытых вкладок.
async function status() {
  if (!sessionAlive()) {
    return "Браузер не запущен. Ни одной вкладки нет. Открой страницу через browserOpen (url)." + profileNote();
  }
  const rows = [];
  for (const [id, tb] of tabs.entries()) {
    const info = await pageInfo(tb.page);
    rows.push((id === activeTabId ? "▶ " : "   ") + id + "  " + (info.title || "").slice(0, 60) + "  " + (info.url || ""));
  }
  if (!rows.length) return "Браузер запущен, вкладок нет. browserOpen (url) — открыть страницу.";
  return "Открытые вкладки (" + rows.length + "), движок: " + engineName + ":\n" + rows.join("\n") +
    "\n\nАктивная — ▶. Для действий в конкретной вкладке передавай tabId." + profileNote();
}

// Остановить браузер (вызывается при выходе из приложения).
async function stop() {
  // В режиме «свой Chrome» отключаемся, НЕ закрывая браузер пользователя.
  if (sessionAlive() && !cdpActive) {
    try { await browser.close(); } catch {}
  }
  browser = null;
  tabs.clear();
  activeTabId = null;
  sessionClosed = true;
  runningProfileDir = null;
  runningModeKey = null;
  cdpActive = false;
  cdpContext = null;
}

// Полная очистка постоянного профиля: выход со всех сайтов, стирание куки и сессий.
async function clearProfile() {
  if (cdpActive) {
    return "Сейчас инструменты работают в твоём Chrome (CDP). Закрой его окно (или вызови browserClose с tabId: \"all\") — иначе профиль занят и файлы не удалятся.";
  }
  await stop();
  if (!profileDir) return "Постоянный профиль браузера выключен — очищать нечего.";
  await new Promise((r) => setTimeout(r, 400)); // даём Chromium отпустить файлы профиля
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch (e) {
    return "Не удалось очистить профиль браузера: " + (((e && e.message) || String(e)) + "").slice(0, 200);
  }
  return "OK — профиль браузера очищен. При следующем входе на сайт потребуется авторизация заново.";
}

module.exports = {
  open,
  snapshot,
  fill,
  click,
  select,
  press,
  text,
  screenshot,
  wait,
  close,
  status,
  stop,
  connect,
  setConnectMode,
  connectInfo,
  setProfileDir,
  profilePath,
  clearProfile,
  collectInPage, // используется тестами (мини-DOM), не вызывается снаружи
  setPlaywright, // только для тестов: подменить/сбросить кэш playwright
};