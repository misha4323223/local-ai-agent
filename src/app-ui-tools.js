"use strict";

/* ── app-ui-tools.js — управление СОБСТВЕННЫМ окном приложения ─────────────────
   Агент может «ходить» по интерфейсу приложения, в котором живёт (Electron):
   читать карту окна (appRead), кликать (appClick), вводить текст (appFill),
   выбирать из списков (appSelect), жать клавиши (appPress), ждать элемент
   (appWait) и снимать скриншот окна (appScreenshot). Всё выполняется через
   webContents.executeJavaScript — внутри собственного DOM приложения.

   Главное правило: элементы адресуются СТАБИЛЬНЫМ ref (e12), а не номером [N].
   Порядковый номер ломается при любой перерисовке (например, после «↻ обновить»):
   агент кликал «[7]», а на седьмом месте оказывалась другая вкладка. Теперь
   браузер страницы сам вешает элементам data-agent-ref и ref не меняется, пока
   элемент жив; промах возвращает свежую карту с новыми ref (повтор без угадывания).

   Секреты: значения полей НЕ собираются (пароли, токены). Исключение — подписи
   кнопок-<input>, там value и есть надпись. Поля с id/классом вида token/key/pass
   дополнительно помечаются «секретное».

   Безопасность: клики по разрушительным элементам («Удалить», «Очистить чат»,
   «Сбросить», «Отмена изменений») блокируются — и по тексту до клика, и по
   РЕАЛЬНОМУ имени найденного элемента. Работает только в десктоп-приложении. */

const dom = require("./dom-map.js");

// Разрушительные тексты кнопок — кликать по ним агенту запрещено.
const DANGEROUS_TEXT = /удал|очист|сброс|отмен|откат|уничтож|выйти|выход/i;

function looksDangerous(text) {
  return DANGEROUS_TEXT.test(String(text || "").toLowerCase());
}

function blockText(desc) {
  return (
    "⛔ Клик по разрушительному элементу «" + String(desc || "").slice(0, 80) +
    "» заблокирован (удаление/очистка/сброс/отмена изменений). Спроси пользователя через askUser; при подтверждении попроси его нажать самому или используй профильный инструмент агента (writeFile/runCommand/ycDelete…)."
  );
}

function winOk(win) {
  return !!(win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed());
}

