"use strict";

/* ─── Интеграция с Yandex Cloud (REST API) ────────────────────────────────────
   Чистый Node-модуль (без Electron): fetch + таймеры, тестируется в plain-node.

   Авторизация:
     Пользователь даёт OAuth-токен Yandex (получается на oauth.yandex.ru,
     тот же токен, что использует yc CLI). Приложение обменивает его на
     IAM-токен (POST https://iam.api.cloud.yandex.net/iam/v1/tokens), который
     живёт ~12 часов и кэшируется — пере-обмен происходит автоматически.

   Эндпоинты:
     Загружаются динамически с https://api.cloud.yandex.net/endpoints (кэш),
     фолбэк — известные адреса сервисов (на случай недоступности списка).

   Дашборд (счётчики по 13 сервисам):
     Для каждого сервиса — GET list по каталогу (folderId) с Bearer IAM-токеном.
     Каждый сервис считается независимо: ошибка одного не роняет остальные.

   Создание/удаление:
     Простые ресурсы (YDB, Lockbox, Registry, Bucket, DNS-зона, Serverless
     Container, VPC-сеть) создаются POST'ом и ждут завершения операции.
     Удаление — DELETE по id ресурса. */

const KNOWN_ENDPOINTS = {
  "iam": "https://iam.api.cloud.yandex.net",
  "resource-manager": "https://resource-manager.api.cloud.yandex.net",
  "operation": "https://operation.api.cloud.yandex.net",
  "serverless-containers": "https://serverless-containers.api.cloud.yandex.net",
  "container-registry": "https://container-registry.api.cloud.yandex.net",
  "ydb": "https://ydb.api.cloud.yandex.net",
  "lockbox": "https://lockbox.api.cloud.yandex.net",
  "storage": "https://storage.api.cloud.yandex.net",
  "storage-api": "https://storage.api.cloud.yandex.net",
  "dns": "https://dns.api.cloud.yandex.net",
  "apigateway": "https://apigateway.api.cloud.yandex.net",
  "serverless-apigateway": "https://serverless-apigateway.api.cloud.yandex.net",
  "certificate-manager": "https://certificatemanager.api.cloud.yandex.net",
  "cdn": "https://cdn.api.cloud.yandex.net",
  "logging": "https://logging.api.cloud.yandex.net",
  // В каталоге эндпоинтов это ТРИ разных сервиса:
  //   logging       — группы, экспорт, синки (REST + gRPC);
  //   log-reading   — чтение записей (ТОЛЬКО gRPC; REST там не живёт вовсе);
  //   log-ingestion — запись записей.
  // Чтение логов с logging.api.cloud.yandex.net даёт «gRPC 12: unknown service
  // yandex.cloud.logging.v1.LogReadingService» — сервиса на том хосте нет.
  "log-reading": "https://reader.logging.yandexcloud.net",
  "log-ingestion": "https://ingester.logging.yandexcloud.net",
  "vpc": "https://vpc.api.cloud.yandex.net",
  // Postbox — SES-совместимый API (см. auth в SERVICES), не обычный REST каталога.
  "postbox": "https://postbox.cloud.yandex.net",
};

let endpointsCache = null; // { serviceId: address }
let endpointsTs = 0; // мс загрузки
let iamCache = null; // { token, expiresAtMs }

// ── HTTP-обёртка с таймаутом ────────────────────────────────────────────────
async function fetchJson(url, opts, timeoutMs) {
  const t = timeoutMs || 15000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), t);
  try {
    const res = await fetch(url, Object.assign({ signal: ctrl.signal, redirect: "follow" }, opts || {}));
    let body = null;
    const text = await res.text().catch(() => "");
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const msg = friendlyApiError(res.status, body, text);
      const err = new Error(msg);
      err.status = res.status;
      err.body = body;
      err.raw = text;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// Понятное объяснение ошибок API (коды HTTP + типовые причины Yandex Cloud).
function friendlyApiError(status, body, text) {
  const raw = body && (body.message || body.error || body.detail) ? String(body.message || body.error || body.detail) : (text || "").slice(0, 300);
  const map = {
    400: "Неверный запрос (400): ",
    401: "Не пройдена авторизация (401): токен недействителен или истёк. Проверь OAuth-токен в Настройках → Yandex Cloud.",
    403: "Нет доступа (403): у аккаунта/сервисного аккаунта не хватает прав на это действие в каталоге.",
    404: "Не найдено (404): ",
    409: "Конфликт (409): ресурс с таким именем уже существует или операция ещё не завершена.",
    429: "Слишком много запросов (429): подожди немного и повтори.",
    500: "Ошибка сервера Yandex Cloud (500): ",
    503: "Сервис временно недоступен (503): попробуй позже.",
  };
  const prefix = map[status] || ("Ошибка HTTP " + status + ": ");
  const detail = raw ? raw.slice(0, 500) : "(без деталей)";
  // Типовые причины из тела ошибки (коды вида FAILED_PRECONDITION и т.п.)
  if (body && body.code === 7) return "Предусловие не выполнено (7, FAILED_PRECONDITION): " + (body.message || detail);
  if (body && body.code === 16) return "Недостаточно прав (16, UNAUTHENTICATED): " + (body.message || detail);
  if (body && body.code === 3) return "Неверный аргумент (3, INVALID_ARGUMENT): " + (body.message || detail);
  return prefix + detail;
}

// Сбои «запрос не дошёл» (сеть, таймаут, обрыв) — их имеет смысл повторить,
// в отличие от ошибок API (401/403/404 — повтор ничего не изменит).
function isNetworkError(e) {
  const m = String((e && e.message) || e || "");
  if (e && e.name === "AbortError") return true;
  return /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|aborted|terminated/i.test(m);
}

function hostOf(url) {
  try {
    return new URL(String(url)).host;
  } catch {
    return String(url || "");
  }
}

// Понятный текст ошибки сервиса + адрес, по которому стучались (видно сразу,
// сетевой это сбой или ошибка API).
function serviceError(e, base, path) {
  const where = hostOf(base) + String(path || "");
  if (e && e.name === "AbortError") return "Таймаут: " + where + " не ответил вовремя — повтори позже.";
  if (isNetworkError(e)) {
    return "Сеть: запрос к " + where + " не прошёл (" + String((e && e.message) || e).slice(0, 120) + ").";
  }
  return String((e && e.message) || e) + " [" + where + "]";
}

// ── Эндпоинты сервисов ──────────────────────────────────────────────────────
// Полный список отдаёт https://api.cloud.yandex.net/endpoints (формат устойчив к
// изменениям: ищем все объекты с полем address и собираем карту по id).
async function loadEndpoints() {
  if (endpointsCache && Date.now() - endpointsTs < 12 * 3600 * 1000) return endpointsCache;
  try {
    const j = await fetchJson("https://api.cloud.yandex.net/endpoints", {}, 8000);
    const map = {};
    const walk = (v) => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) {
        for (const x of v) walk(x);
        return;
      }
      if (typeof v.address === "string" && v.id) {
        let a = String(v.address).replace(/\/+$/, "");
        if (!/^https?:\/\//i.test(a)) a = "https://" + a;
        map[String(v.id)] = a;
      }
      for (const k of Object.keys(v)) {
        if (k === "address") continue;
        walk(v[k]);
      }
    };
    walk(j);
    if (Object.keys(map).length) {
      endpointsCache = map;
      endpointsTs = Date.now();
      return map;
    }
  } catch {}
  return null;
}

