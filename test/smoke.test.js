"use strict";

/* ── Smoke-тесты (plain node, без фреймворков и без сети) ───────────────────
   Запуск: bun run test  (node test/smoke.test.js)
   Покрывают самые хрупкие узлы, чтобы «хирургические» правки не ломали их молча:
   - agent-core: состав инструментов (в т.ч. browser-*), системный промпт,
     нормализация имён, извлечение tool_calls, тримминг контекста;
   - secrets: разделение настроек, roundtrip записи/чтения, миграция legacy;
   - ota: сравнение версий, применение бандла, защита хеша, отказ без файлов;
   - browser-tools: состояние «браузер не запущен», карта страницы (browserSnapshot),
     клик/ввод по ref и имени вместо перебора селекторов, пароли из полей не собираются;
   - server.js: защита /api/llm (только Yandex), валидация /api/fetch.
   - highlight: подсветка кода не теряет и не искажает исходный текст.
   - chats: атомарная запись истории, .bak-восстановление, автосейв при закрытии.
   - сессия: постоянный профиль браузера, индикатор контекста, «Дописать ответ».
   - vault: менеджер паролей (поиск, отсутствие утечек паролей, подстановка входа, интерфейс).
   - yandex: логи внутренним API (REST+gRPC), автоматические YC_TOKEN/YC_CLOUD_ID/YC_FOLDER_ID, встроенный yc CLI;
     адреса сервисов (postbox/logging), повторы и пачечный опрос дашборда, свежие настройки у инструментов.
   - app-ui: стабильные ref вместо номеров [N] (клик не уезжает после перерисовки окна).
*/

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ✓ " + name);
    })
    .catch((e) => {
      failed++;
      console.error("  ✗ " + name + "\n    " + ((e && e.message) || e));
    });
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ── 1. agent-core ───────────────────────────────────────────────────────────
async function testAgentCore() {
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

  await test("TOOL_DEFINITIONS: 90+ инструментов и все browser-*", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name).filter(Boolean);
    assert.ok(names.length >= 90, "ожидалось >= 90 инструментов, есть " + names.length);
    for (const n of ["browserOpen", "browserSnapshot", "browserFill", "browserClick", "browserSelect", "browserPress", "browserText", "browserScreenshot", "browserWait", "browserClose", "browserStatus"]) {
      assert.ok(names.includes(n), "нет инструмента " + n);
    }
    // У каждого определения обязательные поля.
    for (const d of core.TOOL_DEFINITIONS) {
      assert.ok(d.function && d.function.name && d.function.description, "плохое определение: " + JSON.stringify(d.function && d.function.name));
      assert.ok(d.function.parameters && d.function.parameters.properties, "нет parameters у " + d.function.name);
    }
  });

  await test("TOOL_DEFINITIONS: app-* инструменты управления окном", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name).filter(Boolean);
    for (const n of ["appRead", "appClick", "appFill", "appSelect", "appPress", "appWait", "appScreenshot"]) {
      assert.ok(names.includes(n), "нет инструмента " + n);
    }
  });

  await test("TOOL_DEFINITIONS: память проекта и точки отката (note-* / checkpoint-*)", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name).filter(Boolean);
    for (const n of ["noteSave", "noteRead", "noteList", "noteDelete", "checkpointSave", "checkpointList", "checkpointRollback"]) {
      assert.ok(names.includes(n), "нет инструмента " + n);
    }
  });

  await test("TOOL_DEFINITIONS: applyPatch / waitUntil / gitStash / gitCherryPick / gitBlame", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name).filter(Boolean);
    for (const n of ["applyPatch", "waitUntil", "gitStash", "gitCherryPick", "gitBlame"]) {
      assert.ok(names.includes(n), "нет инструмента " + n);
    }
  });

  await test("TOOL_DEFINITIONS: semanticSearch", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name).filter(Boolean);
    assert.ok(names.includes("semanticSearch"), "нет инструмента semanticSearch");
  });

  await test("TOOL_DEFINITIONS + алиасы: gitInit (репозиторий без GitHub)", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name).filter(Boolean);
    assert.ok(names.includes("gitInit"), "нет инструмента gitInit");
    assert.strictEqual(core.normalizeToolName("git_init"), "gitInit");
    assert.strictEqual(core.normalizeToolName("gitinit"), "gitInit");
    assert.strictEqual(core.normalizeToolName("init_repo"), "gitInit");
    assert.strictEqual(core.normalizeToolName("create_repo"), "gitInit");
  });

  await test("SYSTEM_PROMPT: правила 21-23 (браузер, своё окно, остановка)", () => {
    assert.ok(core.SYSTEM_PROMPT.includes("21. Браузер (видимое окно Chromium)"), "нет правила 21");
    assert.ok(core.SYSTEM_PROMPT.includes("22. СВОЁ окно приложения (app-инструменты)"), "нет правила 22");
    assert.ok(core.SYSTEM_PROMPT.includes("23. Остановка"), "нет правила 23");
    assert.ok(core.SYSTEM_PROMPT.includes("Остановлено пользователем"), "нет текста остановки");
    assert.ok(core.SYSTEM_PROMPT.includes("appRead, appClick"), "нет имён app-* в списке");
  });

  await test("SYSTEM_PROMPT: правила 24-25 (память/чекпоинты, проверка после правок)", () => {
    assert.ok(core.SYSTEM_PROMPT.includes("24. Память проекта и точки отката"), "нет правила 24");
    assert.ok(core.SYSTEM_PROMPT.includes("noteSave/noteRead/noteList/noteDelete"), "нет имён памяти в правиле 24");
    assert.ok(core.SYSTEM_PROMPT.includes("25. Проверка после правок"), "нет правила 25");
    assert.ok(core.SYSTEM_PROMPT.includes("validateProject"), "нет validateProject в правиле 25");
  });

  await test("TOOL_DEFINITIONS + SYSTEM_PROMPT: OTA-инструменты самообновления и правило 27", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name).filter(Boolean);
    for (const n of ["otaStatus", "otaCheck", "otaRollback"]) {
      assert.ok(names.includes(n), "нет инструмента " + n);
    }
    assert.ok(core.SYSTEM_PROMPT.includes("27. Самоизменения и OTA"), "нет правила 27");
    assert.ok(core.SYSTEM_PROMPT.includes("otaStatus, otaCheck, otaRollback"), "нет OTA-имён в списке инструментов");
    assert.ok(core.SYSTEM_PROMPT.includes("src/bootstrap.js и src/ota.js"), "нет упоминания защиты критичных файлов");
  });

  await test("normalizeToolName: snake_case алиасы (в т.ч. browser-*)", () => {
    assert.strictEqual(core.normalizeToolName("browserOpen"), "browserOpen");
    assert.strictEqual(core.normalizeToolName("browser_open"), "browserOpen");
    assert.strictEqual(core.normalizeToolName("browser_click"), "browserClick");
    assert.strictEqual(core.normalizeToolName("app_read"), "appRead");
    assert.strictEqual(core.normalizeToolName("app_click"), "appClick");
    assert.strictEqual(core.normalizeToolName("write_file"), "writeFile");
  });

  await test("extractToolCallsFromText: JSON-блок из текста", () => {
    const text = '```json\n[{"name":"webSearch","arguments":{"query":"x"}}]\n```';
    const calls = core.extractToolCallsFromText(text);
    assert.ok(Array.isArray(calls) && calls.length === 1, "не извлёк вызов");
    assert.strictEqual(calls[0].name, "webSearch");
    assert.strictEqual(calls[0].args.query, "x");
  });

  await test("contextBudget/trimConversation: не ломаются", () => {
    const budget = core.contextBudget("openai", "deepseek-v4-flash");
    assert.ok(typeof budget === "number" && budget > 0, "contextBudget вернул " + budget);
    const msgs = Array.from({ length: 5 }, (_, i) => ({ role: "user", content: "m" + i }));
    const trimmed = core.trimConversation(msgs, 1000);
    assert.ok(Array.isArray(trimmed), "trimConversation вернул не массив");
  });

  await test("trimConversation: осиротевшие tool-сообщения выбрасываются", () => {
    // Цепочка инструментов без нового user-сообщения: после обрезки хвост может
    // остаться без assistant(tool_calls) — такие tool-сообщения валидны только сразу
    // после assistant с tool_calls, иначе провайдер отвечает 400 wrong_api_format.
    const msgs = [
      { role: "user", content: "сделай" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "runCommand", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "readFile", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c2", content: "file" },
      { role: "assistant", content: "готово", tool_calls: null },
    ];
    // Маленький бюджет — срез придётся на середину цепочки инструментов
    const trimmed = core.trimConversation(msgs, 1500);
    const roles = trimmed.map((m) => m.role);
    // Никакое tool-сообщение не должно идти первым или без предшествующего assistant с tool_calls
    assert.notStrictEqual(roles[0], "tool", "история начинается с tool: " + JSON.stringify(roles));
    for (let i = 0; i < roles.length; i++) {
      if (roles[i] === "tool") {
        const prev = trimmed[i - 1];
        assert.ok(
          prev && prev.role === "assistant" && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0,
          "tool без предшествующего assistant(tool_calls) на позиции " + i + ": " + JSON.stringify(roles)
        );
      }
    }
  });

  await test("trimConversation: длинная цепочка инструментов без нового user валидна", () => {
    // Многораундовый агентный цикл: после исходного user идут только пары
    // assistant(tool_calls) → tool без новых user-сообщений. Срез падает на середину
    // цепочки — санитайзер не должен оставить tool без предшествующего assistant.
    const msgs = [{ role: "user", content: "сделай всё" }];
    for (let i = 1; i <= 12; i++) {
      msgs.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c" + i, type: "function", function: { name: "runCommand", arguments: "{}" } }],
      });
      msgs.push({ role: "tool", tool_call_id: "c" + i, content: "result ".repeat(60) });
    }
    const trimmed = core.trimConversation(msgs, 1500);
    const roles = trimmed.map((m) => m.role);
    assert.ok(roles.length >= 1, "история пуста после обрезки");
    assert.notStrictEqual(roles[0], "tool", "история начинается с tool: " + JSON.stringify(roles));
    for (let i = 0; i < roles.length; i++) {
      if (roles[i] === "tool") {
        const prev = trimmed[i - 1];
        assert.ok(
          prev && prev.role === "assistant" && Array.isArray(prev.tool_calls) && prev.tool_calls.length > 0,
          "tool без предшествующего assistant(tool_calls) на позиции " + i + ": " + JSON.stringify(roles)
        );
      }
    }
  });

  await test("sanitizeToolPairs: экспорт и удаление сирот без обрезки", () => {
    // Прямой доступ к санитайзеру — защита срабатывает и когда обрезка контекста
    // не нужна (под-бюджетный путь manage() / финальный предохранитель перед запросом).
    assert.strictEqual(typeof core.sanitizeToolPairs, "function", "sanitizeToolPairs не экспортирован");
    const msgs = [
      { role: "tool", tool_call_id: "x1", content: "сирота без assistant" },
      { role: "user", content: "привет" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "runCommand", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "tool", tool_call_id: "c2", content: "сирота после валидной пары" },
      { role: "assistant", content: "готово" },
    ];
    const out = core.sanitizeToolPairs(msgs);
    const roles = out.map((m) => m.role);
    // Первый tool — сирота (удалён), второй tool (c2) идёт сразу после валидной пары
    // и допустим: несколько tool-ответов подряд после одного assistant(tool_calls) — валидно.
    assert.deepStrictEqual(roles, ["user", "assistant", "tool", "tool", "assistant"], "роли после санитизации: " + JSON.stringify(roles));
    // Инвариант: у каждого tool последнее НЕ-tool сообщение перед ним — assistant с tool_calls
    // (несколько tool-ответов подряд после одного assistant — допустимо: N вызовов → N результатов).
    let lastNonTool = null;
    for (let i = 0; i < out.length; i++) {
      if (out[i].role !== "tool") lastNonTool = out[i];
      else {
        assert.ok(
          lastNonTool && lastNonTool.role === "assistant" && Array.isArray(lastNonTool.tool_calls) && lastNonTool.tool_calls.length > 0,
          "tool без предшествующего assistant(tool_calls) на позиции " + i
        );
      }
    }
  });

  await test("createContextManager: под-бюджетный путь тоже убирает сирот", async () => {
    const mgr = core.createContextManager({ settings: {}, planMode: true });
    const msgs = [
      { role: "tool", tool_call_id: "x", content: "сирота" },
      { role: "user", content: "сделай" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "runCommand", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ];
    const out = await mgr.manage(msgs, 1e9); // бюджет огромный — обрезка не нужна
    const roles = out.map((m) => m.role);
    assert.deepStrictEqual(roles, ["user", "assistant", "tool"], "роли под-бюджетного пути: " + JSON.stringify(roles));
  });

  await test("Gemini: thought signature захватывается из стрима (extra_content)", async () => {
    // SSE-чанк как его шлёт OpenAI-совместимый эндпоинт Gemini 3.x:
    // tool-call несёт extra_content.google.thought_signature.
    const sse =
      "data: " +
      JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  extra_content: { google: { thought_signature: "SIG123==" } },
                  function: { name: "runCommand", arguments: '{"command":"pwd"}' },
                },
              ],
            },
          },
        ],
      }) +
      "\n" +
      "data: [DONE]\n";
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });
    const calls = [];
    await core.consumeProviderStream({
      response: { body: stream },
      provider: "openai",
      onToolCall: (tc) => calls.push(tc),
    });
    assert.strictEqual(calls.length, 1, "не получен вызов инструмента");
    assert.strictEqual(calls[0].name, "runCommand");
    assert.ok(calls[0].extraContent, "нет extraContent у вызова");
    assert.strictEqual(calls[0].extraContent.google.thought_signature, "SIG123==");
  });

  await test("Gemini: assistant tool_calls эхуют extra_content в запрос", () => {
    const req = core.buildChatRequest(
      { provider: "openai", openaiUrl: "https://api.openai.com/v1", openaiApiKey: "k" },
      {
        model: "gemini-3.8-flash",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call-1", type: "function", function: { name: "runCommand", arguments: "{}" }, extra_content: { google: { thought_signature: "SIG123==" } } },
            ],
          },
          { role: "tool", tool_call_id: "call-1", content: "ok" },
        ],
      }
    );
    const body = JSON.parse(req.body);
    const asst = body.messages[1];
    assert.ok(asst.tool_calls && asst.tool_calls[0], "нет tool_calls у ассистента");
    assert.ok(asst.tool_calls[0].extra_content, "extra_content потерян при эхе");
    assert.strictEqual(asst.tool_calls[0].extra_content.google.thought_signature, "SIG123==");
  });

  await test("Gemini: signature отдельной дельтой достаётся tool-call'у", async () => {
    // Google может прислать подпись отдельным delta.extra_content до tool_calls.
    const sse =
      "data: " +
      JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", extra_content: { google: { thought_signature: "SIG456==" } } } }] }) +
      "\n" +
      "data: " +
      JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-2", type: "function", function: { name: "listFiles", arguments: "{}" } }] } }],
      }) +
      "\n" +
      "data: [DONE]\n";
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
        controller.close();
      },
    });
    const calls = [];
    await core.consumeProviderStream({
      response: { body: stream },
      provider: "openai",
      onToolCall: (tc) => calls.push(tc),
    });
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].extraContent, "нет extraContent (отдельная дельта)");
    assert.strictEqual(calls[0].extraContent.google.thought_signature, "SIG456==");
  });
  await test("friendlyRateLimitError: Groq 413 ITPM → понятное сообщение", () => {
    const msg = core.friendlyRateLimitError(
      413,
      '{"error":{"message":"Request too large for model ... ITPM: Limit 7000, Requested 19594, please reduce your message size","type":"tokens","code":"rate_limit_exceeded"}}',
      { openaiUrl: "https://api.groq.com/openai/v1" }
    );
    assert.ok(msg && msg.includes("Groq"), "нет пояснения Groq");
    assert.ok(msg.includes("7 000"), "нет лимита 7000");
    assert.ok(msg.includes("Ollama Cloud"), "нет подсказки о провайдерах");
  });

  await test("friendlyRateLimitError: не-Groq / другие статусы → null", () => {
    const groq = { openaiUrl: "https://api.groq.com/openai/v1" };
    assert.strictEqual(core.friendlyRateLimitError(413, "ITPM: Limit 7000", { openaiUrl: "https://api.deepseek.com/v1" }), null);
    assert.strictEqual(core.friendlyRateLimitError(500, "server error", groq), null);
    assert.strictEqual(core.friendlyRateLimitError(401, "unauthorized", groq), null);
    assert.strictEqual(core.friendlyRateLimitError(413, "request body too large", groq), null);
  });
}

// ── 1b. app-ui-tools ─────────────────────────────────────────────────────────
async function testAppUiTools() {
  const appUi = require(path.join(ROOT, "src", "app-ui-tools.js"));

  await test("app-ui-tools: экспорты и looksDangerous", () => {
    for (const f of ["read", "click", "fill", "select", "press", "wait", "screenshot"]) {
      assert.strictEqual(typeof appUi[f], "function", "нет экспорта " + f);
    }
    assert.ok(appUi.looksDangerous("Удалить файл"), "не поймал «Удалить»");
    assert.ok(appUi.looksDangerous("Очистить чат"), "не поймал «Очистить чат»");
    assert.ok(appUi.looksDangerous("Сбросить настройки"), "не поймал «Сбросить»");
    assert.ok(appUi.looksDangerous("Отменить изменения"), "не поймал «Отменить»");
    assert.ok(!appUi.looksDangerous("Настройки"), "ложный сработал на «Настройки»");
    assert.ok(!appUi.looksDangerous("Сохранить"), "ложный сработал на «Сохранить»");
    assert.ok(!appUi.looksDangerous(""), "пустая строка опасна");
  });

  await test("app-ui-tools: без окна → понятная ошибка", async () => {
    let msg = "";
    try {
      await appUi.read({}, null);
    } catch (e) {
      msg = e && e.message ? e.message : String(e);
    }
    assert.ok(/десктоп|недоступно/i.test(msg), "read(null) вернул: " + msg.slice(0, 80));
  });
}