async function evalIn(win, code, timeoutMs) {
  if (!winOk(win)) throw new Error("Окно приложения недоступно (запусти desktop-версию).");
  let timer = null;
  try {
    const p = win.webContents.executeJavaScript(code, true);
    const to = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error("Таймаут выполнения в окне приложения")), timeoutMs || 12000);
    });
    return await Promise.race([p, to]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Код, который выполняется ВНУТРИ окна приложения ────────────────────────
// (никаких ссылок наружу — только DOM страницы; тесты подставляют мини-DOM)
const COLLECT_JS = `
const APPSEL = 'button, a, input, select, textarea, summary, [role="button"], [onclick], [tabindex], .chip, .seg, .tab';
const appVis = (el) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const st = getComputedStyle(el);
  if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity || 1) <= 0) return false;
  if (el.closest && el.closest(".hidden")) return false;
  return true;
};
const appName = (el) => String(el.getAttribute("aria-label") || el.innerText || el.placeholder || el.title || "").replace(/\\s+/g, " ").trim();
const appDesc = (el) => {
  const tag = String(el.tagName || "").toLowerCase();
  const type = String(el.getAttribute("type") || "").toLowerCase();
  const isBtn = tag === "input" && (type === "submit" || type === "button" || type === "reset" || type === "image");
  let d = tag + (el.id ? "#" + el.id : "") + " «" + (appName(el) || (isBtn ? String(el.value || "") : "") || "…") + "»";
  if (type === "password" || appIsSecret(el)) d += " (секретное поле, значение скрыто)";
  return d;
};
const appIsSecret = (el) => {
  const t = String(el.getAttribute("type") || "").toLowerCase();
  if (t === "password") return true;
  const idc = String(el.id || "") + " " + String(typeof el.className === "string" ? el.className : "");
  return /pass|secret|token|apikey|api-key|ключ|парол/i.test(idc);
};
const appRoleOk = (el, role) => {
  if (!role) return true;
  const tag = String(el.tagName || "").toLowerCase();
  const ty = String(el.getAttribute("type") || "").toLowerCase();
  const rt = String(el.getAttribute("role") || "").toLowerCase();
  if (role === "button") return rt === "button" || tag === "button" || tag === "summary" || (tag === "input" && (ty === "submit" || ty === "button" || ty === "reset"));
  if (role === "link") return tag === "a" || rt === "link";
  if (role === "textbox") return rt === "textbox" || tag === "textarea" || !!el.isContentEditable || (tag === "input" && ty !== "checkbox" && ty !== "radio" && ty !== "submit" && ty !== "button" && ty !== "hidden" && ty !== "file");
  if (role === "checkbox") return ty === "checkbox" || rt === "checkbox";
  if (role === "radio") return ty === "radio" || rt === "radio";
  if (role === "combobox") return tag === "select" || rt === "combobox";
  return rt === role;
};
const appCollect = () => {
  if (!window.__aiAppRefSeq) window.__aiAppRefSeq = 0;
  const items = [];
  document.querySelectorAll(APPSEL).forEach((el) => {
    if (!appVis(el)) return;
    const tag = String(el.tagName || "").toLowerCase();
    const type = String(el.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && type === "hidden") return;
    let ref = el.getAttribute("data-agent-ref");
    if (!ref) {
      window.__aiAppRefSeq += 1;
      ref = "e" + window.__aiAppRefSeq;
      el.setAttribute("data-agent-ref", ref);
    }
    let labelText = "";
    try {
      if (el.labels && el.labels.length) {
        for (let i = 0; i < el.labels.length; i++) labelText += " " + (el.labels[i].innerText || el.labels[i].textContent || "");
      } else if (el.closest) {
        const p = el.closest("label");
        if (p) labelText = p.innerText || p.textContent || "";
      }
    } catch (e) {}
    const isBtn = tag === "input" && (type === "submit" || type === "button" || type === "reset" || type === "image");
    items.push({
      ref,
      tag,
      type,
      roleAttr: String(el.getAttribute("role") || "").toLowerCase(),
      contenteditable: !!el.isContentEditable,
      onclick: !!el.onclick || !!el.getAttribute("onclick"),
      tabindex: el.getAttribute("tabindex"),
      href: tag === "a" ? String(el.getAttribute("href") || "") : "",
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
      checked: el.checked === true,
      ariaLabel: String(el.getAttribute("aria-label") || ""),
      labelledby: "",
      labelText,
      text: String(el.getAttribute("aria-label") || el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 160),
      // Значения полей не собираем: там бывают токены и пароли.
      value: isBtn ? String(el.value || "") : "",
      placeholder: String(el.getAttribute("placeholder") || ""),
      title: String(el.getAttribute("title") || ""),
      alt: "",
      nameAttr: tag === "input" || tag === "select" || tag === "textarea" ? String(el.getAttribute("name") || "") : "",
      id: String(el.id || ""),
      cls: String(typeof el.className === "string" ? el.className : "").replace(/\\s+/g, " ").trim().slice(0, 80),
      inViewport: true,
      secret: appIsSecret(el),
    });
  });
  const panels = [];
  document.querySelectorAll(".view-header, .side-panel, #sidebar, #project-panel").forEach((el) => {
    if (!appVis(el)) return;
    const cls = typeof el.className === "string" ? el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
    panels.push((el.id ? "#" + el.id : "") + (cls ? "." + cls : "") + " «" + String(el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40) + "»");
  });
  return { title: document.title || "", items, panels };
};
// Поиск цели: ref (стабильный) → selector → текст (точное совпадение важнее вхождения).
// appCollect() в начале — гарантия, что data-agent-ref расставлены (refs не сбрасываются).
const appFind = (q) => {
  appCollect();
  if (q.ref) {
    const byRef = document.querySelector('[data-agent-ref="' + q.ref + '"]');
    if (byRef && appVis(byRef) && appRoleOk(byRef, q.role)) return { el: byRef, how: "ref " + q.ref };
    return { el: null, how: "", stale: true };
  }
  if (q.selector) {
    let bySel = null;
    try { bySel = document.querySelector(q.selector); } catch (e) { bySel = null; }
    if (bySel && appVis(bySel) && appRoleOk(bySel, q.role)) return { el: bySel, how: "селектор " + q.selector };
    return { el: null, how: "" };
  }
  const want = String(q.text || "").toLowerCase();
  // Пустой запрос не должен «находить» первый попавшийся элемент (иначе клик
  // по номеру/пустым аргументам уходил бы в случайную кнопку).
  if (!want) return { el: null, how: "" };
  let exact = null;
  let loose = null;
  document.querySelectorAll(APPSEL).forEach((el) => {
    if (!appVis(el) || !appRoleOk(el, q.role)) return;
    const t = String(el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || "").replace(/\\s+/g, " ").trim().toLowerCase();
    if (!t) return;
    if (t === want && !exact) exact = el;
    else if (!loose && t.indexOf(want) !== -1) loose = el;
  });
  const el = exact || loose;
  return el ? { el, how: "текст «" + q.text + "»" } : { el: null, how: "" };
};
// Клик по позиции — устаревший способ: работает, но предупреждаем (DOM мог перерисоваться).
const appByIndex = (n) => {
  let found = null;
  let i = 0;
  document.querySelectorAll(APPSEL).forEach((el) => {
    if (found || !appVis(el)) return;
    const tag = String(el.tagName || "").toLowerCase();
    const type = String(el.getAttribute("type") || "").toLowerCase();
    if (tag === "input" && type === "hidden") return;
    i += 1;
    if (i === n) found = el;
  });
  return found;
};
`;

function wrap(body) {
  return "(function() {\n" + COLLECT_JS + "\n" + body + "\n})()";
}

// Аргументы → нормализованный запрос (ref/selector/text/role + устаревший index).
// ВАЖНО: index НЕ превращается в ref — это разные вещи. Номер [N] — позиция в
// списке, которая ломается при перерисовке; ref принадлежит элементу и не меняется.
function argsQuery(args) {
  const a = args || {};
  const q = dom.parseQuery({
    ref: a.ref != null ? a.ref : a.element,
    selector: a.selector,
    css: a.css,
    text: a.text,
    name: a.name,
    aria: a.aria,
    label: a.label,
    placeholder: a.placeholder,
    role: a.role,
  });
  const index = parseInt(a.index, 10);
  return {
    q,
    index: Number.isFinite(index) && index > 0 ? index : 0,
    raw: dom.queryText(q) || (Number.isFinite(index) && index > 0 ? "Номер [" + index + "]" : ""),
  };
}

// Сырые элементы окна → карточки для агента (роли/имена считает dom-map).
function mapItems(raw) {
  const out = [];
  let order = 0;
  for (const r of raw || []) {
    if (!dom.isInteractive(r)) continue;
    order += 1;
    out.push({
      ref: r.ref,
      role: dom.roleOf(r),
      name: dom.accessibleName(r),
      tag: r.tag,
      type: r.type,
      id: r.id,
      cls: r.cls,
      placeholder: r.placeholder,
      href: "",
      disabled: !!r.disabled,
      checked: !!r.checked,
      secret: !!r.secret,
      inViewport: true,
      order,
    });
  }
  return out;
}

async function snapshot(win) {
  return await evalIn(win, wrap("return appCollect();"));
}

// Промах: свежая карта окна + похожие элементы с их ref.
async function missText(win, what, query, extra) {
  let snap = { items: [], panels: [], title: "" };
  try {
    snap = await snapshot(win);
  } catch (e) {
    return "Ошибка " + what + ": " + ((e && e.message) || e) + ". Не удалось прочитать окно — проверь состояние через appRead.";
  }
  const items = mapItems(snap.items);
  const head =
    "Ошибка " + what + ":\n" +
    dom.suggestText({
      items,
      query: String(query || ""),
      reason: String(extra || "").slice(0, 140),
      tool: "appRead",
    });
  const rows = items.slice(0, 10).map((it) => "  " + dom.formatItem(it).trim());
  return head + (rows.length ? "\nКлик (и ввод) — по ref из appRead:\n" + rows.join("\n") : "");
}

// ── appRead: карта окна (ref + роль + имя + id/класс) ───────────────────────
async function read(args, win) {
  const snap = await snapshot(win);
  const items = mapItems(snap && snap.items);
  const lines = [];
  lines.push("Окно: " + ((snap && snap.title) || "AI Developer Agent"));
  if (snap && snap.panels && snap.panels.length) lines.push("Видимые панели: " + snap.panels.join(" · "));
  lines.push(
    "Элементы окна (" + items.length + ") — действуй по ref (например e12) или по видимому тексту; " +
      "номер [N] — устаревший способ (ломается при перерисовке):"
  );
  for (const it of items) lines.push("  " + dom.formatItem(it).trim());
  if (!items.length) lines.push("  (интерактивные элементы не найдены)");
  let txt = "";
  try {
    txt = await evalIn(win, "(function(){ return String((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').trim(); })()");
  } catch {}
  const text = String(txt || "").slice(0, 4000);
  lines.push("Текст окна (фрагмент):");
  lines.push(text + (String(txt || "").length > 4000 ? "\n…(обрезано)" : ""));
  return lines.join("\n");
}

// ── appClick: клик по ref / тексту / селектору (номер [N] — с предупреждением)
async function click(args, win) {
  const { q, index, raw } = argsQuery(args);
  if (!dom.hasQuery(q) && !index) {
    return "Ошибка appClick: укажи ref из appRead (ref: \"e12\"), text («Настройки») или selector (#id/.class). Номер [N] тоже принимается, но он ненадёжен при перерисовке окна.";
  }
  if (q.text && looksDangerous(q.text)) return blockText(q.text);
  const body = `
    const q = ${JSON.stringify({ ref: q.ref, selector: q.selector, text: q.text, role: q.role })};
    const bad = new RegExp(${JSON.stringify(DANGEROUS_TEXT.source)}, "i");
    let found = appFind(q);
    let warning = "";
    if (!found.el && ${index} > 0) {
      const byIdx = appByIndex(${index});
      if (byIdx) { found = { el: byIdx, how: "номер [${index}]" }; warning = "Клик выполнен по НОМЕРУ, а не по ref — после перерисовки окна номер может указывать на другой элемент. Возьми ref из appRead."; }
    }
    if (!found.el) {
      const s = appCollect();
      return { ok: false, stale: !!found.stale, items: s.items, panels: s.panels, title: s.title };
    }
    const desc = appDesc(found.el);
    if (bad.test(desc)) return { ok: false, blocked: true, desc };
    found.el.scrollIntoView({ block: "center", inline: "center" });
    found.el.click();
    return { ok: true, how: found.how, desc, warning };
  `;
  const r = await evalIn(win, wrap(body));
  if (!r) return "Ошибка appClick: окно не ответило.";
  if (r.ok) {
    return "OK — клик по " + r.how + ": " + r.desc + "." + (r.warning ? "\n⚠️ " + r.warning : "") + " Проверь результат через appRead.";
  }
  if (r.blocked) return blockText(r.desc);
  return await missText(win, "appClick", raw, r.stale ? "ref устарел (окно перерисовано) — сделай appRead заново" : "элемент не найден");
}

// ── appFill: ввод текста по ref/тексту/селектору (React-controlled инпуты) ──
async function fill(args, win) {
  const a = args || {};
  const value = a.text != null ? String(a.text) : a.value != null ? String(a.value) : "";
  const { q, index, raw } = argsQuery(a);
  if (!dom.hasQuery(q) && !index) {
    return "Ошибка appFill: укажи поле — ref из appRead (ref: \"e4\"), label/placeholder (видимая подпись) или selector (#id).";
  }
  const body = `
    const q = ${JSON.stringify({ ref: q.ref, selector: q.selector, text: q.text || q.label || q.placeholder, role: q.role || "textbox" })};
    const value = ${JSON.stringify(value)};
    let found = appFind(q);
    if (!found.el && ${index} > 0) {
      const byIdx = appByIndex(${index});
      if (byIdx) found = { el: byIdx, how: "номер [${index}]" };
    }
    if (!found.el) {
      const s = appCollect();
      return { ok: false, stale: !!found.stale, items: s.items, panels: s.panels };
    }
    const el = found.el;
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, "value");
      if (d && d.set) d.set.call(el, value); else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      return { ok: false, notField: true, desc: appDesc(el) };
    }
    return { ok: true, desc: appDesc(el), secret: appIsSecret(el), len: value.length };
  `;
  const r = await evalIn(win, wrap(body));
  if (!r) return "Ошибка appFill: окно не ответило.";
  if (r.ok) {
    return (
      "OK — в поле " + r.desc + " введено " +
      (r.secret ? "значение (" + r.len + " символов; поле секретное — в чат не выводим)" : "«" + value.slice(0, 40) + "»") +
      ". Проверь через appRead."
    );
  }
  if (r.notField) return "Ошибка appFill: элемент не является полем ввода: " + r.desc;
  return await missText(win, "appFill", raw, r.stale ? "ref устарел — сделай appRead заново" : "поле не найдено");
}

// ── appSelect: выбор варианта по value или тексту варианта ──────────────────
async function select(args, win) {
  const a = args || {};
  const value = String(a.value || "").trim();
  const text = String(a.text || "").trim();
  const { q, index, raw } = argsQuery(a);
  if (!dom.hasQuery(q) && !index) {
    return "Ошибка appSelect: укажи список — ref из appRead, label или selector; и value (или text варианта).";
  }
  if (!value && !text) return "Ошибка appSelect: укажи value или text варианта.";
  const body = `
    const q = ${JSON.stringify({ ref: q.ref, selector: q.selector, text: q.text || q.label, role: q.role || "combobox" })};
    const wantValue = ${JSON.stringify(value)};
    const wantText = ${JSON.stringify(text.toLowerCase())};
    let found = appFind(q);
    if (!found.el && ${index} > 0) {
      const byIdx = appByIndex(${index});
      if (byIdx) found = { el: byIdx, how: "номер [${index}]" };
    }
    if (!found.el) { const s = appCollect(); return { ok: false, stale: !!found.stale, items: s.items, panels: s.panels }; }
    const el = found.el;
    if (String(el.tagName || "").toLowerCase() !== "select") {
      return { ok: false, notSelect: true, desc: appDesc(el), options: [] };
    }
    const options = Array.prototype.map.call(el.options || [], (o) => o.value + ((o.text || "") && o.text !== o.value ? " («" + o.text + "»)" : "")).slice(0, 20);
    let opt = null;
    if (wantValue) opt = Array.prototype.find.call(el.options, (o) => o.value === wantValue);
    if (!opt && wantText) opt = Array.prototype.find.call(el.options, (o) => String(o.text || "").trim().toLowerCase().indexOf(wantText) !== -1);
    if (!opt) return { ok: false, noOption: true, desc: appDesc(el), options };
    el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, chosen: opt.text || opt.value, desc: appDesc(el) };
  `;
  const r = await evalIn(win, wrap(body));
  if (!r) return "Ошибка appSelect: окно не ответило.";
  if (r.ok) return "OK — в «" + r.desc + "» выбран вариант «" + r.chosen + "». Проверь через appRead.";
  if (r.notSelect) return "Ошибка appSelect: это не список (<select>): " + r.desc;
  if (r.noOption) {
    return (
      "Ошибка appSelect: в «" + r.desc + "» нет варианта «" + (value || text) + "». " +
      (r.options && r.options.length ? "Варианты списка: " + r.options.join(", ") : "Список пуст.")
    );
  }
  return await missText(win, "appSelect", raw, r.stale ? "ref устарел — сделай appRead заново" : "список не найден");
}

// ── appPress: нажатие клавиши (Enter, Escape, Tab, стрелки) ────────────────
async function press(args, win) {
  args = args || {};
  const key = String(args.key || "").trim();
  if (!key) return "Ошибка: укажи key (Enter, Escape, Tab, ArrowDown...).";
  const k = JSON.stringify(key);
  const JS =
    "(function() {\n" +
    `const el = document.activeElement || document.body;
    const opts = { key: ${k}, code: ${k}, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
    return { ok: true, target: el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") };
  })()`;
  const r = await evalIn(win, JS);
  if (!r || !r.ok) return "Ошибка appPress: не удалось нажать клавишу";
  return "OK — нажата клавиша " + key + " (фокус: " + r.target + "). Проверь через appRead.";
}

// ── appWait: ожидание элемента (ref, текст или селектор) ───────────────────
async function wait(args, win) {
  const { q, raw } = argsQuery(args);
  if (!dom.hasQuery(q)) return "Ошибка appWait: укажи ref, text или selector ожидаемого элемента.";
  const timeout = Math.min(Math.max(parseInt(args && args.timeout, 10) || 20000, 1000), 60000);
  const deadline = Date.now() + timeout;
  const body = `
    const q = ${JSON.stringify({ ref: q.ref, selector: q.selector, text: q.text, role: q.role })};
    const found = appFind(q);
    return found.el ? { desc: appDesc(found.el) } : null;
  `;
  while (Date.now() < deadline) {
    try {
      const r = await evalIn(win, wrap(body), 6000);
      if (r && r.desc) return "OK — элемент появился: " + r.desc + ".";
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return await missText(win, "appWait", raw, "не появился за " + Math.round(timeout / 1000) + " с");
}

// ── appScreenshot: скриншот окна приложения (для vision-модели) ────────────
async function screenshot(args, win) {
  if (!winOk(win)) throw new Error("Окно приложения недоступно (запусти desktop-версию).");
  const img = await win.webContents.capturePage();
  if (!img || img.isEmpty()) throw new Error("Пустой скриншот окна");
  const png = img.toPNG();
  if (!png || !png.length) throw new Error("Не удалось сформировать скриншот окна");
  return "data:image/png;base64," + png.toString("base64");
}

module.exports = {
  read,
  snapshot,
  click,
  fill,
  select,
  press,
  wait,
  screenshot,
  looksDangerous,
  mapItems,
};
