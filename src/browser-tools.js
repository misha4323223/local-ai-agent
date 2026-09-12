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
// Сколько ждём появления элемента, прежде чем сказать «не нашёл». Раньше провал был
// мгновенным: если SPA ещё не дорисовала кнопку, модель получала ошибку и тратила
// ходы на browserWait и повторный browserSnapshot. Теперь ждём сами.
const FIND_TIMEOUT = 3000;
const FIND_POLL_MS = 200;
// По ref ждать почти нечего: либо элемент на месте, либо ref устарел после перехода.
const FIND_TIMEOUT_REF = 800;

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
    if (browser && typeof browser.pages === "function") {
      const r = browser.pages();
      // ВАЖНО: у BrowserContext pages() синхронный (массив), у Browser — Promise.
      // Раньше промис возвращался как «список» (length === undefined), и всё,
      // что по нему итерируется, падало с «pages is not iterable».
      return Array.isArray(r) ? r : [];
    }
  } catch {}
  return [];
}

// Тот же список, но с ожиданием (для подхвата вкладок, открытых кликом).
async function allPages() {
  try {
    if (cdpActive && cdpContext) return cdpContext.pages() || [];
    if (browser && typeof browser.pages === "function") {
      const r = browser.pages();
      return Array.isArray(r) ? r : (await r) || [];
    }
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

// Сколько вкладок сейчас открыто (без создания).
async function pageCount() {
  return (await allPages()).length;
}

// Подхватить вкладки, появившиеся ПОСЛЕ действия (ссылка с target=_blank,
// window.open, платёжный виджет). Без этого агент остаётся в старой вкладке и
// решает, что «клик ничего не сделал».
async function adoptNewPages(before) {
  const opened = [];
  const pages = await allPages();
  if (pages.length <= before) return opened;
  for (const p of pages) {
    let url = "";
    try { url = p.url() || ""; } catch { continue; }
    let known = false;
    for (const tb of tabs.values()) if (tb.page === p) { known = true; break; }
    if (known || !/^https?:/i.test(url)) continue;
    if (tabs.size >= 25) break;
    const tabId = "tab" + (++tabSeq);
    tabs.set(tabId, { id: tabId, page: p, openedAt: Date.now(), adopted: !!cdpActive });
    activeTabId = tabId;
    try {
      p.on("close", () => {
        if (tabs.has(tabId)) {
          tabs.delete(tabId);
          if (activeTabId === tabId) activeTabId = tabs.size ? Array.from(tabs.keys()).pop() : null;
        }
      });
    } catch {}
    opened.push(tabId + "  " + url.slice(0, 90));
  }
  return opened;
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
  // Сеть вкладки копим с первого инструмента: агент спрашивает её ПОСЛЕ действия.
  try { const t0 = activeTabId ? tabs.get(tabId || activeTabId) : null; if (t0 && t0.page && t0.page.on) netRecorder(t0.page); } catch (e) {}
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
  // Слои ПОВЕРХ страницы: диалоги Angular Material (консоль Google Cloud, банки),
  // модальные окна, окно перевода Google. Раньше карта их не видела (диалог
  // дописывается в конец <body> и отрезался лимитом строк), а клик падал на
  // проверке «элемент под курсором». Теперь такие элементы идут ПЕРВЫМИ и
  // помечены — с ними и надо работать, они перекрывают всю страницу.
  const OVERLAY_SEL =
    ".cdk-overlay-pane,.cdk-overlay-container,[role=dialog],[role=alertdialog],[aria-modal=true]," +
    "dialog[open],mat-dialog-container,.mat-mdc-dialog-container,.modal,.modal-dialog," +
    ".goog-te-banner-frame,#goog-gt-tt,.skiptranslate";
  const w = window;
  if (!w.__aiAgentRefSeq) w.__aiAgentRefSeq = 0;

  // Дерево обходим с заходом в shadow DOM: сайты на веб-компонентах держат кнопки
  // внутри shadow-root, и обычный querySelectorAll их не находит.
  const roots = [{ root: document, depth: 0 }];
  const nodes = [];
  for (let ri = 0; ri < roots.length && roots.length < 40; ri++) {
    const entry = roots[ri];
    let found = [];
    try { found = entry.root.querySelectorAll(SEL); } catch (e) { found = []; }
    for (let k = 0; k < found.length; k++) {
      const el = found[k];
      nodes.push(el);
      try {
        if (entry.depth < 3 && el.shadowRoot) roots.push({ root: el.shadowRoot, depth: entry.depth + 1 });
      } catch (e) {}
    }
  }
  const items = [];
  const overlayHosts = [];

  // Ближайший overlay-контейнер элемента + его человеческое имя («Welcome …»).
  const overlayOf = (el) => {
    let host = null;
    try { host = el.closest ? el.closest(OVERLAY_SEL) : null; } catch (e) { host = null; }
    if (!host) {
      // Shadow DOM: closest не выходит за границу корня — идём по хостам вверх.
      try {
        let r = el.getRootNode ? el.getRootNode() : null;
        let guard = 0;
        while (r && r.host && !host && guard++ < 10) {
          host = r.host.closest ? r.host.closest(OVERLAY_SEL) : null;
          r = r.host.getRootNode ? r.host.getRootNode() : null;
        }
      } catch (e) {}
    }
    if (!host) return null;
    let name = "";
    try { name = host.getAttribute("aria-label") || ""; } catch (e) {}
    if (!name) {
      try {
        const h = host.querySelector("[role=heading],h1,h2,h3,h4,h5,h6");
        if (h) name = h.innerText || h.textContent || "";
      } catch (e) {}
    }
    if (!name) {
      try {
        name = String(host.innerText || host.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
      } catch (e) {}
    }
    if (overlayHosts.indexOf(host) < 0 && overlayHosts.length < 8) {
      overlayHosts.push(host);
      overlayHosts[host] = String(name).replace(/\s+/g, " ").trim().slice(0, 80);
    }
    return { host: host, name: String(name).replace(/\s+/g, " ").trim().slice(0, 80) };
  };

  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const tag = (el.tagName || "").toLowerCase();
    const elAttr = (x) => { try { return el.getAttribute(x) || ""; } catch (e) { return ""; } };
    const type = (elAttr("type") || "").toLowerCase();
    if (tag === "input" && type === "hidden") continue;
    let rect = null;
    try { rect = el.getBoundingClientRect(); } catch (e) { rect = null; }
    const tiny = !rect || rect.width < 1 || rect.height < 1;
    let style = null;
    try { style = w.getComputedStyle(el); } catch (e) {}
    const overlay = overlayOf(el);
    const roleAttr0 = (elAttr("role") || "").toLowerCase();
    // Галочка — это не «мусорный» элемент: у Angular Material настоящий <input
    // type=checkbox> прозрачный (opacity: 0), а видно стилизованный квадратик.
    // Такой ввод берём в карту, но помечаем: по нему нужен force-клик.
    const isCheck =
      (tag === "input" && (type === "checkbox" || type === "radio")) ||
      roleAttr0 === "checkbox" || roleAttr0 === "radio" || roleAttr0 === "switch";
    if (style && (style.visibility === "hidden" || style.display === "none")) continue;
    if (tiny && !isCheck) continue;
    if (style && style.opacity === "0" && !isCheck) continue;
    const peNone = !!(style && style.pointerEvents === "none");
    if (peNone && !(overlay && (isCheck || tag === "button" || tag === "a" || roleAttr0))) continue;
    const hiddenInput = isCheck && !!style && (style.opacity === "0" || tiny);
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
      inDialog: !!overlay,
      dialogName: overlay ? overlay.name : "",
      hiddenInput: hiddenInput,
      peNone: peNone,
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
  // Сводка по слоям: имя, класс и текст (по тексту классифицируем — согласие,
  // cookie, окно перевода). Текст обрезаем: он уходит агенту в контекст.
  const overlays = [];
  for (let i = 0; i < overlayHosts.length; i++) {
    const h = overlayHosts[i];
    let text = "";
    try { text = String(h.innerText || h.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500); } catch (e) {}
    let hcls = "";
    try { hcls = typeof h.className === "string" ? h.className : ""; } catch (e) {}
    overlays.push({
      name: overlayHosts[h] || "",
      text: text,
      cls: hcls.replace(/\s+/g, " ").trim().slice(0, 120),
      tag: (h.tagName || "").toLowerCase(),
    });
  }
  return { url: location.href, title: document.title || "", items, overlays };
}

// Классификация слоя поверх страницы по имени/классу/тексту. Чистая функция —
// используется и инструментом, и тестами.
function overlayKind(o) {
  const hay = ((o && o.name) || "") + " " + ((o && o.cls) || "") + " " + ((o && o.text) || "");
  const s = String(hay).toLowerCase();
  if (/goog-te|skiptranslate|goog-gt/.test(s)) return "translate";
  if (/terms of service|terms and conditions|пользовательск|условия использования|i agree|я согласен|лицензионн|безопасност/.test(s)) return "terms";
  if (/cookie|печень|куки|accept all|принять все/.test(s)) return "cookie";
  if (/перевести|перевод страницы|translate this page|не сейчас|no thanks|never translate/.test(s)) return "translate";
  if (/dismiss|закрыть|понятно|got it|позже|later|больше не показывать/.test(s)) return "noise";
  return "dialog";
}

const OVERLAY_LABEL = {
  translate: "окно перевода Google",
  terms: "юридическое согласие (terms of service)",
  cookie: "баннер cookie",
  noise: "информационный баннер",
  dialog: "диалоговое окно",
};

// Элементы диалога с человеческими пометками: что это (галочка/кнопка/поле),
// как называется и как по нему действовать.
function overlayItems(map, dialogName) {
  const items = (map && map.items) || [];
  return items.filter((it) => it.inDialog && (!dialogName || it.dialogName === dialogName));
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
      inDialog: !!r.inDialog,
      dialogName: r.dialogName || "",
      hiddenInput: !!r.hiddenInput,
      peNone: !!r.peNone,
      order,
    });
  }
  // Элементы открытого диалога — В НАЧАЛЕ карты: он перекрывает страницу,
  // поэтому работать надо с ним, а обычные элементы подождут (сортировка
  // стабильная, порядок внутри групп сохраняется).
  items.sort((a, b) => (b.inDialog ? 1 : 0) - (a.inDialog ? 1 : 0));
  return {
    url: (raw && raw.url) || "",
    title: (raw && raw.title) || "",
    items,
    overlays: (raw && raw.overlays) || [],
  };
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Все «окна» страницы: сама страница + вложенные фреймы (вход через iframe,
// платёжные и капча-виджеты, ленивые консоли). Поиск по фреймам снимает
// половину «не нашёл» — раньше такой элемент был для агента невидимым.
function frameList(page) {
  const out = [page];
  try {
    if (page && typeof page.frames === "function") {
      for (const f of page.frames()) if (f && out.indexOf(f) < 0) out.push(f);
    }
  } catch {}
  return out;
}

function frameLabel(page, fr) {
  if (!fr || fr === page) return "";
  let u = "";
  try { u = fr.url() || ""; } catch {}
  if (!u) {
    try { if (typeof fr.name === "function") u = fr.name() || ""; } catch {}
  }
  return u ? " (фрейм " + String(u).slice(0, 70) + ")" : " (фрейм)";
}

async function visibleNow(loc) {
  try { return await loc.isVisible(); } catch { return false; }
}

// Поиск цели по ВСЕМ фреймам и с ожиданием появления. Если ничего не нашли сразу —
// опрашиваем страницу до timeout (по умолчанию 3 с), вместо мгновенного провала.
// Возвращает { loc, desc, frame } или невидимый запасной вариант (клик попробует
// прокрутить его и нажать силой).
async function resolveTarget(page, q, kind, opts) {
  const o = opts || {};
  const asked = parseInt(o.timeout, 10);
  const waitMs = q.ref
    ? (isNaN(asked) ? FIND_TIMEOUT_REF : Math.min(asked, 10000))
    : (isNaN(asked) ? FIND_TIMEOUT : Math.max(0, Math.min(asked, 30000)));
  const deadline = Date.now() + waitMs;
  let fallback = null;
  for (;;) {
    fallback = null;
    for (const fr of frameList(page)) {
      let cands = [];
      try {
        cands = kind === "field" ? fieldCandidates(fr, q) : clickCandidates(fr, q);
      } catch (e) {
        cands = [];
      }
      const t = await firstUsable(cands);
      if (!t) continue;
      const rc = { loc: t.loc, desc: t.desc + frameLabel(page, fr), frame: fr };
      if (await visibleNow(t.loc)) return rc;
      if (!fallback) fallback = rc;
    }
    // Что-то нашли (пусть и невидимое) — не ждём: дальше решает клик (force/прокрутка).
    if (fallback) return fallback;
    if (Date.now() >= deadline) break;
    await sleep(FIND_POLL_MS);
  }
  return null;
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

// ── Составное действие: несколько шагов одной командой ────────────────────
// Зачем: слабая или быстрая модель тратит ходы на каждый шаг (клик → карта →
// ввод → Enter → проверка) и на этом «застревает». Здесь вся цепочка идёт одним
// вызовом: мы сами ждём появления элементов и останавливаемся на первом сбое.
// Шаги (любая форма, см. normalizeStep):
//   { "click": "Войти" } · { "ref": "e2" } · { "click": { "ref": "e2" } }
//   { "fill": { "ref": "e4", "text": "…" }, "submit": true }
//   { "fill": "привет", "ref": "e9" } · { "field": "Почта", "text": "a@b.c" }
//   { "press": "Enter" } · { "key": "Escape" }
//   { "wait": 800 } · { "waitFor": "Готово" }
//   { "scroll": "down", "times": 3 } · { "eval": "document.title" }
//   { "read": true } · { "snapshot": true }
function stepQuery(s) {
  const q = {};
  for (const k of ["ref", "selector", "css", "role", "name", "label", "placeholder", "field", "text"]) {
    if (s[k] != null) q[k] = s[k];
  }
  return q;
}

function normalizeStep(raw) {
  if (typeof raw === "string") {
    return { kind: "click", args: { name: raw }, label: "клик по «" + raw.slice(0, 40) + "»" };
  }
  const s = raw && typeof raw === "object" ? raw : null;
  if (!s) return null;
  const q = stepQuery(s);
  const code = s.eval != null ? s.eval : s.js != null ? s.js : s.script != null ? s.script : null;
  if (code != null) return { kind: "eval", args: { script: code }, label: "JS на странице" };
  const link = s.goto != null ? s.goto : s.open != null ? s.open : s.navigate != null ? s.navigate : null;
  if (typeof link === "string" && link) {
    return { kind: "open", args: { url: link, newTab: s.newTab }, label: "открыть " + link.slice(0, 60) };
  }
  if (s.back === true || s.goBack === true || s.previous === true) {
    return { kind: "back", args: {}, label: "назад по истории" };
  }
  if (typeof s.press === "string" && s.press) return { kind: "press", args: { key: s.press, waitLoad: s.waitLoad }, label: "клавиша " + s.press };
  if (typeof s.key === "string" && s.key) return { kind: "press", args: { key: s.key, waitLoad: s.waitLoad }, label: "клавиша " + s.key };
  if (s.enter === true) return { kind: "press", args: { key: "Enter", waitLoad: s.waitLoad }, label: "клавиша Enter" };
  if (s.waitFor != null || s.forText != null) {
    const w = s.waitFor != null ? s.waitFor : s.forText;
    const wargs = typeof w === "string" ? Object.assign({}, q, { name: w }) : Object.assign({}, q, w || {});
    return { kind: "wait", args: wargs, label: "ждать появление «" + String(w && typeof w === "string" ? w : wargs.name || "").slice(0, 40) + "»" };
  }
  const pause = s.wait != null ? s.wait : s.ms != null ? s.ms : s.sleep;
  if (pause != null && !isNaN(parseInt(pause, 10))) {
    const n = Math.min(Math.max(parseInt(pause, 10), 0), 60000);
    return { kind: "pause", args: { ms: n }, label: "пауза " + n + " мс" };
  }
  if (s.scroll != null) {
    return { kind: "scroll", args: { how: s.scroll, times: s.times }, label: "прокрутка (" + String(s.scroll) + ")" };
  }
  if (s.read === true || (s.text === true && !q.ref)) {
    return { kind: "text", args: { max: s.max }, label: "текст страницы" };
  }
  if (s.snapshot != null) {
    const sn = s.snapshot && typeof s.snapshot === "object" ? s.snapshot : {};
    return { kind: "snapshot", args: sn, label: "карта страницы" };
  }
  // Значение для ввода: {"fill":"текст"} · {"fill":{...}} · {"type":"текст"} ·
  // {"field":"Почта","text":"…"} — последний вариант слабые модели пишут чаще всего.
  const val =
    s.fill != null
      ? s.fill
      : s.type != null
      ? s.type
      : s.field != null && s.text != null
      ? s.text
      : s.field != null && s.value != null
      ? s.value
      : null;
  if (val != null || s.field != null) {
    const fargs = Object.assign({}, q);
    if (typeof val === "string" || typeof val === "number") fargs.text = String(val);
    else if (val && typeof val === "object") Object.assign(fargs, val);
    if (s.submit != null) fargs.submit = s.submit;
    return {
      kind: "fill",
      args: fargs,
      label: "ввод" + (fargs.text != null ? " «" + String(fargs.text).slice(0, 30) + "»" : "") + (fargs.submit ? " + Enter" : ""),
    };
  }
  if (s.click != null || dom.hasQuery(dom.parseQuery(q))) {
    const cargs = Object.assign({}, q);
    if (typeof s.click === "string") cargs.name = s.click;
    else if (s.click && typeof s.click === "object") Object.assign(cargs, s.click);
    if (s.waitLoad != null) cargs.waitLoad = s.waitLoad;
    return {
      kind: "click",
      args: cargs,
      label: "клик по " + (cargs.name || cargs.ref || cargs.selector || "элементу"),
    };
  }
  return null;
}

// Прокрутка страницы: ленивые списки (ВК, бесконечные ленты) не отдают элементы,
// пока их не подгрузят скроллом.
async function scrollPage(page, a) {
  const how = String(a.how == null ? "down" : a.how).toLowerCase();
  const times = Math.max(1, Math.min(parseInt(a.times, 10) || 1, 10));
  for (let i = 0; i < times; i++) {
    let key = "PageDown";
    if (how === "up" || how === "вверх") key = "PageUp";
    else if (how === "top" || how === "начало") key = "Home";
    else if (how === "bottom" || how === "низ") key = "End";
    try {
      await page.keyboard.press(key, { timeout: ACTION_TIMEOUT });
    } catch (e) {
      return "Ошибка browserAct (прокрутка): " + String((e && e.message) || e).slice(0, 150);
    }
    await sleep(250);
  }
  await afterNavigation(page);
  return "OK — прокрутка " + how + (times > 1 ? " ×" + times : "");
}

async function goBackStep(page) {
  try {
    const r = await page.goBack({ timeout: ACTION_TIMEOUT, waitUntil: "domcontentloaded" });
    if (!r) return "Ошибка browserAct (назад): история переходов пуста";
  } catch (e) {
    return "Ошибка browserAct (назад): " + String((e && e.message) || e).slice(0, 150);
  }
  const pi = await pageInfo(page);
  return "OK — вернулся назад. URL: " + (pi.url || "—");
}

function stepFailed(res) {
  return /^(Ошибка|Не нашёл|Браузер не запущен|Вкладка не найдена|browserDOM:)/.test(String(res || ""));
}

// Несколько шагов одной командой. Первый сбой останавливает цепочку
// (stopOnError: false — продолжать), в ответе видно, что сработало, а что нет.
async function act(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  let steps = args.steps || args.actions || args.script;
  if (typeof steps === "string") {
    try { steps = JSON.parse(steps); } catch { steps = null; }
  }
  if (!Array.isArray(steps) || !steps.length) {
    return (
      "Ошибка browserAct: укажи steps — массив шагов. Пример:\n" +
      'browserAct { steps: [{ "click": "Войти" }, { "field": "Почта", "text": "a@b.c" }, ' +
      '{ "fill": "•••", "ref": "e5", "submit": true }, { "read": true }] }\n' +
      "Шаги: goto (открыть адрес), click, fill (+submit), press, wait (мс), waitFor (текст), back, scroll, eval, read, snapshot."
    );
  }
  const list = steps.slice(0, 20);
  const stopOnError = args.stopOnError !== false;
  const page = t.tab.page;
  const rows = [];
  let failed = 0;
  for (let i = 0; i < list.length; i++) {
    const st = normalizeStep(list[i]);
    const num = i + 1;
    if (!st) {
      failed++;
      rows.push(num + ". ❌ шаг не понял: " + JSON.stringify(list[i]).slice(0, 140));
      if (stopOnError) break;
      continue;
    }
    const a = Object.assign({}, st.args, { tabId: t.tab.id, waitLoad: args.waitLoad });
    let res = "";
    if (st.kind === "click") res = await click(a);
    else if (st.kind === "fill") res = await fill(a);
    else if (st.kind === "press") res = await press(a);
    else if (st.kind === "wait") res = await wait(a);
    else if (st.kind === "pause") res = await wait({ tabId: t.tab.id, ms: a.ms, load: a.load });
    else if (st.kind === "eval") res = await evalJs(a);
    else if (st.kind === "text") res = await text(a);
    else if (st.kind === "snapshot") res = await snapshot(a);
    else if (st.kind === "scroll") res = await scrollPage(page, a);
    else if (st.kind === "open") res = await open(a);
    else if (st.kind === "back") res = await goBackStep(page);
    const bad = stepFailed(res);
    if (bad) failed++;
    const one = String(res || "").replace(/\s+/g, " ").trim().slice(0, 220);
    rows.push(num + ". " + (bad ? "❌ " : "✅ ") + st.label + " — " + (one || "(без ответа)"));
    if (bad && stopOnError) break;
    if (args.stepDelayMs) await sleep(Math.min(Math.max(parseInt(args.stepDelayMs, 10) || 0, 0), 5000));
  }
  const info = await pageInfo(page);
  const done = rows.filter((r) => r.indexOf("✅") > 0).length;
  const out = [
    "browserAct: шагов " + rows.length + " из " + list.length + ", ок: " + done + (failed ? ", сбоев: " + failed : ""),
    ...rows,
    "URL: " + (info.url || "—") + (info.title ? " («" + info.title + "»)" : ""),
  ];
  if (failed) {
    out.push("Дальше: поправь шаг и вызови browserAct снова одним вызовом (похожие элементы и ref — browserSnapshot).");
  }
  return out.join("\n");
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
  // field — понятный человеку синоним подписи/имени поля (модели часто пишут именно так).
  const fargs =
    args.field != null && args.label == null && args.name == null
      ? Object.assign({}, args, { name: args.field })
      : args;
  const q = dom.parseQuery(fargs, { forField: true });
  if (!dom.hasQuery(q)) {
    return "Ошибка browserFill: укажи поле — ref из browserSnapshot (ref: \"e4\"), label/placeholder/name (видимая подпись) или selector (CSS / text= / xpath=).";
  }
  const findStart = Date.now();
  const found = await resolveTarget(t.tab.page, q, "field", { timeout: args.timeout });
  if (!found) {
    return missText(
      t.tab.page,
      "browserFill",
      q,
      "поле не найдено (ждал " + Math.round((Date.now() - findStart) / 1000) + " с)"
    );
  }
  const target = found;
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
  // submit: true — сразу отправить (Enter). Обычный случай: поиск, вход, сообщение.
  // Так агент делает «ввёл и отправил» одним вызовом, без отдельного browserPress.
  let sent = "";
  if (args.submit) {
    const key = typeof args.submit === "string" ? args.submit : "Enter";
    try {
      await t.tab.page.keyboard.press(key, { timeout: ACTION_TIMEOUT });
      sent = "; отправлено (" + key + ")";
      if (args.waitLoad !== false) await afterNavigation(t.tab.page);
    } catch (e3) {
      sent = "; но отправить не удалось (" + String((e3 && e3.message) || e3).slice(0, 120) + ")";
    }
  }
  // Страницу показываем только после отправки: там возможен переход.
  const pinfo = args.submit ? await pageInfo(t.tab.page) : null;
  return (
    "OK — поле «" + target.desc + "» заполнено (" + text.length + " символов, способ: " + via + sent + ")." +
    (pinfo ? "\nСтраница: " + (pinfo.title ? "«" + pinfo.title + "» — " : "") + (pinfo.url || "—") : "")
  );
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
  const findStart = Date.now();
  const target = await resolveTarget(t.tab.page, q, "click", { timeout: args.timeout });
  if (!target) {
    return missText(
      t.tab.page,
      "browserClick",
      q,
      "элемент не найден (ждал " + Math.round((Date.now() - findStart) / 1000) + " с)"
    );
  }
  const pagesBefore = await pageCount();
  try { await target.loc.scrollIntoViewIfNeeded({ timeout: 3000 }); } catch {}
  // Клик не сдаётся с первого раза: если элемент перекрыт слоем (диалог, баннер,
  // окно перевода) — повторяем силой, затем из DOM, затем мышью по координатам.
  // Разница принципиальная: раньше агент получал «перекрыт» и упирался.
  let via = "";
  let blocker = "";
  const firstErr = await (async () => {
    try {
      await target.loc.click({ timeout: ACTION_TIMEOUT });
      via = "обычный клик";
      return "";
    } catch (e) {
      return (e && e.message) || String(e);
    }
  })();
  if (!via) {
    try {
      await target.loc.click({ timeout: ACTION_TIMEOUT, force: true });
      via = "force-клик (проверка «под курсором» пропущена)";
      blocker = await describeInterceptor(t.tab.page, target.loc);
    } catch (e2) {}
  }
  if (!via) {
    try {
      const l = typeof target.loc.first === "function" ? target.loc.first() : target.loc;
      await l.evaluate((el) => el.click());
      via = "клик из DOM (el.click())";
      blocker = await describeInterceptor(t.tab.page, target.loc);
    } catch (e3) {}
  }
  if (!via) {
    const box = await boxOf(target.loc);
    if (box) {
      try {
        await t.tab.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        via = "клик мышью по координатам центра";
      } catch (e4) {}
    }
  }
  if (!via) {
    const msg = /intercepts pointer events/i.test(firstErr)
      ? "элемент перекрыт другим слоем (диалог, баннер, окно перевода)"
      : String(firstErr || "не удалось").slice(0, 160);
    return (
      "Ошибка browserClick («" + target.desc + "»): " + msg + ".\n" +
      (await missText(t.tab.page, "browserClick", q, msg))
    );
  }
  if (args.waitLoad !== false) await afterNavigation(t.tab.page);
  // Ссылка с target=_blank открывает НОВУЮ вкладку — подхватываем её и делаем
  // активной, иначе агент продолжит работать в старой и решит, что клик не сработал.
  const opened = await adoptNewPages(pagesBefore);
  const info = await pageInfo(t.tab.page);
  let out = "OK — клик по «" + target.desc + "» (" + via + "). Текущий URL: " + (info.url || "—");
  if (opened.length) out += "\nОткрылась новая вкладка: " + opened.join(", ") + " — она стала активной.";
  if (blocker) {
    out +=
      "\nВнимание: элемент был перекрыт слоем (" + blocker + "). Если действие не сработало — " +
      "посмотри слои через browserOverlays и убери помеху (browserOverlays { dismiss: true }).";
  }
  return out;
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

// Скриншот страницы: сохраняем PNG В ФАЙЛ (data URL в контекст агента — это
// десятки тысяч токенов на один вызов) и возвращаем путь. Файл можно отдать
// vision-модели через analyzeImage или показать пользователю.
async function screenshotFile(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return { error: t.error };
  let buf;
  try {
    buf = await t.tab.page.screenshot({ type: "png", fullPage: args.fullPage === true });
  } catch (e) {
    return { error: "Ошибка browserScreenshot: " + String((e && e.message) || "").slice(0, 200) };
  }
  const dir = String(args.dir || path.join(os.tmpdir(), "ai-agent-shots"));
  let file = "";
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, "browser-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png");
    fs.writeFileSync(file, buf);
  } catch (e) {
    file = "";
  }
  const info = await pageInfo(t.tab.page);
  return { buf: buf, path: file, url: info.url, title: info.title };
}

// Текстовый ответ для агента: путь к файлу (data URL — только если попросили явно).
async function screenshot(args) {
  args = args || {};
  const r = await screenshotFile(args);
  if (r.error) return r.error;
  if (args.dataUrl === true || args.asDataUrl === true) {
    return "data:image/png;base64," + r.buf.toString("base64");
  }
  if (r.path) {
    return (
      "OK — скриншот сохранён в файл: " + r.path +
      "\nСтраница: " + (r.url || "—") + (r.title ? " («" + r.title + "»)" : "") +
      "\nДальше: analyzeImage { path: \"" + r.path + "\" } — разбор vision-моделью (если она настроена), " +
      "или работай по DOM: browserSnapshot / browserDOM / browserEval."
    );
  }
  return "data:image/png;base64," + r.buf.toString("base64");
}

// ── Инструменты поверх стандартных ─────────────────────────────────────────

// Выполнить JS на странице и вернуть результат. Самый надёжный путь через любые
// слои: перекрытый чекбокс, кнопка в диалоге, значение из JS-состояния страницы.
async function evalJs(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const script = String(args.script || args.code || args.js || "").trim();
  if (!script) {
    return (
      'Ошибка browserEval: укажи script — выражение или код на JS. Примеры: ' +
      '"document.querySelector(\'input[type=checkbox]\').click()", "document.title", ' +
      '"Array.from(document.querySelectorAll(\'[role=dialog] button\')).map(b=>b.innerText)"'
    );
  }
  const max = Math.min(Math.max(parseInt(args.maxChars, 10) || 2000, 200), 20000);
  // Голое выражение оборачиваем в return, код со своими return выполняем как есть.
  const withReturn = /\breturn\b/.test(script);
  let value;
  let err = "";
  try {
    value = await t.tab.page.evaluate("(async () => {\n" + (withReturn ? script : "return (" + script + ");") + "\n})()");
  } catch (e1) {
    try {
      value = await t.tab.page.evaluate("(async () => {\n" + script + "\n})()");
    } catch (e2) {
      err = String((e2 && e2.message) || e1 || "").slice(0, 300);
    }
  }
  if (err) return "Ошибка browserEval: " + err;
  let text = "";
  try {
    text = value === undefined ? "(выражение ничего не вернуло)" : typeof value === "string" ? value : JSON.stringify(value);
  } catch (e) {
    text = String(value);
  }
  if (text == null) text = "(выражение ничего не вернуло)";
  const shown = text.length > max ? text.slice(0, max) + "\n… [обрезано, всего " + text.length + " символов]" : text;
  const info = await pageInfo(t.tab.page);
  return "browserEval выполнен. URL: " + (info.url || "—") + "\nРезультат: " + shown;
}

// HTML вокруг селектора (или ref из карты) — чтобы понять структуру незнакомого
// слоя: имена классов диалога, aria-атрибуты, вложенность.
async function domHtml(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const ref = dom.refName(args.ref || args.element);
  const selector = String(args.selector || args.css || "").trim();
  if (!ref && !selector) return "Ошибка browserDOM: укажи selector (CSS) или ref из browserSnapshot.";
  const sel = ref ? dom.refSelector(ref) : selector;
  const max = Math.min(Math.max(parseInt(args.limit, 10) || 3000, 300), 30000);
  let res;
  try {
    res = await t.tab.page.evaluate(({ sel, max }) => {
      // Ищем и в обычном дереве, и в shadow-root'ах веб-компонентов.
      const deepFind = (s) => {
        let direct = null;
        try { direct = document.querySelector(s); } catch (e) { return null; }
        if (direct) return direct;
        const queue = [document];
        let seen = 0;
        while (queue.length && seen < 4000) {
          const root = queue.shift();
          let all = [];
          try { all = root.querySelectorAll("*"); } catch (e) { all = []; }
          for (let i = 0; i < all.length; i++) {
            seen++;
            const node = all[i];
            if (!node.shadowRoot) continue;
            let hit = null;
            try { hit = node.shadowRoot.querySelector(s); } catch (e) {}
            if (hit) return hit;
            queue.push(node.shadowRoot);
          }
        }
        return null;
      };
      const el = deepFind(sel);
      if (!el) return { found: false };
      const html = el.outerHTML || "";
      let total = 0;
      try { total = document.querySelectorAll(sel).length; } catch (e) { total = 0; }
      return {
        found: true,
        tag: (el.tagName || "").toLowerCase(),
        html: html.slice(0, max),
        full: html.length,
        text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400),
        count: total,
      };
    }, { sel: sel, max: max });
  } catch (e) {
    return "Ошибка browserDOM: " + String((e && e.message) || e).slice(0, 200);
  }
  if (!res || !res.found) {
    return (
      "browserDOM: по «" + sel + "» ничего не нашлось. Проверь селектор через browserSnapshot " +
      "(там ref и классы элементов) или посмотри слои через browserOverlays."
    );
  }
  return (
    "Элемент «" + sel + "» — <" + res.tag + ">, совпадений на странице: " + res.count +
    "\nТекст: " + (res.text || "(пусто)") +
    "\nHTML" + (res.html.length < res.full ? " (обрезано до " + res.html.length + " из " + res.full + " символов)" : "") +
    ":\n" + res.html
  );
}

// Закрыть помехи поверх страницы и/или показать, что там открыто.
// ВАЖНО: юридические согласия (terms of service) молча НЕ подтверждаются —
// инструмент только показывает, какие ref нажать. Явное подтверждение —
// acceptTerms: true (агент вызывает его осознанно, по просьбе пользователя).
async function overlays(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  let map;
  try {
    map = await collectMap(t.tab.page);
  } catch (e) {
    return "Ошибка browserOverlays: " + String((e && e.message) || e).slice(0, 200);
  }
  const found = (map.overlays || []).map((o) => Object.assign({}, o, { kind: overlayKind(o) }));
  let out = "";
  if (found.length) {
    out += "Слоёв поверх страницы: " + found.length + "\n";
    found.forEach((o, i) => {
      const items = overlayItems(map, o.name);
      out +=
        "\n" + (i + 1) + ". " + (OVERLAY_LABEL[o.kind] || OVERLAY_LABEL.dialog) +
        (o.name ? " — «" + o.name + "»" : "") +
        " (" + items.length + " " + (items.length === 1 ? "элемент" : items.length < 5 ? "элемента" : "элементов") + ")" +
        (o.text ? "\n   Текст: «" + o.text.slice(0, 220) + "»" : "");
      if (items.length) {
        out +=
          "\n   Элементы: " +
          items
            .slice(0, 12)
            .map((it) => it.ref + " (" + it.role + (it.name ? " «" + it.name.slice(0, 40) + "»" : "") + (it.hiddenInput ? ", скрытый ввод" : "") + (it.checked ? ", отмечено" : "") + ")")
            .join(", ");
        out += "\n   Действия: " + dom.actionHint(items[0]);
      }
    });
  } else {
    out += "Слоёв поверх страницы не видно.";
  }

  if (args.dismiss) {
    let report = [];
    try {
      report = await t.tab.page.evaluate(cleanupInPage);
    } catch (e) {
      report = [];
    }
    out += "\n\nЗакрытие помех: " + (report && report.length ? report.join("; ") : "нечего закрывать (перевод и баннеры не найдены)");
  }
  if (args.acceptTerms) {
    let report = [];
    try {
      report = await t.tab.page.evaluate(acceptTermsInPage);
    } catch (e) {
      report = [];
    }
    out += "\n\nПодтверждение согласия: " + (report && report.length ? report.join("; ") : "галочка/кнопка согласия не найдены — сделай browserSnapshot и действуй по ref");
  }
  if (found.some((o) => o.kind === "terms") && !args.acceptTerms) {
    out +=
      "\n\nЭто юридическое согласие: сам его не подтверждаю. Если пользователь просил продолжить — " +
      "отметь галочку и нажми кнопку согласия (browserOverlays { acceptTerms: true } либо browserClick по ref), " +
      "затем проверь результат: browserSnapshot.";
  }
  if (found.some((o) => o.kind === "translate")) {
    out += "\n\nОкно перевода Google сдвигает страницу и перехватывает клики — убери его: browserOverlays { dismiss: true }.";
  }
  return out;
}

// Закрыть помехи: окно перевода Google, cookie-баннеры, «Понятно/Dismiss/позже».
// Юридические формулировки («Принять все», «Я согласен») НЕ нажимаются никогда —
// чтобы агент не подписывал за пользователя то, что не просили.
function cleanupInPage() {
  const report = [];
  const hide = (el, why) => {
    try {
      el.style.display = "none";
      el.setAttribute("data-agent-dismissed", "1");
      report.push(why);
    } catch (e) {}
  };
  const tr = document.querySelectorAll(
    "iframe.goog-te-banner-frame,.goog-te-banner-frame,#goog-gt-tt,.goog-te-balloon-frame"
  );
  for (let i = 0; i < tr.length; i++) hide(tr[i], "скрыто: " + (tr[i].tagName || "элемент").toLowerCase() + " перевода");
  try { document.body.style.top = "0"; } catch (e) {}
  const SAFE = [
    "не сейчас", "позже", "закрыть", "понятно", "хорошо", "ок", "пропустить", "больше не показывать",
    "dismiss", "close", "not now", "no thanks", "maybe later", "got it", "ok", "skip",
  ];
  const LAYER =
    ".cdk-overlay-pane,.cdk-overlay-container,[role=dialog],[role=alertdialog],[aria-modal=true]," +
    ".modal,.modal-dialog,.goog-te-banner-frame,#goog-gt-tt,[class*=banner],[class*=cookie],[class*=consent],[class*=notice],[style*=fixed]";
  const nodes = document.querySelectorAll("button,[role=button],a[href],span,div");
  let seen = 0;
  for (let i = 0; i < nodes.length && seen < 500; i++) {
    const el = nodes[i];
    const txt = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!txt || txt.length > 24) continue;
    seen++;
    if (SAFE.indexOf(txt) < 0) continue;
    let host = null;
    try { host = el.closest ? el.closest(LAYER) : null; } catch (e) {}
    if (!host) continue;
    try {
      el.click();
      report.push("нажато «" + txt + "»");
    } catch (e) {}
  }
  const crosses = document.querySelectorAll("[data-dismiss],[aria-label*=закрыть],[class*=close]");
  for (let i = 0; i < crosses.length && i < 6; i++) {
    const el = crosses[i];
    let host = null;
    try { host = el.closest ? el.closest(LAYER) : null; } catch (e) {}
    if (!host) continue;
    try {
      el.click();
      report.push("нажат крестик закрытия");
    } catch (e) {}
  }
  return report;
}