// ── 1.5 agent-store: память проекта и точки отката ────────────────────────────
async function testAgentStore() {
  const store = require(path.join(ROOT, "src", "agent-store.js"));

  await test("agent-store: заметки roundtrip (save/read/list/delete), разделение по проектам", () => {
    const userData = tmpdir("as-mem-");
    const projA = path.join(userData, "projA");
    const projB = path.join(userData, "projB");
    fs.mkdirSync(projA);
    fs.mkdirSync(projB);

    const r1 = store.noteSave(userData, projA, "architecture", "Electron + Vite, main.js — агентский цикл.");
    assert.ok(r1.ok, "noteSave упал: " + (r1.error || ""));
    const r2 = store.noteSave(userData, projA, "decisions", "Никогда не пушим без спроса.");
    assert.ok(r2.ok);
    store.noteSave(userData, projB, "architecture", "Другой проект.");

    const one = store.noteRead(userData, projA, "architecture");
    assert.ok(one.ok && one.content.includes("Electron"), "noteRead по ключу: " + JSON.stringify(one));

    const all = store.noteRead(userData, projA, "");
    assert.ok(all.ok && all.notes.length === 2, "должно быть 2 заметки в projA, есть " + (all.notes && all.notes.length));
    // Свежие первыми (при равных миллисекундах порядок не важен — главное, что обе на месте).
    const keys = all.notes.map((n) => n.key).sort();
    assert.deepStrictEqual(keys, ["architecture", "decisions"]);

    const bOnly = store.noteRead(userData, projB, "");
    assert.strictEqual(bOnly.notes.length, 1, "проекты должны быть изолированы");

    const del = store.noteDelete(userData, projA, "decisions");
    assert.ok(del.ok, "noteDelete: " + (del.error || ""));
    assert.strictEqual(store.noteRead(userData, projA, "").notes.length, 1);
    assert.ok(!store.noteRead(userData, projA, "decisions").ok, "удалённая заметка всё ещё читается");
  });

  await test("agent-store: валидация заметок (key, пустота, длина)", () => {
    const userData = tmpdir("as-val-");
    const proj = path.join(userData, "p");
    fs.mkdirSync(proj);
    assert.ok(!store.noteSave(userData, proj, "плохой ключ", "x").ok, "пропустил пробел в key");
    assert.ok(!store.noteSave(userData, proj, "a/b", "x").ok, "пропустил слэш в key");
    assert.ok(!store.noteSave(userData, proj, "valid", "   ").ok, "пропустил пустой content");
    assert.ok(!store.noteSave(userData, proj, "valid", "x".repeat(store.NOTE_MAX_LEN + 1)).ok, "пропустил слишком длинный content");
    assert.ok(store.noteSave(userData, proj, "valid", "x").ok, "валидная заметка отклонена");
  });

  await test("agent-store: чекпоинт — снимок, правки, откат (пропускает .git/node_modules/бинарные)", async () => {
    const userData = tmpdir("as-cp-");
    const proj = path.join(userData, "proj");
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(path.join(proj, "src"), { recursive: true });
    fs.mkdirSync(path.join(proj, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
    fs.writeFileSync(path.join(proj, "src", "app.js"), "const a = 1;");
    fs.writeFileSync(path.join(proj, "index.html"), "<h1>hi</h1>");
    fs.writeFileSync(path.join(proj, "node_modules", "big.js"), "should not be saved");
    fs.writeFileSync(path.join(proj, ".git", "config"), "should not be saved");
    fs.writeFileSync(path.join(proj, "bin.dat"), Buffer.from([0, 1, 2, 3]));

    const saved = store.checkpointSave(userData, proj, "до правок");
    assert.ok(saved.ok, "checkpointSave: " + (saved.error || ""));
    assert.strictEqual(saved.files, 2, "в снимке должно быть 2 файла, есть " + saved.files);

    // Правки после снимка
    fs.writeFileSync(path.join(proj, "src", "app.js"), "// сломано");
    fs.writeFileSync(path.join(proj, "index.html"), "<h1>broken</h1>");
    fs.writeFileSync(path.join(proj, "new-file.txt"), "создан после чекпоинта");

    const list = store.checkpointList(userData);
    assert.ok(list.ok && list.checkpoints.length === 1, "checkpointList: " + JSON.stringify(list));

    const rb = store.checkpointRollback(userData, saved.id);
    assert.ok(rb.ok, "rollback: " + (rb.error || ""));
    assert.strictEqual(rb.restoredCount, 2);
    assert.strictEqual(fs.readFileSync(path.join(proj, "src", "app.js"), "utf8"), "const a = 1;");
    assert.strictEqual(fs.readFileSync(path.join(proj, "index.html"), "utf8"), "<h1>hi</h1>");
    // Файлы, созданные после чекпоинта, не удаляются.
    assert.ok(fs.existsSync(path.join(proj, "new-file.txt")), "rollback удалил новый файл");
  });

  await test("agent-store: чекпоинт — лимит хранения (старые вытесняются) и защита id", async () => {
    const userData = tmpdir("as-cplim-");
    const proj = path.join(userData, "proj");
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, "a.txt"), "x");
    for (let i = 0; i < 17; i++) store.checkpointSave(userData, proj, "cp" + i);
    const list = store.checkpointList(userData);
    assert.strictEqual(list.checkpoints.length, 15, "должно остаться 15 чекпоинтов, есть " + list.checkpoints.length);

    assert.ok(!store.checkpointRollback(userData, "..\\..\\settings").ok, "пропустил path traversal в id");
    assert.ok(!store.checkpointRollback(userData, "нет-такого-id").ok, "пропустил несуществующий id");
  });
}

// ── 1.6 unified-patch: применение diff ───────────────────────────────────────
async function testUnifiedPatch() {
  const up = require(path.join(ROOT, "src", "unified-patch.js"));

  await test("unified-patch: изменение существующего файла (контекст + замена)", () => {
    const dir = tmpdir("up-mod-");
    fs.writeFileSync(path.join(dir, "app.js"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const patch = [
      "diff --git a/app.js b/app.js",
      "--- a/app.js",
      "+++ b/app.js",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 20;",
      " const c = 3;",
    ].join("\n");
    const r = up.applyUnifiedPatch(dir, patch);
    assert.ok(r.ok, "apply упал: " + JSON.stringify(r.errors));
    assert.deepStrictEqual(r.changed, ["app.js"]);
    assert.strictEqual(fs.readFileSync(path.join(dir, "app.js"), "utf8"), "const a = 1;\nconst b = 20;\nconst c = 3;\n");
  });

  await test("unified-patch: создание и удаление файлов, безопасность путей", () => {
    const dir = tmpdir("up-cr-");
    const patch = [
      "diff --git a/new.js b/new.js",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.js",
      "@@ -0,0 +1,2 @@",
      "+// новый",
      "+export const x = 1;",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-старый",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "old.txt"), "старый\n");
    const r = up.applyUnifiedPatch(dir, patch);
    assert.ok(r.ok, "apply упал: " + JSON.stringify(r.errors));
    assert.strictEqual(fs.readFileSync(path.join(dir, "new.js"), "utf8"), "// новый\nexport const x = 1;");
    assert.ok(!fs.existsSync(path.join(dir, "old.txt")), "файл не удалён");

    // Path traversal не проходит
    const bad = up.applyUnifiedPatch(dir, "--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n-x\n+y\n");
    assert.ok(bad.errors.length >= 1, "пропустил traversal: " + JSON.stringify(bad));
    // Абсолютный путь тоже
    const bad2 = up.applyUnifiedPatch(dir, "--- a/" + dir.replace(/\\/g, "/") + "/secret\n+++ b/x\n@@ -1 +1 @@\n-x\n+y\n");
    assert.ok(bad2.errors.length >= 1, "пропустил абсолютный путь");
  });

  await test("unified-patch: несовпадение контекста → понятная ошибка, файл не тронут", () => {
    const dir = tmpdir("up-miss-");
    fs.writeFileSync(path.join(dir, "a.txt"), "один\nдва\n");
    const patch = "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n один\n-НЕСОВПАДЕНИЕ\n+три\n";
    const r = up.applyUnifiedPatch(dir, patch);
    assert.ok(!r.ok, "должен был упасть");
    assert.strictEqual(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "один\nдва\n");
  });
}

// ── 1.7 code-index: семантический поиск ─────────────────────────────────────
async function testCodeIndex() {
  const ci = require(path.join(ROOT, "src", "code-index.js"));

  await test("code-index: стемминг Porter сводит формы одного слова", () => {
    assert.strictEqual(ci.stem("running"), ci.stem("run"));
    assert.strictEqual(ci.stem("tokens"), ci.stem("token"));
    assert.strictEqual(ci.stem("files"), ci.stem("file"));
    assert.strictEqual(ci.stem("abc"), "abc");
    // authenticat/authentic — известная неточность Porter: не строго равны, но родственны (общий префикс).
    assert.ok(ci.tokenRelated(ci.stem("authentication"), ci.stem("authenticate")) > 0, "стеммы не родственны");
  });

  await test("code-index: токенизация разбирает camelCase/snake_case и кириллицу", () => {
    const toks = ci.tokenizeCode("getUserToken -> api_token; AUTH! 123");
    for (const t of ["get", "user", "token", "api", "auth", "123"]) {
      assert.ok(toks.includes(t), "нет токена " + t + " в " + JSON.stringify(toks));
    }
    const ru = ci.tokenizeCode("функция авторизации пользователя");
    assert.ok(ru.includes("функция") && ru.includes("авторизации"), "кириллица пропала: " + JSON.stringify(ru));
  });

  await test("code-index: BM25 — ранжирование и поиск по смыслу (auth → authenticate)", () => {
    const dir = tmpdir("ci-");
    fs.mkdirSync(path.join(dir, "src"));
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "src", "login.js"), "function authenticateUser(user, pass) { return checkPassword(user, pass); }");
    fs.writeFileSync(path.join(dir, "src", "cart.js"), "function addToCart(item) { return total + item.price; }");
    fs.writeFileSync(path.join(dir, "src", "db.js"), "export const pool = createConnection('localhost');");
    fs.writeFileSync(path.join(dir, "node_modules", "junk.js"), "authenticate should be ignored");

    const index = ci.buildIndex(dir);
    assert.strictEqual(index.docsCount, 3, "node_modules должен быть пропущен, есть " + index.docsCount);

    // «authenticating users login» — морфология + смылс: должен найти login.js, где authenticateUser.
    const hits = ci.searchIndex(index, "authenticating users login", 8);
    assert.ok(hits.length >= 1, "ничего не найдено");
    assert.strictEqual(hits[0].rel, "src/login.js", "первый результат: " + JSON.stringify(hits.map((h) => h.rel)));

    const hits2 = ci.searchIndex(index, "database connection", 8);
    assert.strictEqual(hits2[0].rel, "src/db.js", "второй запрос: " + JSON.stringify(hits2.map((h) => h.rel)));

    // Кириллица: запрос на русском находит русские комментарии/строки.
    fs.writeFileSync(path.join(dir, "src", "docs.md"), "# Подключение к базе\nпароль хранится в secrets");
    const idxRu = ci.buildIndex(dir);
    const hitsRu = ci.searchIndex(idxRu, "пароль база", 8);
    assert.strictEqual(hitsRu[0].rel, "src/docs.md", "русский запрос: " + JSON.stringify(hitsRu.map((h) => h.rel)));

    const sn = ci.snippetForFile(dir, "src/login.js", "authenticate");
    assert.ok(sn.line >= 1 && sn.text.includes("authenticateUser"), "сниппет: " + sn.text);
  });

  await test("code-index: кэш на диске (getIndex по отпечатку)", () => {
    const userData = tmpdir("ci-cache-");
    const dir = path.join(userData, "proj");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "a.txt"), "hello world");
    const idx1 = ci.getIndex(userData, dir);
    const idx2 = ci.getIndex(userData, dir);
    assert.strictEqual(idx1.docsCount, 1);
    assert.ok(idx2.docs.length === 1, "кэш не подхватился");
    // После изменения файла отпечаток меняется → пересборка
    fs.writeFileSync(path.join(dir, "a.txt"), "hello world again and again");
    const idx3 = ci.getIndex(userData, dir);
    assert.ok(idx3.docs[0].len > idx1.docs[0].len, "индекс не обновился после правки файла");
  });
}

// ── 2. secrets ──────────────────────────────────────────────────────────────
async function testSecrets() {
  const secrets = require(path.join(ROOT, "src", "secrets.js"));

  await test("splitSecrets: вынимает только секреты", () => {
    const s = { provider: "openai", openaiApiKey: "k", mobilePin: "1234", agentEnv: { P: "v" }, model: "m" };
    const { rest, sec } = secrets.splitSecrets(s);
    assert.strictEqual(rest.provider, "openai");
    assert.strictEqual(rest.model, "m");
    assert.strictEqual(rest.openaiApiKey, undefined);
    assert.strictEqual(sec.openaiApiKey, "k");
    assert.strictEqual(sec.mobilePin, "1234");
    assert.deepStrictEqual(sec.agentEnv, { P: "v" });
  });

  await test("saveSecrets/loadSecrets: roundtrip (plain-откат без safeStorage)", () => {
    const dir = tmpdir("secrets-test-");
    const file = path.join(dir, "secrets.json");
    secrets.init(file);
    secrets.saveSecrets({ openaiApiKey: "k1", agentEnv: { A: "1", B: "2" }, githubToken: "t" });
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(typeof raw.openaiApiKey === "string" && raw.openaiApiKey.startsWith("plain:"), "ключ не в plain-формате: " + raw.openaiApiKey);
    const loaded = secrets.loadSecrets();
    assert.strictEqual(loaded.openaiApiKey, "k1");
    assert.deepStrictEqual(loaded.agentEnv, { A: "1", B: "2" });
    assert.strictEqual(loaded.githubToken, "t");
  });

  await test("saveSecrets: пустые значения не пишутся", () => {
    const dir = tmpdir("secrets-test2-");
    secrets.init(path.join(dir, "secrets.json"));
    secrets.saveSecrets({ openaiApiKey: "", agentEnv: {}, githubToken: null });
    assert.ok(!fs.existsSync(path.join(dir, "secrets.json")) || fs.readFileSync(path.join(dir, "secrets.json"), "utf8").trim() === "{}", "пустые секреты записались");
  });

  await test("loadSecrets: миграция открытого текста из legacy", () => {
    const dir = tmpdir("secrets-test3-");
    const file = path.join(dir, "secrets.json");
    fs.writeFileSync(file, JSON.stringify({ openaiApiKey: "legacy-key", mobilePin: "9999" }), "utf8");
    secrets.init(file);
    const loaded = secrets.loadSecrets();
    assert.strictEqual(loaded.openaiApiKey, "legacy-key");
    assert.strictEqual(loaded.mobilePin, "9999");
  });

  secrets.init(null); // сброс, чтобы не влиять на другие тесты
}

// ── 3. ota ──────────────────────────────────────────────────────────────────
function makeBundle(dir, files, version, corrupt) {
  const filesB64 = {};
  for (const rel of Object.keys(files)) filesB64[rel] = Buffer.from(files[rel]).toString("base64");
  const bundleJson = JSON.stringify({ version, files: filesB64 });
  const manifest = {
    app: "ai-agent",
    version,
    builtAt: Date.now(),
    files: Object.keys(filesB64).length,
    sha256: crypto.createHash("sha256").update(bundleJson).digest("hex"),
  };
  if (corrupt) manifest.sha256 = "0".repeat(64);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "bundle.json"), bundleJson, "utf8");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

