"use strict";
/* Dev/preview server: показывает интерфейс приложения (src/renderer) в браузере.
   Полноценная работа (файлы, git, GitHub OAuth) доступна только в десктоп-приложении —
   `bun run start` или сборка `bun run dist:win` на ПК. */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const AgentCore = require("./src/renderer/agent-core.js");

const ROOT = path.join(__dirname, "src", "renderer");
const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || "0.0.0.0";

// Оборачивает асинхронную функцию в ответ; текст — plain UTF-8.
function jsonOk(res, text) {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(String(text));
}

function handleApi(url, res, req) {
  // Поиск в интернете без API-ключа (DuckDuckGo). Браузер не может ходить на DDG
  // напрямую (CORS) — запрос идёт через preview-сервер.
  if (url.pathname === "/api/search") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return jsonOk(res, "Ошибка: пустой поисковый запрос");
    AgentCore.webSearchDDG(q).then((t) => jsonOk(res, t)).catch((e) => jsonOk(res, "Ошибка веб-поиска: " + e.message));
    return true;
  }
  // Чтение веб-страницы по URL (тоже из-за CORS идёт через сервер).
  if (url.pathname === "/api/fetch") {
    const u = (url.searchParams.get("url") || "").trim();
    if (!/^https?:\/\//i.test(u)) return jsonOk(res, "Ошибка: укажи URL вида https://...");
    AgentCore.webFetchPage(u).then((t) => jsonOk(res, t)).catch((e) => jsonOk(res, "Ошибка загрузки: " + e.message));
    return true;
  }
  // Прокси для LLM-провайдеров без CORS (Yandex AI Studio и др.): браузер не может
  // ходить на них напрямую — запрос идёт через preview-сервер. Формат пути:
  //   /api/llm/<encodeURIComponent(базовый URL)>/<остальной путь>?<query>
  // Заголовки Authorization / OpenAI-Project / Content-Type пробрасываются как есть.
  if (url.pathname.startsWith("/api/llm/")) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, openai-project, content-type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      res.end();
      return true;
    }
    const rest = url.pathname.slice("/api/llm/".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) {
      res.writeHead(400);
      res.end("Bad proxy path");
      return true;
    }
    let base = "";
    try {
      base = decodeURIComponent(rest.slice(0, slash));
    } catch {
      res.writeHead(400);
      res.end("Bad proxy base");
      return true;
    }
    const target = base + rest.slice(slash) + (url.search || "");
    if (!/^https:\/\/ai\.api\.cloud\.yandex\.net\//i.test(target)) {
      res.writeHead(403);
      res.end("Forbidden proxy target");
      return true;
    }
    const headers = {};
    for (const h of ["authorization", "openai-project", "content-type", "x-api-key", "anthropic-version", "anthropic-dangerous-direct-browser-access"]) {
      const v = req.headers[h];
      if (v !== undefined) headers[h] = v;
    }
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, openai-project, content-type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access",
    };
    const transport = target.startsWith("https:") ? https : http;
    const preq = transport.request(target, { method: req.method, headers }, (pres) => {
      res.writeHead(pres.statusCode || 502, { ...cors, ...(pres.headers["content-type"] ? { "Content-Type": pres.headers["content-type"] } : {}) });
      pres.pipe(res);
    });
    preq.on("error", (e) => {
      res.writeHead(502, cors);
      res.end("Proxy error: " + e.message);
    });
    req.pipe(preq);
    return true;
  }
  return false;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (handleApi(url, res, req)) return; // /api/search, /api/fetch, /api/llm
    let p = decodeURIComponent(url.pathname);
    if (p === "/" || p === "") p = "/index.html";
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404);
        res.end("Not found: " + p);
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      fs.createReadStream(file).pipe(res);
    });
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});

server.listen(PORT, HOST, () => {
  console.log("AI Developer Agent preview: http://" + HOST + ":" + PORT + " (serving src/renderer)");
});