// Подтвердить юридическое согласие: отметить галочки в слое и нажать кнопку
// согласия. Вызывается только осознанно (acceptTerms), сообщение попадает в чат.
function acceptTermsInPage() {
  const report = [];
  const LAYER = ".cdk-overlay-pane,.cdk-overlay-container,[role=dialog],[role=alertdialog],[aria-modal=true],.modal,.modal-dialog";
  const inLayer = (el) => {
    try { return !!(el.closest && el.closest(LAYER)); } catch (e) { return false; }
  };
  const boxes = document.querySelectorAll("input[type=checkbox],[role=checkbox],[role=switch]");
  for (let i = 0; i < boxes.length; i++) {
    const el = boxes[i];
    if (!inLayer(el)) continue;
    const on = el.checked === true || (el.getAttribute && el.getAttribute("aria-checked") === "true");
    if (on) continue;
    try {
      el.click();
      report.push("отмечена галочка");
    } catch (e) {}
  }
  const btns = document.querySelectorAll("button,[role=button],input[type=submit],a[href]");
  for (let i = 0; i < btns.length; i++) {
    const el = btns[i];
    if (!inLayer(el)) continue;
    const txt = String(el.innerText || el.textContent || el.value || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!txt) continue;
    if (txt.indexOf("не соглас") === 0 || txt.indexOf("disagree") === 0) continue;
    const yes =
      txt.indexOf("agree") >= 0 || txt.indexOf("соглас") >= 0 || txt.indexOf("принять") >= 0 ||
      txt.indexOf("продолжить") >= 0 || txt.indexOf("accept") >= 0 || txt.indexOf("continue") >= 0;
    if (!yes) continue;
    try {
      el.click();
      report.push("нажата кнопка «" + txt.slice(0, 40) + "»");
      break;
    } catch (e) {}
  }
  return report;
}