async function testOta() {
  const ota = require(path.join(ROOT, "src", "ota.js"));

  await test("versionGt: сравнение версий", () => {
    assert.ok(ota.versionGt("1.0.1", "1.0.0"));
    assert.ok(ota.versionGt("1.2.0", "1.1.9"));
    assert.ok(!ota.versionGt("1.0.0", "1.0.0"));
    assert.ok(!ota.versionGt("1.0.0", "1.0.1"));
  });

  await test("applyBundle: распаковка и проверка синтаксиса", async () => {
    const root = tmpdir("ota-test-");
    const srcDir = path.join(root, "src");
    fs.mkdirSync(path.join(srcDir, "renderer"), { recursive: true });
    makeBundle(srcDir, {
      "src/main.js": "console.log(1);",
      "src/renderer/index.html": "<html></html>",
    }, "9.9.9");
    process.env.AI_AGENT_OTA_ROOT = root;
    const r = await ota.applyBundle(srcDir, JSON.parse(fs.readFileSync(path.join(srcDir, "manifest.json"), "utf8")));
    assert.ok(r.ok && r.version === "9.9.9");
    const cur = ota.resolveCurrent();
    assert.ok(fs.existsSync(path.join(cur, "src", "main.js")), "main.js не распакован");
    assert.ok(fs.existsSync(path.join(cur, "version.json")), "нет version.json");
    delete process.env.AI_AGENT_OTA_ROOT;
  });

  await test("applyBundle: повреждённый хеш отклоняется", async () => {
    const root = tmpdir("ota-test2-");
    const srcDir = path.join(root, "src");
    fs.mkdirSync(path.join(srcDir, "renderer"), { recursive: true });
    makeBundle(srcDir, {
      "src/main.js": "console.log(1);",
      "src/renderer/index.html": "<html></html>",
    }, "9.9.8", true);
    process.env.AI_AGENT_OTA_ROOT = root;
    await assert.rejects(() => ota.applyBundle(srcDir, JSON.parse(fs.readFileSync(path.join(srcDir, "manifest.json"), "utf8"))), /Хеш/);
    delete process.env.AI_AGENT_OTA_ROOT;
  });

  await test("applyBundle: без обязательных файлов отклоняется", async () => {
    const root = tmpdir("ota-test3-");
    const srcDir = path.join(root, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    makeBundle(srcDir, { "src/renderer/index.html": "<html></html>" }, "9.9.7");
    process.env.AI_AGENT_OTA_ROOT = root;
    await assert.rejects(() => ota.applyBundle(srcDir, JSON.parse(fs.readFileSync(path.join(srcDir, "manifest.json"), "utf8"))), /main\.js/);
    delete process.env.AI_AGENT_OTA_ROOT;
  });
}

// ── 4. browser-tools (без браузера) ─────────────────────────────────────────
async function testBrowserTools() {
  const bt = require(path.join(ROOT, "src", "browser-tools.js"));

  await test("status: корректное сообщение без запущенного браузера", async () => {
    const s = await bt.status();
    assert.ok(typeof s === "string" && s.includes("Браузер не запущен"), "странный статус: " + s.slice(0, 60));
  });

  await test("close(all): безопасен без браузера", async () => {
    const r = await bt.close({ tabId: "all" });
    assert.ok(typeof r === "string" && r.includes("закрыты"), r);
  });

  // ── Постоянный профиль: сессии сайтов переживают перезапуск приложения ──
  // playwright подменяем заглушкой — реальный браузер в тестах не запускаем.
  const Module_ = require("module");
  const origRequire = Module_.prototype.require;
  const persistentDirs = [];
  const mkPage = (u) => ({
    _u: u || "about:blank",
    url() { return this._u; },
    async title() { return "t"; },
    async goto(x) { this._u = x; },
    on() {},
    async close() {},
    async fill() {},
    async click() {},
  });
  const fakePw = {
    chromium: {
      executablePath() { return ""; },
      async launch() {
        return { isConnected: () => true, on() {}, async newPage() { return mkPage(""); }, async close() {} };
      },
      async launchPersistentContext(dir, opts) {
        persistentDirs.push({ dir, opts });
        const pages = [mkPage("about:blank")];
        return { pages: () => pages, on() {}, async newPage() { return mkPage(""); }, async close() {} };
      },
    },
  };
  Module_.prototype.require = function (id) {
    if (id === "playwright") return fakePw;
    return origRequire.apply(this, arguments);
  };
  try {
    const dir = path.join(tmpdir("agent-profile-"), "profile");
    bt.setProfileDir(dir);
    await test("browser-tools: профиль включён → launchPersistentContext + папка на диске", async () => {
      const r = await bt.open({ url: "https://vk.com/im" });
      assert.ok(/постоянный профиль/.test(r), "движок: " + r.slice(0, 90));
      assert.strictEqual(persistentDirs.length, 1, "вызовов persistent: " + persistentDirs.length);
      assert.ok(fs.existsSync(dir), "папка профиля не создана");
    });
    await test("browser-tools: следы автоматизации скрыты (без обхода защит сайтов)", () => {
      const opts = persistentDirs[0] && persistentDirs[0].opts;
      assert.ok(opts, "не нашёл опции запуска браузера");
      assert.ok(
        (opts.ignoreDefaultArgs || []).includes("--enable-automation"),
        "не отключён флаг --enable-automation: " + JSON.stringify(opts.ignoreDefaultArgs)
      );
      assert.ok(
        (opts.args || []).includes("--disable-blink-features=AutomationControlled"),
        "нет флага AutomationControlled: " + JSON.stringify(opts.args)
      );
      assert.ok(opts.headless === false, "браузер должен быть видимым (headless=false)");
    });

    await test("browser-tools: status сообщает, что профиль постоянный", async () => {
      assert.ok(/Профиль: постоянный/.test(await bt.status()));
    });
    await test("browser-tools: очистка профиля удаляет папку", async () => {
      const m = await bt.clearProfile();
      assert.ok(/^OK/.test(m), m);
      assert.ok(!fs.existsSync(dir), "папка профиля осталась");
    });
    await test("browser-tools: профиль выключен → обычный запуск и честное сообщение", async () => {
      bt.setProfileDir("");
      assert.ok(/выключен/.test(await bt.clearProfile()));
      const r = await bt.open({ url: "https://example.com" });
      assert.ok(!/постоянный профиль/.test(r), "движок: " + r.slice(0, 90));
      assert.ok(/Профиль: временный/.test(await bt.status()));
    });
  } finally {
    Module_.prototype.require = origRequire;
    bt.setProfileDir("");
    await bt.stop().catch(() => {});
  }
}

// ── 4c. Браузерная карта страницы (browserSnapshot) и умные действия ────────
// Главное обещание: агент НЕ перебирает селекторы, а берёт ref из карты;
// при промахе инструмент сам возвращает похожие элементы с их ref.
async function testBrowserBrain() {
  const bt = require(path.join(ROOT, "src", "browser-tools.js"));
  const dom = require(path.join(ROOT, "src", "dom-map.js"));
  const Module_ = require("module");

  const EL = (spec) =>
    Object.assign(
      {
        key: "", tag: "button", type: "", id: "", cls: "", role: "button", name: "",
        label: "", placeholder: "", text: "", href: "", contenteditable: false,
        visible: true, disabled: false, checked: false, options: [], ref: "",
      },
      spec
    );
  const contains = (hay, needle) =>
    String(hay || "").toLowerCase().indexOf(String(needle || "").toLowerCase()) >= 0;
  const matchSelector = (sel, e) => {
    const ref = String(sel).match(/^\[data-agent-ref="([^"]+)"\]$/);
    if (ref) return e.ref === ref[1];
    const s = String(sel).trim();
    const tag = s.match(/^[a-zA-Z][\w-]*/);
    const id = s.match(/#([\w-]+)/);
    const cls = s.match(/\.([\w-]+)/);
    if (!tag && !id && !cls) return false;
    if (tag && e.tag !== tag[0].toLowerCase()) return false;
    if (id && e.id !== id[1]) return false;
    if (cls && String(e.cls).split(/\s+/).indexOf(cls[1]) < 0) return false;
    return true;
  };
  const fakePage = (elements) => {
    const page = {
      els: elements, clicked: [], filled: [], selected: [], typed: [],
      _u: "about:blank",
      keyboard: { press: async () => {}, insertText: async (t) => page.typed.push(t) },
      async goto(u) { page._u = u; },
      async waitForLoadState() {},
      url() { return page._u; },
      async title() { return "Тестовая страница"; },
      on() {},
      async close() {},
    };
    const by = (pred) => elements.filter(pred);
    const loc = (list) => ({
      _list: list,
      first() { return loc(list.slice(0, 1)); },
      async count() { return list.length; },
      async isVisible() { return !!(list[0] && list[0].visible); },
      async scrollIntoViewIfNeeded() {},
      async click() {
        const e = list[0];
        if (!e) throw new Error("no element");
        if (!e.visible) throw new Error("element is not visible");
        page.clicked.push(e.key);
      },
      async fill(t) {
        const e = list[0];
        if (!e) throw new Error("no element");
        if (e.contenteditable) throw new Error("Element is not an <input>, <textarea> or [contenteditable]");
        page.filled.push({ key: e.key, text: t });
      },
      async selectOption(v) {
        const e = list[0];
        if (!e) throw new Error("no element");
        if (!(e.options || []).some((o) => o.value === v)) throw new Error("did not find option");
        page.selected.push({ key: e.key, value: v });
      },
      async evaluate(fn) {
        const e = list[0];
        if (!e) throw new Error("no element");
        return fn({ options: e.options || [] });
      },
    });
    page.locator = (sel) => loc(by((e) => matchSelector(sel, e)));
    page.getByRole = (role, opts) => loc(by((e) => e.role === role && (!opts || !opts.name || contains(e.name, opts.name))));
    page.getByLabel = (t) => loc(by((e) => contains(e.label || e.ariaLabel, t)));
    page.getByPlaceholder = (t) => loc(by((e) => contains(e.placeholder, t)));
    page.getByText = (t) => loc(by((e) => contains(e.text || e.name, t)));
    // Настоящий сборщик карты пропускает невидимое — подставной ведёт себя так же.
    page.evaluate = async () => ({
      url: "https://vk.com/im",
      title: "ВК",
      items: elements.filter((e) => e.visible).map((e) => ({
        ref: e.ref,
        tag: e.tag,
        type: e.type,
        roleAttr: e.roleAttr || "",
        contenteditable: !!e.contenteditable,
        text: e.text || e.name || "",
        value: e.value || "",
        ariaLabel: e.ariaLabel || "",
        labelText: e.label,
        placeholder: e.placeholder,
        id: e.id,
        cls: e.cls,
        href: e.href,
        inViewport: e.visible,
        disabled: !!e.disabled,
        checked: !!e.checked,
      })),
    });
    return page;
  };

  const els = [
    EL({ key: "home", tag: "a", role: "link", name: "Главная", href: "/" }),
    EL({ key: "login", tag: "button", role: "button", name: "Войти", id: "login", cls: "btn primary" }),
    EL({ key: "search", tag: "input", type: "search", role: "searchbox", name: "Поиск", ariaLabel: "Поиск", placeholder: "Найти", id: "q" }),
    EL({ key: "msg", tag: "div", role: "textbox", roleAttr: "textbox", name: "Написать сообщение", contenteditable: true }),
    EL({ key: "city", tag: "select", role: "combobox", label: "Город", id: "city", options: [{ value: "msk", text: "Москва" }, { value: "tula", text: "Тула" }] }),
    EL({ key: "captcha", tag: "input", type: "checkbox", role: "checkbox", name: "Я не робот", visible: false }),
  ];
  els.forEach((e, i) => { e.ref = "e" + (i + 1); });
  const page = fakePage(els);

  const origRequire = Module_.prototype.require;
  // Важно: browser-tools кэширует playwright между тестами — сбрасываем кэш,
  // иначе вместо нашего подставного движка остался бы движок предыдущего теста.
  bt.setPlaywright(null);
  Module_.prototype.require = function (id) {
    if (id === "playwright") {
      return {
        chromium: {
          executablePath: () => "",
          async launch() {
            return { isConnected: () => true, on() {}, async newPage() { return page; }, async close() {} };
          },
        },
      };
    }
    return origRequire.apply(this, arguments);
  };
  try {
    await bt.open({ url: "https://vk.com/im" });

    await test("browserSnapshot: карта с ref, ролями и именами", async () => {
      const s = await bt.snapshot({});
      assert.ok(/Карта страницы: «ВК»/.test(s), s.slice(0, 160));
      assert.ok(/e2\s+button\s+«Войти»/.test(s), "нет кнопки:\n" + s);
      assert.ok(/e3\s+searchbox\s+«Поиск»/.test(s), "нет поля поиска:\n" + s);
      assert.ok(/e4\s+textbox\s+«Написать сообщение»/.test(s), "нет contenteditable:\n" + s);
      assert.ok(/browserClick \{ ref: "e2" \}/.test(s), "нет подсказки по ref:\n" + s);
      assert.ok(!/Я не робот/.test(s), "невидимый элемент попал в карту:\n" + s);
    });

    await test("browserSnapshot: filter сужает список", async () => {
      const s = await bt.snapshot({ filter: "войти" });
      assert.ok(/по фильтру «войти» — 1/.test(s), s.slice(0, 200));
      assert.ok(!/«Главная»/.test(s), "фильтр не отсеял лишнее:\n" + s);
    });

    await test("browserClick: по имени — берёт саму кнопку, без селектора", async () => {
      page.clicked.length = 0;
      const r = await bt.click({ name: "Войти" });
      assert.ok(/^OK/.test(r), r);
      assert.deepStrictEqual(page.clicked, ["login"], "клики: " + JSON.stringify(page.clicked));
    });

    await test("browserClick: по ref из карты и по номеру вместо ref", async () => {
      page.clicked.length = 0;
      await bt.click({ ref: "e4" });
      await bt.click({ ref: 1 });
      assert.deepStrictEqual(page.clicked, ["msg", "home"], "клики: " + JSON.stringify(page.clicked));
    });

    await test("browserClick: имя в кавычках («Войти») не мешает поиску", async () => {
      page.clicked.length = 0;
      const r = await bt.click({ name: "«Войти»" });
      assert.ok(/^OK/.test(r), r);
      assert.deepStrictEqual(page.clicked, ["login"]);
    });

    await test("browserClick: несовпавшая роль не ломает поиск по имени", async () => {
      page.clicked.length = 0;
      const r = await bt.click({ role: "clickable", name: "Войти" });
      assert.ok(/^OK/.test(r), r);
      assert.deepStrictEqual(page.clicked, ["login"], "роль не совпала — должен сработать поиск по имени");
    });

    await test("browserClick: промах по имени возвращает похожие элементы с ref", async () => {
      const r = await bt.click({ name: "Войти в аккаунт" });
      assert.ok(/Ошибка browserClick/.test(r), r.slice(0, 160));
      assert.ok(/Не нашёл «Войти в аккаунт»/.test(r), "кривой заголовок:\n" + r);
      assert.ok(/Похожие элементы/.test(r), "нет подсказок:\n" + r);
      assert.ok(/browserClick \{ ref: "e2" \}/.test(r), "нет готового действия:\n" + r);
    });

    await test("browserClick: безнадёжный селектор — отдаёт карту страницы", async () => {
      const r = await bt.click({ selector: "#nope" });
      assert.ok(/Ошибка browserClick/.test(r), r.slice(0, 160));
      assert.ok(/«Войти»/.test(r), "нет карты страницы:\n" + r);
    });

    await test("browserFill: поле по подписи (label / aria-label) и по ref", async () => {
      const r = await bt.fill({ label: "Поиск", text: "велосипед" });
      assert.ok(/^OK — поле «подпись «Поиск»»/.test(r), r);
      assert.deepStrictEqual(page.filled, [{ key: "search", text: "велосипед" }]);
    });

    await test("browserFill: contenteditable через insertText (ВК)", async () => {
      const r = await bt.fill({ ref: "e4", text: "привет" });
      assert.ok(/способ: insertText/.test(r), r);
      assert.deepStrictEqual(page.typed, ["привет"]);
    });

    await test("browserFill: промах показывает похожие поля (textbox)", async () => {
      const r = await bt.fill({ selector: "textarea.nope", text: "x" });
      assert.ok(/Ошибка browserFill/.test(r), r.slice(0, 120));
      assert.ok(/textbox/.test(r), "нет похожих полей:\n" + r);
    });

    await test("browserSelect: неверный вариант — показываем реальные значения списка", async () => {
      const r = await bt.select({ label: "Город", value: "Сочи" });
      assert.ok(/не выбрался вариант «Сочи»/.test(r), r);
      assert.ok(/msk \(«Москва»\)/.test(r) && /tula \(«Тула»\)/.test(r), "нет вариантов:\n" + r);
      const ok = await bt.select({ label: "Город", value: "tula" });
      assert.ok(/^OK — в «подпись «Город»» выбрано: tula/.test(ok), ok);
    });

    await test("browserWait: ждём словами — и находим, и объясняем промах", async () => {
      const ok = await bt.wait({ name: "Войти", timeout: 1000 });
      assert.ok(/^OK — элемент «role=button name="Войти"» появился/.test(ok), ok);
      const no = await bt.wait({ name: "Капча", timeout: 400 });
      assert.ok(/Ошибка browserWait/.test(no), no.slice(0, 160));
      assert.ok(/Не нашёл «Капча»/.test(no) && /browserSnapshot/.test(no), no);
    });

    await test("браузерные инструменты: без аргументов — понятная подсказка", async () => {
      assert.ok(/укажи, по чему кликать/.test(await bt.click({})));
      assert.ok(/укажи поле/.test(await bt.fill({ text: "x" })));
      assert.ok(/укажи список/.test(await bt.select({ value: "x" })));
      assert.ok(/укажи selector, ref или name\/text/.test(await bt.wait({})));
    });
  } finally {
    Module_.prototype.require = origRequire;
    await bt.stop().catch(() => {});
    bt.setPlaywright(null);
  }

  // ── Настоящий сборщик карты на мини-DOM: ref стабильны, пароли не утекают ──
  await test("browserSnapshot: сборщик карты не отдаёт значения полей (пароли) и скрытое", () => {
    const mk = (tag, attrs, extra) => {
      const store = Object.assign({}, attrs);
      return Object.assign(
        {
          tagName: tag.toUpperCase(),
          className: attrs.class || "",
          innerText: attrs.__text || "",
          textContent: attrs.__text || "",
          isContentEditable: !!attrs.__ce,
          onclick: null,
          disabled: false,
          checked: false,
          labels: [],
          closest: () => null,
          getAttribute: (n) => (n in store ? store[n] : null),
          setAttribute: (n, v) => { store[n] = v; },
          getBoundingClientRect: () =>
            (extra && extra.rect) || { top: 10, left: 10, bottom: 40, right: 200, width: 190, height: 30 },
        },
        extra || {}
      );
    };
    const nodes = [
      mk("button", { __text: "Войти" }),
      mk("input", { type: "password", name: "pass", "aria-label": "Пароль", value: "СЕКРЕТ" }),
      mk("input", { type: "hidden", name: "token", value: "СЕКРЕТ2" }),
      mk("div", { __ce: true, role: "textbox" }),
      mk("button", { __text: "Невидимая" }, { getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }) }),
      mk("div", { role: "presentation", __text: "мусор" }),
      mk("span", { tabindex: "0", __text: "без роли, но кликабельный" }),
    ];
    global.window = {
      __aiAgentRefSeq: 0,
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1", pointerEvents: "auto" }),
    };
    global.document = { title: "T", querySelectorAll: () => nodes, getElementById: () => null };
    global.location = { href: "https://x.ru/" };
    try {
      const raw = bt.collectInPage();
      assert.deepStrictEqual(
        raw.items.map((i) => i.ref),
        ["e1", "e2", "e3", "e4", "e5"],
        "refs: " + JSON.stringify(raw.items.map((i) => i.ref))
      );
      assert.strictEqual(raw.items.filter((i) => i.type === "hidden").length, 0, "hidden-поле в карте");
      const pass = raw.items.find((i) => i.type === "password");
      assert.strictEqual(pass.value, "", "пароль попал в карту!");
      assert.strictEqual(dom.accessibleName(pass), "Пароль");
      assert.strictEqual(dom.isInteractive({ tag: "div", roleAttr: "presentation", text: "x" }), false);
      assert.strictEqual(
        dom.accessibleName({ tag: "input", type: "submit", value: "Войти" }),
        "Войти",
        "подпись кнопки-<input> берётся из value"
      );
      assert.strictEqual(dom.refName("#e12"), "e12");
      assert.strictEqual(dom.refName("div.x"), "");
      const again = bt.collectInPage();
      assert.deepStrictEqual(again.items.map((i) => i.ref), raw.items.map((i) => i.ref), "ref не должны меняться");
    } finally {
      delete global.window;
      delete global.document;
      delete global.location;
    }
  });
}

