"use strict";

/* ── Карта интерфейса страницы: чистая логика (без DOM и без playwright) ────
   Задача — чтобы агент «понимал» кнопки и поля, а не перебирал селекторы.
   Здесь всё, что можно проверить тестами без браузера:

     normText / normName     — сравнение имён без регистра, кавычек, «ё» и лишних пробелов;
     roleOf(raw)             — роль элемента (button / link / textbox / checkbox / …);
     accessibleName(raw)     — видимое имя («Войти», «Поиск», «Написать сообщение»);
     isInteractive(raw)      — стоит ли показывать элемент в карте;
     refName(v)              — "12" / "e12" / "#e12" → "e12";
     refSelector(ref)        — "e12" → [data-agent-ref="e12"];
     parseQuery(args, opts)  — разбор аргументов инструмента в один запрос;
     findMatches(items, q)   — похожие элементы (подсказки при промахе вместо перебора);
     formatItem(it)          — одна строка карты;
     formatSnapshot({...})   — текстовая карта для агента;
     suggestText({...})      — «не нашёл, но вот что есть».

   raw-объект элемента — плоский набор полей, который собирает страница
   (см. collectInPage в browser-tools.js): tag, type, roleAttr, contenteditable,
   onclick, tabindex, href, disabled, checked, ariaLabel, labelledby, labelText,
   text, value, placeholder, title, alt, nameAttr, id, cls, inViewport, ref.
*/

const DISPLAY_MAX = 60; // максимум символов в имени элемента
const TEXT_MAX = 160; // сколько текста берём из элемента до обрезки

// Роли, которые имеют смысл для агента (клик / ввод).
const INTERACTIVE_ROLES = {
  button: 1,
  link: 1,
  checkbox: 1,
  radio: 1,
  switch: 1,
  tab: 1,
  menuitem: 1,
  menuitemcheckbox: 1,
  menuitemradio: 1,
  option: 1,
  textbox: 1,
  searchbox: 1,
  combobox: 1,
  slider: 1,
  spinbutton: 1,
  treeitem: 1,
  clickable: 1,
};

const FIELD_ROLES = {
  textbox: 1,
  searchbox: 1,
  combobox: 1,
  slider: 1,
  spinbutton: 1,
};

const INPUT_ROLE = {
  submit: "button",
  button: "button",
  reset: "button",
  image: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  file: "file",
  color: "color",
  hidden: "hidden",
  number: "spinbutton",
  search: "searchbox",
};

const TAG_ROLE = {
  a: "link",
  button: "button",
  select: "combobox",
  textarea: "textbox",
  summary: "button",
  option: "option",
  label: "label",
  form: "form",
  img: "img",
};

const BUTTON_INPUT_TYPES = { submit: 1, button: 1, reset: 1, image: 1 };

// ── Текст ─────────────────────────────────────────────────────────────────

function str(v) {
  return v == null ? "" : String(v);
}

// Нормализация для сравнения: регистр, кавычки, «ё», неразрывные пробелы.
function normText(s) {
  return str(s)
    .replace(/[\u00a0\u2000-\u200b\u202f\u3000]/g, " ")
    .replace(/[«»„“”"'`´]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е");
}

function normName(s) {
  return normText(s);
}

// Текст «как он есть» для показа: без переносов, обрезанный.
function cut(s, max) {
  const t = str(s).replace(/\s+/g, " ").trim();
  const m = max || DISPLAY_MAX;
  if (t.length <= m) return t;
  return t.slice(0, m - 1) + "…";
}

// ── Роль и имя ────────────────────────────────────────────────────────────

function roleOf(raw) {
  const r = raw || {};
  const tag = str(r.tag).toLowerCase();
  const type = str(r.type).toLowerCase();
  if (r.roleAttr) return str(r.roleAttr).toLowerCase();
  if (tag === "input") return INPUT_ROLE[type] || "textbox";
  if (tag === "a") return r.href ? "link" : "generic";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "button" || tag === "summary") return "button";
  if (r.contenteditable) return "textbox";
  if (r.onclick || r.tabindex != null) return "clickable";
  return TAG_ROLE[tag] || "generic";
}

