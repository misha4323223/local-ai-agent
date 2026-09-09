"use strict";
/* markdown.js — лёгкий рендер markdown и схем (mermaid-подмножество) без внешних библиотек.
   Используется чатом для красивого оформления ответов агента:
   - заголовки, списки (в т.ч. чек-листы), таблицы, цитаты, жирный/курсив/зачёркнутый, ссылки;
   - блоки кода с подписью языка и кнопкой «копировать»;
   - блоки ```mermaid с диаграммами flowchart / sequenceDiagram (рисуются чистым HTML/CSS);
   - любые другие mermaid-диаграммы отображаются как обычный код.
   Всё экранируется до рендера — HTML из ответа модели безопасен. */

(function (global) {
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Инлайновое форматирование (сначала экранируем, потом размечаем) ──
  function inline(t) {
    let s = esc(t);
    s = s.replace(/`([^`\n]+)`/g, (_, c) => '<code class="md-code">' + c + "</code>");
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?;:—–-]|$)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, txt, url) => '<a href="' + url + '" target="_blank" rel="noopener">' + txt + "</a>"); // url уже экранирован
    // Голые URL → кликабельные ссылки (после markdown-ссылок, чтобы не задвоить).
    // Отрезаем хвостовую пунктуацию: «Смотри: https://x.com/test.» → ссылка без точки.
    s = s.replace(/(^|[\s(>])(https?:\/\/[^\s<]+)/g, (m, pre, url) => {
      let u = String(url).replace(/[.,;:!?)]+$/, "");
      return pre + '<a href="' + u + '" target="_blank" rel="noopener">' + u + "</a>";
    });
    return s;
  }

  // ── Блок кода с шапкой (язык + кнопка копирования) ──
  function codeBlock(lang, code) {
    const l = (lang || "").trim();
    return (
      '<div class="md-codeblock">' +
      '<div class="md-codehead"><span class="md-codelang">' + esc(l || "код") + "</span>" +
      '<button type="button" class="md-copy" title="Скопировать">⧉ Копировать</button></div>' +
      "<pre><code>" + esc(code) + "</code></pre></div>"
    );
  }

  // ══════════════ Схемы (mermaid-подмножество) ══════════════

  function parseNode(raw, nodes) {
    raw = raw.trim();
    let m = raw.match(/^([A-Za-z0-9_]+)\s*\(\((.*)\)\)$/);
    let shape = "circle";
    if (!m) { m = raw.match(/^([A-Za-z0-9_]+)\s*\[(.*)\]$/); shape = "rect"; }
    if (!m) { m = raw.match(/^([A-Za-z0-9_]+)\s*\((.*)\)$/); shape = "round"; }
    if (!m) { m = raw.match(/^([A-Za-z0-9_]+)\s*\{(.*)\}$/); shape = "diamond"; }
    if (!m) { m = raw.match(/^([A-Za-z0-9_]+)$/); shape = "rect"; }
    if (!m) return null;
    const id = m[1];
    const text = m[2] || id;
    if (!nodes.has(id)) nodes.set(id, { id, text, shape });
    return id;
  }

  function flowchart(lines) {
    let dir = "TD";
    const nodes = new Map();
    const edges = [];
    for (const raw of lines) {
      const line = raw.replace(/;$/, "").trim();
      if (!line) continue;
      const dm = line.match(/^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/i);
      if (dm) { dir = dm[1].toUpperCase() === "TB" ? "TD" : dm[1].toUpperCase(); continue; }
      if (/^(?:flowchart|graph|subgraph|end)\b/i.test(line)) continue;
      // A -->|label| B
      let m = line.match(/^(.+?)\s*(-->|---|-\.->|==>)\|([^|]*)\|\s*(.+)$/);
      if (m) {
        const from = parseNode(m[1], nodes);
        const to = parseNode(m[4], nodes);
        if (from && to) edges.push({ from, to, style: m[2], label: m[3] });
        continue;
      }
      // A --> B (и B & C)
      m = line.match(/^(.+?)\s*(-->|--x|--o|---|-\.->|==>)\s*(.+)$/);
      if (m) {
        const from = parseNode(m[1], nodes);
        if (!from) continue;
        const targets = m[3].split("&").map((x) => x.trim()).filter(Boolean);
        for (const t of targets) {
          const to = parseNode(t, nodes);
          if (to) edges.push({ from, to, style: m[2], label: "" });
        }
      }
    }
    if (!edges.length) return null;
    const horizontal = dir === "LR" || dir === "RL";
    const reverse = dir === "RL" || dir === "BT";
    let h = '<div class="md-dg md-dg-' + (horizontal ? "lr" : "td") + '">';
    for (const e of edges) {
      const a = nodes.get(e.from);
      const b = nodes.get(e.to);
      if (!a || !b) continue;
      const cls = "dg-arrow" +
        (e.style === "-.->" ? " dashed" : e.style === "==>" ? " thick" : e.style === "--x" ? " cross" : e.style === "--o" ? " dot" : "") +
        (reverse ? " rev" : "");
      h +=
        '<div class="dg-edge">' +
        nodeHtml(a) +
        '<div class="' + cls + '">' +
        '<div class="dg-arrow-line"></div>' +
        (e.label ? '<div class="dg-arrow-label">' + esc(e.label) + "</div>" : "") +
        '<div class="dg-arrow-head"></div></div>' +
        nodeHtml(b) +
        "</div>";
    }
    return h + "</div>";
  }

  function nodeHtml(n) {
    if (n.shape === "diamond") {
      return '<div class="dg-node dg-diamond"><span>' + esc(n.text) + "</span></div>";
    }
    return '<div class="dg-node dg-' + n.shape + '">' + esc(n.text) + "</div>";
  }

  function sequenceDiagram(lines) {
    const parts = [];
    const pidx = new Map();
    const msgs = [];
    const addP = (id, name) => {
      if (!pidx.has(id)) {
        pidx.set(id, parts.length);
        parts.push({ id, name: name || id });
      }
    };
    for (const raw of lines) {
      const line = raw.replace(/;$/, "").trim();
      if (!line) continue;
      let m = line.match(/^participant\s+([A-Za-z0-9_]+)(?:\s+as\s+(.+))?$/i);
      if (m) { addP(m[1], m[2] ? m[2].trim().replace(/^["']|["']$/g, "") : null); continue; }
      m = line.match(/^Note\s+over\s+([A-Za-z0-9_]+)(?:,\s*([A-Za-z0-9_]+))?:\s*(.+)$/i);
      if (m) {
        addP(m[1], null);
        if (m[2]) addP(m[2], null);
        msgs.push({ kind: "note", a: m[1], b: m[2] || m[1], text: m[3] });
        continue;
      }
      m = line.match(/^([A-Za-z0-9_]+)\s*(->>|-->>|->|-->|-x|--x)\s*([A-Za-z0-9_]+)(?::\s*(.*))?$/);
      if (m) {
        addP(m[1], null);
        addP(m[3], null);
        msgs.push({ kind: "msg", a: m[1], b: m[3], style: m[2], text: m[4] || "" });
      }
    }
    if (!parts.length) return null;
    const idx = (id) => pidx.get(id) || 0;
    const span = (a, b) => {
      let c1 = idx(a) + 1;
      let c2 = idx(b) + 2;
      if (c1 >= c2) { const t = c1; c1 = c2 - 1; c2 = t + 1; }
      return c1 + " / " + c2;
    };
    let h = '<div class="md-seq" style="grid-template-columns: repeat(' + parts.length + ", 1fr)\">";
    for (const p of parts) h += '<div class="seq-actor">' + esc(p.name) + "</div>";
    for (const m of msgs) {
      if (m.kind === "note") {
        h += '<div class="seq-note" style="grid-column: ' + span(m.a, m.b) + '">' + esc(m.text) + "</div>";
      } else {
        const cls = "seq-msg" +
          (m.style.includes("--") ? " dashed" : "") +
          (m.style.endsWith("x") ? " cross" : "");
        h += '<div class="' + cls + '" style="grid-column: ' + span(m.a, m.b) + '">' +
          '<div class="seq-label">' + esc(m.text) + "</div></div>";
      }
    }
    return h + "</div>";
  }

  function diagram(code) {
    const lines = code.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return null;
    const first = lines[0].toLowerCase().replace(/;$/, "").trim();
    if (/^(flowchart|graph|flow)(\s|$)/.test(first)) return flowchart(lines);
    if (/^(sequencediagram|sequence)(\s|$)/.test(first)) return sequenceDiagram(lines);
    return null;
  }

  // ══════════════ Блочный разбор markdown ══════════════

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    return s.split("|").map((x) => x.trim());
  }

  function tableHtml(head, body) {
    let h = '<div class="md-tablewrap"><table class="md-table"><thead><tr>';
    for (const c of head) h += "<th>" + inline(c) + "</th>";
    h += "</tr></thead><tbody>";
    for (const row of body) {
      h += "<tr>";
      for (let j = 0; j < head.length; j++) h += "<td>" + inline(row[j] || "") + "</td>";
      h += "</tr>";
    }
    return h + "</tbody></table></div>";
  }

  function parseList(lines, i, out) {
    const items = [];
    let ol = false;
    while (i < lines.length) {
      const t = lines[i].trim();
      const m = t.match(/^([-*+]|\d+[.)])\s+(.*)$/);
      if (!m) break;
      if (/^\d+[.)]/.test(m[1])) ol = true;
      let content = m[2];
      const task = content.match(/^\[( |x|X)\]\s+(.*)$/);
      let li = '<li class="md-li">';
      if (task) {
        li += '<span class="md-task' + (task[1] !== " " ? " done" : "") + '">' + (task[1] !== " " ? "☑" : "☐") + "</span> " + inline(task[2]);
      } else {
        li += inline(content);
      }
      items.push(li);
      i++;
      if (i < lines.length && /^\s+/.test(lines[i]) && /^[-*+]|\d+[.)]\s+/.test(lines[i].trim())) {
        const sub = [];
        i = parseList(lines, i, sub);
        items[items.length - 1] += sub.join("");
      }
    }
    out.push("<" + (ol ? "ol" : "ul") + ' class="md-list">' + items.map((x) => x + "</li>").join("") + "</" + (ol ? "ol" : "ul") + ">");
    return i;
  }

  function render(src) {
    src = String(src == null ? "" : src).replace(/\r\n?/g, "\n");
    const lines = src.split("\n");
    const out = [];
    let para = [];
    const flushPara = () => {
      if (para.length) {
        out.push("<p>" + inline(para.join(" ")) + "</p>");
        para = [];
      }
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const t = line.trim();
      if (!t) { i++; continue; }
      const fence = t.match(/^```(\S*)\s*$/);
      if (fence) {
        flushPara();
        const lang = fence[1] || "";
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
        i++; // закрывающий ``` 
        const code = buf.join("\n");
        const l = lang.toLowerCase();
        if (l === "mermaid" || l === "flowchart" || l === "sequence") {
          const d = diagram(l === "mermaid" ? code : l + "\n" + code);
          out.push(d || codeBlock(lang, code));
        } else {
          out.push(codeBlock(lang, code));
        }
        continue;
      }
      const h = t.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushPara();
        const n = h[1].length;
        out.push("<h" + n + ">" + inline(h[2]) + "</h" + n + ">");
        i++;
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
        flushPara();
        out.push('<hr class="md-hr" />');
        i++;
        continue;
      }
      if (t.startsWith("|") && i + 1 < lines.length) {
        const sep = lines[i + 1].trim();
        if (/^\|?[\s:|-]+\|?\s*$/.test(sep) && sep.includes("-")) {
          flushPara();
          const head = splitRow(t);
          i += 2;
          const body = [];
          while (i < lines.length && lines[i].trim().startsWith("|")) { body.push(splitRow(lines[i])); i++; }
          out.push(tableHtml(head, body));
          continue;
        }
      }
      if (t.startsWith(">")) {
        flushPara();
        const q = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) { q.push(lines[i].trim().replace(/^>\s?/, "")); i++; }
        out.push('<blockquote class="md-quote">' + inline(q.join(" ")) + "</blockquote>");
        continue;
      }
      if (/^[-*+]\s+/.test(t) || /^\d+[.)]\s+/.test(t)) {
        flushPara();
        i = parseList(lines, i, out);
        continue;
      }
      para.push(t);
      i++;
    }
    flushPara();
    return out.join("\n");
  }

  // Кнопка «Копировать» у блоков кода (делегирование — работает и после перерисовки)
  if (typeof document !== "undefined") {
    document.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest(".md-copy") : null;
      if (!btn) return;
      const block = btn.closest(".md-codeblock");
      const code = block && block.querySelector("code");
      if (!code) return;
      const text = code.textContent;
      const done = () => {
        const old = btn.textContent;
        btn.textContent = "✓ Скопировано";
        btn.classList.add("ok");
        setTimeout(() => { btn.textContent = old; btn.classList.remove("ok"); }, 1300);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (err) { /* ignore */ }
        document.body.removeChild(ta);
        done();
      }
    });
  }

  const api = { render, esc, diagram };
  global.MdRender = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);