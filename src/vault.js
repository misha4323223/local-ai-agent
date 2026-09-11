"use strict";

/* ── Менеджер паролей сайтов (для агента) ───────────────────────────────────
   Записи живут в settings.sitePasswords и шифруются как остальные секреты
   (secrets.json + Electron safeStorage / Windows DPAPI). Здесь — только чистая
   логика: нормализация списка, поиск записи по сайту, безопасный текст для
   агента и подстановка логина/пароля в форму на странице.

   ГЛАВНОЕ ПРАВИЛО БЕЗОПАСНОСТИ: пароль НИКОГДА не попадает в текст ответа
   инструмента (а значит и в чат, в историю и в контекст модели). Наружу уходят
   только название сайта, адрес и логин. Пароль передаётся напрямую в браузер
   (bt.fill) и больше никуда.

   Модуль не требует electron и не читает диск — браузерные примитивы
   передаются аргументом (bt), поэтому всё покрывается тестами в plain node.
*/

const MAX_ENTRIES = 100; // защита от бесконечного списка
const MAX_NAME = 80;
const MAX_URL = 300;
const MAX_LOGIN = 200;
const MAX_PASSWORD = 400;
const MAX_NOTE = 300;

// Кандидаты селекторов полей входа. Первое совпавшее поле выигрывает —
// Playwright принимает список селекторов через запятую и берёт первый найденный.
const LOGIN_SELECTOR = [
  'input[autocomplete="username"]',
  'input[name="username" i]',
  'input[name="login" i]',
  'input[name="email" i]',
  'input[name="phone" i]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[type="text"]',
].join(", ");
const PASSWORD_SELECTOR = 'input[type="password"]';

// Обрезает значение и убирает переводы строк (для полей записи).
function clip(v, max) {
  return String(v == null ? "" : v)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

// Пароль: сохраняем символы КАК ЕСТЬ (пробелы внутри могут быть частью пароля),
// убираем только переводы строк — частая беда при вставке из буфера/файла.
function clipSecret(v, max) {
  return String(v == null ? "" : v)
    .replace(/[\r\n]+/g, "")
    .slice(0, max);
}

function makeId() {
  return "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Хост сайта: https://vk.com/im?x=1 → vk.com (для сопоставления записи с URL).
function hostOf(v) {
  let s = clip(v, MAX_URL).toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z]+:\/\//, ""); // протокол
  s = s.replace(/^www\./, "");
  s = s.split("/")[0].split("?")[0].split("#")[0];
  s = s.replace(/:\d+$/, ""); // порт
  return s;
}

// Одна запись: { id, name, url, login, password, note } или null, если мусор.
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = clip(raw.name, MAX_NAME);
  const url = clip(raw.url, MAX_URL);
  const login = clip(raw.login, MAX_LOGIN);
  const password = clipSecret(raw.password, MAX_PASSWORD);
  const note = clip(raw.note, MAX_NOTE);
  // Запись без названия и без адреса бесполезна — её некуда привязать.
  if (!name && !url) return null;
  return {
    id: clip(raw.id, 40) || makeId(),
    name: name || hostOf(url) || "Сайт",
    url,
    login,
    password,
    note,
  };
}

// Список записей: чистка мусора, дедупликация по id, ограничение размера.
function sanitizeList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const e = normalizeEntry(raw);
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

// Поиск записи по названию сайта или адресу (регистр не важен).
// Порядок: точное имя → точный хост → вхождение имени/хоста.
function findEntry(list, query) {
  const entries = sanitizeList(list);
  const q = clip(query, MAX_URL).toLowerCase();
  if (!q) return null;
  const qHost = hostOf(q);
  let soft = null;
  for (const e of entries) {
    const nm = e.name.toLowerCase();
    const eh = hostOf(e.url);
    if (nm === q) return e; // «ВК» → «ВК»
    if (qHost && eh && eh === qHost) return e; // «https://vk.com/login» → vk.com
    if (!soft) {
      if (nm && (nm.includes(q) || q.includes(nm))) soft = e;
      else if (eh && (eh.includes(qHost || q) || (qHost && qHost.includes(eh)))) soft = e;
    }
  }
  return soft;
}

// Подпись записи для интерфейса и текстов: «ВК — vk.com (логин: +7…)».
function label(e) {
  if (!e) return "";
  const parts = [e.name || hostOf(e.url) || "Сайт"];
  if (e.url) parts.push(e.url);
  if (e.login) parts.push("логин: " + e.login);
  return parts.join(" — ");
}