// ── 1c. app-инструменты: стабильные ref вместо номеров [N] ──────────────────
// Мини-DOM: проверяем, что клик идёт по ref (номер ломается при перерисовке),
// промах возвращает свежую карту, разрушительное блокируется, пароли не утекают.
async function testAppUiRefs() {
  const appUi = require(path.join(ROOT, "src", "app-ui-tools.js"));

  const matches = (el, sel) => {
    sel = String(sel).trim();
    if (sel.indexOf(",") !== -1) return sel.split(",").some((s) => matches(el, s));
    const attr = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (attr) {
      const v = el.getAttribute(attr[1]);
      return attr[2] === undefined ? v !== null : v === attr[2];
    }
    const tag = sel.match(/^[a-zA-Z][\w-]*/);
    const id = sel.match(/#([\w-]+)/);
    const cls = sel.match(/\.([\w-]+)/);
    if (!tag && !id && !cls) return false;
    if (tag && String(el.tagName).toLowerCase() !== tag[0].toLowerCase()) return false;
    if (id && el.id !== id[1]) return false;
    if (cls && String(el.className).split(/\s+/).indexOf(cls[1]) < 0) return false;
    return true;
  };

  class El {
    constructor(tag, attrs, opts) {
      const a = Object.assign({}, attrs || {});
      const o = opts || {};
      this.tagName = tag.toUpperCase();
      this._attrs = a;
      this.id = a.id || "";
      this.className = a.class || "";
      this.innerText = o.text != null ? o.text : a.__text || "";
      this.textContent = this.innerText;
      this.placeholder = a.placeholder || "";
      this.title = a.title || "";
      this.type = a.type || "";
      this._v = a.value || "";
      this.disabled = !!o.disabled;
      this.checked = !!o.checked;
      this.isContentEditable = !!o.ce;
      this.labels = o.labels || [];
      this.onclick = o.onclick || null;
      this.clicks = 0;
      this.events = [];
      this._parent = o.parent || null;
      this._gone = !!o.gone;
      this.rect = o.rect || { width: 90, height: 24, top: 10, left: 10, bottom: 34, right: 100 };
    }
    get value() { return this._v; }
    set value(v) { this._v = v; }
    getAttribute(n) { return n in this._attrs ? String(this._attrs[n]) : null; }
    setAttribute(n, v) { this._attrs[n] = String(v); }
    getBoundingClientRect() { return Object.assign({}, this.rect); }
    scrollIntoView() { this.scrolled = true; }
    click() { this.clicks++; }
    dispatchEvent(e) { this.events.push(e && e.type); return true; }
    closest(sel) {
      let n = this._parent;
      while (n) {
        if (matches(n, sel)) return n;
        n = n._parent;
      }
      return null;
    }
  }
  function Proto() {}
  Object.defineProperty(Proto.prototype, "value", {
    get() { return this._v; },
    set(v) { this._v = v; },
    configurable: true,
  });
  class FakeEvent { constructor(type) { this.type = type; } }

  const makeWin = (elements, title) => {
    const doc = {
      title: title || "AI Developer Agent",
      body: { innerText: "Текст окна для агента" },
      activeElement: null,
      querySelectorAll: (sel) => elements.filter((el) => !el._gone && matches(el, sel)),
      querySelector: (sel) => elements.filter((el) => !el._gone && matches(el, sel))[0] || null,
    };
    const win = {
      __aiAppRefSeq: 0,
      document: doc,
      isDestroyed: () => false,
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: (code) =>
          Promise.resolve(
            new Function(
              "document", "window", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement", "Event",
              "return " + code + ";"
            )(doc, win, () => ({ display: "block", visibility: "visible", opacity: "1" }), Proto, Proto, FakeEvent)
          ),
        capturePage: async () => ({ isEmpty: () => false, toPNG: () => Buffer.from("png") }),
      },
    };
    return win;
  };

  await test("appRead: карта с ref, ролями, именами, id; значения полей и .hidden не утекают", async () => {
    const hiddenBox = new El("div", { class: "hidden" });
    const els = [
      new El("button", { id: "btn-settings", __text: "Настройки" }),
      new El("button", { id: "btn-secrets", __text: "Секреты" }),
      new El("input", { id: "s-token", type: "password", value: "СЕКРЕТ-ТОКЕН" }),
      new El("input", { id: "s-model", placeholder: "Модель", value: "gpt-4o" }),
      new El("button", { id: "btn-hidden", __text: "Внутри скрытого" }, { parent: hiddenBox }),
    ];
    const out = await appUi.read({}, makeWin(els));
    assert.ok(/e1\s+button\s+«Настройки»\s+#btn-settings/.test(out), out.slice(0, 400));
    assert.ok(/значение скрыто/.test(out), "нет пометки скрытого значения:\n" + out);
    assert.ok(!/СЕКРЕТ-ТОКЕН/.test(out), "значение секретного поля попало в карту!");
    assert.ok(!/gpt-4o/.test(out), "значение обычного поля попало в карту:\n" + out);
    assert.ok(!/Внутри скрытого/.test(out), "элемент из .hidden попал в карту:\n" + out);
    assert.ok(/действуй по ref/.test(out), "нет подсказки про ref:\n" + out.slice(0, 300));
  });

  await test("appClick: ref переживает перерисовку окна (номер [N] — нет)", async () => {
    const els = [
      new El("button", { id: "btn-settings", __text: "Настройки" }),
      new El("button", { id: "btn-secrets", __text: "Секреты" }),
    ];
    const win = makeWin(els);
    await appUi.read({}, win);
    // Перерисовка: сверху появилась кнопка «↻» — позиции сдвинулись, ref остались.
    els.unshift(new El("button", { id: "btn-refresh", __text: "↻" }));
    const r = await appUi.click({ ref: "e2" }, win);
    assert.ok(/^OK — клик по ref e2/.test(r), r);
    assert.strictEqual(els[2].clicks, 1, "клик ушёл не в тот элемент");
    assert.strictEqual(els[0].clicks, 0, "клик попал в новую кнопку");
  });

  await test("appClick: устаревший ref НЕ кликает наугад — отдаёт свежую карту", async () => {
    const els = [new El("button", { id: "btn-a", __text: "Первая" }), new El("button", { id: "btn-b", __text: "Вторая" })];
    const win = makeWin(els);
    await appUi.read({}, win);
    els[1]._gone = true;
    const r = await appUi.click({ ref: "e2" }, win);
    assert.ok(/Ошибка appClick/.test(r) && /ref устарел/.test(r), r.slice(0, 200));
    assert.ok(/«Первая»/.test(r), "нет свежей карты:\n" + r);
    assert.strictEqual(els[0].clicks + els[1].clicks, 0, "клик всё-таки прошёл");
  });

  await test("appClick: номер [N] работает, но предупреждает; промах подсказывает ref", async () => {
    const els = [new El("button", { id: "btn-a", __text: "Настройки" }), new El("button", { id: "btn-b", __text: "Секреты" })];
    const win = makeWin(els);
    const byIndex = await appUi.click({ index: 2 }, win);
    assert.ok(/^OK/.test(byIndex) && /НОМЕРУ/.test(byIndex), byIndex);
    assert.strictEqual(els[1].clicks, 1);
    const miss = await appUi.click({ text: "Секретики" }, win);
    assert.ok(/Ошибка appClick/.test(miss) && /Похожие элементы/.test(miss), miss.slice(0, 240));
    assert.ok(/appRead/.test(miss) && !/browserSnapshot/.test(miss), "подсказка про чужой инструмент:\n" + miss);
  });

  await test("appClick: разрушительное блокируется и по ref/селектору, не только по тексту", async () => {
    const els = [new El("button", { id: "btn-del", __text: "Удалить аккаунт" })];
    const win = makeWin(els);
    const byRef = await appUi.click({ ref: "e1" }, win);
    assert.ok(/⛔/.test(byRef), byRef.slice(0, 160));
    const bySel = await appUi.click({ selector: "#btn-del" }, win);
    assert.ok(/⛔/.test(bySel), bySel.slice(0, 160));
    assert.strictEqual(els[0].clicks, 0, "опасный клик прошёл");
  });

  await test("appFill: ввод по ref и по подписи; секретное поле не эхом", async () => {
    const els = [new El("input", { id: "s-model", placeholder: "Модель" }), new El("input", { id: "s-mail-pass", type: "password" })];
    const win = makeWin(els);
    const r1 = await appUi.fill({ ref: "e1", text: "gpt-4o-mini" }, win);
    assert.ok(/^OK/.test(r1), r1);
    assert.strictEqual(els[0]._v, "gpt-4o-mini");
    assert.ok(els[0].events.includes("input") && els[0].events.includes("change"), "нет событий ввода: " + els[0].events);
    const r3 = await appUi.fill({ ref: "e2", text: "МойПароль123" }, win);
    assert.ok(/^OK/.test(r3) && !/МойПароль123/.test(r3) && /секретное/.test(r3), "секрет выведен: " + r3);
  });

  await test("appSelect: неверный вариант — показываем реальные варианты списка", async () => {
    const sel = new El("select", { id: "s-folder" });
    sel.options = [{ value: "msk", text: "Москва" }, { value: "tula", text: "Тула" }];
    const win = makeWin([sel]);
    const bad = await appUi.select({ ref: "e1", value: "sochi" }, win);
    assert.ok(/нет варианта «sochi»/.test(bad) && /msk \(«Москва»\)/.test(bad), bad);
    const ok = await appUi.select({ selector: "#s-folder", value: "tula" }, win);
    assert.ok(/^OK/.test(ok), ok);
    assert.strictEqual(sel.value, "tula");
  });

  await test("appWait: ждём по тексту; пустой запрос ничего не «находит»", async () => {
    const win = makeWin([new El("button", { id: "btn-ok", __text: "Сохранить" })]);
    assert.ok(/^OK — элемент появился/.test(await appUi.wait({ text: "Сохранить", timeout: 2000 }, win)));
    const nothing = await appUi.click({}, win);
    assert.ok(/укажи ref/.test(nothing), nothing);
    assert.strictEqual(win.document.querySelectorAll("button").length, 1, "мини-DOM сломан");
  });
}

// ── Yandex Cloud по отчёту песочницы: адреса, повторы, пачки, UX ────────────
async function testYcDiagnosis() {
  const yc = require(path.join(ROOT, "src", "yandex-cloud.js"));
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const coreSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "agent-core.js"), "utf8");

  const makeFetch = (handler) => {
    const calls = [];
    let inflight = 0;
    let maxInflight = 0;
    const f = async (url) => {
      calls.push(String(url));
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        const r = await handler(String(url), calls.length);
        return {
          ok: r.status ? r.status < 400 : true,
          status: r.status || 200,
          async text() { return r.body == null ? "" : JSON.stringify(r.body); },
        };
      } finally {
        inflight--;
      }
    };
    f.calls = calls;
    f.stats = () => ({ maxInflight, count: calls.length });
    return f;
  };
  const iamBody = () => ({ iamToken: "t", expiresAt: new Date(Date.now() + 3600e3).toISOString() });

  const realFetch = global.fetch;
  try {
    await test("yc: адреса сервисов — logging/logGroups и существующий хост Postbox", async () => {
      const lg = yc.SERVICES.find((s) => s.key === "logging");
      assert.strictEqual(lg.listPath, "/logging/v1/logGroups", "неверный путь лог-групп");
      const f = makeFetch((url) => {
        if (url.includes("/endpoints")) return { body: {} }; // нет списка эндпоинтов → фолбэк
        if (url.includes("/iam/v1/tokens")) return { body: iamBody() };
        return { body: { addresses: [] } };
      });
      global.fetch = f;
      yc.resetIamCache();
      await yc.listService("oauth", "folder1", yc.serviceByKey("postbox"));
      const url = f.calls.find((u) => u.includes("postbox"));
      assert.ok(/^https:\/\/postbox\.cloud\.yandex\.net\//.test(url), "неверный адрес Postbox: " + url);
      assert.ok(url.includes("folderId=folder1"), "нет folderId: " + url);
    });

    await test("yc: сетевой сбой повторяется (2 попытки), 403 — нет и подписан адресом", async () => {
      let n = 0;
      const f = makeFetch((url) => {
        if (url.includes("/endpoints")) return { body: {} };
        if (url.includes("/iam/v1/tokens")) return { body: iamBody() };
        n++;
        if (n === 1) throw new TypeError("fetch failed");
        return { body: { networks: [{ id: "n1" }, { id: "n2" }] } };
      });
      global.fetch = f;
      yc.resetIamCache();
      const r = await yc.listService("oauth", "f1", yc.serviceByKey("vpc"));
      assert.strictEqual(r.count, 2);
      assert.strictEqual(n, 2, "попыток: " + n);

      let m = 0;
      const f2 = makeFetch((url) => {
        if (url.includes("/endpoints")) return { body: {} };
        if (url.includes("/iam/v1/tokens")) return { body: iamBody() };
        m++;
        return { status: 403, body: { message: "Permission denied" } };
      });
      global.fetch = f2;
      yc.resetIamCache();
      let err = null;
      try {
        await yc.listService("oauth", "f1", yc.serviceByKey("cdn"));
      } catch (e) {
        err = e;
      }
      assert.ok(err && /Нет доступа \(403\)/.test(err.message), err && err.message);
      assert.ok(/cdn\.api\.cloud\.yandex\.net/.test(err.message), "нет адреса в ошибке: " + err.message);
      assert.strictEqual(m, 1, "403 не должен повторяться");
    });

    await test("yc: дашборд опрашивает сервисы пачками, порядок и ошибки сохранены", async () => {
      const f = makeFetch((url) => {
        if (url.includes("/endpoints")) return { body: {} };
        if (url.includes("/iam/v1/tokens")) return { body: iamBody() };
        if (!url.includes("vpc")) throw new TypeError("fetch failed");
        return { body: { networks: [{ id: "n1" }] } };
      });
      global.fetch = f;
      yc.resetIamCache();
      const res = await yc.resourcesStatus("oauth", "f1");
      assert.deepStrictEqual(res.map((s) => s.key), yc.SERVICES.map((s) => s.key), "порядок карточек поехал");
      assert.ok(f.stats().maxInflight <= 3, "залп запросов: " + f.stats().maxInflight);
      const broken = res.filter((s) => !s.ok);
      assert.ok(broken.length > 0 && broken.every((s) => /Сеть:|Таймаут:|\[/.test(s.error)), "непонятная ошибка: " + (broken[0] || {}).error);
      assert.ok(res.find((s) => s.key === "vpc" && s.ok), "vpc должен был ответить");
    });

    await test("yc: классификация ошибок (сеть / таймаут / API с адресом)", () => {
      assert.ok(yc.isNetworkError(new TypeError("fetch failed")), "не распознан сетевой сбой");
      const ab = new Error("This operation was aborted");
      ab.name = "AbortError";
      assert.ok(yc.isNetworkError(ab), "не распознан таймаут");
      assert.ok(/Таймаут: logging\.api\.cloud\.yandex\.net\/x/.test(yc.serviceError(ab, "https://logging.api.cloud.yandex.net", "/x")));
      assert.ok(/Сеть:/.test(yc.serviceError(new TypeError("fetch failed"), "https://vpc.api.cloud.yandex.net", "/vpc/v1/networks")));
      assert.strictEqual(yc.hostOf("https://a.b.c/x"), "a.b.c");
    });

    await test("инструменты агента читают свежие настройки (каталог применяется сразу)", () => {
      assert.strictEqual((mainSrc.match(/ycConfig\(settings\)/g) || []).length, 0, "остались вызовы со старым settings");
      assert.ok((mainSrc.match(/ycConfig\(loadSettings\(\)\)/g) || []).length >= 6, "yc-инструменты не читают свежие настройки");
      assert.ok(mainSrc.includes("mailConfig(loadSettings())"), "почта не читает свежие настройки");
      assert.ok(mainSrc.includes("loadSettings().sitePasswords"), "пароли сайтов не читаются свежими");
    });

    await test("cmd на Windows: UTF-8 (chcp 65001) для всех команд агента", () => {
      assert.ok(mainSrc.includes("function shellArgsFor(command)"), "нет хелпера кодировки");
      assert.ok(mainSrc.includes('"chcp 65001>nul & "'), "нет переключения кодировки");
      const uses = (mainSrc.match(/shellArgsFor\(command\)/g) || []).length;
      assert.ok(uses >= 3, "кодировка подключена не во все места запуска: " + uses);
      assert.strictEqual((mainSrc.match(/\[\"\/d\", \"\/s\", \"\/c\", command\]/g) || []).length, 0, "остался запуск cmd без UTF-8");
    });

    await test("UI: ошибки дашборда и списка каталогов видны текстом", () => {
      assert.ok(appSrc.includes('err.className = "yc-card-err"'), "ошибка сервиса не показывается текстом");
      assert.ok(appSrc.includes("⚠️ Не ответили:"), "сводка не сообщает, сколько сервисов упало");
      assert.ok(appSrc.includes("⏳ Загрузка каталогов…"), "нет состояния загрузки каталогов");
      assert.ok(appSrc.includes("Каталоги не загрузились"), "пустой список каталогов не объясняет причину");
      assert.ok(htmlSrc.includes("галочка = РАЗРЕШЕНО"), "семантика чекбоксов разрешений не пояснена");
    });

    await test("app-инструменты: ref в описаниях и «номер [N] устаревает» в промпте", () => {
      for (const n of ["appClick", "appFill", "appSelect", "appWait"]) {
        const d = coreSrc.split('name: "' + n + '"')[1] || "";
        assert.ok(d.slice(0, 600).includes("ref"), "в описании " + n + " нет ref");
      }
      assert.ok(/номер \[N\] устаревает при любой перерисовке/.test(coreSrc), "промпт не предупреждает про номера");
    });
  } finally {
    global.fetch = realFetch;
    yc.resetIamCache();
  }
}

// ── 4d. Менеджер паролей (vault) ───────────────────────────────────────────
async function testVault() {
  const vault = require(path.join(ROOT, "src", "vault.js"));
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

  await test("vault: нормализация записи (обрезка, переводы строк, id, мусор)", () => {
    const e = vault.normalizeEntry({
      name: "  ВК  ",
      url: " https://vk.com/im ",
      login: "  user  ",
      password: "p\nw\r\n",
      note: " 2FA ",
    });
    assert.strictEqual(e.name, "ВК");
    assert.strictEqual(e.url, "https://vk.com/im");
    assert.strictEqual(e.login, "user");
    assert.strictEqual(e.password, "pw"); // переводы строк убраны, символы пароля не портим
    assert.strictEqual(e.note, "2FA");
    assert.ok(/^v[a-z0-9]+$/.test(e.id), "плохой id: " + e.id);
    assert.strictEqual(vault.normalizeEntry(null), null);
    assert.strictEqual(vault.normalizeEntry("строка"), null);
    assert.strictEqual(vault.normalizeEntry({ login: "x" }), null, "запись без имени и адреса должна отбрасываться");
    assert.strictEqual(vault.normalizeEntry({ url: "vk.com" }).name, "vk.com");
    assert.strictEqual(vault.hostOf("https://WWW.Vk.com:443/im?x=1"), "vk.com");
  });

  await test("vault: список чистится, дубликаты по id отбрасываются", () => {
    const list = vault.sanitizeList([
      { id: "a", name: "ВК", password: "p" },
      { id: "a", name: "Дубль" },
      null,
      "мусор",
      { name: "" },
    ]);
    assert.strictEqual(list.length, 1, "осталось: " + list.length);
    assert.strictEqual(list[0].password, "p");
    assert.strictEqual(vault.sanitizeList(null).length, 0);
    assert.strictEqual(vault.sanitizeList("x").length, 0);
  });

  const site = vault.sanitizeList([
    { id: "a", name: "ВК", url: "https://vk.com/", login: "user1", password: "pass1" },
    { id: "b", name: "Авито", url: "avito.ru", login: "user2" },
    { id: "c", name: "Яндекс Почта", url: "mail.yandex.ru", login: "user3" },
  ]);

  await test("vault: поиск по имени, регистру, хосту и полному URL", () => {
    assert.strictEqual(vault.findEntry(site, "ВК").id, "a");
    assert.strictEqual(vault.findEntry(site, "вк").id, "a");
    assert.strictEqual(vault.findEntry(site, "https://vk.com/login").id, "a");
    assert.strictEqual(vault.findEntry(site, "avito.ru").id, "b");
    assert.strictEqual(vault.findEntry(site, "почта").id, "c");
    assert.strictEqual(vault.findEntry(site, "yandex").id, "c");
    assert.strictEqual(vault.findEntry(site, "ok.ru"), null);
    assert.strictEqual(vault.findEntry(site, ""), null);
  });

  await test("vault: текст для агента НИКОГДА не содержит паролей", () => {
    const text = vault.listText(site);
    assert.ok(!text.includes("pass1"), "пароль утёк в текст: " + text.slice(0, 120));
    assert.ok(text.includes("пароль: сохранён") && text.includes("пароль: не сохранён"));
    assert.ok(text.includes("user2"), "логин должен быть виден агенту");
    assert.ok(/Сохранённых паролей нет/.test(vault.listText([])));
    const nf = vault.notFoundText(site, "ok.ru");
    assert.ok(nf.includes("ok.ru") && nf.includes("ВК"));
  });

  await test("vault: fillLogin подставляет вход и не выводит пароль в ответ", async () => {
    const calls = [];
    const bt = {
      async fill(a) { calls.push({ op: "fill", ...a }); return "OK"; },
      async press(a) { calls.push({ op: "press", ...a }); return "OK"; },
    };
    const r = await vault.fillLogin(site[0], {}, bt);
    assert.strictEqual(calls[0].op, "fill");
    assert.strictEqual(calls[0].text, "user1");
    assert.strictEqual(calls[0].selector, vault.LOGIN_SELECTOR);
    assert.strictEqual(calls[1].op, "fill");
    assert.strictEqual(calls[1].text, "pass1");
    assert.strictEqual(calls[1].selector, vault.PASSWORD_SELECTOR);
    assert.ok(!r.includes("pass1"), "пароль попал в текст ответа");
    assert.ok(!r.includes("user1"), "логин не должен дублироваться в ответе");
    assert.ok(r.includes("НЕ отправлена"));
  });

  await test("vault: fillLogin — submit, частичный вход и понятные ошибки", async () => {
    const calls = [];
    const bt = {
      async fill(a) { calls.push({ op: "fill", ...a }); return "OK"; },
      async press(a) { calls.push({ op: "press", ...a }); return "OK"; },
    };
    const r1 = await vault.fillLogin(site[0], { submit: true }, bt);
    assert.strictEqual(calls[2].op, "press");
    assert.strictEqual(calls[2].key, "Enter");
    assert.ok(r1.includes("Форма отправлена"));

    calls.length = 0;
    const r2 = await vault.fillLogin(site[1], {}, bt); // запись без пароля
    assert.strictEqual(calls.length, 1, "заполняться должен только логин");
    assert.ok(r2.includes("Пароль не сохранён") && !r2.includes("pass"));

    const errBt = { async fill() { return "Ошибка browserFill: элемент не найден"; }, async press() { return "OK"; } };
    assert.ok((await vault.fillLogin(site[0], {}, errBt)).includes("Не удалось заполнить поле логина"));

    let n = 0;
    const halfBt = { async fill() { n++; return n === 1 ? "OK" : "Ошибка browserFill: нет поля"; }, async press() { return "OK"; } };
    const r4 = await vault.fillLogin(site[0], {}, halfBt);
    assert.ok(r4.includes("поле пароля не найдено") && !r4.includes("pass1"));

    assert.ok((await vault.fillLogin(site[0], {}, null)).includes("Браузер агента недоступен"));
    assert.ok((await vault.fillLogin({ name: "X", password: "p" }, {}, bt)).includes("только пароль без логина"));
    assert.ok((await vault.fillLogin(null, {}, bt)).includes("Нет записи"));
  });

  await test("secrets: sitePasswords шифруется и читается обратно", () => {
    const dir = tmpdir("agent-vault-");
    const file = path.join(dir, "secrets.json");
    const sec = require(path.join(ROOT, "src", "secrets.js"));
    sec.init(file);
    const entries = [{ id: "a", name: "ВК", url: "vk.com", login: "user1", password: "s3cret!" }];
    const split = sec.splitSecrets({ model: "m", sitePasswords: entries });
    assert.ok(!("sitePasswords" in split.rest), "sitePasswords остался в открытых настройках");
    assert.deepStrictEqual(split.sec.sitePasswords, entries);
    sec.saveSecrets(split.sec);
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes("vk.com") && !raw.includes("s3cret!"), "значения не зашифрованы:\n" + raw.slice(0, 300));
    sec.init(file); // читаем заново с диска
    assert.deepStrictEqual(sec.loadSecrets().sitePasswords, entries);
  });

  await test("vault: инструменты агента, тексты и интерфейс связаны", () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    const coreSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "agent-core.js"), "utf8");
    const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");

    assert.ok(mainSrc.includes('case "vaultList"') && mainSrc.includes('case "vaultFill"'), "нет обработчиков vault-инструментов");
    assert.ok(mainSrc.includes("sitePasswords: []"), "нет настройки sitePasswords");
    assert.ok(mainSrc.includes("vault.sanitizeList(s.sitePasswords)"), "список не чистится при загрузке настроек");
    assert.ok(mainSrc.includes("merged.sitePasswords = prev.sitePasswords"), "нет защиты паролей от затирания при сохранении");

    const defs = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name);
    assert.ok(defs.includes("vaultList") && defs.includes("vaultFill"), "нет описаний vault-инструментов");
    assert.ok(coreSrc.includes("НИКОГДА не проси пароль в чате"), "в промпте нет запрета просить пароль в чате");
    assert.ok(coreSrc.includes("vaultFill подставляет логин и пароль прямо в форму"), "промпт не направляет агента в vaultFill");

    for (const id of ["vault-list", "s-vault-name", "s-vault-url", "s-vault-login", "s-vault-pass", "s-vault-note", "btn-vault-add", "btn-vault-clear", "btn-vault-eye"]) {
      assert.ok(htmlSrc.includes('id="' + id + '"'), "нет id=" + id + " в index.html");
      assert.ok(appSrc.includes('"' + id + '"'), "нет ссылки на " + id + " в app.js");
    }
    assert.ok(htmlSrc.includes('id="s-vault-pass" type="password"'), "поле пароля должно быть скрытым");
    assert.ok(appSrc.includes("function renderVault") && appSrc.includes("function vaultAdd") && appSrc.includes("function vaultDelete"));
  });
}