// Фоновое обновление каталога: не блокирует запуск (у loadEndpoints таймаут 8 с,
// и раньше он ждался ДО первого запроса — из-за этого холодный yc:status мог
// висеть десятки секунд).
let primePromise = null;
let primeTs = 0;
const PRIME_MIN_INTERVAL = 5 * 60 * 1000; // не долбим каталог, если он недоступен
function primeEndpoints() {
  if (primePromise) return primePromise;
  if (Date.now() - primeTs < PRIME_MIN_INTERVAL) return null;
  primeTs = Date.now();
  primePromise = loadEndpoints()
    .catch(() => null)
    .finally(() => {
      primePromise = null;
    });
  return primePromise;
}

// Адрес сервиса. Выверенный KNOWN_ENDPOINTS отдаётся сразу (он совпадает с
// актуальным), а каталог догружается в фоне и потом используется для id, которых
// в KNOWN нет. Так первый запрос не ждёт сеть вообще.
async function endpoint(serviceId) {
  if (endpointsCache && Date.now() - endpointsTs < 12 * 3600 * 1000) {
    return endpointsCache[serviceId] || KNOWN_ENDPOINTS[serviceId] || null;
  }
  const known = KNOWN_ENDPOINTS[serviceId] || null;
  if (known) {
    primeEndpoints();
    return known;
  }
  const ep = await loadEndpoints();
  return (ep && ep[serviceId]) || null;
}

// ── IAM-токен (OAuth → IAM, кэш с авто-обновлением) ─────────────────────────
// Возвращает и срок жизни: он нужен, чтобы подставлять в окружение yc CLI
// ЗАВЕДОМО живой IAM-токен (OAuth там не принимается — CLI отвечает
// «The token is invalid»).
async function getIamTokenInfo(oauthToken, force) {
  const oauth = String(oauthToken || "").trim();
  if (!oauth) {
    const e = new Error("Не указан OAuth-токен Yandex. Открой Настройки → Yandex Cloud и вставь токен.");
    e.status = 401;
    throw e;
  }
  if (!force && iamCache && Date.now() < iamCache.expiresAtMs - 60 * 1000) return { token: iamCache.token, expiresAtMs: iamCache.expiresAtMs };
  const base = (await endpoint("iam")) || KNOWN_ENDPOINTS.iam;
  const j = await fetchJson(base + "/iam/v1/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yandexPassportOauthToken: oauth }),
  }, 20000);
  const token = j && j.iamToken;
  if (!token) {
    const e = new Error("Обмен OAuth → IAM не вернул токен (ответ: " + JSON.stringify(j).slice(0, 200) + ")");
    e.status = 401;
    throw e;
  }
  const expiresAtMs = j.expiresAt ? Date.parse(String(j.expiresAt)) : 0;
  iamCache = { token, expiresAtMs: expiresAtMs || Date.now() + 12 * 3600 * 1000 };
  return { token: iamCache.token, expiresAtMs: iamCache.expiresAtMs };
}

async function getIamToken(oauthToken, force) {
  return (await getIamTokenInfo(oauthToken, force)).token;
}

// Обнулить кэш IAM-токена (после смены/удаления OAuth-токена).
function resetIamCache() {
  iamCache = null;
}

// ── Облака и каталоги ───────────────────────────────────────────────────────
// Сетевые сбои повторяем — они, в отличие от 401/403/404, проходят со второй попытки.
async function retryNet(fn, tries) {
  const n = Math.max(1, tries || 2);
  let last = null;
  for (let i = 0; i < n; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isNetworkError(e) || i === n - 1) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}

