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
  "vpc": "https://vpc.api.cloud.yandex.net",
  "postbox": "https://postbox.api.cloud.yandex.net",
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

async function endpoint(serviceId) {
  const ep = await loadEndpoints();
  if (ep && ep[serviceId]) return ep[serviceId];
  return KNOWN_ENDPOINTS[serviceId] || null;
}

// ── IAM-токен (OAuth → IAM, кэш с авто-обновлением) ─────────────────────────
async function getIamToken(oauthToken, force) {
  const oauth = String(oauthToken || "").trim();
  if (!oauth) {
    const e = new Error("Не указан OAuth-токен Yandex. Открой Настройки → Yandex Cloud и вставь токен.");
    e.status = 401;
    throw e;
  }
  if (!force && iamCache && Date.now() < iamCache.expiresAtMs - 60 * 1000) return iamCache.token;
  const base = await endpoint("iam") || KNOWN_ENDPOINTS.iam;
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
  return token;
}

// Обнулить кэш IAM-токена (после смены/удаления OAuth-токена).
function resetIamCache() {
  iamCache = null;
}

// ── Облака и каталоги ───────────────────────────────────────────────────────
async function listClouds(oauthToken) {
  const token = await getIamToken(oauthToken);
  const base = await endpoint("resource-manager") || KNOWN_ENDPOINTS["resource-manager"];
  const j = await fetchJson(base + "/resource-manager/v1/clouds?pageSize=1000", {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  const clouds = Array.isArray(j && j.clouds) ? j.clouds : [];
  return clouds.map((c) => ({ id: c.id, name: c.name || "" }));
}

async function listFolders(oauthToken, cloudId) {
  const token = await getIamToken(oauthToken);
  const base = await endpoint("resource-manager") || KNOWN_ENDPOINTS["resource-manager"];
  const q = cloudId ? "cloudId=" + encodeURIComponent(cloudId) + "&pageSize=1000" : "pageSize=1000";
  const j = await fetchJson(base + "/resource-manager/v1/folders?" + q, {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
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
  { key: "logging", title: "Cloud Logging", icon: "📜", svc: "logging", listPath: "/logging/v1/groups", listKey: "groups" },
  { key: "postbox", title: "Cloud Postbox", icon: "📮", svc: "postbox", listPath: "/postbox/v1/addresses", listKey: "addresses" },
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

// Список всех ресурсов каталога по одному сервису. Возвращает { count, items }.
async function listService(oauthToken, folderId, svcDef) {
  const token = await getIamToken(oauthToken);
  const base = await endpoint(svcDef.svc) || KNOWN_ENDPOINTS[svcDef.svc];
  if (!base) throw new Error("Эндпоинт сервиса «" + svcDef.title + "» не найден.");
  const q = folderId ? "folderId=" + encodeURIComponent(folderId) + "&pageSize=1000" : "pageSize=1000";
  const j = await fetchJson(base + svcDef.listPath + "?" + q, {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  const items = Array.isArray(j && j[svcDef.listKey]) ? j[svcDef.listKey] : [];
  return { count: items.length, items };
}

// Дашборд: все сервисы разом (каждый независимо). Возвращает массив
// { key, title, icon, ok, count, error }.
async function resourcesStatus(oauthToken, folderId) {
  const token = await getIamToken(oauthToken);
  const results = await Promise.allSettled(
    SERVICES.map(async (svcDef) => {
      try {
        const r = await listService(oauthToken, folderId, svcDef);
        return { key: svcDef.key, title: svcDef.title, icon: svcDef.icon, ok: true, count: r.count, items: r.items, error: "" };
      } catch (e) {
        return { key: svcDef.key, title: svcDef.title, icon: svcDef.icon, ok: false, count: 0, items: [], error: (e && e.message) || String(e) };
      }
    })
  );
  return results.map((r) => (r.status === "fulfilled" ? r.value : { ok: false, error: String(r.reason) }));
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
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
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

async function containerInfo(oauthToken, containerId) {
  const token = await getIamToken(oauthToken);
  const base = await endpoint("serverless-containers") || KNOWN_ENDPOINTS["serverless-containers"];
  const j = await fetchJson(base + "/containers/v1/containers/" + encodeURIComponent(containerId), {
    headers: { Authorization: "Bearer " + token },
  }, 20000);
  return { id: j.id, name: j.name, url: j.url, status: j.status };
}

// Деплой ревизии контейнера (POST /containers/v1/revisions:deploy).
// opts: { containerId, folderId, imageUrl, serviceAccountId?, memoryMb?, cores?, env?, timeoutSec? }
async function deployContainerRevision(oauthToken, opts) {
  const token = await getIamToken(oauthToken);
  const base = await endpoint("serverless-containers") || KNOWN_ENDPOINTS["serverless-containers"];
  const memoryMb = Math.max(128, Math.min(parseInt(opts.memoryMb, 10) || 256, 4096));
  const memory = memoryMb * 1024 * 1024; // кратно 128 МБ
  const cores = Math.min(Math.max(parseInt(opts.cores, 10) || 1, 1), 4);
  const body = {
    containerId: opts.containerId,
    description: "deploy " + new Date().toISOString(),
    resources: { memory: String(memory), cores: String(cores), coreFraction: "100" },
    executionTimeout: (opts.timeoutSec || 30) + "s",
    imageSpec: { imageUrl: opts.imageUrl, environment: opts.env || {} },
    concurrency: "1",
  };
  if (opts.serviceAccountId) body.serviceAccountId = opts.serviceAccountId;
  if (opts.folderId) body.logOptions = { folderId: opts.folderId };
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
  endpoint,
  getIamToken,
  resetIamCache,
  listClouds,
  listFolders,
  listService,
  resourcesStatus,
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
  deployContainerRevision,
  findServiceAccount,
  ensureServiceAccount,
  addRoleOnFolder,
  _friendlyApiError: friendlyApiError,
};