// ── 4e. Интерфейс паролей: реальный код app.js + мини-DOM ──────────────────
async function testVaultUi() {
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const A = "  // ─────────────── Пароли сайтов (Настройки → Секреты) ───────────────";
  const B = "  // ─────────────── Секреты: переменные окружения (Настройки) ───────────────";
  const i = appSrc.indexOf(A);
  const j = appSrc.indexOf(B);
  assert.ok(i > 0 && j > i, "не нашёл блок паролей в app.js");

  const mkEl = (tag) => ({
    tag, className: "", textContent: "", title: "", type: "", value: "",
    children: [], onclick: null,
    appendChild(c) { this.children.push(c); return c; },
    classList: { add() {}, toggle() {}, remove() {} },
  });
  const inputs = new Map();
  const box = mkEl("div");
  // В настоящем DOM присваивание innerHTML удаляет вложенные узлы — повторяем это в заглушке.
  Object.defineProperty(box, "innerHTML", {
    get() { return this._html || ""; },
    set(v) { this._html = v; if (v === "") this.children = []; },
  });
  const $ = (id) => {
    if (id === "vault-list") return box;
    if (!inputs.has(id)) inputs.set(id, mkEl("input"));
    return inputs.get(id);
  };
  const toasts = [];
  const settings = { sitePasswords: [] };
  let persisted = 0;
  const code = appSrc.slice(i, j);
  const mod = new Function(
    "$", "document", "settings", "persistSettings", "toast", "confirm",
    code + "\nreturn { renderVault, vaultAdd, vaultDelete, vaultLoadToForm, vaultClearForm, vaultArr };"
  )($, { createElement: (t) => mkEl(t) }, settings, () => { persisted++; }, (t) => toasts.push(t), () => true);

  await test("vault UI: пустой список показывает подсказку", () => {
    mod.renderVault();
    assert.ok(box.innerHTML.includes("Записей пока нет"));
  });

  await test("vault UI: добавление обрезает поля, сохраняет и очищает форму", () => {
    $("s-vault-name").value = "  ВК  ";
    $("s-vault-url").value = "vk.com";
    $("s-vault-login").value = " +79000000000 ";
    $("s-vault-pass").value = "sup3r secret";
    $("s-vault-note").value = " 2FA ";
    mod.vaultAdd();
    assert.strictEqual(settings.sitePasswords.length, 1);
    const e = settings.sitePasswords[0];
    assert.strictEqual(e.name, "ВК");
    assert.strictEqual(e.login, "+79000000000");
    assert.strictEqual(e.password, "sup3r secret"); // пароль не портим
    assert.ok(/^v[a-z0-9]+$/.test(e.id));
    assert.strictEqual(persisted, 1, "настройки не сохранены");
    assert.strictEqual($("s-vault-name").value, "");
    assert.strictEqual($("s-vault-pass").value, "");
    assert.ok(toasts[toasts.length - 1].includes("сохранена зашифрованно"));
  });

  await test("vault UI: пустые записи не сохраняются (с понятными сообщениями)", () => {
    $("s-vault-name").value = "";
    $("s-vault-url").value = "";
    $("s-vault-login").value = "u";
    mod.vaultAdd();
    assert.strictEqual(settings.sitePasswords.length, 1, "запись без имени и адреса сохранилась");
    assert.strictEqual(toasts[toasts.length - 1], "Укажи название или адрес сайта");
    $("s-vault-url").value = "avito.ru";
    $("s-vault-login").value = "";
    $("s-vault-pass").value = "";
    mod.vaultAdd();
    assert.strictEqual(settings.sitePasswords.length, 1, "запись без логина и пароля сохранилась");
    assert.strictEqual(toasts[toasts.length - 1], "Заполни хотя бы логин или пароль");
  });

  await test("vault UI: в списке пароль показывается только маской", () => {
    settings.sitePasswords.push({ id: "z", name: "Авито", url: "avito.ru", login: "user2", password: "topsecret", note: "тест" });
    mod.renderVault();
    assert.strictEqual(box.children.length, 2, "строк: " + box.children.length);
    const cells = box.children[1].children;
    assert.strictEqual(cells.length, 4, "в строке должно быть имя, данные, ✏️ и 🗑");
    const valText = cells[1].textContent;
    assert.ok(!valText.includes("topsecret"), "пароль показан в списке: " + valText);
    assert.ok(valText.includes("••••••"), "нет маски пароля");
    assert.ok(valText.includes("user2") && valText.includes("тест"));
    assert.strictEqual(cells[2].textContent, "✏️");
    assert.strictEqual(cells[3].textContent, "🗑");
  });

  await test("vault UI: правка загружает запись без пароля и обновляет её", () => {
    mod.vaultLoadToForm(settings.sitePasswords[1]);
    assert.strictEqual($("s-vault-name").value, "Авито");
    assert.strictEqual($("s-vault-pass").value, "", "пароль не должен подставляться в форму");
    assert.ok(toasts[toasts.length - 1].includes("Пароль введи заново"));
    $("s-vault-pass").value = "newpass";
    mod.vaultAdd();
    assert.strictEqual(settings.sitePasswords.length, 2, "вместо обновления добавилась новая запись");
    assert.strictEqual(settings.sitePasswords[1].id, "z");
    assert.strictEqual(settings.sitePasswords[1].password, "newpass");
    assert.strictEqual(toasts[toasts.length - 1], "Запись обновлена");
  });

  await test("vault UI: удаление и устойчивость к битым данным", () => {
    mod.vaultDelete("z");
    assert.strictEqual(settings.sitePasswords.length, 1);
    assert.strictEqual(toasts[toasts.length - 1], "Запись удалена");
    settings.sitePasswords = null;
    assert.ok(Array.isArray(mod.vaultArr()), "vaultArr должен вернуть массив");
    mod.renderVault();
    assert.ok(box.innerHTML.includes("Записей пока нет"), "отрисовка не пережила null");
  });
}

// ── 4c. Сессия и контекст: индикатор, профиль браузера, «Дописать ответ» ───
async function testSessionExtras() {
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const htmlSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const preSrc = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
  const cssSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "styles.css"), "utf8");

  await test("контекст: main.js считает заполняемость и шлёт её в интерфейс", () => {
    assert.ok(/type: "context"/.test(mainSrc), "нет события context");
    assert.ok(/emitContext\(trimmedHistory\)/.test(mainSrc), "нет отправки после обрезки истории");
    assert.ok(/emitContext\(canonical\)/.test(mainSrc), "нет обновления между раундами");
  });

  // Отрисовку индикатора берём как реальный код из app.js и подставляем простой DOM.
  const s0 = appSrc.indexOf("  function fmtTokens(n) {");
  const s1 = appSrc.indexOf("  // Состояние постоянного профиля браузера");
  assert.ok(s0 > 0 && s1 > s0, "не нашёл функции индикатора контекста в app.js");
  const ctxMod = new Function(
    "$",
    appSrc.slice(s0, s1) + "\nreturn { renderContext: renderContext, fmtTokens: fmtTokens };"
  );
  const cls = new Set();
  const dom = {
    "ctx-indicator": { classList: { add: (c) => cls.add(c) }, title: "" },
    "ctx-fill": { style: {}, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) } },
    "ctx-text": { textContent: "" },
  };
  const ctx = ctxMod((id) => dom[id] || null);

  await test("контекст: индикатор рисует проценты, токены и цвет по уровню", () => {
    ctx.renderContext({ used: 12400, budget: 24000, percent: 52 });
    assert.strictEqual(dom["ctx-fill"].style.width, "52%");
    assert.strictEqual(dom["ctx-text"].textContent, "🧠 12.4k / 24k · 52%");
    assert.ok(cls.has("visible"), "индикатор остался скрытым");
    assert.ok(!cls.has("warn") && !cls.has("danger"), "лишний цвет на 52%");
    ctx.renderContext({ used: 19000, budget: 24000, percent: 80 });
    assert.ok(cls.has("warn"), "нет жёлтого на 80%");
    ctx.renderContext({ used: 23000, budget: 24000, percent: 96 });
    assert.ok(cls.has("danger"), "нет красного на 96%");
    assert.strictEqual(ctx.fmtTokens(950), "950");
    assert.strictEqual(ctx.fmtTokens(20000), "20k");
  });

  await test("контекст: индикатор скрыт по умолчанию (до первого ответа)", () => {
    assert.ok(/\.ctx-indicator \{[\s\S]{0,80}display: none;/.test(cssSrc), "нет скрытого состояния в styles.css");
    assert.ok(/\.ctx-indicator\.visible \{ display: flex; \}/.test(cssSrc), "нет класса visible");
  });

  await test("профиль браузера: разметка, preload и обработчики согласованы", () => {
    for (const id of [
      "s-browser-profile", "browser-profile-info", "btn-browser-profile-clear",
      "s-browser-connect", "s-browser-connect-port", "btn-browser-connect", "browser-connect-info",
    ]) {
      assert.ok(htmlSrc.includes('id="' + id + '"'), "нет id=" + id + " в index.html");
      assert.ok(appSrc.includes('"' + id + '"'), "нет ссылки на " + id + " в app.js");
    }
    assert.ok(preSrc.includes('"browser:profileInfo"'), "нет канала browser:profileInfo");
    assert.ok(preSrc.includes('"browser:clearProfile"'), "нет канала browser:clearProfile");
    assert.ok(mainSrc.includes('ipcMain.handle("browser:profileInfo"'), "нет обработчика browser:profileInfo");
    assert.ok(mainSrc.includes('ipcMain.handle("browser:clearProfile"'), "нет обработчика browser:clearProfile");
    assert.ok(mainSrc.includes("browserProfile: true"), "профиль не включён по умолчанию");
    assert.ok(preSrc.includes('"browser:connect"'), "нет канала browser:connect");
    assert.ok(mainSrc.includes('ipcMain.handle("browser:connect"'), "нет обработчика browser:connect");
    assert.ok(preSrc.includes('"browser:connectInfo"'), "нет канала browser:connectInfo");
    assert.ok(mainSrc.includes("browserConnectPort: 9222"), "нет настройки порта отладки");
  });

  await test("прерванный ответ: пометка и кнопка «Дописать ответ» на месте", () => {
    assert.ok(/interrupted: true/.test(appSrc), "пометка прерванного ответа не ставится");
    assert.ok(/function continueInterruptedAnswer\(chatId, m\)/.test(appSrc), "нет функции продолжения");
    assert.ok(/Дописать ответ/.test(appSrc), "нет кнопки «Дописать ответ»");
    assert.ok(/continueInterruptedAnswer\(m\.chatId \|\| chatsData\.activeId, m\)/.test(appSrc), "кнопка не привязана");
  });
}


// ── 4b. mobile-bridge: rate-limit PIN ───────────────────────────────────────
async function testMobileBridge() {
  const MobileBridge = require(path.join(ROOT, "src", "mobile-bridge.js"));

  await test("mobile-bridge: 10 неудач подряд → глобальная блокировка", () => {
    const b = new MobileBridge({ handlerMap: new Map() });
    b.pin = "123456";
    const replies = [];
    const conn = { authed: false, authTries: 0, sendText: (s) => replies.push(JSON.parse(s)), destroy: () => {} };
    const auth = (pin) => b.onWsMessage(conn, JSON.stringify({ t: "auth", pin }));
    for (let i = 0; i < 10; i++) auth("000000");
    assert.ok(b.authLockedUntil > Date.now(), "не наступила блокировка");
    assert.ok(
      replies.some((r) => r.t === "auth_err" && r.lock === true),
      "нет auth_err с lock среди ответов: " + JSON.stringify(replies.slice(-3))
    );
    // Во время блокировки даже правильный PIN не принимается.
    auth("123456");
    const lastErr = [...replies].reverse().find((r) => r.t === "auth_err");
    assert.ok(lastErr && lastErr.lock === true, "правильный PIN принят во время блокировки");
    assert.ok(!conn.authed, "соединение авторизовано во время блокировки");
  });

  await test("mobile-bridge: успешный вход сбрасывает счётчик", () => {
    const b = new MobileBridge({ handlerMap: new Map() });
    b.pin = "123456";
    const replies = [];
    const conn = { authed: false, authTries: 0, sendText: (s) => replies.push(JSON.parse(s)), destroy: () => {} };
    const auth = (pin) => b.onWsMessage(conn, JSON.stringify({ t: "auth", pin }));
    for (let i = 0; i < 5; i++) auth("000000");
    assert.ok(b.authFailCount > 0, "счётчик не накопился");
    auth("123456");
    assert.ok(conn.authed, "не авторизовался правильным PIN");
    assert.strictEqual(b.authFailCount, 0, "счётчик не сброшен после успеха");
  });
}

// ── 5. server.js (API-защита) ───────────────────────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

function get(port, p) {
  return new Promise((resolve) => {
    const req = require("http").get({ host: "127.0.0.1", port, path: p, timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", (e) => resolve({ status: 0, body: e.message }));
  });
}

async function testServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: "ignore",
  });

  await test("server.js: стартует и отдаёт index.html", async () => {
    let ok = false;
    for (let i = 0; i < 30; i++) {
      const r = await get(port, "/");
      if (r.status === 200) { ok = true; break; }
      await new Promise((r2) => setTimeout(r2, 150));
    }
    assert.ok(ok, "сервер не поднялся");
  });

  await test("server.js: /api/llm с внутренним хостом → 403", async () => {
    const enc = encodeURIComponent("https://127.0.0.1:1234");
    const r = await get(port, "/api/llm/" + enc + "/v1/chat/completions");
    assert.strictEqual(r.status, 403, "статус " + r.status + ": " + r.body.slice(0, 80));
  });

  await test("server.js: /api/llm с http → 403", async () => {
    const enc = encodeURIComponent("http://ollama.com");
    const r = await get(port, "/api/llm/" + enc + "/v1/chat/completions");
    assert.strictEqual(r.status, 403, "статус " + r.status + ": " + r.body.slice(0, 80));
  });

  await test("server.js: /api/fetch с не-http URL → ошибка", async () => {
    const r = await get(port, "/api/fetch?url=" + encodeURIComponent("ftp://x"));
    assert.strictEqual(r.status, 200);
    assert.ok(/https?:/.test(r.body), "нет валидации URL: " + r.body.slice(0, 80));
  });

  await test("server.js: неизвестный путь → 404", async () => {
    const r = await get(port, "/nope-xyz");
    assert.strictEqual(r.status, 404);
  });

  child.kill();
}