async function listClouds(oauthToken) {
  const token = await getIamToken(oauthToken);
  const base = (await endpoint("resource-manager")) || KNOWN_ENDPOINTS["resource-manager"];
  const j = await retryNet(() =>
    fetchJson(base + "/resource-manager/v1/clouds?pageSize=1000", {
      headers: { Authorization: "Bearer " + token },
    }, 12000)
  );
  const clouds = Array.isArray(j && j.clouds) ? j.clouds : [];
  return clouds.map((c) => ({ id: c.id, name: c.name || "" }));
}

async function listFolders(oauthToken, cloudId) {
  const token = await getIamToken(oauthToken);
  const base = (await endpoint("resource-manager")) || KNOWN_ENDPOINTS["resource-manager"];
  const q = cloudId ? "cloudId=" + encodeURIComponent(cloudId) + "&pageSize=1000" : "pageSize=1000";
  const j = await retryNet(() =>
    fetchJson(base + "/resource-manager/v1/folders?" + q, {
      headers: { Authorization: "Bearer " + token },
    }, 12000)
  );
  const folders = Array.isArray(j && j.folders) ? j.folders : [];
  return folders.map((f) => ({ id: f.id, name: f.name || "", cloudId: f.cloudId || "" }));
}

// ── Сервисы дашборда ────────────────────────────────────────────────────────
// Каждый сервис: key (для IPC), title, icon (emoji), svc (id эндпоинта),
// listPath (GET list по каталогу), listKey (поле массива в ответе).
const SERVICES = [
  { key: "apiGateway", title: "API Gateway", icon: "🔀", svc: "serverless-apigateway", listPath: "/apigateways/v1/apigateways", listKey: "apigateways" },
  { key: "certificateManager", title: "Certificate Manager", icon: "🔐", svc: "certificate-manager", listPath: "/certificate-manager/v1/certificates", listKey: "certificates" },
  { key: "cdn", title: "Cloud CDN", icon: "🌍", svc: "cdn", listPath: "/cdn/v1/resources", listKey: "resources" },
  { key: "dns", title: "Cloud DNS", icon: "🌐", svc: "dns", listPath: "/dns/v1/zones", listKey: "zones" },
  { key: "logging", title: "Cloud Logging", icon: "📜", svc: "logging", listPath: "/logging/v1/logGroups", listKey: "groups" },
  // Cloud Postbox — это SES-совместимый API (Amazon SES v2), а НЕ обычный REST
  // каталога: путь /postbox/v1/addresses не существует (проверено — быстрый 404),
  // список адресов — GET /v2/email/identities, авторизация — X-YaCloud-SubjectToken
  // с IAM-токеном СЕРВИСНОГО аккаунта (роль postbox.viewer), Authorization не нужен.
  { key: "postbox", title: "Cloud Postbox", icon: "📮", svc: "postbox", listPath: "/v2/email/identities", listKey: "Identities", auth: "subject", query: "ses" },
  { key: "containerRegistry", title: "Container Registry", icon: "📦", svc: "container-registry", listPath: "/container-registry/v1/registries", listKey: "registries" },
  { key: "iam", title: "Identity and Access Management", icon: "🗝️", svc: "iam", listPath: "/iam/v1/serviceAccounts", listKey: "serviceAccounts" },
  { key: "lockbox", title: "Lockbox", icon: "🔒", svc: "lockbox", listPath: "/lockbox/v1/secrets", listKey: "secrets" },
  { key: "ydb", title: "Managed Service for YDB", icon: "🗄️", svc: "ydb", listPath: "/ydb/v1/databases", listKey: "databases" },
  { key: "storage", title: "Object Storage", icon: "🪣", svc: "storage-api", listPath: "/storage/v1/buckets", listKey: "buckets" },
  { key: "serverlessContainers", title: "Serverless Containers", icon: "☁️", svc: "serverless-containers", listPath: "/containers/v1/containers", listKey: "containers" },
  { key: "vpc", title: "Virtual Private Cloud", icon: "🕸️", svc: "vpc", listPath: "/vpc/v1/networks", listKey: "networks" },
];

function serviceByKey(key) {
  return SERVICES.find((s) => s.key === key) || null;
}

// Заголовки авторизации сервиса. Postbox (SES) ждёт IAM-токен в
// X-YaCloud-SubjectToken; все остальные сервисы — обычный Bearer.
function serviceHeaders(svcDef, token) {
  return svcDef && svcDef.auth === "subject"
    ? { "X-YaCloud-SubjectToken": token }
    : { Authorization: "Bearer " + token };
}

// Строка запроса. SES живёт по своим правилам (PageSize вместо folderId/pageSize).
function serviceQuery(svcDef, folderId) {
  if (svcDef && svcDef.query === "ses") return "?PageSize=100";
  const q = folderId ? "folderId=" + encodeURIComponent(folderId) + "&pageSize=1000" : "pageSize=1000";
  return "?" + q;
}

// Массив ресурсов из ответа: точное имя поля, затем то же имя в другом регистре
// (SES отдаёт Identities, каталог — lowercase), затем сам ответ, если это массив.
function pickList(body, key) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body[key])) return body[key];
  const lower = String(key).toLowerCase();
  for (const k of Object.keys(body)) {
    if (k.toLowerCase() === lower && Array.isArray(body[k])) return body[k];
  }
  return [];
}

// Почему 403 у SES-сервиса: пользовательский OAuth-токен такой API не принимает,
// нужен сервисный аккаунт. Иначе агент видел бы просто «Нет доступа (403)» и шёл
// искать права пользователя, которых там нет.
function serviceForbidden(svcDef, e) {
  if (!svcDef || svcDef.auth !== "subject" || !e || e.status !== 403) return "";
  return (
    "Нет доступа (403) к «" + svcDef.title + "»: этому API нужен IAM-токен СЕРВИСНОГО аккаунта с ролью postbox.viewer — " +
    "пользовательский OAuth-токен Postbox не принимает. Создай сервисный аккаунт в консоли Yandex Cloud."
  );
}