// Координаты элемента — для клика мышью в обход проверки доступности.
async function boxOf(loc) {
  try {
    const l = typeof loc.first === "function" ? loc.first() : loc;
    return await l.boundingBox();
  } catch (e) {
    return null;
  }
}

// Кто перекрывает элемент: настоящий клик мышью попал бы в этот слой. Агенту
// нужен человеческий ответ («div.cdk-overlay-backdrop»), а не «intercepts events».
async function describeInterceptor(page, loc) {
  try {
    const l = typeof loc.first === "function" ? loc.first() : loc;
    const info = await l.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      if (!top || top === el || el.contains(top)) return "";
      let cls = "";
      try { cls = typeof top.className === "string" ? top.className.replace(/\s+/g, ".").slice(0, 60) : ""; } catch (e) {}
      const txt = String(top.innerText || top.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
      return (top.tagName || "").toLowerCase() + (cls ? "." + cls : "") + (txt ? " «" + txt + "»" : "");
    });
    return String(info || "").slice(0, 140);
  } catch (e) {
    return "";
  }
}

// Ждать появления элемента: selector, ref или name/text (та же логика поиска,
 // что у клика — поэтому ожидание можно писать словами, а не селектором).
async function wait(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const q = dom.parseQuery(args);
  // Пауза без элемента: browserWait { ms: 1500 } — иногда нужно просто дать
  // странице дорисоваться, а искать конкретный элемент нечего.
  const pauseMs = parseInt(args.ms != null ? args.ms : args.pause, 10);
  if (!dom.hasQuery(q) && pauseMs > 0) {
    const capped = Math.min(Math.max(pauseMs, 0), 60000);
    await sleep(capped);
    if (args.load) await afterNavigation(t.tab.page);
    const pi = await pageInfo(t.tab.page);
    return "OK — пауза " + capped + " мс. URL: " + (pi.url || "—");
  }
  if (!dom.hasQuery(q)) {
    return "Ошибка browserWait: укажи selector, ref или name/text ожидаемого элемента (или паузу: browserWait { ms: 1500 }).";
  }
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
  let text = dom.formatSnapshot({
    items: map.items,
    url: map.url,
    title: map.title,
    filter: String(args.filter || "").trim(),
    limit: parseInt(args.limit, 10) || 60,
  });
  // Слои бывают без интерактивных элементов (окно перевода — это iframe), поэтому
  // о помехах и о юридических согласиях сообщаем прямо в карте: агент узнаёт об
  // экране до того, как упрётся в него кликом.
  const found = (map.overlays || []).map((o) => Object.assign({}, o, { kind: overlayKind(o) }));
  const noise = found.filter((o) => o.kind === "translate" || o.kind === "cookie" || o.kind === "noise");
  const terms = found.filter((o) => o.kind === "terms");
  if (noise.length) {
    const kinds = [];
    for (const o of noise) if (kinds.indexOf(OVERLAY_LABEL[o.kind]) < 0) kinds.push(OVERLAY_LABEL[o.kind]);
    text +=
      "\n⚠️ Поверх страницы помехи: " + kinds.join(", ") +
      " — убрать одним вызовом: browserOverlays { dismiss: true } (баннер перевода сдвигает страницу и перехватывает клики).";
  }
  if (terms.length) {
    text +=
      "\n⚠️ Открыт экран юридического согласия (" + (terms[0].name ? "«" + terms[0].name + "»" : "terms of service") +
      ") — сам его не подтверждай: сообщи пользователю и пройди по его просьбе (browserOverlays { acceptTerms: true }).";
  }
  return text;
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

// ── Скорость на сложных сайтах: прокрутка, наведение, сеть, ожидание покоя ──
// Всё это агент раньше делал «на ощупь»: элементы были за экраном, меню не
// раскрывались, а после клика он гадал по DOM, что ответил сервер.

const NET_MAX = 200; // кольцевой буфер запросов на вкладку
const NET_STATIC = { image: 1, font: 1, stylesheet: 1, media: 1, script: 1, other: 1 };

// Состояние прокрутки страницы и её внутренних контейнеров: SPA часто скроллят
// не body, а собственный блок — без этого «прокрутил, а ничего не сдвинулось».
function scrollStateInPage() {
  const de = document.scrollingElement || document.documentElement;
  const inner = [];
  const nodes = document.querySelectorAll("div,ul,ol,section,main,article,table,tbody,aside,nav");
  for (let i = 0; i < nodes.length && inner.length < 3; i++) {
    const el = nodes[i];
    const st = getComputedStyle(el);
    if ((st.overflowY === "auto" || st.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 40) {
      inner.push({
        cls: String(el.className || "").replace(/\s+/g, ".").slice(0, 40),
        top: Math.round(el.scrollTop),
        max: Math.round(el.scrollHeight - el.clientHeight),
      });
    }
  }
  const vh = window.innerHeight || 800;
  return {
    y: Math.round(window.scrollY || de.scrollTop || 0),
    max: Math.round(Math.max(0, de.scrollHeight - vh)),
    vh: vh,
    docH: Math.round(de.scrollHeight),
    inner: inner,
  };
}

// Прокрутить страницу (или самый большой внутренний контейнер, если body не скроллится).
function scrollPageInPage(a) {
  a = a || {};
  const dy = Math.round(Number(a.dy) || 0);
  const dx = Math.round(Number(a.dx) || 0);
  const how = String(a.how || "down");
  const de = document.scrollingElement || document.documentElement;
  const vh = window.innerHeight || 800;
  const pickBiggest = () => {
    let best = null;
    let bestRoom = 0;
    const nodes = document.querySelectorAll("div,ul,ol,section,main,article,table,tbody,aside");
    for (const el of nodes) {
      const st = getComputedStyle(el);
      if ((st.overflowY === "auto" || st.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 40) {
        const room = el.scrollHeight - el.clientHeight;
        if (room > bestRoom) { bestRoom = room; best = el; }
      }
    }
    return best;
  };
  const useWindow = !!de && de.scrollHeight > vh + 4;
  const box = useWindow ? de : pickBiggest();
  if (!box) return { moved: 0, mode: "прокрутки нет", y: 0, max: 0 };
  const isWin = box === de;
  const before = isWin ? window.scrollY || de.scrollTop : box.scrollTop;
  if (how === "top") {
    if (isWin) window.scrollTo(window.scrollX || 0, 0);
    else box.scrollTop = 0;
  } else if (how === "bottom") {
    if (isWin) window.scrollTo(window.scrollX || 0, de.scrollHeight);
    else box.scrollTop = box.scrollHeight;
  } else if (isWin) {
    window.scrollBy(dx, dy);
  } else {
    box.scrollTop = Math.max(0, box.scrollTop + dy);
    if (dx) box.scrollLeft = Math.max(0, box.scrollLeft + dx);
  }
  const after = isWin ? window.scrollY || de.scrollTop : box.scrollTop;
  return {
    moved: Math.round(after - before),
    mode: isWin ? "страница" : "внутренний контейнер",
    y: Math.round(after),
    max: Math.round(isWin ? Math.max(0, de.scrollHeight - vh) : box.scrollHeight - box.clientHeight),
  };
}

// Прокрутить сам элемент (или ближайший прокручиваемый родитель) — списки,
// выпадающие меню и таблицы со своим скроллом.
function scrollInnerInPage(a) {
  a = a || {};
  const el = a.self;
  if (!el) return { moved: 0, mode: "элемент не найден", y: 0, max: 0 };
  const dy = Math.round(Number(a.dy) || 0);
  const how = String(a.how || "down");
  const scrollable = (n) => {
    const st = getComputedStyle(n);
    return (st.overflowY === "auto" || st.overflowY === "scroll") && n.scrollHeight > n.clientHeight + 4;
  };
  let box = el;
  while (box && box !== document.body && box !== document.documentElement && !scrollable(box)) box = box.parentElement;
  if (!box || box === document.body || box === document.documentElement) box = el;
  const before = box.scrollTop;
  if (how === "top") box.scrollTop = 0;
  else if (how === "bottom") box.scrollTop = box.scrollHeight;
  else box.scrollTop = Math.max(0, box.scrollTop + dy);
  return {
    moved: Math.round(box.scrollTop - before),
    mode: "контейнер",
    y: Math.round(box.scrollTop),
    max: Math.round(Math.max(0, box.scrollHeight - box.clientHeight)),
  };
}

// Наведение «по-настоящему»: hover ломается на перекрытых элементах, тогда
// события мыши шлём прямо в DOM (меню и тултипы раскрываются и так).
function hoverInPage(el) {
  if (!el) return false;
  for (const type of ["pointerover", "mouseover", "mouseenter", "mousemove"]) {
    try {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    } catch (e) {}
  }
  return true;
}

// Счётчики покоя: мутации DOM + запросы в полёте (ждут waitForIdle).
function idleStartInPage() {
  window.__aiIdle = window.__aiIdle || { mut: 0 };
  window.__aiIdle.mut = 0;
  try { if (window.__aiIdleObs) window.__aiIdleObs.disconnect(); } catch (e) {}
  const root = document.documentElement || document.body;
  window.__aiIdleObs = new MutationObserver(() => { window.__aiIdle.mut++; });
  if (root) {
    window.__aiIdleObs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  }
  return true;
}

function idleTakeInPage() {
  const s = window.__aiIdle || { mut: 0 };
  const m = s.mut;
  s.mut = 0;
  return m;
}

function idleStopInPage() {
  try { if (window.__aiIdleObs) window.__aiIdleObs.disconnect(); } catch (e) {}
  window.__aiIdleObs = null;
  return true;
}

function posLine(st) {
  const st1 = st || {};
  const max = Number(st1.max) || 0;
  const y = Number(st1.y) || 0;
  const percent = max > 0 ? Math.round((y / max) * 100) : 100;
  let out = "Прокрутка: " + y + " из " + max + " (" + percent + "%)";
  if (Array.isArray(st1.inner) && st1.inner.length) {
    out += ". Со своим скроллом: " + st1.inner.map((i) => "«" + (i.cls || "блок") + "» " + i.top + "/" + i.max).join(", ");
  }
  if (max > 0 && y >= max - 2) out += ". Это низ — ниже ничего нет.";
  return out;
}

// Что видно в кадре СЕЙЧАС: с ref, чтобы сразу кликать без повторной карты.
async function revealText(page, limit) {
  const map = await collectMap(page);
  const shown = map.items.filter((it) => it.inViewport && !it.inDialog);
  const off = map.items.filter((it) => !it.inViewport).length;
  const text = dom.formatSnapshot({
    items: shown,
    url: map.url,
    title: map.title,
    filter: "",
    limit: Math.min(Math.max(parseInt(limit, 10) || 10, 3), 30),
  });
  return text + (off ? "\n(вне экрана ещё " + off + " — прокрути browserScroll или ищи по имени)" : "");
}

// Имена интерактивных элементов страницы — для сравнения «что появилось после наведения».
async function namesOnPage(page) {
  try {
    const map = await collectMap(page);
    return map.items.map((it) => it.role + " «" + it.name + "»");
  } catch (e) {
    return [];
  }
}

// {"click":"Войти"} или {ref:"e2"} или CSS — приводим к виду, понятному поиску.
function queryFromSpec(spec) {
  const s = String(spec == null ? "" : spec).trim();
  if (!s) return null;
  if (/^e\d+$/i.test(s)) return { ref: s };
  if (/^[#.\[]/.test(s)) return { selector: s };
  if (/^text=|^xpath=/i.test(s)) return { selector: s };
  return { name: s, text: s };
}

async function wheelAt(page, dx, dy, times, box) {
  let vp = null;
  try { vp = page.viewportSize ? page.viewportSize() : null; } catch (e) { vp = null; }
  const w = (vp && vp.width) || 1024;
  const h = (vp && vp.height) || 768;
  const cx = box ? Math.round(box.x + box.width / 2) : Math.round(w / 2);
  const cy = box ? Math.round(box.y + box.height / 2) : Math.round(h / 2);
  try { if (page.mouse && page.mouse.move) await page.mouse.move(cx, cy); } catch (e) {}
  if (!page.mouse || !page.mouse.wheel) return { ok: false };
  for (let i = 0; i < times; i++) {
    try {
      await page.mouse.wheel(dx, dy);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 140) };
    }
    await sleep(200);
  }
  return { ok: true };
}

// browserScroll: страница, внутренние контейнеры, «до элемента» (+ что появилось в кадре).
async function scroll(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const page = t.tab.page;

  // «Прокрути до элемента»: ищем так же, как для клика (ref/имя/селектор, фреймы).
  const toSpec = args.to != null ? args.to : args.toText != null ? args.toText : null;
  if (toSpec != null && String(toSpec).trim()) {
    const q = queryFromSpec(toSpec);
    const target = await resolveTarget(page, q, "click");
    if (!target) return missText(page, "browserScroll", q, "не нашёл элемент для прокрутки");
    if (target.error) return target.error;
    try {
      await target.loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT });
    } catch (e) {
      try { await target.loc.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" })); } catch (e2) {}
    }
    await sleep(150);
    const st = await page.evaluate(scrollStateInPage).catch(() => ({}));
    return (
      "OK — прокрутил до «" + target.desc + "»" + ".\n" +
      posLine(st) + "\n" + (await revealText(page, args.limit))
    );
  }

  const how = String(args.how || args.direction || (Number(args.by || args.dy) < 0 ? "up" : "down")).toLowerCase();
  const times = Math.max(1, Math.min(parseInt(args.times, 10) || 1, 20));
  const stBefore = await page.evaluate(scrollStateInPage).catch(() => ({}));
  const vh = Number(stBefore && stBefore.vh) || 800;
  const step = Math.round(Number(args.by != null ? args.by : args.dy) || Math.round(vh * 0.8));

  // Контейнер (список API, таблица, выпадающее меню): крутим его, а не страницу.
  if (args.container) {
    const cq = queryFromSpec(args.container);
    const box = cq ? await resolveTarget(page, cq, "click") : { error: "укажи container — имя, ref или селектор" };
    if (box.error) return box.error;
    const rect = await boxOf(box.loc);
    const wheel = await wheelAt(page, 0, how === "up" ? -step : step, times, rect || null);
    let res = null;
    if (!wheel.ok || wheel.error) {
      res = await box.loc.evaluate(scrollInnerInPage, { dy: how === "up" ? -step : step, how: how === "top" || how === "bottom" ? how : "down" }).catch(() => null);
    }
    const st = await page.evaluate(scrollStateInPage).catch(() => ({}));
    return (
      "OK — прокрутил контейнер «" + box.desc + "» " + how +
      (wheel.error ? " (колесо не сработало: " + wheel.error + ")" : "") +
      (res ? " → " + res.mode + " " + res.y + "/" + res.max : "") +
      ".\n" + posLine(st) + "\n" + (await revealText(page, args.limit))
    );
  }

  // Страница: сначала честное колесо мыши (ленивые ленты и SPA реагируют именно на него).
  const dy = how === "top" ? 0 : how === "bottom" ? 0 : how === "up" ? -step : step;
  const wheel = await wheelAt(page, Number(args.dx) || 0, dy * times, 1, null);
  let inPage = null;
  if (how === "top" || how === "bottom") {
    inPage = await page.evaluate(scrollPageInPage, { how: how, dx: Number(args.dx) || 0, dy: 0 }).catch(() => null);
  }
  const st = await page.evaluate(scrollStateInPage).catch(() => ({}));
  const moved = Number(st.y || 0) - Number(stBefore.y || 0);
  if (!how.match(/^(top|bottom)$/) && Math.abs(moved) < 2) {
    // Колесо не сдвинуло страницу (SPA со своим скроллом) — прокручиваем программно.
    inPage = await page.evaluate(scrollPageInPage, { how: "down", dy: dy * times, dx: Number(args.dx) || 0 }).catch(() => null);
  }
  const stAfter = await page.evaluate(scrollStateInPage).catch(() => st);
  let out =
    "OK — прокрутил " + how + (times > 1 ? " ×" + times : "") + " (" + step + "px за раз" +
    (wheel.error ? ", колесо не сработало: " + wheel.error : "") + ").\n" + posLine(stAfter);
  if (inPage && inPage.mode) out += "\nРежим: " + inPage.mode + " (сдвинуто " + inPage.moved + "px)";
  if (how !== "top" && how !== "bottom" && Math.abs(Number(stAfter.y || 0) - Number(stBefore.y || 0)) < 2) {
    out += "\n⚠️ Страница не сдвинулась: похоже, прокручивается внутренний контейнер — укажи его: browserScroll { container: \"список\" }";
  }
  out += "\n" + (await revealText(page, args.limit));
  return out;
}

// browserHover: навести мышь (меню и подсказки, которые раскрываются по hover).
async function hover(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const page = t.tab.page;
  const before = await namesOnPage(page);
  const target = await resolveTarget(page, dom.parseQuery(args), "click");
  if (target.error) return target.error;
  let how = "";
  try {
    await target.loc.hover({ timeout: ACTION_TIMEOUT });
    how = "мышью";
  } catch (e) {
    try {
      await target.loc.hover({ force: true, timeout: ACTION_TIMEOUT });
      how = "мышью в обход перекрытия";
    } catch (e2) {
      try {
        await target.loc.evaluate(hoverInPage);
        how = "событиями из DOM";
      } catch (e3) {
        return "Ошибка browserHover: " + String((e3 && e3.message) || e3).slice(0, 150);
      }
    }
  }
  await sleep(400);
  const after = await namesOnPage(page);
  const fresh = [];
  for (const n of after) {
    if (before.indexOf(n) < 0 && fresh.indexOf(n) < 0) fresh.push(n);
  }
  let out = "OK — навёл " + how + " на «" + target.desc + "».";
  if (fresh.length) {
    out += "\nПоявилось " + fresh.length + ": " + fresh.slice(0, 8).join(" · ") + "\nДальше: browserSnapshot (ref появившихся пунктов) или browserClick { name: \"…\" }.";
  } else {
    out += "\nНовых элементов не появилось — на этом сайте меню не по наведению. Работай кликом (browserClick) или JS (browserEval).";
  }
  return out;
}

// Записываем сеть вкладки с первого же вызова инструмента: спрашивать «что
// ответил сервер» агент будет ПОСЛЕ действия, задним числом.
const netRecorders = new WeakMap();
function netRecorder(page) {
  const cached = netRecorders.get(page);
  if (cached) return cached;
  const rec = { entries: [], bodies: true };
  netRecorders.set(page, rec);
  const push = (e) => {
    rec.entries.push(e);
    if (rec.entries.length > NET_MAX) rec.entries.shift();
  };
  try {
    page.on("request", (req) => {
      try {
        push({
          method: req.method ? req.method() : "GET",
          url: String(req.url ? req.url() : ""),
          type: req.resourceType ? String(req.resourceType()) : "",
          ts: Date.now(),
        });
      } catch (e) {}
    });
    page.on("response", (res) => {
      try {
        const req = res.request();
        const url = String(req.url());
        const method = req.method ? req.method() : "GET";
        const status = res.status ? res.status() : 0;
        let mime = "";
        try { mime = String(((res.headers && res.headers()) || {})["content-type"] || ""); } catch (e) {}
        let e = null;
        for (let i = rec.entries.length - 1; i >= 0; i--) {
          const x = rec.entries[i];
          if (x.url === url && x.method === method && x.status == null) { e = x; break; }
        }
        if (e) { e.status = status; e.mime = mime; }
        else { e = { method: method, url: url, status: status, mime: mime, ts: Date.now() }; push(e); }
        if (rec.bodies && /json|text|xml|graphql/.test(mime) && !/event-stream/.test(mime)) {
          Promise.resolve(res.text()).then((txt) => {
            if (e && txt) e.body = String(txt).slice(0, 4000);
          }).catch(() => {});
        }
      } catch (e) {}
    });
  } catch (e) {}
  return rec;
}

// browserNetwork: что страница реально отправила и что вернул сервер.
async function network(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const rec = netRecorder(t.tab.page);
  if (args.bodies === false) rec.bodies = false;
  const all = rec.entries.slice();
  if (args.clear === true && args.since !== true) {
    rec.entries.length = 0;
    return "OK — сетевой журнал очищен (было " + all.length + " запросов).";
  }
  // По умолчанию отдаём НОВОЕ и очищаем буфер: агент спрашивает сразу после действия.
  const list = args.since === false ? all : all;
  if (args.since !== false) rec.entries.length = 0;
  const filter = String(args.filter || args.q || "").trim().toLowerCase();
  const rows = [];
  for (const e of list) {
    if (!args.all && NET_STATIC[e.type]) continue;
    if (filter && e.url.toLowerCase().indexOf(filter) < 0) continue;
    rows.push(e);
  }
  if (!rows.length) {
    return (
      "browserNetwork: новых запросов нет" + (list.length ? " (в журнале " + list.length + ", отсеял статику и фильтр)" : "") +
      ". Если действие должно было обратиться к серверу — возможно, оно не сработало: проверь browserSnapshot/browserText."
    );
  }
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 60);
  const shown = rows.slice(-limit);
  const bad = shown.filter((e) => e.status >= 400 || e.status === 0).length;
  const out = [
    "browserNetwork: запросов " + rows.length + (bad ? ", с ошибкой: " + bad : "") + (rows.length > shown.length ? " (показаны последние " + shown.length + ")" : ""),
  ];
  shown.forEach((e, i) => {
    const st = e.status == null ? "…" : e.status;
    const mime = String(e.mime || "").split(";")[0].slice(0, 24);
    out.push(i + 1 + ". " + e.method + " " + e.url.slice(0, 160) + " → " + st + (mime ? " (" + mime + ")" : "") + (e.status >= 400 || e.status == null ? " ❌" : ""));
    if (e.body) {
      const body = String(e.body).replace(/\s+/g, " ").trim().slice(0, 300);
      out.push("   → " + body);
    }
  });
  if (bad) out.push("Дальше: 4xx/5xx — прочитай тело ответа выше (там обычно причина) или browserEval, чтобы увидеть ошибку в JS-консоли страницы.");
  return out.join("\n");
}

// waitForIdle: дождаться, когда страница «успокоится» (DOM не меняется, сеть пуста) —
// чтобы клик не улетел в элемент, который Angular уже перерисовал.
async function waitForIdle(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const page = t.tab.page;
  const quietMs = Math.min(Math.max(parseInt(args.quietMs, 10) || 500, 100), 5000);
  const timeout = Math.min(Math.max(parseInt(args.timeout, 10) || 8000, 500), 60000);
  await page.evaluate(idleStartInPage).catch(() => null);
  let inflight = 0;
  const onReq = () => { inflight++; };
  const onDone = () => { if (inflight > 0) inflight--; };
  const canListen = typeof page.on === "function";
  if (canListen) {
    try {
      page.on("request", onReq);
      page.on("requestfinished", onDone);
      page.on("requestfailed", onDone);
    } catch (e) {}
  }
  const started = Date.now();
  let mutSeen = 0;
  let quietSince = Date.now();
  while (Date.now() - started < timeout) {
    const mut = await page.evaluate(idleTakeInPage).catch(() => 0);
    mutSeen += Number(mut) || 0;
    if ((Number(mut) || 0) > 0 || inflight > 0) quietSince = Date.now();
    if (Date.now() - quietSince >= quietMs) break;
    await sleep(150);
  }
  if (canListen && typeof page.off === "function") {
    try {
      page.off("request", onReq);
      page.off("requestfinished", onDone);
      page.off("requestfailed", onDone);
    } catch (e) {}
  }
  await page.evaluate(idleStopInPage).catch(() => null);
  const waited = Date.now() - started;
  const stillBusy = inflight > 0;
  return (
    "OK — страница " + (stillBusy ? "всё ещё грузит (" + inflight + " запросов)" : "успокоилась") +
    ": ждал " + waited + " мс, изменений DOM " + mutSeen + ", запросов в полёте " + inflight + "." +
    (stillBusy ? "\nДействуй по тому, что уже видно (browserSnapshot) — или повтори waitForIdle с большим timeout." : "\nТеперь карта (browserSnapshot) не поедет — можно кликать по ref.")
  );
}

module.exports = {
  open,
  snapshot,
  fill,
  click,
  evalJs,
  domHtml,
  overlays,
  act,
  scroll,
  hover,
  network,
  waitForIdle,
  overlayKind,
  overlayItems,
  screenshotFile,
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
  collectMap, // тесты: карта строится на мини-DOM через page.evaluate-заглушку
  cleanupInPage, // тесты: очистка помех не трогает юридические кнопки
  acceptTermsInPage, // тесты: подтверждение согласия отмечает галочку и кнопку
  // тесты: прокрутка и счётчики покоя на мини-DOM
  scrollStateInPage,
  scrollPageInPage,
  scrollInnerInPage,
  hoverInPage,
  idleStartInPage,
  idleTakeInPage,
  idleStopInPage,
  queryFromSpec,
  setPlaywright, // только для тестов: подменить/сбросить кэш playwright
};