// ── 10. self-dev: защита критичной инфраструктуры самообновления ────────────
async function testSelfDev() {
  const selfDev = require(path.join(ROOT, "src", "self-dev.js"));
  const appSrc = path.join(ROOT, "src");
  const otaRoot = path.join(os.tmpdir(), "ota-protect-test", "current");

  await test("self-dev: защищает bootstrap.js и ota.js приложения", () => {
    assert.ok(selfDev.protectedSelfPath(path.join(appSrc, "bootstrap.js"), { appSrcDir: appSrc }), "bootstrap.js не защищён");
    assert.ok(selfDev.protectedSelfPath(path.join(appSrc, "ota.js"), { appSrcDir: appSrc }), "ota.js не защищён");
  });

  await test("self-dev: защищает применённый OTA-бандл и его содержимое", () => {
    assert.ok(selfDev.protectedSelfPath(otaRoot, { appSrcDir: appSrc, otaRoot }), "корень OTA не защищён");
    assert.ok(selfDev.protectedSelfPath(path.join(otaRoot, "src", "main.js"), { appSrcDir: appSrc, otaRoot }), "файл внутри OTA не защищён");
  });

  await test("self-dev: обычные файлы проекта не блокируются", () => {
    const allowed = [
      path.join(appSrc, "main.js"),
      path.join(appSrc, "renderer", "app.js"),
      path.join(ROOT, "README.md"),
      // одноимённые файлы в ЧУЖОМ проекте не под защитой
      path.join(os.tmpdir(), "some-project", "src", "ota.js"),
    ];
    for (const p of allowed) {
      assert.ok(!selfDev.protectedSelfPath(p, { appSrcDir: appSrc, otaRoot }), "неожиданно заблокирован: " + p);
    }
  });

  await test("self-dev: сообщение об отказе содержит путь и подсказку", () => {
    const msg = selfDev.protectedSelfPathMessage(path.join(appSrc, "ota.js"), { appSrcDir: appSrc });
    assert.ok(msg.includes("заблокировано"), "нет слова «заблокировано»");
    assert.ok(msg.includes("make-ota.js"), "нет подсказки про make-ota.js");
  });
}

async function testHighlight() {
  // Модуль браузерный (window.Highlight) — подставляем минимальный шим.
  const src = fs.readFileSync(path.join(ROOT, "src", "renderer", "highlight.js"), "utf8");
  const win = {};
  new Function("window", src + "\nreturn window.Highlight;")(win);
  const H = win.Highlight;

  const decode = (t) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const strip = (html) => decode(html.replace(/<span class="tok-[\w-]+">/g, "").replace(/<\/span>/g, ""));

  const samples = [
    ["a.js", "const x = 1; // комм\nfunction f(a) { return `t ${a} < b & c`; }\n/* multi\nline */\nlet s = \"строка <тег> & амп\";\n"],
    ["a.ts", "export interface A<T> { x: T }\nclass B extends A<string> { async m() { await 1; } }\n"],
    ["a.json", '{ "key": "v", "n": 12.5e3, "b": true, "arr": [1, 2] }\n'],
    ["a.html", "<!DOCTYPE html>\n<div class=\"a\" data-x='1'>text & more</div>\n<!-- c <b> -->\n<br/>\n"],
    ["a.css", "/* c */\n.a, #b:hover { color: #fff; margin: 10px 2.5em 50%; content: \"x\"; }\n"],
    ["a.py", '#!/usr/bin/env python\n"""doc <html> & """\ndef f(x):\n    # c\n    return True if x is not None else False\n'],
    ["a.sh", '#!/bin/bash\necho "hi $USER ${HOME} <x>"\nif [ -f x ]; then cd /tmp && rm -rf y; fi\n'],
    ["a.sql", "-- c\nSELECT a, COUNT(*) FROM t WHERE x = 'a''b'; /* z */\n"],
    ["a.yml", '# c\nkey: value\nlist:\n  - a: "b"\n'],
    ["a.md", "# Заголовок\n\n```js\nconst a = 1;\n```\n\n- пункт\n> цитата [ссылка](https://x.y)\n"],
    ["a.txt", 'просто текст <b> & "строка"\n// не комментарий # тоже\n'],
    ["Dockerfile", 'FROM node:20\nRUN echo "hi" && npm i\n# c\n'],
  ];

  await test("highlight: текст после снятия тегов совпадает с исходным (12 файлов)", () => {
    for (const [name, code] of samples) {
      assert.strictEqual(strip(H.highlight(code, name)), code, "искажён текст: " + name);
    }
  });

  await test("highlight: язык определяется по расширению и имени файла", () => {
    assert.strictEqual(H.langOf("src/a/b.ts"), "js");
    assert.strictEqual(H.langOf("x.YML"), "yaml");
    assert.strictEqual(H.langOf("a.b.c.py"), "py");
    assert.strictEqual(H.langOf("Dockerfile"), "sh");
    assert.strictEqual(H.langOf(".env"), "sh");
    assert.strictEqual(H.langOf("noext"), "generic");
    assert.strictEqual(H.langOf(""), "generic");
  });

  await test("highlight: HTML в коде экранируется (живых тегов не появляется)", () => {
    const out = H.highlight('<script>alert(1)</script> & "x"', "x.js");
    assert.ok(out.indexOf("<script") === -1, "в выводе остался живой <script>");
    assert.ok(out.indexOf("&lt;script") !== -1, "нет экранирования <");
  });

  await test("highlight: ключевые слова, строки и комментарии подсвечиваются", () => {
    const js = H.highlight('const a = "s"; // c\n', "a.js");
    assert.ok(js.indexOf("tok-kw") !== -1, "нет ключевого слова");
    assert.ok(js.indexOf("tok-str") !== -1, "нет строки");
    assert.ok(js.indexOf("tok-com") !== -1, "нет комментария");
    assert.ok(H.highlight("def f():\n    return True\n", "a.py").indexOf("tok-kw") !== -1, "нет def в python");
    assert.ok(H.highlight('{ "k": 1 }', "a.json").indexOf("tok-key") !== -1, "нет ключа в json");
  });

  await test("highlight: countLines считает строки", () => {
    assert.strictEqual(H.countLines(""), 1);
    assert.strictEqual(H.countLines("a"), 1);
    assert.strictEqual(H.countLines("a\nb\n"), 3);
  });

  await test("highlight: очень большой текст не подсвечивается, но не теряется", () => {
    const big = "a".repeat(400 * 1024 + 10);
    assert.strictEqual(decode(H.highlight(big, "big.js")), big);
  });
}

// ── 11. Хранение чатов: атомарная запись, .bak-восстановление, автосейв ──────
async function testChatPersistence() {
  // Функции хранения берём прямо из main.js (реальный код, не копия).
  const mainSrc = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const s0 = mainSrc.indexOf("// Чтение чатов:");
  const s1 = mainSrc.indexOf("// ─────────────────────────── Пути и файлы");
  assert.ok(s0 > 0 && s1 > s0, "не нашёл функции хранения чатов в main.js");
  const chatCode = mainSrc.slice(s0, s1);

  function makeStore(dir) {
    const chatMod = new Function(
      "fs",
      "path",
      "chatsFile",
      chatCode + "\nreturn { loadChats, saveChats };"
    );
    return chatMod(fs, path, () => path.join(dir, "chats.json"));
  }

  await test("chats: атомарная запись — нет .tmp, есть .bak, основной файл валиден", () => {
    const dir = tmpdir("chats-atomic-");
    const { loadChats, saveChats } = makeStore(dir);
    saveChats({ chats: [{ id: "a", messages: [{ role: "user", content: "1" }] }], activeId: "a" });
    assert.ok(fs.existsSync(path.join(dir, "chats.json")), "нет chats.json");
    assert.ok(!fs.existsSync(path.join(dir, "chats.json.tmp")), "остался chats.json.tmp");
    saveChats({ chats: [{ id: "b", messages: [] }], activeId: "b" });
    assert.ok(!fs.existsSync(path.join(dir, "chats.json.tmp")), "остался chats.json.tmp после 2-й записи");
    assert.ok(fs.existsSync(path.join(dir, "chats.json.bak")), "нет резервной копии .bak");
    assert.strictEqual(loadChats().activeId, "b");
  });

  await test("chats: обрезанный (битый) основной файл → история поднимается из .bak", () => {
    const dir = tmpdir("chats-recover-");
    const { loadChats, saveChats } = makeStore(dir);
    saveChats({ chats: [{ id: "keep", messages: [] }], activeId: "keep" });
    saveChats({ chats: [{ id: "new", messages: [] }], activeId: "new" });
    // Имитируем внезапное закрытие во время записи: файл обрезан.
    fs.writeFileSync(path.join(dir, "chats.json"), '{"chats": [{"id": "new"', "utf8");
    const loaded = loadChats();
    assert.strictEqual(loaded.activeId, "keep", "не восстановилось из .bak: " + JSON.stringify(loaded));
    assert.strictEqual(loaded.chats[0].id, "keep");
  });

  await test("chats: битый JSON без .bak → пустая история, без исключения", () => {
    const dir = tmpdir("chats-broken-");
    fs.writeFileSync(path.join(dir, "chats.json"), "не json", "utf8");
    const { loadChats } = makeStore(dir);
    assert.deepStrictEqual(loadChats(), { chats: [], activeId: null });
  });

  // Логику автосохранения берём из renderer/app.js и подсовываем заглушки окружения.
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
  const a0 = appSrc.indexOf("  function persistChats() {");
  const vis = appSrc.indexOf('  document.addEventListener("visibilitychange"');
  const a1 = appSrc.indexOf("});", vis) + 3;
  assert.ok(a0 > 0 && vis > a0 && a1 > vis, "не нашёл блок автосохранения чатов в app.js");

  function makeAutosave(syncSupported) {
    const block = appSrc.slice(a0, a1);
    const syncSaves = [];
    const asyncSaves = [];
    const timers = [];
    const handlers = { window: {}, document: {} };
    const win = { addEventListener: (n, cb) => { handlers.window[n] = cb; } };
    const doc = { addEventListener: (n, cb) => { handlers.document[n] = cb; }, visibilityState: "visible" };
    const api = {
      saveChats: (d) => asyncSaves.push(d),
    };
    if (syncSupported) api.saveChatsSync = (d) => syncSaves.push(d);
    const mk = new Function(
      "window",
      "document",
      "isElectron",
      "api",
      "chatsData",
      "localStorage",
      "setTimeout",
      "clearTimeout",
      block + "\nreturn { persistChats, persistChatsSoon, persistChatsNow, flushChats };"
    );
    const fns = mk(
      win,
      doc,
      true,
      api,
      { chats: [{ id: "c1", messages: [] }], activeId: "c1" },
      { setItem() {} },
      (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
      (t) => { if (t) t.cancelled = true; }
    );
    return { ...fns, syncSaves, asyncSaves, timers, handlers, doc };
  }

  await test("чаты: throttle — пачка правок даёт одну запись, а не десять", () => {
    const a = makeAutosave(true);
    for (let i = 0; i < 10; i++) a.persistChatsSoon();
    assert.strictEqual(a.timers.length, 1, "запланировано таймеров: " + a.timers.length);
    assert.strictEqual(a.syncSaves.length + a.asyncSaves.length, 0, "запись произошла сразу, без задержки");
    a.timers[0].fn();
    assert.strictEqual(a.asyncSaves.length, 1, "после интервала должно быть ровно одно сохранение");
  });

  await test("чаты: закрытие окна (beforeunload) пишет синхронно — данные не теряются", () => {
    const a = makeAutosave(true);
    a.persistChatsSoon(); // правки во время ответа ещё не сброшены
    assert.ok(typeof a.handlers.window.beforeunload === "function", "нет обработчика beforeunload");
    a.handlers.window.beforeunload();
    assert.strictEqual(a.syncSaves.length, 1, "синхронное сохранение не сработало");
    assert.strictEqual(a.asyncSaves.length, 0, "при закрытии должен идти только синхронный путь");
    // Свёрнутая страница (мобильный режим) — тоже сбрасываем.
    a.persistChatsSoon();
    a.doc.visibilityState = "hidden";
    a.handlers.document.visibilitychange();
    assert.strictEqual(a.syncSaves.length, 2, "скрытие страницы не сохранило данные");
  });

  await test("чаты: без новых правок закрытие окна ничего не пишет", () => {
    const a = makeAutosave(true);
    a.handlers.window.beforeunload();
    assert.strictEqual(a.syncSaves.length + a.asyncSaves.length, 0, "лишняя запись на диск");
  });

  await test("чаты: завершение хода пишет сразу и отменяет отложенную запись", () => {
    const a = makeAutosave(true);
    a.persistChatsSoon();
    a.persistChatsNow();
    assert.strictEqual(a.asyncSaves.length, 1, "немедленной записи не было");
    a.timers.forEach((t) => { if (!t.cancelled) t.fn(); });
    assert.strictEqual(a.asyncSaves.length, 1, "отменённый таймер всё же записал файл");
  });

  await test("чаты: без синхронного канала (мобильный мост) сохранение всё равно происходит", () => {
    const a = makeAutosave(false);
    a.persistChatsSoon();
    a.handlers.window.beforeunload();
    assert.strictEqual(a.asyncSaves.length, 1, "асинхронный путь не сработал");
  });

  // Восстановление «подвисших» сообщений после аварийного закрытия.
  const sIdx = appSrc.indexOf("  function sanitizeChats(d) {");
  assert.ok(sIdx > 0, "не нашёл sanitizeChats в app.js");
  const rawLines = appSrc.slice(sIdx).split("\n");
  let endLine = -1;
  for (let i = 1; i < rawLines.length; i++) {
    if (rawLines[i] === "  }") { endLine = i; break; }
  }
  assert.ok(endLine > 0, "не нашёл конец функции sanitizeChats");
  const sanitizeChats = new Function(rawLines.slice(0, endLine + 1).join("\n") + "\nreturn sanitizeChats;")();

  await test("чаты: после аварийного закрытия не остаётся вечных «выполняется»", () => {
    const out = sanitizeChats({
      activeId: "c1",
      chats: [
        {
          id: "c1",
          messages: [
            { id: "u", role: "user", content: "привет" },
            { id: "a", role: "assistant", content: "частичный ответ", pending: true },
            { id: "t", role: "tool", toolName: "runCommand", toolResult: null, pending: true },
          ],
        },
        { id: "c2", messages: [{ id: "a2", role: "assistant", content: "", pending: true }] },
      ],
    });
    const msgs = out.chats[0].messages;
    assert.strictEqual(msgs[1].pending, false, "assistant остался незавершённым");
    assert.strictEqual(msgs[1].content, "частичный ответ", "текст ответа потерян");
    assert.strictEqual(msgs[2].pending, false, "tool остался незавершённым");
    assert.strictEqual(msgs[2].toolOk, false);
    assert.ok(msgs[2].toolResult.indexOf("закрыл") !== -1, "нет пояснения к прерванному действию");
    assert.strictEqual(msgs[msgs.length - 1].role, "system", "нет пометки о прерывании");
    assert.ok(msgs[msgs.length - 1].content.indexOf("прерван") !== -1, "пометка без пояснения");
    // В неактивном чате флаг тоже снимается, но лишней пометки не появляется.
    assert.strictEqual(out.chats[1].messages[0].pending, false);
    assert.strictEqual(out.chats[1].messages[0].content, "…");
    assert.strictEqual(out.chats[1].messages.length, 1, "лишняя пометка в неактивном чате");
  });

  await test("чаты: целая история при загрузке не меняется", () => {
    const d = { activeId: "c1", chats: [{ id: "c1", messages: [{ id: "u", role: "user", content: "ок" }] }] };
    const before = JSON.stringify(d);
    assert.strictEqual(JSON.stringify(sanitizeChats(d)), before, "sanitizeChats испортил целую историю");
  });

  await test("чаты: битые данные не ломают загрузку", () => {
    assert.deepStrictEqual(sanitizeChats(null), { chats: [], activeId: null });
    assert.strictEqual(sanitizeChats({ chats: "нет" }).chats, "нет");
    const fixed = sanitizeChats({ chats: [{ id: "x" }], activeId: "x" });
    assert.deepStrictEqual(fixed.chats[0].messages, [], "messages не восстановлен в массив");
  });
}

// ── 6.5 mail: почта (SMTP/IMAP) ─────────────────────────────────────────────
async function testMail() {
  const mail = require(path.join(ROOT, "src", "mail.js"));
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));

  await test("mail: пресеты серверов по домену адреса", () => {
    const g = mail.guessServers("user@gmail.com");
    assert.strictEqual(g.imapHost, "imap.gmail.com");
    assert.strictEqual(g.smtpPort, 465);
    assert.ok(/пароль приложения/.test(g.note), "нет подсказки про пароль приложения");
    assert.strictEqual(mail.guessServers("user@yandex.ru").imapHost, "imap.yandex.ru");
    assert.strictEqual(mail.guessServers("user@mail.ru").smtpHost, "smtp.mail.ru");
    const o = mail.guessServers("user@outlook.com");
    assert.strictEqual(o.starttls, true);
    assert.strictEqual(o.smtpPort, 587);
    const u = mail.guessServers("user@my-firm.ru");
    assert.strictEqual(u.preset, false);
    assert.strictEqual(u.imapHost, "imap.my-firm.ru");
    assert.strictEqual(mail.guessServers("").smtpHost, "");
  });

  await test("mail: письмо — тема RFC 2047, получатели, base64-тело, защита от инъекции", () => {
    const msg = mail.buildMessage({
      from: "Михаил <me@yandex.ru>",
      to: ["client@example.com", "boss@example.com"],
      subject: "КП: предложение",
      text: "Здравствуйте!\n.точка в начале",
      date: new Date("2026-09-11T10:20:30Z"),
    });
    assert.ok(/Subject: =\?UTF-8\?B\?/.test(msg), "тема не закодирована RFC 2047");
    assert.ok(msg.includes("To: client@example.com, boss@example.com"), "получатели не в To");
    assert.ok(/Date: \w{3}, \d{2} \w{3} \d{4}/.test(msg), "нет корректной даты");
    const body = msg.split("\r\n\r\n")[1].replace(/\s+/g, "");
    assert.ok(Buffer.from(body, "base64").toString("utf8").includes("точка в начале"), "тело не декодируется обратно");
    const injected = mail.buildMessage({ from: "a@b.ru", to: "c@d.ru", subject: "Тема\r\nBcc: hacker@evil.com", text: "x" });
    assert.ok(!/\r\nBcc:/i.test(injected), "прошла инъекция заголовка");
    const multi = mail.buildMessage({ from: "a@b.ru", to: "c@d.ru", subject: "s", text: "t", html: "<p>t</p>" });
    assert.ok(/multipart\/alternative/.test(multi) && /text\/html/.test(multi), "нет multipart/alternative");
  });

  await test("mail: windows-1251 и UTF-8 декодируются без потерь", () => {
    const win = Buffer.from([0xCF, 0xE0, 0xF0, 0xEE, 0xEB, 0xFC, 0x3A, 0x20, 0x37, 0x37, 0x37, 0x38, 0x38, 0x38]);
    assert.strictEqual(mail.decodeBytes(win, "windows-1251"), "Пароль: 777888");
    assert.strictEqual(mail.decodeBytes(Buffer.from("Привет", "utf8"), "UTF-8"), "Привет");
    // Письмо объявлено UTF-8, а байты на самом деле cp1251 — спасаем (частая беда рассылок).
    assert.strictEqual(mail.decodeBytes(win, "utf-8"), "Пароль: 777888");
  });

  await test("mail: разбор письма (тема, отправитель, код) и эвристика кода", () => {
    const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
    const raw = [
      "From: =?UTF-8?B?" + b64("Сервис Госуслуги") + "?= <noreply@gosuslugi.ru>",
      "Subject: =?UTF-8?B?" + b64("Ваш код подтверждения") + "?=",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64("Ваш код: 483920"),
      "",
    ].join("\r\n");
    const m = mail.parseMessage(raw, 7);
    assert.strictEqual(m.subject, "Ваш код подтверждения");
    assert.ok(m.from.includes("Сервис Госуслуги"), "отправитель не декодирован");
    assert.strictEqual(m.fromAddress, "noreply@gosuslugi.ru");
    assert.strictEqual(mail.extractCode(m.text), "483920");
    assert.strictEqual(mail.extractCode("Your verification code is 55221"), "55221");
    assert.strictEqual(mail.extractCode("Код 9876 (2026)"), "9876", "год не должен считаться кодом");
    assert.strictEqual(mail.extractCode(""), null);
    assert.strictEqual(mail.extractCode("просто текст без цифр"), null);
    assert.ok(mail.isEmail("a@b.ru"));
    assert.ok(!mail.isEmail("мусор") && !mail.isEmail("a@b") && !mail.isEmail(""));
  });

  await test("mail: интеграция — инструменты агента, промпт, мост и настройки", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name);
    for (const n of ["mailSend", "mailList", "mailCode"]) assert.ok(names.includes(n), "нет инструмента " + n);
    const prompt = core.SYSTEM_PROMPT || "";
    assert.ok(/Почта \(SMTP\/IMAP/.test(prompt), "в промпте нет правила про почту");
    const preload = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
    for (const s of ["mail:test", "mail:recent", "mail:testSend"]) assert.ok(preload.includes(s), "в preload нет " + s);
    const main = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    assert.ok(main.includes('require("./mail.js")'), "main.js не подключает mail.js");
    for (const s of ['case "mailSend"', 'case "mailList"', 'case "mailCode"', 'ipcMain.handle("mail:test"']) {
      assert.ok(main.includes(s), "в main.js нет " + s);
    }
    const secrets = fs.readFileSync(path.join(ROOT, "src", "secrets.js"), "utf8");
    assert.ok(secrets.includes('"mailPassword"'), "пароль почты не в списке секретов");
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    for (const id of ["s-mail-address", "s-mail-pass", "s-mail-imap-host", "s-mail-smtp-host", "s-mail-allow-send", "btn-mail-test"]) {
      assert.ok(html.includes('id="' + id + '"'), "в index.html нет " + id);
    }
    const app = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
    assert.ok(app.includes('settings.mailAddress = $("s-mail-address")'), "app.js не сохраняет адрес почты");
    assert.ok(app.includes("mailDoTest") && app.includes("mailFillServers"), "app.js не содержит логики почты");
  });
}