// Доступное имя: порядок как у браузера — labelledby → aria-label → <label> →
// видимый текст / значение кнопки → placeholder → title → alt → name → id.
function accessibleName(raw) {
  const r = raw || {};
  const tag = str(r.tag).toLowerCase();
  const isButtonInput = tag === "input" && !!BUTTON_INPUT_TYPES[str(r.type).toLowerCase()];
  const sources = [
    r.labelledby,
    r.ariaLabel,
    r.labelText,
    isButtonInput ? r.value : "",
    r.text,
    r.placeholder,
    r.title,
    r.alt,
    r.nameAttr,
    r.id,
  ];
  for (const s of sources) {
    const t = cut(s, TEXT_MAX);
    if (t) return cut(t, DISPLAY_MAX);
  }
  return "";
}

function isInteractive(raw) {
  const r = raw || {};
  const tag = str(r.tag).toLowerCase();
  const role = roleOf(r);
  if (role === "hidden" || role === "presentation" || role === "none") return false;
  if (tag === "input" && str(r.type).toLowerCase() === "hidden") return false;
  if (tag === "a") return !!r.href;
  if (tag === "img" || tag === "form" || tag === "label") return false;
  if (tag === "button" || tag === "select" || tag === "textarea" || tag === "summary" || tag === "input") return true;
  if (r.contenteditable) return true;
  if (INTERACTIVE_ROLES[role]) return true;
  if (r.onclick || r.tabindex != null) return !!accessibleName(r);
  return false;
}

// ── ref ───────────────────────────────────────────────────────────────────

