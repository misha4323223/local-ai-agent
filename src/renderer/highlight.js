"use strict";
/* ─── Подсветка синтаксиса без внешних зависимостей ───────────────────────────
   window.Highlight.highlight(code, fileNameOrPath) → HTML-строка.

   Гарантия: если снять теги и раскодировать сущности, получится РОВНО исходный
   текст (проверяется smoke-тестом). Никакой код не выполняется: всё, что не
   распознано как токен, экранируется (& < >).

   Поддерживаются: js/ts/jsx/tsx, json, html/xml/svg/vue, css/scss/less,
   python, shell/bat/env, sql, yaml, markdown; для остальных — общий набор
   (комментарии, строки, числа).

   Устройство: для каждого языка — список правил; из них собирается одна
   регулярка-альтернатива с группами, поэтому порядок правил = приоритет
   (комментарий/строка побеждают ключевое слово). Все внутренние группы —
   неотрицательные (?:...), чтобы индексы групп не сбивались. */
(function () {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
  function esc(s) {
    return String(s).replace(/[&<>]/g, (c) => ESC[c]);
  }

  const NUM = "(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)";
  const JS_KW =
    "as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|get|if|import|in|instanceof|let|new|of|return|set|static|super|switch|this|throw|try|typeof|var|void|while|with|yield";
  const JS_LIT = "true|false|null|undefined|NaN|Infinity";
  const PY_KW =
    "def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|pass|break|continue|lambda|yield|global|nonlocal|assert|del|in|is|not|and|or|async|await|print";
  const SH_KW =
    "if|then|else|elif|fi|for|while|until|do|done|case|esac|function|in|return|exit|local|export|readonly|declare|source|echo|printf|cd|ls|rm|cp|mv|mkdir|touch|cat|grep|sed|awk|npm|bun|node|git|docker|curl|sudo|chmod|chown|test|set|unset|trap|head|tail|sleep|kill";
  const SQL_KW =
    "select|from|where|insert|into|values|update|set|delete|create|table|alter|drop|index|join|left|right|inner|outer|on|group|by|order|having|limit|offset|as|and|or|not|null|is|in|exists|distinct|count|sum|avg|min|max|primary|key|foreign|references|default|unique|constraint|case|when|then|else|end|union|all|begin|commit|rollback|with|returning|asc|desc|if|exists|bigint|int|integer|text|varchar|boolean|timestamp|serial|uuid";

  const LANGS = {
    js: {
      flags: "gm",
      rules: [
        { re: "\\/\\*[\\s\\S]*?\\*\\/", cls: "com" },
        { re: "\\/\\/[^\\n]*", cls: "com" },
        { re: "`(?:\\\\.|[^`\\\\])*`", cls: "str" },
        { re: "\"(?:\\\\.|[^\"\\\\\\n])*\"", cls: "str" },
        { re: "'(?:\\\\.|[^'\\\\\\n])*'", cls: "str" },
        { re: "\\b(?:" + JS_KW + ")\\b", cls: "kw" },
        { re: "\\b(?:" + JS_LIT + ")\\b", cls: "lit" },
        { re: "\\b[A-Za-z_$][\\w$]*(?=\\s*\\()", cls: "fn" },
        { re: NUM, cls: "num" },
      ],
    },
    json: {
      flags: "gm",
      rules: [
        { re: "\"(?:\\\\.|[^\"\\\\])*\"(?=\\s*:)", cls: "key" },
        { re: "\"(?:\\\\.|[^\"\\\\])*\"", cls: "str" },
        { re: "\\b(?:true|false|null)\\b", cls: "lit" },
        { re: NUM, cls: "num" },
      ],
    },
    markup: {
      flags: "gmi",
      rules: [
        { re: "<!--[\\s\\S]*?-->", cls: "com" },
        { re: "<!\\[CDATA\\[[\\s\\S]*?\\]\\]>", cls: "com" },
        { re: "<\\/?[A-Za-z][\\w:.-]*", cls: "tag" },
        { re: "\\/?>", cls: "tag" },
        { re: "[A-Za-z_:][-\\w:.]*(?=\\s*=)", cls: "attr" },
        { re: "\"[^\"]*\"", cls: "str" },
        { re: "'[^']*'", cls: "str" },
      ],
    },
    css: {
      flags: "gm",
      rules: [
        { re: "\\/\\*[\\s\\S]*?\\*\\/", cls: "com" },
        { re: "\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'", cls: "str" },
        { re: "@[\\w-]+", cls: "kw" },
        { re: "#[0-9a-fA-F]{3,8}\\b", cls: "num" },
        { re: "[-\\w]+(?=\\s*:)", cls: "prop" },
        { re: NUM + "(?:px|em|rem|vh|vw|vmin|vmax|s|ms|deg|fr|pt|%)?", cls: "num" },
      ],
    },
    py: {
      flags: "gm",
      rules: [
        { re: "#[^\\n]*", cls: "com" },
        { re: "[rRbBfFuU]{0,2}\"\"\"[\\s\\S]*?\"\"\"", cls: "str" },
        { re: "[rRbBfFuU]{0,2}'''[\\s\\S]*?'''", cls: "str" },
        { re: "[rRbBfFuU]{0,2}\"(?:\\\\.|[^\"\\\\\\n])*\"", cls: "str" },
        { re: "[rRbBfFuU]{0,2}'(?:\\\\.|[^'\\\\\\n])*'", cls: "str" },
        { re: "\\b(?:" + PY_KW + ")\\b", cls: "kw" },
        { re: "\\b(?:True|False|None|self)\\b", cls: "lit" },
        { re: "@[\\w.]+", cls: "fn" },
        { re: "\\b[A-Za-z_]\\w*(?=\\s*\\()", cls: "fn" },
        { re: NUM, cls: "num" },
      ],
    },
    sh: {
      flags: "gm",
      rules: [
        { re: "#[^\\n]*", cls: "com" },
        { re: "\"(?:\\\\.|[^\"\\\\\\n])*\"|'[^'\\n]*'", cls: "str" },
        { re: "\\$\\{[^}\\n]*\\}|\\$[A-Za-z_]\\w*|\\$[0-9@*#?$!-]", cls: "var" },
        { re: "\\b(?:" + SH_KW + ")\\b", cls: "kw" },
        { re: NUM, cls: "num" },
      ],
    },
    sql: {
      flags: "gmi",
      rules: [
        { re: "--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/", cls: "com" },
        { re: "'(?:''|[^'])*'", cls: "str" },
        { re: "\"[^\"]*\"", cls: "str" },
        { re: "\\b(?:" + SQL_KW + ")\\b", cls: "kw" },
        { re: NUM, cls: "num" },
      ],
    },
    yaml: {
      flags: "gm",
      rules: [
        { re: "#[^\\n]*", cls: "com" },
        { re: "\"(?:\\\\.|[^\"\\\\\\n])*\"|'[^'\\n]*'", cls: "str" },
        { re: "^\\s*(?:-\\s+)?[\\w.$-]+(?=\\s*:)", cls: "key" },
        { re: "\\b(?:true|false|null|yes|no|on|off|~)\\b", cls: "lit" },
        { re: NUM, cls: "num" },
      ],
    },
    md: {
      flags: "gm",
      rules: [
        { re: "```[\\s\\S]*?(?:```|$)", cls: "code" },
        { re: "`[^`\\n]*`", cls: "code" },
        { re: "^#{1,6}[^\\n]*", cls: "head" },
        { re: "\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__", cls: "kw" },
        { re: "\\[[^\\]\\n]*\\]\\([^)\\n]*\\)", cls: "link" },
        { re: "^\\s*(?:[-*+]|\\d+\\.)\\s", cls: "fn" },
        { re: "^> [^\\n]*", cls: "com" },
      ],
    },
    generic: {
      flags: "gm",
      rules: [
        { re: "\\/\\*[\\s\\S]*?\\*\\/", cls: "com" },
        { re: "\\/\\/[^\\n]*|#[^\\n]*", cls: "com" },
        { re: "\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'", cls: "str" },
        { re: NUM, cls: "num" },
      ],
    },
  };

  // Расширение (или имя файла) → язык
  const BY_EXT = {
    js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js",
    json: "json", jsonc: "json",
    html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup",
    css: "css", scss: "css", less: "css",
    py: "py", pyw: "py",
    sh: "sh", bash: "sh", zsh: "sh", env: "sh", bat: "sh", cmd: "sh", ps1: "sh",
    sql: "sql",
    yml: "yaml", yaml: "yaml",
    md: "md", markdown: "md",
  };

  function langOf(name) {
    const base = String(name || "").split(/[\\/]/).pop().toLowerCase();
    if (!base) return "generic";
    if (base === "dockerfile" || base === "makefile" || base === ".env" || base.indexOf(".env.") === 0) return "sh";
    const dot = base.lastIndexOf(".");
    if (dot <= 0) return "generic";
    return BY_EXT[base.slice(dot + 1)] || "generic";
  }

  const compiled = {};
  function scanner(lang) {
    if (compiled[lang]) return compiled[lang];
    const def = LANGS[lang] || LANGS.generic;
    const re = new RegExp(def.rules.map((r) => "(" + r.re + ")").join("|"), def.flags);
    compiled[lang] = { re: re, classes: def.rules.map((r) => r.cls) };
    return compiled[lang];
  }

  function scan(text, lang) {
    const s = scanner(lang);
    const re = s.re;
    re.lastIndex = 0;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m[0] === "") {
        re.lastIndex++; // защита от нулевых совпадений
        continue;
      }
      if (m.index > last) out += esc(text.slice(last, m.index));
      let cls = "";
      for (let i = 1; i < m.length; i++) {
        if (m[i] !== undefined) {
          cls = s.classes[i - 1] || "";
          break;
        }
      }
      out += cls ? '<span class="tok-' + cls + '">' + esc(m[0]) + "</span>" : esc(m[0]);
      last = m.index + m[0].length;
    }
    if (last < text.length) out += esc(text.slice(last));
    return out;
  }

  // Очень большие тексты не подсвечиваем — иначе DOM-строка разрастается.
  const MAX = 400 * 1024;

  function highlight(code, name) {
    const text = code == null ? "" : String(code);
    if (!text) return "";
    if (text.length > MAX) return esc(text);
    return scan(text, langOf(name));
  }

  // Сколько строк в тексте (для нумерации без расхождений)
  function countLines(code) {
    const text = code == null ? "" : String(code);
    if (!text) return 1;
    let n = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
  }

  window.Highlight = { highlight, langOf, esc, countLines };
})();