// ── Yandex Cloud: логи внутренним API + встроенный yc CLI ──────────────────
async function testYandexCloud() {
  const ycCli = require(path.join(ROOT, "src", "yc-cli.js"));
  const ycLogs = require(path.join(ROOT, "src", "yc-logs.js"));
  const core = require(path.join(ROOT, "src", "renderer", "agent-core.js"));
  const http2 = require("http2");

  await test("yc-logs: протобаф — критерий запроса и разбор ответа (уровень, ресурс, время)", () => {
    const req = ycLogs.buildReadRequest({
      logGroupId: "grp-1",
      resourceIds: ["cont-1"],
      resourceTypes: ["serverless.container"],
      sinceMs: 1700000000000,
      untilMs: 1700003600000,
      pageSize: 50,
      filter: 'level = "ERROR"',
    });
    const crit = ycLogs.pbDecode(req).find((f) => f.field === 2 && f.wire === 2);
    assert.ok(crit, "в запросе нет criteria");
    const c = ycLogs.pbDecode(crit.buf);
    const str = (num) => {
      const f = c.find((x) => x.field === num && x.wire === 2);
      return f ? f.buf.toString("utf8") : "";
    };
    assert.strictEqual(str(1), "grp-1");
    assert.strictEqual(str(2), "serverless.container");
    assert.strictEqual(str(3), "cont-1");
    assert.strictEqual(str(7), 'level = "ERROR"');
    assert.strictEqual(Number(c.find((f) => f.field === 8 && f.wire === 0).num), 50);
    assert.ok(c.some((f) => f.field === 4 && f.wire === 2), "нет since");
    assert.ok(c.some((f) => f.field === 5 && f.wire === 2), "нет until");

    const resource = Buffer.concat([ycLogs.pbString(1, "serverless.container"), ycLogs.pbString(2, "cont-1")]);
    const entry = Buffer.concat([
      ycLogs.pbString(1, "uid-1"),
      ycLogs.pbMessage(2, resource),
      ycLogs.pbMessage(3, Buffer.concat([ycLogs.pbInt(1, 1700000000), ycLogs.pbInt(2, 500000000)])),
      ycLogs.pbInt(6, 5),
      ycLogs.pbString(7, "контейнер упал: timeout"),
    ]);
    const entries = ycLogs.parseReadResponse(Buffer.concat([ycLogs.pbString(1, "grp-1"), ycLogs.pbMessage(2, entry)]));
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].message, "контейнер упал: timeout");
    assert.strictEqual(entries[0].level, 5);
    assert.strictEqual(entries[0].resourceId, "cont-1");
    assert.strictEqual(entries[0].timestamp, 1700000000500);
    assert.strictEqual(ycLogs.LEVEL_NAMES[5], "ERROR");
    const line = ycLogs.formatEntries(entries, { max: 5 })[0];
    assert.ok(line.includes("ERROR") && line.includes("timeout"), "строка лога: " + line);
    assert.deepStrictEqual(ycLogs.parseReadResponse(Buffer.alloc(0)), []);
  });

  await test("yc-logs: gRPC-кадры разделяются, обрезанный кадр не съедает мусор", () => {
    const frame = (buf) => {
      const h = Buffer.alloc(5);
      h.writeUInt8(0, 0);
      h.writeUInt32BE(buf.length, 1);
      return Buffer.concat([h, buf]);
    };
    const parts = ycLogs.grpcFrames(Buffer.concat([frame(Buffer.from("первый")), frame(Buffer.from("второй"))]));
    assert.strictEqual(parts.length, 2);
    assert.strictEqual(parts[1].toString("utf8"), "второй");
    assert.strictEqual(ycLogs.grpcFrames(Buffer.concat([frame(Buffer.from("ок")), Buffer.from([0, 0, 0, 0, 99, 1, 2])])).length, 1);
  });

  await test("yc-logs: живой обмен — лог-группы по REST, записи по gRPC (http2), внешний yc не нужен", async () => {
    const resource = Buffer.concat([ycLogs.pbString(1, "serverless.container"), ycLogs.pbString(2, "cont-42")]);
    const entry = Buffer.concat([
      ycLogs.pbString(1, "u"),
      ycLogs.pbMessage(2, resource),
      ycLogs.pbInt(6, 3),
      ycLogs.pbString(7, "hello from logs"),
    ]);
    const respBuf = Buffer.concat([ycLogs.pbString(1, "grp"), ycLogs.pbMessage(2, entry)]);
    let seenAuth = "";
    let seenPath = "";
    const server = http2.createServer();
    server.on("stream", (stream, headers) => {
      seenAuth = String(headers.authorization || "");
      seenPath = String(headers[":path"] || "");
      const h = Buffer.alloc(5);
      h.writeUInt8(0, 0);
      h.writeUInt32BE(respBuf.length, 1);
      stream.respond({ ":status": 200, "content-type": "application/grpc+proto", "grpc-status": "0" });
      stream.end(Buffer.concat([h, respBuf]));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      const res = await ycLogs.readLogs({
        iamToken: "t.IAM",
        baseUrl: "http://127.0.0.1:" + port,
        folderId: "folder-1",
        resourceIds: ["cont-42"],
        resourceTypes: ["serverless.container"],
        limit: 10,
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ groups: [{ id: "grp", name: "default" }] }) }),
      });
      assert.strictEqual(res.logGroupId, "grp");
      assert.strictEqual(res.logGroupName, "default");
      assert.strictEqual(res.entries.length, 1);
      assert.strictEqual(res.entries[0].message, "hello from logs");
      assert.strictEqual(seenAuth, "Bearer t.IAM");
      assert.strictEqual(seenPath, "/yandex.cloud.logging.v1.LogReadingService/Read");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  await test("yc-logs: нет лог-групп и ошибки gRPC объясняются человеку", async () => {
    const noGroups = await ycLogs
      .readLogs({ iamToken: "t", baseUrl: "http://127.0.0.1:1", folderId: "f", fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }) })
      .then(() => null, (e) => e);
    assert.ok(noGroups && /нет ни одной лог-группы/.test(noGroups.message), "сообщение: " + (noGroups && noGroups.message));

    const bad = await ycLogs
      .readLogs({
        iamToken: "t",
        baseUrl: "http://127.0.0.1:1",
        folderId: "f",
        fetchImpl: async () => ({ ok: false, status: 403, text: async () => "Permission denied" }),
      })
      .then(() => null, (e) => e);
    assert.ok(bad && /HTTP 403/.test(bad.message), "сообщение: " + (bad && bad.message));

    const noFolder = await ycLogs.readLogs({ iamToken: "t", baseUrl: "http://127.0.0.1:1", folderId: "" }).then(() => null, (e) => e);
    assert.ok(noFolder && /каталог/.test(noFolder.message), "сообщение: " + (noFolder && noFolder.message));

    // Понятная подсказка по коду gRPC (нет прав / плохой токен / нет группы).
    const g = ycLogs.grpcCall("http://127.0.0.1:1", "/x", "t", Buffer.alloc(0), 2000).then(() => null, (e) => e);
    const ge = await g;
    assert.ok(ge instanceof Error, "нет ошибки при недоступном сервере");
  });

  await test("yc-cli: платформа, версия и адреса бинаря (официальная схема хранилища)", () => {
    assert.deepStrictEqual(ycCli.platformInfo("win32", "x64"), { ok: true, os: "windows", arch: "amd64", binName: "yc.exe" });
    assert.strictEqual(ycCli.platformInfo("darwin", "arm64").arch, "arm64");
    assert.strictEqual(ycCli.platformInfo("linux", "x64").binName, "yc");
    assert.strictEqual(ycCli.platformInfo("linux", "ia32").arch, "386");
    assert.strictEqual(ycCli.platformInfo("win32", "arm64").ok, false, "Windows/ARM не поддерживается");
    assert.strictEqual(ycCli.platformInfo("aix", "x64").ok, false);
    assert.ok(ycCli.versionUrl().endsWith("/release/stable"));
    assert.strictEqual(
      ycCli.binaryUrl("0.140.0", "linux", "amd64", "yc"),
      "https://storage.yandexcloud.net/yandexcloud-yc/release/0.140.0/linux/amd64/yc"
    );
    assert.ok(ycCli.binDir("/tmp/x").endsWith(path.join("x", "bin")));
    assert.strictEqual(ycCli.installed("/tmp/нет-такой-папки-xyz"), null);
  });

  await test("yc-cli: установка кладёт бинарь в папку приложения и не оставляет .tmp", async () => {
    const dir = tmpdir("yc-cli-");
    const big = Buffer.alloc(1024 * 1024 + 64, 7);
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.endsWith("/release/stable")) return { ok: true, status: 200, text: async () => "0.140.0" };
      return { ok: true, status: 200, arrayBuffer: async () => big };
    };
    const r = await ycCli.install({ userData: dir, platform: "linux", arch: "x64", fetchImpl, timeoutMs: 5000 });
    assert.ok(r.ok, "установка не прошла: " + (r && r.error));
    assert.strictEqual(r.version, "0.140.0");
    const target = path.join(ycCli.binDir(dir), "yc");
    assert.ok(fs.existsSync(target), "бинарь не появился");
    assert.strictEqual(fs.statSync(target).size, big.length);
    assert.ok(!fs.existsSync(target + ".tmp"), "остался временный файл");
    assert.strictEqual(ycCli.installed(dir), target);
    assert.ok(calls.some((u) => u.includes("/0.140.0/linux/amd64/yc")), "скачан не тот бинарь: " + calls.join(", "));
  });

  await test("yc-cli: недокачанный файл не подменяет бинарь, мусор не остаётся", async () => {
    const dir = tmpdir("yc-cli-bad-");
    const small = await ycCli.install({
      userData: dir,
      platform: "linux",
      arch: "x64",
      fetchImpl: async (url) =>
        url.endsWith("stable") ? { ok: true, status: 200, text: async () => "0.140.0" } : { ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(10) },
    });
    assert.strictEqual(small.ok, false);
    assert.ok(!fs.existsSync(path.join(ycCli.binDir(dir), "yc")), "недокачанный файл не должен занимать место бинаря");
    assert.ok(!fs.existsSync(path.join(ycCli.binDir(dir), "yc.tmp")), "остался .tmp");

    const bad = await ycCli.install({ userData: dir, platform: "linux", arch: "x64", fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>error</html>" }) });
    assert.strictEqual(bad.ok, false);
    assert.ok(/Неожиданный ответ/.test(bad.error), "сообщение: " + bad.error);

    const offline = await ycCli.install({ userData: dir, platform: "linux", arch: "x64", fetchImpl: async () => { throw new Error("нет сети"); } });
    assert.strictEqual(offline.ok, false);
    assert.ok(/нет связи/i.test(offline.error), "сообщение: " + offline.error);

    const noDir = await ycCli.install({ userData: "", fetchImpl: async () => ({ ok: true, status: 200, text: async () => "1.0.0" }) });
    assert.strictEqual(noDir.ok, false);
    const noFetch = await ycCli.install({ userData: dir, fetchImpl: null, platform: "sunos", arch: "x64" });
    assert.strictEqual(noFetch.ok, false);
  });

  await test("Yandex Cloud: токен и каталог автоматически уходят в окружение команд", () => {
    const main = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    assert.ok(main.includes('require("./yc-cli.js")') && main.includes('require("./yc-logs.js")'), "модули не подключены");
    assert.ok(/function ycAutoEnv\(s\)/.test(main), "нет ycAutoEnv");
    assert.ok(/out\.YC_TOKEN = cfg\.oauth/.test(main), "токен не подставляется");
    assert.ok(/out\.YC_CLOUD_ID = cfg\.cloudId/.test(main), "cloudId не подставляется");
    assert.ok(/out\.YC_FOLDER_ID = cfg\.folderId/.test(main), "folderId не подставляется");
    assert.ok(main.includes("agentEnv = { ...userAgentEnv, ...ycAutoEnv(s) }"), "окружение не собирается из двух частей");
    assert.ok(main.includes("applyAgentEnv(s);"), "loadSettings не пересобирает окружение");
    assert.ok(main.includes("applyAgentEnv(merged);"), "смена настроек не пересобирает окружение");
    // Автоподстановка не должна оседать в настройках: сохраняем только пользовательское.
    assert.ok(main.includes("s.agentEnv = { ...userAgentEnv }"), "в настройки пишется не только пользовательское");
    assert.ok(!main.includes("s.agentEnv = { ...agentEnv }"), "в настройки попадает объединённое окружение");
    assert.ok(main.includes("YC_TOKEN") && main.includes("[авто: Yandex Cloud]"), "envList не помечает автоматические переменные");
    assert.ok(/подставляется автоматически из настроек Yandex Cloud/.test(main), "envUnset не защищает автоматические переменные");
    // Папка встроенного yc CLI — в PATH всех команд.
    assert.ok(/function ycEnsurePath\(\)/.test(main), "нет ycEnsurePath");
    assert.ok(main.includes('ycCli.binDir(app.getPath("userData"))'), "не берётся папка приложения");
    assert.ok(main.includes("setMergedPath(before, dir)"), "PATH не обновляется");
  });

  await test("Yandex Cloud: ycLogs идёт через внутренний API — внешний yc CLI больше не нужен", () => {
    const main = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    assert.ok(/async function readYcLogsText\(/.test(main), "нет чтения логов внутренним API");
    assert.ok(main.includes('yandexCloud.endpoint("logging")'), "нет адреса сервиса логирования");
    assert.ok(main.includes("ycLogs.readLogs("), "не вызывается модуль логов");
    assert.ok(!main.includes("yc logging read"), "остался вызов внешнего yc CLI");
    assert.ok(!main.includes('findProgram("yc")'), "логи всё ещё ищут внешний yc");
    assert.ok(main.includes('ipcMain.handle("yc:logs"') && main.includes("readYcLogsText(cfg,"), "IPC логов не переведён");
    assert.ok(main.includes('case "ycLogs"') && main.includes('case "ycInstall"'), "нет инструментов ycLogs/ycInstall");
    assert.ok(main.includes('ipcMain.handle("yc:cliStatus"') && main.includes('ipcMain.handle("yc:installCli"'), "нет IPC встроенного yc CLI");
    assert.ok(main.includes("const YC_RESOURCE_TYPES") && main.includes("serverless.container"), "нет карты типов ресурсов");
  });

  await test("Yandex Cloud: инструменты, алиасы промпта, мост и интерфейс согласованы", () => {
    const names = core.TOOL_DEFINITIONS.map((d) => d.function && d.function.name);
    for (const n of ["ycStatus", "ycList", "ycCreate", "ycDelete", "ycDeploy", "ycLogs", "ycInstall"]) {
      assert.ok(names.includes(n), "нет инструмента " + n);
    }
    const prompt = core.SYSTEM_PROMPT || "";
    for (const n of ["ycLogs", "ycInstall"]) assert.ok(prompt.includes(n), "в промпте нет " + n);
    assert.ok(/yc init не нужен/.test(prompt), "в промпте нет пояснения про автоматическую авторизацию");
    assert.ok(/внутренним API Cloud Logging/.test(prompt), "в промпте не сказано, что логи идут внутренним API");
    const logsDef = core.TOOL_DEFINITIONS.find((d) => d.function && d.function.name === "ycLogs");
    assert.ok(/внутренним API/.test(logsDef.function.description), "описание ycLogs не обновлено");
    assert.deepStrictEqual(logsDef.function.parameters.required, ["id"], "id должен быть единственным обязательным");
    const installDef = core.TOOL_DEFINITIONS.find((d) => d.function && d.function.name === "ycInstall");
    assert.ok(/userData\/bin/.test(installDef.function.description), "описание ycInstall без папки установки");
    const preload = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
    for (const s of ["ycCliStatus", "ycInstallCli"]) assert.ok(preload.includes(s), "в preload нет " + s);
    const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
    for (const id of ["btn-yc-install-cli", "yc-cli-status"]) assert.ok(html.includes('id="' + id + '"'), "в index.html нет " + id);
    const app = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");
    assert.ok(app.includes("api.ycInstallCli()"), "app.js не устанавливает yc CLI");
    assert.ok(app.includes("api.ycCliStatus()"), "app.js не показывает статус yc CLI");
    assert.ok(app.includes('$("btn-yc-install-cli")'), "в app.js нет обработчика кнопки");
  });

  await test("readYcLogsText: берёт реальный код main.js и собирает запрос из настроек", async () => {
    const main = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
    const s0 = main.indexOf("// Ключ сервиса → тип ресурса Cloud Logging");
    const s1 = main.indexOf("// Встроенный yc CLI:");
    assert.ok(s0 > 0 && s1 > s0, "не нашёл helpers логирования в main.js");
    const code = main.slice(s0, s1);

    const mkApi = (logGroup) => {
      const captured = { token: "", svc: "", read: null };
      const sandbox = {
        yandexCloud: {
          getIamToken: async (t) => {
            captured.token = t;
            return "iam-1";
          },
          endpoint: async (svc) => {
            captured.svc = svc;
            return "https://logging.test";
          },
        },
        ycLogs: {
          readLogs: async (o) => {
            captured.read = o;
            return logGroup;
          },
          formatEntries: (entries, o) => entries.map((e) => "FMT:" + e.message + " max=" + o.max),
        },
      };
      const fn = new Function(...Object.keys(sandbox), code + "\nreturn { readYcLogsText, YC_RESOURCE_TYPES };");
      return { api: fn(...Object.values(sandbox)), captured };
    };

    const ok = mkApi({ logGroupId: "grp", logGroupName: "default", entries: [{ timestamp: 1700000000000, level: 3, resourceId: "c1", message: "ok", json: null }] });
    assert.strictEqual(ok.api.YC_RESOURCE_TYPES.serverlessContainers, "serverless.container");
    const text = await ok.api.readYcLogsText({ oauth: "y0", folderId: "f1" }, "serverlessContainers", "cont-9", { limit: 7, sinceHours: 12 });
    assert.strictEqual(ok.captured.token, "y0", "IAM-токен должен браться из настроек");
    assert.strictEqual(ok.captured.svc, "logging", "адрес берётся у сервиса logging");
    assert.strictEqual(ok.captured.read.baseUrl, "https://logging.test");
    assert.strictEqual(ok.captured.read.folderId, "f1");
    assert.deepStrictEqual(ok.captured.read.resourceIds, ["cont-9"]);
    assert.deepStrictEqual(ok.captured.read.resourceTypes, ["serverless.container"], "тип ресурса выводится из ключа сервиса");
    assert.strictEqual(ok.captured.read.limit, 7);
    assert.strictEqual(ok.captured.read.sinceHours, 12);
    assert.ok(text.includes("FMT:ok max=50"), "записи не отформатированы: " + text);
    assert.ok(text.includes("12 ч") && text.includes("default"), "в ответе нет окна времени/группы: " + text);

    // Без каталога запрос не уходит — сразу понятная ошибка.
    await assert.rejects(() => ok.api.readYcLogsText({ oauth: "y", folderId: "" }, "", "id", {}), /каталог/);

    // Пустые логи — честное «логов нет», а не пустая строка.
    const empty = mkApi({ logGroupId: "g", logGroupName: "", entries: [] });
    const emptyText = await empty.api.readYcLogsText({ oauth: "y", folderId: "f" }, "", "id", {});
    assert.ok(/Логов за последние 3 ч нет/.test(emptyText), "сообщение: " + emptyText);
  });

}

// ── 5. Оболочка (shell), коды ошибок, установщики и свой Chrome по CDP ─────
async function testShellAndCdp() {
  const http = require("http");
  const mainFull = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
  const core2 = fs.readFileSync(path.join(ROOT, "src", "renderer", "agent-core.js"), "utf8");
  const pre2 = fs.readFileSync(path.join(ROOT, "src", "preload.js"), "utf8");
  const html2 = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const app2 = fs.readFileSync(path.join(ROOT, "src", "renderer", "app.js"), "utf8");

  // ── Реальный срез main.js: выбор оболочки и PowerShell-кодирование ────────
  const h0 = mainFull.indexOf("function shellArgsFor(command) {");
  const h1 = mainFull.indexOf("// Запуск произвольной команды в терминале");
  assert.ok(h0 > 0 && h1 > h0, "не нашёл блок оболочек в main.js");
  const helpers = mainFull.slice(h0, h1);
  const mkHelpers = (findProgram) =>
    new Function("fs", "path", "process", "findProgram", helpers + "; return { normalizeShell, powershellArgs, resolveShell };")(
      fs, path, process, findProgram
    );
  const H = mkHelpers((name) => ({ found: true, path: "/usr/bin/" + name }));

  await test("shell: псевдонимы оболочек и команда PowerShell без искажений", () => {
    assert.strictEqual(H.normalizeShell("PS"), "powershell");
    assert.strictEqual(H.normalizeShell("pwsh"), "pwsh");
    assert.strictEqual(H.normalizeShell("git-bash"), "bash");
    assert.strictEqual(H.normalizeShell("КОМАНДНАЯ СТРОКА"), "cmd");
    assert.strictEqual(H.normalizeShell("calc.exe"), "", "мусор не должен становиться оболочкой");
    const ps = H.powershellArgs('Get-Process | Where-Object { $_.Name -eq "node" }');
    assert.ok(ps.includes("-EncodedCommand"), "нет -EncodedCommand");
    assert.ok(ps.includes("-NoProfile"), "нет тихих ключей");
    const decoded = Buffer.from(ps[ps.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
    assert.ok(/UTF8/.test(decoded), "нет UTF-8 на выходе PowerShell");
    assert.ok(decoded.includes('$_.Name -eq "node"'), "команда искажена: " + decoded);
    assert.deepStrictEqual(H.resolveShell("echo $HOME", "bash").args, ["-lc", "echo $HOME"]);
    assert.strictEqual(H.resolveShell("echo hi", "").kind, process.platform === "win32" ? "cmd" : "sh");
  });

  await test("shell: нет оболочки — подсказка, а не безликий «код 1»", () => {
    const noPs = mkHelpers(() => ({ found: false, reason: "нет" }));
    assert.ok(/installSystemPackage/.test(noPs.resolveShell("x", "powershell").shellHint), "нет подсказки про установку PowerShell");
    assert.ok(/shell: "cmd"/.test(noPs.resolveShell("x", "powershell").shellHint), "нет альтернативы cmd");
    const cmdCode = mainFull.slice(mainFull.indexOf("function runTerminalCommand(command, cwd, timeoutMs, shellName)"));
    assert.ok(/sh\.shellHint/.test(cmdCode), "подсказка оболочки не попадает в ответ");
    assert.ok(/const sh = resolveShell\(command, shellName\)/.test(cmdCode), "runTerminalCommand не использует выбор оболочки");
    const rc = mainFull.slice(mainFull.indexOf('case "runCommand"'), mainFull.indexOf('case "startBackground"'));
    assert.ok(/normalizeShell\(shellRaw\)/.test(rc), "runCommand не проверяет оболочку");
    assert.ok(/runTerminalCommand\(cmd, cwd, timeoutMs, shellName\)/.test(rc), "runCommand не передаёт оболочку");
    const bg = mainFull.slice(mainFull.indexOf('case "startBackground"'), mainFull.indexOf('case "listBackground"'));
    assert.ok(/shellArgs: bgShell\.args/.test(bg), "startBackground не передаёт оболочку");
    assert.ok(mainFull.includes('shell: { type: "string", description: "Оболочка: cmd') === false, "описание в main.js не нужно");
    assert.ok(/shell: "powershell"/.test(core2) || /shell: \\"powershell\\"/.test(core2), "нет описания shell у инструмента runCommand");
  });

  // ── spawnRaw: системные коды ошибок сохраняются ─────────────────────────
  const r0 = mainFull.indexOf("function spawnRaw(args, opts) {");
  const r1 = mainFull.indexOf("\n}\n", mainFull.indexOf("resolve({ ok: !err, code, out", r0));
  assert.ok(r0 > 0 && r1 > r0, "не нашёл spawnRaw");
  let pendingErr = null;
  const spawnRaw = new Function(
    "execFile", "os", "stripAnsi", "agentEnv",
    mainFull.slice(r0, r1 + 2) + "; return spawnRaw;"
  )(
    (bin, args, opts, cb) => { setTimeout(() => cb(pendingErr, pendingErr ? "" : "ok", ""), 0); },
    os,
    (x) => String(x || ""),
    {}
  );

  await test("spawnRaw: EINVAL/EACCES/EPERM и текст ошибки больше не теряются", async () => {
    const cases = [
      [{ code: "EINVAL", message: "spawn EINVAL" }, "EINVAL", /spawn EINVAL/],
      [{ code: "EACCES", message: "spawn EACCES" }, "EACCES", /EACCES/],
      [{ code: "EPERM", message: "operation not permitted" }, "EPERM", /not permitted/],
      [{ code: 2, message: "exit 2" }, 2, /./],
      [{ code: "ENOENT", message: "spawn foo ENOENT" }, 127, /ENOENT/],
      [{ killed: true, message: "killed" }, -1, /./],
      [{ message: "непонятный сбой" }, 1, /непонятный сбой/],
    ];
    for (const [err, wantCode, wantText] of cases) {
      pendingErr = err;
      const r = await spawnRaw(["x"], {});
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.code, wantCode, "код для " + JSON.stringify(err) + " → " + r.code + ", ждали " + wantCode);
      assert.ok(wantText.test(r.err), "текст ошибки потерян: «" + r.err + "»");
    }
    pendingErr = null;
    const okRes = await spawnRaw(["x"], {});
    assert.strictEqual(okRes.ok, true);
    assert.strictEqual(okRes.code, 0);
  });

  // ── installExe: .exe / .msi / .zip ──────────────────────────────────────
  const i0 = mainFull.indexOf("function findInstallersIn(dir) {");
  const i1 = mainFull.indexOf("\nasync function downloadAndExtractTo", i0);
  assert.ok(i0 > 0 && i1 > i0, "не нашёл findInstallersIn");
  const findInstallersIn = new Function("fs", "path", mainFull.slice(i0, i1) + "; return findInstallersIn;")(fs, path);

  await test("installExe: установщик ищется в распакованном архиве (сначала из корня)", () => {
    const dir = tmpdir("inst-test-");
    fs.mkdirSync(path.join(dir, "app", "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "readme.txt"), "x");
    fs.writeFileSync(path.join(dir, "setup.exe"), "x");
    fs.writeFileSync(path.join(dir, "app", "pkg.msi"), "x");
    fs.writeFileSync(path.join(dir, "app", "bin", "tool.exe"), "x");
    const found = findInstallersIn(dir);
    assert.strictEqual(found.length, 3, "найдено не то: " + JSON.stringify(found));
    assert.ok(found[0].endsWith("setup.exe"), "первым должен идти установщик из корня: " + found[0]);
    assert.ok(found.some((f) => f.endsWith("pkg.msi")), ".msi не найден");
    assert.ok(!found.some((f) => f.endsWith(".txt")), "текстовый файл попал в установщики");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test("installExe: ветки .msi (msiexec) и .zip на месте, .exe не форсируется", () => {
    const inst = mainFull.slice(mainFull.indexOf('case "installExe"'), mainFull.indexOf('case "noteSave"'));
    assert.ok(inst.includes("msiexec /i"), "нет ветки .msi");
    assert.ok(inst.includes("/passive /norestart"), "нет тихих ключей msiexec по умолчанию");
    assert.ok(inst.includes("downloadAndExtractTo(url, destDir)"), "нет распаковки .zip");
    assert.ok(inst.includes("findInstallersIn("), "нет поиска установщика в архиве");
    assert.ok(inst.includes("downloadFileTo(url, destMsi)") && inst.includes("downloadFileTo(url, dest)"), "загрузка не переиспользует downloadFileTo");
    assert.ok(/path\.extname\(pathOnly\)/.test(inst), "расширение не берётся из URL");
    assert.ok(/\.\(exe\|msi\|zip\|msix\|appx\)[^/]*\/i\.test\(rawBase\)/.test(inst), "имя файла не учитывает расширение");
    assert.ok(core2.includes("msiexec") && core2.includes(".zip (распаковка"), "описание installExe не обновлено");
  });

  // ── gitPublish вне GitHub ───────────────────────────────────────────────
  await test("gitPublish: публикация на GitLab/Bitbucket по remoteUrl", () => {
    const gp = mainFull.slice(mainFull.indexOf('case "gitPublish"'), mainFull.indexOf('case "gitInit"'));
    assert.ok(gp.includes("args.remoteUrl"), "нет ветки remoteUrl");
    assert.ok(/remote", "set-url"/.test(gp) || gp.includes('"remote", "set-url"'), "нет обновления существующего remote");
    assert.ok(gp.includes('"remote", "add"'), "нет добавления remote");
    assert.ok(gp.includes('"push", "-u"'), "нет push -u <remote> <branch>");
    assert.ok(/git@bitbucket\.org/.test(core2), "описание gitPublish не объясняет формат адреса");
  });

  // ── Свой Chrome по CDP ──────────────────────────────────────────────────
  const bt = require(path.join(ROOT, "src", "browser-tools.js"));
  assert.ok(typeof bt.connect === "function" && typeof bt.setConnectMode === "function", "нет API CDP в browser-tools");

  await test("browserConnect: подхват вкладок пользователя, отключение без закрытия его Chrome", async () => {
    const closed = [];
    let killed = 0;
    const mkPage = (url, title) => ({
      url: () => url, title: async () => title, on: () => {}, goto: async () => {},
      waitForLoadState: async () => {}, close: async () => { closed.push(url); },
    });
    const vk = mkPage("https://vk.com/im", "ВКонтакте");
    const mail = mkPage("https://mail.yandex.ru/", "Почта");
    const fresh = mkPage("about:blank", "Новая вкладка");
    const ctx = { pages: () => [vk, mail], newPage: async () => fresh };
    const browserMock = {
      isConnected: () => true,
      contexts: () => [ctx],
      on: () => {},
      close: async () => { killed++; },
      newPage: async () => { throw new Error("в CDP-режиме нельзя создавать вкладки вне контекста пользователя"); },
    };
    const endpoints = [];
    bt.setPlaywright({ chromium: { connectOverCDP: async (ep) => { endpoints.push(ep); return browserMock; } } });
    bt.setProfileDir(path.join(os.tmpdir(), "agent-profile-test"));

    const server = http.createServer((req, res) => {
      if (req.url === "/json/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Browser: "Chrome/140.0.0.0" }));
        return;
      }
      res.writeHead(404);
      res.end("no");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    try {
      const cfg = bt.setConnectMode({ enabled: true, port, dataDir: path.join(os.tmpdir(), "cdp-dir") });
      assert.strictEqual(cfg.port, port, "порт не принят");
      assert.strictEqual(bt.setConnectMode({ enabled: true, port: 80, dataDir: "/x" }).port, 9222, "некорректный порт не отброшен");
      bt.setConnectMode({ enabled: true, port, dataDir: path.join(os.tmpdir(), "cdp-dir") });

      const out = await bt.connect({ launch: false });
      assert.ok(/^OK — подключился к твоему Chrome по CDP/.test(out), "нет подтверждения: " + out.slice(0, 140));
      assert.strictEqual(endpoints[0], "http://127.0.0.1:" + port, "подключение не к тому адресу: " + endpoints[0]);
      assert.ok(/vk\.com\/im/.test(out) && /mail\.yandex/.test(out), "вкладки пользователя не подхвачены:\n" + out);

      const st = await bt.status();
      assert.ok(/СВОЙ Chrome по CDP/.test(st), "статус не сообщает режим CDP");
      const tabId = (st.match(/(tab\d+)/) || [])[1];
      assert.ok(tabId, "нет id вкладки в статусе");
      const refused = await bt.close({ tabId });
      assert.ok(/вкладка твоего Chrome/.test(refused), "вкладка пользователя закрыта: " + refused);

      const off = await bt.close({ tabId: "all" });
      assert.ok(/отключился от твоего Chrome/.test(off), "нет отключения: " + off);
      assert.strictEqual(killed, 0, "Chrome пользователя был закрыт!");
      assert.deepStrictEqual(closed, [], "вкладки пользователя закрыты: " + JSON.stringify(closed));
      assert.strictEqual(bt.connectInfo().active, false, "флаг CDP не сброшен");

      await bt.connect({ launch: false });
      const opened = await bt.open({ url: "https://example.com", newTab: true });
      assert.ok(/Вкладка tab\d+ открыта/.test(opened) && /CDP/.test(opened), "новая вкладка не открылась в своём Chrome: " + opened);

      await bt.close({ tabId: "all" });
      bt.setConnectMode({ enabled: true, port: 65500, dataDir: "/x" });
      const fail = await bt.connect({ launch: false });
      assert.ok(/^Ошибка browserConnect/.test(fail), "нет ошибки подключения: " + fail.slice(0, 100));
      assert.ok(/Chrome 136\+/.test(fail) && /user-data-dir/.test(fail), "нет предупреждения про Chrome 136+ и --user-data-dir");
    } finally {
      bt.setConnectMode({ enabled: false, port: 9222, dataDir: "" });
      await bt.stop();
      bt.setPlaywright(null);
      await new Promise((r) => server.close(r));
    }
  });

  await test("browserConnect: инструмент, промпт, каналы и настройки согласованы", () => {
    assert.ok(core2.includes('name: "browserConnect"'), "нет определения инструмента в agent-core");
    const list = core2.split("\n").find((l) => l.startsWith("Доступные инструменты:")) || "";
    assert.ok(/browserConnect/.test(list), "инструмента нет в списке для модели");
    assert.ok(/browser_connect: "browserConnect"/.test(core2), "нет алиаса browser_connect");
    assert.ok(/начни с browserConnect/.test(core2), "промпт не объясняет, когда подключаться к своему Chrome");
    assert.ok(pre2.includes("browserConnect: (opts) =>"), "preload не пробрасывает browserConnect");
    assert.ok(mainFull.includes('case "browserConnect": {'), "нет диспетчера инструмента");
    assert.ok(mainFull.includes("function applyBrowserSettings(s)"), "нет единой точки применения браузерных настроек");
    assert.ok(/browserConnect === true/.test(mainFull), "настройка не читается");
    for (const id of ["s-browser-connect", "s-browser-connect-port", "btn-browser-connect", "browser-connect-info"]) {
      assert.ok(html2.includes('id="' + id + '"'), "нет id=" + id + " в index.html");
      assert.ok(app2.includes('"' + id + '"'), "app.js не ссылается на " + id);
    }
    assert.ok(app2.includes("settings.browserConnect = !!$(\"s-browser-connect\").checked"), "настройка не сохраняется");
    assert.ok(app2.includes("api.browserConnect({ port })"), "кнопка не вызывает подключение");
  });
}

// ── Запуск ──────────────────────────────────────────────────────────────────
(async () => {
  console.log("Smoke-тесты: " + path.basename(__filename));
  await testAgentCore();
  await testAppUiTools();
  await testAppUiRefs();
  await testAgentStore();
  await testUnifiedPatch();
  await testCodeIndex();
  await testSecrets();
  await testOta();
  await testBrowserTools();
  await testBrowserBrain();
  await testHighlight();
  await testMobileBridge();
  await testChatPersistence();
  await testSessionExtras();
  await testVault();
  await testVaultUi();
  await testMail();
  await testYandexCloud();
  await testYcDiagnosis();
  await testShellAndCdp();
  await testServer();
  await testSelfDev();
  console.log("\nИтог: " + passed + " прошло, " + failed + " упало");
  process.exit(failed ? 1 : 0);
})();