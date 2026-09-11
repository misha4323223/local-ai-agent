"use strict";

/* ── Браузерные инструменты агента (Playwright) ─────────────────────────────
   Агент получает ВИДИМОЕ окно Chromium и управляет им через инструменты:
   открыть URL, заполнить поле, кликнуть, выбрать из <select>, нажать клавишу,
   прочитать текст страницы, сделать скриншот, подождать элемент, закрыть вкладку.
   Окно видимое намеренно: пользователь видит, что делает агент, и может
   дожимать руками капчу / 2FA / лишние подтверждения.

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
const { spawn } = require("child_process");

let pw = null; // модуль playwright (лениво)
let browser = null; // экземпляр браузера
let tabs = new Map(); // tabId -> { id, page, openedAt }
let tabSeq = 0;
let activeTabId = null;
let installPromise = null; // один инсталлятор на всё время жизни процесса
let engineName = "";

const ACTION_TIMEOUT = 12000;

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
      const b = await chromium.launch({
        headless: false,
        ...a.opts,
        args: ["--start-maximized", "--disable-infobars"],
      });
      return { ok: true, browser: b, engine: a.name };
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
    const b = await chromium.launch({
      headless: false,
      args: ["--start-maximized", "--disable-infobars"],
    });
    return { ok: true, browser: b, engine: "Chromium (playwright)" };
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
  if (browser && browser.isConnected()) return { ok: true };
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
    wireBrowser();
    return { ok: true };
  }
  if (!r.ok) return { ok: false, message: r.error || "Не удалось запустить браузер" };
  browser = r.browser;
  engineName = r.engine;
  wireBrowser();
  return { ok: true };
}

function wireBrowser() {
  browser.on("disconnected", () => {
    tabs.clear();
    activeTabId = null;
    browser = null;
  });
}

function resolveTab(tabId) {
  if (tabId && tabs.has(String(tabId))) return tabs.get(String(tabId));
  if (activeTabId && tabs.has(activeTabId)) return tabs.get(activeTabId);
  return null;
}

function needTab(tabId) {
  if (!browser || !browser.isConnected()) {
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
  if (!page) page = await browser.newPage();
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

// Заполнить текстовое поле. selector — CSS (#id, .class, input[name=...]), text=..., xpath=...
// Поддержка contenteditable (ВК и другие SPA): если page.fill не сработал —
// клик по полю → очистка (Ctrl+A) → вставка текста через keyboard.insertText,
// которая корректно триггерит события ввода в кастомных редакторах.
async function fill(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const selector = String(args.selector || "").trim();
  const text = String(args.text == null ? "" : args.text);
  if (!selector) return "Ошибка: укажи selector поля";
  let via = "fill";
  let firstErr = "";
  try {
    await t.tab.page.fill(selector, text, { timeout: ACTION_TIMEOUT });
  } catch (e1) {
    firstErr = (e1 && e1.message) || String(e1);
    try {
      const loc = t.tab.page.locator(selector).first();
      await loc.click({ timeout: ACTION_TIMEOUT });
      await t.tab.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A", { timeout: ACTION_TIMEOUT });
      await t.tab.page.keyboard.insertText(text, { timeout: ACTION_TIMEOUT });
      via = "insertText";
    } catch (e2) {
      return "Ошибка browserFill: элемент не найден или недоступен («" + selector + "»). " + ((e2 && e2.message || firstErr || "").slice(0, 250));
    }
  }
  return "OK — поле «" + selector + "» заполнено (" + text.length + " символов, способ: " + via + ").";
}

// Кликнуть по элементу (кнопка, ссылка, чекбокс). При необходимости ждёт загрузки страницы.
async function click(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const selector = String(args.selector || "").trim();
  if (!selector) return "Ошибка: укажи selector элемента";
  try {
    await t.tab.page.click(selector, { timeout: ACTION_TIMEOUT });
  } catch (e) {
    return "Ошибка browserClick: элемент не найден или недоступен («" + selector + "»). " + ((e && e.message || "").slice(0, 200));
  }
  if (args.waitLoad !== false) await afterNavigation(t.tab.page);
  const info = await pageInfo(t.tab.page);
  return "OK — клик по «" + selector + "». Текущий URL: " + (info.url || "—");
}

// Выбрать значение в <select>.
async function select(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const selector = String(args.selector || "").trim();
  const value = args.value == null ? "" : String(args.value);
  if (!selector) return "Ошибка: укажи selector";
  try {
    await t.tab.page.selectOption(selector, value, { timeout: ACTION_TIMEOUT });
    return "OK — в «" + selector + "» выбрано: " + value;
  } catch (e) {
    return "Ошибка browserSelect: «" + selector + "» не найден или вариант «" + value + "» отсутствует. " + ((e && e.message || "").slice(0, 200));
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

// Ждать появления элемента (селектор) на странице.
async function wait(args) {
  args = args || {};
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const selector = String(args.selector || "").trim();
  if (!selector) return "Ошибка: укажи selector";
  const timeout = Math.min(parseInt(args.timeout, 10) || 10000, 60000);
  try {
    await t.tab.page.waitForSelector(selector, { state: "visible", timeout });
    return "OK — элемент «" + selector + "» появился.";
  } catch (e) {
    return "Ошибка browserWait: элемент «" + selector + "» не появился за " + timeout + " мс.";
  }
}

// Закрыть вкладку (по умолчанию активную; "all" — все вкладки и браузер).
async function close(args) {
  args = args || {};
  if (args.tabId === "all" || args.all) {
    const list = Array.from(tabs.values());
    for (const tb of list) { try { await tb.page.close(); } catch {} }
    tabs.clear();
    activeTabId = null;
    if (browser && browser.isConnected()) { try { await browser.close(); } catch {} }
    browser = null;
    return "OK — все вкладки и браузер закрыты.";
  }
  const t = needTab(args.tabId || args.tab);
  if (t.error) return t.error;
  const id = t.tab.id;
  try { await t.tab.page.close(); } catch {}
  tabs.delete(id);
  if (activeTabId === id) activeTabId = tabs.size ? Array.from(tabs.keys()).pop() : null;
  return "OK — вкладка " + id + " закрыта.";
}

// Список открытых вкладок.
async function status() {
  if (!browser || !browser.isConnected()) {
    return "Браузер не запущен. Ни одной вкладки нет. Открой страницу через browserOpen (url).";
  }
  const rows = [];
  for (const [id, tb] of tabs.entries()) {
    const info = await pageInfo(tb.page);
    rows.push((id === activeTabId ? "▶ " : "   ") + id + "  " + (info.title || "").slice(0, 60) + "  " + (info.url || ""));
  }
  if (!rows.length) return "Браузер запущен, вкладок нет. browserOpen (url) — открыть страницу.";
  return "Открытые вкладки (" + rows.length + "), движок: " + engineName + ":\n" + rows.join("\n") +
    "\n\nАктивная — ▶. Для действий в конкретной вкладке передавай tabId.";
}

// Остановить браузер (вызывается при выходе из приложения).
async function stop() {
  if (browser && browser.isConnected()) {
    try { await browser.close(); } catch {}
  }
  browser = null;
  tabs.clear();
  activeTabId = null;
}

module.exports = {
  open,
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
};