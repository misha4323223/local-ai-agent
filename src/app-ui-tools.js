"use strict";

/* ── app-ui-tools.js — управление СОБСТВЕННЫМ окном приложения ─────────────────
   Агент может «ходить» по интерфейсу приложения, в котором живёт (Electron):
   читать, что сейчас видно в окне (appRead), кликать по тексту/селектору/номеру
   (appClick), вводить текст в поля (appFill), выбирать из списков (appSelect),
   жать клавиши (appPress), ждать появления элемента (appWait) и снимать скриншот
   окна (appScreenshot). Всё выполняется через webContents.executeJavaScript —
   то есть внутри собственного DOM приложения, без отдельного браузера.

   Безопасность: клики по разрушительным кнопкам («Удалить», «Очистить чат»,
   «Сбросить», «Отменить изменения») блокируются — агент должен спросить
   пользователя через askUser. Работает только в десктоп-приложении (main-процесс),
   в веб-превью недоступно (app.js отдаёт честную заглушку). */

// Разрушительные тексты кнопок — кликать по ним агенту запрещено.
const DANGEROUS_TEXT = /удал|очист|сброс|отмен|откат|уничтож|выйти|выход/i;

function looksDangerous(text) {
  return DANGEROUS_TEXT.test(String(text || "").toLowerCase());
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

// Общий код страницы: видимость + поиск интерактивных элементов.
const PAGE_COLLECT = `
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity || 1) > 0;
  };
  const descEl = (el) => {
    let text = (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || "").replace(/\\s+/g, " ").trim().slice(0, 70);
    if (!text) text = "…";
    let id = "";
    if (el.id) id = "#" + el.id;
    let cls = "";
    if (typeof el.className === "string" && el.className.trim()) {
      cls = "." + el.className.trim().split(/\\s+/).filter((c) => c && c !== "hidden").slice(0, 2).join(".");
    }
    let extra = "";
    if (el.placeholder) extra += ' placeholder="' + String(el.placeholder).slice(0, 40) + '"';
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (el.type === "password") extra += " (пароль)";
      else if (el.value) extra += ' value="' + String(el.value).slice(0, 40) + '"';
    }
    if (el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio")) extra += el.checked ? " ✓" : " ✗";
    if (el.disabled) extra += " (disabled)";
    return el.tagName.toLowerCase() + id + cls + " «" + text + "»" + extra;
  };
`;

// ── appRead: снимок текущего состояния окна ─────────────────────────────────
async function read(args, win) {
  const JS =
    "(function() {\n" +
    PAGE_COLLECT +
    `
    const out = { title: document.title || "", views: [], items: [], text: "" };
    document.querySelectorAll(".overlay").forEach((o) => {
      if (o && !o.classList.contains("hidden")) out.views.push(o.id || o.className || "overlay");
    });
    const sel = 'button, a, input, select, textarea, [role="button"], .chip, .seg, .tab, [data-view], .view-header, .side-panel, #sidebar, #project-panel';
    let items = [];
    document.querySelectorAll(sel).forEach((el) => {
      if (!vis(el)) return;
      if (el.closest(".hidden")) return;
      items.push(descEl(el));
    });
    const seen = new Set();
    items = items.filter((i) => (seen.has(i) ? false : (seen.add(i), true)));
    out.items = items.slice(0, 140);
    let txt = (document.body && document.body.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim();
    if (txt.length > 4000) txt = txt.slice(0, 4000) + "\\n…(обрезано)";
    out.text = txt;
    return out;
  })()`;

  const snap = await evalIn(win, JS);
  const lines = [];
  lines.push("Окно: " + (snap && snap.title ? snap.title : "AI Developer Agent"));
  if (snap && snap.views && snap.views.length) {
    lines.push("Открытые панели/оверлеи: " + snap.views.join(", "));
  }
  lines.push("Элементы окна (кликай по тексту «…», селектору или номеру [N]):");
  const items = (snap && snap.items) || [];
  items.forEach((it, i) => lines.push("  [" + (i + 1) + "] " + it));
  if (!items.length) lines.push("  (интерактивные элементы не найдены)");
  lines.push("Текст окна (фрагмент):");
  lines.push(String((snap && snap.text) || "").slice(0, 4000));
  return lines.join("\n");
}

// ── appClick: клик по тексту, CSS-селектору или номеру из appRead ──────────
async function click(args, win) {
  args = args || {};
  const text = String(args.text || args.label || "").trim();
  const selector = String(args.selector || "").trim();
  const index = parseInt(args.index, 10);
  if (!text && !selector && !(Number.isFinite(index) && index > 0)) {
    return "Ошибка: укажи text («Настройки»), selector (#id/.class) или index (номер из appRead).";
  }
  if (text && looksDangerous(text)) {
    return (
      "⛔ Клик по разрушительному элементу «" + text.slice(0, 60) +
      "» заблокирован (удаление/очистка/сброс/отмена изменений). Спроси пользователя через askUser; при подтверждении попроси его нажать самому или используй соответствующий инструмент агента (writeFile/runCommand)."
    );
  }
  const q = JSON.stringify(text);
  const s = JSON.stringify(selector);
  const idx = Number.isFinite(index) && index > 0 ? index : 0;
  const JS =
    "(function() {\n" +
    PAGE_COLLECT +
    `
    let target = null;
    let how = "";
    if (${idx} > 0) {
      const sel = 'button, a, input, select, textarea, [role="button"], .chip, .seg, .tab';
      let n = 0;
      document.querySelectorAll(sel).forEach((el) => {
        if (vis(el) && !el.closest(".hidden")) {
          n++;
          if (n === ${idx}) { target = el; how = "номер " + ${idx}; }
        }
      });
    } else if (${s}) {
      target = document.querySelector(${s});
      how = "селектор " + ${s};
    } else {
      const q = ${q}.toLowerCase();
      const sel = 'button, a, [role="button"], .chip, .seg, .tab, label, input, select, textarea';
      let cands = [];
      document.querySelectorAll(sel).forEach((el) => {
        if (!vis(el) || el.closest(".hidden")) return;
        const t = (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || "").replace(/\\s+/g, " ").trim().toLowerCase();
        if (t === q) cands.push(el);
        else if (t.indexOf(q) !== -1 && cands.length < 2) cands.push(el);
      });
      if (cands.length) { target = cands[0]; how = "текст «" + ${q} + "»"; }
    }
    if (!target) return { ok: false, error: "элемент не найден — обнови карту через appRead" };
    target.scrollIntoView({ block: "center", inline: "center" });
    const desc = descEl(target);
    target.click();
    return { ok: true, how: how || desc, desc };
  })()`;
  const r = await evalIn(win, JS);
  if (!r || !r.ok) return "Ошибка appClick: " + ((r && r.error) || "не удалось кликнуть");
  return "OK — клик по " + r.how + ": " + r.desc + ". Проверь результат через appRead.";
}

// ── appFill: ввод текста в поле (в т.ч. React-controlled инпуты) ───────────
async function fill(args, win) {
  args = args || {};
  const selector = String(args.selector || "").trim();
  const value = args.text != null ? String(args.text) : "";
  if (!selector) return "Ошибка: укажи selector поля (#id, .class, input[name=...]).";
  const s = JSON.stringify(selector);
  const v = JSON.stringify(value);
  const JS =
    "(function() {\n" +
    PAGE_COLLECT +
    `
    const el = document.querySelector(${s});
    if (!el) return { ok: false, error: "поле не найдено: " + ${s} };
    if (el.isContentEditable) {
      el.textContent = ${v};
    } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
      if (setter) setter.call(el, ${v}); else el.value = ${v};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      return { ok: false, error: "элемент не является полем ввода: " + descEl(el) };
    }
    return { ok: true, desc: descEl(el), value: ${v}.slice(0, 40) };
  })()`;
  const r = await evalIn(win, JS);
  if (!r || !r.ok) return "Ошибка appFill: " + ((r && r.error) || "не удалось ввести текст");
  return "OK — в поле " + r.desc + " введено: «" + r.value + "». Проверь через appRead.";
}

// ── appSelect: выбор варианта в <select> по value или тексту ───────────────
async function select(args, win) {
  args = args || {};
  const selector = String(args.selector || "").trim();
  const value = String(args.value || "").trim();
  const text = String(args.text || "").trim();
  if (!selector || (!value && !text)) {
    return "Ошибка: укажи selector списка и value (или text варианта).";
  }
  const s = JSON.stringify(selector);
  const v = JSON.stringify(value);
  const t = JSON.stringify(text.toLowerCase());
  const JS =
    "(function() {\n" +
    PAGE_COLLECT +
    `
    const el = document.querySelector(${s});
    if (!el || el.tagName !== "SELECT") return { ok: false, error: "элемент не найден или это не <select>: " + ${s} };
    let opt = null;
    if (${v}) opt = Array.prototype.find.call(el.options, (o) => o.value === ${v});
    if (!opt && ${t}) opt = Array.prototype.find.call(el.options, (o) => (o.text || "").trim().toLowerCase().indexOf(${t}) !== -1);
    if (!opt) return { ok: false, error: "вариант не найден (value/text)" };
    el.value = opt.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, chosen: opt.text };
  })()`;
  const r = await evalIn(win, JS);
  if (!r || !r.ok) return "Ошибка appSelect: " + ((r && r.error) || "не удалось выбрать");
  return "OK — выбран вариант «" + r.chosen + "». Проверь через appRead.";
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

// ── appWait: ожидание появления элемента (текст или селектор) ──────────────
async function wait(args, win) {
  args = args || {};
  const text = String(args.text || "").trim();
  const selector = String(args.selector || "").trim();
  if (!text && !selector) return "Ошибка: укажи text или selector ожидаемого элемента.";
  const timeout = Math.min(Math.max(parseInt(args.timeout, 10) || 20000, 1000), 60000);
  const s = JSON.stringify(selector);
  const q = JSON.stringify(text.toLowerCase());
  const deadline = Date.now() + timeout;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const JS =
        "(function() {\n" +
        PAGE_COLLECT +
        `
        let el = null;
        if (${s}) el = document.querySelector(${s});
        if (!el && ${q}) {
          const sel = 'button, a, input, select, textarea, [role="button"], .chip, .seg, .tab, h1, h2, h3, h4, .view-header, label, span, div';
          document.querySelectorAll(sel).forEach((c) => {
            if (!el && vis(c) && !c.closest(".hidden")) {
              const tt = (c.getAttribute("aria-label") || c.innerText || "").replace(/\\s+/g, " ").trim().toLowerCase();
              if (tt === ${q} || tt.indexOf(${q}) !== -1) el = c;
            }
          });
        }
        return el && vis(el) ? descEl(el) : "";
      })()`;
      const found = await evalIn(win, JS, 5000);
      if (found) return "OK — элемент появился: " + found + ".";
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return "⏳ Не дождался элемента " + (text ? "«" + text + "»" : selector) + " за " + Math.round(timeout / 1000) + " с" + (lastErr ? " (" + lastErr + ")" : "") + ". Проверь состояние окна через appRead.";
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

module.exports = { read, click, fill, select, press, wait, screenshot, looksDangerous };