// "12" | "e12" | "#e12" | "E12" → "e12"; всё остальное → "" (не ref).
function refName(v) {
  if (v == null) return "";
  const s = str(v).trim();
  if (!s) return "";
  const m = s.match(/^#?e?(\d{1,4})$/i);
  if (m) return "e" + m[1];
  return /^e[0-9a-z]{1,6}$/i.test(s) ? s.toLowerCase() : "";
}

function refSelector(ref) {
  const r = refName(ref);
  return r ? '[data-agent-ref="' + r + '"]' : "";
}

// ── Разбор аргументов инструмента ─────────────────────────────────────────

// Имена и тексты чистим от кавычек-ёлочек: агент часто пишет «Войти», а на
// странице надпись без них (и наоборот). Селекторы НЕ трогаем — это CSS.
function cleanQueryText(s) {
  return str(s)
    .replace(/[«»„“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// forField: true — аргумент text это ЗНАЧЕНИЕ для ввода, а не текст для поиска.
function parseQuery(args, opts) {
  const a = args || {};
  const forField = !!(opts && opts.forField);
  const refSource = a.ref != null ? a.ref : a.element != null ? a.element : a.index;
  return {
    ref: refName(refSource),
    selector: str(a.selector || a.css).trim(),
    role: str(a.role).trim().toLowerCase(),
    name: cleanQueryText(a.name || a.aria),
    label: cleanQueryText(forField ? a.label || a.name : a.label),
    placeholder: forField ? cleanQueryText(a.placeholder) : "",
    text: forField ? "" : cleanQueryText(a.text),
  };
}

function hasQuery(q) {
  const x = q || {};
  return !!(x.ref || x.selector || x.role || x.name || x.label || x.placeholder || x.text);
}

// Что именно искал агент — одной строкой (для сообщений об ошибке).
function queryText(q) {
  const x = q || {};
  if (x.ref) return "ref " + x.ref;
  if (x.selector) return x.selector;
  if (x.role) return "role=" + x.role + (x.name ? ' name="' + x.name + '"' : "");
  if (x.label) return 'label "' + x.label + '"';
  if (x.placeholder) return 'placeholder "' + x.placeholder + '"';
  if (x.name) return '"' + x.name + '"';
  if (x.text) return '"' + x.text + '"';
  return "";
}

// ── Поиск похожих (подсказки вместо перебора) ─────────────────────────────

// Длина общего начала двух строк («секретики» и «секреты» → «секрет», 6).
function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charAt(i) === b.charAt(i)) i++; 
  return i;
}

function nameScore(name, q) {
  const n = normText(name);
  if (!n || !q) return 0;
  if (n === q) return 100;
  // Имя целиком внутри запроса («Войти» ← «войти в аккаунт») — агент дописал лишнее.
  if (n.length >= 3 && q.indexOf(n) >= 0) return 88;
  if (n.indexOf(q) === 0) return 82;
  if (n.split(" ").indexOf(q) >= 0) return 70;
  if (n.indexOf(q) >= 0) return 55;
  // Совпадение по словам: «войти в аккаунт» ↔ «Войти в аккаунт».
  const ntoks = n.split(" ").filter((t) => t.length > 2);
  const qtoks = q.split(" ").filter((t) => t.length > 2);
  if (ntoks.length && qtoks.length) {
    let hit = 0;
    for (const t of qtoks) if (ntoks.indexOf(t) >= 0) hit++;
    if (hit) return 40 + Math.round((hit / qtoks.length) * 20);
  }
  if (qtoks.length > 1 && qtoks.every((t) => n.indexOf(t) >= 0)) return 30;
  // Длинное общее начало — опечатки и словоформы («Секретики» ↔ «Секреты»).
  const plen = commonPrefixLen(n, q);
  if (plen >= 5) return 34 + Math.min(plen, 12);
  return 0;
}

function findMatches(items, query, limit) {
  const q = normText(query);
  if (!q) return [];
  const list = Array.isArray(items) ? items : [];
  const scored = [];
  for (const it of list) {
    if (!it) continue;
    let score = nameScore(it.name, q);
    const role = normText(it.role);
    const ref = normText(it.ref);
    if (ref && ref === q) score = 130;
    if (role) {
      if (role === q) score = Math.max(score, 60);
      else if (role.indexOf(q) >= 0) score = Math.max(score, 40);
    }
    if (!score) continue;
    if (it.inViewport) score += 4;
    if (!it.disabled) score += 2;
    scored.push({ it, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.it.order || 0) - (b.it.order || 0));
  return scored.slice(0, limit || 6).map((s) => s.it);
}

// ── Формат ────────────────────────────────────────────────────────────────

function pad(s, n) {
  const t = str(s);
  return t.length >= n ? t + " " : t + " ".repeat(n - t.length);
}

function formatItem(it) {
  const x = it || {};
  const name = x.name ? "«" + cut(x.name, 46) + "»" : "(без имени)";
  const extra = [];
  if (x.type && x.type !== "text") extra.push(x.type);
  if (x.id) extra.push("#" + x.id);
  if (x.cls) extra.push("." + str(x.cls).split(/\s+/).slice(0, 2).join("."));
  if (!x.name && x.placeholder) extra.push('placeholder="' + cut(x.placeholder, 22) + '"');
  if (x.href) extra.push(cut(str(x.href).replace(/^https?:\/\/[^/]+/, ""), 28));
  const flags = [];
  if (x.disabled) flags.push("недоступно");
  if (x.checked) flags.push("отмечено");
  // Секретные поля (пароли, токены) в карте видны, а значения — нет.
  if (x.secret) flags.push("значение скрыто");
  if (x.inViewport === false) flags.push("вне экрана");
  const tail = [extra.join(" "), flags.length ? "[" + flags.join(", ") + "]" : ""].filter(Boolean).join(" ");
  return " " + pad(x.ref, 5) + pad(x.role, 11) + pad(name, 50) + tail;
}

function matchesFilter(it, f) {
  if (!f) return true;
  const hay = normText(
    [it.ref, it.role, it.name, it.tag, it.type, it.placeholder, it.id, it.cls].join(" ")
  );
  return f
    .split(" ")
    .filter(Boolean)
    .every((t) => hay.indexOf(t) >= 0);
}

// Строка-действие для конкретного элемента: ввод или клик.
function actionHint(it) {
  const x = it || {};
  if (FIELD_ROLES[x.role]) return 'browserFill { ref: "' + x.ref + '", text: "…" }';
  return 'browserClick { ref: "' + x.ref + '" }';
}

function isFieldRole(role) {
  return !!FIELD_ROLES[role];
}

function formatSnapshot(o) {
  const src = o || {};
  const all = Array.isArray(src.items) ? src.items : [];
  const filter = normText(src.filter);
  const limit = Math.max(5, Math.min(parseInt(src.limit, 10) || 60, 200));
  const shown = all.filter((it) => matchesFilter(it, filter));
  const list = shown.slice(0, limit);
  const head =
    "Карта страницы: «" + (cut(src.title, 70) || "без заголовка") + "» — " + str(src.url || "—");
  const count =
    "Интерактивных элементов: " + all.length +
    (filter ? " (по фильтру «" + cut(src.filter, 30) + "» — " + shown.length + ")" : "") +
    (shown.length > list.length ? ", показано " + list.length : "");
  if (!list.length) {
    return (
      head + "\n" + count + "\n\nНичего не найдено." +
      (all.length
        ? "\nПохожих элементов нет — возможно, они вне экрана или страница ещё грузится (browserWait / browserText)."
        : "\nИнтерактивных элементов на странице нет — прочитай её через browserText или сделай browserScreenshot.")
    );
  }
  const lines = list.map(formatItem);
  const offscreen = list.filter((it) => it.inViewport === false).length;
  let out = head + "\n" + count + "\n\n" + lines.join("\n") + "\n\n" +
    'Действия по ref: клик — browserClick { ref: "e2" } · ввод — browserFill { ref: "e4", text: "…" }' +
    (list[0] ? ' · например: ' + actionHint(list[0]) : "");
  if (shown.length > list.length) out += "\nСписок сокращён — уточни через filter («войти», «логин»…).";
  if (offscreen) out += "\nЧасть элементов вне экрана (помечены) — прокрути страницу (browserPress PageDown) и вызови browserSnapshot снова.";
  out += "\nref живут до перезагрузки страницы: после перехода делай browserSnapshot заново.";
  return out;
}

// Сообщение при промахе: что искали + что есть похожего. Главное — кликабельные ref.
// tool — как называется карта в этом инструменте (browserSnapshot / appRead).
function suggestText(o) {
  const src = o || {};
  const items = Array.isArray(src.items) ? src.items : [];
  const tool = str(src.tool) || "browserSnapshot";
  // Внешние кавычки убираем — иначе в тексте получается «"войти"».
  const query = cut(str(src.query).replace(/^["'«„]+/, "").replace(/["'»“]+$/, ""), 40);
  const why = str(src.reason);
  const head = "Не нашёл «" + query + "»" + (why ? " (" + cut(why, 120) + ")" : "") + ".";
  const matches = findMatches(items, query, 8);
  if (matches.length) {
    return (
      head + "\nПохожие элементы (кликай по ref, селекторы перебирать не нужно):\n" +
      matches.map(formatItem).join("\n") +
      "\nДальше: " + actionHint(matches[0]) + " · вся карта — " + tool + "."
    );
  }
  const first = items.slice(0, 14);
  const tail = first.length
    ? "\nЧто вообще есть сейчас:\n" + first.map(formatItem).join("\n")
    : "\nИнтерактивных элементов не видно.";
  return head + tail + "\nВся карта — " + tool + ".";
}

module.exports = {
  DISPLAY_MAX,
  normText,
  normName,
  cleanQueryText,
  commonPrefixLen,
  cut,
  roleOf,
  accessibleName,
  isInteractive,
  refName,
  refSelector,
  parseQuery,
  hasQuery,
  queryText,
  findMatches,
  matchesFilter,
  formatItem,
  formatSnapshot,
  suggestText,
  actionHint,
  isFieldRole,
  FIELD_ROLES,
  INTERACTIVE_ROLES,
};