// Текст для агента. ПАРОЛИ ЗДЕСЬ НЕ ВЫВОДЯТСЯ НИКОГДА (только «сохранён/нет»).
function listText(list) {
  const entries = sanitizeList(list);
  if (!entries.length) {
    return (
      "Сохранённых паролей нет. Варианты: 1) попроси пользователя войти на сайт руками в открытом окне браузера " +
      "(постоянный профиль запомнит сессию, и пароль больше не понадобится); 2) предложи добавить запись в " +
      "Настройках → 🔒 Секреты → «Пароли сайтов»."
    );
  }
  const rows = entries.map((e) => {
    const bits = ["- " + (e.name || hostOf(e.url) || "Сайт")];
    if (e.url) bits.push("адрес: " + e.url);
    bits.push("логин: " + (e.login || "не сохранён"));
    bits.push("пароль: " + (e.password ? "сохранён" : "не сохранён"));
    if (e.note) bits.push("заметка: " + e.note);
    return bits.join(" · ");
  });
  return (
    "Сохранённые сайты (" + rows.length + "). Пароли не показываются — подставляй их инструментом vaultFill:\n" +
    rows.join("\n")
  );
}

// Понятное сообщение, когда запись не нашлась.
function notFoundText(list, query) {
  const entries = sanitizeList(list);
  const names = entries.map((e) => e.name || hostOf(e.url)).filter(Boolean);
  return (
    "В менеджере паролей нет записи для «" + clip(query, 60) + "». " +
    (names.length ? "Есть: " + names.join(", ") + ". " : "") +
    "Спроси пользователя через askUser, какой сайт использовать, или попроси войти руками в окне браузера — " +
    "постоянный профиль запомнит сессию."
  );
}

// Подстановка логина и пароля в форму на открытой странице.
// bt — модуль browser-tools (fill/press/click); передаётся, чтобы логика тестировалась.
// opts: { loginSelector, passwordSelector, submit, tabId }
async function fillLogin(entry, opts, bt) {
  opts = opts || {};
  if (!entry) return "Нет записи для этого сайта.";
  if (!bt || typeof bt.fill !== "function") return "Браузер агента недоступен — заполнить форму нельзя.";
  const name = entry.name || hostOf(entry.url) || "сайт";
  const loginSel = clip(opts.loginSelector, MAX_URL) || LOGIN_SELECTOR;
  const passSel = clip(opts.passwordSelector, MAX_URL) || PASSWORD_SELECTOR;

  if (!entry.login) {
    return (
      "Для «" + name + "» сохранён только пароль без логина — заполнить форму автоматически не получится. " +
      "Попроси пользователя добавить логин в Настройках → 🔒 Секреты → «Пароли сайтов»."
    );
  }

  const rl = await bt.fill({ selector: loginSel, text: entry.login, tabId: opts.tabId });
  if (/^Ошибка/.test(String(rl || ""))) {
    return "Не удалось заполнить поле логина для «" + name + "»: " + String(rl).slice(0, 200);
  }
  if (!entry.password) {
    return (
      "Логин для «" + name + "» заполнен (" + entry.login + "). Пароль не сохранён — попроси пользователя ввести его " +
      "в открытом окне браузера (сессия сохранится в постоянном профиле)."
    );
  }

  const rp = await bt.fill({ selector: passSel, text: entry.password, tabId: opts.tabId });
  if (/^Ошибка/.test(String(rp || ""))) {
    return (
      "Логин для «" + name + "» заполнен, но поле пароля не найдено. Посмотри страницу через browserText, " +
      "при необходимости передай точный selector поля пароля в passwordSelector — или попроси пользователя ввести пароль вручную."
    );
  }

  let out = "OK — логин и пароль для «" + name + "» подставлены в форму (пароль в чат не выводится).";
  if (opts.submit) {
    const rs = await bt.press({ key: "Enter", tabId: opts.tabId });
    out += /^Ошибка/.test(String(rs || ""))
      ? "\nОтправить форму клавишей Enter не удалось — нажми кнопку входа через browserClick (или попроси пользователя дожать вручную)."
      : "\nФорма отправлена (Enter). Проверь результат через browserText — вошёл ли пользователь.";
  } else {
    out += "\nФорма НЕ отправлена. Проверь поля через browserText и нажми кнопку входа (browserClick) — или передай submit:true.";
  }
  return out;
}

module.exports = {
  MAX_ENTRIES,
  LOGIN_SELECTOR,
  PASSWORD_SELECTOR,
  makeId,
  hostOf,
  normalizeEntry,
  sanitizeList,
  findEntry,
  label,
  listText,
  notFoundText,
  fillLogin,
};