// Список всех ресурсов каталога по одному сервису. Возвращает { count, items }.
async function listService(oauthToken, folderId, svcDef, opts) {
  const o = opts || {};
  const token = await getIamToken(oauthToken);
  const base = (await endpoint(svcDef.svc)) || KNOWN_ENDPOINTS[svcDef.svc];
  if (!base) throw new Error("Эндпоинт сервиса «" + svcDef.title + "» не найден.");
  const url = base + svcDef.listPath + serviceQuery(svcDef, folderId);
  const headers = serviceHeaders(svcDef, token);
  const tries = Math.max(1, o.retries == null ? 2 : parseInt(o.retries, 10) || 1);
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const j = await fetchJson(url, { headers }, o.timeoutMs || 25000);
      const items = pickList(j, svcDef.listKey);
      return { count: items.length, items };
    } catch (e) {
      lastErr = e;
      // Повторяем только то, что может пройти со второй попытки.
      const retriable = isNetworkError(e) || (e && e.status >= 500) || (e && e.status === 429);
      if (!retriable || i === tries - 1) break;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw new Error(serviceForbidden(svcDef, lastErr) || serviceError(lastErr, base, svcDef.listPath));
}

// Дашборд: все сервисы разом (каждый независимо). Возвращает массив
// { key, title, icon, ok, count, error }.
async function resourcesStatus(oauthToken, folderId, opts) {
  // Раньше все 13 сервисов опрашивались залпом: поодиночке каждый отвечает,
  // а вместе — таймауты. Идём небольшими пачками (по умолчанию 3).
  // Таймаут для дашборда короткий и без повторов: карточка со сбоем лучше, чем
  // минуты ожидания (серийный вызов может позволить себе 25 с и 2 попытки).
  const o = Object.assign({ timeoutMs: 12000, retries: 1 }, opts || {});
  const batch = Math.max(1, Math.min(parseInt(o.batch, 10) || 3, SERVICES.length));
  await getIamToken(oauthToken); // обмен токена — один раз до опроса
  const out = [];
  for (let i = 0; i < SERVICES.length; i += batch) {
    const chunk = SERVICES.slice(i, i + batch);
    const res = await Promise.all(
      chunk.map(async (svcDef) => {
        try {
          const r = await listService(oauthToken, folderId, svcDef, o);
          return { key: svcDef.key, title: svcDef.title, icon: svcDef.icon, ok: true, count: r.count, items: r.items, error: "" };
        } catch (e) {
          return { key: svcDef.key, title: svcDef.title, icon: svcDef.icon, ok: false, count: 0, items: [], error: (e && e.message) || String(e) };
        }
      })
    );
    out.push(...res);
  }
  return out;
}

// ── Создание и удаление ресурсов ────────────────────────────────────────────
// Какие сервисы можно создать из приложения (простые ресурсы с минимумом полей).
const CREATABLE = {
  ydb: {
    path: "/ydb/v1/databases",
    body: (folderId, name) => ({ folderId, name, serverlessDatabase: {} }),
    hint: "Serverless-база: оплата только за реальные запросы/хранилище",
  },
  lockbox: {
    path: "/lockbox/v1/secrets",
    body: (folderId, name) => ({ folderId, name }),
    hint: "Хранилище секретов (ключи, пароли, токены)",
  },
  containerRegistry: {
    path: "/container-registry/v1/registries",
    body: (folderId, name) => ({ folderId, name }),
    hint: "Реестр Docker-образов для Serverless Containers",
  },
  storage: {
    path: "/storage/v1/buckets",
    body: (folderId, name) => ({ folderId, name }),
    hint: "Бакет Object Storage для файлов и статики",
  },
  dns: {
    path: "/dns/v1/zones",
    body: (folderId, name) => ({ folderId, zone: name.replace(/\.$/, "") + ".", publicVisibility: {} }),
    hint: "Публичная DNS-зона (например example.com)",
  },
  serverlessContainers: {
    path: "/containers/v1/containers",
    body: (folderId, name) => ({ folderId, name }),
    hint: "Контейнер для запуска приложения (образ деплоится отдельно)",
  },
  vpc: {
    path: "/vpc/v1/networks",
    body: (folderId, name) => ({ folderId, name }),
    hint: "Виртуальная сеть с подсетями",
  },
};

function creatableKeys() {
  return Object.keys(CREATABLE);
}

// Создать ресурс. Возвращает { ok, resourceId, name, message }.
async function createResource(oauthToken, folderId, serviceKey, name) {
  const svcDef = serviceByKey(serviceKey);
  const maker = CREATABLE[serviceKey];
  if (!svcDef || !maker) throw new Error("Создание «" + (serviceKey || "?") + "» из приложения пока не поддерживается — создай в консоли Yandex Cloud.");
  const nm = String(name || "").trim();
  if (!nm) throw new Error("Укажи имя ресурса.");
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i.test(nm)) {
    throw new Error("Имя может содержать только латиницу, цифры и дефис (2–63 символа), начинаться и заканчиваться буквой/цифрой.");
  }
  const token = await getIamToken(oauthToken);
  const base = await endpoint(svcDef.svc) || KNOWN_ENDPOINTS[svcDef.svc];
  const j = await fetchJson(base + maker.path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(maker.body(folderId, nm)),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 180000);
  return { ok: true, resourceId: (j && j.id) || "", name: nm, message: "Ресурс «" + nm + "» создан (операция завершена)." };
}

// Удалить ресурс по id. DELETE <base><listPath>/<id>.
async function deleteResource(oauthToken, serviceKey, resourceId) {
  const svcDef = serviceByKey(serviceKey);
  if (!svcDef) throw new Error("Неизвестный сервис: " + serviceKey);
  const id = String(resourceId || "").trim();
  if (!id) throw new Error("Не указан id ресурса.");
  const token = await getIamToken(oauthToken);
  const base = await endpoint(svcDef.svc) || KNOWN_ENDPOINTS[svcDef.svc];
  const j = await fetchJson(base + svcDef.listPath + "/" + encodeURIComponent(id), {
    method: "DELETE",
    headers: { Authorization: "Bearer " + token },
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 120000);
  return { ok: true, message: "Ресурс удалён." };
}

// Ожидание завершения операции (поллинг каждые 2 сек).
async function waitOperation(oauthToken, operationId, timeoutMs) {
  if (!operationId) return;
  const token = await getIamToken(oauthToken);
  const base = await endpoint("operation") || KNOWN_ENDPOINTS.operation;
  const deadline = Date.now() + (timeoutMs || 180000);
  let lastMsg = "";
  let first = true;
  while (Date.now() < deadline) {
    // Первая проверка — сразу: операция создания/удаления нередко уже завершена,
    // а сон до неё добавлял гарантированные 2 секунды к каждому созданию.
    if (!first) await new Promise((r) => setTimeout(r, 2000));
    first = false;
    try {
      const j = await fetchJson(base + "/operations/" + encodeURIComponent(operationId), {
        headers: { Authorization: "Bearer " + token },
      }, 15000);
      if (j && j.done) {
        if (j.error) {
          const e = new Error("Операция завершилась ошибкой: " + ((j.error.message || "") || JSON.stringify(j.error).slice(0, 300)));
          e.status = 400;
          throw e;
        }
        return;
      }
      lastMsg = "операция ещё выполняется";
    } catch (e) {
      if (e && e.status === 404) return; // операция уже не находится — считаем завершённой
      lastMsg = (e && e.message) || String(e);
    }
  }
  throw new Error("Операция не завершилась за отведённое время (" + Math.round(timeoutMs / 1000) + " с). Проверь результат в консоли Yandex Cloud: " + lastMsg);
}

// ── Тест подключения: токен валиден? Есть ли каталог? ───────────────────────
async function testAuth(oauthToken, folderId) {
  const clouds = await listClouds(oauthToken);
  const folders = await listFolders(oauthToken, clouds[0] && clouds[0].id);
  let folderOk = false;
  if (folderId) {
    try {
      await getIamToken(oauthToken);
      folderOk = true;
    } catch {}
  }
  return { clouds, folders, folderOk };
}

// ── Деплой-конвейер: папка проекта → Serverless Containers ───────────────────
// Шаги (выполняются в main.js, здесь — только REST-части):
//   ensureRegistry → docker build/push (CLI) → ensureContainer →
//   ensureServiceAccount + роль на каталог → deployContainerRevision → url.

function slugify(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "app";
}

async function findRegistry(oauthToken, folderId, name) {
  const token = await getIamToken(oauthToken);
  const base = await endpoint("container-registry") || KNOWN_ENDPOINTS["container-registry"];
  const j = await fetchJson(base + "/container-registry/v1/registries?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000", {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  const regs = Array.isArray(j && j.registries) ? j.registries : [];
  return regs.find((r) => r.name === name) || null;
}

async function ensureRegistry(oauthToken, folderId, name) {
  const existing = await findRegistry(oauthToken, folderId, name);
  if (existing) return existing;
  const token = await getIamToken(oauthToken);
  const base = await endpoint("container-registry") || KNOWN_ENDPOINTS["container-registry"];
  const j = await fetchJson(base + "/container-registry/v1/registries", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ folderId, name }),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 120000);
  return findRegistry(oauthToken, folderId, name);
}

async function findContainer(oauthToken, folderId, name) {
  const token = await getIamToken(oauthToken);
  const base = await endpoint("serverless-containers") || KNOWN_ENDPOINTS["serverless-containers"];
  const j = await fetchJson(base + "/containers/v1/containers?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000", {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  const list = Array.isArray(j && j.containers) ? j.containers : [];
  return list.find((c) => c.name === name) || null;
}

async function ensureContainer(oauthToken, folderId, name) {
  const existing = await findContainer(oauthToken, folderId, name);
  if (existing) return existing;
  const r = await createResource(oauthToken, folderId, "serverlessContainers", name);
  return findContainer(oauthToken, folderId, name);
}

// ── Serverless Containers: глубокий слой (обзор → редактор → ревизии) ───────
// Раньше здесь был только Container.Get из трёх полей, поэтому «зайти внутрь»
// контейнера агент не мог. Консоль YC работает так: «Обзор» = Container.Get,
// «Редактор» = настройки последней ревизии (ListRevisions/GetRevision) плюс
// Container.Update, «Создать ревизию» = DeployRevision с префиллом из текущей
// ревизии, «Ревизии» = список с откатом (Container.Rollback). Методы и поля
// сверены по REST-справочнику:
//   GET   /containers/v1/containers/{containerId}
//   PATCH /containers/v1/containers/{containerId}          { updateMask, name, description, labels }
//   POST  /containers/v1/containers/{containerId}:rollback { revisionId }
//   GET   /containers/v1/revisions?containerId=…&filter=…
//   GET   /containers/v1/revisions/{containerRevisionId}
//   POST  /containers/v1/revisions:deploy
// Замечание по API: ревизию удалить нельзя (в сервисе нет DeleteRevision) —
// «переключить» контейнер можно только откатом на другую ревизию.
async function scBase(oauthToken) {
  return (await endpoint("serverless-containers")) || KNOWN_ENDPOINTS["serverless-containers"];
}

// Полный объект контейнера: id, folderId, createdAt, name, description, labels,
// url, status (CREATING | ACTIVE | DELETING | ERROR).
async function getContainer(oauthToken, containerId) {
  const id = String(containerId || "").trim();
  if (!id) throw new Error("Не указан id контейнера.");
  const token = await getIamToken(oauthToken);
  const base = await scBase(oauthToken);
  const j = await fetchJson(base + "/containers/v1/containers/" + encodeURIComponent(id), {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  return j || {};
}

// Краткая карточка контейнера (совместима с прежним containerInfo).
async function containerInfo(oauthToken, containerId) {
  const c = await getContainer(oauthToken, containerId);
  return {
    id: c.id,
    name: c.name,
    url: c.url,
    status: c.status,
    description: c.description || "",
    labels: c.labels || {},
    folderId: c.folderId || "",
    createdAt: c.createdAt || "",
  };
}

// Редактор контейнера: имя, описание, метки. updateMask перечисляет ТОЛЬКО те
// поля, которые реально меняем: без него сервис сбросил бы остальные поля в
// значения по умолчанию, то есть правка меток стирала бы описание.
async function updateContainer(oauthToken, containerId, patch) {
  const id = String(containerId || "").trim();
  if (!id) throw new Error("Не указан id контейнера.");
  const p = patch || {};
  const body = {};
  const mask = [];
  if (p.name != null) { body.name = String(p.name).trim(); mask.push("name"); }
  if (p.description != null) { body.description = String(p.description).slice(0, 256); mask.push("description"); }
  if (p.labels != null) {
    const labels = {};
    for (const k of Object.keys(p.labels || {})) labels[String(k)] = String(p.labels[k]);
    body.labels = labels;
    mask.push("labels");
  }
  if (!mask.length) throw new Error("Нечего менять: укажи name, description или labels.");
  body.updateMask = mask.join(",");
  const token = await getIamToken(oauthToken);
  const base = await scBase(oauthToken);
  const j = await fetchJson(base + "/containers/v1/containers/" + encodeURIComponent(id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(body),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 120000);
  return getContainer(oauthToken, id);
}

// Ревизии контейнера (или всего каталога). От свежих к старым.
// filter: только по полям Revision.status и Revision.runtime, например status="ACTIVE".
async function listRevisions(oauthToken, opts) {
  const o = opts || {};
  const containerId = String(o.containerId || "").trim();
  const folderId = String(o.folderId || "").trim();
  if (!containerId && !folderId) throw new Error("Нужен containerId или folderId.");
  const token = await getIamToken(oauthToken);
  const base = await scBase(oauthToken);
  const q = new URLSearchParams();
  if (containerId) q.set("containerId", containerId);
  else q.set("folderId", folderId);
  q.set("pageSize", String(Math.min(Math.max(parseInt(o.pageSize, 10) || 100, 1), 1000)));
  if (o.filter) q.set("filter", String(o.filter));
  const j = await fetchJson(base + "/containers/v1/revisions?" + q.toString(), {
    headers: { Authorization: "Bearer " + token },
  }, 25000);
  return Array.isArray(j && j.revisions) ? j.revisions : [];
}

async function getRevision(oauthToken, revisionId) {
  const id = String(revisionId || "").trim();
  if (!id) throw new Error("Не указан id ревизии.");
  const token = await getIamToken(oauthToken);
  const base = await scBase(oauthToken);
  const j = await fetchJson(base + "/containers/v1/revisions/" + encodeURIComponent(id), {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  return j || {};
}

// Откат контейнера на выбранную ревизию (в консоли — «сделать активной»).
async function rollbackContainer(oauthToken, containerId, revisionId) {
  const cid = String(containerId || "").trim();
  const rid = String(revisionId || "").trim();
  if (!cid || !rid) throw new Error("Нужны containerId и revisionId (список ревизий — action: revisions).");
  const token = await getIamToken(oauthToken);
  const base = await scBase(oauthToken);
  const j = await fetchJson(base + "/containers/v1/containers/" + encodeURIComponent(cid) + ":rollback", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ revisionId: rid }),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 180000);
  return true;
}

// Длительность вида "30s" → 30 (секунды).
function parseDurationSec(d) {
  const m = /^([0-9.]+)s$/.exec(String(d || ""));
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Сводка ревизии — ровно то, что показывает «Редактор» в консоли, в нормальном
// виде (байты → МБ, длительность → секунды), чтобы агент не пересчитывал в уме.
function revisionSummary(rev) {
  const r = rev || {};
  const img = r.image || {};
  const res = r.resources || {};
  const mem = parseInt(res.memory, 10);
  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
  return {
    id: r.id || "",
    containerId: r.containerId || "",
    status: r.status || "",
    createdAt: r.createdAt || "",
    description: r.description || "",
    image: img.imageUrl || "",
    imageDigest: img.imageDigest || "",
    command: (img.command && img.command.command) || [],
    args: (img.args && img.args.args) || [],
    workingDir: img.workingDir || "",
    env: img.environment || {},
    memoryMb: Number.isFinite(mem) ? Math.round(mem / 1024 / 1024) : null,
    cores: num(res.cores),
    coreFraction: num(res.coreFraction),
    timeoutSec: parseDurationSec(r.executionTimeout),
    concurrency: num(r.concurrency),
    serviceAccountId: r.serviceAccountId || "",
    networkId: (r.connectivity && r.connectivity.networkId) || "",
    minInstances: (r.provisionPolicy && num(r.provisionPolicy.minInstances)) || 0,
    secrets: Array.isArray(r.secrets)
      ? r.secrets.map((s) => ({ id: s.id || "", versionId: s.versionId || "", key: s.key || "", environmentVariable: s.environmentVariable || "" }))
      : [],
    logGroupId: (r.logOptions && r.logOptions.logGroupId) || "",
    logDisabled: !!(r.logOptions && r.logOptions.disabled),
    logMinLevel: (r.logOptions && r.logOptions.minLevel) || "",
    maxInstancesPerZone: (r.scalingPolicy && num(r.scalingPolicy.zoneInstancesLimit)) || 0,
    maxRequestsPerZone: (r.scalingPolicy && num(r.scalingPolicy.zoneRequestsLimit)) || 0,
    runtime: r.runtime && r.runtime.task ? "task" : "http",
    mounts: Array.isArray(r.mounts)
      ? r.mounts.map((m) => ({ path: m.mountPointPath || "", mode: m.mode || "", bucketId: (m.objectStorage && m.objectStorage.bucketId) || "" }))
      : [],
    storageMounts: Array.isArray(r.storageMounts)
      ? r.storageMounts.map((m) => ({ bucketId: m.bucketId || "", prefix: m.prefix || "", path: m.mountPointPath || "", readOnly: !!m.readOnly }))
      : [],
  };
}

// «Создать ревизию» как в консоли: настройки берутся из последней ревизии, а то,
// что передали явно — их переопределяет. Переменные окружения ДОБАВЛЯЮТСЯ к
// прежним (envReplace: true — заменить набор целиком).
function revisionToDeployOpts(rev, overrides) {
  const s = revisionSummary(rev);
  const o = overrides || {};
  const pick = (v, d) => (v == null || v === "" ? d : v);
  return {
    imageUrl: pick(o.imageUrl, s.image),
    memoryMb: pick(o.memoryMb, s.memoryMb || 256),
    cores: pick(o.cores, s.cores || 1),
    coreFraction: pick(o.coreFraction, s.coreFraction || 100),
    timeoutSec: pick(o.timeoutSec, s.timeoutSec || 30),
    concurrency: pick(o.concurrency, s.concurrency || 1),
    serviceAccountId: pick(o.serviceAccountId, s.serviceAccountId),
    networkId: pick(o.networkId, s.networkId),
    minInstances: pick(o.minInstances, s.minInstances || 0),
    env: o.envReplace === true ? (o.env || {}) : Object.assign({}, s.env, o.env || {}),
    command: o.command != null ? o.command : s.command,
    args: o.args != null ? o.args : s.args,
    workingDir: pick(o.workingDir, s.workingDir),
    secrets: o.secrets != null ? o.secrets : s.secrets,
    runtime: pick(o.runtime, s.runtime || "http"),
    maxInstancesPerZone: pick(o.maxInstancesPerZone, s.maxInstancesPerZone || 0),
    maxRequestsPerZone: pick(o.maxRequestsPerZone, s.maxRequestsPerZone || 0),
    logGroupId: pick(o.logGroupId, s.logGroupId),
    logDisabled: o.logDisabled != null ? !!o.logDisabled : s.logDisabled,
    logMinLevel: pick(o.logMinLevel, s.logMinLevel),
    mounts: o.mounts != null ? o.mounts : s.mounts,
    storageMounts: o.storageMounts != null ? o.storageMounts : s.storageMounts,
    description: o.description,
    folderId: o.folderId,
  };
}

// Деплой ревизии контейнера (POST /containers/v1/revisions:deploy).
// opts: { containerId, folderId, imageUrl, description?, serviceAccountId?, memoryMb?,
//   cores?, coreFraction?, timeoutSec?, concurrency?, env?, command?, args?, workingDir?,
//   networkId?, minInstances?, secrets?, logOptions?, scalingPolicy?, storageMounts?,
//   mounts?, runtime?, asyncInvocationServiceAccountId? }
async function deployContainerRevision(oauthToken, opts) {
  const o = opts || {};
  const containerId = String(o.containerId || "").trim();
  if (!containerId) throw new Error("Не указан containerId — для какого контейнера создавать ревизию.");
  const imageUrl = String(o.imageUrl || "").trim();
  if (!imageUrl) throw new Error("Не указан образ (imageUrl) для ревизии, например cr.yandex/<registry-id>/<image>:latest.");
  const token = await getIamToken(oauthToken);
  const base = await scBase(oauthToken);
  const memoryMb = Math.max(128, Math.min(parseInt(o.memoryMb, 10) || 256, 8192));
  const cores = Math.min(Math.max(parseInt(o.cores, 10) || 1, 1), 4);
  // Доля ядра: у многоядерных ревизий сервис принимает только 100%.
  const coreFraction = cores > 1 ? 100 : Math.min(Math.max(parseInt(o.coreFraction, 10) || 100, 5), 100);
  const timeoutSec = Math.min(Math.max(parseInt(o.timeoutSec, 10) || 30, 1), 600);
  const body = {
    containerId,
    description: String(o.description || "deploy " + new Date().toISOString()).slice(0, 256),
    resources: { memory: String(memoryMb * 1024 * 1024), cores: String(cores), coreFraction: String(coreFraction) },
    executionTimeout: timeoutSec + "s",
    imageSpec: { imageUrl, environment: o.env || {} },
    concurrency: String(Math.max(parseInt(o.concurrency, 10) || 1, 1)),
  };
  if (Array.isArray(o.command) && o.command.length) body.imageSpec.command = { command: o.command.map(String) };
  if (Array.isArray(o.args) && o.args.length) body.imageSpec.args = { args: o.args.map(String) };
  if (o.workingDir) body.imageSpec.workingDir = String(o.workingDir);
  if (o.serviceAccountId) body.serviceAccountId = String(o.serviceAccountId);
  // Сеть: без неё ревизия не видит ни VPC, ни управляемые базы.
  if (o.networkId) body.connectivity = { networkId: String(o.networkId) };
  const minInst = parseInt(o.minInstances, 10) || 0;
  if (minInst > 0) body.provisionPolicy = { minInstances: String(minInst) };
  if (Array.isArray(o.secrets) && o.secrets.length) {
    body.secrets = o.secrets
      .map((s) => {
        if (!s || !s.id || !s.key || !s.environmentVariable) return null;
        const out = { id: String(s.id), key: String(s.key), environmentVariable: String(s.environmentVariable) };
        if (s.versionId) out.versionId = String(s.versionId);
        return out;
      })
      .filter(Boolean);
  }
  const logOpts = {};
  if (o.logDisabled) logOpts.disabled = true;
  if (o.logGroupId) logOpts.logGroupId = String(o.logGroupId);
  else if (o.folderId) logOpts.folderId = String(o.folderId);
  if (o.logMinLevel) logOpts.minLevel = String(o.logMinLevel).toUpperCase();
  if (Object.keys(logOpts).length) body.logOptions = logOpts;
  const zoneInst = parseInt(o.maxInstancesPerZone, 10) || 0;
  const zoneReq = parseInt(o.maxRequestsPerZone, 10) || 0;
  if (zoneInst || zoneReq) {
    body.scalingPolicy = { zoneInstancesLimit: String(zoneInst), zoneRequestsLimit: String(zoneReq) };
  }
  if (Array.isArray(o.storageMounts) && o.storageMounts.length) {
    body.storageMounts = o.storageMounts
      .filter((m) => m && m.bucketId && m.mountPointPath)
      .map((m) => ({ bucketId: String(m.bucketId), prefix: String(m.prefix || ""), readOnly: !!m.readOnly, mountPointPath: String(m.mountPointPath) }));
  }
  if (Array.isArray(o.mounts) && o.mounts.length) {
    body.mounts = o.mounts
      .filter((m) => m && m.mountPointPath && m.bucketId)
      .map((m) => ({
        mountPointPath: String(m.mountPointPath),
        mode: String(m.mode || "READ_ONLY").toUpperCase() === "READ_WRITE" ? "READ_WRITE" : "READ_ONLY",
        objectStorage: { bucketId: String(m.bucketId), prefix: String(m.prefix || "") },
      }));
  }
  // Режим task: процесс из ENTRYPOINT запускается на каждый запрос (иначе http-сервер).
  if (String(o.runtime || "").toLowerCase() === "task") body.runtime = { task: {} };
  if (o.asyncInvocationServiceAccountId) {
    body.asyncInvocationConfig = { serviceAccountId: String(o.asyncInvocationServiceAccountId) };
  }
  const j = await fetchJson(base + "/containers/v1/revisions:deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify(body),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 240000);
  return j;
}

// ── Сервисный аккаунт + роль на каталог (для публичного вызова контейнера) ──
async function findServiceAccount(oauthToken, folderId, name) {
  const token = await getIamToken(oauthToken);
  const base = await endpoint("iam") || KNOWN_ENDPOINTS.iam;
  const j = await fetchJson(base + "/iam/v1/serviceAccounts?folderId=" + encodeURIComponent(folderId) + "&pageSize=1000", {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  const list = Array.isArray(j && j.serviceAccounts) ? j.serviceAccounts : [];
  return list.find((s) => s.name === name) || null;
}

async function ensureServiceAccount(oauthToken, folderId, name) {
  const existing = await findServiceAccount(oauthToken, folderId, name);
  if (existing) return existing;
  const token = await getIamToken(oauthToken);
  const base = await endpoint("iam") || KNOWN_ENDPOINTS.iam;
  const j = await fetchJson(base + "/iam/v1/serviceAccounts", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ folderId, name, description: "Создан приложением AI Developer Agent для Serverless Containers" }),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 120000);
  return findServiceAccount(oauthToken, folderId, name);
}

// Добавить роль субъекту НА каталог (delta ADD — остальные роли не трогает).
async function addRoleOnFolder(oauthToken, folderId, saId, roleId) {
  const token = await getIamToken(oauthToken);
  const base = await endpoint("resource-manager") || KNOWN_ENDPOINTS["resource-manager"];
  const j = await fetchJson(base + "/resource-manager/v1/folders/" + encodeURIComponent(folderId) + ":updateAccessBindings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({
      accessBindingDeltas: [
        { action: "ADD", accessBinding: { roleId, subject: { id: saId, type: "serviceAccount" } } },
      ],
    }),
  }, 30000);
  await waitOperation(oauthToken, j && j.id, 120000);
  return true;
}

module.exports = {
  SERVICES,
  CREATABLE,
  serviceByKey,
  creatableKeys,
  loadEndpoints,
  primeEndpoints,
  endpoint,
  getIamToken,
  getIamTokenInfo,
  resetIamCache,
  retryNet,
  listClouds,
  listFolders,
  listService,
  resourcesStatus,
  pickList,
  serviceHeaders,
  serviceQuery,
  isNetworkError,
  hostOf,
  serviceError,
  createResource,
  deleteResource,
  waitOperation,
  testAuth,
  slugify,
  findRegistry,
  ensureRegistry,
  findContainer,
  ensureContainer,
  containerInfo,
  getContainer,
  updateContainer,
  listRevisions,
  getRevision,
  rollbackContainer,
  revisionSummary,
  revisionToDeployOpts,
  deployContainerRevision,
  findServiceAccount,
  ensureServiceAccount,
  addRoleOnFolder,
  _friendlyApiError: friendlyApiError,
};